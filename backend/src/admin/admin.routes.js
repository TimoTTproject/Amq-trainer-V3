// Routes admin (outils de test). Réservées aux comptes admin.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('./admin');
const { getCharacterMedia, seriesOfCharacter, getTopCharacters, getAnimeCharacters } = require('../anilist/anilist.service');
const { rarityForRank, MAX_SUPPLY } = require('../gacha/rarity');
const { invalidateWeeklyCaches } = require('../gacha/gacha.routes');
const { broadcastAll } = require('../mp/mp');
const { scanEndingsBatch, backfillFormatsBatch, backfillSeasonsBatch, repairBrokenTitlesBatch, dedupeAmbiguousAltTitles } = require('../catalog/catalog.service');
const {
  migrateOneSongToR2,
  r2Status,
  startContinuousMigration,
  stopContinuousMigration,
} = require('../storage/r2');

const router = express.Router();
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

router.get('/r2-status', requireAuth, requireAdmin, async (req, res) => {
  res.json(await r2Status());
});

// Migre un seul média par requête afin de ne pas saturer Railway ni AnimeThemes.
// Le client admin enchaîne quelques requêtes et affiche la progression.
router.post('/r2-migrate', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await migrateOneSongToR2());
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

router.post('/r2-migration/start', requireAuth, requireAdmin, async (req, res) => {
  const status = await r2Status();
  if (!status.connected) return res.status(503).json({ error: status.error || 'R2 inaccessible' });
  res.json({ migration: startContinuousMigration() });
});

router.post('/r2-migration/stop', requireAuth, requireAdmin, async (req, res) => {
  res.json({ migration: stopContinuousMigration() });
});

// Crédite des tokens au compte courant (test gacha / achats)
router.post('/tokens', requireAuth, requireAdmin, async (req, res) => {
  const amount = Math.max(1, Math.min(100000, parseInt(req.body?.amount) || 1000));
  const userId = req.user.id;
  const u = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { tokens: { increment: amount } } });
    await tx.tokenTransaction.create({ data: { userId, amount, reason: 'admin_grant' } });
    return user;
  });
  res.json({ granted: amount, tokens: u.tokens });
});

// Liste des personnages (gestion des raretés) : recherche + filtre + pagination
router.get('/characters', requireAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  const q = (req.query.search || '').trim();
  const rarity = VALID_RARITIES.includes(req.query.rarity) ? req.query.rarity : null;

  const where = {};
  if (rarity) where.rarity = rarity;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { series: { contains: q, mode: 'insensitive' } },
    ];
  }
  const [total, characters, missingSeries, rarityGroups] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: [{ favourites: 'desc' }, { id: 'asc' }], // tiebreak cohérent avec recompute-rarities
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true, featured: true },
    }),
    prisma.character.count({ where: { series: null } }),
    // Répartition GLOBALE par rareté (indépendante du filtre/recherche en
    // cours) — affichée en permanence dans l'admin pour suivre le pool avant
    // un rééquilibrage manuel (ex. avant un reset global).
    prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } }),
  ]);
  const byRarity = {};
  let grandTotal = 0;
  rarityGroups.forEach((g) => { byRarity[g.rarity] = g._count._all; grandTotal += g._count._all; });
  res.json({ characters, total, page, pages: Math.ceil(total / perPage), rarities: VALID_RARITIES, missingSeries, byRarity, grandTotal });
});

// Active/désactive le statut « vedette » d'un personnage
router.patch('/characters/:id/featured', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const featured = !!req.body?.featured;
  try {
    const c = await prisma.character.update({ where: { id }, data: { featured } });
    res.json({ id: c.id, featured: c.featured });
  } catch {
    res.status(404).json({ error: 'Personnage introuvable' });
  }
});

// Modifie la rareté d'un personnage. Recalcule TOUJOURS maxSupply/soldOut sur
// le plafond de la nouvelle rareté (sinon un perso repassé "mythic" gardait
// l'ancien plafond, ex. 1 000 000 s'il venait de "common" — beaucoup plus
// disponible qu'un vrai mythique, donc largement sur-représenté dans le pool
// mythique tant qu'il ne s'épuisait pas) et invalide les caches hebdomadaires
// (même raison que /recompute-rarities, cf. invalidateWeeklyCaches).
router.patch('/characters/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const rarity = req.body?.rarity;
  if (!VALID_RARITIES.includes(rarity)) return res.status(400).json({ error: 'Rareté invalide' });
  try {
    const existing = await prisma.character.findUnique({ where: { id }, select: { minted: true } });
    if (!existing) return res.status(404).json({ error: 'Personnage introuvable' });
    const cap = MAX_SUPPLY[rarity] || 1000000;
    const maxSupply = Math.max(cap, existing.minted);
    const c = await prisma.character.update({
      where: { id },
      data: { rarity, maxSupply, soldOut: existing.minted >= maxSupply },
    });
    invalidateWeeklyCaches();
    res.json({ id: c.id, rarity: c.rarity, maxSupply: c.maxSupply, soldOut: c.soldOut });
  } catch {
    res.status(404).json({ error: 'Personnage introuvable' });
  }
});

// Remplit « series » par lots (déclenché côté serveur, qui a accès à la prod + AniList).
// Appeler en boucle jusqu'à remaining === 0.
router.post('/backfill-series', requireAuth, requireAdmin, async (req, res) => {
  const batch = await prisma.character.findMany({
    where: { series: null },
    take: 50,
    select: { id: true, anilistId: true },
  });
  if (!batch.length) return res.json({ processed: 0, remaining: 0 });

  try {
    const media = await getCharacterMedia(batch.map((c) => c.anilistId));
    const byAnilist = Object.fromEntries(media.map((m) => [m.id, m]));
    let processed = 0;
    for (const c of batch) {
      const { series, seriesId } = seriesOfCharacter(byAnilist[c.anilistId]);
      // Marque traité même sans média trouvé (chaîne vide) pour ne pas boucler dessus
      await prisma.character.update({
        where: { id: c.id },
        data: { series: series || '—', seriesId: seriesId || null },
      });
      processed++;
    }
    const remaining = await prisma.character.count({ where: { series: null } });
    res.json({ processed, remaining });
  } catch (e) {
    res.status(502).json({ error: 'AniList indisponible : ' + e.message });
  }
});

// Tableau de bord : visites, utilisateurs, activité globale.
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const since7 = new Date(now.getTime() - 7 * 86400000);
  const dayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const [totalUsers, newToday, new7d, visitsRows, visitsToday, mpGames, towerRuns, tradesOk, charsAgg, pullsAgg, playAgg, cardInstances] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: startToday } } }),
    prisma.user.count({ where: { createdAt: { gte: since7 } } }),
    prisma.visit.groupBy({ by: ['day'], _count: { _all: true }, orderBy: { day: 'desc' }, take: 14 }),
    prisma.visit.count({ where: { day: dayStr } }),
    prisma.mpResult.count(),
    prisma.towerRun.count({ where: { status: 'over' } }),
    prisma.trade.count({ where: { status: 'accepted' } }),
    prisma.character.aggregate({ _sum: { minted: true } }),
    prisma.user.aggregate({ _sum: { pullCommon: true, pullRare: true, pullEpic: true, pullLegendary: true, pullMythic: true } }),
    prisma.userSongStat.aggregate({ _sum: { playCount: true, correctCount: true } }),
    prisma.cardInstance.count(),
  ]);

  const visits = visitsRows.map((v) => ({ day: v.day, count: v._count._all })).reverse();
  const pulls = ['pullCommon', 'pullRare', 'pullEpic', 'pullLegendary', 'pullMythic'].reduce((s, k) => s + (pullsAgg._sum[k] || 0), 0);

  res.json({
    users: { total: totalUsers, newToday, new7d },
    visits: { today: visitsToday, daily: visits },
    activity: {
      quizPlays: playAgg._sum.playCount || 0,
      quizCorrect: playAgg._sum.correctCount || 0,
      mpGames, towerRuns, tradesOk, pulls,
      cardsInCirculation: cardInstances,
      charactersMinted: charsAgg._sum.minted || 0,
    },
  });
});

// Ajoute les Endings (ED) au catalogue pour les animes déjà explorés.
// Appeler en boucle jusqu'à remaining === 0 (réseau throttlé → lots).
router.post('/import-endings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await scanEndingsBatch(20);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Remplit le champ `format` (TV/MOVIE/OVA…) du catalogue existant, par lots.
// Appeler en boucle jusqu'à remaining === 0 (throttlé par AniList).
router.post('/backfill-format', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await backfillFormatsBatch(50);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Calcule le numéro de saison (chaîne PREQUEL/SEQUEL AniList) pour distinguer
// les saisons d'une même œuvre dans les propositions du quiz. Appeler en
// boucle jusqu'à remaining === 0 (throttlé par AniList).
router.post('/backfill-seasons', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await backfillSeasonsBatch(30);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Répare les titres d'anime corrompus (« 2nd Season », « Anime inconnu »…) en
// re-récupérant le vrai nom sur AniList. Appeler en boucle jusqu'à remaining === 0.
router.post('/repair-titles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await repairBrokenTitlesBatch(50);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Retire les synonymes ambigus (ex. « Pokemon » listé sur chaque saison) qui
// rendent des animes distincts interchangeables comme réponse. Aucun appel
// réseau : passe complète en un seul appel (pas de boucle nécessaire).
router.post('/dedupe-alt-titles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await dedupeAmbiguousAltTitles();
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Importe davantage de personnages AniList (par popularité) dans le pool.
// N'ajoute que les nouveaux (en « common », l'admin ajuste ensuite) via createMany
// — insertion groupée rapide. Appeler en boucle pour avancer dans les pages.
router.post('/import-characters', requireAuth, requireAdmin, async (req, res) => {
  const count = await prisma.character.count();
  // Curseur de page explicite (le client incrémente) ; sinon estimation initiale.
  const pageNum = parseInt(req.body?.page) || Math.floor(count / 50) + 1;

  let page;
  try {
    page = await getTopCharacters(pageNum, 50);
  } catch (e) {
    // AniList plafonne la pagination (~5000) → on arrête proprement au lieu d'un 502
    return res.json({ added: 0, total: count, hasMore: false, page: pageNum, capped: true });
  }
  const chars = page.characters || [];
  if (!chars.length) return res.json({ added: 0, total: count, hasMore: false, page: pageNum });

  const ids = chars.map((c) => c.id);
  const existing = await prisma.character.findMany({ where: { anilistId: { in: ids } }, select: { anilistId: true } });
  const existingSet = new Set(existing.map((e) => e.anilistId));

  const toCreate = chars
    .filter((c) => !existingSet.has(c.id))
    .map((c) => {
      const { series, seriesId } = seriesOfCharacter(c);
      return { anilistId: c.id, name: c.name.full, imageUrl: c.image?.large, favourites: c.favourites || 0, rarity: 'common', series, seriesId, maxSupply: MAX_SUPPLY.common };
    });
  if (toCreate.length) await prisma.character.createMany({ data: toCreate, skipDuplicates: true });

  const total = await prisma.character.count();
  res.json({ added: toCreate.length, total, hasMore: !!page.hasNextPage, page: pageNum });
});

// Importe des personnages en itérant les ANIMES par ANNÉE plutôt que la
// recherche globale de personnages — celle-ci (et le browse global d'animes
// par popularité) est plafonnée par AniList à 5000 résultats au total
// (vérifié : au-delà, l'API renvoie "Page depth exceeds maximum"), quels que
// soient le tri/filtre. Filtrer par année contourne ce plafond pour de bon :
// chaque année reste largement en dessous, donc on peut parcourir tout
// l'historique. `year`/`page` forment un curseur géré par le serveur (le
// front le repasse tel quel) : quand une année est épuisée on descend à la
// précédente, jusqu'à YEAR_FLOOR. Nouveaux persos en « common » (l'admin
// recalcule ensuite les raretés).
const ANIME_YEAR_FLOOR = 1960;
router.post('/import-characters-anime', requireAuth, requireAdmin, async (req, res) => {
  let year = parseInt(req.body?.year) || new Date().getFullYear() + 1;
  let pageNum = parseInt(req.body?.page) || 1;

  let page = null;
  let processedYear = year;
  for (let guard = 0; guard < 200 && year >= ANIME_YEAR_FLOOR; guard++) {
    try {
      // perPage=50 (max animes/requête) et charsPerAnime=30 : le seuil réel du
      // top-5000 personnages est ~240 favoris (vérifié), et un anime populaire
      // a souvent PLUS de 15 personnages au-dessus — avec 15, on ne touchait
      // quasiment que des doublons sur les animes populaires en tête d'année.
      page = await getAnimeCharacters(pageNum, 50, 30, year);
    } catch (e) {
      // Seul le plafond de pagination D'AniList (rarissime : années très
      // denses) justifie de sauter à l'année précédente. Toute autre erreur
      // (rate-limit épuisé, réseau…) doit remonter tout de suite : sinon la
      // boucle enchaînerait des dizaines d'années, chacune ré-attendant le
      // délai de rate-limit d'anilistQuery (jusqu'à 60-180s), et la requête
      // ne répond jamais au navigateur (perçu comme "bloqué" côté admin).
      if (!/page depth exceeds maximum/i.test(e.message || '')) throw e;
      page = null;
    }
    if (page && (page.characters.length > 0 || page.hasNextPage)) { processedYear = year; break; }
    year--; pageNum = 1; page = null;
  }

  if (!page) {
    const total = await prisma.character.count();
    return res.json({ added: 0, total, hasMore: false, done: true, year: ANIME_YEAR_FLOOR, page: 1 });
  }

  const chars = page.characters || [];
  const ids = chars.map((c) => c.id);
  const existing = ids.length
    ? await prisma.character.findMany({ where: { anilistId: { in: ids } }, select: { anilistId: true } })
    : [];
  const existingSet = new Set(existing.map((e) => e.anilistId));

  const toCreate = chars
    .filter((c) => !existingSet.has(c.id))
    .map((c) => ({
      anilistId: c.id, name: c.name.full, imageUrl: c.image?.large, favourites: c.favourites || 0,
      rarity: 'common', series: c.seriesTitle || null, seriesId: c.seriesId || null,
      maxSupply: MAX_SUPPLY.common,
    }));
  if (toCreate.length) await prisma.character.createMany({ data: toCreate, skipDuplicates: true });

  const total = await prisma.character.count();
  const nextYear = page.hasNextPage ? processedYear : processedYear - 1;
  const nextPage = page.hasNextPage ? pageNum + 1 : 1;
  res.json({
    added: toCreate.length, total, year: nextYear, page: nextPage,
    processedYear, hasMore: nextYear >= ANIME_YEAR_FLOOR,
  });
});

// Recalcule la rareté de TOUS les personnages par rang de popularité (favourites).
// Restaure la pyramide quel que soit le total (écrase les raretés manuelles).
// Resynchronise TOUJOURS maxSupply/soldOut sur le plafond courant de la rareté
// (pas seulement les personnages qui changent de palier) : c'est ce qui permet
// de resserrer MAX_SUPPLY dans rarity.js (ex. faire baisser un plafond mythique
// existant) et de l'appliquer rétroactivement à tout le pool via ce bouton.
router.post('/recompute-rarities', requireAuth, requireAdmin, async (req, res) => {
  const all = await prisma.character.findMany({ select: { id: true, favourites: true, rarity: true, minted: true } });
  // Départage les égalités de favoris par id (stable et déterministe) : sans
  // ça, ce tri en mémoire peut classer des personnages à égalité dans un ordre
  // différent de celui des requêtes `ORDER BY favourites DESC` faites ailleurs
  // (pokédex, admin…), donnant l'impression que la frontière de rareté « fuit »
  // (ex. un Épique affiché avant des Mythiques dans une liste triée par popularité).
  all.sort((a, b) => (b.favourites || 0) - (a.favourites || 0) || a.id - b.id);
  const total = all.length;
  if (!total) return res.json({ total: 0, counts: {} });

  const byRarity = {};
  all.forEach((c, i) => {
    const r = rarityForRank(i, total);
    (byRarity[r] ||= []).push(c);
  });

  const counts = {};
  const ops = [];
  for (const [rarity, chars] of Object.entries(byRarity)) {
    counts[rarity] = chars.length;
    const cap = MAX_SUPPLY[rarity] || 1000000;
    const ids = chars.map((c) => c.id);
    for (let i = 0; i < ids.length; i += 500) {
      ops.push(prisma.character.updateMany({ where: { id: { in: ids.slice(i, i + 500) } }, data: { rarity } }));
    }
    // La grande majorité des personnages tiennent sous le nouveau plafond → un
    // seul updateMany groupé par rareté. Seuls ceux déjà « sursouscrits »
    // (minted au-delà du nouveau cap, ex. un plafond mythique qu'on resserre
    // sous des tirages déjà en circulation) doivent être ajustés un par un,
    // pour ne jamais invalider des cartes déjà possédées par des joueurs.
    const underCap = chars.filter((c) => c.minted < cap).map((c) => c.id);
    const overCap = chars.filter((c) => c.minted >= cap);
    for (let i = 0; i < underCap.length; i += 500) {
      ops.push(prisma.character.updateMany({ where: { id: { in: underCap.slice(i, i + 500) } }, data: { maxSupply: cap, soldOut: false } }));
    }
    for (const c of overCap) {
      ops.push(prisma.character.update({ where: { id: c.id }, data: { maxSupply: c.minted, soldOut: true } }));
    }
  }
  await prisma.$transaction(ops);
  // Les raretés viennent de bouger : le rate-up vedette de la semaine
  // (weeklyCache) et les pools de candidats au vote peuvent maintenant
  // pointer vers des personnages dont la rareté réelle a changé — sans ça,
  // un tirage Épique/Légendaire peut silencieusement ressortir Mythique
  // (ou l'inverse) via le rate-up, jusqu'au prochain redémarrage serveur.
  invalidateWeeklyCaches();
  res.json({ total, counts });
});

// Réinitialise la progression du compte courant (pour repartir propre avant une sortie).
// Garde le profil et « Ma liste » ; efface stats/SRS/likes, cartes gacha, tokens,
// Château, classé et historiques.
router.post('/reset-me', requireAuth, requireAdmin, async (req, res) => {
  const userId = req.user.id;
  await prisma.$transaction([
    prisma.userSongStat.deleteMany({ where: { userId } }),
    prisma.userCard.deleteMany({ where: { userId } }),
    prisma.towerRun.deleteMany({ where: { userId } }),
    prisma.mpResult.deleteMany({ where: { userId } }),
    prisma.dailyRun.deleteMany({ where: { userId } }),
    prisma.seasonClaim.deleteMany({ where: { userId } }),
    prisma.tokenTransaction.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { tokens: 0, dust: 0, pity: 0, towerBestFloor: 0, mmr: 1000, rankedGames: 0, rankedWins: 0, soloMmr: 1000, soloGames: 0, soloBestScore: 0, dailyStreak: 0, dailyStreakBest: 0, dailyLastDay: null, claimedLevel: 1, towerLastFreeAt: null },
    }),
  ]);
  res.json({ ok: true });
});

// Supprime un compte (ex. comptes de test/diagnostic créés en prod pendant le
// développement) : n'apparaît plus dans l'annuaire des joueurs, le classement,
// les échanges, etc. Cascade totale via les relations Prisma (onDelete: Cascade
// sur tous les modèles liés à User). On rend d'abord au stock les exemplaires
// de cartes possédés (CardInstance) pour ne pas fausser les compteurs de rareté
// dynamique (minted/soldOut), avant que la cascade ne les supprime.
router.delete('/user/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte admin ici.' });
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, displayName: true, email: true } });
  if (!target) return res.status(404).json({ error: 'Compte introuvable' });

  const instances = await prisma.cardInstance.groupBy({
    by: ['characterId'], where: { userId: id }, _count: { _all: true },
  });
  await prisma.$transaction([
    ...instances.map((row) =>
      prisma.character.update({
        where: { id: row.characterId },
        data: { minted: { decrement: row._count._all }, soldOut: false },
      })
    ),
    prisma.user.delete({ where: { id } }),
  ]);
  res.json({ ok: true, deleted: { id: target.id, displayName: target.displayName, email: target.email } });
});

// Reset GLOBAL : remet à zéro la progression de TOUS les comptes (avant un lancement).
// Garde les comptes, profils, « Ma liste », et le pool de personnages/musiques.
// Protégé : nécessite body.confirm === 'RESET'.
router.post('/reset-all', requireAuth, requireAdmin, async (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'Confirmation requise (RESET)' });
  await prisma.$transaction([
    prisma.userSongStat.deleteMany({}),
    prisma.userCard.deleteMany({}),
    prisma.towerRun.deleteMany({}),
    prisma.mpResult.deleteMany({}),
    prisma.dailyRun.deleteMany({}),
    prisma.seasonClaim.deleteMany({}),
    prisma.tokenTransaction.deleteMany({}),
    prisma.user.updateMany({
      data: { tokens: 0, dust: 0, pity: 0, towerBestFloor: 0, mmr: 1000, rankedGames: 0, rankedWins: 0, soloMmr: 1000, soloGames: 0, soloBestScore: 0, dailyStreak: 0, dailyStreakBest: 0, dailyLastDay: null, claimedLevel: 1, towerLastFreeAt: null, lastDailyAt: null },
    }),
  ]);
  const users = await prisma.user.count();
  res.json({ ok: true, users });
});

// Reset GACHA UNIQUEMENT : remet à zéro les collections/stock (pool de
// personnages réorganisé avec la nouvelle pyramide 150 Mythique/550 Légendaire
// et un stock resserré) SANS toucher aux autres systèmes de jeu (quiz, Château,
// multijoueur, défi du jour, XP/niveaux). Chaque joueur est REMBOURSÉ à
// hauteur de ce qu'il a réellement dépensé en tirages DEPUIS LE RESET
// PRÉCÉDENT (somme BRUTE des coûts `pack_open` postérieurs à cette date, sans
// déduire les remboursements de doublons déjà perçus en cours de route) — pas
// un forfait identique pour tout le monde, et jamais deux fois la même
// dépense si ce reset est déclenché plusieurs fois (sinon un 2ᵉ reset
// rembourserait à nouveau les tirages déjà compensés par le 1ᵉʳ, doublant le
// remboursement). Ajouté à son solde actuel (jamais un remplacement : les
// tokens gagnés hors gacha — quiz, Château, etc. — ne sont pas concernés).
// Protégé : nécessite body.confirm === 'RESET_GACHA'.
router.post('/reset-gacha', requireAuth, requireAdmin, async (req, res) => {
  if (req.body?.confirm !== 'RESET_GACHA') return res.status(400).json({ error: 'Confirmation requise (RESET_GACHA)' });

  const users = await prisma.user.findMany({ select: { id: true } });
  const prevReset = await prisma.appSetting.findUnique({ where: { key: 'lastGachaReset' } });
  const since = prevReset ? new Date(parseInt(prevReset.value)) : null;
  const spentGroups = await prisma.tokenTransaction.groupBy({
    by: ['userId'],
    where: { reason: 'pack_open', ...(since ? { createdAt: { gt: since } } : {}) },
    _sum: { amount: true },
  });
  // `amount` est négatif pour un coût de tirage (pack_open) → valeur absolue = dépensé.
  const spentByUser = new Map(spentGroups.map((g) => [g.userId, Math.abs(g._sum.amount || 0)]));

  const ops = [
    // Cartes possédées + exemplaires numérotés + échanges (référencent des
    // exemplaires qui n'existeront plus) + albums (organisent des cartes possédées).
    prisma.userCard.deleteMany({}),
    prisma.cardInstance.deleteMany({}),
    prisma.trade.deleteMany({}),
    prisma.cardAlbumItem.deleteMany({}),
    prisma.cardAlbum.deleteMany({}),
    // Stock mondial en circulation : remis à zéro pour TOUS les personnages
    // (sinon ils resteraient artificiellement épuisés après la suppression
    // des CardInstance qui comptaient dans `minted`).
    prisma.character.updateMany({ data: { minted: 0, nextSerial: 0, soldOut: false } }),
  ];
  // Dédommagement forfaitaire de CET incident (fuite de rareté : le rate-up
  // vedette hebdo pouvait livrer un Mythique sur un tirage Épique/Légendaire
  // après un recalcul des raretés — corrigé le 2026-07-06), en plus du
  // remboursement du montant réellement dépensé. Donné à tout le monde,
  // même à ceux qui n'ont jamais tiré. Purement ponctuel : à retirer si un
  // futur reset gacha n'a plus de rapport avec cet incident.
  const INCIDENT_BONUS = 500;
  let totalCompensation = 0;
  let totalBonus = 0;
  for (const { id: userId } of users) {
    const spent = spentByUser.get(userId) || 0;
    totalCompensation += spent;
    totalBonus += INCIDENT_BONUS;
    ops.push(prisma.user.update({
      where: { id: userId },
      // increment (jamais un remplacement) : préserve les tokens gagnés hors
      // gacha. Remise à zéro des compteurs propres au gacha uniquement.
      data: { tokens: { increment: spent + INCIDENT_BONUS }, dust: 0, pity: 0, pullCommon: 0, pullRare: 0, pullEpic: 0, pullLegendary: 0, pullMythic: 0 },
    }));
    if (spent > 0) {
      ops.push(prisma.tokenTransaction.create({ data: { userId, amount: spent, reason: 'gacha_reset_compensation' } }));
    }
    ops.push(prisma.tokenTransaction.create({ data: { userId, amount: INCIDENT_BONUS, reason: 'gacha_incident_bonus' } }));
  }
  ops.push(prisma.appSetting.upsert({
    where: { key: 'lastGachaReset' },
    update: { value: String(Date.now()) },
    create: { key: 'lastGachaReset', value: String(Date.now()) },
  }));
  await prisma.$transaction(ops);

  // Prévient tous les joueurs déjà connectés (socket ouvert) sans attendre
  // une reconnexion/reload : le client relit alors SA propre compensation
  // via GET /reset-notice (jamais de montant personnel dans le broadcast lui-même).
  try { broadcastAll('gacha:reset-notice', {}); } catch (e) { console.error('broadcast gacha reset:', e.message); }

  res.json({ ok: true, users: users.length, totalCompensation, totalBonus });
});

// Relevé complet des transactions "tokens" d'un joueur (recherché par
// pseudo exact ou approché) : sert à diagnostiquer un solde qui semble faux
// SANS deviner — on voit directement chaque ligne (pack_open, compensations,
// bonus, corrections) au lieu de recalculer à l'aveugle.
router.get('/token-ledger', requireAuth, requireAdmin, async (req, res) => {
  const q = (req.query.user || '').trim();
  if (!q) return res.status(400).json({ error: 'Paramètre user requis (pseudo)' });
  const user = await prisma.user.findFirst({
    where: { displayName: { equals: q, mode: 'insensitive' } },
    select: { id: true, displayName: true, tokens: true },
  }) || await prisma.user.findFirst({
    where: { displayName: { contains: q, mode: 'insensitive' } },
    select: { id: true, displayName: true, tokens: true },
  });
  if (!user) return res.status(404).json({ error: 'Joueur introuvable' });

  const txs = await prisma.tokenTransaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amount: true, reason: true, createdAt: true },
  });
  const byReason = {};
  for (const t of txs) {
    byReason[t.reason] ||= { count: 0, total: 0 };
    byReason[t.reason].count++;
    byReason[t.reason].total += t.amount;
  }

  res.json({
    user: { id: user.id, displayName: user.displayName, tokens: user.tokens },
    byReason,
    // Somme de TOUTES les transactions = ce que le solde actuel DEVRAIT être
    // si aucune transaction n'a été perdue/ignorée (le solde part de 0 à la création).
    sumOfAllTransactions: txs.reduce((s, t) => s + t.amount, 0),
    transactions: txs,
  });
});

// ── Correction d'un remboursement en double (voir commit du 2026-07-06) ──
// AVANT le fix, /reset-gacha remboursait TOUT l'historique pack_open à
// chaque exécution, sans tenir compte d'un reset précédent déjà effectué :
// si le bouton a été cliqué deux fois (ex. le reset d'origine du pool, puis
// celui pour le dédommagement du bug de rareté), le 2ᵉ clic a redonné à
// chaque joueur l'intégralité de ses dépenses déjà remboursées par le 1ᵉʳ —
// doublant leur solde. Les routes ci-dessous reconstruisent les évènements
// de reset passés à partir des transactions `gacha_reset_compensation`
// (un même reset crée toutes ses transactions dans la même requête, donc
// à quelques secondes près) pour identifier précisément quel excédent
// retirer, sans avoir besoin d'un historique dédié.
const RESET_EVENT_GAP_MS = 5 * 60 * 1000; // 5 min sans transaction → nouvel évènement

async function findResetEvents() {
  const rows = await prisma.tokenTransaction.findMany({
    where: { reason: 'gacha_reset_compensation' },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const events = [];
  for (const r of rows) {
    const t = r.createdAt.getTime();
    const cur = events[events.length - 1];
    if (!cur || t - cur.last > RESET_EVENT_GAP_MS) events.push({ first: t, last: t });
    else cur.last = t;
  }
  return events;
}

// Lecture seule : liste les évènements de reset gacha détectés (date, nombre
// de joueurs compensés, montant total) — à consulter AVANT de lancer la
// correction, pour vérifier qu'il y a bien 2+ évènements (sinon rien à corriger).
router.get('/reset-gacha/audit', requireAuth, requireAdmin, async (req, res) => {
  const events = await findResetEvents();
  const out = [];
  for (const ev of events) {
    const from = new Date(ev.first);
    const to = new Date(ev.last);
    const [comps, bonuses] = await Promise.all([
      prisma.tokenTransaction.findMany({ where: { reason: 'gacha_reset_compensation', createdAt: { gte: from, lte: to } } }),
      prisma.tokenTransaction.findMany({ where: { reason: 'gacha_incident_bonus', createdAt: { gte: from, lte: to } } }),
    ]);
    out.push({
      at: from,
      users: comps.length,
      totalCompensation: comps.reduce((s, t) => s + t.amount, 0),
      bonusUsers: bonuses.length,
      totalBonus: bonuses.reduce((s, t) => s + t.amount, 0),
    });
  }
  res.json({ events: out });
});

// Corrige TOUS les évènements de reset après le premier (pas seulement le
// dernier — si le bouton a été cliqué plus de 2 fois au total, chaque
// évènement intermédiaire peut porter sa propre part d'historique en double,
// et une correction limitée au seul dernier évènement laisserait les couches
// précédentes non corrigées). Pour chaque évènement (sauf le tout premier,
// qui n'a pas de prédécesseur et est donc par définition sa propre référence
// correcte), ne garde que la dépense RÉELLE entre lui et l'évènement
// précédent, et retire l'excédent (jamais en dessous de 0 côté solde).
// Idempotent par évènement : un 2ᵉ appel ne retire rien de plus pour un
// évènement déjà corrigé (fenêtre d'idempotence bornée à cet évènement
// précis, pour ne pas confondre la correction d'un évènement avec celle d'un
// autre).
router.post('/reset-gacha/fix-double-refund', requireAuth, requireAdmin, async (req, res) => {
  if (req.body?.confirm !== 'FIX_DOUBLE_REFUND') return res.status(400).json({ error: 'Confirmation requise (FIX_DOUBLE_REFUND)' });
  const events = await findResetEvents();
  if (events.length < 2) return res.status(400).json({ error: 'Un seul évènement de reset détecté — rien à corriger.' });

  const ops = [];
  const corrections = [];
  for (let i = 1; i < events.length; i++) {
    const prevAt = new Date(events[i - 1].last);
    const curStart = new Date(events[i].first);
    const curEnd = new Date(events[i].last);
    // Fenêtre d'idempotence : entre CET évènement et le suivant (ou jusqu'à
    // maintenant s'il n'y en a pas), pour ne pas confondre avec une
    // correction déjà appliquée à un autre évènement.
    const nextStart = i + 1 < events.length ? new Date(events[i + 1].first) : new Date();

    const comps = await prisma.tokenTransaction.findMany({
      where: { reason: 'gacha_reset_compensation', createdAt: { gte: curStart, lte: curEnd } },
    });

    for (const comp of comps) {
      const { userId } = comp;
      const already = await prisma.tokenTransaction.findFirst({
        where: { userId, reason: 'gacha_reset_correction', createdAt: { gte: curStart, lt: nextStart } },
      });
      if (already) continue;

      // Dépense réelle ENTRE l'évènement précédent et celui-ci — c'est ce
      // qui aurait dû être remboursé, au lieu de l'historique complet.
      const spentGroups = await prisma.tokenTransaction.groupBy({
        by: ['userId'],
        where: { userId, reason: 'pack_open', createdAt: { gt: prevAt, lte: curStart } },
        _sum: { amount: true },
      });
      const correctAmount = Math.abs(spentGroups[0]?._sum.amount || 0);
      const excess = comp.amount - correctAmount;
      if (excess <= 0) continue;

      // Ne jamais passer le solde sous 0 : si le joueur a déjà dépensé
      // l'excédent reçu par erreur (nouveaux tirages, boutique…), on retire
      // seulement ce qu'il lui reste — `clamped` le signale pour suivi manuel.
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokens: true } });
      const toRemove = Math.min(excess, user?.tokens || 0);
      if (toRemove <= 0) { corrections.push({ userId, event: i + 1, wrongAmount: comp.amount, correctAmount, excess, removed: 0, clamped: true }); continue; }

      ops.push(prisma.user.update({ where: { id: userId }, data: { tokens: { decrement: toRemove } } }));
      ops.push(prisma.tokenTransaction.create({ data: { userId, amount: -toRemove, reason: 'gacha_reset_correction' } }));
      corrections.push({ userId, event: i + 1, wrongAmount: comp.amount, correctAmount, excess, removed: toRemove, clamped: toRemove < excess });
    }
  }
  if (ops.length) await prisma.$transaction(ops);
  res.json({ ok: true, eventsChecked: events.length - 1, usersFixed: corrections.length, corrections });
});

module.exports = { router };

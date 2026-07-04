// Routes admin (outils de test). Réservées aux comptes admin.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('./admin');
const { getCharacterMedia, seriesOfCharacter, getTopCharacters } = require('../anilist/anilist.service');
const { rarityForRank, MAX_SUPPLY } = require('../gacha/rarity');
const { scanEndingsBatch, backfillFormatsBatch, repairBrokenTitlesBatch, dedupeAmbiguousAltTitles } = require('../catalog/catalog.service');
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
  const [total, characters, missingSeries] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy: [{ favourites: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true, featured: true },
    }),
    prisma.character.count({ where: { series: null } }),
  ]);
  res.json({ characters, total, page, pages: Math.ceil(total / perPage), rarities: VALID_RARITIES, missingSeries });
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

// Modifie la rareté d'un personnage
router.patch('/characters/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const rarity = req.body?.rarity;
  if (!VALID_RARITIES.includes(rarity)) return res.status(400).json({ error: 'Rareté invalide' });
  try {
    const c = await prisma.character.update({ where: { id }, data: { rarity } });
    res.json({ id: c.id, rarity: c.rarity });
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

// Recalcule la rareté de TOUS les personnages par rang de popularité (favourites).
// Restaure la pyramide quel que soit le total (écrase les raretés manuelles).
// Resynchronise aussi maxSupply/soldOut sur la nouvelle rareté (sinon un perso qui
// change de palier garde l'ancien stock max, ex. Mythique avec un cap de Légendaire).
router.post('/recompute-rarities', requireAuth, requireAdmin, async (req, res) => {
  const all = await prisma.character.findMany({ select: { id: true, favourites: true, rarity: true, minted: true } });
  all.sort((a, b) => (b.favourites || 0) - (a.favourites || 0));
  const total = all.length;
  if (!total) return res.json({ total: 0, counts: {} });

  // Regroupe par (nouvelle rareté, ancienne rareté) pour ne resynchroniser le stock
  // que sur les personnages dont la rareté change réellement.
  const byRarity = {};
  const changedByRarity = {};
  all.forEach((c, i) => {
    const r = rarityForRank(i, total);
    (byRarity[r] ||= []).push(c.id);
    if (r !== c.rarity) (changedByRarity[r] ||= []).push(c);
  });

  // updateMany par rareté, en lots de 500 ids (limite de taille de requête)
  const counts = {};
  const ops = [];
  for (const [rarity, ids] of Object.entries(byRarity)) {
    counts[rarity] = ids.length;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      ops.push(prisma.character.updateMany({ where: { id: { in: chunk } }, data: { rarity } }));
    }
  }
  // Pour les personnages qui changent de rareté, aligne maxSupply sur le nouveau
  // palier (jamais sous le nombre déjà en circulation) et met à jour soldOut.
  for (const [rarity, chars] of Object.entries(changedByRarity)) {
    const cap = MAX_SUPPLY[rarity] || 1000000;
    for (const c of chars) {
      const maxSupply = Math.max(cap, c.minted);
      ops.push(prisma.character.update({ where: { id: c.id }, data: { maxSupply, soldOut: c.minted >= maxSupply } }));
    }
  }
  await prisma.$transaction(ops);
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

module.exports = { router };

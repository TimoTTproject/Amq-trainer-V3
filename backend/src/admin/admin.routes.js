// Routes admin (outils de test). Réservées aux comptes admin.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('./admin');
const { getCharacterMedia, seriesOfCharacter, getTopCharacters } = require('../anilist/anilist.service');
const { rarityForRank } = require('../gacha/rarity');

const router = express.Router();
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

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
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true },
    }),
    prisma.character.count({ where: { series: null } }),
  ]);
  res.json({ characters, total, page, pages: Math.ceil(total / perPage), rarities: VALID_RARITIES, missingSeries });
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
      return { anilistId: c.id, name: c.name.full, imageUrl: c.image?.large, favourites: c.favourites || 0, rarity: 'common', series, seriesId };
    });
  if (toCreate.length) await prisma.character.createMany({ data: toCreate, skipDuplicates: true });

  const total = await prisma.character.count();
  res.json({ added: toCreate.length, total, hasMore: !!page.hasNextPage, page: pageNum });
});

// Recalcule la rareté de TOUS les personnages par rang de popularité (favourites).
// Restaure la pyramide quel que soit le total (écrase les raretés manuelles).
router.post('/recompute-rarities', requireAuth, requireAdmin, async (req, res) => {
  const all = await prisma.character.findMany({ select: { id: true, favourites: true } });
  all.sort((a, b) => (b.favourites || 0) - (a.favourites || 0));
  const total = all.length;
  if (!total) return res.json({ total: 0, counts: {} });

  const byRarity = {};
  all.forEach((c, i) => {
    const r = rarityForRank(i, total);
    (byRarity[r] ||= []).push(c.id);
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
    prisma.tokenTransaction.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: { tokens: 0, towerBestFloor: 0, mmr: 1000, rankedGames: 0, rankedWins: 0, claimedLevel: 1, towerLastFreeAt: null },
    }),
  ]);
  res.json({ ok: true });
});

module.exports = { router };

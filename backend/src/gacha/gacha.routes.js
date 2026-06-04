// Routes gacha : infos, tirage de cartes, collection
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rollRarity, DUPLICATE_REFUND, PRICES, RARITY_LABELS, RARITY_ORDER, RARITY_RATES } = require('./rarity');
const { rateLimit } = require('../util/ratelimit');

const router = express.Router();

// Infos pour l'UI : prix, taille du pool, répartition par rareté
router.get('/info', async (req, res) => {
  const total = await prisma.character.count();
  const groups = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const byRarity = {};
  groups.forEach((g) => (byRarity[g.rarity] = g._count._all));
  res.json({ prices: PRICES, total, byRarity, labels: RARITY_LABELS });
});

// Choisit un personnage aléatoire d'une rareté donnée (fallback : n'importe lequel)
async function pickRandomCharacter(tx, rarity) {
  let count = await tx.character.count({ where: { rarity } });
  let where = { rarity };
  if (count === 0) {
    count = await tx.character.count();
    where = {};
  }
  if (count === 0) return null;
  const skip = Math.floor(Math.random() * count);
  return tx.character.findFirst({ where, skip });
}

// Tirage : type = 'single' | 'pack'
router.post('/pull', requireAuth, rateLimit({ max: 60 }), async (req, res) => {
  const type = req.body?.type === 'pack' ? 'pack' : 'single';
  const cfg = PRICES[type];
  const userId = req.user.id;

  const poolSize = await prisma.character.count();
  if (poolSize === 0) {
    return res.status(503).json({ error: "Le gacha n'est pas encore disponible (pool vide)" });
  }
  if (req.user.tokens < cfg.cost) {
    return res.status(400).json({ error: 'Pas assez de tokens' });
  }

  // Tirage des raretés (avec garantie rare+ pour les paquets)
  const rarities = Array.from({ length: cfg.count }, () => rollRarity());
  if (cfg.guaranteeRarePlus && !rarities.some((r) => r !== 'common')) {
    rarities[Math.floor(Math.random() * rarities.length)] = 'rare';
  }

  const result = await prisma.$transaction(async (tx) => {
    // Débit du coût
    await tx.user.update({ where: { id: userId }, data: { tokens: { decrement: cfg.cost } } });
    await tx.tokenTransaction.create({ data: { userId, amount: -cfg.cost, reason: 'pack_open' } });

    const cards = [];
    let refundTotal = 0;
    for (const rarity of rarities) {
      const character = await pickRandomCharacter(tx, rarity);
      if (!character) continue;
      const existing = await tx.userCard.findUnique({
        where: { userId_characterId: { userId, characterId: character.id } },
      });
      const isNew = !existing;
      let refund = 0;
      if (isNew) {
        await tx.userCard.create({ data: { userId, characterId: character.id, copies: 1 } });
      } else {
        await tx.userCard.update({
          where: { userId_characterId: { userId, characterId: character.id } },
          data: { copies: { increment: 1 } },
        });
        refund = DUPLICATE_REFUND[character.rarity] || 0;
        refundTotal += refund;
      }
      cards.push({
        id: character.id,
        name: character.name,
        imageUrl: character.imageUrl,
        rarity: character.rarity,
        isNew,
        refund,
      });
    }

    let tokens;
    if (refundTotal > 0) {
      const u = await tx.user.update({
        where: { id: userId },
        data: { tokens: { increment: refundTotal } },
      });
      await tx.tokenTransaction.create({ data: { userId, amount: refundTotal, reason: 'duplicate_refund' } });
      tokens = u.tokens;
    } else {
      tokens = (await tx.user.findUnique({ where: { id: userId } })).tokens;
    }
    return { cards, refundTotal, tokens };
  });

  res.json({ type, cost: cfg.cost, ...result });
});

// Catalogue (pokédex) des personnages : filtre rareté/recherche (nom ou série),
// pagination, et indicateur de possession pour l'utilisateur.
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];
router.get('/characters', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 60;
  const q = (req.query.search || '').trim();
  const rarity = VALID_RARITIES.includes(req.query.rarity) ? req.query.rarity : null;
  const sort = req.query.sort === 'name' ? 'name' : 'favourites';

  const where = {};
  if (rarity) where.rarity = rarity;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { series: { contains: q, mode: 'insensitive' } },
    ];
  }
  const orderBy = sort === 'name' ? [{ name: 'asc' }] : [{ favourites: 'desc' }];

  const [total, chars, pool] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true },
    }),
    prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } }),
  ]);

  // Possession (copies) pour les personnages de la page
  const owned = await prisma.userCard.findMany({
    where: { userId: req.user.id, characterId: { in: chars.map((c) => c.id) } },
    select: { characterId: true, copies: true },
  });
  const ownedById = Object.fromEntries(owned.map((o) => [o.characterId, o.copies]));
  const byRarity = {};
  pool.forEach((g) => (byRarity[g.rarity] = g._count._all));

  res.json({
    characters: chars.map((c) => ({ ...c, owned: ownedById[c.id] || 0 })),
    total,
    page,
    pages: Math.ceil(total / perPage),
    byRarity,
    labels: RARITY_LABELS,
  });
});

// Marque/retire un personnage des favoris (vitrine du profil). Doit être possédé.
router.post('/favorite', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  const favorite = !!req.body?.favorite;
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const card = await prisma.userCard.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId } },
  });
  if (!card) return res.status(400).json({ error: 'Tu ne possèdes pas ce personnage' });
  await prisma.userCard.update({
    where: { userId_characterId: { userId: req.user.id, characterId } },
    data: { favorite },
  });
  res.json({ favorite });
});

// Fiche détaillée d'un personnage (+ possession de l'utilisateur)
router.get('/character/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id invalide' });
  const character = await prisma.character.findUnique({ where: { id } });
  if (!character) return res.status(404).json({ error: 'Personnage introuvable' });

  const card = await prisma.userCard.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId: id } },
  });
  // Rang de popularité au sein de sa rareté (1 = le plus populaire)
  const rankInRarity =
    1 +
    (await prisma.character.count({
      where: { rarity: character.rarity, favourites: { gt: character.favourites } },
    }));
  const totalInRarity = await prisma.character.count({ where: { rarity: character.rarity } });

  res.json({
    character: {
      id: character.id,
      anilistId: character.anilistId,
      name: character.name,
      imageUrl: character.imageUrl,
      rarity: character.rarity,
      favourites: character.favourites,
      fromManga: character.fromManga,
      series: character.series,
    },
    rarityLabel: RARITY_LABELS[character.rarity] || character.rarity,
    pullRate: RARITY_RATES[character.rarity] ?? null,
    dupRefund: DUPLICATE_REFUND[character.rarity] ?? 0,
    rankInRarity,
    totalInRarity,
    owned: card ? card.copies : 0,
    favorite: card ? card.favorite : false,
    anilistUrl: `https://anilist.co/character/${character.anilistId}`,
  });
});

// Collection de l'utilisateur
router.get('/collection', requireAuth, async (req, res) => {
  const cards = await prisma.userCard.findMany({
    where: { userId: req.user.id },
    include: { character: true },
  });
  cards.sort(
    (a, b) =>
      RARITY_ORDER[b.character.rarity] - RARITY_ORDER[a.character.rarity] ||
      (b.character.favourites || 0) - (a.character.favourites || 0)
  );

  // Progression par rareté (possédés / total du pool)
  const pool = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const poolByRarity = {};
  pool.forEach((g) => (poolByRarity[g.rarity] = g._count._all));
  const ownedByRarity = {};
  cards.forEach((c) => (ownedByRarity[c.character.rarity] = (ownedByRarity[c.character.rarity] || 0) + 1));

  res.json({
    cards: cards.map((c) => ({
      id: c.character.id,
      name: c.character.name,
      imageUrl: c.character.imageUrl,
      rarity: c.character.rarity,
      copies: c.copies,
    })),
    poolByRarity,
    ownedByRarity,
    labels: RARITY_LABELS,
  });
});

module.exports = { router };

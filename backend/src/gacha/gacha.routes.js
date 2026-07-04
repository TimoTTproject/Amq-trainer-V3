// Routes gacha : infos, tirage de cartes, collection
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rollRarity, DUPLICATE_REFUND, DUST_GAIN, CRAFT_COST, PITY_LIMIT, PRICES, RARITY_LABELS, RARITY_ORDER, RARITY_RATES, MAX_STARS, ascendCost } = require('./rarity');
const { rateLimit } = require('../util/ratelimit');
const { progressQuests } = require('../quests/quests');

const router = express.Router();

// ── Bannière hebdomadaire (vedettes de la semaine, rate-up) ──
// Sélection déterministe par n° de semaine → pas de cron ni d'action admin.
const WEEK_MS = 7 * 24 * 3600 * 1000;
const WEEKLY_BOOST = 0.6; // proba de tomber sur la vedette de la rareté tirée
let weeklyCache = { week: -1, byRarity: {}, chars: [], resetAt: 0 };

function seededIndex(wk, salt, mod) {
  let h = (wk * 2654435761 + salt) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h % mod;
}

function currentWeek() {
  return Math.floor(Date.now() / WEEK_MS);
}

// Personnage le plus voté pour une semaine donnée (null si aucun vote).
async function topVotedCharacterId(week) {
  const g = await prisma.featuredVote.groupBy({
    by: ['characterId'], where: { week },
    _count: { characterId: true },
    orderBy: { _count: { characterId: 'desc' } },
    take: 1,
  });
  return g.length ? g[0].characterId : null;
}

async function getWeeklyFeatured() {
  const wk = currentWeek();
  if (weeklyCache.week === wk) return weeklyCache;
  const chars = [];
  const byRarity = {};
  const salts = { mythic: 101, legendary: 211, epic: 307 };
  for (const r of ['mythic', 'legendary', 'epic']) {
    const count = await prisma.character.count({ where: { rarity: r } });
    if (!count) continue;
    const idx = seededIndex(wk, salts[r], count);
    const c = await prisma.character.findFirst({
      where: { rarity: r }, orderBy: { favourites: 'desc' }, skip: idx,
      select: { id: true, name: true, imageUrl: true, rarity: true },
    });
    if (c) { chars.push(c); byRarity[r] = c.id; }
  }
  // Vedette élue par les votes de la semaine PRÉCÉDENTE : remplace le slot de sa
  // rareté (ou s'ajoute), avec le même rate-up. Repli sur le déterministe sinon.
  try {
    const winnerId = await topVotedCharacterId(wk - 1);
    if (winnerId) {
      const w = await prisma.character.findUnique({
        where: { id: winnerId }, select: { id: true, name: true, imageUrl: true, rarity: true },
      });
      if (w) {
        byRarity[w.rarity] = w.id;
        const i = chars.findIndex((c) => c.rarity === w.rarity);
        const entry = { ...w, voted: true };
        if (i >= 0) chars[i] = entry; else chars.push(entry);
      }
    }
  } catch (e) { console.warn('weekly vote winner unavailable:', e.message); }

  weeklyCache = { week: wk, byRarity, chars, resetAt: (wk + 1) * WEEK_MS };
  return weeklyCache;
}

// Infos pour l'UI : prix, taille du pool, répartition par rareté
router.get('/info', async (req, res) => {
  const total = await prisma.character.count();
  const groups = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const byRarity = {};
  groups.forEach((g) => (byRarity[g.rarity] = g._count._all));
  const featured = await prisma.character.findMany({
    where: { featured: true },
    select: { id: true, name: true, imageUrl: true, rarity: true },
    take: 12,
  });
  const weekly = await getWeeklyFeatured();
  res.json({
    prices: PRICES, total, byRarity, labels: RARITY_LABELS, featured, craftCost: CRAFT_COST, pityLimit: PITY_LIMIT,
    weeklyFeatured: weekly.chars, weeklyResetAt: weekly.resetAt, weeklyBoost: Math.round(WEEKLY_BOOST * 100),
  });
});

// Fil des derniers tirages Légendaire+ (tous joueurs confondus), pour le hub d'accueil.
router.get('/recent-pulls', requireAuth, async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 12));
  const pulls = await prisma.cardInstance.findMany({
    where: { character: { rarity: { in: ['legendary', 'mythic'] } } },
    orderBy: { obtainedAt: 'desc' },
    take: limit,
    select: {
      serial: true,
      obtainedAt: true,
      character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } },
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  res.json({
    pulls: pulls.map((p) => ({
      characterId: p.character.id,
      name: p.character.name,
      imageUrl: p.character.imageUrl,
      rarity: p.character.rarity,
      rarityLabel: RARITY_LABELS[p.character.rarity],
      series: p.character.series,
      serial: p.serial,
      obtainedAt: p.obtainedAt,
      user: { id: p.user.id, displayName: p.user.displayName, avatarUrl: p.user.avatarUrl },
    })),
  });
});

// Stats de tirage de l'utilisateur : répartition par rareté (réelle vs attendue)
// + indice de chance. La « valeur » d'une rareté = 1/probabilité, si bien que
// l'espérance par tirage vaut le nombre de raretés → indice 100% = pile dans la moyenne.
const RARITY_KEYS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const LUCK_MIN_PULLS = 10;
router.get('/stats', requireAuth, async (req, res) => {
  const u = req.user;
  const counts = {
    common: u.pullCommon || 0, rare: u.pullRare || 0, epic: u.pullEpic || 0,
    legendary: u.pullLegendary || 0, mythic: u.pullMythic || 0,
  };
  const total = RARITY_KEYS.reduce((s, r) => s + counts[r], 0);

  const perRarity = RARITY_KEYS.map((r) => ({
    rarity: r,
    label: RARITY_LABELS[r],
    count: counts[r],
    actualRate: total ? (counts[r] / total) * 100 : 0,
    expectedRate: RARITY_RATES[r], // en %
    expectedCount: total * (RARITY_RATES[r] / 100),
  }));

  let luckPercent = null;
  let luckLabel = `Encore ${Math.max(0, LUCK_MIN_PULLS - total)} tirage(s) pour évaluer ta chance`;
  if (total >= LUCK_MIN_PULLS) {
    let actualValue = 0;
    for (const r of RARITY_KEYS) {
      const p = RARITY_RATES[r] / 100;
      if (p > 0) actualValue += counts[r] * (1 / p);
    }
    const expectedValue = total * RARITY_KEYS.length;
    luckPercent = Math.round((actualValue / expectedValue) * 100);
    luckLabel =
      luckPercent >= 140 ? 'Très chanceux 🍀🍀' :
      luckPercent >= 112 ? 'Chanceux 🍀' :
      luckPercent >= 88 ? 'Dans la moyenne ⚖️' :
      luckPercent >= 60 ? 'Malchanceux 😕' : 'Très malchanceux 💀';
  }

  res.json({
    total, pity: u.pity || 0, pityLimit: PITY_LIMIT,
    perRarity, luck: { percent: luckPercent, label: luckLabel, min: LUCK_MIN_PULLS },
  });
});

// Choisit un personnage aléatoire d'une rareté donnée, NON épuisé (fallback : n'importe lequel non épuisé).
// Si un personnage « vedette » non épuisé existe pour cette rareté, 50% de chance de l'obtenir.
async function pickRandomCharacter(tx, rarity, boost) {
  // Rate-up vedette de la semaine (prioritaire)
  const boostId = boost && boost[rarity];
  if (boostId) {
    const bc = await tx.character.findUnique({ where: { id: boostId }, select: { id: true, name: true, imageUrl: true, rarity: true, featured: true, soldOut: true } });
    if (bc && !bc.soldOut && Math.random() < 0.6) return bc;
  }
  const feat = await tx.character.findFirst({ where: { rarity, featured: true, soldOut: false } });
  if (feat && Math.random() < 0.5) return feat;
  let where = { rarity, soldOut: false };
  let count = await tx.character.count({ where });
  if (count === 0) {
    where = { soldOut: false };
    count = await tx.character.count({ where });
  }
  if (count === 0) return null;
  const skip = Math.floor(Math.random() * count);
  return tx.character.findFirst({ where, skip });
}

// Frappe une nouvelle instance numérotée d'un personnage pour un joueur (dans tx).
// Re-lit le perso (anti-course) ; retourne null si épuisé entre-temps. Sync UserCard.
async function mintInstance(tx, userId, characterId) {
  const c = await tx.character.findUnique({
    where: { id: characterId },
    select: { id: true, minted: true, maxSupply: true, nextSerial: true },
  });
  if (!c || c.minted >= c.maxSupply) return null;
  const serial = c.nextSerial + 1;
  await tx.cardInstance.create({ data: { characterId: c.id, serial, userId } });
  await tx.character.update({
    where: { id: c.id },
    data: { minted: { increment: 1 }, nextSerial: serial, soldOut: c.minted + 1 >= c.maxSupply },
  });
  const existing = await tx.userCard.findUnique({ where: { userId_characterId: { userId, characterId: c.id } } });
  if (existing) {
    await tx.userCard.update({ where: { userId_characterId: { userId, characterId: c.id } }, data: { copies: { increment: 1 } } });
  } else {
    await tx.userCard.create({ data: { userId, characterId: c.id, copies: 1 } });
  }
  return { serial, isNew: !existing };
}

// Détruit jusqu'à n exemplaires (les n° de série les plus hauts) d'un perso pour un joueur.
// Rend les places au stock mondial (minted décrémenté, soldOut levé). Retourne le nb détruit.
async function destroyInstances(tx, userId, characterId, n) {
  if (n <= 0) return 0;
  const insts = await tx.cardInstance.findMany({
    where: { userId, characterId }, orderBy: { serial: 'desc' }, take: n, select: { id: true },
  });
  if (!insts.length) return 0;
  await tx.cardInstance.deleteMany({ where: { id: { in: insts.map((i) => i.id) } } });
  await tx.character.update({
    where: { id: characterId },
    data: { minted: { decrement: insts.length }, soldOut: false },
  });
  return insts.length;
}

// Tirage : type = 'single' | 'pack'
router.post('/pull', requireAuth, rateLimit({ max: 60, name: 'pull' }), async (req, res) => {
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

  // Tirage des raretés avec PITIÉ : garantie d'un Légendaire+ au bout de PITY_LIMIT
  // tirages sans en obtenir. Le compteur est suivi sur le compte.
  let pity = req.user.pity || 0;
  const rarities = [];
  for (let i = 0; i < cfg.count; i++) {
    let r = rollRarity();
    pity++;
    if (pity >= PITY_LIMIT && r !== 'legendary' && r !== 'mythic') r = 'legendary';
    if (r === 'legendary' || r === 'mythic') pity = 0;
    rarities.push(r);
  }
  if (cfg.guaranteeRarePlus && !rarities.some((r) => r !== 'common')) {
    rarities[Math.floor(Math.random() * rarities.length)] = 'rare';
  }

  const weekly = await getWeeklyFeatured();
  const result = await prisma.$transaction(async (tx) => {
    // Débit du coût
    await tx.user.update({ where: { id: userId }, data: { tokens: { decrement: cfg.cost } } });
    await tx.tokenTransaction.create({ data: { userId, amount: -cfg.cost, reason: 'pack_open' } });

    const cards = [];
    let refundTotal = 0;
    let dustTotal = 0;
    const pullCounts = { common: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
    for (const rarity of rarities) {
      const character = await pickRandomCharacter(tx, rarity, weekly.byRarity);
      if (!character) continue;
      const mint = await mintInstance(tx, userId, character.id);
      if (!mint) continue; // épuisé entre-temps (course)
      pullCounts[character.rarity] = (pullCounts[character.rarity] || 0) + 1;
      const isNew = mint.isNew;
      let refund = 0;
      let dust = 0;
      if (!isNew) {
        refund = DUPLICATE_REFUND[character.rarity] || 0;
        dust = DUST_GAIN[character.rarity] || 0;
        refundTotal += refund;
        dustTotal += dust;
      }
      cards.push({
        id: character.id, name: character.name, imageUrl: character.imageUrl,
        rarity: character.rarity, featured: character.featured, isNew, refund, dust, serial: mint.serial,
      });
    }

    const u = await tx.user.update({
      where: { id: userId },
      data: {
        pity,
        ...(refundTotal > 0 ? { tokens: { increment: refundTotal } } : {}),
        ...(dustTotal > 0 ? { dust: { increment: dustTotal } } : {}),
        ...(pullCounts.common ? { pullCommon: { increment: pullCounts.common } } : {}),
        ...(pullCounts.rare ? { pullRare: { increment: pullCounts.rare } } : {}),
        ...(pullCounts.epic ? { pullEpic: { increment: pullCounts.epic } } : {}),
        ...(pullCounts.legendary ? { pullLegendary: { increment: pullCounts.legendary } } : {}),
        ...(pullCounts.mythic ? { pullMythic: { increment: pullCounts.mythic } } : {}),
      },
    });
    if (refundTotal > 0) {
      await tx.tokenTransaction.create({ data: { userId, amount: refundTotal, reason: 'duplicate_refund' } });
    }
    return { cards, refundTotal, dustTotal, tokens: u.tokens, dust: u.dust, pity: u.pity };
  });

  progressQuests(userId, 'pull', cfg.count);
  res.json({ type, cost: cfg.cost, pityLimit: PITY_LIMIT, ...result });
});

// Fabrication : dépense de la poussière pour obtenir un personnage choisi
router.post('/craft', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) return res.status(404).json({ error: 'Personnage introuvable' });
  if (character.soldOut) return res.status(400).json({ error: 'Personnage épuisé — disponible seulement par échange' });
  const cost = CRAFT_COST[character.rarity] || 0;
  if ((req.user.dust || 0) < cost) return res.status(400).json({ error: `Pas assez de poussière (${cost} requis)` });

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const mint = await mintInstance(tx, req.user.id, characterId);
      if (!mint) throw new Error('SOLD_OUT');
      const u = await tx.user.update({ where: { id: req.user.id }, data: { dust: { decrement: cost } } });
      return { dust: u.dust, isNew: mint.isNew, serial: mint.serial };
    });
  } catch (e) {
    if (e.message === 'SOLD_OUT') return res.status(400).json({ error: 'Personnage épuisé entre-temps' });
    throw e;
  }
  res.json({ ...result, cost });
});

// Recyclage : convertit les doublons (copies au-delà de 1) en poussière.
// Garde toujours 1 exemplaire de chaque personnage.
router.post('/recycle', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const out = await prisma.$transaction(async (tx) => {
    const card = await tx.userCard.findUnique({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      include: { character: true },
    });
    if (!card || card.copies <= 1) return { error: 'Aucun doublon à recycler' };
    const extra = card.copies - 1;
    const gain = extra * (DUST_GAIN[card.character.rarity] || 0);
    await destroyInstances(tx, req.user.id, characterId, extra); // rend les places au stock
    await tx.userCard.update({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      data: { copies: 1 },
    });
    const u = await tx.user.update({ where: { id: req.user.id }, data: { dust: { increment: gain } } });
    return { recycled: extra, gain, dust: u.dust };
  });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

// Ascension d'une carte (★) : consomme des DOUBLONS pour monter d'un niveau.
// Purement cosmétique (prestige/vitrine) ; ne touche ni la rareté ni les classements.
router.post('/ascend', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const out = await prisma.$transaction(async (tx) => {
    const card = await tx.userCard.findUnique({
      where: { userId_characterId: { userId: req.user.id, characterId } },
    });
    if (!card) return { error: 'Tu ne possèdes pas cette carte' };
    const stars = card.stars || 1;
    if (stars >= MAX_STARS) return { error: 'Carte déjà au niveau maximum (★' + MAX_STARS + ')' };
    const cost = ascendCost(stars);
    if (card.copies < 1 + cost) return { error: `Il faut ${cost} doublon(s) pour passer ★${stars + 1} (tu en as ${card.copies - 1}).` };
    // Consomme les doublons (rend les places au stock) et garde 1 exemplaire.
    await destroyInstances(tx, req.user.id, characterId, cost);
    const updated = await tx.userCard.update({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      data: { copies: { decrement: cost }, stars: { increment: 1 } },
    });
    return { stars: updated.stars, copies: updated.copies, consumed: cost };
  });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

// Recycle TOUS les doublons de la collection d'un coup.
router.post('/recycle-all', requireAuth, async (req, res) => {
  const dupes = await prisma.userCard.findMany({
    where: { userId: req.user.id, copies: { gt: 1 } },
    include: { character: { select: { rarity: true } } },
  });
  if (!dupes.length) return res.status(400).json({ error: 'Aucun doublon à recycler' });
  let gain = 0, recycled = 0;
  for (const c of dupes) {
    const extra = c.copies - 1;
    recycled += extra;
    gain += extra * (DUST_GAIN[c.character.rarity] || 0);
  }
  const dust = await prisma.$transaction(async (tx) => {
    for (const c of dupes) {
      await destroyInstances(tx, req.user.id, c.characterId, c.copies - 1); // rend les places au stock
      await tx.userCard.update({
        where: { userId_characterId: { userId: req.user.id, characterId: c.characterId } },
        data: { copies: 1 },
      });
    }
    const u = await tx.user.update({ where: { id: req.user.id }, data: { dust: { increment: gain } } });
    return u.dust;
  });
  res.json({ recycled, gain, dust });
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
  // Filtre possession : owned=1 (possédés) | owned=0 (manquants) | absent (tous)
  if (req.query.owned === '0' || req.query.owned === '1') {
    const mine = await prisma.userCard.findMany({ where: { userId: req.user.id }, select: { characterId: true } });
    const ids = mine.map((m) => m.characterId);
    where.id = req.query.owned === '1' ? { in: ids.length ? ids : [0] } : { notIn: ids.length ? ids : [0] };
  }
  const orderBy = sort === 'name' ? [{ name: 'asc' }] : [{ favourites: 'desc' }];

  const [total, chars, pool] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true, soldOut: true },
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
    characters: chars.map((c) => ({ ...c, owned: ownedById[c.id] || 0, craftCost: CRAFT_COST[c.rarity] || 0 })), // c.soldOut inclus via select
    total,
    page,
    pages: Math.ceil(total / perPage),
    byRarity,
    labels: RARITY_LABELS,
    dust: req.user.dust || 0,
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

// ── Wishlist (liste de souhaits) ──
// Ajoute/retire un personnage de sa liste de souhaits (souhait d'obtention).
router.post('/wishlist', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  const wish = !!req.body?.wish;
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  if (wish) {
    const exists = await prisma.character.findUnique({ where: { id: characterId }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Personnage introuvable' });
    await prisma.wishlist.upsert({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      update: {}, create: { userId: req.user.id, characterId },
    });
  } else {
    await prisma.wishlist.deleteMany({ where: { userId: req.user.id, characterId } });
  }
  res.json({ wished: wish });
});

// Wishlist d'un joueur (la sienne par défaut, ou celle d'un autre via ?userId).
router.get('/wishlist', requireAuth, async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const rows = await prisma.wishlist.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, soldOut: true } } },
  });
  // Que possède le joueur CONSULTÉ (pour griser les déjà-obtenus).
  const ownedIds = new Set(
    (await prisma.userCard.findMany({ where: { userId }, select: { characterId: true } })).map((c) => c.characterId)
  );
  res.json({
    items: rows.map((r) => ({ ...r.character, owned: ownedIds.has(r.character.id) })),
  });
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

  // Numéros de série possédés par l'utilisateur pour ce personnage
  const myInstances = await prisma.cardInstance.findMany({
    where: { userId: req.user.id, characterId: id }, orderBy: { serial: 'asc' }, select: { serial: true },
  });
  const wished = !!(await prisma.wishlist.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId: id } }, select: { id: true },
  }));

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
    dustGain: DUST_GAIN[character.rarity] ?? 0,
    rankInRarity,
    totalInRarity,
    owned: card ? card.copies : 0,
    wished,
    stars: card ? (card.stars || 1) : 0,
    ascendCost: card && (card.stars || 1) < MAX_STARS ? ascendCost(card.stars || 1) : 0,
    maxStars: MAX_STARS,
    favorite: card ? card.favorite : false,
    featured: character.featured,
    craftCost: CRAFT_COST[character.rarity] || 0,
    // Rareté réelle : stock mondial + n° de série possédés
    maxSupply: character.maxSupply,
    minted: character.minted,
    available: Math.max(0, character.maxSupply - character.minted),
    soldOut: character.soldOut,
    serials: myInstances.map((i) => i.serial),
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
      series: c.character.series || null,
      copies: c.copies,
      stars: c.stars || 1,
    })),
    poolByRarity,
    ownedByRarity,
    labels: RARITY_LABELS,
  });
});

// ── Progression « par série » : pour chaque anime du pool, combien de
// personnages le joueur possède sur le total existant. Sert à l'onglet
// « Par série » de la collection (barres de progression, tri par avancement).
router.get('/collection/series', requireAuth, async (req, res) => {
  const [all, owned] = await Promise.all([
    prisma.character.findMany({
      select: { id: true, series: true, imageUrl: true, favourites: true },
    }),
    prisma.userCard.findMany({
      where: { userId: req.user.id },
      select: { characterId: true },
    }),
  ]);
  const ownedSet = new Set(owned.map((c) => c.characterId));
  const bySeries = new Map();
  for (const c of all) {
    const key = c.series || 'Autre';
    if (!bySeries.has(key)) bySeries.set(key, { series: key, total: 0, owned: 0, cover: c.imageUrl || null, topFav: -1 });
    const g = bySeries.get(key);
    g.total += 1;
    if (ownedSet.has(c.id)) g.owned += 1;
    // Couverture = personnage le plus populaire de la série
    if ((c.favourites || 0) > g.topFav) { g.topFav = c.favourites || 0; g.cover = c.imageUrl || g.cover; }
  }
  const series = [...bySeries.values()]
    .map(({ topFav, ...s }) => s)
    .sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || b.total - a.total);
  res.json({ series });
});

// ── Vote pour la vedette de la semaine prochaine ──
// Statut : mon vote, classement en cours, échéance, et la vedette élue en cours.
router.get('/vote', requireAuth, async (req, res) => {
  const wk = currentWeek();
  const mine = await prisma.featuredVote.findUnique({
    where: { userId_week: { userId: req.user.id, week: wk } },
    select: { characterId: true },
  });
  const grouped = await prisma.featuredVote.groupBy({
    by: ['characterId'], where: { week: wk },
    _count: { characterId: true },
    orderBy: { _count: { characterId: 'desc' } },
    take: 8,
  });
  const chars = await prisma.character.findMany({
    where: { id: { in: grouped.map((g) => g.characterId) } },
    select: { id: true, name: true, imageUrl: true, rarity: true },
  });
  const byId = Object.fromEntries(chars.map((c) => [c.id, c]));
  const standings = grouped
    .filter((g) => byId[g.characterId])
    .map((g) => ({ ...byId[g.characterId], votes: g._count.characterId }));
  const weekly = await getWeeklyFeatured();
  res.json({
    week: wk,
    closesAt: (wk + 1) * WEEK_MS,
    myVote: mine?.characterId || null,
    standings,
    current: weekly.chars, // vedettes en cours (dont le gagnant du vote précédent)
  });
});

// Émet/modifie mon vote pour la semaine en cours (décide la vedette de la suivante).
router.post('/vote', requireAuth, rateLimit({ max: 30, name: 'gacha-vote' }), async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const c = await prisma.character.findUnique({ where: { id: characterId }, select: { id: true } });
  if (!c) return res.status(404).json({ error: 'Personnage introuvable' });
  const wk = currentWeek();
  await prisma.featuredVote.upsert({
    where: { userId_week: { userId: req.user.id, week: wk } },
    update: { characterId },
    create: { userId: req.user.id, week: wk, characterId },
  });
  res.json({ ok: true, characterId });
});

module.exports = { router };

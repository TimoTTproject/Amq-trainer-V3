// Routes de profil : modification du pseudo, bio et photo
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { publicUser } = require('../auth/auth.routes');
const { tierFromMmr } = require('../mp/rank');
const { resolveEquipped, byId, publicCosmetic } = require('../shop/cosmetics');

const router = express.Router();

const MAX_AVATAR_BYTES = 700 * 1024; // ~700 Ko (l'avatar est redimensionné côté client)

// Valide une data URL d'image (data:image/...;base64,....)
function isValidAvatar(value) {
  if (typeof value !== 'string') return false;
  if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(value)) return false;
  // Taille approximative des octets décodés à partir du base64
  const base64 = value.split(',')[1] || '';
  const bytes = Math.floor((base64.length * 3) / 4);
  return bytes <= MAX_AVATAR_BYTES;
}

// Met à jour le profil de l'utilisateur connecté
router.patch('/', requireAuth, async (req, res) => {
  const { displayName, bio, avatar } = req.body || {};
  const data = {};

  if (displayName !== undefined) {
    const name = String(displayName).trim();
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({ error: 'Le pseudo doit faire entre 2 et 30 caractères' });
    }
    data.displayName = name;
  }

  if (bio !== undefined) {
    const text = String(bio).trim();
    if (text.length > 300) {
      return res.status(400).json({ error: 'La bio est limitée à 300 caractères' });
    }
    data.bio = text || null;
  }

  if (avatar !== undefined) {
    if (avatar === null || avatar === '') {
      data.avatarUrl = null; // suppression de la photo
    } else if (isValidAvatar(avatar)) {
      data.avatarUrl = avatar;
    } else {
      return res.status(400).json({ error: 'Image invalide ou trop lourde (max ~700 Ko)' });
    }
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ error: 'Rien à mettre à jour' });
  }

  const user = await prisma.user.update({ where: { id: req.user.id }, data });
  res.json({ user: publicUser(user) });
});

const RARITY_RANK = { mythic: 4, legendary: 3, epic: 2, rare: 1, common: 0 };

// Niveau / XP dérivés de l'activité (paliers quadratiques : xp = 50·(niv-1)²)
function computeLevel(xp) {
  const level = Math.floor(Math.sqrt(xp / 50)) + 1;
  const curStart = 50 * (level - 1) ** 2;
  const nextStart = 50 * level ** 2;
  return {
    xp,
    level,
    intoLevel: xp - curStart,
    forNext: nextStart - curStart,
    progress: Math.min(1, (xp - curStart) / (nextStart - curStart)),
  };
}

// Récompense en tokens pour avoir atteint un niveau (niveau 1 = départ, 0 token)
function levelReward(level) {
  return level <= 1 ? 0 : level * 20;
}
// Total des récompenses entre deux niveaux (exclus → inclus)
function rewardBetween(fromLevel, toLevel) {
  let sum = 0;
  for (let l = fromLevel + 1; l <= toLevel; l++) sum += levelReward(l);
  return sum;
}

// XP d'un utilisateur (même formule que le GET, réutilisée pour la réclamation)
async function getUserXp(userId) {
  const stats = await prisma.userSongStat.findMany({
    where: { userId },
    select: { playCount: true, correctCount: true },
  });
  const played = stats.reduce((s, x) => s + x.playCount, 0);
  const correct = stats.reduce((s, x) => s + x.correctCount, 0);
  const cardsCount = await prisma.userCard.count({ where: { userId } });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { towerBestFloor: true } });
  return played * 5 + correct * 10 + cardsCount * 8 + (u?.towerBestFloor || 0) * 15;
}

// Réclame les récompenses des niveaux franchis depuis la dernière réclamation
router.post('/claim-levels', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const xp = await getUserXp(userId);
  const current = computeLevel(xp).level;
  const claimed = req.user.claimedLevel || 1;
  if (current <= claimed) return res.json({ granted: 0, tokens: req.user.tokens, claimedLevel: claimed, level: current });

  const reward = rewardBetween(claimed, current);
  const u = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { tokens: { increment: reward }, claimedLevel: current },
    });
    if (reward > 0) await tx.tokenTransaction.create({ data: { userId, amount: reward, reason: 'level_reward' } });
    return user;
  });
  res.json({ granted: reward, tokens: u.tokens, claimedLevel: current, level: current });
});

// Annuaire des joueurs : liste paginée + recherche par pseudo (vue Communauté)
router.get('/players/list', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 30;
  const q = (req.query.search || '').trim();
  const where = q ? { displayName: { contains: q, mode: 'insensitive' } } : {};
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: [{ mmr: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true, mmr: true, rankedGames: true, towerBestFloor: true, createdAt: true },
    }),
  ]);
  res.json({
    total, page, pages: Math.ceil(total / perPage),
    players: users.map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl,
      frame: publicCosmetic(byId(u.avatarFrame)),
      tier: u.rankedGames > 0 ? tierFromMmr(u.mmr) : null,
      towerBestFloor: u.towerBestFloor || 0,
      isMe: u.id === req.user.id,
    })),
  });
});

// Profil riche d'un joueur (sert le profil perso ET la fiche publique)
router.get('/:userId', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, displayName: true, avatarUrl: true, bio: true, createdAt: true, tokens: true, towerBestFloor: true, claimedLevel: true, mmr: true, rankedGames: true, rankedWins: true, soloMmr: true, soloGames: true, soloBestScore: true, cardBack: true, cardBorder: true, profileBanner: true, avatarFrame: true },
  });
  if (!user) return res.status(404).json({ error: 'Joueur introuvable' });

  // Stats quiz + top séries jouées
  const songStats = await prisma.userSongStat.findMany({
    where: { userId: user.id },
    select: { playCount: true, correctCount: true, song: { select: { animeTitle: true } } },
  });
  const played = songStats.reduce((s, x) => s + x.playCount, 0);
  const correct = songStats.reduce((s, x) => s + x.correctCount, 0);
  const seriesMap = {};
  for (const s of songStats) {
    if (!s.playCount) continue;
    const t = s.song?.animeTitle || '—';
    (seriesMap[t] ||= { title: t, plays: 0, correct: 0 }).plays += s.playCount;
    seriesMap[t].correct += s.correctCount;
  }
  const topSeries = Object.values(seriesMap).sort((a, b) => b.plays - a.plays).slice(0, 6);

  // Collection : cartes triées, répartition par rareté
  const cards = await prisma.userCard.findMany({ where: { userId: user.id }, include: { character: true } });
  cards.sort(
    (a, b) =>
      RARITY_RANK[b.character.rarity] - RARITY_RANK[a.character.rarity] ||
      (b.stars || 1) - (a.stars || 1) || // à rareté égale, les cartes ascensionnées priment
      (b.character.favourites || 0) - (a.character.favourites || 0)
  );
  const ownedByRarity = {};
  cards.forEach((c) => (ownedByRarity[c.character.rarity] = (ownedByRarity[c.character.rarity] || 0) + 1));
  const pool = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const poolByRarity = {};
  pool.forEach((g) => (poolByRarity[g.rarity] = g._count._all));
  // Vitrine : les favoris en priorité, sinon les meilleures cartes
  const favs = cards.filter((c) => c.favorite);
  const showcaseCards = (favs.length ? favs : cards).slice(0, 6);
  const showcase = showcaseCards.map((c) => ({
    id: c.character.id, name: c.character.name, imageUrl: c.character.imageUrl,
    rarity: c.character.rarity, copies: c.copies, favorite: c.favorite, stars: c.stars || 1,
  }));

  // Graphe de progression : 14 derniers jours d'activité
  const daily = await prisma.dailyStat.findMany({
    where: { userId: user.id }, orderBy: { day: 'desc' }, take: 14,
    select: { day: true, played: true, correct: true },
  });
  const progression = daily.reverse().map((d) => ({
    day: d.day, played: d.played, rate: d.played ? Math.round((d.correct / d.played) * 100) : 0,
  }));

  // Historique Château (parties terminées récentes)
  const towerHistory = await prisma.towerRun.findMany({
    where: { userId: user.id, status: 'over' },
    orderBy: { finishedAt: 'desc' },
    take: 8,
    select: { floor: true, finishedAt: true },
  });

  const xp = played * 5 + correct * 10 + cards.length * 8 + (user.towerBestFloor || 0) * 15;
  const lvl = computeLevel(xp);
  const claimed = user.claimedLevel || 1;

  // Stats classées + dernières parties multi
  const mpRecent = await prisma.mpResult.findMany({
    where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 6,
    select: { ranked: true, placement: true, players: true, score: true, mmrAfter: true, mmrBefore: true, createdAt: true },
  });

  res.json({
    user,
    cosmetics: resolveEquipped(user),
    stats: { played, correct, rate: played ? Math.round((correct / played) * 100) : 0 },
    ranked: {
      mmr: user.mmr, tier: tierFromMmr(user.mmr), games: user.rankedGames, wins: user.rankedWins,
      winrate: user.rankedGames ? Math.round((user.rankedWins / user.rankedGames) * 100) : 0,
    },
    solo: {
      mmr: user.soloMmr, tier: user.soloGames > 0 ? tierFromMmr(user.soloMmr) : null,
      games: user.soloGames, bestScore: user.soloBestScore,
    },
    mpRecent,
    level: lvl,
    levelReward: {
      claimed,
      pending: rewardBetween(claimed, lvl.level),
      nextLevel: lvl.level + 1,
      nextReward: levelReward(lvl.level + 1),
    },
    cardsCount: cards.length,
    ownedByRarity,
    poolByRarity,
    bestCard: showcase[0] || null,
    showcase,
    topSeries,
    towerHistory,
    progression,
  });
});

module.exports = { router };

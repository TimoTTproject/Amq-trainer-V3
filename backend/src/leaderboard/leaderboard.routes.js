// Classements : Château (meilleur étage), Tokens, Collection (cartes distinctes)
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { tierFromMmr } = require('../mp/rank');
const { byId, publicCosmetic } = require('../shop/cosmetics');
const { weekKey } = require('../util/week');
const { RARITY_RATES } = require('../gacha/rarity');

const router = express.Router();
const TOP_N = 50;
const LUCK_MIN_PULLS = 50;
const LUCK_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// Cadre d'avatar (cosmétique) prêt à appliquer côté front, ou null
const frameOf = (u) => publicCosmetic(byId(u.avatarFrame));

function pullCountsOf(u) {
  return {
    common: u.pullCommon || 0,
    rare: u.pullRare || 0,
    epic: u.pullEpic || 0,
    legendary: u.pullLegendary || 0,
    mythic: u.pullMythic || 0,
  };
}

function luckPercentFromCounts(counts) {
  const total = LUCK_RARITIES.reduce((sum, r) => sum + counts[r], 0);
  if (total < LUCK_MIN_PULLS) return null;
  const actualValue = LUCK_RARITIES.reduce((sum, r) => {
    const p = RARITY_RATES[r] / 100;
    return p > 0 ? sum + counts[r] * (1 / p) : sum;
  }, 0);
  const expectedValue = total * LUCK_RARITIES.length;
  return Math.round((actualValue / expectedValue) * 100);
}

// Classé (MMR) : classement par MMR parmi les joueurs ayant joué en classé
async function rankedBoard(meId) {
  const users = await prisma.user.findMany({
    where: { rankedGames: { gt: 0 } },
    orderBy: { mmr: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true, mmr: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1, userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, frame: frameOf(u),
    value: u.mmr, tier: tierFromMmr(u.mmr), isMe: u.id === meId,
  }));
  const me = await prisma.user.findUnique({ where: { id: meId }, select: { mmr: true, rankedGames: true } });
  let myRank = null;
  if (me?.rankedGames > 0) {
    const better = await prisma.user.count({ where: { rankedGames: { gt: 0 }, mmr: { gt: me.mmr } } });
    myRank = { rank: better + 1, value: me.mmr, tier: tierFromMmr(me.mmr) };
  }
  return { top, me: myRank };
}

// Solo classé (défi du jour) : classement par MMR solo
async function soloBoard(meId) {
  const users = await prisma.user.findMany({
    where: { soloGames: { gt: 0 } },
    orderBy: { soloMmr: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true, soloMmr: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1, userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, frame: frameOf(u),
    value: u.soloMmr, tier: tierFromMmr(u.soloMmr), isMe: u.id === meId,
  }));
  const me = await prisma.user.findUnique({ where: { id: meId }, select: { soloMmr: true, soloGames: true } });
  let myRank = null;
  if (me?.soloGames > 0) {
    const better = await prisma.user.count({ where: { soloGames: { gt: 0 }, soloMmr: { gt: me.soloMmr } } });
    myRank = { rank: better + 1, value: me.soloMmr, tier: tierFromMmr(me.soloMmr) };
  }
  return { top, me: myRank };
}

// Château : classement par meilleur étage atteint
async function towerBoard(meId) {
  const users = await prisma.user.findMany({
    where: { towerBestFloor: { gt: 0 } },
    orderBy: { towerBestFloor: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true, towerBestFloor: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    frame: frameOf(u),
    value: u.towerBestFloor,
    isMe: u.id === meId,
  }));
  const me = await prisma.user.findUnique({ where: { id: meId }, select: { towerBestFloor: true } });
  let myRank = null;
  if (me?.towerBestFloor > 0) {
    const better = await prisma.user.count({ where: { towerBestFloor: { gt: me.towerBestFloor } } });
    myRank = { rank: better + 1, value: me.towerBestFloor };
  }
  return { top, me: myRank };
}

// Coop (Tour en équipe) : meilleur étage de la SEMAINE en cours. Les 2 premiers
// gagnent des tokens en fin de semaine (récompense hebdomadaire).
async function coopBoard(meId) {
  const week = weekKey();
  const rows = await prisma.coopWeeklyScore.findMany({
    where: { week, floor: { gt: 0 } },
    orderBy: { floor: 'desc' },
    take: TOP_N,
    select: { userId: true, floor: true, user: { select: { displayName: true, avatarUrl: true, avatarFrame: true } } },
  });
  const top = rows.map((r, i) => ({
    rank: i + 1, userId: r.userId, displayName: r.user.displayName, avatarUrl: r.user.avatarUrl,
    frame: frameOf(r.user), value: r.floor, isMe: r.userId === meId,
  }));
  const mineRow = await prisma.coopWeeklyScore.findUnique({ where: { userId_week: { userId: meId, week } }, select: { floor: true } });
  let myRank = null;
  if (mineRow && mineRow.floor > 0) {
    const better = await prisma.coopWeeklyScore.count({ where: { week, floor: { gt: mineRow.floor } } });
    myRank = { rank: better + 1, value: mineRow.floor };
  }
  return { top, me: myRank, week, rewards: [800, 400] };
}

// Tokens : classement par solde
async function tokensBoard(meId) {
  const users = await prisma.user.findMany({
    where: { tokens: { gt: 0 } },
    orderBy: { tokens: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true, tokens: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    frame: frameOf(u),
    value: u.tokens,
    isMe: u.id === meId,
  }));
  const me = await prisma.user.findUnique({ where: { id: meId }, select: { tokens: true } });
  const better = await prisma.user.count({ where: { tokens: { gt: me?.tokens || 0 } } });
  return { top, me: { rank: better + 1, value: me?.tokens || 0 } };
}

// Collection : classement par nombre de personnages distincts possédés
async function collectionBoard(meId) {
  const grouped = await prisma.userCard.groupBy({ by: ['userId'], _count: { _all: true } });
  grouped.sort((a, b) => b._count._all - a._count._all);

  const topGroups = grouped.slice(0, TOP_N);
  const users = await prisma.user.findMany({
    where: { id: { in: topGroups.map((g) => g.userId) } },
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true },
  });
  const usersById = Object.fromEntries(users.map((u) => [u.id, u]));
  const top = topGroups.map((g, i) => ({
    rank: i + 1,
    userId: g.userId,
    displayName: usersById[g.userId]?.displayName || '—',
    avatarUrl: usersById[g.userId]?.avatarUrl || null,
    frame: usersById[g.userId] ? frameOf(usersById[g.userId]) : null,
    value: g._count._all,
    isMe: g.userId === meId,
  }));

  const mine = grouped.find((g) => g.userId === meId);
  const myValue = mine ? mine._count._all : 0;
  let myRank = null;
  if (myValue > 0) {
    myRank = { rank: grouped.filter((g) => g._count._all > myValue).length + 1, value: myValue };
  }
  return { top, me: myRank };
}

// Chance gacha : classement par indice relatif de raretés obtenues.
// Minimum 50 tirages, sinon un seul Mythique rendrait le classement beaucoup trop
// bruyant. Valeur front : 1 = proche des taux de base, 1.25 = +25% au-dessus.
async function luckBoard(meId) {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { pullCommon: { gt: 0 } },
        { pullRare: { gt: 0 } },
        { pullEpic: { gt: 0 } },
        { pullLegendary: { gt: 0 } },
        { pullMythic: { gt: 0 } },
      ],
    },
    select: {
      id: true, displayName: true, avatarUrl: true, avatarFrame: true,
      pullCommon: true, pullRare: true, pullEpic: true, pullLegendary: true, pullMythic: true,
    },
  });

  const ranked = users
    .map((u) => {
      const counts = pullCountsOf(u);
      const total = LUCK_RARITIES.reduce((sum, r) => sum + counts[r], 0);
      const luckPercent = luckPercentFromCounts(counts);
      if (luckPercent == null) return null;
      return {
        userId: u.id,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        frame: frameOf(u),
        value: luckPercent / 100,
        pullCount: total,
        isMe: u.id === meId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.value - a.value) || (b.pullCount - a.pullCount) || a.displayName.localeCompare(b.displayName, 'fr'));

  const withRanks = ranked.map((row, i) => ({ rank: i + 1, ...row }));
  const me = withRanks.find((row) => row.userId === meId);
  return {
    top: withRanks.slice(0, TOP_N),
    me: me ? { rank: me.rank, value: me.value, pullCount: me.pullCount } : null,
    minPulls: LUCK_MIN_PULLS,
  };
}

router.get('/', requireAuth, async (req, res) => {
  const type = ['tokens', 'collection', 'ranked', 'solo', 'coop', 'luck'].includes(req.query.type) ? req.query.type : 'tower';
  const board =
    type === 'tokens'
      ? await tokensBoard(req.user.id)
      : type === 'collection'
      ? await collectionBoard(req.user.id)
      : type === 'ranked'
      ? await rankedBoard(req.user.id)
      : type === 'solo'
      ? await soloBoard(req.user.id)
      : type === 'coop'
      ? await coopBoard(req.user.id)
      : type === 'luck'
      ? await luckBoard(req.user.id)
      : await towerBoard(req.user.id);
  res.json({ type, ...board });
});

module.exports = { router };

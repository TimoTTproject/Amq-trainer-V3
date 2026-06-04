// Classements : Château (meilleur étage), Tokens, Collection (cartes distinctes)
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');

const router = express.Router();
const TOP_N = 50;

// Château : classement par meilleur étage atteint
async function towerBoard(meId) {
  const users = await prisma.user.findMany({
    where: { towerBestFloor: { gt: 0 } },
    orderBy: { towerBestFloor: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, towerBestFloor: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
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

// Tokens : classement par solde
async function tokensBoard(meId) {
  const users = await prisma.user.findMany({
    where: { tokens: { gt: 0 } },
    orderBy: { tokens: 'desc' },
    take: TOP_N,
    select: { id: true, displayName: true, avatarUrl: true, tokens: true },
  });
  const top = users.map((u, i) => ({
    rank: i + 1,
    userId: u.id,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
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
    select: { id: true, displayName: true, avatarUrl: true },
  });
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const top = topGroups.map((g, i) => ({
    rank: i + 1,
    userId: g.userId,
    displayName: byId[g.userId]?.displayName || '—',
    avatarUrl: byId[g.userId]?.avatarUrl || null,
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

router.get('/', requireAuth, async (req, res) => {
  const type = ['tokens', 'collection'].includes(req.query.type) ? req.query.type : 'tower';
  const board =
    type === 'tokens'
      ? await tokensBoard(req.user.id)
      : type === 'collection'
      ? await collectionBoard(req.user.id)
      : await towerBoard(req.user.id);
  res.json({ type, ...board });
});

module.exports = { router };

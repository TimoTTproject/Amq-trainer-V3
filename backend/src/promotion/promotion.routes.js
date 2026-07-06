// Vote « Édition 2 » : chaque joueur choisit jusqu'à MAX_VOTES personnages
// distincts (1 voix chacune, pas de cumul) qu'il aimerait voir promus en
// Mythique/Légendaire à la future édition. Le nombre exact de promotions
// n'est pas encore fixé — ces routes ne font que constituer un classement.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rateLimit } = require('../util/ratelimit');

const router = express.Router();
const MAX_VOTES = 10;

function publicCharacter(c) {
  return {
    id: c.id, anilistId: c.anilistId, name: c.name, imageUrl: c.imageUrl,
    rarity: c.rarity, series: c.series, edition: c.edition,
  };
}

// Mes votes + voix restantes.
router.get('/status', requireAuth, async (req, res) => {
  const votes = await prisma.promotionVote.findMany({
    where: { userId: req.user.id },
    include: { character: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    max: MAX_VOTES,
    used: votes.length,
    remaining: Math.max(0, MAX_VOTES - votes.length),
    votes: votes.map((v) => publicCharacter(v.character)),
  });
});

// Vote pour un personnage (idempotent si déjà voté).
router.post('/vote', requireAuth, rateLimit({ max: 30, name: 'promotion-vote' }), async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'Personnage invalide.' });

  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) return res.status(404).json({ error: 'Personnage introuvable.' });

  const existing = await prisma.promotionVote.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId } },
  });
  if (existing) return res.json({ ok: true, alreadyVoted: true });

  const count = await prisma.promotionVote.count({ where: { userId: req.user.id } });
  if (count >= MAX_VOTES) {
    return res.status(400).json({ error: `Tu as déjà utilisé tes ${MAX_VOTES} voix — retire-en une pour en choisir une autre.` });
  }

  await prisma.promotionVote.create({ data: { userId: req.user.id, characterId } });
  res.json({ ok: true, used: count + 1, remaining: MAX_VOTES - (count + 1) });
});

// Retire un vote (pour changer d'avis).
router.delete('/vote/:characterId', requireAuth, async (req, res) => {
  const characterId = parseInt(req.params.characterId);
  await prisma.promotionVote.deleteMany({ where: { userId: req.user.id, characterId } });
  const count = await prisma.promotionVote.count({ where: { userId: req.user.id } });
  res.json({ ok: true, used: count, remaining: MAX_VOTES - count });
});

// Classement public des personnages les plus votés (tous rarement/toutes
// raretés confondues — le vote sert à repérer les chouchous de la communauté).
router.get('/leaderboard', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const grouped = await prisma.promotionVote.groupBy({
    by: ['characterId'],
    _count: { characterId: true },
    orderBy: { _count: { characterId: 'desc' } },
    take: limit,
  });
  if (!grouped.length) return res.json({ total: 0, entries: [] });

  const characters = await prisma.character.findMany({ where: { id: { in: grouped.map((g) => g.characterId) } } });
  const byId = new Map(characters.map((c) => [c.id, c]));
  const entries = grouped
    .map((g) => {
      const c = byId.get(g.characterId);
      if (!c) return null;
      return { ...publicCharacter(c), votes: g._count.characterId };
    })
    .filter(Boolean);
  const totalVoters = await prisma.promotionVote.groupBy({ by: ['userId'] });
  res.json({ total: totalVoters.length, entries });
});

module.exports = { router, MAX_VOTES };

// Récompenses de saison (mensuelles), SANS reset du MMR : on réclame une fois
// par saison une récompense selon son meilleur palier (solo OU multi), à
// condition d'avoir joué en classé/défi pendant la saison (anti-claim passif).
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rateLimit } = require('../util/ratelimit');
const { tierFromMmr } = require('../mp/rank');
const {
  currentSeason, seasonLabel, seasonStart, seasonEnd,
  tierIndexFromName, computeSeasonReward,
} = require('./season');

const router = express.Router();

// Meilleur palier du joueur (index + objet tier) entre solo et multi.
function bestTier(user) {
  const cands = [];
  if (user.rankedGames > 0) cands.push(tierFromMmr(user.mmr));
  if (user.soloGames > 0) cands.push(tierFromMmr(user.soloMmr));
  let best = null, bestIdx = -1;
  for (const t of cands) {
    const idx = tierIndexFromName(t.name);
    if (idx > bestIdx) { bestIdx = idx; best = t; }
  }
  return { tier: best, index: bestIdx };
}

// A-t-il joué en classé (multi ou défi) depuis le début de la saison ?
async function activeThisSeason(userId, start) {
  const [mp, daily] = await Promise.all([
    prisma.mpResult.count({ where: { userId, ranked: true, createdAt: { gte: start } } }),
    prisma.dailyRun.count({ where: { userId, finished: true, createdAt: { gte: start } } }),
  ]);
  return mp + daily > 0;
}

async function buildStatus(userId) {
  const season = currentSeason();
  const start = seasonStart(season);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mmr: true, rankedGames: true, soloMmr: true, soloGames: true },
  });
  const { tier, index } = bestTier(user);
  const reward = computeSeasonReward(index);
  const [claim, active] = await Promise.all([
    prisma.seasonClaim.findUnique({ where: { userId_season: { userId, season } } }),
    activeThisSeason(userId, start),
  ]);
  return {
    season,
    label: seasonLabel(season),
    endsAt: seasonEnd(season).toISOString(),
    tier,
    reward,
    active,
    claimed: !!claim,
    claimable: !claim && active && index >= 0,
  };
}

router.get('/status', requireAuth, async (req, res) => {
  res.json(await buildStatus(req.user.id));
});

router.post('/claim', requireAuth, rateLimit({ max: 20, name: 'season-claim' }), async (req, res) => {
  const status = await buildStatus(req.user.id);
  if (status.claimed) return res.status(400).json({ error: 'Récompense de saison déjà réclamée.' });
  if (!status.active) return res.status(400).json({ error: 'Joue au moins une partie classée ou un défi du jour cette saison.' });
  if (!status.tier) return res.status(400).json({ error: 'Pas encore classé.' });

  const { tokens, dust } = status.reward;
  try {
    await prisma.$transaction([
      prisma.seasonClaim.create({
        data: { userId: req.user.id, season: status.season, tier: status.tier.name, tokens, dust },
      }),
      prisma.user.update({
        where: { id: req.user.id },
        data: { tokens: { increment: tokens }, dust: { increment: dust } },
      }),
      prisma.tokenTransaction.create({ data: { userId: req.user.id, amount: tokens, reason: 'season_reward' } }),
    ]);
  } catch (e) {
    // Course (double clic) → la contrainte unique [userId, season] protège.
    return res.status(400).json({ error: 'Récompense déjà réclamée.' });
  }
  res.json({ ok: true, tokens, dust, tier: status.tier });
});

module.exports = { router };

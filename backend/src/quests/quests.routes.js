// Routes quêtes : liste du jour + réclamation des récompenses.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { ensureDailyQuests, todayStr } = require('./quests');

const router = express.Router();

function publicQuest(q) {
  const progress = Math.min(q.progress, q.target);
  return {
    id: q.id, label: q.label, target: q.target, progress,
    reward: q.reward, claimed: q.claimed, done: q.progress >= q.target,
  };
}

router.get('/', requireAuth, async (req, res) => {
  const quests = await ensureDailyQuests(req.user.id);
  res.json({ quests: quests.map(publicQuest) });
});

router.post('/claim/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const q = await prisma.quest.findFirst({ where: { id, userId: req.user.id, day: todayStr() } });
  if (!q) return res.status(404).json({ error: 'Quête introuvable' });
  if (q.claimed) return res.status(400).json({ error: 'Déjà réclamée' });
  if (q.progress < q.target) return res.status(400).json({ error: 'Quête non terminée' });

  const user = await prisma.$transaction(async (tx) => {
    await tx.quest.update({ where: { id }, data: { claimed: true } });
    const u = await tx.user.update({ where: { id: req.user.id }, data: { tokens: { increment: q.reward } } });
    await tx.tokenTransaction.create({ data: { userId: req.user.id, amount: q.reward, reason: 'quest_reward' } });
    return u;
  });
  res.json({ granted: q.reward, tokens: user.tokens });
});

module.exports = { router };

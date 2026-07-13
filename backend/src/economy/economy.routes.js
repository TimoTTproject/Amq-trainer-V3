// Routes économie : historique des transactions de tokens
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { quizCapState, QUIZ_CAP } = require('../quiz/quiz.routes');
const { mpCapState, MP_REWARD_CAP } = require('../mp/mp');

const router = express.Router();

const DAILY_BONUS = 100;

// Libellés lisibles pour l'historique
const REASON_LABELS = {
  quiz_first_correct: 'Bonne réponse (découverte)',
  quiz_correct: 'Bonne réponse',
  pack_open: 'Ouverture de paquet',
  idle_recruit: 'Invocation Anime Ascension',
  duplicate_refund: 'Doublon remboursé',
  tower_entry: 'Entrée au Château',
  tower_reward: 'Récompense du Château',
  level_reward: 'Récompense de niveau',
  admin_grant: 'Bonus admin',
  daily_bonus: 'Bonus quotidien',
  quest_reward: 'Récompense de quête',
  cosmetic_purchase: 'Achat boutique',
  mp_reward: 'Récompense multijoueur',
  coop_reward: 'Tour en équipe (coop)',
  coop_weekly: 'Classement coop hebdo 🏆',
  daily_reward: 'Défi du jour',
  season_reward: 'Récompense de saison',
};

// Bonus de connexion déjà disponible aujourd'hui ?
function dailyAvailable(last) {
  if (!last) return true;
  const a = new Date(last);
  const b = new Date();
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

// Réclame le bonus quotidien
router.post('/daily', requireAuth, async (req, res) => {
  if (!dailyAvailable(req.user.lastDailyAt)) {
    return res.status(400).json({ error: 'Bonus déjà réclamé aujourd\'hui' });
  }
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: req.user.id },
      data: { tokens: { increment: DAILY_BONUS }, lastDailyAt: new Date() },
    });
    await tx.tokenTransaction.create({ data: { userId: req.user.id, amount: DAILY_BONUS, reason: 'daily_bonus' } });
    return u;
  });
  res.json({ granted: DAILY_BONUS, tokens: user.tokens });
});

// Solde autoritaire. Utilisé après les gains asynchrones (notamment le
// multijoueur) pour éviter toute dérive d'affichage côté client.
router.get('/balance', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { tokens: true, dust: true },
  });
  if (!user) return res.status(404).json({ error: 'Compte introuvable' });
  res.json(user);
});

// État des plafonds anti-farm (quiz solo + multi/coop : tous deux en fenêtre
// glissante de 6h) — consultable hors quiz (ex. clic sur la monnaie dans l'en-tête).
router.get('/reward-caps', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { quizRewardAt: true, quizRewardWindow: true, mpRewardAt: true, mpRewardWindow: true },
  });
  if (!user) return res.status(404).json({ error: 'Compte introuvable' });
  const quiz = quizCapState(user);
  const multiplayer = mpCapState(user);
  res.json({
    quiz: { used: quiz.used, max: QUIZ_CAP, resetAt: quiz.resetAt },
    multiplayer: { used: multiplayer.used, max: MP_REWARD_CAP, resetAt: multiplayer.resetAt },
  });
});

router.get('/transactions', requireAuth, async (req, res) => {
  const tx = await prisma.tokenTransaction.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  res.json({
    balance: req.user.tokens,
    transactions: tx.map((t) => ({
      amount: t.amount,
      reason: REASON_LABELS[t.reason] || t.reason,
      createdAt: t.createdAt,
    })),
  });
});

module.exports = { router };

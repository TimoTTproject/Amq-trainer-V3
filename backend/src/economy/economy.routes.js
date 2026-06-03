// Routes économie : historique des transactions de tokens
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');

const router = express.Router();

// Libellés lisibles pour l'historique
const REASON_LABELS = {
  quiz_first_correct: 'Bonne réponse (découverte)',
  quiz_correct: 'Bonne réponse',
  pack_open: 'Ouverture de paquet',
};

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

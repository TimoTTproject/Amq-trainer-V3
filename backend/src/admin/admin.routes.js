// Routes admin (outils de test). Réservées aux comptes admin.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('./admin');

const router = express.Router();

// Crédite des tokens au compte courant (test gacha / achats)
router.post('/tokens', requireAuth, requireAdmin, async (req, res) => {
  const amount = Math.max(1, Math.min(100000, parseInt(req.body?.amount) || 1000));
  const userId = req.user.id;
  const u = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { tokens: { increment: amount } } });
    await tx.tokenTransaction.create({ data: { userId, amount, reason: 'admin_grant' } });
    return user;
  });
  res.json({ granted: amount, tokens: u.tokens });
});

module.exports = { router };

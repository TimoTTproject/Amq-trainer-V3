// Retours joueurs génériques (bug / suggestion), via le bouton flottant présent
// sur toutes les pages. Distinct de /api/quiz/report-song qui vise une musique
// précise pendant une partie.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rateLimit } = require('../util/ratelimit');

const router = express.Router();
const VALID_TYPES = new Set(['bug', 'suggestion']);

router.post('/', requireAuth, rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: 'feedback' }), async (req, res) => {
  const { type, message, page } = req.body || {};
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'type invalide' });
  const text = String(message || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'message requis' });
  await prisma.feedback.create({
    data: { userId: req.user.id, type, message: text, page: page ? String(page).slice(0, 200) : null },
  });
  res.json({ ok: true });
});

module.exports = { router };

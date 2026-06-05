// Analytics léger : enregistre une visite (visiteur unique par jour).
const express = require('express');
const { prisma } = require('../db');
const { rateLimit } = require('../util/ratelimit');

const router = express.Router();

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Ping de visite (anonyme, id stocké côté client). Public, rate-limité.
router.post('/hit', rateLimit({ max: 30, name: 'hit' }), async (req, res) => {
  const vid = String(req.body?.visitorId || '').slice(0, 40);
  if (!vid) return res.json({ ok: false });
  const day = today();
  try {
    await prisma.visit.upsert({
      where: { visitorId_day: { visitorId: vid, day } },
      update: req.user ? { authed: true } : {},
      create: { visitorId: vid, day, authed: !!req.user },
    });
  } catch { /* non bloquant */ }
  res.json({ ok: true });
});

module.exports = { router };

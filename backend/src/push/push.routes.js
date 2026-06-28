// Routes Web Push : clé publique VAPID, (dés)abonnement, test.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { isEnabled, publicKey, sendToUser } = require('./push');

const router = express.Router();

// Clé publique + état (le front masque l'option si désactivé).
router.get('/key', (req, res) => res.json({ enabled: isEnabled(), publicKey: publicKey() }));

// Enregistre l'abonnement du navigateur courant pour l'utilisateur.
router.post('/subscribe', requireAuth, async (req, res) => {
  const sub = req.body?.subscription || req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Abonnement invalide' });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    update: { userId: req.user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    create: { userId: req.user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
  res.json({ ok: true });
});

// Envoi de test à soi-même (vérification rapide de la config).
router.post('/test', requireAuth, async (req, res) => {
  const sent = await sendToUser(req.user.id, {
    title: 'Test 🔔', body: 'Les notifications fonctionnent !', url: '/?nav=daily',
  });
  res.json({ ok: true, sent });
});

module.exports = { router };

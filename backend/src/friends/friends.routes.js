// Routes amis : recherche, demandes, acceptation, liste (avec présence en ligne).
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { isOnline } = require('../mp/mp');
const { byId, publicCosmetic } = require('../shop/cosmetics');

const router = express.Router();

const pubUser = (u) => ({ id: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl, frame: publicCosmetic(byId(u.avatarFrame)) });
const SEL = { id: true, displayName: true, avatarUrl: true, avatarFrame: true };

// Recherche par pseudo (hors soi-même), pour envoyer une demande
router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const users = await prisma.user.findMany({
    where: { displayName: { contains: q, mode: 'insensitive' }, NOT: { id: req.user.id } },
    select: SEL,
    take: 10,
  });
  res.json({ results: users.map(pubUser) });
});

// Liste : amis (acceptés), demandes reçues, demandes envoyées
router.get('/', requireAuth, async (req, res) => {
  const me = req.user.id;
  const all = await prisma.friendship.findMany({
    where: { OR: [{ requesterId: me }, { addresseeId: me }] },
    include: { requester: { select: SEL }, addressee: { select: SEL } },
  });
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of all) {
    const other = f.requesterId === me ? f.addressee : f.requester;
    if (f.status === 'accepted') friends.push({ ...pubUser(other), online: isOnline(other.id) });
    else if (f.addresseeId === me) incoming.push(pubUser(f.requester));
    else outgoing.push(pubUser(f.addressee));
  }
  friends.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.displayName.localeCompare(b.displayName));
  res.json({ friends, incoming, outgoing });
});

// Envoie une demande (ou accepte directement si réciproque)
router.post('/request', requireAuth, async (req, res) => {
  const target = String(req.body?.userId || '');
  if (!target || target === req.user.id) return res.status(400).json({ error: 'Cible invalide' });
  const exists = await prisma.user.findUnique({ where: { id: target }, select: { id: true } });
  if (!exists) return res.status(404).json({ error: 'Joueur introuvable' });

  // Demande inverse déjà en attente → on accepte
  const reverse = await prisma.friendship.findUnique({
    where: { requesterId_addresseeId: { requesterId: target, addresseeId: req.user.id } },
  });
  if (reverse) {
    if (reverse.status !== 'accepted') {
      await prisma.friendship.update({ where: { id: reverse.id }, data: { status: 'accepted' } });
    }
    return res.json({ status: 'accepted' });
  }
  await prisma.friendship.upsert({
    where: { requesterId_addresseeId: { requesterId: req.user.id, addresseeId: target } },
    update: {},
    create: { requesterId: req.user.id, addresseeId: target, status: 'pending' },
  });
  res.json({ status: 'pending' });
});

// Accepte une demande reçue
router.post('/accept', requireAuth, async (req, res) => {
  const from = String(req.body?.userId || '');
  const f = await prisma.friendship.findUnique({
    where: { requesterId_addresseeId: { requesterId: from, addresseeId: req.user.id } },
  });
  if (!f || f.status === 'accepted') return res.status(400).json({ error: 'Aucune demande' });
  await prisma.friendship.update({ where: { id: f.id }, data: { status: 'accepted' } });
  res.json({ ok: true });
});

// Refuse une demande / supprime un ami (dans les deux sens)
router.post('/remove', requireAuth, async (req, res) => {
  const other = String(req.body?.userId || '');
  await prisma.friendship.deleteMany({
    where: {
      OR: [
        { requesterId: req.user.id, addresseeId: other },
        { requesterId: other, addresseeId: req.user.id },
      ],
    },
  });
  res.json({ ok: true });
});

module.exports = { router };

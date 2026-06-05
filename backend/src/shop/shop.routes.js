// Routes boutique : catalogue de cosmétiques, achat (tokens) et équipement.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { COSMETICS, SLOTS, SLOT_LABELS, byId, publicCosmetic } = require('./cosmetics');

const router = express.Router();

// Catalogue complet groupé par slot, avec possession + équipement de l'utilisateur.
router.get('/', requireAuth, async (req, res) => {
  const owned = await prisma.userCosmetic.findMany({
    where: { userId: req.user.id },
    select: { cosmeticId: true },
  });
  const ownedIds = new Set(owned.map((o) => o.cosmeticId));

  const groups = SLOTS.map((slot) => ({
    slot,
    label: SLOT_LABELS[slot],
    equipped: req.user[slot] || null, // null = item par défaut du slot
    items: COSMETICS.filter((c) => c.slot === slot).map((c) => ({
      ...publicCosmetic(c),
      price: c.price,
      owned: c.price === 0 || ownedIds.has(c.id), // les items gratuits sont possédés d'office
      equipped: (req.user[slot] || null) === c.id || (c.price === 0 && !req.user[slot]),
    })),
  }));

  res.json({ tokens: req.user.tokens, groups });
});

// Achat d'un cosmétique avec des tokens.
router.post('/buy', requireAuth, async (req, res) => {
  const item = byId(req.body?.cosmeticId);
  if (!item) return res.status(404).json({ error: 'Cosmétique introuvable' });
  if (item.price === 0) return res.status(400).json({ error: 'Cet article est déjà disponible' });

  const already = await prisma.userCosmetic.findUnique({
    where: { userId_cosmeticId: { userId: req.user.id, cosmeticId: item.id } },
  });
  if (already) return res.status(400).json({ error: 'Déjà possédé' });
  if (req.user.tokens < item.price) return res.status(400).json({ error: 'Pas assez de tokens' });

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: req.user.id },
      data: { tokens: { decrement: item.price } },
    });
    await tx.userCosmetic.create({ data: { userId: req.user.id, cosmeticId: item.id } });
    await tx.tokenTransaction.create({ data: { userId: req.user.id, amount: -item.price, reason: 'cosmetic_purchase' } });
    return u;
  });

  res.json({ ok: true, cosmeticId: item.id, tokens: user.tokens });
});

// Équipe un cosmétique (ou revient au défaut du slot si id par défaut/null).
router.post('/equip', requireAuth, async (req, res) => {
  const id = req.body?.cosmeticId || null;
  // Revenir au défaut : on accepte null ou l'id de l'item gratuit du slot.
  if (id) {
    const item = byId(id);
    if (!item) return res.status(404).json({ error: 'Cosmétique introuvable' });
    if (item.price > 0) {
      const owned = await prisma.userCosmetic.findUnique({
        where: { userId_cosmeticId: { userId: req.user.id, cosmeticId: id } },
      });
      if (!owned) return res.status(400).json({ error: 'Tu ne possèdes pas cet article' });
    }
    // On stocke null pour l'item par défaut (price 0) → apparence standard.
    const value = item.price === 0 ? null : id;
    await prisma.user.update({ where: { id: req.user.id }, data: { [item.slot]: value } });
    return res.json({ ok: true, slot: item.slot, equipped: value });
  }
  res.status(400).json({ error: 'cosmeticId requis' });
});

module.exports = { router };

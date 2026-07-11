// Routes du Dojo (idle/clicker) : état, récolte, assignation d'emplacements,
// clic manuel, améliorations. Monnaie "essence" entièrement séparée des tokens
// (cf. src/idle/idle.js) — pas de TokenTransaction ici.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('../admin/admin');
const { rateLimit } = require('../util/ratelimit');
const {
  MAX_SLOTS,
  START_SLOTS,
  slotRate,
  prodMultiplier,
  prodUpgradeCost,
  PROD_LEVEL_MAX,
  clickYield,
  clickUpgradeCost,
  CLICK_LEVEL_MAX,
  CLICK_COOLDOWN_MS,
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  pendingEssence,
} = require('./idle');

const router = express.Router();

class IdleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Emplacements + niveau ★ (issu de UserCard) des personnages assignés.
async function loadRateInputs(tx, userId) {
  const slots = await tx.idleSlot.findMany({
    where: { userId },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true } } },
  });
  const charIds = slots.filter((s) => s.characterId).map((s) => s.characterId);
  const cards = charIds.length
    ? await tx.userCard.findMany({ where: { userId, characterId: { in: charIds } }, select: { characterId: true, stars: true } })
    : [];
  const starsMap = new Map(cards.map((c) => [c.characterId, c.stars || 1]));
  return { slots, starsMap };
}

function computeTotalRate(slots, starsMap, prodLevel) {
  const base = slots.reduce(
    (sum, s) => (s.characterId && s.character ? sum + slotRate(s.character.rarity, starsMap.get(s.characterId) || 1) : sum),
    0
  );
  return base * prodMultiplier(prodLevel);
}

// Solde l'essence en attente (production passive depuis idleLastCollectAt,
// plafonnée) puis laisse `mutate` appliquer son effet — le tout dans UNE
// transaction, pour que le taux utilisé au calcul soit celui d'avant la
// mutation (ex. avant de changer un emplacement) et que rien ne se perde.
async function withSettle(userId, mutate) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new IdleError(404, 'Compte introuvable');
    const { slots, starsMap } = await loadRateInputs(tx, userId);
    const totalRate = computeTotalRate(slots, starsMap, user.idleProdLevel);
    const collected = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));
    const settledUser = await tx.user.update({
      where: { id: userId },
      data: { essence: { increment: collected }, idleLastCollectAt: new Date() },
    });
    if (mutate) await mutate(tx, settledUser);
    return settledUser;
  });
}

// État complet pour l'affichage (essence, emplacements 0..MAX_SLOTS-1, coûts).
async function buildState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { essence: true, idleLastCollectAt: true, idleSlotsUnlocked: true, idleProdLevel: true, idleClickLevel: true },
  });
  if (!user) return null;
  const { slots, starsMap } = await loadRateInputs(prisma, userId);
  const totalRate = computeTotalRate(slots, starsMap, user.idleProdLevel);
  const pending = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));

  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const slotsOut = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = bySlot.get(i);
    const locked = i >= user.idleSlotsUnlocked;
    let character = null;
    if (row && row.characterId && row.character) {
      const stars = starsMap.get(row.characterId) || 1;
      character = {
        id: row.character.id,
        name: row.character.name,
        imageUrl: row.character.imageUrl,
        rarity: row.character.rarity,
        stars,
        rate: slotRate(row.character.rarity, stars),
      };
    }
    slotsOut.push({ index: i, locked, character, unlockCost: locked ? slotUpgradeCost(i) : null });
  }

  return {
    essence: user.essence,
    pendingEssence: pending,
    totalRate,
    lastCollectAt: user.idleLastCollectAt,
    offlineCapMs: OFFLINE_CAP_MS,
    slots: slotsOut,
    slotsUnlocked: user.idleSlotsUnlocked,
    maxSlots: MAX_SLOTS,
    startSlots: START_SLOTS,
    prod: {
      level: user.idleProdLevel,
      multiplier: prodMultiplier(user.idleProdLevel),
      nextCost: user.idleProdLevel < PROD_LEVEL_MAX ? prodUpgradeCost(user.idleProdLevel) : null,
      maxed: user.idleProdLevel >= PROD_LEVEL_MAX,
    },
    click: {
      level: user.idleClickLevel,
      yield: clickYield(user.idleClickLevel),
      nextCost: user.idleClickLevel < CLICK_LEVEL_MAX ? clickUpgradeCost(user.idleClickLevel) : null,
      maxed: user.idleClickLevel >= CLICK_LEVEL_MAX,
    },
  };
}

// TEMPORAIRE (phase de test) : réservé aux admins tant que le Dojo n'est pas
// ouvert à tous — retirer `requireAdmin` sur ces 6 routes pour la sortie publique.
router.get('/state', requireAuth, requireAdmin, async (req, res) => {
  const state = await buildState(req.user.id);
  if (!state) return res.status(404).json({ error: 'Compte introuvable' });
  res.json(state);
});

router.post('/collect', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  try {
    await withSettle(req.user.id, null);
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

router.post('/assign', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  const characterId = Number(req.body?.characterId);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return res.status(400).json({ error: 'Emplacement invalide' });
  }
  if (!Number.isInteger(characterId)) return res.status(400).json({ error: 'Personnage invalide' });

  try {
    await withSettle(req.user.id, async (tx, user) => {
      if (slotIndex >= user.idleSlotsUnlocked) throw new IdleError(400, 'Cet emplacement est verrouillé');
      const owned = await tx.userCard.findUnique({ where: { userId_characterId: { userId: user.id, characterId } } });
      if (!owned) throw new IdleError(400, 'Tu ne possèdes pas ce personnage');
      // Déplace le personnage s'il était déjà assigné ailleurs (1 seul emplacement à la fois).
      await tx.idleSlot.updateMany({
        where: { userId: user.id, characterId, slotIndex: { not: slotIndex } },
        data: { characterId: null, assignedAt: null },
      });
      await tx.idleSlot.upsert({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        update: { characterId, assignedAt: new Date() },
        create: { userId: user.id, slotIndex, characterId, assignedAt: new Date() },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

router.post('/unassign', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return res.status(400).json({ error: 'Emplacement invalide' });
  }
  try {
    await withSettle(req.user.id, async (tx, user) => {
      await tx.idleSlot.updateMany({ where: { userId: user.id, slotIndex }, data: { characterId: null, assignedAt: null } });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

router.post('/upgrade', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  const type = req.body?.type;
  if (!['prod', 'click', 'slot'].includes(type)) return res.status(400).json({ error: 'Type invalide' });

  try {
    await withSettle(req.user.id, async (tx, user) => {
      if (type === 'prod') {
        if (user.idleProdLevel >= PROD_LEVEL_MAX) throw new IdleError(400, 'Niveau maximum atteint');
        const cost = prodUpgradeCost(user.idleProdLevel);
        if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost }, idleProdLevel: { increment: 1 } } });
      } else if (type === 'click') {
        if (user.idleClickLevel >= CLICK_LEVEL_MAX) throw new IdleError(400, 'Niveau maximum atteint');
        const cost = clickUpgradeCost(user.idleClickLevel);
        if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost }, idleClickLevel: { increment: 1 } } });
      } else if (type === 'slot') {
        if (user.idleSlotsUnlocked >= MAX_SLOTS) throw new IdleError(400, 'Tous les emplacements sont débloqués');
        const cost = slotUpgradeCost(user.idleSlotsUnlocked);
        if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost }, idleSlotsUnlocked: { increment: 1 } } });
      }
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// Clic manuel : gain instantané indépendant de la production passive (pas de
// solde de `pending` ici, juste un ajout — évite de perdre de l'essence à
// l'arrondi si le clic est spammé, cf. commentaire de withSettle).
router.post('/click', requireAuth, requireAdmin, rateLimit({ windowMs: CLICK_COOLDOWN_MS, max: 1, name: 'idle-click' }), async (req, res) => {
  const gained = clickYield(req.user.idleClickLevel || 0);
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { essence: { increment: gained } }, select: { essence: true } });
  res.json({ essence: user.essence, gained });
});

module.exports = { router };

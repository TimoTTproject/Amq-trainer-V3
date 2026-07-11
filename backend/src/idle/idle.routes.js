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
  charLevelUpCost,
  dojoLevelForXp,
  dojoXpForLevel,
  dojoLevelMultiplier,
  decorForLevel,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  prestigeMultiplier,
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

// N'accepte que les emplacements dont le personnage est encore RÉELLEMENT
// possédé (présent dans starsMap, dérivé de UserCard) — pas seulement encore
// présent dans le catalogue (`s.character`). Un perso échangé/vendu/fusionné
// pendant qu'il était assigné disparaît de UserCard (la ligne est supprimée à
// 0 exemplaire, cf. trade/market/fuse) sans que l'IdleSlot soit prévenu ; sans
// ce garde-fou, `?? 1` ferait tourner l'emplacement comme si de rien n'était.
function computeTotalRate(slots, starsMap, prodLevel, dojoLevel, prestigeLevel) {
  const base = slots.reduce(
    (sum, s) => (s.characterId && s.character && starsMap.has(s.characterId) ? sum + slotRate(s.character.rarity, starsMap.get(s.characterId), s.level) : sum),
    0
  );
  return base * prodMultiplier(prodLevel) * dojoLevelMultiplier(dojoLevel) * prestigeMultiplier(prestigeLevel);
}

// Emplacements dont le personnage assigné n'est plus possédé (cf. commentaire
// de computeTotalRate) — à vider.
function orphanedSlotIndexes(slots, starsMap) {
  return slots.filter((s) => s.characterId && !starsMap.has(s.characterId)).map((s) => s.slotIndex);
}

// Solde l'essence en attente (production passive depuis idleLastCollectAt,
// plafonnée) puis laisse `mutate` appliquer son effet — le tout dans UNE
// transaction, pour que le taux utilisé au calcul soit celui d'avant la
// mutation (ex. avant de changer un emplacement) et que rien ne se perde.
// `essenceEarnedTotal` (jamais décrémentée) suit aussi ce gain : c'est elle qui
// fait progresser le niveau du Dojo (décor + bonus), indépendamment de ce que
// le joueur dépense ensuite en améliorations.
async function withSettle(userId, mutate) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new IdleError(404, 'Compte introuvable');
    const { slots, starsMap } = await loadRateInputs(tx, userId);
    const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
    const totalRate = computeTotalRate(slots, starsMap, user.idleProdLevel, dojoLevel, user.prestigeLevel);
    const collected = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));
    const settledUser = await tx.user.update({
      where: { id: userId },
      data: { essence: { increment: collected }, essenceEarnedTotal: { increment: collected }, idleLastCollectAt: new Date() },
    });
    // Vide les emplacements dont le personnage a été échangé/vendu/fusionné
    // entre-temps (cf. computeTotalRate) — la production n'en tenait déjà plus
    // compte, ceci nettoie juste l'IdleSlot pour que l'emplacement redevienne
    // assignable normalement au lieu de rester "occupé" par un fantôme.
    const orphans = orphanedSlotIndexes(slots, starsMap);
    if (orphans.length) {
      await tx.idleSlot.updateMany({
        where: { userId, slotIndex: { in: orphans } },
        data: { characterId: null, assignedAt: null, level: 1 },
      });
    }
    if (mutate) await mutate(tx, settledUser);
    return settledUser;
  });
}

// État complet pour l'affichage (essence, emplacements 0..MAX_SLOTS-1, coûts,
// niveau/décor du Dojo).
async function buildState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      essence: true, idleLastCollectAt: true, idleSlotsUnlocked: true, idleProdLevel: true, idleClickLevel: true,
      essenceEarnedTotal: true, idleMilestoneClaimed: true, prestigeLevel: true,
    },
  });
  if (!user) return null;
  const { slots, starsMap } = await loadRateInputs(prisma, userId);
  const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
  const totalRate = computeTotalRate(slots, starsMap, user.idleProdLevel, dojoLevel, user.prestigeLevel);
  const pending = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));

  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const slotsOut = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = bySlot.get(i);
    const locked = i >= user.idleSlotsUnlocked;
    let character = null;
    // starsMap.has(...) : n'affiche que si le personnage est encore RÉELLEMENT
    // possédé (cf. computeTotalRate) — un slot orphelin s'affiche vide, prêt à
    // être auto-nettoyé en base à la prochaine action (voir withSettle).
    if (row && row.characterId && row.character && starsMap.has(row.characterId)) {
      const stars = starsMap.get(row.characterId);
      const level = row.level || 1;
      character = {
        id: row.character.id,
        name: row.character.name,
        imageUrl: row.character.imageUrl,
        rarity: row.character.rarity,
        stars,
        level,
        rate: slotRate(row.character.rarity, stars, level),
        levelUpCost: charLevelUpCost(row.character.rarity, level),
      };
    }
    slotsOut.push({ index: i, locked, character, unlockCost: locked ? slotUpgradeCost(i) : null });
  }

  const { current: decor, next: nextDecor } = decorForLevel(dojoLevel);
  const xpIntoLevel = user.essenceEarnedTotal - dojoXpForLevel(dojoLevel);
  const xpForNextLevel = dojoXpForLevel(dojoLevel + 1) - dojoXpForLevel(dojoLevel);
  const milestoneTier = milestoneTierForLevel(dojoLevel);

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
    dojo: {
      level: dojoLevel,
      xpTotal: user.essenceEarnedTotal,
      xpIntoLevel,
      xpForNextLevel,
      progress: xpForNextLevel > 0 ? Math.min(1, xpIntoLevel / xpForNextLevel) : 1,
      multiplier: dojoLevelMultiplier(dojoLevel),
      decor,
      nextDecor: nextDecor ? { ...nextDecor, levelsRemaining: nextDecor.level - dojoLevel } : null,
      milestone: {
        tier: milestoneTier,
        claimed: user.idleMilestoneClaimed,
        available: milestoneTier > user.idleMilestoneClaimed,
        reward: milestoneTier > user.idleMilestoneClaimed ? milestoneReward(milestoneTier) : null,
      },
      prestige: {
        level: user.prestigeLevel,
        multiplier: prestigeMultiplier(user.prestigeLevel),
        minLevel: PRESTIGE_MIN_DOJO_LEVEL,
        eligible: dojoLevel >= PRESTIGE_MIN_DOJO_LEVEL,
      },
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

// Monte le niveau d'entraînement (illimité) du personnage assigné à un
// emplacement — distinct des ★ d'ascension gacha, remis à 1 si on change de
// personnage sur cet emplacement (cf. commentaire IdleSlot.level).
router.post('/slot-level', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return res.status(400).json({ error: 'Emplacement invalide' });
  }
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const slot = await tx.idleSlot.findUnique({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        include: { character: { select: { rarity: true } } },
      });
      if (!slot || !slot.characterId || !slot.character) throw new IdleError(400, 'Cet emplacement est vide');
      const cost = charLevelUpCost(slot.character.rarity, slot.level || 1);
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { level: { increment: 1 } } });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// Réclame le coffre du jalon en cours (tous les MILESTONE_INTERVAL niveaux de
// Dojo). Permanent : n'est jamais remis à zéro, y compris après une Prestige.
router.post('/claim-milestone', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
      const tier = milestoneTierForLevel(dojoLevel);
      if (tier <= user.idleMilestoneClaimed) throw new IdleError(400, 'Aucun coffre à réclamer pour l’instant');
      const reward = milestoneReward(tier);
      await tx.user.update({
        where: { id: user.id },
        data: { essence: { increment: reward }, idleMilestoneClaimed: tier },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// Prestige (« Retraite du Maître ») : reset la RUN contre un bonus de
// production permanent (+PRESTIGE_BONUS_PER_LEVEL par niveau, cumulable à
// l'infini). Le niveau du Dojo (essenceEarnedTotal) et les jalons réclamés
// sont volontairement CONSERVÉS — seule la puissance personnelle repart à zéro.
router.post('/prestige', requireAuth, requireAdmin, rateLimit({ max: 5, name: 'idle-prestige' }), async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      if (!user) throw new IdleError(404, 'Compte introuvable');
      const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
      if (dojoLevel < PRESTIGE_MIN_DOJO_LEVEL) {
        throw new IdleError(400, `Le Dojo doit atteindre le niveau ${PRESTIGE_MIN_DOJO_LEVEL} avant de prestiger`);
      }
      await tx.idleSlot.updateMany({ where: { userId: user.id }, data: { characterId: null, assignedAt: null, level: 1 } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          essence: 0,
          idleSlotsUnlocked: START_SLOTS,
          idleProdLevel: 0,
          idleClickLevel: 0,
          idleLastCollectAt: new Date(),
          prestigeLevel: { increment: 1 },
        },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// Clic manuel : gain instantané indépendant de la production passive (pas de
// solde de `pending` ici, juste un ajout — évite de perdre de l'essence à
// l'arrondi si le clic est spammé, cf. commentaire de withSettle). Compte
// aussi pour l'XP du Dojo (essenceEarnedTotal).
router.post('/click', requireAuth, requireAdmin, rateLimit({ windowMs: CLICK_COOLDOWN_MS, max: 1, name: 'idle-click' }), async (req, res) => {
  const gained = clickYield(req.user.idleClickLevel || 0);
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { essence: { increment: gained }, essenceEarnedTotal: { increment: gained } },
    select: { essence: true },
  });
  res.json({ essence: user.essence, gained });
});

module.exports = { router };

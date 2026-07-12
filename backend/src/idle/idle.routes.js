// Routes du Dojo (idle/clicker) : état, récolte, recrutement, assignation
// d'emplacements, clic manuel, améliorations. Monnaie "essence" et roster de
// personnages ENTIÈREMENT séparés du gacha — ni UserCard/CardInstance/tokens
// ni TokenTransaction ne sont jamais lus ou écrits ici (cf. src/idle/idle.js).
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
  stageForXp,
  stageXpForLevel,
  decorForLevel,
  DOJO_DECOR,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  prestigeMultiplier,
  rollRecruitRarity,
  recruitCost,
} = require('./idle');

const router = express.Router();

class IdleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Habillage visuel du décor : un « gardien » mythique réel (portrait
// AniList déjà en base) + un fond tiré d'un anime (jaquette déjà récupérée
// par le catalogue de musiques, cf. Song.coverUrl) — aucune donnée externe
// nouvelle, aucune URL inventée, tout vient de ce que le site a déjà importé.
// Choix déterministe par palier (même gardien pour tout le monde à un palier
// donné, pas de tirage aléatoire à chaque requête) + petit cache mémoire (le
// pool de personnages/jaquettes ne change pas d'une requête à l'autre) pour
// ne pas taper la base à chaque GET /state.
const DECOR_ART_TTL_MS = 30 * 60 * 1000;
const decorArtCache = new Map(); // theme -> { data, at }
async function decorArtForTheme(theme) {
  const cached = decorArtCache.get(theme);
  if (cached && Date.now() - cached.at < DECOR_ART_TTL_MS) return cached.data;
  const data = await fetchDecorArt(theme);
  decorArtCache.set(theme, { data, at: Date.now() });
  return data;
}
async function fetchDecorArt(theme) {
  const tierIndex = Math.max(0, DOJO_DECOR.findIndex((t) => t.theme === theme));
  const mythics = await prisma.character.findMany({
    where: { rarity: 'mythic' },
    select: { id: true, name: true, imageUrl: true, seriesId: true },
    orderBy: { id: 'asc' },
  });
  if (!mythics.length) return null;
  // Essaie quelques candidats à partir du palier (déterministe) si le premier
  // choix n'a pas de portrait ou de jaquette exploitable.
  for (let offset = 0; offset < Math.min(mythics.length, 6); offset++) {
    const boss = mythics[(tierIndex + offset) % mythics.length];
    if (!boss.imageUrl) continue;
    let backgroundUrl = null;
    if (boss.seriesId) {
      // `NOT IN (NULL, ...)` en SQL ne filtre RIEN (NULL dans la liste rend la
      // condition UNKNOWN pour toutes les lignes) — deux conditions séparées.
      const song = await prisma.song.findFirst({
        where: { anilistId: boss.seriesId, coverUrl: { not: null, notIn: [''] } },
        select: { coverUrl: true },
      });
      // Song.coverUrl stocke coverImage.medium (~100 px, suffisant pour les
      // vignettes du quiz) — bien trop petit pour un visuel de scène : étiré,
      // ça donnait une bouillie floue. Le CDN AniList sert la même image en
      // /large/ (~230 px), on réécrit juste le segment du chemin.
      backgroundUrl = song?.coverUrl ? song.coverUrl.replace('/medium/', '/large/') : null;
    }
    return { characterId: boss.id, name: boss.name, imageUrl: boss.imageUrl, backgroundUrl };
  }
  return null;
}

// Emplacements + personnage (catalogue) assigné, pour le calcul de production.
// Pas besoin de revérifier la possession ici : un IdleSlot.characterId n'est
// posé QUE par /assign (qui vérifie le roster DojoRecruit à ce moment-là), et
// DojoRecruit/Character sont en CASCADE l'un sur l'autre — si un personnage
// disparaît un jour du catalogue, la ligne IdleSlot qui le référence se vide
// automatiquement via la contrainte FK (onDelete: SetNull), pas besoin d'un
// garde-fou applicatif en plus.
async function loadSlots(tx, userId) {
  return tx.idleSlot.findMany({
    where: { userId },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true } } },
  });
}

function computeTotalRate(slots, prodLevel, dojoLevel, prestigeLevel) {
  const base = slots.reduce(
    (sum, s) => (s.characterId && s.character ? sum + slotRate(s.character.rarity, s.level) : sum),
    0
  );
  return base * prodMultiplier(prodLevel) * dojoLevelMultiplier(dojoLevel) * prestigeMultiplier(prestigeLevel);
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
    const slots = await loadSlots(tx, userId);
    const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
    const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, user.prestigeLevel);
    const collected = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));
    const settledUser = await tx.user.update({
      where: { id: userId },
      data: { essence: { increment: collected }, essenceEarnedTotal: { increment: collected }, idleLastCollectAt: new Date() },
    });
    if (mutate) await mutate(tx, settledUser);
    return settledUser;
  });
}

// État complet pour l'affichage (essence, emplacements 0..MAX_SLOTS-1, coûts,
// niveau/décor du Dojo, recrutement).
async function buildState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      essence: true, idleLastCollectAt: true, idleSlotsUnlocked: true, idleProdLevel: true, idleClickLevel: true,
      essenceEarnedTotal: true, idleMilestoneClaimed: true, prestigeLevel: true,
    },
  });
  if (!user) return null;
  const [slots, recruitCount] = await Promise.all([
    loadSlots(prisma, userId),
    prisma.dojoRecruit.count({ where: { userId } }),
  ]);
  const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
  const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, user.prestigeLevel);
  const pending = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate));

  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const slotsOut = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = bySlot.get(i);
    const locked = i >= user.idleSlotsUnlocked;
    let character = null;
    if (row && row.characterId && row.character) {
      const level = row.level || 1;
      character = {
        id: row.character.id,
        name: row.character.name,
        imageUrl: row.character.imageUrl,
        rarity: row.character.rarity,
        level,
        rate: slotRate(row.character.rarity, level),
        levelUpCost: charLevelUpCost(row.character.rarity, level),
      };
    }
    slotsOut.push({ index: i, locked, character, unlockCost: locked ? slotUpgradeCost(i) : null });
  }

  const { current: decor, next: nextDecor } = decorForLevel(dojoLevel);
  const decorArt = await decorArtForTheme(decor.theme);
  const xpIntoLevel = user.essenceEarnedTotal - dojoXpForLevel(dojoLevel);
  const xpForNextLevel = dojoXpForLevel(dojoLevel + 1) - dojoXpForLevel(dojoLevel);
  const milestoneTier = milestoneTierForLevel(dojoLevel);

  // Stage de combat : PAS le niveau du Dojo (trop lent, volontairement — il
  // pilote le décor/les paliers). Le stage vient de la même source (l'essence
  // gagnée à vie) mais avec une courbe bien plus douce, pour des kills toutes
  // les quelques secondes façon Clicker Heroes (cf. commentaire dans idle.js).
  const stage = stageForXp(user.essenceEarnedTotal);
  const xpIntoStage = user.essenceEarnedTotal - stageXpForLevel(stage);
  const xpForNextStage = stageXpForLevel(stage + 1) - stageXpForLevel(stage);

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
    recruit: { count: recruitCount, nextCost: recruitCost(recruitCount) },
    battle: {
      stage,
      xpIntoStage,
      xpForNextStage,
      progress: xpForNextStage > 0 ? Math.min(1, xpIntoStage / xpForNextStage) : 1,
    },
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
      decor: { ...decor, boss: decorArt ? { characterId: decorArt.characterId, name: decorArt.name, imageUrl: decorArt.imageUrl } : null, backgroundUrl: decorArt?.backgroundUrl || null },
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
// ouvert à tous — retirer `requireAdmin` sur ces routes pour la sortie publique.
router.get('/state', requireAuth, requireAdmin, async (req, res) => {
  const state = await buildState(req.user.id);
  if (!state) return res.status(404).json({ error: 'Compte introuvable' });
  res.json(state);
});

// Roster du joueur (personnages recrutés) — pour le sélecteur d'assignation.
// Totalement indépendant de /api/gacha/collection.
router.get('/roster', requireAuth, requireAdmin, async (req, res) => {
  const recruits = await prisma.dojoRecruit.findMany({
    where: { userId: req.user.id },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true } } },
    orderBy: { recruitedAt: 'desc' },
  });
  res.json({
    recruits: recruits.map((r) => ({
      id: r.character.id, name: r.character.name, imageUrl: r.character.imageUrl, rarity: r.character.rarity,
    })),
  });
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

// Recrute un personnage au hasard (pondéré par rareté, cf. RECRUIT_WEIGHTS)
// contre de l'essence — la SEULE façon d'obtenir un personnage dans le Dojo.
// Exclut les personnages déjà recrutés par ce joueur ; si la rareté tirée est
// épuisée (tout recruté), retombe sur les autres raretés dans l'ordre.
router.post('/recruit', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mutate' }), async (req, res) => {
  let result;
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const count = await tx.dojoRecruit.count({ where: { userId: user.id } });
      const cost = recruitCost(count);
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      const already = (await tx.dojoRecruit.findMany({ where: { userId: user.id }, select: { characterId: true } })).map((r) => r.characterId);
      const rolled = rollRecruitRarity();
      let pool = await tx.character.findMany({ where: { rarity: rolled, id: { notIn: already } }, select: { id: true, name: true, imageUrl: true, rarity: true, series: true } });
      if (!pool.length) {
        for (const r of ['common', 'rare', 'epic', 'legendary', 'mythic']) {
          pool = await tx.character.findMany({ where: { rarity: r, id: { notIn: already } }, select: { id: true, name: true, imageUrl: true, rarity: true, series: true } });
          if (pool.length) break;
        }
      }
      if (!pool.length) throw new IdleError(400, 'Tu as déjà recruté tout le roster disponible !');
      const picked = pool[Math.floor(Math.random() * pool.length)];
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.dojoRecruit.create({ data: { userId: user.id, characterId: picked.id } });
      result = picked;
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  // `recruited` (le personnage tout juste obtenu) est distinct de `recruit`
  // (compteur/coût du prochain) déjà renvoyé par buildState() — le spread
  // doit passer EN PREMIER, sinon il écraserait `recruited` s'il portait le
  // même nom.
  res.json({ ...(await buildState(req.user.id)), recruited: result });
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
      const recruited = await tx.dojoRecruit.findUnique({ where: { userId_characterId: { userId: user.id, characterId } } });
      if (!recruited) throw new IdleError(400, "Tu n'as pas recruté ce personnage");
      // Le niveau d'entraînement appartient à L'EMPLACEMENT, pas au personnage
      // (cf. IdleSlot.level) : il doit repartir à 1 dès qu'un AUTRE personnage
      // y prend place — sinon un perso tout juste assigné hériterait gratuitement
      // du niveau (donc de la production) laissé par l'occupant précédent.
      // No-op si c'est déjà le même personnage (évite de punir un clic redondant).
      const currentSlot = await tx.idleSlot.findUnique({ where: { userId_slotIndex: { userId: user.id, slotIndex } } });
      const sameCharacter = currentSlot && currentSlot.characterId === characterId;
      // Déplace le personnage s'il était déjà assigné ailleurs (1 seul emplacement à la fois).
      await tx.idleSlot.updateMany({
        where: { userId: user.id, characterId, slotIndex: { not: slotIndex } },
        data: { characterId: null, assignedAt: null },
      });
      await tx.idleSlot.upsert({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        update: { characterId, assignedAt: new Date(), ...(sameCharacter ? {} : { level: 1 }) },
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
// emplacement, remis à 1 si on change de personnage sur cet emplacement
// (cf. commentaire IdleSlot.level).
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
// l'infini). Le niveau du Dojo (essenceEarnedTotal), le roster recruté et les
// jalons réclamés sont volontairement CONSERVÉS — seule la puissance
// personnelle (essence, emplacements, améliorations) repart à zéro, pas le
// lieu ni les personnages déjà recrutés. Passe par withSettle (comme toutes
// les autres actions) pour que la production en attente soit soldée AVANT le
// reset : sinon elle disparaissait sans même compter dans l'XP du Dojo.
router.post('/prestige', requireAuth, requireAdmin, rateLimit({ max: 5, name: 'idle-prestige' }), async (req, res) => {
  try {
    await withSettle(req.user.id, async (tx, user) => {
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

// decorArtCache exposé UNIQUEMENT pour les tests (`.clear()` entre les cas —
// sinon le cache mémoire fait fuiter l'état d'un test à l'autre).
module.exports = { router, decorArtCache };

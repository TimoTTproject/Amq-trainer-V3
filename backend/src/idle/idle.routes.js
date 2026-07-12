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
  charLevelBulkCost,
  RARITY_RATE,
  RARITY_LEVEL_BONUS,
  RARITY_PASSIVE,
  HERO_MILESTONES,
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
  wisdomForPrestige,
  ANCIENTS,
  ancientByKey,
  ancientCost,
  ancientBonus,
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

function idlePeriods(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return { day, week: d.toISOString().slice(0, 10) };
}

function idleMissionList(user, recruitCount, activeCount, stage) {
  const p = idlePeriods();
  return [
    { key: 'daily_stage', period: p.day, cadence: 'Quotidienne', title: 'Atteindre la vague 10', progress: Math.min(stage, 10), target: 10, reward: 250 },
    { key: 'daily_team', period: p.day, cadence: 'Quotidienne', title: 'Former une équipe de 3 héros', progress: Math.min(activeCount, 3), target: 3, reward: 400 },
    { key: 'weekly_roster', period: p.week, cadence: 'Hebdomadaire', title: 'Posséder 8 recrues', progress: Math.min(recruitCount, 8), target: 8, reward: 2500 },
    { key: 'weekly_master', period: p.week, cadence: 'Hebdomadaire', title: 'Atteindre le niveau 25 du Dojo', progress: Math.min(dojoLevelForXp(user.essenceEarnedTotal), 25), target: 25, reward: 5000 },
  ];
}

function bossMechanicForStage(stage) {
  const wave = ((stage - 1) % 10) + 1; if (wave !== 10) return null;
  const zone = Math.floor((stage - 1) / 10) + 1;
  return [
    { key: 'shield', name: 'Bouclier', description: 'Frappes normales réduites de 40%.', clickMultiplier: .6 },
    { key: 'rage', name: 'Rage', description: 'Dégâts actifs réduits de 25%.', clickMultiplier: .75 },
    { key: 'regen', name: 'Régénération', description: 'Dégâts actifs réduits de 20%.', clickMultiplier: .8 },
    { key: 'counter', name: 'Contre', description: 'Frappes normales réduites de 50%.', clickMultiplier: .5 },
  ][(zone - 1) % 4];
}

function idleAchievementDefs({ stage, recruits, teamLevels, worlds, prestige }) {
  return [
    { key: 'boss_hunter', title: 'Chasseur de boss', description: 'Atteindre la vague 25', icon: 'fa-skull', progress: Math.min(stage, 25), target: 25, reward: 1000 },
    { key: 'recruiter', title: 'Maître recruteur', description: 'Posséder 10 recrues', icon: 'fa-users', progress: Math.min(recruits, 10), target: 10, reward: 1500 },
    { key: 'trainer', title: 'Entraînement sans fin', description: 'Cumuler 250 niveaux actifs', icon: 'fa-dumbbell', progress: Math.min(teamLevels, 250), target: 250, reward: 3000 },
    { key: 'explorer', title: 'Voyageur des mondes', description: 'Découvrir 5 mondes', icon: 'fa-map', progress: Math.min(worlds, 5), target: 5, reward: 5000 },
    { key: 'sage', title: 'Premier éveil', description: 'Effectuer un Prestige', icon: 'fa-brain', progress: Math.min(prestige, 1), target: 1, reward: 7500 },
  ];
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
// Personnage mythique déterministe pour un palier de décor donné — même
// gardien pour tout le monde à ce palier, pas de tirage aléatoire à chaque
// requête. Réutilisé par fetchDecorArt (lecture, cache 30 min) ET la route
// admin de génération de portraits IA plus bas : une seule source de vérité
// pour « qui est le gardien d'un palier ».
async function pickBossForTheme(theme) {
  const tierIndex = Math.max(0, DOJO_DECOR.findIndex((t) => t.theme === theme));
  const mythics = await prisma.character.findMany({
    where: { rarity: 'mythic' },
    select: { id: true, name: true, imageUrl: true, seriesId: true, series: true },
    orderBy: { id: 'asc' },
  });
  if (!mythics.length) return null;
  // Essaie quelques candidats à partir du palier (déterministe) si le premier
  // choix n'a pas de portrait exploitable.
  for (let offset = 0; offset < Math.min(mythics.length, 6); offset++) {
    const boss = mythics[(tierIndex + offset) % mythics.length];
    if (boss.imageUrl) return boss;
  }
  return null;
}

async function fetchDecorArt(theme) {
  const boss = await pickBossForTheme(theme);
  if (!boss) return null;
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
  // Portrait IA généré une fois pour toutes via la route admin (jamais à la
  // demande d'un joueur) — absent = repli silencieux sur le portrait AniList
  // existant (boss.imageUrl), comportement inchangé si rien n'a été généré.
  const generated = await prisma.dojoBossArt.findUnique({
    where: { characterId_theme: { characterId: boss.id, theme } },
    select: { imageUrl: true },
  });
  return {
    characterId: boss.id, name: boss.name, imageUrl: boss.imageUrl, backgroundUrl,
    generatedImageUrl: generated?.imageUrl || null,
  };
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
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } }, equipments: true },
  });
}

const HERO_CLASSES = {
  warrior: { name: 'Guerrier', icon: 'fa-shield-halved', description: '+50% puissance de frappe', click: 1.5, prod: 1, burst: 1, team: 1 },
  mage: { name: 'Mage', icon: 'fa-hat-wizard', description: '+75% puissance de l’Ultime', click: 1, prod: 1, burst: 1.75, team: 1 },
  ninja: { name: 'Ninja', icon: 'fa-user-ninja', description: '+50% puissance du Combo', click: 1, prod: 1, burst: 1, team: 1.5 },
  swordsman: { name: 'Épéiste', icon: 'fa-khanda', description: '+25% frappe et +10% production', click: 1.25, prod: 1.1, burst: 1, team: 1 },
  summoner: { name: 'Invocateur', icon: 'fa-dragon', description: '+20% production de l’équipe', click: 1, prod: 1.2, burst: 1, team: 1 },
};
function heroClass(key) { return HERO_CLASSES[key] || HERO_CLASSES.warrior; }
const HERO_STYLES = {
  auras: [{ key:'none',name:'Sans aura',level:1 },{key:'flame',name:'Flammes',level:10},{key:'lightning',name:'Éclairs',level:25},{key:'void',name:'Énergie obscure',level:50},{key:'divine',name:'Aura divine',level:100}],
  stances: [{key:'balanced',name:'Équilibrée',level:1},{key:'power',name:'Puissance',level:20},{key:'speed',name:'Vitesse',level:40},{key:'master',name:'Maître',level:75}],
  titles: [{key:'rookie',name:'Novice du Dojo',level:1},{key:'guardian',name:'Gardien des mondes',level:25},{key:'legend',name:'Légende du multivers',level:60},{key:'transcendent',name:'Transcendant',level:100}],
};
function unlockedStyles(level, selected) { return Object.fromEntries(Object.entries(HERO_STYLES).map(([type,items]) => [type, items.map((x)=>({...x,unlocked:level>=x.level,selected:selected[type]===x.key}))])); }
function currentIdleEvent(now = new Date()) {
  const events = [
    { key: 'training', name: 'Entraînement intensif', icon: 'fa-dumbbell', description: '+25% production d’équipe', prod: 1.25, click: 1 },
    { key: 'fury', name: 'Fureur du héros', icon: 'fa-fire-flame-curved', description: '+50% puissance de frappe', prod: 1, click: 1.5 },
    { key: 'alliance', name: 'Alliance des univers', icon: 'fa-people-group', description: '+15% production et +20% frappe', prod: 1.15, click: 1.2 },
    { key: 'meditation', name: 'Méditation sacrée', icon: 'fa-om', description: '+35% production d’équipe', prod: 1.35, click: 1 },
  ];
  const day = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86400000);
  const event = events[((day % events.length) + events.length) % events.length];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { ...event, endsAt: end.toISOString() };
}

function computeTotalRate(slots, prodLevel, dojoLevel, prodAncientBonus, classKey) {
  const seriesLevels = new Map();
  for (const s of slots) if (s.character?.series) seriesLevels.set(s.character.series, (seriesLevels.get(s.character.series) || 0) + (s.level || 1));
  const masteryBonus = (series) => { const n = seriesLevels.get(series) || 0; return n >= 500 ? .25 : n >= 250 ? .15 : n >= 100 ? .10 : n >= 25 ? .05 : 0; };
  const base = slots.reduce(
    (sum, s) => (s.characterId && s.character ? sum + slotRate(s.character.rarity, s.level) * Math.pow(2, s.ascension || 0) * (1 + (s.equipments || []).reduce((v, e) => v + e.bonus, 0)) * (1 + masteryBonus(s.character.series)) : sum),
    0
  );
  const teamPassive = slots.reduce((mult, s) => {
    if (!s.character || (s.level || 1) < 10) return mult;
    return mult + ({ epic: .03, legendary: .08, mythic: .15 }[s.character.rarity] || 0);
  }, 1);
  return base * teamPassive * heroClass(classKey).prod * currentIdleEvent().prod * prodMultiplier(prodLevel, prodAncientBonus) * dojoLevelMultiplier(dojoLevel) * synergyForSlots(slots).multiplier;
}

function roleForCharacter(character) {
  return ['attaquant', 'support', 'tank', 'assassin', 'producteur'][Math.abs(Number(character?.id) || 0) % 5];
}

function synergyForSlots(slots) {
  const active = slots.filter((s) => s.characterId && s.character);
  const counts = new Map();
  for (const s of active) if (s.character.series) counts.set(s.character.series, (counts.get(s.character.series) || 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best?.[1] >= 3) return { key: 'license', name: `Alliance ${best[0]}`, bonus: .25, multiplier: 1.25 };
  if (best?.[1] === 2) return { key: 'license', name: `Duo ${best[0]}`, bonus: .10, multiplier: 1.10 };
  if (active.length >= 3) return { key: 'crossover', name: 'Crossover', bonus: .05, multiplier: 1.05 };
  return { key: 'none', name: 'Aucune synergie', bonus: 0, multiplier: 1 };
}

// Niveaux d'Ancients du joueur (Map clé→niveau, absent = pas encore acheté).
async function loadAncientLevels(client, userId) {
  const rows = await client.ancientLevel.findMany({ where: { userId }, select: { ancientKey: true, level: true } });
  return new Map(rows.map((r) => [r.ancientKey, r.level]));
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
    const ancientLevelsByKey = await loadAncientLevels(tx, userId);
    const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
    const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, ancientBonus(ancientLevelsByKey, 'prodMult'), user.idleHeroClass);
    const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
    const collected = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate, undefined, offlineCapMs));
    const settledUser = await tx.user.update({
      where: { id: userId },
      data: { essence: { increment: collected }, essenceEarnedTotal: { increment: collected }, idleLastCollectAt: new Date() },
    });
    // `ancientLevelsByKey` passé au mutateur : certaines routes (recrutement)
    // ont besoin d'autres bonus d'Ancients (chance, remise) que celui déjà
    // appliqué ci-dessus à la production.
    if (mutate) await mutate(tx, settledUser, ancientLevelsByKey);
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
      essenceEarnedTotal: true, idleMilestoneClaimed: true, prestigeLevel: true, wisdomPoints: true,
      idleBossClaimed: true,
      idleHeroClass: true,
      idleHeroAura: true, idleHeroStance: true, idleHeroTitle: true,
    },
  });
  if (!user) return null;
  const [slots, recruitCount, ancientLevelsByKey] = await Promise.all([
    loadSlots(prisma, userId),
    prisma.dojoRecruit.count({ where: { userId } }),
    loadAncientLevels(prisma, userId),
  ]);
  let recruits = [];
  try { recruits = await prisma.dojoRecruit.findMany({ where: { userId }, include: { character: { select: { series: true, rarity: true } } } }); } catch (e) { if (e?.code) throw e; }
  const prodAncientBonus = ancientBonus(ancientLevelsByKey, 'prodMult');
  const clickAncientBonus = ancientBonus(ancientLevelsByKey, 'clickMult');
  const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
  const recruitDiscountBonus = ancientBonus(ancientLevelsByKey, 'recruitDiscount');
  const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
  const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, prodAncientBonus, user.idleHeroClass);
  const strategy = synergyForSlots(slots);
  const pending = Math.floor(pendingEssence(user.idleLastCollectAt, totalRate, undefined, offlineCapMs));

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
        series: row.character.series,
        level,
        rate: slotRate(row.character.rarity, level) * Math.pow(2, row.ascension || 0),
        levelUpCost: charLevelUpCost(row.character.rarity, level),
        levelCosts: Object.fromEntries([1, 5, 10, 100].map((n) => [n, charLevelBulkCost(row.character.rarity, level, n)])),
        baseRate: RARITY_RATE[row.character.rarity] || 0,
        scaling: RARITY_LEVEL_BONUS[row.character.rarity] || 0,
        passive: RARITY_PASSIVE[row.character.rarity] || '',
        passiveUnlocked: level >= 10,
        milestones: HERO_MILESTONES.map((target) => ({ target, reached: level >= target })),
        nextMilestone: HERO_MILESTONES.find((target) => target > level) || null,
        ascension: row.ascension || 0,
        ascensionMultiplier: Math.pow(2, row.ascension || 0),
        canAscend: level >= 500 && (row.ascension || 0) < 5,
        ascensionCost: Math.round(({ rare: 25000, epic: 60000, legendary: 150000, mythic: 400000 }[row.character.rarity] || 25000) * Math.pow(3, row.ascension || 0)),
        equipments: ['weapon', 'relic', 'accessory'].map((kind) => (row.equipments || []).find((e) => e.kind === kind) || { kind, empty: true }),
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
  const defeatedBosses = Math.floor(Math.max(0, stage - 1) / 10);
  const nextBossChest = user.idleBossClaimed + 1;
  const bossReward = (tier) => Math.round(150 * Math.pow(1.45, Math.max(0, tier - 1)));

  const missionDefs = idleMissionList(user, recruitCount, slots.filter((s) => s.characterId).length, stage);
  let claims = [];
  try { claims = await prisma.idleMissionClaim.findMany({ where: { userId, OR: missionDefs.map((m) => ({ missionKey: m.key, period: m.period })) }, select: { missionKey: true, period: true } }); } catch (e) {
    // Compatibilité pendant le court instant où l'application redémarre avant
    // que la migration ne soit appliquée, ainsi qu'avec les doubles de tests.
    if (e?.code && e.code !== 'P2021') throw e;
  }
  const claimed = new Set(claims.map((c) => `${c.missionKey}:${c.period}`));
  const missions = missionDefs.map((m) => ({ ...m, completed: m.progress >= m.target, claimed: claimed.has(`${m.key}:${m.period}`) }));
  const masteryMap = new Map();
  for (const r of recruits) if (r.character?.series) { const x = masteryMap.get(r.character.series) || { series: r.character.series, recruits: 0, levels: 0 }; x.recruits++; masteryMap.set(r.character.series, x); }
  for (const s of slots) if (s.character?.series) { const x = masteryMap.get(s.character.series) || { series: s.character.series, recruits: 0, levels: 0 }; x.levels += s.level || 1; masteryMap.set(s.character.series, x); }
  const masteries = [...masteryMap.values()].map((m) => { const bonus = m.levels >= 500 ? .25 : m.levels >= 250 ? .15 : m.levels >= 100 ? .10 : m.levels >= 25 ? .05 : 0; const next = [25,100,250,500].find((n) => n > m.levels) || null; return { ...m, bonus, next }; }).sort((a,b) => b.levels-a.levels);
  const periods = idlePeriods(); const weeklyLevels = slots.reduce((n, s) => n + (s.character ? (s.level || 1) : 0), 0);
  let weeklyClaimed = false; try { weeklyClaimed = !!(await prisma.idleMissionClaim.findUnique({ where: { userId_missionKey_period: { userId, missionKey: 'weekly_convergence', period: periods.week } } })); } catch (e) { if (e?.code) throw e; }
  const achievementDefs = idleAchievementDefs({ stage, recruits: recruitCount, teamLevels: weeklyLevels, worlds: DOJO_DECOR.filter((w) => dojoLevel >= w.level).length, prestige: user.prestigeLevel });
  let achievementClaims = []; try { achievementClaims = await prisma.idleMissionClaim.findMany({ where: { userId, period: 'lifetime', missionKey: { in: achievementDefs.map((a) => `achievement_${a.key}`) } }, select: { missionKey: true } }); } catch (e) { if (e?.code) throw e; }
  const claimedAchievements = new Set(achievementClaims.map((c) => c.missionKey));
  const achievements = achievementDefs.map((a) => ({ ...a, completed: a.progress >= a.target, claimed: claimedAchievements.has(`achievement_${a.key}`) }));
  return {
    essence: user.essence,
    pendingEssence: pending,
    totalRate,
    heroClass: { key: user.idleHeroClass, ...heroClass(user.idleHeroClass), choices: Object.entries(HERO_CLASSES).map(([key, value]) => ({ key, ...value })) },
    heroStyle: { aura:user.idleHeroAura, stance:user.idleHeroStance, title:user.idleHeroTitle, choices:unlockedStyles(dojoLevel,{auras:user.idleHeroAura,stances:user.idleHeroStance,titles:user.idleHeroTitle}) },
    strategy: { ...strategy, roles: slots.filter((s) => s.character).map((s) => roleForCharacter(s.character)) },
    lastCollectAt: user.idleLastCollectAt,
    offlineCapMs,
    slots: slotsOut,
    slotsUnlocked: user.idleSlotsUnlocked,
    maxSlots: MAX_SLOTS,
    startSlots: START_SLOTS,
    recruit: { count: recruitCount, nextCost: recruitCost(recruitCount, recruitDiscountBonus) },
    battle: {
      stage,
      kills: Math.max(0, stage - 1), // les stages commencent à 1 — affichage façon "X ennemis vaincus"
      xpIntoStage,
      xpForNextStage,
      progress: xpForNextStage > 0 ? Math.min(1, xpIntoStage / xpForNextStage) : 1,
      bossChest: { defeated: defeatedBosses, claimed: user.idleBossClaimed, available: defeatedBosses >= nextBossChest, tier: nextBossChest, reward: bossReward(nextBossChest) },
      mechanic: bossMechanicForStage(stage),
    },
    missions,
    codex: { discovered: recruitCount, masteries, worlds: DOJO_DECOR.map((w) => ({ name: w.name, level: w.level, discovered: dojoLevel >= w.level })) },
    event: { ...currentIdleEvent(), weekly: { title: 'Convergence', description: 'Cumule 100 niveaux dans ton équipe active', progress: Math.min(weeklyLevels, 100), target: 100, reward: 3000, completed: weeklyLevels >= 100, claimed: weeklyClaimed } },
    achievements,
    prod: {
      level: user.idleProdLevel,
      multiplier: prodMultiplier(user.idleProdLevel, prodAncientBonus),
      nextCost: user.idleProdLevel < PROD_LEVEL_MAX ? prodUpgradeCost(user.idleProdLevel) : null,
      maxed: user.idleProdLevel >= PROD_LEVEL_MAX,
    },
    click: {
      level: user.idleClickLevel,
      yield: clickYield(user.idleClickLevel, clickAncientBonus),
      nextCost: user.idleClickLevel < CLICK_LEVEL_MAX ? clickUpgradeCost(user.idleClickLevel) : null,
      maxed: user.idleClickLevel >= CLICK_LEVEL_MAX,
    },
    ancients: {
      points: user.wisdomPoints,
      items: ANCIENTS.map((a) => {
        const level = ancientLevelsByKey.get(a.key) || 0;
        return { key: a.key, name: a.name, icon: a.icon, kind: a.kind, level, effectPerLevel: a.effectPerLevel, cost: ancientCost(level) };
      }),
    },
    dojo: {
      level: dojoLevel,
      xpTotal: user.essenceEarnedTotal,
      xpIntoLevel,
      xpForNextLevel,
      progress: xpForNextLevel > 0 ? Math.min(1, xpIntoLevel / xpForNextLevel) : 1,
      multiplier: dojoLevelMultiplier(dojoLevel),
      decor: { ...decor, boss: decorArt ? { characterId: decorArt.characterId, name: decorArt.name, imageUrl: decorArt.imageUrl, generatedImageUrl: decorArt.generatedImageUrl } : null, backgroundUrl: decorArt?.backgroundUrl || null },
      nextDecor: nextDecor ? { ...nextDecor, levelsRemaining: nextDecor.level - dojoLevel } : null,
      // Liste statique (pas de requête DB) des paliers — sert la frise de
      // progression côté client (renderIdleRoadmap) sans dupliquer DOJO_DECOR
      // dans public/idle.js (qui se désynchroniserait si un palier change).
      tiers: DOJO_DECOR.map((t) => ({ level: t.level, name: t.name, theme: t.theme })),
      milestone: {
        tier: milestoneTier,
        claimed: user.idleMilestoneClaimed,
        available: milestoneTier > user.idleMilestoneClaimed,
        reward: milestoneTier > user.idleMilestoneClaimed ? milestoneReward(milestoneTier) : null,
      },
      // Le multiplicateur plat automatique a disparu : la Sagesse gagnée au
      // Prestige (cf. bloc `ancients` ci-dessus, `points`) se dépense
      // maintenant volontairement dans les Ancients.
      prestige: {
        level: user.prestigeLevel,
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

router.post('/collect', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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
router.post('/recruit', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  let result;
  try {
    await withSettle(req.user.id, async (tx, user, ancientLevelsByKey) => {
      const count = await tx.dojoRecruit.count({ where: { userId: user.id } });
      const cost = recruitCost(count, ancientBonus(ancientLevelsByKey, 'recruitDiscount'));
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      const already = (await tx.dojoRecruit.findMany({ where: { userId: user.id }, select: { characterId: true } })).map((r) => r.characterId);
      const rolled = rollRecruitRarity(ancientBonus(ancientLevelsByKey, 'recruitLuck'));
      let pool = await tx.character.findMany({ where: { rarity: rolled, id: { notIn: already } }, select: { id: true, name: true, imageUrl: true, rarity: true, series: true } });
      if (!pool.length) {
        for (const r of ['rare', 'epic', 'legendary', 'mythic']) {
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

router.post('/assign', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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

router.post('/unassign', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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

router.post('/upgrade', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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
router.post('/slot-level', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  const amount = Number(req.body?.amount || 1);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return res.status(400).json({ error: 'Emplacement invalide' });
  }
  if (![1, 5, 10, 100].includes(amount)) return res.status(400).json({ error: 'Quantité invalide' });
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const slot = await tx.idleSlot.findUnique({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        include: { character: { select: { rarity: true } } },
      });
      if (!slot || !slot.characterId || !slot.character) throw new IdleError(400, 'Cet emplacement est vide');
      const cost = charLevelBulkCost(slot.character.rarity, slot.level || 1, amount);
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { level: { increment: amount } } });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

router.post('/slot-ascend', requireAuth, requireAdmin, rateLimit({ max: 20, name: 'idle-ascend' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) return res.status(400).json({ error: 'Emplacement invalide' });
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const slot = await tx.idleSlot.findUnique({ where: { userId_slotIndex: { userId: user.id, slotIndex } }, include: { character: { select: { rarity: true } } } });
      if (!slot?.character) throw new IdleError(400, 'Emplacement vide');
      if ((slot.level || 1) < 500) throw new IdleError(400, 'Niveau 500 requis');
      if ((slot.ascension || 0) >= 5) throw new IdleError(400, 'Ascension maximale atteinte');
      const cost = Math.round(({ rare: 25000, epic: 60000, legendary: 150000, mythic: 400000 }[slot.character.rarity] || 25000) * Math.pow(3, slot.ascension || 0));
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { level: 1, ascension: { increment: 1 } } });
    });
    res.json(await buildState(req.user.id));
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// Réclame le coffre du jalon en cours (tous les MILESTONE_INTERVAL niveaux de
// Dojo). Permanent : n'est jamais remis à zéro, y compris après une Prestige.
router.post('/claim-milestone', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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

// Prestige (« Retraite du Maître ») : reset la RUN contre de la Sagesse
// (voir wisdomForPrestige), dépensée ensuite dans les Ancients — plus de
// multiplicateur automatique. Le niveau du Dojo (essenceEarnedTotal), le
// roster recruté, les jalons réclamés ET les Ancients déjà achetés sont
// volontairement CONSERVÉS — seule la puissance personnelle (essence,
// emplacements, améliorations) repart à zéro, pas le lieu ni les personnages
// déjà recrutés. Passe par withSettle (comme toutes les autres actions) pour
// que la production en attente soit soldée AVANT le reset : sinon elle
// disparaissait sans même compter dans l'XP du Dojo.
router.post('/prestige', requireAuth, requireAdmin, rateLimit({ max: 5, name: 'idle-prestige' }), async (req, res) => {
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal);
      if (dojoLevel < PRESTIGE_MIN_DOJO_LEVEL) {
        throw new IdleError(400, `L'Idle doit atteindre le niveau ${PRESTIGE_MIN_DOJO_LEVEL} avant de prestiger`);
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
          wisdomPoints: { increment: wisdomForPrestige(dojoLevel) },
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
  const ancientLevelsByKey = await loadAncientLevels(prisma, req.user.id);
  const liveUser = await prisma.user.findUnique({ where: { id: req.user.id }, select: { idleClickLevel: true, essenceEarnedTotal: true, idleHeroClass: true } });
  const mechanic = bossMechanicForStage(stageForXp(liveUser.essenceEarnedTotal));
  const raw = clickYield(liveUser.idleClickLevel || 0, ancientBonus(ancientLevelsByKey, 'clickMult')) * heroClass(liveUser.idleHeroClass).click * currentIdleEvent().click;
  const gained = Math.max(1, Math.round(raw * (mechanic?.clickMultiplier || 1)));
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: { essence: { increment: gained }, essenceEarnedTotal: { increment: gained } },
    select: { essence: true },
  });
  res.json({ essence: user.essence, gained, mechanic: mechanic?.key || null });
});

router.post('/skill/burst', requireAuth, requireAdmin, rateLimit({ windowMs: 30000, max: 1, name: 'idle-skill-burst' }), async (req, res) => {
  const levels = await loadAncientLevels(prisma, req.user.id);
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { idleClickLevel: true, idleHeroClass: true } });
  const gained = Math.round(clickYield(user.idleClickLevel || 0, ancientBonus(levels, 'clickMult')) * 25 * heroClass(user.idleHeroClass).burst);
  await prisma.user.update({ where: { id: req.user.id }, data: { essence: { increment: gained }, essenceEarnedTotal: { increment: gained } } });
  res.json({ ok: true, gained, cooldownMs: 30000 });
});

router.post('/skill/team', requireAuth, requireAdmin, rateLimit({ windowMs: 60000, max: 1, name: 'idle-skill-team' }), async (req, res) => {
  const [user, slots, levels] = await Promise.all([prisma.user.findUnique({ where: { id: req.user.id } }), loadSlots(prisma, req.user.id), loadAncientLevels(prisma, req.user.id)]);
  const roles = slots.filter((s) => s.character).map((s) => roleForCharacter(s.character));
  if (roles.length < 2) return res.status(400).json({ error: 'Équipe insuffisante' });
  const rate = computeTotalRate(slots, user.idleProdLevel, dojoLevelForXp(user.essenceEarnedTotal), ancientBonus(levels, 'prodMult'), user.idleHeroClass);
  const uniqueRoles = new Set(roles).size;
  const gained = Math.max(1, Math.floor(rate * (20 + uniqueRoles * 5) * heroClass(user.idleHeroClass).team));
  await prisma.user.update({ where: { id: req.user.id }, data: { essence: { increment: gained }, essenceEarnedTotal: { increment: gained } } });
  res.json({ ok: true, gained, cooldownMs: 60000, uniqueRoles });
});

router.post('/hero-class', requireAuth, requireAdmin, rateLimit({ max: 20, name: 'idle-hero-class' }), async (req, res) => {
  const key = String(req.body?.key || '');
  if (!HERO_CLASSES[key]) return res.status(400).json({ error: 'Classe inconnue' });
  await withSettle(req.user.id, async (tx, user) => { await tx.user.update({ where: { id: user.id }, data: { idleHeroClass: key } }); });
  res.json(await buildState(req.user.id));
});

router.post('/hero-style', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-hero-style' }), async (req, res) => {
  const type = String(req.body?.type || ''); const key = String(req.body?.key || '');
  const field = { auras:'idleHeroAura', stances:'idleHeroStance', titles:'idleHeroTitle' }[type];
  const item = HERO_STYLES[type]?.find((x)=>x.key===key);
  if (!field || !item) return res.status(400).json({ error:'Personnalisation inconnue' });
  const user = await prisma.user.findUnique({ where:{id:req.user.id},select:{essenceEarnedTotal:true} });
  if (dojoLevelForXp(user.essenceEarnedTotal) < item.level) return res.status(403).json({ error:`Débloqué au niveau ${item.level}` });
  await prisma.user.update({ where:{id:req.user.id},data:{[field]:key} });
  res.json(await buildState(req.user.id));
});

router.post('/mission/claim', requireAuth, requireAdmin, rateLimit({ max: 30, name: 'idle-mission' }), async (req, res) => {
  const key = String(req.body?.key || '');
  try {
    const reward = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const [recruits, slots] = await Promise.all([tx.dojoRecruit.count({ where: { userId: req.user.id } }), tx.idleSlot.count({ where: { userId: req.user.id, characterId: { not: null } } })]);
      const mission = idleMissionList(user, recruits, slots, stageForXp(user.essenceEarnedTotal)).find((m) => m.key === key);
      if (!mission) throw new IdleError(400, 'Mission inconnue');
      if (mission.progress < mission.target) throw new IdleError(400, 'Mission incomplète');
      await tx.idleMissionClaim.create({ data: { userId: req.user.id, missionKey: key, period: mission.period } });
      await tx.user.update({ where: { id: req.user.id }, data: { essence: { increment: mission.reward }, essenceEarnedTotal: { increment: mission.reward } } });
      return mission.reward;
    });
    res.json({ ok: true, reward });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Mission déjà réclamée' });
    throw e;
  }
});

router.post('/event/claim', requireAuth, requireAdmin, rateLimit({ max: 10, name: 'idle-event' }), async (req, res) => {
  const period = idlePeriods().week;
  try {
    await prisma.$transaction(async (tx) => {
      const slots = await tx.idleSlot.findMany({ where: { userId: req.user.id, characterId: { not: null } }, select: { level: true } });
      if (slots.reduce((n, s) => n + (s.level || 1), 0) < 100) throw new IdleError(400, 'Défi hebdomadaire incomplet');
      await tx.idleMissionClaim.create({ data: { userId: req.user.id, missionKey: 'weekly_convergence', period } });
      await tx.user.update({ where: { id: req.user.id }, data: { essence: { increment: 3000 }, essenceEarnedTotal: { increment: 3000 } } });
    });
    res.json({ ok: true, reward: 3000 });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Récompense déjà réclamée' });
    throw e;
  }
});

router.post('/achievement/claim', requireAuth, requireAdmin, rateLimit({ max: 20, name: 'idle-achievement' }), async (req, res) => {
  const key = String(req.body?.key || '');
  try {
    const reward = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const [recruits, slots] = await Promise.all([tx.dojoRecruit.count({ where: { userId: user.id } }), tx.idleSlot.findMany({ where: { userId: user.id, characterId: { not: null } }, select: { level: true } })]);
      const dojoLevel = dojoLevelForXp(user.essenceEarnedTotal); const stage = stageForXp(user.essenceEarnedTotal);
      const defs = idleAchievementDefs({ stage, recruits, teamLevels: slots.reduce((n,s)=>n+(s.level||1),0), worlds: DOJO_DECOR.filter((w)=>dojoLevel>=w.level).length, prestige: user.prestigeLevel });
      const achievement = defs.find((a) => a.key === key);
      if (!achievement) throw new IdleError(400, 'Succès inconnu');
      if (achievement.progress < achievement.target) throw new IdleError(400, 'Succès incomplet');
      await tx.idleMissionClaim.create({ data: { userId: user.id, missionKey: `achievement_${key}`, period: 'lifetime' } });
      await tx.user.update({ where: { id: user.id }, data: { essence: { increment: achievement.reward }, essenceEarnedTotal: { increment: achievement.reward } } });
      return achievement.reward;
    });
    res.json({ ok: true, reward });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Succès déjà réclamé' });
    throw e;
  }
});

router.post('/boss-chest', requireAuth, requireAdmin, rateLimit({ max: 20, name: 'idle-boss-chest' }), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const defeated = Math.floor(Math.max(0, stageForXp(user.essenceEarnedTotal) - 1) / 10);
      const tier = user.idleBossClaimed + 1;
      if (defeated < tier) throw new IdleError(400, 'Aucun coffre de boss disponible');
      const amount = Math.round(150 * Math.pow(1.45, Math.max(0, tier - 1)));
      const updated = await tx.user.updateMany({ where: { id: user.id, idleBossClaimed: user.idleBossClaimed }, data: { idleBossClaimed: { increment: 1 }, essence: { increment: amount }, essenceEarnedTotal: { increment: amount } } });
      if (!updated.count) throw new IdleError(409, 'Coffre déjà réclamé');
      const slot = await tx.idleSlot.findFirst({ where: { userId: user.id, characterId: { not: null } }, orderBy: { slotIndex: 'asc' } });
      let loot = null;
      if (slot) {
        const kinds = ['weapon', 'relic', 'accessory']; const kind = kinds[(tier - 1) % kinds.length];
        const rarity = tier % 10 === 0 ? 'mythic' : tier % 5 === 0 ? 'legendary' : tier % 3 === 0 ? 'epic' : 'rare';
        const base = { rare: .03, epic: .06, legendary: .10, mythic: .16 }[rarity];
        const bonus = Number((base + Math.min(.25, tier * .002)).toFixed(3));
        const current = await tx.idleEquipment.findUnique({ where: { idleSlotId_kind: { idleSlotId: slot.id, kind } } });
        if (!current || bonus > current.bonus) {
          await tx.idleEquipment.upsert({ where: { idleSlotId_kind: { idleSlotId: slot.id, kind } }, create: { idleSlotId: slot.id, kind, rarity, bonus }, update: { rarity, bonus, obtainedAt: new Date() } });
          loot = { kind, rarity, bonus, equipped: true, slotIndex: slot.slotIndex };
        } else loot = { kind, rarity, bonus, equipped: false, slotIndex: slot.slotIndex };
      }
      return { reward: amount, loot };
    });
    res.json({ ok: true, ...result });
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// Achète (ou monte) un Ancient : débite ancientCost(level) en Sagesse
// (wisdomPoints — PAS l'essence, monnaie séparée), incrémente son niveau.
// Indépendant de withSettle : les Ancients ne dépendent ni de la production
// ni de l'essence, pas besoin de solder quoi que ce soit avant.
router.post('/ancient', requireAuth, requireAdmin, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  const key = String(req.body?.key || '');
  if (!ancientByKey(key)) return res.status(400).json({ error: 'Ancient invalide' });
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id }, select: { wisdomPoints: true } });
      if (!user) throw new IdleError(404, 'Compte introuvable');
      const existing = await tx.ancientLevel.findUnique({ where: { userId_ancientKey: { userId: req.user.id, ancientKey: key } } });
      const level = existing?.level || 0;
      const cost = ancientCost(level);
      if (user.wisdomPoints < cost) throw new IdleError(400, 'Sagesse insuffisante');
      await tx.user.update({ where: { id: req.user.id }, data: { wisdomPoints: { decrement: cost } } });
      await tx.ancientLevel.upsert({
        where: { userId_ancientKey: { userId: req.user.id, ancientKey: key } },
        update: { level: { increment: 1 } },
        create: { userId: req.user.id, ancientKey: key, level: 1 },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// decorArtCache exposé UNIQUEMENT pour les tests (`.clear()` entre les cas —
// sinon le cache mémoire fait fuiter l'état d'un test à l'autre).
module.exports = {
  router,
  decorArtCache,
  // Exportés pour la route admin de génération de portraits IA
  // (src/admin/admin.routes.js) — même sélection déterministe du gardien
  // que celle utilisée pour l'affichage, une seule source de vérité.
  pickBossForTheme,
};

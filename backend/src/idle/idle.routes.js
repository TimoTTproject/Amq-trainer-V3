// Routes du Dojo (idle/clicker) : état, récolte, recrutement, assignation
// d'emplacements, clic manuel, améliorations. Le roster reste séparé du gacha ;
// l'Essence sert d'alternative aux Sceaux à l'invocation.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin, requireIdleBeta } = require('../admin/admin');
const { rateLimit } = require('../util/ratelimit');
const store = require('../util/store');
const { publishGlobalChatSystem } = require('../mp/mp');
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
  CLICK_RATE_SHARE,
  critUpgradeBonus,
  critUpgradeCost,
  CRIT_LEVEL_MAX,
  multiStrikeBonus,
  multiStrikeUpgradeCost,
  MULTI_STRIKE_MAX,
  cooldownUpgradeBonus,
  cooldownUpgradeCost,
  COOLDOWN_LEVEL_MAX,
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  simulateCombat,
  MAX_STAGE_ADVANCE_PER_SYNC,
  enemyMaxHp,
  enemyUnitMaxHp,
  enemyArchetype,
  enemyReward,
  enemiesRequiredForStage,
  normalizeWaveProgress,
  enemyUnitReward,
  enemiesDefeatedBeforeStage,
  isBossStage,
  isEliteStage,
  campaignForStage,
  BOSS_TIMER_SECONDS,
  charLevelUpCost,
  charLevelBulkCost,
  RARITY_RATE,
  RARITY_LEVEL_BONUS,
  stableCharacterHash,
  characterPassiveBonus,
  characterPassiveDescription,
  RECRUIT_WEIGHTS,
  HERO_MILESTONES,
  HERO_ASCENSION_LEVEL,
  HERO_ASCENSION_MAX,
  heroAscensionRequiredLevel,
  heroAscensionMultiplier,
  heroAscensionCost,
  dojoLevelMultiplier,
  rankQuestSeries,
  decorForLevel,
  DOJO_DECOR,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  PRESTIGE_MIN_STAGE,
  prestigeRequiredStage,
  wisdomForRunStage,
  prestigeMinimumRunMs,
  ANCIENTS,
  ANCIENT_BRANCHES,
  ancientByKey,
  ancientCost,
  ancientBonus,
  rollRecruitRarity,
  recruitCost,
  recruitEssenceCost,
  achievementProdMultiplier,
  ACHIEVEMENT_PROD_BONUS,
  AWAKENED_CHANCE,
  AWAKENED_BONUS,
  AWAKEN_STAR_MAX,
  AWAKEN_STAR_BONUS,
  awakenStarCost,
  awakenStarMultiplier,
  SERIES_COMPLETION_BONUS,
  SERIES_COMPLETION_SEALS,
  completedSeriesMultiplier,
  prestigeStartingLevels,
  ORB_COOLDOWN_SECONDS,
  ORB_SEAL_CHANCE,
  ORB_JACKPOT_CHANCE,
  ORB_BUFF_CHANCE,
  ORB_BUFFS,
  rollOrbBuff,
  activeOrbBuff,
  orbReward,
  RUN_BLESSINGS,
  parseRunBlessings,
  runBlessingEffects,
  runBlessingChoices,
  runBlessingRerollCost,
} = require('./idle');

const router = express.Router();
const ROUTE_NUMBER_CAP = 1e300;

function safeIdleNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return number > 0 ? ROUTE_NUMBER_CAP : fallback;
  return Math.max(0, Math.min(ROUTE_NUMBER_CAP, number));
}

async function recordIdleEvent(userId,event,{value=null,stage=null}={}) {
  try { await prisma.idleTelemetry.create({data:{userId,event,value,stage}}); }
  catch { /* Télémétrie non bloquante, notamment pendant la migration. */ }
}

async function incrementIdleCounter(userId,key,amount=1,now=new Date()) {
  const periods=idlePeriods(now);
  const targets=[periods.day,periods.week,periods.month];
  const rankField={click:'idleRankClicks',kill:'idleRankKills',upgrade:'idleRankUpgrades',boss_chest:'idleRankBosses'}[key];
  const increment=Math.max(0,Math.floor(amount));
  try {
    await Promise.all([...targets.map((period)=>prisma.idleProgressCounter.upsert({
      where:{userId_key_period:{userId,key,period}},
      create:{userId,key,period,value:increment},
      update:{value:{increment}},
    })),...(rankField&&increment?[prisma.user.update({where:{id:userId},data:{[rankField]:{increment}}})]:[])]);
  } catch (e) {
    // Non bloquant (ne doit jamais faire échouer le kill/l'essence déjà
    // crédités ailleurs) — mais avaler l'erreur en silence rendait ce genre
    // d'échec partiel (pool de connexions, verrou transitoire) impossible à
    // distinguer d'un vrai « la quête n'a pas avancé » côté joueur.
    console.error(`incrementIdleCounter échoué (userId=${userId}, key=${key}):`, e?.message || e);
  }
}

async function loadIdleCounters(userId,now=new Date()) {
  const periods=idlePeriods(now);
  try {
    const rows=await prisma.idleProgressCounter.findMany({where:{userId,period:{in:[periods.day,periods.week,periods.month]}}});
    return new Map(rows.map((row)=>[`${row.key}:${row.period}`,row.value]));
  } catch { return new Map(); }
}

class IdleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SQUAD_PRESET_LIMIT = 5;
const SQUAD_SLOT_DEFS = [
  { index: 0, name: 'Composition Alpha', icon: 'fa-flag', unlock: { type: 'start', label: 'Disponible' }, purpose: 'Progression principale', bonus: 'Sauvegarde de team : aucun bonus caché, c’est ta compo de push.' },
  { index: 1, name: 'Composition Boss', icon: 'fa-skull', unlock: { type: 'prestige', value: 1, label: 'Prestige 1' }, purpose: 'Gardiens et boss communs', bonus: 'Sauvegarde conseillée pour Tank + Assassin + Attaquant.' },
  { index: 2, name: 'Composition Farm', icon: 'fa-recycle', unlock: { type: 'rank', value: 25, label: 'Rang 25' }, purpose: 'Farm et recyclage', bonus: 'Sauvegarde conseillée pour Producteur + Support.' },
  { index: 3, name: 'Composition Faille', icon: 'fa-dungeon', unlock: { type: 'rift', value: 1, label: 'Rang 20 ou stage 120' }, purpose: 'Défi hebdomadaire', bonus: 'Sauvegarde conseillée pour rôles variés et reliques.' },
  { index: 4, name: 'Composition Libre', icon: 'fa-stars', unlock: { type: 'prestige', value: 5, label: 'Prestige 5' }, purpose: 'Test de méta', bonus: 'Pour essayer des persos favoris sans casser la composition principale.' },
];
const AUTO_SKILLS_UNLOCK_LEVEL = 40;
const BATTLE_SPEED_UNLOCKS = { 1: 1, 2: 30, 4: 60 };

// Condition de déverrouillage PROPRE à ce slot (pas de dépendance à l'ordre
// des autres slots).
function isSquadSlotUnlocked(slot, user = {}) {
  const prestige = Math.max(0, Number(user.prestigeLevel) || 0);
  const rank = Math.max(1, Number(user.idleRankLevel) || 1);
  const bestStage = Math.max(1, Number(user.idleBestStage || user.idleRunBestStage || user.idleStage) || 1);
  if (slot.unlock.type === 'start') return true;
  if (slot.unlock.type === 'prestige') return prestige >= slot.unlock.value;
  if (slot.unlock.type === 'rank') return rank >= slot.unlock.value;
  if (slot.unlock.type === 'rift') return rank >= 20 || bestStage >= 120;
  return false;
}

function unlockedSquadPresetCount(user = {}) {
  return SQUAD_SLOT_DEFS.filter((slot) => isSquadSlotUnlocked(slot, user)).length;
}

function squadPresetSlots(user = {}, presets = []) {
  const byName = new Map(presets.map((preset) => [preset.name, preset]));
  // Chaque slot vérifie SA PROPRE condition, plutôt qu'un seuil `index <
  // unlocked` fondé sur un simple COMPTE de slots débloqués : ce comptage
  // supposait que les conditions étaient strictement croissantes dans l'ordre
  // des index (Alpha < Boss < Farm < Faille < Libre), ce qui n'est pas le cas
  // (Farm ne demande qu'un rang 25, atteignable bien avant le premier
  // Prestige qui débloque Boss). Un joueur pouvait donc voir Boss affiché
  // comme débloqué sans remplir sa condition, et Farm affiché comme verrouillé
  // alors qu'il la remplissait déjà — sauvegarder/charger échouait ou
  // réussissait sur le mauvais slot (retour joueur : « les slots d'équipe ne
  // sont pas fonctionnels »).
  return SQUAD_SLOT_DEFS.map((slot) => {
    const preset = byName.get(slot.name) || null;
    return { ...slot, unlocked: isSquadSlotUnlocked(slot, user), saved: !!preset, formation: preset?.formation || null, size: Array.isArray(preset?.slots) ? preset.slots.length : 0 };
  });
}

async function withIdleUserLock(userId, action, { attempts = 8, ttlMs = 30000 } = {}) {
  const key = `lock:idle:user:${userId}`;
  let token = null;
  for (let attempt = 0; attempt < attempts && !token; attempt++) {
    token = await store.acquireLock(key, ttlMs);
    if (!token && attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!token) throw new IdleError(409, 'Une autre action Idle est déjà en cours, réessaie.');
  try {
    return await action();
  } finally {
    try { await store.releaseLock(key, token); } catch { /* expiration du verrou : la mutation reste valide */ }
  }
}

async function idleUserLockMiddleware(req, res, next) {
  const key = `lock:idle:user:${req.user.id}`;
  let token = null;
  for (let attempt = 0; attempt < 8 && !token; attempt++) {
    token = await store.acquireLock(key, 30000);
    if (!token && attempt < 7) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!token) return res.status(409).json({ error:'Une autre action Idle est déjà en cours, réessaie.' });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void store.releaseLock(key, token).catch(()=>{});
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

function idlePeriods(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return { day, week: d.toISOString().slice(0, 10),month:`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}` };
}

function idleMissionList(user, recruitCount, activeCount, stage, counters=new Map()) {
  const p = idlePeriods();
  const value=(key,period)=>counters.get(`${key}:${period}`)||0;
  const dailyPool = [
    { key:'daily_clicks',counter:'click',title:'Discipline du poing',description:'Porter 150 frappes manuelles',target:150,reward:1 },
    { key:'daily_kills',counter:'kill',title:'Nettoyage de zone',description:'Vaincre 75 ennemis',target:75,reward:1 },
    { key:'daily_skills',counter:'skill',title:'Maîtrise des techniques',description:'Utiliser 5 compétences actives',target:5,reward:1 },
    { key:'daily_upgrades',counter:'upgrade',title:'Entretien du Dojo',description:'Acheter 5 améliorations',target:5,reward:1 },
  ];
  const dayIndex = Math.floor(Date.parse(`${p.day}T00:00:00Z`) / 86400000);
  const daily = [0,1,2].map((offset)=>dailyPool[(dayIndex+offset)%dailyPool.length]).map((m)=>({
    ...m,period:p.day,cadence:'Quotidienne',progress:Math.min(value(m.counter,p.day),m.target),rewardCurrency:'seals',
  }));
  const weekly = [
    { key:'weekly_kills',counter:'kill',title:'Campagne d’extermination',description:'Vaincre 1 000 ennemis cette semaine',target:1000,reward:4 },
    { key:'weekly_clicks',counter:'click',title:'Entraînement intensif',description:'Porter 750 frappes manuelles',target:750,reward:3 },
    { key:'weekly_skills',counter:'skill',title:'Arsenal complet',description:'Utiliser 30 compétences actives',target:30,reward:3 },
    { key:'weekly_upgrades',counter:'upgrade',title:'Expansion du Dojo',description:'Acheter 75 améliorations',target:75,reward:4 },
  ].map((m)=>({...m,period:p.week,cadence:'Hebdomadaire',progress:Math.min(value(m.counter,p.week),m.target),rewardCurrency:'seals'}));
  return [...daily,...weekly];
}

const SEASON_TIERS = [
  {tier:1,level:1000,reward:1,essence:0},{tier:2,level:2500,reward:2,essence:0},
  {tier:3,level:5000,reward:2,essence:25000},{tier:4,level:8000,reward:3,essence:0},
  {tier:5,level:12000,reward:3,essence:0},{tier:6,level:16000,reward:4,essence:75000},
  {tier:7,level:20000,reward:5,essence:0},{tier:8,level:24000,reward:7,essence:200000},
];

function seasonActivityScore(counters, period) {
  const value=(key)=>counters.get(`${key}:${period}`)||0;
  const breakdown=[
    {key:'click',label:'Frappes',value:Math.min(value('click'),3000),cap:3000,weight:1},
    {key:'kill',label:'Victoires',value:Math.min(value('kill'),5000),cap:5000,weight:1},
    {key:'skill',label:'Compétences',value:Math.min(value('skill'),300),cap:300,weight:15},
    {key:'upgrade',label:'Améliorations',value:Math.min(value('upgrade'),300),cap:300,weight:12},
    {key:'boss_chest',label:'Coffres',value:Math.min(value('boss_chest'),20),cap:20,weight:300},
    {key:'recruit',label:'Invocations',value:Math.min(value('recruit'),20),cap:20,weight:100},
  ];
  return { score:breakdown.reduce((sum,x)=>sum+x.value*x.weight,0),breakdown:breakdown.map((x)=>({...x,score:x.value*x.weight})) };
}

function challengeProgress(requirements) {
  const completed=requirements.every((r)=>r.progress>=r.target);
  const progress=Math.round(requirements.reduce((sum,r)=>sum+Math.min(1,r.progress/Math.max(1,r.target)),0)/requirements.length*100);
  return {progress,target:100,completed};
}

function idleChallengeList(counters, slots, periods=idlePeriods()) {
  const value=(key,period)=>counters.get(`${key}:${period}`)||0;
  const uniqueRoles=new Set(slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character))).size;
  const defs=[
    {key:'disciplined_assault',name:'Assaut discipliné',cadence:'Quotidien',difficulty:'Expert',description:'Combine activité manuelle et techniques.',period:periods.day,reward:3,icon:'fa-hand-fist',requirements:[{label:'Frappes',progress:value('click',periods.day),target:250},{label:'Compétences',progress:value('skill',periods.day),target:6}]},
    {key:'complete_squad',name:'Escouade complète',cadence:'Hebdomadaire',difficulty:'Tactique',description:'Construis une équipe variée qui tient sur la durée.',period:periods.week,reward:5,icon:'fa-people-group',requirements:[{label:'Rôles actifs',progress:uniqueRoles,target:3},{label:'Ennemis vaincus',progress:value('kill',periods.week),target:1000}]},
    {key:'guardian_hunt',name:'Chasse aux gardiens',cadence:'Hebdomadaire',difficulty:'Endurance',description:'Franchis trois nouveaux murs de boss.',period:periods.week,reward:6,icon:'fa-crown',requirements:[{label:'Gardiens vaincus',progress:value('boss_kill',periods.week),target:3}]},
  ];
  return defs.map((def)=>({...def,...challengeProgress(def.requirements)}));
}

function weeklyConvergence(counters, periods=idlePeriods()) {
  const value=(key)=>counters.get(`${key}:${periods.week}`)||0;
  const requirements=[
    {label:'Ennemis',progress:value('kill'),target:1500},
    {label:'Frappes',progress:value('click'),target:1000},
    {label:'Compétences',progress:value('skill'),target:40},
    {label:'Améliorations',progress:value('upgrade'),target:100},
  ];
  return {title:'Convergence suprême',description:'Accomplis les quatre objectifs avant la fin de la semaine.',requirements,...challengeProgress(requirements),reward:7,essence:100000,rewardCurrency:'seals'};
}

// Reliques de la Faille : choix roguelike offerts tous les 5 paliers franchis
// (voir POST /rift/attempt), actifs pour le reste de la semaine (reset
// naturel au changement de `period`, comme le record lui-même). De vrais
// choix risque/récompense plutôt qu'un pur pourcentage — certaines paires
// sont volontairement symétriques (miroir DPS/Essence) pour que le choix
// dépende du style de jeu, pas d'une réponse strictement dominante.
const RIFT_RELICS = {
  lame_aiguisee: { name: 'Lame Aiguisée', icon: 'fa-khanda', description: '+25% DPS en Faille, mais −10% d’Essence gagnée.', dpsMult: 1.25, rewardMult: .90 },
  coffre_beni: { name: 'Coffre Béni', icon: 'fa-sack-dollar', description: '+50% d’Essence gagnée, mais −10% DPS en Faille.', dpsMult: .90, rewardMult: 1.50 },
  rage_abyssale: { name: 'Rage Abyssale', icon: 'fa-fire', description: '+35% DPS en Faille, mais −20% d’Essence gagnée.', dpsMult: 1.35, rewardMult: .80 },
  fortune_ecarlate: { name: 'Fortune Écarlate', icon: 'fa-gem', description: '+35% d’Essence gagnée, mais −20% DPS en Faille.', dpsMult: .80, rewardMult: 1.35 },
  souffle_continu: { name: 'Souffle Continu', icon: 'fa-wind', description: '+15% DPS et +15% Essence en Faille — un choix sûr, sans contrepartie.', dpsMult: 1.15, rewardMult: 1.15 },
  focalisation: { name: 'Focalisation', icon: 'fa-crosshairs', description: '+15% DPS en Faille, sans contrepartie.', dpsMult: 1.15, rewardMult: 1 },
  instinct_econome: { name: 'Instinct d’Économe', icon: 'fa-piggy-bank', description: '+20% d’Essence gagnée en Faille, sans contrepartie.', dpsMult: 1, rewardMult: 1.20 },
  ombre_furtive: { name: 'Ombre Furtive', icon: 'fa-user-ninja', description: 'Les salles de la Faille résistent 8% de moins.', dpsMult: 1, rewardMult: 1, resistanceMult: .92 },
  echo_temporel: { name: 'Écho Temporel', icon: 'fa-clock-rotate-left', description: '+8% DPS en Faille par relique déjà choisie cette semaine (celle-ci comprise) — monte en puissance avec le build.', dpsMult: 1, rewardMult: 1 },
};
function riftRelicModifiers(relicKeys = []) {
  let dpsMult = 1, rewardMult = 1, resistanceMult = 1;
  for (const key of relicKeys) {
    const relic = RIFT_RELICS[key]; if (!relic) continue;
    dpsMult *= key === 'echo_temporel' ? (1 + .08 * Math.max(1, relicKeys.length)) : (relic.dpsMult ?? 1);
    rewardMult *= relic.rewardMult ?? 1;
    resistanceMult *= relic.resistanceMult ?? 1;
  }
  return { dpsMult, rewardMult, resistanceMult };
}
function rollRiftRelics(existingKeys = [], count = 3) {
  const available = Object.keys(RIFT_RELICS).filter((k) => !existingKeys.includes(k));
  const picked = [];
  for (let i = 0; i < count && available.length; i++) picked.push(available.splice(Math.floor(Math.random() * available.length), 1)[0]);
  return picked;
}
function riftRelicDetails(keys = []) {
  return keys.filter((k) => RIFT_RELICS[k]).map((k) => ({ key: k, name: RIFT_RELICS[k].name, icon: RIFT_RELICS[k].icon, description: RIFT_RELICS[k].description }));
}

function weeklyRift(counters,totalRate,bestStage,rankLevel,periods=idlePeriods(),relicKeys=[]) {
  const best=Math.max(0,counters.get(`rift_floor:${periods.week}`)||0);
  const variants=[
    {key:'iron',name:'Armure astrale',description:'Les ennemis possèdent 35% de PV supplémentaires.',multiplier:1.35},
    {key:'haste',name:'Course du temps',description:'Chaque salle doit tomber en 15 secondes.',multiplier:20/15},
    {key:'void',name:'Instabilité du Néant',description:'Toutes les salles sont 18% plus résistantes.',multiplier:1.18},
  ];
  const variant=variants[Math.abs(Math.floor(Date.parse(`${periods.week}T00:00:00Z`)/604800000))%variants.length];
  const mods=riftRelicModifiers(relicKeys);
  const effectiveRate=totalRate*mods.dpsMult;
  const baseHp=enemyMaxHp(Math.max(1,bestStage||1));
  const targetFor=(floor)=>Math.round(baseHp*Math.pow(1.48,Math.max(0,floor-1))*variant.multiplier*mods.resistanceMult);
  let projected=0;for(let floor=1;floor<=20;floor++){if(effectiveRate*20<targetFor(floor))break;projected=floor;}
  return {period:periods.week,unlocked:(rankLevel||1)>=20,unlockLevel:20,maxFloor:20,bestFloor:best,projectedFloor:projected,nextFloor:Math.min(20,best+1),nextTarget:targetFor(Math.min(20,best+1)),variant,relics:riftRelicDetails(relicKeys),reward:{essence:Math.max(0,Math.round((250*projected*projected-250*best*best)*mods.rewardMult)),seals:Math.max(0,Math.floor(projected/5)-Math.floor(best/5))}};
}

function bossChestRewards(tier) {
  // Le coffre reste visible dans l'économie du monde où il tombe. Son
  // plancher historique protège le début de partie ; ensuite il suit 75% du
  // butin du boss correspondant, sans créer un farm répétable.
  const reward=Math.max(
    Math.round(80*Math.pow(1.4,Math.max(0,tier-1))),
    Math.round(enemyReward(Math.max(1,tier)*10)*.75),
  );
  const sealReward=1+Math.min(3,Math.floor(tier/5));
  const bonusEssence=tier%5===0?Math.round(reward*.5):0;
  const lootRarity=tier%10===0?'mythic':tier%5===0?'legendary':tier%3===0?'epic':'rare';
  return {reward,sealReward,bonusEssence,lootRarity};
}

const IDLE_ITEM_CAPACITY=120;
const ITEM_KINDS={
  rune1:{label:'Objet 1',icon:'fa-diamond',effectKey:'assault',effectLabel:'Stat principale'},
  rune2:{label:'Objet 2',icon:'fa-diamond',effectKey:'precision',effectLabel:'Stat principale'},
  rune3:{label:'Objet 3',icon:'fa-diamond',effectKey:'resonance',effectLabel:'Stat principale'},
  rune4:{label:'Objet 4',icon:'fa-diamond',effectKey:'overdrive',effectLabel:'Stat principale'},
  rune5:{label:'Objet 5',icon:'fa-diamond',effectKey:'focus',effectLabel:'Stat principale'},
  rune6:{label:'Objet 6',icon:'fa-diamond',effectKey:'aura',effectLabel:'Stat principale'},
};
const RUNE_KINDS=Object.keys(ITEM_KINDS);
const ITEM_EFFECTS={
  assault:{label:'Assaut',mode:'dps',description:'Dégâts constants'},
  precision:{label:'Précision',mode:'click',description:'Augmente les frappes manuelles'},
  overdrive:{label:'Surcharge',mode:'burst',description:'Augmente les dégâts de l’Ultime'},
  resonance:{label:'Résonance',mode:'team',description:'Augmente les dégâts du Combo'},
  focus:{label:'Concentration',mode:'boss',description:'Augmente les dégâts contre les boss'},
  echo:{label:'Écho',mode:'dps',description:'Augmente la production continue'},
  salvage:{label:'Fortune',mode:'salvage',description:'Essence de recyclage'},
  aura:{label:'Aura',mode:'dps',description:'Présence amplifiée'},
  pact:{label:'Pacte',mode:'dps',description:'Lien de puissance'},
};
// Nombre d'affixes selon la rareté (façon ARPG : plus un objet est rare, plus
// il porte de lignes) — le premier tiré reste l'affixe primaire de l'objet
// (effectKey/effectValue, colonnes historiques), les suivants vont dans
// IdleItem.affixes. Retiré : la restriction par nature d'objet (ITEM_EFFECT_POOLS)
// — n'importe quel affixe peut tomber sur n'importe quel type d'objet, c'est ce
// qui rend le tirage excitant (une arme peut sortir « Fortune »).
const ITEM_AFFIX_COUNT_BY_RARITY={rare:1,epic:2,legendary:3,mythic:4};
const RUNE_SETS={
  energy:{name:'Énergie',required:2,mode:'dps',bonus:.06,multiplier:1.06,effectKey:'assault',description:'+6% de production personnelle'},
  blade:{name:'Lame',required:2,mode:'click',bonus:.12,multiplier:1.12,effectKey:'precision',description:'+12% de dégâts de clic'},
  rage:{name:'Rage',required:4,mode:'burst',bonus:.25,multiplier:1.25,effectKey:'overdrive',description:'+25% de dégâts d’Ultime'},
  unity:{name:'Union',required:4,mode:'team',bonus:.22,multiplier:1.22,effectKey:'resonance',description:'+22% de dégâts de Combo'},
  hunter:{name:'Chasseur',required:2,mode:'boss',bonus:.15,multiplier:1.15,effectKey:'focus',description:'+15% de dégâts contre les boss'},
  fortune:{name:'Fortune',required:2,mode:'salvage',bonus:.25,multiplier:1.25,effectKey:'salvage',description:'+25% d’Essence au recyclage'},
};
const RUNE_SET_KEYS=Object.keys(RUNE_SETS);
const WORLD_ITEM_NAMES={
  'Konoha':{weapon:'Kunai de la Feuille',relic:'Parchemin du Hokage',accessory:'Talisman du Feu'},
  'Namek':{weapon:'Lame de Ki',relic:'Cristal namek',accessory:'Capsule Senzu'},
  'Marineford':{weapon:'Sabre de Justice',relic:'Vivre Card',accessory:'Menotte marine'},
  'Château de l’Infini':{weapon:'Nichirin fracturée',relic:'Œil démoniaque',accessory:'Clochette de l’Infini'},
  'Shiganshina':{weapon:'Lame tridimensionnelle',relic:'Éclat du Mur',accessory:'Insigne des Éclaireurs'},
  'Hueco Mundo':{weapon:'Zanpakutō blanc',relic:'Fragment de Hōgyoku',accessory:'Masque Hollow'},
  'U.A.':{weapon:'Gantelet Plus Ultra',relic:'Noyau d’Alter',accessory:'Permis de Héros'},
  'Shibuya':{weapon:'Dague maudite',relic:'Doigt scellé',accessory:'Talisman d’Exorciste'},
  'Aincrad':{weapon:'Épée de Fer Noir',relic:'Cristal de téléportation',accessory:'Anneau de guilde'},
  'Monde du Néant':{weapon:'Lame du Néant',relic:'Cœur abyssal',accessory:'Sceau dimensionnel'},
};
const ITEM_RARITY_ORDER={rare:1,epic:2,legendary:3,mythic:4};
// La rareté décrit la qualité trouvée dans le coffre. L'amélioration augmente
// la puissance sans changer l'identité ni la couleur de la rune.
function upgradedItemRarity(currentRarity){return currentRarity;}

// Tire N affixes sans remise dans la totalité de ITEM_EFFECTS (N selon la
// rareté, voir ITEM_AFFIX_COUNT_BY_RARITY). Chaque magnitude reçoit une
// variance aléatoire (±15%) : deux objets du même palier/rareté n'ont donc
// jamais exactement le même rendement — c'est ce qui fait qu'un joueur a une
// raison de garder plusieurs objets de même rareté (« reroll chase »).
function rollItemAffixes(tier,rarity) {
  const count=ITEM_AFFIX_COUNT_BY_RARITY[rarity]||1;
  const pool=Object.keys(ITEM_EFFECTS);
  const picked=[];
  for(let i=0;i<count&&pool.length;i++){
    const index=Math.floor(Math.random()*pool.length);
    const key=pool.splice(index,1)[0];
    const effect=ITEM_EFFECTS[key];
    const base=effect.mode==='salvage'?(.05+Math.min(.25,tier*.005)):(.01+Math.min(.09,tier*.002));
    const variance=.85+Math.random()*.3;
    picked.push({effectKey:key,effectValue:Number((base*variance).toFixed(3))});
  }
  return picked;
}

function idleItemDrop(tier,kind,rarity,bonus,sourceWorld='Dojo ancestral') {
  const def=ITEM_KINDS[kind];
  const setKey=RUNE_SET_KEYS[Math.max(0,tier-1)%RUNE_SET_KEYS.length];
  const effectKey=RUNE_SETS[setKey].effectKey;
  const effect=ITEM_EFFECTS[effectKey];
  const effectValue=effect.mode==='salvage'?Number((.05+Math.min(.25,tier*.005)).toFixed(3)):Number((.01+Math.min(.09,tier*.002)).toFixed(3));
  const affixes=rollItemAffixes(tier,rarity).filter((affix)=>affix.effectKey!==effectKey).slice(0,Math.max(0,(ITEM_AFFIX_COUNT_BY_RARITY[rarity]||1)-1));
  const adjectives={rare:'Affûté',epic:'Héroïque',legendary:'Légendaire',mythic:'Transcendant'};
  const world=String(sourceWorld).split(' · ')[0];
  const family=Object.entries(WORLD_ITEM_NAMES).find(([name])=>world.startsWith(name))?.[1];
  const legacyKind=['rune1','rune3'].includes(kind)?'weapon':['rune2','rune4'].includes(kind)?'relic':'accessory';
  const baseName=family?.[legacyKind]||`${def.label} de ${world}`;
  const mainStat={rune1:'dps',rune2:'click',rune3:'dps',rune4:'burst',rune5:'boss',rune6:'team'}[kind]||'dps';
  const subStatCount={rare:1,epic:2,legendary:3,mythic:4}[rarity]||1;
  const subStatKeys=['dps','click','burst','team'].filter((key)=>key!==mainStat).slice(0,subStatCount);
  const subStats=Object.fromEntries(subStatKeys.map((key,index)=>[key,Number((.005+tier*.0005+index*.002).toFixed(3))]));
  return {kind,rarity,bonus,name:`${baseName} · ${RUNE_SETS[setKey].name} · ${adjectives[rarity]}`,effectKey,effectValue,affixes,sourceWorld:world,enhancementLevel:0,setKey,mainStat,subStats};
}

// Liste affichable (primaire + secondaires) pour l'UI — un objet pré-affixes
// (colonne affixes absente/vide) retombe simplement sur sa seule ligne
// historique, sans backfill nécessaire.
function describeItemAffixes(item) {
  const all=[{effectKey:item.effectKey,effectValue:item.effectValue},...(Array.isArray(item.affixes)?item.affixes:[])];
  return all.map(({effectKey,effectValue})=>({key:effectKey,value:effectValue,label:ITEM_EFFECTS[effectKey]?.label||effectKey,description:ITEM_EFFECTS[effectKey]?.description||'',mode:ITEM_EFFECTS[effectKey]?.mode||'dps'}));
}

// Affixe primaire (effectKey/effectValue) + affixes secondaires réunis en une
// seule liste brute {effectKey,effectValue} — base commune aux fonctions de
// bonus ci-dessous, pour que primaire et secondaires soient toujours traités
// identiquement (un affixe secondaire vaut autant que le primaire).
function itemAffixList(item) {
  return [{effectKey:item.effectKey,effectValue:item.effectValue},...(Array.isArray(item.affixes)?item.affixes:[])];
}

function itemProductionBonus(item) {
  return item.bonus+itemAffixList(item).filter((a)=>ITEM_EFFECTS[a.effectKey]?.mode==='dps').reduce((sum,a)=>sum+(a.effectValue||0),0)+Number(item.subStats?.dps||0);
}

function equipmentSetEffectMultiplier(items=[],mode='dps') {
  const counts=new Map();for(const item of items){if(!item.setKey)continue;counts.set(item.setKey,(counts.get(item.setKey)||0)+1);}
  let multiplier=1;for(const [key,count] of counts){const set=RUNE_SETS[key]||RUNE_SETS.energy;if(set.mode!==mode)continue;multiplier*=Math.pow(set.multiplier,Math.floor(count/set.required));}
  return multiplier;
}

function equipmentSetActionMultiplier(slots=[],mode='dps') {
  return slots.reduce((multiplier,slot)=>multiplier*equipmentSetEffectMultiplier(slot.items||[],mode),1);
}

function equipmentSetFlatMultiplier(items=[],mode='dps') {
  const byCharacter=new Map();for(const item of items){const key=item.equippedCharacterId||'unassigned';const list=byCharacter.get(key)||[];list.push(item);byCharacter.set(key,list);}
  return [...byCharacter.values()].reduce((multiplier,list)=>multiplier*equipmentSetEffectMultiplier(list,mode),1);
}

function itemActionBonus(slots, mode) {
  const affixMultiplier=1+slots.flatMap((slot)=>slot.items||[])
    .reduce((sum,item)=>sum+itemAffixList(item).filter((a)=>ITEM_EFFECTS[a.effectKey]?.mode===mode).reduce((affixSum,a)=>affixSum+Number(a.effectValue||0),0)+Number(item.subStats?.[mode]||0),0);
  return affixMultiplier*equipmentSetActionMultiplier(slots,mode);
}

function equipmentSetMultiplier(items=[]) {
  return equipmentSetEffectMultiplier(items,'dps');
}

// Valeur de recyclage indexée sur la progression du joueur (`bestStage`) : la
// formule historique (plate, ~25-600 essence) devenait dérisoire face à une
// économie exponentielle — dès le milieu de partie, recycler ne payait plus
// rien, et tout l'axe « Fortune » (set, affixe salvage, rôle Producteur)
// était mort-né. Plancher = quelques ennemis du meilleur stage atteint,
// pondéré par la rareté : recycler reste un appoint, jamais un revenu
// principal, mais un appoint qui suit le joueur toute la partie.
const SALVAGE_STAGE_FACTOR={rare:5,epic:12,legendary:25,mythic:50};
function itemSalvageValue(item,bestStage=1) {
  const rarity=ITEM_RARITY_ORDER[item.rarity]||1;
  const flat=Math.round(160*rarity*Math.pow(1+item.bonus,4)*(1+(item.enhancementLevel||0)*.08));
  const progression=Math.round(enemyReward(Math.max(1,bestStage))*(SALVAGE_STAGE_FACTOR[item.rarity]||SALVAGE_STAGE_FACTOR.rare)*(1+(item.enhancementLevel||0)*.08));
  return Math.max(25,flat,progression);
}
// Coût d'amélioration (+15) : formule plate historique + plancher indexé sur
// la progression — la formule plate (quelques milliers au total) devenait
// dérisoire face à l'économie exponentielle, l'amélioration doit rester un
// investissement comparable aux autres achats du moment (esprit Summoners
// War : le +15 est un gouffre assumé, pas une formalité).
function runeEnhanceCost(item,bestStage=1){
  const level=Math.max(0,Math.min(15,Number(item?.enhancementLevel)||0));if(level>=15)return 0;
  const rarity=ITEM_RARITY_ORDER[item?.rarity]||1;
  const flat=Math.round(120*(level+1)*Math.pow(1.22,level)*rarity);
  const progression=Math.round(enemyReward(Math.max(1,bestStage))*.5*(level+1)*rarity);
  return Math.max(flat,progression);
}
// Meulage (reroll) : re-tire la MAGNITUDE de l'affixe primaire et des affixes
// secondaires (les types sont conservés) aux valeurs du tier ACTUEL du joueur
// — revalorise les vieux objets « presque parfaits » et sert de puits
// d'essence de fin de partie (« grind » de Summoners War).
function runeRerollCost(item,bestStage=1){
  const rarity=ITEM_RARITY_ORDER[item?.rarity]||1;
  return Math.max(400,Math.round(enemyReward(Math.max(1,bestStage))*8*rarity));
}
function rerolledAffixValue(effectKey,tier){
  const mode=ITEM_EFFECTS[effectKey]?.mode||'dps';
  const base=mode==='salvage'?(.05+Math.min(.25,tier*.005)):(.01+Math.min(.09,tier*.002));
  const variance=.85+Math.random()*.3;
  return Number((base*variance).toFixed(3));
}
function enhancedRuneSubStats(item,nextLevel){
  const stats={...(item.subStats&&typeof item.subStats==='object'?item.subStats:{})};
  if(nextLevel%3===0){const keys=['dps','click','burst','team','boss'];const key=keys[(Math.floor(nextLevel/3)-1)%keys.length];stats[key]=Number((Number(stats[key]||0)+.01).toFixed(3));}
  return stats;
}

// (L'ancien plan d'auto-équipement — score pondéré par rôle
// (EQUIPMENT_ROLE_WEIGHTS), recherche de panoplies sur plusieurs ordres —
// a été supprimé : il construisait quasiment le meilleur build possible en
// un clic, vidant sets et rôles de tout intérêt. Voir la nouvelle route
// /equipment/auto-equip : simple comblement des emplacements vides.)

function progressionBossesCrossed(startStage, endStage, mode='progress') {
  if (mode === 'farm' || endStage <= startStage) return 0;
  return Math.max(0, Math.floor((endStage - 1) / 10) - Math.floor((startStage - 1) / 10));
}

function bossMechanicForStage(stage) {
  const wave = ((stage - 1) % 10) + 1; if (wave !== 10) return null;
  const zone = Math.floor((stage - 1) / 10) + 1;
  const act = campaignForStage(stage).act;
  const shieldHits = 8 + Math.min(12, (act - 1) * 2);
  const rageThreshold = Math.min(.5, .3 + (act - 1) * .03);
  return [
    { key:'shield',name:'Bouclier',description:`Frappe ${shieldHits} fois pour briser le bouclier.`,required:shieldHits },
    { key:'rage',name:'Rage',description:`Sous ${Math.round(rageThreshold*100)}% PV, les frappes faiblissent : garde ton Ultime.`,threshold:rageThreshold },
    { key:'regen',name:'Régénération',description:'Utilise l’Ultime pour interrompre sa régénération.' },
    { key:'counter',name:'Contre',description:'Alterne frappe et Combo pour éviter le contre.' },
  ][(zone - 1) % 4];
}

function idleAchievementDefs({ stage, recruits, teamLevels, worlds, prestige }) {
  const groups=[
    ['boss_hunter','Chasseur de boss','fa-skull',stage,[25,50,100,250]],
    ['recruiter','Maître recruteur','fa-users',recruits,[5,10,20,40]],
    ['trainer','Entraînement sans fin','fa-dumbbell',teamLevels,[50,250,1000,2500]],
    ['explorer','Voyageur des mondes','fa-map',worlds,[3,5,10,20]],
    ['sage','Maître de la retraite','fa-brain',prestige,[1,3,10,25]],
  ];
  return groups.flatMap(([key,title,icon,progress,targets])=>targets.map((target,index)=>({
    key:`${key}_${index+1}`,title:`${title} ${['I','II','III','IV'][index]}`,
    description:`Atteindre ${target}`,icon,progress:Math.min(progress,target),target,reward:index+1,rewardCurrency:'seals',
  })));
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

// Totaux du catalogue par licence (pour la collection façon Pokédex) : le
// catalogue Character n'évolue qu'aux imports admin, un cache mémoire de 30
// minutes évite un groupBy à chaque GET /state. try/catch : doubles de tests
// et anciens schémas répondent simplement « collection vide ».
const SERIES_TOTALS_TTL_MS = 30 * 60 * 1000;
let seriesTotalsCache = null; // { at, data: Map(series -> total) }
async function loadSeriesTotals() {
  if (seriesTotalsCache && Date.now() - seriesTotalsCache.at < SERIES_TOTALS_TTL_MS) return seriesTotalsCache.data;
  let data = new Map();
  try {
    const rows = await prisma.character.groupBy({ by: ['series'], _count: { _all: true }, where: { series: { not: null } } });
    data = new Map(rows.map((r) => [r.series, r._count._all]));
  } catch { return data; } // échec non mis en cache : nouvel essai à la prochaine requête
  seriesTotalsCache = { at: Date.now(), data };
  return data;
}
// Choix de départ (onboarding) : les 6 personnages RARES les plus populaires
// du catalogue (favoris AniList, la même donnée qui fixe les raretés) — une
// vitrine de visages connus plutôt que « les 6 premiers importés par id ».
// Cache mémoire 30 min (le catalogue ne bouge qu'aux imports admin) ; la
// même liste sert à VALIDER le choix côté /onboarding, pour qu'on ne puisse
// pas démarrer avec un rare hors vitrine en forgeant la requête.
const STARTER_POOL_TTL_MS = 30 * 60 * 1000;
let starterPoolCache = null; // { at, data }
async function starterChoicePool() {
  if (starterPoolCache && Date.now() - starterPoolCache.at < STARTER_POOL_TTL_MS) return starterPoolCache.data;
  let data = [];
  try {
    data = await prisma.character.findMany({
      where: { rarity: 'rare', imageUrl: { not: null } },
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true },
      orderBy: [{ favourites: 'desc' }, { id: 'asc' }],
      take: 6,
    });
  } catch { return data; } // échec non mis en cache : nouvel essai à la prochaine requête
  // Liste vide jamais mise en cache : catalogue pas encore importé (ou stub de
  // test) — on retente à la prochaine requête plutôt que de bloquer 30 min.
  if (data.length) starterPoolCache = { at: Date.now(), data };
  return data;
}
function invalidateStarterPool() { starterPoolCache = null; }

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
  const slots = await tx.idleSlot.findMany({
    where: { userId },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } } },
  });
  // Marque les héros « Éveillés » (shiny, +10% de production personnelle) et
  // leurs étoiles d'Éveil (+8% chacune) — ces informations vivent sur
  // DojoRecruit, pas sur l'emplacement. try/catch : les colonnes peuvent
  // manquer pendant la fenêtre de migration (et dans les tests qui ne
  // stubbent pas cette requête), auquel cas personne n'est éveillé.
  let recruitRows = [];
  try { recruitRows = await tx.dojoRecruit.findMany({ where: { userId }, select: { characterId: true, awakened: true, awakenStars: true } }); } catch { /* migration/tests */ }
  const recruitByCharacter = new Map(recruitRows.map((r) => [r.characterId, r]));
  // L'équipement est lié au PERSONNAGE (equippedCharacterId), plus au slot :
  // on le rattache ici par characterId pour que le reste du code (score
  // d'équipe, fiche héros, plan d'auto-équipement) continue de lire
  // `slot.items` sans changement, mais en suivant le héros s'il change
  // d'emplacement.
  const characterIds = slots.map((s) => s.characterId).filter(Boolean);
  let items = [];
  if (characterIds.length) items = await tx.idleItem.findMany({ where: { userId, equippedCharacterId: { in: characterIds } } });
  const itemsByCharacter = new Map();
  for (const item of items) { const list = itemsByCharacter.get(item.equippedCharacterId) || []; list.push(item); itemsByCharacter.set(item.equippedCharacterId, list); }
  return slots.map((s) => {
    const recruit = s.characterId ? recruitByCharacter.get(s.characterId) : null;
    return { ...s, awakened: !!recruit?.awakened, awakenStars: recruit?.awakenStars || 0, items: s.characterId ? (itemsByCharacter.get(s.characterId) || []) : [] };
  });
}

// Chaque classe porte désormais une composante de production : la production
// est à la fois le revenu ET le DPS passif — une classe qui n'y touchait pas
// (Guerrier/Mage/Ninja) était strictement dominée par l'Invocateur en idle,
// ses bonus (frappe/Ultime/Combo) ne payant qu'en jeu actif. L'Invocateur
// reste le roi du pur idle (+20%), les autres échangent une partie de cette
// production contre un avantage actif marqué.
const HERO_CLASSES = {
  warrior: { name: 'Guerrier', icon: 'fa-shield-halved', description: '+50% frappe · 20% de critique (×2) · +8% DPS', click: 1.5, prod: 1.08, burst: 1, team: 1,crit:.20 },
  mage: { name: 'Mage', icon: 'fa-hat-wizard', description: '+75% de dégâts avec l’Ultime · +8% DPS', click: 1, prod: 1.08, burst: 1.75, team: 1 },
  ninja: { name: 'Ninja', icon: 'fa-user-ninja', description: '+50% de dégâts avec le Combo · +8% DPS', click: 1, prod: 1.08, burst: 1, team: 1.5 },
  swordsman: { name: 'Épéiste', icon: 'fa-khanda', description: '+25% frappe · +10% DPS · Exécution ×2 sous 20% PV', click: 1.25, prod: 1.1, burst: 1, team: 1,execute:2 },
  summoner: { name: 'Invocateur', icon: 'fa-dragon', description: '+20% de DPS d’équipe', click: 1, prod: 1.2, burst: 1, team: 1 },
};
const HERO_SPECS = {
  warrior:[{key:'berserker',name:'Berserker',description:'+30% aux frappes',click:1.3},{key:'guardian',name:'Gardien',description:'+15% production',prod:1.15}],
  mage:[{key:'arcane',name:'Arcaniste',description:'+40% à l’Ultime',burst:1.4},{key:'elemental',name:'Élémentaliste',description:'+15% production',prod:1.15}],
  ninja:[{key:'shadow',name:'Ombre',description:'+35% au Combo',team:1.35},{key:'swift',name:'Éclair',description:'+20% aux frappes',click:1.2}],
  swordsman:[{key:'duelist',name:'Duelliste',description:'+25% aux frappes',click:1.25},{key:'commander',name:'Commandant',description:'+25% au Combo',team:1.25}],
  summoner:[{key:'beast',name:'Maître des bêtes',description:'+30% au Combo',team:1.3},{key:'spirit',name:'Spiritualiste',description:'+20% production',prod:1.2}],
};
function heroClass(key) { return HERO_CLASSES[key] || HERO_CLASSES.warrior; }
function heroSpec(classKey, specKey) { return HERO_SPECS[classKey]?.find((s)=>s.key===specKey) || { click:1,prod:1,burst:1,team:1,name:'Non spécialisée' }; }
const CHARACTER_TALENTS = [
  {key:'prodigy',name:'Prodige',description:'+12% de production personnelle',self:.12,team:0},
  {key:'mentor',name:'Mentor',description:'+4% de production à toute l’équipe',self:0,team:.04},
  {key:'relentless',name:'Inépuisable',description:'+8% de production personnelle',self:.08,team:0},
  {key:'leader',name:'Leader',description:'+6% de production à toute l’équipe',self:0,team:.06},
  {key:'chosen',name:'Élu',description:'+15% de production personnelle',self:.15,team:0},
  {key:'strategist',name:'Stratège',description:'+5% de production à toute l’équipe',self:0,team:.05},
];
function roleForCharacter(character) {
  const text=`${character?.name||''} ${character?.series||''}`.toLowerCase();
  if(/heal|sakura|orihime|support|rem|nezuko/.test(text))return 'support';
  if(/shield|armor|tank|reiner|all might|escano/.test(text))return 'tank';
  if(/ninja|assassin|killua|levi|zoro|sasuke/.test(text))return 'assassin';
  if(/bulma|senku|merchant|engineer|mai/.test(text))return 'producteur';
  return ['attaquant','support','tank','assassin','producteur'][stableCharacterHash(character)%5];
}
function characterTalent(character){
  const byRole={attaquant:'chosen',support:'leader',tank:'mentor',assassin:'prodigy',producteur:'strategist'};
  const key=typeof character==='object'?byRole[roleForCharacter(character)]:null;
  return CHARACTER_TALENTS.find((talent)=>talent.key===key)||CHARACTER_TALENTS[stableCharacterHash(character)%CHARACTER_TALENTS.length];
}
// Bonus de production des rôles à rendement DÉCROISSANT par doublon : à +9%
// plat par Attaquant, empiler dix Attaquants (+90%) écrasait toute
// composition variée — la diversité (+4%/rôle unique) et les rôles
// situationnels (Tank/Support) ne pouvaient pas compenser un bonus permanent
// cumulable sans friction. Le premier exemplaire garde sa pleine valeur, les
// suivants paient de moins en moins (plancher = dernière valeur de la table).
const ROLE_STACK_BONUSES={attaquant:[.09,.06,.04,.02],producteur:[.04,.03,.02,.01],assassin:[.03,.02,.01]};
function roleStackBonus(role,count){
  const table=ROLE_STACK_BONUSES[role];if(!table||!count)return 0;
  let sum=0;for(let i=0;i<count;i++)sum+=table[Math.min(i,table.length-1)];
  return sum;
}
// +6% par rôle unique après le premier (relevé de +4%) : la diversité devait
// peser plus lourd pour être une alternative crédible au stacking.
const ROLE_DIVERSITY_BONUS=.06;
function roleTeamBonus(roles){
  const count=(role)=>roles.filter((value)=>value===role).length;
  const uniqueRoleBonus=Math.max(0,new Set(roles).size-1)*ROLE_DIVERSITY_BONUS;
  return {
    attaquant:roleStackBonus('attaquant',count('attaquant')),
    producteur:roleStackBonus('producteur',count('producteur')),
    assassin:roleStackBonus('assassin',count('assassin')),
    diversity:uniqueRoleBonus,
    total:roleStackBonus('attaquant',count('attaquant'))+roleStackBonus('producteur',count('producteur'))+roleStackBonus('assassin',count('assassin'))+uniqueRoleBonus,
  };
}
const FORMATIONS={
  balanced:{name:'Équilibrée',description:'Toujours active. Aucun bonus ni condition.',bonusPercent:0,requirements:[],bonus:()=>1},
  assault:{name:'Assaut',description:'Réunit deux combattants offensifs.',bonusPercent:15,requirements:[{roles:['attaquant','assassin'],count:2,label:'Attaquant ou Assassin'}],bonus:(roles)=>roles.filter((r)=>['attaquant','assassin'].includes(r)).length>=2?1.15:1},
  fortress:{name:'Forteresse',description:'Associe une ligne de défense et un soutien.',bonusPercent:20,requirements:[{roles:['tank'],count:1,label:'Tank'},{roles:['support'],count:1,label:'Support'}],bonus:(roles)=>roles.includes('tank')&&roles.includes('support')?1.2:1},
  industry:{name:'Logistique',description:'Associe production et soutien.',bonusPercent:18,requirements:[{roles:['producteur'],count:1,label:'Producteur'},{roles:['support'],count:1,label:'Support'}],bonus:(roles)=>roles.includes('producteur')&&roles.includes('support')?1.18:1},
};
const ULTIMATE_COOLDOWN_MS=90000;
const TEAM_COMBO_COOLDOWN_MS=150000;
const ULTIMATE_CLICK_MULTIPLIER=75;
const ULTIMATE_TEAM_SECONDS=15;
function activeSkillCooldown(baseMs,supportCount,cooldownLevel=0,runMultiplier=1,passiveCooldownBonus=0){return Math.max(5000,Math.round(baseMs*(1-Math.min(.7,supportCount*.1+cooldownUpgradeBonus(cooldownLevel)+passiveCooldownBonus))*runMultiplier));}
function ultimateBaseDamage(clickDamage,teamRate){return Math.max(clickDamage*ULTIMATE_CLICK_MULTIPLIER,teamRate*ULTIMATE_TEAM_SECONDS);}
// (Les « Voies de Prestige » — 4 multiplicateurs plats choisis après le
// premier Prestige — ont été supprimées : redondantes avec les classes, les
// bénédictions de run et les Ancients, elles ajoutaient une couche de
// multiplicateurs sans vrai choix.)
function characterCombatSkill(character){const role=roleForCharacter(character);return {attaquant:{name:'Ruée',description:'Renforce les formations d’assaut.'},support:{name:'Ralliement',description:'Active les formations combinées.'},tank:{name:'Rempart',description:'Stabilise les combats de boss.'},assassin:{name:'Exécution',description:'Excellent contre les ennemis affaiblis.'},producteur:{name:'Logistique',description:'Améliore le rendement hors combat.'}}[role];}
function characterLeaderSkill(character){const role=roleForCharacter(character);return {attaquant:{name:'Avant-garde',description:'+12% de DPS d’équipe lorsque ce héros est chef.',prod:1.12},support:{name:'Inspiration',description:'+10% de DPS d’équipe lorsque ce héros est chef.',prod:1.10},tank:{name:'Commandement défensif',description:'+10% de DPS d’équipe lorsque ce héros est chef.',prod:1.10},assassin:{name:'Chasse coordonnée',description:'+12% de DPS d’équipe lorsque ce héros est chef.',prod:1.12},producteur:{name:'Maître logisticien',description:'+15% de DPS d’équipe lorsque ce héros est chef.',prod:1.15}}[role];}
function leaderSkillForSlots(slots,leaderCharacterId){const leader=slots.find((slot)=>slot.character&&slot.characterId===leaderCharacterId)||slots.find((slot)=>slot.character);return leader?characterLeaderSkill(leader.character):{name:'Aucun chef',description:'Désigne un chef pour activer un Lead Skill.',prod:1};}
const HERO_STYLES = {
  auras: [{ key:'none',name:'Sans aura',level:1 },{key:'flame',name:'Flammes',level:10},{key:'lightning',name:'Éclairs',level:25},{key:'void',name:'Énergie obscure',level:50},{key:'divine',name:'Aura divine',level:100}],
  stances: [{key:'balanced',name:'Équilibrée',level:1},{key:'power',name:'Puissance',level:20},{key:'speed',name:'Vitesse',level:40},{key:'master',name:'Maître',level:75}],
  titles: [{key:'rookie',name:'Novice d’Ascension',level:1},{key:'guardian',name:'Gardien des mondes',level:25},{key:'legend',name:'Légende du multivers',level:60},{key:'transcendent',name:'Transcendant',level:100}],
  hairs: [{key:'short',name:'Courte',level:1},{key:'spiky',name:'Hérissée',level:10},{key:'long',name:'Longue',level:30},{key:'wild',name:'Sauvage',level:60}],
  outfits: [{key:'dojo',name:'Tenue d’aventurier',level:1},{key:'ninja',name:'Armure ninja',level:20},{key:'captain',name:'Manteau de capitaine',level:45},{key:'divine',name:'Armure divine',level:90}],
  colors: [{key:'red',name:'Rouge AMQ',level:1},{key:'blue',name:'Bleu céleste',level:15},{key:'gold',name:'Or légendaire',level:40},{key:'violet',name:'Violet obscur',level:70}],
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

// `extras` (optionnel) : bonus transverses calculés par l'appelant —
// `achievementsCompleted` (succès complétés → +1% production chacun, cf.
// achievementProdMultiplier) et `autoClickDps` (Ancient « Frappe Fantôme »,
// ajouté APRÈS les multiplicateurs d'équipe : c'est le joueur qui frappe,
// pas l'équipe qui produit).
// Somme, sur les emplacements actifs de niveau 10+, la magnitude du passif
// de rareté de CE personnage pour le `stat` demandé (0 si son passif tiré
// porte sur un autre stat) — même esprit que `itemActionBonus` pour
// l'équipement, mais pour les passifs de personnage. Réutilisé pour
// click/crit/cooldown dans les routes de combat (le stat 'prodTeam' passe
// lui par `computeTotalRate`, seul endroit qui compose déjà la production).
function characterPassiveTeamBonus(slots, stat) {
  return slots.reduce((sum, s) => {
    if (!s.character || (s.level || 1) < 10) return sum;
    return sum + characterPassiveBonus(s.character, s.character.rarity, stat);
  }, 0);
}
function computeRateBreakdown(slots, prodLevel, dojoLevel, prodAncientBonus, classKey, specKey, battleSpeed=1, autoSkills=false, recruitCount=0,formation='balanced',leaderCharacterId=null,extras={}) {
  const seriesLevels = new Map();
  for (const s of slots) if (s.character?.series) seriesLevels.set(s.character.series, (seriesLevels.get(s.character.series) || 0) + (s.level || 1));
  const masteryBonus = (series) => { const n = seriesLevels.get(series) || 0; return n >= 500 ? .25 : n >= 250 ? .15 : n >= 100 ? .10 : n >= 25 ? .05 : 0; };
  const talentTeamBonus=slots.reduce((n,s)=>n+(s.character?characterTalent(s.character).team:0),0);
  const personalRates=slots.filter((s)=>s.characterId&&s.character).map((s)=>{
    const equipped=s.items||[];
    const gearMultiplier=(1+equipped.reduce((v,e)=>v+itemProductionBonus(e),0))*equipmentSetMultiplier(equipped);
    // Passif de rareté « prodSelf » (possible sur les rares, cf.
    // RARITY_PASSIVE_POOL) : ne s'applique qu'au niveau 10+, comme annoncé
    // côté personnage.
    const rarityPassiveSelf=(s.level||1)>=10?characterPassiveBonus(s.character,s.character.rarity,'prodSelf'):0;
    const baseRate=slotRate(s.character.rarity,s.level);
    const personalMultiplier=(1+characterTalent(s.character).self)*(1+rarityPassiveSelf)*heroAscensionMultiplier(s.ascension)*gearMultiplier*(1+masteryBonus(s.character.series))*(s.awakened?AWAKENED_BONUS:1)*awakenStarMultiplier(s.awakenStars);
    return {slotIndex:s.slotIndex,characterId:s.characterId,baseRate,personalMultiplier,personalRate:safeIdleNumber(baseRate*personalMultiplier)};
  });
  const teamPassive = 1 + characterPassiveTeamBonus(slots, 'prodTeam');
  // battleSpeed ne modifie volontairement plus l'économie : c'est un réglage
  // d'animation et non un multiplicateur obligatoire de classement.
  const reserveBonus=1+Math.min(.20,Math.max(0,recruitCount-slots.filter((s)=>s.character).length)*.01);
  const roles=slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character));
  const roleMultiplier=1+roleTeamBonus(roles).total;
  // `extras.completedSeries` (licences complétées, permanent) et
  // `extras.buffProd` (buff temporaire d'orbe) arrivent par rateExtrasFor —
  // même chemin que les succès, pour que TOUTES les routes calculent le même
  // taux. L'ancienne Voie de Prestige (multiplicateur plat) a été supprimée :
  // redondante avec classes + bénédictions + Ancients.
  const teamMultiplier=roleMultiplier*reserveBonus*(autoSkills?1.15:1)*(1+talentTeamBonus)*teamPassive*heroClass(classKey).prod*(heroSpec(classKey,specKey).prod||1)*currentIdleEvent().prod*prodMultiplier(prodLevel,prodAncientBonus)*dojoLevelMultiplier(dojoLevel)*synergyForSlots(slots).multiplier*(FORMATIONS[formation]||FORMATIONS.balanced).bonus(roles)*leaderSkillForSlots(slots,leaderCharacterId).prod*achievementProdMultiplier(extras.achievementsCompleted||0)*completedSeriesMultiplier(extras.completedSeries||0)*runBlessingEffects(extras.runBlessings).prod*(extras.buffProd||1);
  const heroes=personalRates.map((entry)=>({...entry,teamMultiplier,rate:safeIdleNumber(entry.personalRate*teamMultiplier)}));
  const heroRate=heroes.reduce((sum,entry)=>safeIdleNumber(sum+entry.rate),0);
  const autoClickDps=Math.max(0,extras.autoClickDps||0);
  return {heroes,teamMultiplier,heroRate,autoClickDps,totalRate:safeIdleNumber(heroRate+autoClickDps)};
}

function computeTotalRate(slots, prodLevel, dojoLevel, prodAncientBonus, classKey, specKey, battleSpeed=1, autoSkills=false, recruitCount=0,formation='balanced',leaderCharacterId=null,extras={}) {
  return computeRateBreakdown(slots,prodLevel,dojoLevel,prodAncientBonus,classKey,specKey,battleSpeed,autoSkills,recruitCount,formation,leaderCharacterId,extras).totalRate;
}

// Nombre de succès complétés (cf. idleAchievementDefs) — utilisé pour le
// multiplicateur permanent de production. Calculé à partir de données déjà
// chargées par tous les appelants (user + slots + roster), aucune requête.
function achievementsCompletedFor(user, slots, recruitCount) {
  const best = Math.max(user.idleBestStage || 1, user.idleStage || 1);
  const teamLevels = slots.reduce((n, s) => n + (s.character ? (s.level || 1) : 0), 0);
  const worlds = Math.min(DOJO_DECOR.length, Math.floor((best - 1) / 10) + 1);
  return idleAchievementDefs({ stage: best, recruits: recruitCount, teamLevels, worlds, prestige: user.prestigeLevel || 0 })
    .filter((a) => a.progress >= a.target).length;
}

// DPS passif de l'Ancient « Frappe Fantôme » : N frappes automatiques/s au
// rendement du clic de base (bonus de clic des Ancients inclus, pas les
// multiplicateurs situationnels de boss/monde — c'est un plancher stable).
function autoClickDpsFor(user, ancientLevelsByKey) {
  const rate = ancientBonus(ancientLevelsByKey, 'autoClickRate');
  if (!rate) return 0;
  return rate * clickYield(user.idleClickLevel || 0, ancientBonus(ancientLevelsByKey, 'clickMult'));
}

function rateExtrasFor(user, slots, recruitCount, ancientLevelsByKey) {
  const buff = activeOrbBuff(user);
  return {
    achievementsCompleted: achievementsCompletedFor(user, slots, recruitCount),
    autoClickDps: autoClickDpsFor(user, ancientLevelsByKey),
    runBlessings: user.idleRunBlessings,
    completedSeries: user.idleCompletedSeries || 0,
    buffProd: buff?.prod || 1,
  };
}

async function applyActiveDamage(tx, user, damage) {
  const normalized = normalizeWaveProgress(user.idleStage, user.idleWaveKills, user.idleBattleMode);
  const stage = normalized.stage;
  const waveKills = normalized.waveKills;
  const maxHp = enemyUnitMaxHp(stage, waveKills);
  const hp = user.idleEnemyHp > 0 && user.idleEnemyHp <= maxHp ? user.idleEnemyHp : maxHp;
  const now = new Date();
  const bossStartedAt = isBossStage(stage) ? (user.idleBossStartedAt ? new Date(user.idleBossStartedAt) : now) : null;
  const slots=await loadSlots(tx,user.id);const roles=slots.filter((slot)=>slot.character).map((slot)=>roleForCharacter(slot.character));
  const tankProtection=Math.max(.45,1-roles.filter((role)=>role==='tank').length*.15);
  const phaseMult = isBossStage(stage) && hp / maxHp <= .5 ? 1-(.25*tankProtection) : 1;
  const enrageMult = bossStartedAt && now.getTime() - bossStartedAt.getTime() >= BOSS_TIMER_SECONDS * 1000 ? 1-(.5*tankProtection) : 1;
  const executeMult=hp/maxHp<=.2?1+Math.min(.5,roles.filter((role)=>role==='assassin').length*.25):1;
  const bossItemMult=isBossStage(stage)?itemActionBonus(slots,'boss'):1;
  const dealt = safeIdleNumber(damage * phaseMult * enrageMult * executeMult * bossItemMult);
  if (dealt < hp) {
    const updated = await tx.user.update({ where: { id: user.id }, data: { idleEnemyHp: hp - dealt, idleBossStartedAt: bossStartedAt } });
    return { updated, killed:false, bossKilled:false };
  }
  const reward = enemyUnitReward(stage,waveKills);
  const waveComplete = waveKills + 1 >= enemiesRequiredForStage(stage);
  const nextStage = waveComplete && user.idleBattleMode !== 'farm' ? stage + 1 : stage;
  const nextWaveKills = waveComplete ? 0 : waveKills + 1;
  const bossMs = bossStartedAt ? Math.max(1, now.getTime() - bossStartedAt.getTime()) : null;
  const updated = await tx.user.update({
    where: { id: user.id },
    data: {
      essence: { increment: reward },
      essenceEarnedTotal: { increment: reward },
      idleRunEssenceEarned: { increment: reward },
      idleStage: nextStage,
      idleWaveKills: nextWaveKills,
      idleRunBestStage: Math.max(user.idleRunBestStage || 1, nextStage),
      idleBestStage: Math.max(user.idleBestStage || 1, nextStage),
      idleEnemyHp: enemyUnitMaxHp(nextStage,nextWaveKills),
      idleBossProgress: 0,
      idleBossStartedAt: null,
      ...(bossMs ? { idleBestBossMs: user.idleBestBossMs ? Math.min(user.idleBestBossMs, bossMs) : bossMs } : {}),
    },
  });
  return { updated, killed:true, bossKilled:isBossStage(stage) && waveComplete && user.idleBattleMode !== 'farm' };
}

function synergyForSlots(slots) {
  const active = slots.filter((s) => s.characterId && s.character);
  const counts = new Map();
  for (const s of active) if (s.character.series) counts.set(s.character.series, (counts.get(s.character.series) || 0) + 1);
  // Chaque licence alignée en Duo (2) ou Alliance (3+) apporte SON PROPRE
  // bonus, cumulé additivement avec les autres — auparavant, seule la
  // MEILLEURE licence comptait (`sort(...)[0]`) : un joueur avec deux duos de
  // licences différentes dans une équipe de 4+ ne touchait que le bonus d'une
  // seule paire, ce qui rendait toute diversité au-delà de la meilleure
  // licence strictement punitive plutôt que récompensée.
  const series = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name, count]) => ({ name, count, tier: count >= 3 ? 'alliance' : 'duo', bonus: count >= 3 ? .25 : .10 }))
    .sort((a, b) => b.bonus - a.bonus || b.count - a.count);
  const totalBonus = series.reduce((sum, s) => sum + s.bonus, 0);
  const best = series[0] || null;
  const shared = { activeCount: active.length, sameSeries: best?.count || 0, bestSeries: best?.name || null, series };

  if (series.length) {
    const duoToUpgrade = series.find((s) => s.tier === 'duo');
    const next = duoToUpgrade
      ? `Ajoute un 3e héros ${duoToUpgrade.name} pour passer cette paire à +25%`
      : `Alliance${series.length > 1 ? 's' : ''} déjà au maximum pour ${series.length > 1 ? 'ces licences' : 'cette licence'} · ajoute une autre licence en duo pour cumuler un bonus supplémentaire`;
    return {
      ...shared, key: 'license',
      name: series.length > 1 ? `${series.length} synergies de licence actives` : `${best.tier === 'alliance' ? 'Alliance' : 'Duo'} ${best.name}`,
      bonus: totalBonus, multiplier: 1 + totalBonus,
      condition: series.map((s) => `${s.count}/${s.tier === 'alliance' ? 3 : 2} héros ${s.name}`).join(' · '),
      next,
      rules: series.map((s) => ({ key: s.tier, label: s.tier === 'alliance' ? 'Alliance de licence' : 'Duo de licence', condition: `${s.count} héros ${s.name}`, bonus: s.bonus, met: true })),
    };
  }
  if (active.length >= 3) return {
    ...shared, key: 'crossover', name: 'Crossover', bonus: .05, multiplier: 1.05,
    condition: `${active.length} héros de licences différentes`,
    next: 'Aligne 2 héros de la même licence pour démarrer un bonus de licence (+10%, remplace le Crossover)',
    rules: [{ key: 'crossover', label: 'Crossover', condition: '3 héros de licences différentes', bonus: .05, met: true }],
  };
  return {
    ...shared, key: 'none', name: 'Aucune synergie', bonus: 0, multiplier: 1,
    condition: `${active.length}/3 héros actifs`,
    next: '2 héros de la même licence = +10% · 3 licences différentes = +5%',
    rules: [
      { key: 'duo', label: 'Duo de licence', condition: '2 héros de la même licence', bonus: .10, met: false },
      { key: 'alliance', label: 'Alliance de licence', condition: '3 héros de la même licence', bonus: .25, met: false },
      { key: 'crossover', label: 'Crossover', condition: '3 héros de licences différentes', bonus: .05, met: active.length >= 3 },
    ],
  };
}

// Décomposition pédagogique de la production d'équipe. Cette structure est
// calculée avec les mêmes règles que computeTotalRate afin que l'interface
// n'affiche jamais une « méta » approximative ou un bonus caché.
function teamMetaBreakdown(slots, recruitCount=0, formation='balanced', autoSkills=false,leaderCharacterId=null) {
  const active=slots.filter((slot)=>slot.characterId&&slot.character);
  const roles=active.map((slot)=>roleForCharacter(slot.character));
  const count=(role)=>roles.filter((value)=>value===role).length;
  const roleBreakdown=roleTeamBonus(roles);
  const uniqueRoleBonus=roleBreakdown.diversity;
  const roleBonus=roleBreakdown.total;
  const reserveBonus=Math.min(.20,Math.max(0,recruitCount-active.length)*.01);
  const teamTalentBonus=active.reduce((sum,slot)=>sum+characterTalent(slot.character).team,0);
  // Même règle que computeRateBreakdown (characterPassiveTeamBonus) : seuls
  // les passifs `prodTeam` réellement tirés par les personnages entrent dans
  // la production d'équipe. L'ancien barème fixe par rareté ({epic:.02, ...})
  // affichait ici un multiplicateur différent de celui effectivement appliqué.
  const passiveBonus=characterPassiveTeamBonus(slots,'prodTeam');
  const synergy=synergyForSlots(slots);
  const selectedFormation=FORMATIONS[formation]||FORMATIONS.balanced;
  const formationMultiplier=selectedFormation.bonus(roles);
  const leaderSkill=leaderSkillForSlots(slots,leaderCharacterId);
  const multipliers=[
    {key:'roles',label:'Rôles et diversité',multiplier:1+roleBonus,detail:`${count('attaquant')} Attaquant(s), ${count('assassin')} Assassin(s), ${count('producteur')} Producteur(s), ${new Set(roles).size} rôle(s) unique(s)`},
    {key:'talents',label:'Talents d’équipe',multiplier:1+teamTalentBonus,detail:'Mentor, Leader et Stratège actifs'},
    {key:'passives',label:'Passifs niv. 10',multiplier:1+passiveBonus,detail:'Somme des passifs « production d’équipe » actifs (héros niv. 10+)'},
    {key:'reserve',label:'Réserve',multiplier:1+reserveBonus,detail:`${Math.max(0,recruitCount-active.length)} recrue(s) non assignée(s), plafond +20%`},
    {key:'synergy',label:'Synergie',multiplier:synergy.multiplier,detail:synergy.name},
    {key:'formation',label:`Formation ${selectedFormation.name}`,multiplier:formationMultiplier,detail:formationMultiplier>1?'Condition remplie':'Condition non remplie ou formation neutre'},
    {key:'leader',label:`Lead Skill · ${leaderSkill.name}`,multiplier:leaderSkill.prod,detail:leaderSkill.description},
    {key:'auto',label:'Compétences automatiques',multiplier:autoSkills?1.15:1,detail:autoSkills?'Activées':'Inactives'},
  ];
  const roleDetails=[
    {key:'attaquant',count:count('attaquant'),name:'Attaquant',effect:'+9% DPS d’équipe, rendement décroissant par doublon (9/6/4/2%)',bonus:roleBreakdown.attaquant},
    {key:'assassin',count:count('assassin'),name:'Assassin',effect:'+3% DPS d’équipe (décroissant) et +25% dégâts sous 20% PV ennemi',bonus:roleBreakdown.assassin+Math.min(.50,count('assassin')*.25),situational:true},
    {key:'producteur',count:count('producteur'),name:'Producteur',effect:'+4% DPS d’équipe, rendement décroissant par doublon',bonus:roleBreakdown.producteur},
    {key:'support',count:count('support'),name:'Support',effect:'−10% recharge Ultime + Combo chacun. Cumulé avec Flux et passifs, cap global −70%',bonus:count('support')*.10,situational:true},
    {key:'tank',count:count('tank'),name:'Tank',effect:'−15% de pénalité de boss chacun (minimum 45%)',bonus:count('tank')*.15,situational:true},
    {key:'diversity',count:new Set(roles).size,name:'Diversité',effect:'+6% DPS d’équipe par rôle unique après le premier',bonus:uniqueRoleBonus},
  ];
  const talents=active.map((slot,index)=>{const talent=characterTalent(slot.character);return {slot:index+1,character:slot.character.name,name:talent.name,description:talent.description,teamBonus:talent.team,selfBonus:talent.self};});
  let recommendation='Composition stable : compare DPS, boss, essence et recharge avant de remplacer un héros.';
  if(!active.length)recommendation='Assigne un premier héros pour commencer à produire de l’Essence.';
  else if(roles.includes('producteur')&&!roles.includes('support'))recommendation='Ajoute un Support pour activer Logistique : Producteur + Support donne ×1,18.';
  else if(roles.includes('support')&&!roles.includes('producteur'))recommendation='Un Producteur ajoute +4% DPS d’équipe, son talent Stratège +5%, et peut activer Logistique ×1,18.';
  else if(formation!=='balanced'&&formationMultiplier===1)recommendation=`La formation ${selectedFormation.name} est sélectionnée mais sa condition n’est pas remplie.`;
  return {
    roleDetails,talents,multipliers,recommendation,
    visibleMultiplier:multipliers.reduce((value,item)=>value*item.multiplier,1),
    leaderSkill,leaderExplanation:`Le chef active ${leaderSkill.name} : ${leaderSkill.description}`,
  };
}

// Niveaux d'Ancients du joueur (Map clé→niveau, absent = pas encore acheté).
async function loadAncientLevels(client, userId) {
  const rows = await client.ancientLevel.findMany({ where: { userId }, select: { ancientKey: true, level: true } });
  return new Map(rows.map((r) => [r.ancientKey, r.level]));
}

// Solde l'essence en attente (production passive depuis idleLastCollectAt,
// plafonnée) puis laisse `mutate` appliquer son effet — le tout dans UNE
// écriture optimiste, pour que le taux utilisé au calcul soit celui d'avant la
// mutation (ex. avant de changer un emplacement) et que rien ne se perde.
// `essenceEarnedTotal` (jamais décrémentée) conserve aussi ce gain comme
// historique économique. Le rang progresse uniquement via ses épreuves.
async function settleUnlocked(userId, mutate) {
  // Les transactions interactives Prisma sont fragiles derrière certains
  // poolers PostgreSQL (P2028/connexion expirée). Un compare-and-swap sur
  // idleLastCollectAt garantit qu'une seule requête encaisse la période, sans
  // conserver une connexion transactionnelle pendant tous les calculs.
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new IdleError(404, 'Compte introuvable');
    const [slots,recruitCount] = await Promise.all([loadSlots(prisma, userId),prisma.dojoRecruit.count({where:{userId}})]);
    const ancientLevelsByKey = await loadAncientLevels(prisma, userId);
    const dojoLevel = user.idleRankLevel || 1;
    const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, ancientBonus(ancientLevelsByKey, 'prodMult'), user.idleHeroClass, user.idleHeroSpec, user.idleBattleSpeed, user.idleAutoSkills,recruitCount,user.idleFormation,user.idleLeaderCharacterId,rateExtrasFor(user,slots,recruitCount,ancientLevelsByKey));
    const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
    const elapsedMs = Math.min(offlineCapMs, Math.max(0, Date.now() - new Date(user.idleLastCollectAt).getTime()));
    const combat = simulateCombat({
      stage: user.idleStage,
      hp: user.idleEnemyHp,
      waveKills: user.idleWaveKills,
      dps: totalRate,
      elapsedSeconds: elapsedMs / 1000,
      mode: user.idleBattleMode,
      maxStageAdvance:MAX_STAGE_ADVANCE_PER_SYNC,
    });
    const rawCollected = safeIdleNumber(Math.floor(Number(combat.essence) || 0));
    // Chaque compteur reste sous le plafond : une addition répétée ne peut pas
    // dépasser la capacité d'un DOUBLE PRECISION PostgreSQL.
    const collected = Math.max(0, Math.min(
      rawCollected,
      ROUTE_NUMBER_CAP - safeIdleNumber(user.essence),
      ROUTE_NUMBER_CAP - safeIdleNumber(user.essenceEarnedTotal),
      ROUTE_NUMBER_CAP - safeIdleNumber(user.idleRunEssenceEarned)
    ));
    const stage = Math.max(1, Math.min(1e9, Math.floor(Number(combat.stage) || 1)));
    const hp = safeIdleNumber(combat.hp, enemyMaxHp(stage));
    // `simulateCombat` borne son propre travail (maxKills, cf. combat.js) pour
    // rester rapide même sur un très gros écart hors-ligne : sur une équipe
    // très puissante, l'écart réel (elapsedMs) peut donc dépasser ce que la
    // simulation a effectivement consommé (combat.elapsedSeconds). Avancer
    // idleLastCollectAt seulement du temps RÉELLEMENT consommé — jamais
    // jusqu'à « maintenant » — garantit que le reliquat non simulé reste dû et
    // sera comptabilisé aux prochaines synchronisations, au lieu d'être perdu
    // silencieusement pour les joueurs les plus avancés.
    const consumedMs = Math.min(elapsedMs, Math.max(0, Math.round((Number(combat.elapsedSeconds) || 0) * 1000)));
    const nextCollectAt = new Date(new Date(user.idleLastCollectAt).getTime() + consumedMs);
    let settledUser;
    try {
      settledUser = await prisma.user.update({
        // `id` conserve l'unicité Prisma ; idleLastCollectAt sert de verrou
        // optimiste. Si une autre requête a gagné, Prisma renvoie P2025.
        where: { id: userId, idleLastCollectAt: user.idleLastCollectAt },
        data: {
          essence: { increment: collected },
          essenceEarnedTotal: { increment: collected },
          idleRunEssenceEarned: { increment: collected },
          idleStage: stage,
          idleRunBestStage: Math.max(user.idleRunBestStage || 1, stage),
          idleBestStage: Math.max(user.idleBestStage || 1, stage),
          idleEnemyHp: hp,
          idleWaveKills: combat.waveKills,
          idleBossProgress:stage!==(user.idleStage||1)?0:user.idleBossProgress,
          idleBossStartedAt:isBossStage(stage)?(isBossStage(user.idleStage||1)&&user.idleBossStartedAt?user.idleBossStartedAt:new Date()):null,
          idleLastCollectAt: nextCollectAt,
        },
      });
    } catch (error) {
      if (error?.code === 'P2025') continue;
      throw error;
    }
    // `ancientLevelsByKey` passé au mutateur : certaines routes (recrutement)
    // ont besoin d'autres bonus d'Ancients (chance, remise) que celui déjà
    // appliqué ci-dessus à la production.
    if(combat.kills>0)await incrementIdleCounter(userId,'kill',combat.kills);
    const bosses=progressionBossesCrossed(user.idleStage||1,stage,user.idleBattleMode);
    if(bosses>0)await incrementIdleCounter(userId,'boss_kill',bosses);
    // `totalRate` transmis au mutateur : la frappe manuelle ajoute une part de
    // la production d'équipe (CLICK_RATE_SHARE) et le taux vient d'être
    // calculé ici — inutile de le recalculer dans chaque route.
    if (mutate) await mutate(prisma, settledUser, ancientLevelsByKey, { passiveKills: combat.kills, totalRate });
    return settledUser;
  }
  throw new IdleError(409, 'Une autre action est déjà en cours, réessaie.');
}

async function withSettle(userId, mutate) {
  return withIdleUserLock(userId, () => settleUnlocked(userId, mutate));
}

// État complet pour l'affichage (essence, emplacements 0..MAX_SLOTS-1, coûts,
// niveau/décor du Dojo, recrutement).
async function buildState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      essence: true, idleLastCollectAt: true, idleSlotsUnlocked: true, idleProdLevel: true, idleClickLevel: true, idleCritLevel:true, idleCooldownLevel:true,idleMultiStrikeLevel:true,idleRunBlessings:true,idleRunBlessingRerolls:true,idleRunStartedAt:true,
      essenceEarnedTotal: true, idleRunEssenceEarned: true, idleStage: true, idleRunBestStage: true, idleBestStage: true, idleEnemyHp: true, idleWaveKills:true,
      idleMilestoneClaimed: true, prestigeLevel: true, wisdomPoints: true,
      idleBossClaimed: true,
      idleHeroClass: true, idleHeroClassChangedAt: true,
      idleHeroAura: true, idleHeroStance: true, idleHeroTitle: true, idleHeroHair:true, idleHeroOutfit:true, idleHeroColor:true, idleHeroSpec:true, idleBattleSpeed:true, idleBattleMode:true, idleAutoSkills:true,idleRecruitPity:true,idleEssenceRecruitCount:true,idleOnboardingComplete:true,
      idleSeals:true,idleBurstReadyAt:true,idleTeamReadyAt:true,idleBossProgress:true,idleBossStartedAt:true,idleBestBossMs:true,idleFormation:true,idleLeaderCharacterId:true,idlePrestigeMilestone:true,
      idleBuffKey:true,idleBuffUntil:true,idleCompletedSeries:true,
      idleRankLevel:true,idleRankKills:true,idleRankClicks:true,idleRankUpgrades:true,idleRankBosses:true,idleRankStartedAt:true,
    },
  });
  if (!user) return null;
  const [slots, recruitCount, ancientLevelsByKey,missionCounters,inventoryItems] = await Promise.all([
    loadSlots(prisma, userId),
    prisma.dojoRecruit.count({ where: { userId } }),
    loadAncientLevels(prisma, userId),
    loadIdleCounters(userId),
    prisma.idleItem.findMany({where:{userId},orderBy:[{rarity:'desc'},{obtainedAt:'desc'}],take:IDLE_ITEM_CAPACITY}),
  ]);
  // Certains comptes de la première bêta ont gardé le marqueur
  // d'onboarding alors qu'un ancien reset avait supprimé leur roster. Un
  // joueur sans aucune recrue doit toujours pouvoir récupérer un starter.
  const needsStarter=!user.idleOnboardingComplete||recruitCount===0;
  const starterChoices = needsStarter ? await starterChoicePool() : [];
  let recruits = [];let presets=[];
  try { recruits = await prisma.dojoRecruit.findMany({ where: { userId }, include: { character: { select: { name:true, series: true, rarity: true } } }, orderBy:{recruitedAt:'desc'} }); } catch (e) { if (e?.code) throw e; }
  try{presets=await prisma.idleTeamPreset.findMany({where:{userId},select:{name:true,formation:true,slots:true},orderBy:{updatedAt:'desc'},take:SQUAD_PRESET_LIMIT});}catch(e){if(e?.code&&e.code!=='P2021')throw e;}
  const prodAncientBonus = ancientBonus(ancientLevelsByKey, 'prodMult');
  const clickAncientBonus = ancientBonus(ancientLevelsByKey, 'clickMult');
  const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
  const recruitDiscountBonus = ancientBonus(ancientLevelsByKey, 'recruitDiscount');
  const dojoLevel = user.idleRankLevel || 1;
  const runBlessingKeys=parseRunBlessings(user.idleRunBlessings);const blessingEffects=runBlessingEffects(runBlessingKeys);
  const rateExtras = rateExtrasFor(user, slots, recruitCount, ancientLevelsByKey);
  const rateBreakdown = computeRateBreakdown(slots, user.idleProdLevel, dojoLevel, prodAncientBonus, user.idleHeroClass, user.idleHeroSpec, user.idleBattleSpeed, user.idleAutoSkills,recruitCount,user.idleFormation,user.idleLeaderCharacterId,rateExtras);
  const totalRate = rateBreakdown.totalRate;
  const rateBySlot = new Map(rateBreakdown.heroes.map((entry)=>[entry.slotIndex,entry]));
  const strategy = synergyForSlots(slots);
  const previewElapsedMs = Math.min(offlineCapMs, Math.max(0, Date.now() - new Date(user.idleLastCollectAt).getTime()));
  const combatPreview = simulateCombat({
    stage: user.idleStage,
    hp: user.idleEnemyHp,
    waveKills: user.idleWaveKills,
    dps: totalRate,
    elapsedSeconds: previewElapsedMs / 1000,
    mode: user.idleBattleMode,
    maxStageAdvance:MAX_STAGE_ADVANCE_PER_SYNC,
  });
  const pending = Math.floor(combatPreview.essence);

  // Stage de référence pour les coûts indexés sur la progression (recyclage,
  // amélioration, meulage) — déclaré AVANT la boucle des emplacements : la
  // fiche héros y référençait `stage` (déclaré bien plus bas), et cette TDZ
  // faisait tomber /state en 500 pour tout joueur avec un héros assigné.
  const progressionStage = Math.max(user.idleBestStage || 1, Math.max(1, Math.floor(Number(combatPreview.stage) || 1)));
  const bySlot = new Map(slots.map((s) => [s.slotIndex, s]));
  const slotsOut = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = bySlot.get(i);
    const locked = i >= user.idleSlotsUnlocked;
    let character = null;
    if (row && row.characterId && row.character) {
      const level = row.level || 1;
      const realRate=rateBySlot.get(i);
      character = {
        id: row.character.id,
        name: row.character.name,
        imageUrl: row.character.imageUrl,
        rarity: row.character.rarity,
        series: row.character.series,
        level,
        rate: realRate?.rate || 0,
        personalRate: realRate?.personalRate || 0,
        personalMultiplier: realRate?.personalMultiplier || 1,
        teamMultiplier: realRate?.teamMultiplier || 1,
        teamShare: totalRate>0?(realRate?.rate||0)/totalRate:0,
        levelUpCost: charLevelUpCost(row.character.rarity, level),
        levelCosts: Object.fromEntries([1, 5, 10, 100].map((n) => [n, charLevelBulkCost(row.character.rarity, level, n)])),
        baseRate: RARITY_RATE[row.character.rarity] || 0,
        scaling: RARITY_LEVEL_BONUS[row.character.rarity] || 0,
        passive: characterPassiveDescription(row.character, row.character.rarity),
        passiveUnlocked: level >= 10,
        milestones: HERO_MILESTONES.map((target,index) => ({
          target,
          reached: level >= target,
          bonusMultiplier: 2,
          cumulativeMultiplier: Math.pow(2,index+1),
          effect: target===10?`Production ×2 et passif : ${characterPassiveDescription(row.character,row.character.rarity)}`:target===HERO_ASCENSION_LEVEL?'Production ×2 et Ascension débloquée':'Production ×2 supplémentaire',
        })),
        nextMilestone: HERO_MILESTONES.find((target) => target > level) || null,
        ascension: row.ascension || 0,
        ascensionMultiplier: heroAscensionMultiplier(row.ascension),
        nextAscensionMultiplier: heroAscensionMultiplier((row.ascension || 0) + 1),
        ascensionLevel: heroAscensionRequiredLevel(row.ascension),
        ascensionMax: HERO_ASCENSION_MAX,
        canAscend: level >= heroAscensionRequiredLevel(row.ascension) && (row.ascension || 0) < HERO_ASCENSION_MAX,
        ascensionCost: heroAscensionCost(row.character.rarity, row.ascension),
        equipments: RUNE_KINDS.map((kind) => { const e=(row.items||[]).find((x)=>x.kind===kind);const set=e?(RUNE_SETS[e.setKey]||RUNE_SETS.energy):null; return e?{...e,effectiveBonus:itemProductionBonus(e),effectLabel:ITEM_EFFECTS[e.effectKey]?.label||ITEM_KINDS[kind].effectLabel,effectDescription:ITEM_EFFECTS[e.effectKey]?.description||'',affixesDetailed:describeItemAffixes(e),enhanceCost:runeEnhanceCost(e,progressionStage),powerLevel:e.enhancementLevel||0,setName:set.name,setRequired:set.required,setDescription:set.description,setMode:set.mode,setBonus:set.bonus}:{kind,empty:true}; }),
        talent: characterTalent(row.character),
        role: roleForCharacter(row.character),
        combatSkill: characterCombatSkill(row.character),
        leaderSkill: characterLeaderSkill(row.character),
        awakened: !!row.awakened,
        awakenStars: row.awakenStars || 0,
        awakenStarMax: AWAKEN_STAR_MAX,
        awakenStarBonus: AWAKEN_STAR_BONUS,
        awakenStarMultiplier: awakenStarMultiplier(row.awakenStars),
        awakenStarCost: (row.awakenStars || 0) < AWAKEN_STAR_MAX ? awakenStarCost(row.awakenStars) : null,
      };
    }
    slotsOut.push({ index: i, locked, character, unlockCost: locked ? slotUpgradeCost(i) : null });
  }

  const { current: decor, next: nextDecor } = decorForLevel(dojoLevel);
  const decorArt = await decorArtForTheme(decor.theme);
  const rank = rankQuestSeries({ level:dojoLevel, kills:user.idleRankKills, clicks:user.idleRankClicks, upgrades:user.idleRankUpgrades, bosses:user.idleRankBosses });
  const xpIntoLevel = rank.completed;
  const xpForNextLevel = rank.total;
  const milestoneTier = milestoneTierForLevel(dojoLevel);

  // Le stage de combat est indépendant du rang : il rythme les combats et les
  // mondes, tandis que le rang se valide avec les épreuves d'Ascension.
  const stage = combatPreview.stage;
  const waveKills = combatPreview.waveKills || 0;
  const enemiesRequired = enemiesRequiredForStage(stage);
  const clickBase = clickYield(user.idleClickLevel, clickAncientBonus);
  const clickMechanic = bossMechanicForStage(stage);
  const enemy=enemyArchetype(stage,waveKills);
  const maxEnemyHp = enemyUnitMaxHp(stage,waveKills);
  const enemyHp = Math.max(0, Math.min(maxEnemyHp, combatPreview.hp));
  const hpRatio=enemyHp/Math.max(1,maxEnemyHp);
  let mechanicMultiplier=!clickMechanic?1:clickMechanic.key==='shield'&&(user.idleBossProgress||0)<8?.25:clickMechanic.key==='rage'&&hpRatio<=.3?.5:clickMechanic.key==='regen'&&(user.idleBossProgress||0)<1?.65:clickMechanic.key==='counter'&&(user.idleBossProgress||0)===1?.35:1;
  const combatWorld=campaignForStage(stage);
  const worldClick=combatWorld.modifier?.click||1;
  const activeBuff=activeOrbBuff(user);
  const buffClick=activeBuff?.click||1;
  const activeRoles=slots.filter((slot)=>slot.character).map((slot)=>roleForCharacter(slot.character));
  const activeSupportCount=activeRoles.filter((role)=>role==='support').length;
  const passiveCooldownBonus=characterPassiveTeamBonus(slots,'cooldown');
  const executeAt=combatWorld.modifier?.executeAt||.2;const executionActive=!!heroClass(user.idleHeroClass).execute&&hpRatio<=executeAt;
  if(isBossStage(stage)&&hpRatio<=.5)mechanicMultiplier*=.75;
  if(isBossStage(stage)&&user.idleBossStartedAt&&Date.now()-new Date(user.idleBossStartedAt).getTime()>=BOSS_TIMER_SECONDS*1000)mechanicMultiplier*=.5;
  if(executionActive)mechanicMultiplier*=heroClass(user.idleHeroClass).execute;
  if(hpRatio<=.2)mechanicMultiplier*=1+Math.min(.5,activeRoles.filter((role)=>role==='assassin').length*.25);
  const clickItems=itemActionBonus(slots,'click')*(isBossStage(stage)?itemActionBonus(slots,'boss'):1);
  // Même base que la route /click : rendement plat + part de la production
  // (CLICK_RATE_SHARE), pour que l'aperçu affiché corresponde aux dégâts réels.
  const clickDamage = Math.max(1, Math.round((clickBase + totalRate * CLICK_RATE_SHARE) * heroClass(user.idleHeroClass).click * (heroSpec(user.idleHeroClass,user.idleHeroSpec).click||1) * currentIdleEvent().click * worldClick * buffClick * mechanicMultiplier * clickItems * blessingEffects.click));
  // Même formule que la route /click (passifs de personnage inclus) pour que
  // la chance affichée soit celle réellement tirée.
  const critChance=Math.max(0,Math.min(.95,(heroClass(user.idleHeroClass).crit||.12)+(combatWorld.modifier?.critBonus||0)+critUpgradeBonus(user.idleCritLevel)+blessingEffects.crit+characterPassiveTeamBonus(slots,'crit')));
  const uniqueActiveRoles=new Set(activeRoles).size;
  const burstPreview=Math.max(1,Math.round(ultimateBaseDamage(clickYield(user.idleClickLevel||0,clickAncientBonus),totalRate)*heroClass(user.idleHeroClass).burst*(heroSpec(user.idleHeroClass,user.idleHeroSpec).burst||1)*(combatWorld.modifier?.burst||1)*itemActionBonus(slots,'burst')*blessingEffects.burst));
  const teamPreview=activeRoles.length<2?0:Math.max(1,Math.floor(totalRate*(20+uniqueActiveRoles*5)*heroClass(user.idleHeroClass).team*(heroSpec(user.idleHeroClass,user.idleHeroSpec).team||1)*(combatWorld.modifier?.team||1)*itemActionBonus(slots,'team')*blessingEffects.team));
  const combatArt=await decorArtForTheme(combatWorld.theme);
  Object.assign(combatWorld,{backgroundUrl:combatArt?.backgroundUrl||null,boss:combatArt?{characterId:combatArt.characterId,name:combatArt.name,imageUrl:combatArt.imageUrl,generatedImageUrl:combatArt.generatedImageUrl}:null});
  const xpIntoStage = maxEnemyHp - enemyHp;
  const xpForNextStage = maxEnemyHp;
  const bossStartedAt=isBossStage(stage)?(user.idleBossStartedAt?new Date(user.idleBossStartedAt).getTime():Date.now()):null;
  const bossTimerRemainingMs=bossStartedAt===null?null:Math.max(0,BOSS_TIMER_SECONDS*1000-(Date.now()-bossStartedAt));
  const defeatedBosses = Math.floor(Math.max(0, stage - 1) / 10);
  const nextBossChest = user.idleBossClaimed + 1;
  const nextChestRewards=bossChestRewards(nextBossChest);

  const missionDefs = idleMissionList(user, recruitCount, slots.filter((s) => s.characterId).length, stage,missionCounters);
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
  const worldsDiscovered=Math.min(DOJO_DECOR.length,Math.floor((Math.max(user.idleBestStage||1,stage)-1)/10)+1);
  const achievementDefs = idleAchievementDefs({ stage:Math.max(user.idleBestStage||1,stage), recruits: recruitCount, teamLevels: weeklyLevels, worlds: worldsDiscovered, prestige: user.prestigeLevel });
  let achievementClaims = []; try { achievementClaims = await prisma.idleMissionClaim.findMany({ where: { userId, period: 'lifetime', missionKey: { in: achievementDefs.map((a) => `achievement_${a.key}`) } }, select: { missionKey: true } }); } catch (e) { if (e?.code) throw e; }
  const claimedAchievements = new Set(achievementClaims.map((c) => c.missionKey));
  const achievements = achievementDefs.map((a) => ({ ...a, completed: a.progress >= a.target, claimed: claimedAchievements.has(`achievement_${a.key}`) }));
  // Bonus permanent des succès (déjà appliqué au totalRate via rateExtras) —
  // exposé pour que l'interface montre POURQUOI compléter les succès rapporte.
  const achievementsBonus = {
    completed: rateExtras.achievementsCompleted,
    total: achievementDefs.length,
    perAchievement: ACHIEVEMENT_PROD_BONUS,
    multiplier: achievementProdMultiplier(rateExtras.achievementsCompleted),
  };
  // Collection par licence (façon Pokédex) : total du catalogue par série
  // (cache mémoire 30 min, le catalogue ne bouge presque jamais) croisé avec
  // les recrues du joueur. Seules les séries où il possède au moins un héros
  // sont listées — le reste se découvre en invoquant.
  const seriesTotals = await loadSeriesTotals();
  const ownedBySeries = new Map();
  for (const r of recruits) {
    if (!r.character?.series) continue;
    const entry = ownedBySeries.get(r.character.series) || { owned: 0, awakened: 0 };
    entry.owned++;
    if (r.awakened) entry.awakened++;
    ownedBySeries.set(r.character.series, entry);
  }
  const seriesCollection = [...ownedBySeries.entries()].map(([series, entry]) => {
    const total = Math.max(entry.owned, seriesTotals.get(series) || entry.owned);
    return { series, owned: entry.owned, awakened: entry.awakened, total, percent: Math.round((entry.owned / total) * 100), complete: entry.owned >= total };
  }).sort((a, b) => b.percent - a.percent || b.owned - a.owned);
  const catalogTotal = [...seriesTotals.values()].reduce((sum, n) => sum + n, 0);
  // ── Complétion de licence : synchronisation paresseuse du compteur
  // permanent (User.idleCompletedSeries). Monotone : ne descend jamais, même
  // si un import catalogue agrandit une licence déjà complétée — la
  // récompense reste acquise. Chaque nouvelle complétion verse aussi des
  // Sceaux (garde optimiste sur l'ancienne valeur : deux requêtes
  // concurrentes ne créditent pas deux fois).
  // Garde-fou : si les totaux du catalogue n'ont pas pu être chargés
  // (seriesTotals vide, cf. loadSeriesTotals), chaque licence possédée
  // paraîtrait « complète » — on ne synchronise jamais dans ce cas.
  const completedNow = seriesTotals.size ? seriesCollection.filter((s) => s.complete).length : 0;
  let completedSeries = user.idleCompletedSeries || 0;
  if (completedNow > completedSeries) {
    const gainedSeals = (completedNow - completedSeries) * SERIES_COMPLETION_SEALS;
    try {
      const synced = await prisma.user.updateMany({
        where: { id: userId, idleCompletedSeries: completedSeries },
        data: { idleCompletedSeries: completedNow, idleSeals: { increment: gainedSeals } },
      });
      if (synced.count) completedSeries = completedNow;
    } catch { /* fenêtre de migration : le bonus s'appliquera à la prochaine lecture */ }
  }
  const now=new Date();const seasonPeriod=periods.month;const seasonName=['Hiver Éternel','Floraison des héros','Brasier des mondes','Crépuscule dimensionnel'][Math.floor(now.getUTCMonth()/3)];
  const seasonActivity=seasonActivityScore(missionCounters,seasonPeriod);
  let seasonClaims=[];try{seasonClaims=await prisma.idleMissionClaim.findMany({where:{userId,period:`season-${seasonPeriod}`,missionKey:{startsWith:'season_tier_'}},select:{missionKey:true}});}catch(e){if(e?.code)throw e;}const seasonClaimed=new Set(seasonClaims.map((x)=>x.missionKey));
  const activeSlots=slots.filter((s)=>s.character);
  const challengeDefs=idleChallengeList(missionCounters,slots,periods);
  let challengeClaims=[];try{challengeClaims=await prisma.idleMissionClaim.findMany({where:{userId,OR:challengeDefs.map((c)=>({missionKey:`challenge_${c.key}`,period:c.period}))},select:{missionKey:true,period:true}});}catch(e){if(e?.code)throw e;}const claimedChallenges=new Set(challengeClaims.map((c)=>`${c.missionKey}:${c.period}`));
  const challenges=challengeDefs.map((c)=>({...c,progress:Math.min(c.progress,c.target),completed:c.progress>=c.target,claimed:claimedChallenges.has(`challenge_${c.key}:${c.period}`)}));
  let riftRun=null;try{riftRun=await prisma.idleRiftRun.findUnique({where:{userId_period:{userId,period:periods.week}}});}catch(e){if(e?.code)throw e;}
  const rift=weeklyRift(missionCounters,totalRate,Math.max(user.idleBestStage||1,stage),dojoLevel,periods,riftRun?.relics||[]);
  rift.pendingChoice=riftRelicDetails(riftRun?.pendingChoice||[]);
  const guide=[
    {key:'recruit',title:'Invoque ton premier héros',description:'Utilise 1 Sceau ou de l’Essence pour obtenir une recrue Rare ou supérieure.',done:recruitCount>0,tab:'home'},
    {key:'assign',title:'Forme ton équipe',description:'Assigne une recrue dans un emplacement pour produire automatiquement.',done:activeSlots.length>0,tab:'team'},
    {key:'train',title:'Entraîne un héros',description:'Monte un membre de l’équipe au niveau 10 pour activer son passif.',done:activeSlots.some((s)=>(s.level||1)>=10),tab:'team'},
    {key:'boss',title:'Vaincs un boss',description:'Atteins la vague 10 puis ouvre son coffre.',done:stage>10,tab:'home'},
    {key:'gear',title:'Équipe un objet',description:'Les coffres donnent des objets à placer sur les six emplacements.',done:slots.some((s)=>(s.items||[]).length>0),tab:'equipment'},
    {key:'prestige',title:'Prépare ton premier Prestige',description:'Atteins le stage requis et garde la run assez longtemps pour obtenir de la Sagesse permanente.',done:user.prestigeLevel>0,tab:'upgrades'},
  ];
  // Équipé sur un personnage : reste vrai même si ce personnage est
  // actuellement au repos (pas dans un emplacement actif) — `slotByCharacter`
  // ne sert qu'à savoir OÙ il produit en ce moment, `characterNameById`
  // (issu du roster complet, pas des seuls emplacements actifs) permet
  // d'afficher le nom même pour un héros laissé au repos.
  const slotByCharacter=new Map(slots.filter((s)=>s.characterId).map((s)=>[s.characterId,s]));
  const characterNameById=new Map(recruits.map((r)=>[r.characterId,r.character?.name]));
  const preparedInventoryItems=inventoryItems.map((item)=>{
    const activeSlot=item.equippedCharacterId?slotByCharacter.get(item.equippedCharacterId):null;
    const set=RUNE_SETS[item.setKey]||RUNE_SETS.energy;
    return {...item,effectiveBonus:itemProductionBonus(item),effectLabel:ITEM_EFFECTS[item.effectKey]?.label||ITEM_KINDS[item.kind]?.effectLabel||'Effet',effectDescription:ITEM_EFFECTS[item.effectKey]?.description||'',affixesDetailed:describeItemAffixes(item),kindLabel:ITEM_KINDS[item.kind]?.label||item.kind,setName:set.name,setRequired:set.required,setDescription:set.description,setMode:set.mode,setBonus:set.bonus,salvageValue:itemSalvageValue(item,progressionStage),enhanceCost:runeEnhanceCost(item,progressionStage),rerollCost:runeRerollCost(item,progressionStage),powerLevel:item.enhancementLevel||0,equipped:!!item.equippedCharacterId,equippedSlotIndex:activeSlot?.slotIndex??null,equippedCharacter:item.equippedCharacterId?(characterNameById.get(item.equippedCharacterId)||null):null,equippedResting:!!item.equippedCharacterId&&!activeSlot};
  });
  const inventoryFamilies=RUNE_SET_KEYS.map((key)=>{const set=RUNE_SETS[key];const count=preparedInventoryItems.filter((item)=>(item.setKey||'energy')===key).length;return {key,world:set.name,count,kinds:[],complete:count>=set.required,required:set.required,description:set.description,mode:set.mode,bonus:set.bonus};}).filter((set)=>set.count).sort((a,b)=>Number(b.complete)-Number(a.complete)||b.count-a.count);
  const inventory={
    capacity:IDLE_ITEM_CAPACITY,
    count:inventoryItems.length,
    items:preparedInventoryItems,
    summary:{worlds:inventoryFamilies.length,effects:new Set(preparedInventoryItems.flatMap((item)=>item.affixesDetailed.map((a)=>a.key))).size,equipped:preparedInventoryItems.filter((item)=>item.equipped).length,completeFamilies:inventoryFamilies.filter((family)=>family.complete).length},
    families:inventoryFamilies,
    sets:Object.entries(RUNE_SETS).map(([key,set])=>({key,...set})),
    setBonus:{label:'Équipe 2 ou 4 objets du même set sur un héros pour activer son bonus.'},
  };
  const runBestStage=Math.max(user.idleRunBestStage||1,stage);const blessingSlots=Math.min(12,Math.floor((runBestStage-1)/20));const blessingPending=runBlessingKeys.length<blessingSlots;
  // `buildState` charge volontairement une projection sans `id`. La graine
  // doit donc utiliser l'identifiant reçu par la fonction ; sinon l'interface
  // affiche l'offre de `undefined` que la route de choix refuse ensuite.
  const blessingChoices=blessingPending?runBlessingChoices(userId,user.prestigeLevel,runBlessingKeys.length,runBlessingKeys,user.idleRunBlessingRerolls||0):[];
  const blessingRerollCost=blessingPending?runBlessingRerollCost(user.idleRunBlessingRerolls||0):null;
  const selectedBlessings=runBlessingKeys.map((key)=>RUN_BLESSINGS.find((item)=>item.key===key)).filter(Boolean);
  return {
    essence: user.essence,
    pendingEssence: pending,
    totalRate,
    economy:{essence:user.essence,seals:user.idleSeals,pendingEssence:pending,dps:totalRate,heroDps:rateBreakdown.heroRate,autoClickDps:rateBreakdown.autoClickDps,offlineCapMs},
    // Buff temporaire d'orbe en cours (ou null) — le client affiche le bandeau
    // et le compte à rebours ; le serveur reste seul juge de l'expiration.
    buff:(()=>{const active=activeOrbBuff(user);return active?{key:active.key,label:active.label,description:active.description,prod:active.prod,click:active.click,until:active.until.toISOString(),remainingSeconds:Math.max(0,Math.round((active.until.getTime()-Date.now())/1000))}:null;})(),
    run:{stage,bestStage:runBestStage,essenceEarned:user.idleRunEssenceEarned||0,mode:user.idleBattleMode||'progress',act:combatWorld.act,build:{blessings:selectedBlessings,effects:blessingEffects,pending:blessingPending,choices:blessingChoices,rerollCost:blessingRerollCost,nextStage:blessingSlots>=12?null:(blessingSlots+1)*20+1,maxChoices:12}},
    combat:{stage,hp:enemyHp,maxHp:maxEnemyHp,dps:totalRate,reward:enemyUnitReward(stage,waveKills),isBoss:isBossStage(stage),timerSeconds:isBossStage(stage)?BOSS_TIMER_SECONDS:null,bossFailed:combatPreview.bossFailed,world:combatWorld},
    permanentProgress:{dojoLevel,xpTotal:user.essenceEarnedTotal,bestStage:Math.max(user.idleBestStage||1,stage),prestige:user.prestigeLevel,wisdom:user.wisdomPoints},
    rank:{...rank,startedAt:user.idleRankStartedAt?.toISOString()||null},
    collection:{recruits:recruitCount,masteries,worldsDiscovered},
    inventory,
    automation:{speed:user.idleBattleSpeed||1,mode:user.idleBattleMode||'progress',autoSkills:!!user.idleAutoSkills},
    onboarding:{
      required:needsStarter,
      classes:Object.entries(HERO_CLASSES).map(([key,value])=>({key,name:value.name,icon:value.icon,description:value.description})),
      starters:starterChoices.map((character)=>({...character,talent:characterTalent(character),role:roleForCharacter(character),baseRate:slotRate(character.rarity,1)})),
    },
    heroClass: { key: user.idleHeroClass, ...heroClass(user.idleHeroClass), passiveActive:executionActive,passiveStatus:user.idleHeroClass==='swordsman'?(executionActive?'EXÉCUTION ACTIVE · dégâts de frappe ×2':`Exécution à ${Math.round(executeAt*100)}% PV · ennemi à ${Math.round(hpRatio*100)}%`):null, changeReadyAt:user.idleHeroClassChangedAt?new Date(new Date(user.idleHeroClassChangedAt).getTime()+10*60*1000).toISOString():null, choices: Object.entries(HERO_CLASSES).map(([key, value]) => ({ key, ...value })) },
    heroSpecialization: { key:user.idleHeroSpec, active:heroSpec(user.idleHeroClass,user.idleHeroSpec), unlocked:dojoLevel>=25, choices:(HERO_SPECS[user.idleHeroClass]||[]).map((s)=>({...s,selected:s.key===user.idleHeroSpec})) },
    heroStyle: { aura:user.idleHeroAura, stance:user.idleHeroStance, title:user.idleHeroTitle, hair:user.idleHeroHair, outfit:user.idleHeroOutfit, color:user.idleHeroColor, choices:unlockedStyles(dojoLevel,{auras:user.idleHeroAura,stances:user.idleHeroStance,titles:user.idleHeroTitle,hairs:user.idleHeroHair,outfits:user.idleHeroOutfit,colors:user.idleHeroColor}) },
    strategy: { ...strategy, reserveBonus:Math.min(.20,Math.max(0,recruitCount-slots.filter((s)=>s.character).length)*.01), roles: slots.filter((s) => s.character).map((s) => roleForCharacter(s.character)),formation:user.idleFormation||'balanced',leaderCharacterId:(slots.some((s)=>s.characterId===user.idleLeaderCharacterId)?user.idleLeaderCharacterId:slots.find((s)=>s.character)?.characterId)||null,formations:Object.entries(FORMATIONS).map(([key,f])=>{const roles=slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character));const multiplier=f.bonus(roles);const requirements=(f.requirements||[]).map((requirement)=>{const current=roles.filter((role)=>requirement.roles.includes(role)).length;return {label:requirement.label,current,required:requirement.count,met:current>=requirement.count};});return {key,name:f.name,description:f.description,active:key===(user.idleFormation||'balanced'),multiplier,bonusPercent:f.bonusPercent,conditionMet:key==='balanced'||multiplier>1,requirements};}),presets,squads:{limit:SQUAD_PRESET_LIMIT,unlocked:unlockedSquadPresetCount(user),slots:squadPresetSlots(user,presets)},meta:teamMetaBreakdown(slots,recruitCount,user.idleFormation||'balanced',!!user.idleAutoSkills,user.idleLeaderCharacterId),leaderSkill:leaderSkillForSlots(slots,user.idleLeaderCharacterId) },
    lastCollectAt: user.idleLastCollectAt,
    offlineCapMs,
    offlineSummary:{awayMs:previewElapsedMs,essence:pending,kills:combatPreview.kills,waves:Math.max(0,combatPreview.stage-(user.idleStage||1)),bossBlocked:combatPreview.bossFailed,progressionCapped:combatPreview.progressionCapped,capped:Date.now()-new Date(user.idleLastCollectAt).getTime()>=offlineCapMs},
    slots: slotsOut,
    slotsUnlocked: user.idleSlotsUnlocked,
    maxSlots: MAX_SLOTS,
    startSlots: START_SLOTS,
    recruit: { count: recruitCount, nextCost:recruitCost(),nextCostAfter:recruitCost(),currency:'seals',balance:user.idleSeals,essenceCost:recruitEssenceCost(user.idleEssenceRecruitCount,recruitDiscountBonus),essenceCostAfter:recruitEssenceCost((user.idleEssenceRecruitCount||0)+1,recruitDiscountBonus),essenceRecruitCount:user.idleEssenceRecruitCount||0,essenceBalance:user.essence,pity:user.idleRecruitPity||0,guaranteedEpicIn:Math.max(1,10-(user.idleRecruitPity||0)),odds:Object.fromEntries(RECRUIT_WEIGHTS.map(([rarity,weight])=>[rarity,weight])),income:{daily:3,weekly:3} },
    recruitHistory: recruits.slice(0,8).map((r)=>({ id:r.characterId, name:r.character?.name, series:r.character?.series, rarity:r.character?.rarity, recruitedAt:r.recruitedAt, talent:characterTalent(r.character),role:roleForCharacter(r.character),awakened:!!r.awakened })),
    battle: {
      stage,
      bestStage: Math.max(user.idleBestStage || 1, stage),
      runBestStage: Math.max(user.idleRunBestStage || 1, stage),
      hp: enemyHp,
      maxHp: maxEnemyHp,
      reward: enemyUnitReward(stage,waveKills),
      enemy,
      isBoss: isBossStage(stage),
      phase:isBossStage(stage)?(hpRatio<=.5?2:1):null,
      enraged:isBossStage(stage)&&bossTimerRemainingMs<=0,
      bestTimeMs:user.idleBestBossMs||null,
      timerSeconds: isBossStage(stage) ? BOSS_TIMER_SECONDS : null,
      timerRemainingMs:bossTimerRemainingMs,
      bossFailed: combatPreview.bossFailed,
      world:combatWorld,
      kills: enemiesDefeatedBeforeStage(stage) + waveKills,
      enemiesDefeated: waveKills,
      enemiesRequired,
      enemiesRemaining: enemiesRequired - waveKills,
      enemyNumber: waveKills + 1,
      xpIntoStage,
      xpForNextStage,
      progress: xpForNextStage > 0 ? Math.min(1, xpIntoStage / xpForNextStage) : 1,
      bossChest: { defeated: defeatedBosses, claimed: user.idleBossClaimed, available: defeatedBosses >= nextBossChest, tier: nextBossChest, ...nextChestRewards },
      isElite:isEliteStage(stage),
      mechanic: clickMechanic?{...clickMechanic,progress:user.idleBossProgress||0,active:clickMechanic.key!=='shield'||(user.idleBossProgress||0)<8}:null,
      speed: { current:user.idleBattleSpeed||1, choices:Object.entries(BATTLE_SPEED_UNLOCKS).map(([value,level])=>({value:Number(value),level,unlocked:dojoLevel>=level})) },
      mode: user.idleBattleMode||'progress',
      autoSkills:{enabled:!!user.idleAutoSkills,unlocked:dojoLevel>=AUTO_SKILLS_UNLOCK_LEVEL,level:AUTO_SKILLS_UNLOCK_LEVEL,bonus:.15},
      skills:{burstReadyAt:user.idleBurstReadyAt?.toISOString()||null,teamReadyAt:user.idleTeamReadyAt?.toISOString()||null,burstDamage:burstPreview,teamDamage:teamPreview,uniqueRoles:uniqueActiveRoles,teamWindowSeconds:20+uniqueActiveRoles*5,supportCount:activeSupportCount,cooldownReductionPercent:Math.round((1-activeSkillCooldown(ULTIMATE_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel,blessingEffects.cooldown,passiveCooldownBonus)/ULTIMATE_COOLDOWN_MS)*100),burstBaseCooldownSeconds:ULTIMATE_COOLDOWN_MS/1000,teamBaseCooldownSeconds:TEAM_COMBO_COOLDOWN_MS/1000,burstCooldownSeconds:Math.round(activeSkillCooldown(ULTIMATE_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel,blessingEffects.cooldown,passiveCooldownBonus)/1000),teamCooldownSeconds:Math.round(activeSkillCooldown(TEAM_COMBO_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel,blessingEffects.cooldown,passiveCooldownBonus)/1000)},
    },
    missions,
    codex: { discovered: recruitCount, masteries, collection: seriesCollection, catalogTotal, completion:{completed:completedSeries,perSeriesBonus:SERIES_COMPLETION_BONUS,sealsPerSeries:SERIES_COMPLETION_SEALS,multiplier:completedSeriesMultiplier(completedSeries)}, worlds: Array.from({length:Math.max(DOJO_DECOR.length,Math.floor((Math.max(user.idleBestStage||1,stage)-1)/10)+1)},(_,i)=>{const level=i*10+1;const world=campaignForStage(level);return {name:world.name,level,act:world.act,difficulty:world.difficulty.name,discovered:Math.max(user.idleBestStage||1,stage)>=level};}) },
    event: { ...currentIdleEvent(), weekly: { ...weeklyConvergence(missionCounters,periods), claimed: weeklyClaimed } },
    rift,
    achievements,
    achievementsBonus,
    guide:{items:guide,completed:guide.filter((x)=>x.done).length,total:guide.length,next:guide.find((x)=>!x.done)||null},
    // La première vraie saison utilisera une progression dédiée. L'ancien
    // pass mensuel fondé sur le niveau à vie est volontairement masqué.
    season:{enabled:true,period:seasonPeriod,name:seasonName,level:seasonActivity.score,breakdown:seasonActivity.breakdown,endsAt:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString(),tiers:SEASON_TIERS.map((x)=>({...x,completed:seasonActivity.score>=x.level,claimed:seasonClaimed.has(`season_tier_${x.tier}`)}))},
    challenges,
    prod: {
      level: user.idleProdLevel,
      multiplier: prodMultiplier(user.idleProdLevel, prodAncientBonus),
      nextMultiplier: user.idleProdLevel < PROD_LEVEL_MAX ? prodMultiplier(user.idleProdLevel+1,prodAncientBonus) : null,
      nextCost: user.idleProdLevel < PROD_LEVEL_MAX ? prodUpgradeCost(user.idleProdLevel) : null,
      bulkCosts: bulkUpgradeCosts(user.idleProdLevel, PROD_LEVEL_MAX, prodUpgradeCost),
      maxed: user.idleProdLevel >= PROD_LEVEL_MAX,
    },
    click: {
      level: user.idleClickLevel,
      yield: clickBase,
      damage: clickDamage,
      nextDamage: user.idleClickLevel < CLICK_LEVEL_MAX ? Math.max(clickDamage+1,Math.round((clickYield(user.idleClickLevel+1,clickAncientBonus)+totalRate*CLICK_RATE_SHARE)*heroClass(user.idleHeroClass).click*(heroSpec(user.idleHeroClass,user.idleHeroSpec).click||1)*currentIdleEvent().click*worldClick*buffClick*mechanicMultiplier*blessingEffects.click)) : null,
      nextCost: user.idleClickLevel < CLICK_LEVEL_MAX ? clickUpgradeCost(user.idleClickLevel) : null,
      bulkCosts: bulkUpgradeCosts(user.idleClickLevel, CLICK_LEVEL_MAX, clickUpgradeCost),
      maxed: user.idleClickLevel >= CLICK_LEVEL_MAX,
    },
    crit: {
      level:user.idleCritLevel||0,
      chance:critChance,
      nextChance:user.idleCritLevel<CRIT_LEVEL_MAX?Math.min(.95,critChance+critUpgradeBonus(1)):null,
      nextCost:user.idleCritLevel<CRIT_LEVEL_MAX?critUpgradeCost(user.idleCritLevel):null,
      bulkCosts: bulkUpgradeCosts(user.idleCritLevel||0, CRIT_LEVEL_MAX, critUpgradeCost),
      maxed:user.idleCritLevel>=CRIT_LEVEL_MAX,
    },
    cooldown: {
      level:user.idleCooldownLevel||0,
      reduction:cooldownUpgradeBonus(user.idleCooldownLevel),
      nextReduction:user.idleCooldownLevel<COOLDOWN_LEVEL_MAX?cooldownUpgradeBonus(user.idleCooldownLevel+1):null,
      burstSeconds:Math.round(activeSkillCooldown(ULTIMATE_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel,blessingEffects.cooldown,passiveCooldownBonus)/1000),
      nextBurstSeconds:user.idleCooldownLevel<COOLDOWN_LEVEL_MAX?Math.round(activeSkillCooldown(ULTIMATE_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel+1,blessingEffects.cooldown,passiveCooldownBonus)/1000):null,
      teamSeconds:Math.round(activeSkillCooldown(TEAM_COMBO_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel,blessingEffects.cooldown,passiveCooldownBonus)/1000),
      nextTeamSeconds:user.idleCooldownLevel<COOLDOWN_LEVEL_MAX?Math.round(activeSkillCooldown(TEAM_COMBO_COOLDOWN_MS,activeSupportCount,user.idleCooldownLevel+1,blessingEffects.cooldown,passiveCooldownBonus)/1000):null,
      nextCost:user.idleCooldownLevel<COOLDOWN_LEVEL_MAX?cooldownUpgradeCost(user.idleCooldownLevel):null,
      bulkCosts: bulkUpgradeCosts(user.idleCooldownLevel||0, COOLDOWN_LEVEL_MAX, cooldownUpgradeCost),
      maxed:user.idleCooldownLevel>=COOLDOWN_LEVEL_MAX,
    },
    multiStrike: {
      level:user.idleMultiStrikeLevel||0,
      bonus:multiStrikeBonus(user.idleMultiStrikeLevel||0),
      nextBonus:user.idleMultiStrikeLevel<MULTI_STRIKE_MAX?multiStrikeBonus((user.idleMultiStrikeLevel||0)+1):null,
      nextCost:user.idleMultiStrikeLevel<MULTI_STRIKE_MAX?multiStrikeUpgradeCost(user.idleMultiStrikeLevel||0):null,
      bulkCosts: bulkUpgradeCosts(user.idleMultiStrikeLevel||0, MULTI_STRIKE_MAX, multiStrikeUpgradeCost),
      maxed:user.idleMultiStrikeLevel>=MULTI_STRIKE_MAX,
    },
    ancients: {
      points: user.wisdomPoints,
      branches: ANCIENT_BRANCHES,
      items: ANCIENTS.map((a) => {
        const level = ancientLevelsByKey.get(a.key) || 0;
        const unlocked = !a.requires || (ancientLevelsByKey.get(a.requires) || 0) > 0;
        return { key: a.key, name: a.name, icon: a.icon, kind: a.kind, level, effectPerLevel: a.effectPerLevel, cost: ancientCost(level), branch: a.branch, tier: a.tier, requires: a.requires, unlocked };
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
        reward: milestoneTier > user.idleMilestoneClaimed ? Array.from({length:milestoneTier-user.idleMilestoneClaimed},(_,i)=>milestoneReward(user.idleMilestoneClaimed+i+1)).reduce((a,b)=>a+b,0) : null,
      },
      // Le multiplicateur plat automatique a disparu : la Sagesse gagnée au
      // Prestige (cf. bloc `ancients` ci-dessus, `points`) se dépense
      // maintenant volontairement dans les Ancients.
      prestige: {
        level: user.prestigeLevel,
        minLevel: PRESTIGE_MIN_DOJO_LEVEL,
        minStage: prestigeRequiredStage(user.prestigeLevel),
        runBestStage: user.idleRunBestStage || 1,
        reward: wisdomForRunStage(user.idleRunBestStage || 1, user.prestigeLevel),
        minRunMs:prestigeMinimumRunMs(user.prestigeLevel),runStartedAt:(user.idleRunStartedAt||user.createdAt||new Date()).toISOString(),runElapsedMs:Math.max(0,Date.now()-new Date(user.idleRunStartedAt||user.createdAt||Date.now()).getTime()),
        eligible: (user.idleRunBestStage || 1) >= prestigeRequiredStage(user.prestigeLevel)&&Date.now()-new Date(user.idleRunStartedAt||user.createdAt||Date.now()).getTime()>=prestigeMinimumRunMs(user.prestigeLevel),
        preview:{
          reset:[
            {key:'essence',label:'Essence disponible',before:safeIdleNumber(user.essence),after:0},
            {key:'stage',label:'Stage et record de la run',before:user.idleRunBestStage||1,after:1},
            {key:'training',label:'Niveaux et Ascensions des héros',before:'Niveaux et Ascensions actuels',after:'Niveau 1 · A0'},
            {key:'team',label:'Équipe et emplacements',before:`${user.idleSlotsUnlocked}/${MAX_SLOTS} débloqués`,after:`${START_SLOTS}/${MAX_SLOTS}, formation conservée`},
            {key:'upgrades',label:'Niveaux des améliorations',before:`Niv. ${user.idleProdLevel||0} · ${user.idleClickLevel||0} · ${user.idleCritLevel||0} · ${user.idleCooldownLevel||0} · ${user.idleMultiStrikeLevel||0}`,after:`Discipline et Concentration niv. ${prestigeStartingLevels((user.prestigeLevel||0)+1)} offerts (Mémoire du Maître), le reste au niveau 0`},
            {key:'blessings',label:'Bénédictions roguelike',before:`${runBlessingKeys.length} pouvoir${runBlessingKeys.length!==1?'s':''} de run`,after:'Toutes retirées'},
          ],
          kept:[
            {key:'rank',label:'Rang et niveau du Dojo',value:`Rang ${user.idleRankLevel||1} · Dojo niv. ${dojoLevel}`},
            {key:'roster',label:'Héros recrutés et étoiles d’Éveil',value:`${recruitCount} héros conservés`},
            {key:'gear',label:'Inventaire et équipements',value:'Tout est conservé'},
            {key:'records',label:'Record permanent et coffres',value:`Stage ${Math.max(user.idleBestStage||1,stage)} · coffres conservés`},
            {key:'permanent',label:'Sagesse, Ancients et Sceaux',value:`${safeIdleNumber(user.wisdomPoints)} + ${wisdomForRunStage(user.idleRunBestStage||1,user.prestigeLevel)} Sagesse`},
          ],
          note:'Les recharges de l’Ultime et du Combo sont aussi annulées. La production en attente est comptabilisée dans l’XP permanente du Dojo avant la remise à zéro.',
        },
        startingLevels:prestigeStartingLevels((user.prestigeLevel||0)+1),milestone:user.idlePrestigeMilestone||0,
      },
    },
  };
}

// Diagnostic admin : exécute buildState et renvoie l'erreur EXACTE (message +
// stack) au lieu du 500 générique — pour localiser en prod un throw dans la
// construction de l'état sans accès direct aux logs.
router.get('/diagnostics/state', requireAuth, requireAdmin, async (req, res) => {
  try {
    const state = await buildState(req.user.id);
    res.json({ ok: true, hasState: !!state, keys: state ? Object.keys(state) : [] });
  } catch (e) {
    console.error('diagnostics/state:', e?.stack || e);
    res.json({ ok: false, name: e?.name || null, code: e?.code || null, message: e?.message || String(e), stack: String(e?.stack || '').split('\n').slice(0, 12) });
  }
});

// Le diagnostic reste administrateur ; le jeu est accessible aux admins et aux
// joueurs portant `idle_beta`. Retirer requireIdleBeta à la sortie publique.
router.get('/diagnostics/simulation',requireAuth,requireAdmin,(req,res)=>{
  const bosses=Array.from({length:10},(_,i)=>(i+1)*10).map((stage)=>({stage,hp:enemyMaxHp(stage),requiredDps:enemyMaxHp(stage)/BOSS_TIMER_SECONDS,reward:enemyReward(stage)}));
  const heroCurves=Object.keys(RARITY_RATE).filter((r)=>r!=='common').map((rarity)=>({rarity,levels:Object.fromEntries([1,10,25,50,100].map((level)=>[level,slotRate(rarity,level)]))}));
  res.json({bossTimerSeconds:BOSS_TIMER_SECONDS,prestigeStage:PRESTIGE_MIN_STAGE,bosses,heroCurves});
});
router.get('/state', requireAuth, requireIdleBeta, async (req, res) => {
  const state = await buildState(req.user.id);
  if (!state) return res.status(404).json({ error: 'Compte introuvable' });
  res.json(state);
});

router.post('/rank/advance', requireAuth, requireIdleBeta, rateLimit({ max: 10, name: 'idle-rank' }), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where:{id:req.user.id} });
      if (!user) throw new IdleError(404, 'Compte introuvable');
      const series = rankQuestSeries({ level:user.idleRankLevel, kills:user.idleRankKills, clicks:user.idleRankClicks, upgrades:user.idleRankUpgrades, bosses:user.idleRankBosses });
      if (!series.ready) throw new IdleError(400, 'Termine tous les objectifs avant de passer au niveau suivant');
      const updated = await tx.user.updateMany({
        where:{
          id:user.id,idleRankLevel:series.level,
          idleRankKills:user.idleRankKills,idleRankClicks:user.idleRankClicks,
          idleRankUpgrades:user.idleRankUpgrades,idleRankBosses:user.idleRankBosses,
        },
        data:{
          idleRankLevel:{increment:1}, idleRankKills:0, idleRankClicks:0,
          idleRankUpgrades:0, idleRankBosses:0, idleRankStartedAt:new Date(),
          idleSeals:{increment:series.sealReward},
        },
      });
      if (!updated.count) throw new IdleError(409, 'Ce niveau a déjà été validé');
      return { level:series.nextLevel, seals:series.sealReward };
    });
    void recordIdleEvent(req.user.id, 'rank_advance', { value:result.level });
    res.json({ ...result, state:await buildState(req.user.id) });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error:e.message });
    throw e;
  }
});

router.post('/onboarding', requireAuth, requireIdleBeta, rateLimit({ max: 10, name:'idle-onboarding' }), async(req,res)=>{
  const classKey=String(req.body?.classKey||'');
  const characterId=Number(req.body?.characterId);
  if(!HERO_CLASSES[classKey])return res.status(400).json({error:'Classe invalide'});
  if(!Number.isInteger(characterId))return res.status(400).json({error:'Personnage invalide'});
  try {
    await withIdleUserLock(req.user.id, async()=>{
      const [user,recruitCount]=await Promise.all([
        prisma.user.findUnique({where:{id:req.user.id},select:{idleOnboardingComplete:true}}),
        prisma.dojoRecruit.count({where:{userId:req.user.id}}),
      ]);
      if(!user)throw new IdleError(404,'Compte introuvable');
      if(user.idleOnboardingComplete&&recruitCount>0)throw new IdleError(409,'Ton aventure a déjà commencé');
      // Le choix doit appartenir à la vitrine réellement proposée (top 6
      // populaires) — l'ancienne validation acceptait N'IMPORTE quel rare du
      // catalogue, il suffisait de forger la requête.
      const pool=await starterChoicePool();
      if(!pool.some((starter)=>starter.id===characterId))throw new IdleError(400,'Ce personnage de départ n’est pas disponible');
      await prisma.$transaction(async(tx)=>{
        await tx.dojoRecruit.upsert({
          where:{userId_characterId:{userId:req.user.id,characterId}},
          update:{},create:{userId:req.user.id,characterId},
        });
        await tx.idleSlot.upsert({
          where:{userId_slotIndex:{userId:req.user.id,slotIndex:0}},
          update:{characterId,assignedAt:new Date(),level:1,ascension:0},
          create:{userId:req.user.id,slotIndex:0,characterId,assignedAt:new Date(),level:1,ascension:0},
        });
        await tx.user.update({where:{id:req.user.id},data:{idleHeroClass:classKey,idleHeroSpec:'none',idleHeroClassChangedAt:null,idleOnboardingComplete:true}});
      });
    });
    res.json(await buildState(req.user.id));
  } catch(e) { if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e; }
});

router.get('/leaderboard', requireAuth, requireIdleBeta, async(req,res)=>{
  const users=await prisma.user.findMany({where:{idleBestStage:{gt:1}},select:{id:true,displayName:true,avatarUrl:true,essenceEarnedTotal:true,idleBestStage:true,idleRankLevel:true,prestigeLevel:true,idleHeroClass:true},orderBy:[{idleRankLevel:'desc'},{idleBestStage:'desc'},{updatedAt:'asc'}],take:50});
  res.json({players:users.map((u,i)=>({rank:i+1,id:u.id,name:u.displayName,avatarUrl:u.avatarUrl,progression:u.essenceEarnedTotal,stage:u.idleBestStage,level:u.idleRankLevel||1,prestige:u.prestigeLevel,className:heroClass(u.idleHeroClass).name,isMe:u.id===req.user.id}))});
});

// Roster du joueur (personnages recrutés) — pour le sélecteur d'assignation.
// Totalement indépendant de /api/gacha/collection.
router.get('/roster', requireAuth, requireIdleBeta, async (req, res) => {
  const recruits = await prisma.dojoRecruit.findMany({
    where: { userId: req.user.id },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } } },
    orderBy: { recruitedAt: 'desc' },
  });
  res.json({
    recruits: recruits.map((r) => ({
      id: r.character.id, name: r.character.name, imageUrl: r.character.imageUrl, rarity: r.character.rarity, series:r.character.series, recruitedAt:r.recruitedAt,
      level:r.trainingLevel||1,rate:slotRate(r.character.rarity,r.trainingLevel||1)*(r.awakened?AWAKENED_BONUS:1),baseRate:RARITY_RATE[r.character.rarity]||0,scaling:RARITY_LEVEL_BONUS[r.character.rarity]||0,passive:characterPassiveDescription(r.character,r.character.rarity),passiveUnlocked:(r.trainingLevel||1)>=10,talent:characterTalent(r.character),role:roleForCharacter(r.character),combatSkill:characterCombatSkill(r.character),leaderSkill:characterLeaderSkill(r.character),awakened:!!r.awakened,
    })),
  });
});

router.post('/collect', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  try {
    await withSettle(req.user.id, null);
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

// Recrute un personnage au hasard (pondéré par rareté, cf. RECRUIT_WEIGHTS)
// avec 1 Sceau ou de l'Essence — la SEULE façon d'obtenir un personnage dans le Dojo.
// Exclut les personnages déjà recrutés par ce joueur ; si la rareté tirée est
// épuisée (tout recruté), retombe sur les autres raretés dans l'ordre.
router.post('/recruit', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  const currency = String(req.body?.currency || 'seals');
  if (!['seals', 'essence'].includes(currency)) return res.status(400).json({ error: 'Devise de recrutement invalide' });
  let result;
  let recruiterName='Un joueur';
  let paymentCost = 0;
  try {
    await withSettle(req.user.id, async (tx, user, ancientLevelsByKey) => {
      recruiterName=user.displayName||recruiterName;
      const discount = ancientBonus(ancientLevelsByKey, 'recruitDiscount');
      const cost = currency === 'essence' ? recruitEssenceCost(user.idleEssenceRecruitCount, discount) : recruitCost();
      paymentCost = cost;
      if (currency === 'essence' ? (user.essence||0) < cost : (user.idleSeals||0) < cost) {
        throw new IdleError(400, currency === 'essence' ? 'Essence insuffisante' : 'Sceaux insuffisants');
      }
      const already = (await tx.dojoRecruit.findMany({ where: { userId: user.id }, select: { characterId: true } })).map((r) => r.characterId);
      const pity = user.idleRecruitPity || 0;
      const rolled = pity >= 9 ? (Math.random() < .06 ? 'mythic' : Math.random() < .32 ? 'legendary' : 'epic') : rollRecruitRarity(ancientBonus(ancientLevelsByKey, 'recruitLuck'));
      let pool = await tx.character.findMany({ where: { rarity: rolled, id: { notIn: already } }, select: { id: true, name: true, imageUrl: true, rarity: true, series: true } });
      if (!pool.length) {
        const fallbackRarities = pity >= 9
          ? ['epic', 'legendary', 'mythic', 'rare']
          : ['rare', 'epic', 'legendary', 'mythic'];
        for (const r of fallbackRarities) {
          pool = await tx.character.findMany({ where: { rarity: r, id: { notIn: already } }, select: { id: true, name: true, imageUrl: true, rarity: true, series: true } });
          if (pool.length) break;
        }
      }
      if (!pool.length) throw new IdleError(400, 'Tu as déjà recruté tout le roster disponible !');
      const picked = pool[Math.floor(Math.random() * pool.length)];
      // Recrue « Éveillée » (shiny) : rare, dorée, +10% de production personnelle.
      const awakened = Math.random() < AWAKENED_CHANCE;
      const pityUpdate = ['epic', 'legendary', 'mythic'].includes(picked.rarity) ? 0 : { increment: 1 };
      if (currency === 'essence') {
        const debit = await tx.user.updateMany({ where: { id: user.id, essence: { gte: cost } }, data: { essence: { decrement: cost }, idleRecruitPity: pityUpdate, idleEssenceRecruitCount:{increment:1} } });
        if (!debit.count) throw new IdleError(400, 'Essence insuffisante');
      } else {
        // Même garde que la branche Essence ci-dessus : sans elle, deux requêtes
        // quasi simultanées avec un seul Sceau en poche décrémentaient chacune
        // sans se voir, livrant deux recrues pour un solde passant en négatif.
        const debit = await tx.user.updateMany({ where: { id: user.id, idleSeals: { gte: cost } }, data: { idleSeals: { decrement: cost }, idleRecruitPity: pityUpdate } });
        if (!debit.count) throw new IdleError(400, 'Sceaux insuffisants');
      }
      try {
        await tx.dojoRecruit.create({ data: { userId: user.id, characterId: picked.id, awakened } });
      } catch (e) {
        // Fenêtre de migration (colonne absente) : on ne perd pas le paiement,
        // la recrue est créée sans éveil.
        if (e?.code !== 'P2002') await tx.dojoRecruit.create({ data: { userId: user.id, characterId: picked.id } });
        else throw e;
      }
      result = { ...picked, awakened };
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error:'Ce personnage est déjà assigné dans un autre emplacement' });
    throw e;
  }
  // `recruited` (le personnage tout juste obtenu) est distinct de `recruit`
  // (compteur/coût du prochain) déjà renvoyé par buildState() — le spread
  // doit passer EN PREMIER, sinon il écraserait `recruited` s'il portait le
  // même nom.
  res.json({ ...(await buildState(req.user.id)), payment:{currency,cost:paymentCost}, recruited: { ...result, talent: characterTalent(result), role:roleForCharacter(result),leaderSkill:characterLeaderSkill(result),baseRate:slotRate(result.rarity,1) } });
  if(['legendary','mythic'].includes(result.rarity)){
    const label=result.rarity==='mythic'?'MYTHIQUE':'LÉGENDAIRE';
    publishGlobalChatSystem({type:'recruit',rarity:result.rarity,player:recruiterName,character:result.name,text:`${recruiterName} a recruté ${result.name} · ${label}`});
  }
  void recordIdleEvent(req.user.id,'recruit',{value:1});
  void incrementIdleCounter(req.user.id,'recruit',1);
});

router.post('/assign', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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
      // Le niveau d'entraînement appartient au personnage recruté. IdleSlot en
      // garde une copie active pour les calculs, restaurée depuis DojoRecruit à
      // chaque réaffectation afin d'éviter tout héritage entre personnages.
      // No-op si c'est déjà le même personnage (évite de punir un clic redondant).
      // Déplace le personnage s'il était déjà assigné ailleurs (1 seul emplacement à la fois).
      await tx.idleSlot.updateMany({
        where: { userId: user.id, characterId, slotIndex: { not: slotIndex } },
        data: { characterId: null, assignedAt: null },
      });
      await tx.idleSlot.upsert({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        update: { characterId, assignedAt: new Date(), level:recruited.trainingLevel||1,ascension:recruited.idleAscension||0 },
        create: { userId: user.id, slotIndex, characterId, assignedAt: new Date(),level:recruited.trainingLevel||1,ascension:recruited.idleAscension||0 },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await buildState(req.user.id));
});

router.post('/unassign', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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

// Aperçu (lecture seule, pour buildState) du coût des lots ×5/×10/×100 d'une
// amélioration plafonnée — même esprit que `levelCosts` sur les héros
// (charLevelBulkCost), pour que le client affiche le prix exact avant achat.
// `count` peut être < n si le plafond de niveau est atteint avant le lot entier.
function bulkUpgradeCosts(level, maxLevel, costFn) {
  const current = level || 0;
  const remaining = Math.max(0, maxLevel - current);
  const out = {};
  for (const n of [5, 10, 100]) {
    const count = Math.min(n, remaining);
    if (!count) { out[n] = null; continue; }
    let total = 0;
    for (let i = 0; i < count; i++) total += costFn(current + i);
    out[n] = { count, cost: total };
  }
  return out;
}

// Achète jusqu'à `amount` niveaux d'une amélioration plafonnée d'un coup —
// même contrat que charLevelBulkCost (héros) : quantité fixe (1/5/10/100) =
// tout ou rien au prix exact ; 'max' = autant que le budget permet, borné au
// plafond de niveau. Clampe silencieusement sur le plafond plutôt que de
// refuser un achat qui aurait de toute façon atteint le maximum.
function buyBulkUpgrade(user, { level, maxLevel, costFn, amount }) {
  const current = level || 0;
  if (current >= maxLevel) throw new IdleError(400, 'Niveau maximum atteint');
  if (amount === 'max') {
    let total = 0, bought = 0;
    while (current + bought < maxLevel) {
      const next = costFn(current + bought);
      if (total + next > user.essence) break;
      total += next; bought++;
    }
    if (!bought) throw new IdleError(400, 'Essence insuffisante');
    return { bought, total: safeIdleNumber(total) };
  }
  const count = Math.min(amount, Math.max(0, maxLevel - current));
  let total = 0;
  for (let i = 0; i < count; i++) total += costFn(current + i);
  if (user.essence < total) throw new IdleError(400, 'Essence insuffisante');
  return { bought: count, total: safeIdleNumber(total) };
}

router.post('/upgrade', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  const type = req.body?.type;
  if (!['prod', 'click', 'slot', 'crit', 'cooldown', 'multistrike'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
  const requestedAmount = req.body?.amount;
  const amount = type === 'slot' ? 1 : (requestedAmount === 'max' ? 'max' : Number(requestedAmount || 1));
  if (type !== 'slot' && amount !== 'max' && ![1, 5, 10, 100].includes(amount)) return res.status(400).json({ error: 'Quantité invalide' });

  let purchasedLevels = 1;
  try {
    await withSettle(req.user.id, async (tx, user) => {
      if (type === 'prod') {
        const { bought, total } = buyBulkUpgrade(user, { level: user.idleProdLevel, maxLevel: PROD_LEVEL_MAX, costFn: prodUpgradeCost, amount });
        purchasedLevels = bought;
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: total }, idleProdLevel: { increment: bought } } });
      } else if (type === 'click') {
        const { bought, total } = buyBulkUpgrade(user, { level: user.idleClickLevel, maxLevel: CLICK_LEVEL_MAX, costFn: clickUpgradeCost, amount });
        purchasedLevels = bought;
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: total }, idleClickLevel: { increment: bought } } });
      } else if (type === 'crit') {
        const { bought, total } = buyBulkUpgrade(user, { level: user.idleCritLevel || 0, maxLevel: CRIT_LEVEL_MAX, costFn: critUpgradeCost, amount });
        purchasedLevels = bought;
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: total }, idleCritLevel: { increment: bought } } });
      } else if (type === 'cooldown') {
        const { bought, total } = buyBulkUpgrade(user, { level: user.idleCooldownLevel || 0, maxLevel: COOLDOWN_LEVEL_MAX, costFn: cooldownUpgradeCost, amount });
        purchasedLevels = bought;
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: total }, idleCooldownLevel: { increment: bought } } });
      } else if (type === 'multistrike') {
        const { bought, total } = buyBulkUpgrade(user, { level: user.idleMultiStrikeLevel || 0, maxLevel: MULTI_STRIKE_MAX, costFn: multiStrikeUpgradeCost, amount });
        purchasedLevels = bought;
        await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: total }, idleMultiStrikeLevel: { increment: bought } } });
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
  await incrementIdleCounter(req.user.id,'upgrade',purchasedLevels);
  res.json(await buildState(req.user.id));
});

// Monte le niveau d'entraînement (illimité) du personnage assigné à un
// emplacement, remis à 1 si on change de personnage sur cet emplacement
// (cf. commentaire IdleSlot.level).
router.post('/slot-level', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  const requestedAmount=req.body?.amount;let amount=requestedAmount==='max'?'max':Number(requestedAmount||1);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) {
    return res.status(400).json({ error: 'Emplacement invalide' });
  }
  if (amount!=='max'&&![1, 5, 10, 100].includes(amount)) return res.status(400).json({ error: 'Quantité invalide' });
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const slot = await tx.idleSlot.findUnique({
        where: { userId_slotIndex: { userId: user.id, slotIndex } },
        include: { character: { select: { rarity: true } } },
      });
      if (!slot || !slot.characterId || !slot.character) throw new IdleError(400, 'Cet emplacement est vide');
      if(amount==='max'){
        amount=0;let budget=user.essence,total=0;
        while(amount<1000){const next=charLevelUpCost(slot.character.rarity,(slot.level||1)+amount);if(total+next>budget)break;total+=next;amount++;}
        if(!amount)throw new IdleError(400,'Essence insuffisante');
      }
      const cost = charLevelBulkCost(slot.character.rarity, slot.level || 1, amount);
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { level: { increment: amount } } });
      await tx.dojoRecruit.update({where:{userId_characterId:{userId:user.id,characterId:slot.characterId}},data:{trainingLevel:{increment:amount}}});
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  await incrementIdleCounter(req.user.id,'upgrade',amount);
  res.json(await buildState(req.user.id));
});

router.post('/slot-ascend', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-ascend' }), async (req, res) => {
  const slotIndex = Number(req.body?.slotIndex);
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOTS) return res.status(400).json({ error: 'Emplacement invalide' });
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const slot = await tx.idleSlot.findUnique({ where: { userId_slotIndex: { userId: user.id, slotIndex } }, include: { character: { select: { rarity: true } } } });
      if (!slot?.character) throw new IdleError(400, 'Emplacement vide');
      const requiredLevel = heroAscensionRequiredLevel(slot.ascension);
      if ((slot.level || 1) < requiredLevel) throw new IdleError(400, `Niveau ${requiredLevel} requis`);
      if ((slot.ascension || 0) >= HERO_ASCENSION_MAX) throw new IdleError(400, 'Ascension maximale atteinte');
      const cost = heroAscensionCost(slot.character.rarity, slot.ascension);
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { ascension: { increment: 1 } } });
      await tx.dojoRecruit.update({where:{userId_characterId:{userId:user.id,characterId:slot.characterId}},data:{idleAscension:{increment:1}}});
    });
    await incrementIdleCounter(req.user.id,'upgrade',1);
    res.json(await buildState(req.user.id));
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// Étoile d'Éveil : investissement PERMANENT par héros, payé en Sceaux (le
// deuxième usage des Sceaux après l'invocation). +8% de production
// personnelle par étoile, conservé au Prestige comme le roster — l'éveil
// progressif d'un favori, façon Summoners War.
router.post('/hero-awaken', requireAuth, requireIdleBeta, rateLimit({ max: 30, name: 'idle-awaken' }), async (req, res) => {
  const characterId = Number(req.body?.characterId);
  if (!Number.isInteger(characterId)) return res.status(400).json({ error: 'Personnage invalide' });
  let stars = 0, cost = 0;
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const recruit = await tx.dojoRecruit.findUnique({ where: { userId_characterId: { userId: user.id, characterId } } });
      if (!recruit) throw new IdleError(400, "Tu n'as pas recruté ce personnage");
      if ((recruit.awakenStars || 0) >= AWAKEN_STAR_MAX) throw new IdleError(400, 'Éveil maximal atteint');
      cost = awakenStarCost(recruit.awakenStars);
      // Garde optimiste sur le solde ET le nombre d'étoiles : deux requêtes
      // simultanées ne peuvent ni payer deux fois ni sauter une étoile.
      const debit = await tx.user.updateMany({ where: { id: user.id, idleSeals: { gte: cost } }, data: { idleSeals: { decrement: cost } } });
      if (!debit.count) throw new IdleError(400, 'Sceaux insuffisants');
      const upgraded = await tx.dojoRecruit.updateMany({
        where: { userId: user.id, characterId, awakenStars: recruit.awakenStars || 0 },
        data: { awakenStars: { increment: 1 } },
      });
      if (!upgraded.count) throw new IdleError(409, 'Éveil déjà en cours, réessaie');
      stars = (recruit.awakenStars || 0) + 1;
    });
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
  void recordIdleEvent(req.user.id, 'hero_awaken', { value: stars });
  res.json({ ...(await buildState(req.user.id)), awaken: { characterId, stars, cost, multiplier: awakenStarMultiplier(stars) } });
});

// Remplissage automatique de l'équipe — VOLONTAIREMENT simple. L'ancienne
// version (beam search sur computeTotalRate) trouvait la composition
// quasi-optimale en un clic : synergies, formations et rôles n'étaient plus
// des choix, le theorycraft n'avait aucun intérêt. Désormais : ne touche
// JAMAIS aux héros déjà assignés, remplit seulement les emplacements vides
// avec les recrues libres les plus entraînées (niveau, puis rareté, puis
// éveil) — un remplissage « pas débile », pas une optimisation.
router.post('/optimize-team', requireAuth, requireIdleBeta, rateLimit({ max: 10, name: 'idle-optimize' }), async (req, res) => {
  let optimization={placed:0,changed:0,selected:[]};
  try {
    await withSettle(req.user.id,async(tx,user)=>{
      const [loadedSlots,recruits]=await Promise.all([loadSlots(tx,user.id),tx.dojoRecruit.findMany({where:{userId:user.id},include:{character:{select:{id:true,name:true,rarity:true}}}})]);
      if(!recruits.length)throw new IdleError(400,'Aucun héros recruté');
      const unlocked=Math.max(1,Math.min(MAX_SLOTS,user.idleSlotsUnlocked||1));
      const assignedIds=new Set(loadedSlots.filter((slot)=>slot.characterId).map((slot)=>slot.characterId));
      const emptySlots=Array.from({length:unlocked},(_,slotIndex)=>slotIndex).filter((slotIndex)=>{const slot=loadedSlots.find((s)=>s.slotIndex===slotIndex);return !slot||!slot.characterId;});
      if(!emptySlots.length)throw new IdleError(400,'Aucun emplacement vide — compose ton équipe toi-même pour optimiser');
      const rarityOrder={rare:1,epic:2,legendary:3,mythic:4};
      const available=recruits.filter((recruit)=>!assignedIds.has(recruit.characterId))
        .sort((a,b)=>(b.trainingLevel||1)-(a.trainingLevel||1)||(rarityOrder[b.character?.rarity]||0)-(rarityOrder[a.character?.rarity]||0)||(b.awakenStars||0)-(a.awakenStars||0)||Number(b.awakened)-Number(a.awakened));
      const picks=available.slice(0,emptySlots.length);
      if(!picks.length)throw new IdleError(400,'Toutes tes recrues sont déjà assignées');
      for(let i=0;i<picks.length;i++){const recruit=picks[i];const slotIndex=emptySlots[i];await tx.idleSlot.upsert({where:{userId_slotIndex:{userId:user.id,slotIndex}},update:{characterId:recruit.characterId,assignedAt:new Date(),level:recruit.trainingLevel||1,ascension:recruit.idleAscension||0},create:{userId:user.id,slotIndex,characterId:recruit.characterId,assignedAt:new Date(),level:recruit.trainingLevel||1,ascension:recruit.idleAscension||0}});}
      optimization={placed:picks.length,changed:picks.length,selected:picks.map((recruit)=>recruit.character.name)};
    });
    void recordIdleEvent(req.user.id,'team_fill',{value:optimization.placed});
    res.json({...(await buildState(req.user.id)),optimization});
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/battle-speed', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-speed' }), async (req,res)=>{
  const speed=Number(req.body?.speed);const required=BATTLE_SPEED_UNLOCKS[speed];if(!required)return res.status(400).json({error:'Vitesse invalide'});
  const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleRankLevel:true}});if((user.idleRankLevel||1)<required)return res.status(403).json({error:`Débloqué au niveau ${required}`});
  await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleBattleSpeed:speed}});});res.json(await buildState(req.user.id));
});
router.post('/battle-mode', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-mode' }), async(req,res)=>{
  const mode=String(req.body?.mode||'');
  if(!['progress','farm'].includes(mode))return res.status(400).json({error:'Mode invalide'});
  if(mode==='farm'&&req.body?.confirmed!==true)return res.status(400).json({error:'Confirme que tu souhaites répéter cette vague sans progresser'});
  await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleBattleMode:mode}});});
  res.json(await buildState(req.user.id));
});
router.post('/formation',requireAuth,requireIdleBeta,rateLimit({max:20,name:'idle-formation'}),async(req,res)=>{const formation=String(req.body?.formation||'');if(!FORMATIONS[formation])return res.status(400).json({error:'Formation invalide'});await withSettle(req.user.id,async(tx,u)=>tx.user.update({where:{id:u.id},data:{idleFormation:formation}}));void recordIdleEvent(req.user.id,'formation_change');res.json(await buildState(req.user.id));});
router.post('/stage',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-stage-select'}),async(req,res)=>{const target=Number(req.body?.stage);if(!Number.isInteger(target)||target<1)return res.status(400).json({error:'Niveau de combat invalide'});try{await withSettle(req.user.id,async(tx,user)=>{const best=Math.max(1,user.idleRunBestStage||1,user.idleStage||1);if(target>best)throw new IdleError(400,`Le niveau ${target} n’est pas encore débloqué`);await tx.user.update({where:{id:user.id},data:{idleStage:target,idleWaveKills:0,idleEnemyHp:enemyUnitMaxHp(target,0),idleBossProgress:0,idleBossStartedAt:null,idleBattleMode:target<best?'farm':'progress'}});});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}void recordIdleEvent(req.user.id,'stage_select',{stage:target});res.json(await buildState(req.user.id));});
router.post('/team-leader',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-team-leader'}),async(req,res)=>{const characterId=Number(req.body?.characterId);if(!Number.isInteger(characterId))return res.status(400).json({error:'Personnage invalide'});try{await withSettle(req.user.id,async(tx,user)=>{const active=await tx.idleSlot.findFirst({where:{userId:user.id,characterId},select:{id:true}});if(!active)throw new IdleError(400,'Ce personnage doit être dans ton équipe');await tx.user.update({where:{id:user.id},data:{idleLeaderCharacterId:characterId}});});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}res.json(await buildState(req.user.id));});

// Choix roguelike tous les 20 stages. Le solde préalable garantit que le DPS
// produit avant le choix est calculé avec l'ancien build, jamais rétroactivement.
router.post('/run-blessing',requireAuth,requireIdleBeta,rateLimit({max:12,name:'idle-run-blessing'}),async(req,res)=>{
  const key=String(req.body?.key||'');
  try{
    await withSettle(req.user.id,async(tx,user)=>{
      const owned=parseRunBlessings(user.idleRunBlessings);const unlocked=Math.min(12,Math.floor((Math.max(user.idleRunBestStage||1,user.idleStage||1)-1)/20));
      // Le déblocage est un simple palier de stage (tous les 20), pas un combat
      // de boss distinct — le message doit refléter la vraie condition
      // (retour testeur : « n'a pas vraiment de sens » avec l'ancien texte).
      if(owned.length>=unlocked)throw new IdleError(400,unlocked>=12?'Toutes les bénédictions de cette run sont déjà choisies':`Aucune bénédiction disponible pour l’instant : la prochaine se débloque au stage ${(unlocked+1)*20+1}`);
      const choices=runBlessingChoices(user.id,user.prestigeLevel,owned.length,owned,user.idleRunBlessingRerolls||0);
      if(!choices.some((item)=>item.key===key))throw new IdleError(400,'Cette bénédiction ne fait pas partie de tes choix');
      // Le prochain choix (s'il y en a un) repart d'un lot non reroll : chaque
      // choix de run a son propre budget de rerolls.
      await tx.user.update({where:{id:user.id},data:{idleRunBlessings:[...owned,key].join(','),idleRunBlessingRerolls:0}});
    });
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void recordIdleEvent(req.user.id,'run_blessing');res.json(await buildState(req.user.id));
});
// Reroll payant des 3 choix proposés (retour testeur : « peut-être offrir la
// possibilité de reroll »). Ne change pas les bénédictions déjà choisies —
// seulement l'offre du choix EN COURS, via le compteur de rerolls inclus
// dans la graine de `runBlessingChoices`.
router.post('/run-blessing/reroll',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-run-blessing-reroll'}),async(req,res)=>{
  try{
    await withSettle(req.user.id,async(tx,user)=>{
      const owned=parseRunBlessings(user.idleRunBlessings);const unlocked=Math.min(12,Math.floor((Math.max(user.idleRunBestStage||1,user.idleStage||1)-1)/20));
      if(owned.length>=unlocked)throw new IdleError(400,unlocked>=12?'Toutes les bénédictions de cette run sont déjà choisies':`Aucune bénédiction disponible pour l’instant : la prochaine se débloque au stage ${(unlocked+1)*20+1}`);
      const cost=runBlessingRerollCost(user.idleRunBlessingRerolls||0);
      if(user.essence<cost)throw new IdleError(400,'Essence insuffisante');
      await tx.user.update({where:{id:user.id},data:{essence:{decrement:cost},idleRunBlessingRerolls:{increment:1}}});
    });
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void recordIdleEvent(req.user.id,'run_blessing_reroll');res.json(await buildState(req.user.id));
});
router.post('/team-preset/save',requireAuth,requireIdleBeta,rateLimit({max:15,name:'idle-preset'}),idleUserLockMiddleware,async(req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,24);if(!name)return res.status(400).json({error:'Nom de squad requis'});
  const [slots,user,presets]=await Promise.all([loadSlots(prisma,req.user.id),prisma.user.findUnique({where:{id:req.user.id},select:{idleFormation:true,prestigeLevel:true,idleRankLevel:true,idleBestStage:true,idleRunBestStage:true,idleStage:true}}),prisma.idleTeamPreset.findMany({where:{userId:req.user.id},select:{name:true,formation:true,slots:true}})]);
  const squadSlots=squadPresetSlots(user,presets);const target=squadSlots.find((slot)=>slot.name===name)||squadSlots.find((slot)=>slot.index===Number(req.body?.slotIndex));
  if(!target)return res.status(400).json({error:'Slot de squad invalide'});
  if(!target.unlocked)return res.status(403).json({error:`${target.name} se débloque avec ${target.unlock.label}`});
  const savedName=target.name;const existing=await prisma.idleTeamPreset.findUnique({where:{userId_name:{userId:req.user.id,name:savedName}}});
  const count=await prisma.idleTeamPreset.count({where:{userId:req.user.id}});
  if(count>=SQUAD_PRESET_LIMIT&&!existing)return res.status(400).json({error:`Maximum de ${SQUAD_PRESET_LIMIT} squads`});
  const squadSlotsData=slots.filter((s)=>s.characterId).map((s)=>({slotIndex:s.slotIndex,characterId:s.characterId}));
  if(new Set(squadSlotsData.map((s)=>s.characterId)).size!==squadSlotsData.length)return res.status(400).json({error:'Un personnage ne peut pas être dupliqué dans la même squad'});
  await prisma.idleTeamPreset.upsert({where:{userId_name:{userId:req.user.id,name:savedName}},update:{slots:squadSlotsData,formation:user.idleFormation},create:{userId:req.user.id,name:savedName,slots:squadSlotsData,formation:user.idleFormation}});
  res.json(await buildState(req.user.id));
});
router.post('/team-preset/load',requireAuth,requireIdleBeta,rateLimit({max:15,name:'idle-preset'}),async(req,res)=>{
  const name=String(req.body?.name||'');const [preset,user,presets]=await Promise.all([prisma.idleTeamPreset.findUnique({where:{userId_name:{userId:req.user.id,name}}}),prisma.user.findUnique({where:{id:req.user.id},select:{prestigeLevel:true,idleRankLevel:true,idleBestStage:true,idleRunBestStage:true,idleStage:true}}),prisma.idleTeamPreset.findMany({where:{userId:req.user.id},select:{name:true,formation:true,slots:true}})]);
  if(!preset)return res.status(404).json({error:'Squad introuvable'});
  const target=squadPresetSlots(user,presets).find((slot)=>slot.name===preset.name);if(target&&!target.unlocked)return res.status(403).json({error:`${target.name} se débloque avec ${target.unlock.label}`});
  await withSettle(req.user.id,async(tx,user)=>{await tx.idleSlot.updateMany({where:{userId:user.id},data:{characterId:null,assignedAt:null,level:1,ascension:0}});const used=new Set();for(const item of Array.isArray(preset.slots)?preset.slots:[]){const slotIndex=Number(item.slotIndex);const characterId=Number(item.characterId);if(!Number.isInteger(slotIndex)||slotIndex<0||slotIndex>=user.idleSlotsUnlocked||!Number.isInteger(characterId)||used.has(characterId))continue;const owned=await tx.dojoRecruit.findUnique({where:{userId_characterId:{userId:user.id,characterId}}});if(owned){used.add(characterId);await tx.idleSlot.upsert({where:{userId_slotIndex:{userId:user.id,slotIndex}},update:{characterId,assignedAt:new Date(),level:owned.trainingLevel||1,ascension:owned.idleAscension||0},create:{userId:user.id,slotIndex,characterId,assignedAt:new Date(),level:owned.trainingLevel||1,ascension:owned.idleAscension||0}});}}await tx.user.update({where:{id:user.id},data:{idleFormation:FORMATIONS[preset.formation]?preset.formation:'balanced'}});});
  void recordIdleEvent(req.user.id,'preset_load');res.json(await buildState(req.user.id));
});
router.post('/auto-skills', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-auto-skills' }), async(req,res)=>{const enabled=!!req.body?.enabled;const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleRankLevel:true}});if((user.idleRankLevel||1)<AUTO_SKILLS_UNLOCK_LEVEL)return res.status(403).json({error:`Compétences automatiques débloquées au Rang ${AUTO_SKILLS_UNLOCK_LEVEL}`});await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleAutoSkills:enabled}});});res.json(await buildState(req.user.id));});

// Identifie l'objet par itemId (comme equip/unequip/salvage), PAS par
// slotIndex+kind : ce dernier résolvait « l'objet actuellement équipé à cet
// endroit » plutôt que l'objet réellement affiché sous le bouton cliqué —
// tout écart entre l'état affiché et l'état serveur (double-clic, un autre
// équipement entre-temps) améliorait alors le mauvais objet (retour testeur :
// « ça upgrade et/ou change qui équipe l'objet, ça dépend du slot »).
router.post('/equipment/enhance', requireAuth, requireIdleBeta, rateLimit({ max: 60, name: 'idle-equipment' }), async(req,res)=>{
  const itemId=String(req.body?.itemId||'');if(!itemId)return res.status(400).json({error:'Objet invalide'});
  const requestedAmount=req.body?.amount;
  const amount=requestedAmount==='max'?'max':Number(requestedAmount||1);
  if(amount!=='max'&&![1,10,100].includes(amount))return res.status(400).json({error:'Quantité invalide'});
  let bought=0;
  try{
    await withSettle(req.user.id,async(tx,user)=>{
      const item=await tx.idleItem.findFirst({where:{id:itemId,userId:user.id}});
      if(!item)throw new IdleError(404,'Objet introuvable');
      if(!item.equippedCharacterId)throw new IdleError(400,'Cet objet doit être équipé pour être amélioré');
      let bonus=item.bonus,total=0,level=Math.max(0,item.enhancementLevel||0),subStats=item.subStats||{};
      if(level>=15)throw new IdleError(400,'Cet objet est déjà au niveau +15');
      const wanted=amount==='max'?15-level:Math.min(amount,15-level);
      const enhanceStage=Math.max(user.idleBestStage||1,user.idleStage||1);
      for(let i=0;i<wanted;i++){const current={...item,enhancementLevel:level};const next=runeEnhanceCost(current,enhanceStage);if(total+next>user.essence)break;total+=next;level++;bonus=Number((bonus+.006+(ITEM_RARITY_ORDER[item.rarity]||1)*.001).toFixed(3));subStats=enhancedRuneSubStats({...item,subStats},level);bought++;}
      if(!bought)throw new IdleError(400,'Essence insuffisante');
      await tx.user.update({where:{id:user.id},data:{essence:{decrement:total}}});
      await tx.idleItem.update({where:{id:item.id},data:{bonus,enhancementLevel:level,subStats}});
    });
    await incrementIdleCounter(req.user.id,'upgrade',bought);
    res.json(await buildState(req.user.id));
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

// Meulage : re-tire la magnitude de l'affixe primaire et des affixes
// secondaires (types conservés) aux valeurs du tier ACTUEL du joueur —
// revalorise les vieux objets et sert de puits d'essence répétable. Le
// résultat peut être meilleur OU moins bon : c'est un pari, comme le
// « grind » de Summoners War, pas une amélioration garantie.
router.post('/equipment/reroll',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-equipment-reroll'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');if(!itemId)return res.status(400).json({error:'Objet invalide'});
  let rerolled=null;
  try{
    await withSettle(req.user.id,async(tx,user)=>{
      const item=await tx.idleItem.findFirst({where:{id:itemId,userId:user.id}});
      if(!item)throw new IdleError(404,'Objet introuvable');
      const bestStage=Math.max(user.idleBestStage||1,user.idleStage||1);
      const cost=runeRerollCost(item,bestStage);
      const debit=await tx.user.updateMany({where:{id:user.id,essence:{gte:cost}},data:{essence:{decrement:cost}}});
      if(!debit.count)throw new IdleError(400,'Essence insuffisante');
      const tier=Math.max(1,Math.floor(bestStage/10));
      const effectValue=rerolledAffixValue(item.effectKey,tier);
      const affixes=(Array.isArray(item.affixes)?item.affixes:[]).map((affix)=>({...affix,effectValue:rerolledAffixValue(affix.effectKey,tier)}));
      await tx.idleItem.update({where:{id:item.id},data:{effectValue,affixes}});
      rerolled={itemId:item.id,cost,before:{effectValue:item.effectValue,affixes:item.affixes},after:{effectValue,affixes}};
    });
    void recordIdleEvent(req.user.id,'rune_reroll');
    res.json({...(await buildState(req.user.id)),reroll:rerolled});
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

// Remplissage automatique de l'équipement — VOLONTAIREMENT simple. L'ancien
// plan (score pondéré par rôle + recherche de panoplies sur plusieurs ordres)
// construisait quasiment le meilleur build possible en un clic : les sets et
// les rôles n'étaient plus des choix. Désormais : ne déséquipe JAMAIS rien,
// comble seulement les emplacements de runes vides des héros actifs avec le
// meilleur objet libre du bon type (rareté puis bonus brut) — sans regarder
// les panoplies ni les rôles. Construire un vrai set reste un travail manuel.
router.post('/equipment/auto-equip',requireAuth,requireIdleBeta,rateLimit({max:10,name:'idle-equipment-auto'}),async(req,res)=>{
  let optimization={changed:0,equipped:0};
  try{
    await withSettle(req.user.id,async()=>{
      const [slots,items]=await Promise.all([loadSlots(prisma,req.user.id),prisma.idleItem.findMany({where:{userId:req.user.id}})]);
      const rarityOrder={rare:1,epic:2,legendary:3,mythic:4};
      const free=items.filter((item)=>!item.equippedCharacterId)
        .sort((a,b)=>(rarityOrder[b.rarity]||0)-(rarityOrder[a.rarity]||0)||itemProductionBonus(b)-itemProductionBonus(a));
      const assignments=[];
      for(const slot of slots.filter((s)=>s.characterId&&s.character)){
        const wornKinds=new Set((slot.items||[]).map((item)=>item.kind));
        for(const kind of RUNE_KINDS){
          if(wornKinds.has(kind))continue;
          const index=free.findIndex((item)=>item.kind===kind);
          if(index<0)continue;
          const [item]=free.splice(index,1);
          assignments.push({itemId:item.id,characterId:slot.characterId});
        }
      }
      optimization={changed:assignments.length,equipped:assignments.length};
      if(!assignments.length)return;
      await prisma.$transaction(async(tx)=>{for(const assignment of assignments)await tx.idleItem.update({where:{id:assignment.itemId},data:{equippedCharacterId:assignment.characterId}});});
    });
    const state=await buildState(req.user.id);res.json({ok:true,optimization,state});
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/equip',requireAuth,requireIdleBeta,rateLimit({max:40,name:'idle-equipment-equip'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');const slotIndex=Number(req.body?.slotIndex);
  if(!itemId||!Number.isInteger(slotIndex))return res.status(400).json({error:'Choix d’équipement invalide'});
  try{await withSettle(req.user.id,async(tx,user)=>{const [item,slot]=await Promise.all([tx.idleItem.findFirst({where:{id:itemId,userId:user.id}}),tx.idleSlot.findUnique({where:{userId_slotIndex:{userId:user.id,slotIndex}}})]);if(!item)throw new IdleError(404,'Objet introuvable');if(!slot?.characterId)throw new IdleError(400,'Ce héros n’est pas assigné');await tx.idleItem.updateMany({where:{userId:user.id,equippedCharacterId:slot.characterId,kind:item.kind,id:{not:item.id}},data:{equippedCharacterId:null}});await tx.idleItem.update({where:{id:item.id},data:{equippedCharacterId:slot.characterId}});});res.json(await buildState(req.user.id));}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/unequip',requireAuth,requireIdleBeta,rateLimit({max:40,name:'idle-equipment-unequip'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');
  try{await withSettle(req.user.id,async(tx,user)=>{const item=await tx.idleItem.findFirst({where:{id:itemId,userId:user.id}});if(!item)throw new IdleError(404,'Objet introuvable');await tx.idleItem.update({where:{id:item.id},data:{equippedCharacterId:null}});});res.json(await buildState(req.user.id));}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/lock',requireAuth,requireIdleBeta,rateLimit({max:60,name:'idle-equipment-lock'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');const locked=!!req.body?.locked;const item=await prisma.idleItem.findFirst({where:{id:itemId,userId:req.user.id}});if(!item)return res.status(404).json({error:'Objet introuvable'});await prisma.idleItem.update({where:{id:item.id},data:{locked}});res.json({ok:true,locked});
});

router.post('/equipment/salvage',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-equipment-salvage'}),idleUserLockMiddleware,async(req,res)=>{
  const ids=[...new Set((Array.isArray(req.body?.ids)?req.body.ids:[req.body?.itemId]).map(String).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({error:'Aucun objet sélectionné'});
  const confirmHighRarity=req.body?.confirmHighRarity===true;
  try{const gained=await prisma.$transaction(async(tx)=>{const salvageUser=await tx.user.findUnique({where:{id:req.user.id},select:{idleBestStage:true,idleStage:true}});const salvageStage=Math.max(salvageUser?.idleBestStage||1,salvageUser?.idleStage||1);const items=await tx.idleItem.findMany({where:{userId:req.user.id,id:{in:ids}}});if(items.length!==ids.length)throw new IdleError(404,'Un objet sélectionné est introuvable');if(items.some((x)=>x.locked))throw new IdleError(400,'Un objet verrouillé est sélectionné');if(items.some((x)=>x.equippedCharacterId))throw new IdleError(400,'Retire les objets équipés avant de les recycler');if(!confirmHighRarity&&items.some((x)=>['legendary','mythic'].includes(x.rarity)))throw new IdleError(400,'Confirmation requise pour recycler un objet légendaire ou mythique');const fortune=await tx.idleItem.findMany({where:{userId:req.user.id,equippedCharacterId:{not:null}},select:{effectKey:true,effectValue:true,affixes:true,setKey:true,equippedCharacterId:true}});const affixMultiplier=1+fortune.flatMap((item)=>itemAffixList(item)).filter((affix)=>ITEM_EFFECTS[affix.effectKey]?.mode==='salvage').reduce((sum,affix)=>sum+Number(affix.effectValue||0),0);const multiplier=affixMultiplier*equipmentSetFlatMultiplier(fortune,'salvage');const amount=Math.round(items.reduce((sum,x)=>sum+itemSalvageValue(x,salvageStage),0)*multiplier);const deleted=await tx.idleItem.deleteMany({where:{userId:req.user.id,id:{in:items.map((x)=>x.id)}}});if(deleted.count!==items.length)throw new IdleError(409,'Ces objets viennent déjà d’être recyclés');if(amount)await tx.user.update({where:{id:req.user.id},data:{essence:{increment:amount},essenceEarnedTotal:{increment:amount}}});return amount;});res.json({ok:true,gained,state:await buildState(req.user.id)});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

// Réclame le coffre du jalon en cours (tous les MILESTONE_INTERVAL niveaux de
// Dojo). Permanent : n'est jamais remis à zéro, y compris après une Prestige.
router.post('/claim-milestone', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const dojoLevel = user.idleRankLevel || 1;
      const tier = milestoneTierForLevel(dojoLevel);
      if (tier <= user.idleMilestoneClaimed) throw new IdleError(400, 'Aucun coffre à réclamer pour l’instant');
      const reward = Array.from({length:tier-user.idleMilestoneClaimed},(_,i)=>milestoneReward(user.idleMilestoneClaimed+i+1)).reduce((a,b)=>a+b,0);
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
// (voir wisdomForRunStage), dépensée ensuite dans les Ancients — plus de
// multiplicateur automatique. Le rang du Dojo (épreuves d'Ascension), le
// roster recruté, les jalons réclamés ET les Ancients déjà achetés sont
// volontairement CONSERVÉS — seule la puissance personnelle (essence,
// emplacements, améliorations) repart à zéro, pas le lieu ni les personnages
// déjà recrutés. Passe par withSettle (comme toutes les autres actions) pour
// que la production en attente soit soldée AVANT le reset : sinon elle
// disparaissait sans même compter dans l'historique économique.
router.post('/prestige', requireAuth, requireIdleBeta, rateLimit({ max: 5, name: 'idle-prestige' }), async (req, res) => {
  let prestigeReward=0,prestigeStage=0,milestoneSeals=0,prestigeLevel=0,prestigePlayer=req.user.displayName||'Un joueur';
  try {
    await withSettle(req.user.id, async (tx, user, ancientLevelsByKey) => {
      const runBestStage = user.idleRunBestStage || 1;
      const requiredStage = prestigeRequiredStage(user.prestigeLevel);
      if (runBestStage < requiredStage) {
        throw new IdleError(400, `Atteins le stage ${requiredStage} pendant cette run avant de prestiger`);
      }
      const minimumRunMs=prestigeMinimumRunMs(user.prestigeLevel);const runElapsedMs=Date.now()-new Date(user.idleRunStartedAt||user.createdAt||Date.now()).getTime();
      if(runElapsedMs<minimumRunMs)throw new IdleError(400,`Cette run doit durer encore ${Math.ceil((minimumRunMs-runElapsedMs)/60000)} min avant le Prestige`);
      prestigeStage=runBestStage;prestigeReward=wisdomForRunStage(runBestStage,user.prestigeLevel);
      const nextPrestige=(user.prestigeLevel||0)+1;prestigeLevel=nextPrestige;prestigePlayer=user.displayName||prestigePlayer;const reached=[{level:1,reward:1},{level:3,reward:2},{level:5,reward:3},{level:10,reward:5}].filter((m)=>m.level>(user.idlePrestigeMilestone||0)&&m.level<=nextPrestige);milestoneSeals=reached.reduce((n,m)=>n+m.reward,0);const lastMilestone=reached.length?reached[reached.length-1].level:(user.idlePrestigeMilestone||0);
      // Ancient « Pas du Conquérant » : la nouvelle run démarre plus loin,
      // borné au meilleur stage jamais atteint (jamais de contenu sauté) et
      // jamais directement sur un boss (stage suivant le cas échéant).
      let startStage = Math.max(1, Math.min(1 + Math.floor(ancientBonus(ancientLevelsByKey, 'startStage')), user.idleBestStage || 1));
      if (isBossStage(startStage)) startStage += 1;
      // Le Prestige recommence la progression de la run, pas la corvée de
      // composition. Les trois premiers héros restent assignés et visibles.
      // Les emplacements qui redeviennent verrouillés sont vidés pour qu'un
      // héros invisible ne continue pas à produire derrière une place fermée.
      await tx.idleSlot.updateMany({
        where: { userId: user.id, slotIndex: { lt: START_SLOTS } },
        data: { level: 1, ascension: 0 },
      });
      await tx.idleSlot.updateMany({
        where: { userId: user.id, slotIndex: { gte: START_SLOTS } },
        data: { characterId: null, assignedAt: null, level: 1, ascension: 0 },
      });
      await tx.dojoRecruit.updateMany({where:{userId:user.id},data:{trainingLevel:1,idleAscension:0}});
      // Mémoire du Maître (fast-start façon Clicker Heroes) : la nouvelle run
      // démarre avec des niveaux gratuits de Discipline et de Concentration
      // (2 par Prestige, plafonné) — chaque Retraite rend la reprise
      // tangiblement plus rapide, sans multiplicateur caché.
      const startingLevels = prestigeStartingLevels(nextPrestige);
      await tx.user.update({
        where: { id: user.id },
        data: {
          essence: 0,
          idleSlotsUnlocked: START_SLOTS,
          idleProdLevel: startingLevels,
          idleClickLevel: startingLevels,
          idleCritLevel: 0,
          idleCooldownLevel: 0,
          idleMultiStrikeLevel: 0,
          idleRunBlessings: '',
          idleRunBlessingRerolls: 0,
          idleRunStartedAt: new Date(),
          idleRunEssenceEarned: 0,
          idleStage: startStage,
          idleWaveKills: 0,
          idleRunBestStage: startStage,
          idleEnemyHp: enemyUnitMaxHp(startStage, 0),
          idleBossProgress: 0,
          idleBossStartedAt: null,
          idleBurstReadyAt: null,
          idleTeamReadyAt: null,
          prestigeLevel: { increment: 1 },
          wisdomPoints: { increment: prestigeReward },
          idleSeals:{increment:milestoneSeals},
          idlePrestigeMilestone:lastMilestone,
          // Le roster est permanent : le compteur des invocations en Essence
          // l'est donc aussi. Le remettre à zéro permettrait de répéter une
          // série de pulls bon marché après chaque Prestige.
        },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  void recordIdleEvent(req.user.id,'prestige',{value:prestigeReward,stage:prestigeStage});
  // `prestige` : bilan de CETTE Retraite (gains + rappel de ce qui est
  // conservé), affiché par la modale de confirmation côté client.
  publishGlobalChatSystem({type:'prestige',player:prestigePlayer,prestigeLevel,stage:prestigeStage,reward:prestigeReward,text:`${prestigePlayer} atteint le Prestige ${prestigeLevel} au stage ${prestigeStage}`});
  res.json({ ...(await buildState(req.user.id)), prestige: { gained: prestigeReward, stage: prestigeStage, seals: milestoneSeals } });
});

// Clic manuel : gain instantané indépendant de la production passive (pas de
// solde de `pending` ici, juste un ajout — évite de perdre de l'essence à
// l'arrondi si le clic est spammé, cf. commentaire de withSettle). Compte
// aussi pour l'XP du Dojo (essenceEarnedTotal).
router.post('/click', requireAuth, requireIdleBeta, rateLimit({ windowMs: 1000, max: 8, name: 'idle-click' }), async (req, res) => {
  const requestId=String(req.body?.requestId||'');if(!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId))return res.status(400).json({error:'Identifiant de frappe invalide'});
  const fresh=await store.setIfAbsent(`idle:click:req:${req.user.id}:${requestId}`,30);if(!fresh)return res.json({duplicate:true,count:0,damage:0,kills:0,criticals:0});
  const requested=Math.min(10,Math.max(1,Number.isInteger(Number(req.body?.count))?Number(req.body.count):1));
  const used=await store.incrBy(`idle:click:budget:${req.user.id}:${Math.floor(Date.now()/1000)}`,requested,2);const count=Math.min(requested,Math.max(0,30-(used-requested)));
  if(!count){void recordIdleEvent(req.user.id,'click_rejected',{value:requested});return res.status(429).json({error:'Cadence de frappe impossible'});}
  let result;
  await withSettle(req.user.id, async (tx, liveUser, ancientLevelsByKey, settlement) => {
    const normalized=normalizeWaveProgress(liveUser.idleStage,liveUser.idleWaveKills,liveUser.idleBattleMode);let stage=normalized.stage;let waveKills=normalized.waveKills;let hp=liveUser.idleEnemyHp>0&&liveUser.idleEnemyHp<=enemyUnitMaxHp(stage,waveKills)?liveUser.idleEnemyHp:enemyUnitMaxHp(stage,waveKills);let progress=liveUser.idleBossProgress||0;let bossStartedAt=liveUser.idleBossStartedAt?new Date(liveUser.idleBossStartedAt):null;let bestBossMs=liveUser.idleBestBossMs||null;
    let damageTotal=0,rewardTotal=0,kills=0,bosses=0,criticals=0,lastMechanic=null;
    const slots=await loadSlots(tx,liveUser.id);const roles=slots.filter((slot)=>slot.character).map((slot)=>roleForCharacter(slot.character));
    // Base = rendement plat du clic + part de la production d'équipe
    // (CLICK_RATE_SHARE) : sans cette part, le clic plafonnait en dur face à
    // des PV exponentiels et tout l'arsenal actif devenait cosmétique en
    // milieu de partie. Les multiplicateurs (classe, crit, objets…) portent
    // sur la somme : ils restent pertinents à tout stade.
    const blessingEffects=runBlessingEffects(liveUser.idleRunBlessings);const passiveCritBonus=characterPassiveTeamBonus(slots,'crit');const clickBuff=activeOrbBuff(liveUser)?.click||1;const base=(clickYield(liveUser.idleClickLevel||0,ancientBonus(ancientLevelsByKey,'clickMult'))+(settlement?.totalRate||0)*CLICK_RATE_SHARE)*heroClass(liveUser.idleHeroClass).click*(heroSpec(liveUser.idleHeroClass,liveUser.idleHeroSpec).click||1)*currentIdleEvent().click*clickBuff*itemActionBonus(slots,'click')*blessingEffects.click*(1+characterPassiveTeamBonus(slots,'click'));
    // « Frappes Multiples » : chaque frappe physique (count, plafonné par la
    // cadence/le budget serveur) simule PLUSIEURS frappes de combat — dégâts
    // et kills comptés en conséquence. Le compteur `count` renvoyé au client
    // (et utilisé pour les quêtes de clic) reste basé sur les frappes
    // physiques, pas sur ce multiplicateur.
    const effectiveCount=Math.max(count,Math.round(count*(1+multiStrikeBonus(liveUser.idleMultiStrikeLevel||0))));
    for(let i=0;i<effectiveCount;i++){
      const world=campaignForStage(stage);const mechanic=bossMechanicForStage(stage);lastMechanic=mechanic?.key||null;
      if(isBossStage(stage)&&!bossStartedAt)bossStartedAt=new Date();const hpRatio=hp/Math.max(1,enemyUnitMaxHp(stage,waveKills));let multiplier=world.modifier?.click||1;
      if(isBossStage(stage)&&hpRatio<=.5)multiplier*=.75;
      if(isBossStage(stage)&&bossStartedAt&&Date.now()-bossStartedAt.getTime()>=BOSS_TIMER_SECONDS*1000)multiplier*=.5;
      if(mechanic?.key==='shield'&&progress<mechanic.required){multiplier*=.25;progress++;}
      if(mechanic?.key==='rage'&&hpRatio<=mechanic.threshold)multiplier*=.5;
      if(mechanic?.key==='regen'&&progress<1)multiplier*=.65;
      if(mechanic?.key==='counter'){if(progress===1)multiplier*=.35;progress=1;}
      const executeAt=world.modifier?.executeAt||.2;if(heroClass(liveUser.idleHeroClass).execute&&hpRatio<=executeAt)multiplier*=heroClass(liveUser.idleHeroClass).execute;
      if(hpRatio<=.2)multiplier*=1+Math.min(.5,roles.filter((role)=>role==='assassin').length*.25);
      if(isBossStage(stage))multiplier*=itemActionBonus(slots,'boss');
      const critical=Math.random()<Math.max(0,Math.min(.95,(heroClass(liveUser.idleHeroClass).crit||.12)+(world.modifier?.critBonus||0)+critUpgradeBonus(liveUser.idleCritLevel)+blessingEffects.crit+passiveCritBonus));if(critical)criticals++;
      const damage=Math.max(1,Math.round(base*multiplier*(critical?2:1)));damageTotal+=damage;
      if(damage>=hp){const defeatedStage=stage;rewardTotal+=enemyUnitReward(stage,waveKills);kills++;waveKills++;const waveComplete=waveKills>=enemiesRequiredForStage(stage);if(isBossStage(stage)&&waveComplete&&bossStartedAt){const ms=Math.max(1,Date.now()-bossStartedAt.getTime());bestBossMs=!bestBossMs||ms<bestBossMs?ms:bestBossMs;if(liveUser.idleBattleMode!=='farm')bosses++;}if(waveComplete){waveKills=0;if(liveUser.idleBattleMode!=='farm')stage++;}hp=enemyUnitMaxHp(stage,waveKills);progress=stage!==defeatedStage?0:progress;bossStartedAt=isBossStage(stage)?new Date():null;}else hp-=damage;
    }
    const updated=await tx.user.update({where:{id:liveUser.id},data:{idleEnemyHp:hp,idleWaveKills:waveKills,idleBossProgress:progress,idleBossStartedAt:bossStartedAt,idleBestBossMs:bestBossMs,idleStage:stage,idleRunBestStage:Math.max(liveUser.idleRunBestStage||1,stage),idleBestStage:Math.max(liveUser.idleBestStage||1,stage),essence:{increment:rewardTotal},essenceEarnedTotal:{increment:rewardTotal},idleRunEssenceEarned:{increment:rewardTotal}}});
    result={essence:updated.essence,gained:damageTotal,damage:damageTotal,killed:kills>0,kills,passiveKills:settlement?.passiveKills||0,bosses,critical:criticals>0,criticals,count,mechanic:lastMechanic,mechanicProgress:progress};
  });
  await incrementIdleCounter(req.user.id,'click',count);
  if(result?.kills)await incrementIdleCounter(req.user.id,'kill',result.kills);
  if(result?.bosses)await incrementIdleCounter(req.user.id,'boss_kill',result.bosses);
  if(result?.kills)void recordIdleEvent(req.user.id,'active_kill',{value:result.damage,count:result.kills});
  res.json(result);
});

router.post('/skill/burst', requireAuth, requireIdleBeta, rateLimit({ windowMs: 30000, max: 1, name: 'idle-skill-burst' }), async (req, res) => {
  let gained=0;let readyAt;let cooldownMs=ULTIMATE_COOLDOWN_MS;let killed=false,bossKilled=false;
  try{await withSettle(req.user.id, async(tx,user,levels)=>{if(user.idleBurstReadyAt&&new Date(user.idleBurstReadyAt)>new Date())throw new IdleError(429,'Ultime encore en recharge');const slots=await loadSlots(tx,user.id);const recruitCount=await tx.dojoRecruit.count({where:{userId:user.id}});const blessingEffects=runBlessingEffects(user.idleRunBlessings);const teamRate=computeTotalRate(slots,user.idleProdLevel||0,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idleLeaderCharacterId,rateExtrasFor(user,slots,recruitCount,levels));const supportCount=slots.filter((slot)=>slot.character&&roleForCharacter(slot.character)==='support').length;cooldownMs=activeSkillCooldown(ULTIMATE_COOLDOWN_MS,supportCount,user.idleCooldownLevel,blessingEffects.cooldown,characterPassiveTeamBonus(slots,'cooldown'));const mechanic=bossMechanicForStage(user.idleStage||1);let multiplier=campaignForStage(user.idleStage||1).modifier?.burst||1;let progress=user.idleBossProgress||0;if(mechanic?.key==='regen'){progress=1;multiplier*=1.5;}if(mechanic?.key==='counter'){if(progress===2)multiplier*=.35;progress=2;}readyAt=new Date(Date.now()+cooldownMs);await tx.user.update({where:{id:user.id},data:{idleBurstReadyAt:readyAt,idleBossProgress:progress}});gained=Math.round(ultimateBaseDamage(clickYield(user.idleClickLevel||0,ancientBonus(levels,'clickMult')),teamRate)*heroClass(user.idleHeroClass).burst*(heroSpec(user.idleHeroClass,user.idleHeroSpec).burst||1)*multiplier*itemActionBonus(slots,'burst')*blessingEffects.burst);({killed,bossKilled}=await applyActiveDamage(tx,user,gained));});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  // L'Ultime représente 75 frappes : cette équivalence doit aussi alimenter
  // tous les systèmes de progression fondés sur les clics (rang du Dojo,
  // missions quotidiennes/hebdomadaires, défis et score de saison).
  await Promise.all([
    incrementIdleCounter(req.user.id,'skill',1),
    incrementIdleCounter(req.user.id,'click',ULTIMATE_CLICK_MULTIPLIER),
  ]);
  if(killed)await incrementIdleCounter(req.user.id,'kill',1);
  if(bossKilled)await incrementIdleCounter(req.user.id,'boss_kill',1);
  res.json({ ok: true, gained, damage:gained, killed, bossKilled, progressClicks:ULTIMATE_CLICK_MULTIPLIER, cooldownMs,readyAt:readyAt.toISOString() });
});

router.post('/skill/team', requireAuth, requireIdleBeta, rateLimit({ windowMs: 60000, max: 1, name: 'idle-skill-team' }), async (req, res) => {
  let gained=0,uniqueRoles=0,cooldownMs=TEAM_COMBO_COOLDOWN_MS,killed=false,bossKilled=false;
  try {
    await withSettle(req.user.id,async(tx,user,levels)=>{
      if(user.idleTeamReadyAt&&new Date(user.idleTeamReadyAt)>new Date())throw new IdleError(429,'Combo encore en recharge');
      const slots=await loadSlots(tx,user.id);
      const roles=slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character));
      if(roles.length<2)throw new IdleError(400,'Équipe insuffisante');
      const recruitCount=await tx.dojoRecruit.count({where:{userId:user.id}});
      const blessingEffects=runBlessingEffects(user.idleRunBlessings);const rate=computeTotalRate(slots,user.idleProdLevel,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idleLeaderCharacterId,rateExtrasFor(user,slots,recruitCount,levels));
      uniqueRoles=new Set(roles).size;
      const mechanic=bossMechanicForStage(user.idleStage||1);let multiplier=1;let progress=user.idleBossProgress||0;if(mechanic?.key==='counter'){if(progress===3)multiplier=.35;progress=3;}
      cooldownMs=activeSkillCooldown(TEAM_COMBO_COOLDOWN_MS,roles.filter((role)=>role==='support').length,user.idleCooldownLevel,blessingEffects.cooldown,characterPassiveTeamBonus(slots,'cooldown'));
      await tx.user.update({where:{id:user.id},data:{idleTeamReadyAt:new Date(Date.now()+cooldownMs),idleBossProgress:progress}});
      gained=Math.max(1,Math.floor(rate*(20+uniqueRoles*5)*heroClass(user.idleHeroClass).team*(heroSpec(user.idleHeroClass,user.idleHeroSpec).team||1)*(campaignForStage(user.idleStage||1).modifier?.team||1)*multiplier*itemActionBonus(slots,'team')*blessingEffects.team));
      ({killed,bossKilled}=await applyActiveDamage(tx,user,gained));
    });
  } catch(e) { if(e instanceof IdleError)return res.status(e.status).json({error:e.message}); throw e; }
  void incrementIdleCounter(req.user.id,'skill',1);
  if(killed)await incrementIdleCounter(req.user.id,'kill',1);
  if(bossKilled)await incrementIdleCounter(req.user.id,'boss_kill',1);
  res.json({ ok: true, gained, damage:gained, killed, bossKilled, cooldownMs,readyAt:new Date(Date.now()+cooldownMs).toISOString(), uniqueRoles });
});

router.post('/hero-class', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-hero-class' }), async (req, res) => {
  const key = String(req.body?.key || '');
  if (!HERO_CLASSES[key]) return res.status(400).json({ error: 'Classe inconnue' });
  try { await withSettle(req.user.id, async (tx, user) => {
      const readyAt=user.idleHeroClassChangedAt?new Date(user.idleHeroClassChangedAt).getTime()+10*60*1000:0;
      if(key!==user.idleHeroClass&&Date.now()<readyAt)throw new IdleError(429,`Changement de classe disponible dans ${Math.ceil((readyAt-Date.now())/60000)} min`);
      await tx.user.update({ where: { id: user.id }, data: { idleHeroClass: key, idleHeroSpec:'none',idleHeroClassChangedAt:new Date() } });
    });
  } catch(e) { if(e instanceof IdleError)return res.status(e.status).json({error:e.message}); throw e; }
  res.json(await buildState(req.user.id));
});

router.post('/hero-style', requireAuth, requireIdleBeta, rateLimit({ max: 30, name: 'idle-hero-style' }), async (req, res) => {
  const type = String(req.body?.type || ''); const key = String(req.body?.key || '');
  const field = { auras:'idleHeroAura', stances:'idleHeroStance', titles:'idleHeroTitle', hairs:'idleHeroHair', outfits:'idleHeroOutfit', colors:'idleHeroColor' }[type];
  const item = HERO_STYLES[type]?.find((x)=>x.key===key);
  if (!field || !item) return res.status(400).json({ error:'Personnalisation inconnue' });
  const user = await prisma.user.findUnique({ where:{id:req.user.id},select:{idleRankLevel:true} });
  if ((user.idleRankLevel||1) < item.level) return res.status(403).json({ error:`Débloqué au niveau ${item.level}` });
  await prisma.user.update({ where:{id:req.user.id},data:{[field]:key} });
  res.json(await buildState(req.user.id));
});

router.post('/hero-specialization', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-hero-spec' }), async (req, res) => {
  const key=String(req.body?.key||''); const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleHeroClass:true,idleRankLevel:true}});
  if((user.idleRankLevel||1)<25)return res.status(403).json({error:'Spécialisation débloquée au niveau 25'});
  if(!HERO_SPECS[user.idleHeroClass]?.some((s)=>s.key===key))return res.status(400).json({error:'Spécialisation incompatible'});
  await prisma.user.update({where:{id:req.user.id},data:{idleHeroSpec:key}}); res.json(await buildState(req.user.id));
});

router.post('/mission/claim', requireAuth, requireIdleBeta, rateLimit({ max: 30, name: 'idle-mission' }), async (req, res) => {
  const key = String(req.body?.key || '');
  const counters=await loadIdleCounters(req.user.id);
  try {
    const reward = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const [recruits, slots] = await Promise.all([tx.dojoRecruit.count({ where: { userId: req.user.id } }), tx.idleSlot.count({ where: { userId: req.user.id, characterId: { not: null } } })]);
      const mission = idleMissionList(user, recruits, slots, user.idleStage || 1,counters).find((m) => m.key === key);
      if (!mission) throw new IdleError(400, 'Mission inconnue');
      if (mission.progress < mission.target) throw new IdleError(400, 'Mission incomplète');
      await tx.idleMissionClaim.create({ data: { userId: req.user.id, missionKey: key, period: mission.period } });
      await tx.user.update({ where: { id: req.user.id }, data: { idleSeals: { increment: mission.reward } } });
      return mission.reward;
    });
    res.json({ ok: true, reward });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Mission déjà réclamée' });
    throw e;
  }
});

router.post('/event/claim', requireAuth, requireIdleBeta, rateLimit({ max: 10, name: 'idle-event' }), async (req, res) => {
  const periods=idlePeriods();const period=periods.week;const counters=await loadIdleCounters(req.user.id);const event=weeklyConvergence(counters,periods);
  try {
    await prisma.$transaction(async (tx) => {
      if (!event.completed) throw new IdleError(400, 'Défi hebdomadaire incomplet');
      await tx.idleMissionClaim.create({ data: { userId: req.user.id, missionKey: 'weekly_convergence', period } });
      await tx.user.update({ where: { id: req.user.id }, data: { idleSeals: { increment: event.reward },essence:{increment:event.essence},essenceEarnedTotal:{increment:event.essence} } });
    });
    res.json({ ok: true, reward:event.reward,essence:event.essence,currency:'seals' });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Récompense déjà réclamée' });
    throw e;
  }
});

router.post('/achievement/claim', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-achievement' }), async (req, res) => {
  const key = String(req.body?.key || '');
  try {
    const reward = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const [recruits, slots] = await Promise.all([tx.dojoRecruit.count({ where: { userId: user.id } }), tx.idleSlot.findMany({ where: { userId: user.id, characterId: { not: null } }, select: { level: true } })]);
      const stage = user.idleBestStage || user.idleStage || 1;
      const defs = idleAchievementDefs({ stage, recruits, teamLevels: slots.reduce((n,s)=>n+(s.level||1),0), worlds:Math.min(DOJO_DECOR.length,Math.floor((stage-1)/10)+1), prestige: user.prestigeLevel });
      const achievement = defs.find((a) => a.key === key);
      if (!achievement) throw new IdleError(400, 'Succès inconnu');
      if (achievement.progress < achievement.target) throw new IdleError(400, 'Succès incomplet');
      await tx.idleMissionClaim.create({ data: { userId: user.id, missionKey: `achievement_${key}`, period: 'lifetime' } });
      await tx.user.update({ where: { id: user.id }, data: { idleSeals: { increment: achievement.reward } } });
      return achievement.reward;
    });
    res.json({ ok: true, reward });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Succès déjà réclamé' });
    throw e;
  }
});
router.post('/season/claim',requireAuth,requireIdleBeta,rateLimit({max:20,name:'idle-season'}),async(req,res)=>{
  const tier=Number(req.body?.tier);const def=SEASON_TIERS.find((x)=>x.tier===tier);if(!def)return res.status(400).json({error:'Palier inconnu'});
  const periods=idlePeriods();const counters=await loadIdleCounters(req.user.id);const activity=seasonActivityScore(counters,periods.month);if(activity.score<def.level)return res.status(400).json({error:'Palier de saison incomplet'});
  try{await prisma.$transaction(async(tx)=>{await tx.idleMissionClaim.create({data:{userId:req.user.id,missionKey:`season_tier_${tier}`,period:`season-${periods.month}`}});await tx.user.update({where:{id:req.user.id},data:{idleSeals:{increment:def.reward},...(def.essence?{essence:{increment:def.essence},essenceEarnedTotal:{increment:def.essence}}:{})}});});res.json({ok:true,reward:def.reward,essence:def.essence,currency:'seals'});}catch(e){if(e?.code==='P2002')return res.status(409).json({error:'Palier déjà réclamé'});throw e;}
});
router.post('/challenge/claim',requireAuth,requireIdleBeta,rateLimit({max:20,name:'idle-challenge'}),async(req,res)=>{const key=String(req.body?.key||'');const periods=idlePeriods();const counters=await loadIdleCounters(req.user.id);const slots=await loadSlots(prisma,req.user.id);const def=idleChallengeList(counters,slots,periods).find((x)=>x.key===key);if(!def)return res.status(400).json({error:'Défi inconnu'});if(!def.completed)return res.status(400).json({error:'Défi incomplet'});try{await prisma.$transaction([prisma.idleMissionClaim.create({data:{userId:req.user.id,missionKey:`challenge_${key}`,period:def.period}}),prisma.user.update({where:{id:req.user.id},data:{idleSeals:{increment:def.reward}}})]);}catch(e){if(e?.code==='P2002')return res.status(400).json({error:'Déjà réclamé'});throw e;}void recordIdleEvent(req.user.id,'challenge_claim',{value:def.reward});res.json({reward:def.reward,state:await buildState(req.user.id)});});

// Réclame en un seul appel tout ce qui est complété et pas encore réclamé :
// missions, défis, succès, paliers de saison et convergence hebdomadaire.
// Rejoue les mêmes règles que les routes individuelles (mêmes définitions,
// même table idleMissionClaim comme registre anti-doublon) — juste groupées
// pour éviter au joueur de cliquer une dizaine de boutons « Réclamer » un par un.
router.post('/claim-all', requireAuth, requireIdleBeta, rateLimit({ max: 10, name: 'idle-claim-all' }), idleUserLockMiddleware, async (req, res) => {
  const periods = idlePeriods();
  const counters = await loadIdleCounters(req.user.id);
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'Compte introuvable' });
  const [recruitCount, slots] = await Promise.all([
    prisma.dojoRecruit.count({ where: { userId: user.id } }),
    loadSlots(prisma, user.id),
  ]);
  const activeSlots = slots.filter((s) => s.characterId).length;
  const stage = Math.max(user.idleBestStage || 1, user.idleStage || 1);
  const teamLevels = slots.reduce((n, s) => n + (s.character ? (s.level || 1) : 0), 0);
  const worlds = Math.min(DOJO_DECOR.length, Math.floor((stage - 1) / 10) + 1);

  const missions = idleMissionList(user, recruitCount, activeSlots, stage, counters);
  const achievements = idleAchievementDefs({ stage, recruits: recruitCount, teamLevels, worlds, prestige: user.prestigeLevel });
  const challenges = idleChallengeList(counters, slots, periods);
  const seasonActivity = seasonActivityScore(counters, periods.month);
  const weekly = weeklyConvergence(counters, periods);
  const seasonPeriod = `season-${periods.month}`;

  let claimedRows = [];
  try {
    claimedRows = await prisma.idleMissionClaim.findMany({
      where: {
        userId: user.id,
        OR: [
          ...missions.map((m) => ({ missionKey: m.key, period: m.period })),
          ...achievements.map((a) => ({ missionKey: `achievement_${a.key}`, period: 'lifetime' })),
          ...challenges.map((c) => ({ missionKey: `challenge_${c.key}`, period: c.period })),
          ...SEASON_TIERS.map((t) => ({ missionKey: `season_tier_${t.tier}`, period: seasonPeriod })),
          { missionKey: 'weekly_convergence', period: periods.week },
        ],
      },
      select: { missionKey: true, period: true },
    });
  } catch (e) { if (e?.code && e.code !== 'P2021') throw e; }
  const claimedSet = new Set(claimedRows.map((c) => `${c.missionKey}:${c.period}`));

  const toClaim = [];
  let seals = 0, essence = 0;
  for (const m of missions) if (m.progress >= m.target && !claimedSet.has(`${m.key}:${m.period}`)) { toClaim.push({ missionKey: m.key, period: m.period }); seals += m.reward; }
  for (const a of achievements) if (a.progress >= a.target && !claimedSet.has(`achievement_${a.key}:lifetime`)) { toClaim.push({ missionKey: `achievement_${a.key}`, period: 'lifetime' }); seals += a.reward; }
  for (const c of challenges) if (c.completed && !claimedSet.has(`challenge_${c.key}:${c.period}`)) { toClaim.push({ missionKey: `challenge_${c.key}`, period: c.period }); seals += c.reward; }
  for (const t of SEASON_TIERS) if (seasonActivity.score >= t.level && !claimedSet.has(`season_tier_${t.tier}:${seasonPeriod}`)) { toClaim.push({ missionKey: `season_tier_${t.tier}`, period: seasonPeriod }); seals += t.reward; essence += t.essence || 0; }
  if (weekly.completed && !claimedSet.has(`weekly_convergence:${periods.week}`)) { toClaim.push({ missionKey: 'weekly_convergence', period: periods.week }); seals += weekly.reward; essence += weekly.essence || 0; }

  if (!toClaim.length) return res.json({ ok: true, claimed: 0, seals: 0, essence: 0, state: await buildState(req.user.id) });

  try {
    await prisma.$transaction(async(tx)=>{
      const inserted=await tx.idleMissionClaim.createMany({data:toClaim.map((c)=>({userId:user.id,...c})),skipDuplicates:true});
      if(inserted.count!==toClaim.length)throw new IdleError(409,'Certaines récompenses viennent déjà d’être réclamées');
      await tx.user.update({
        where:{id:user.id},
        data:{
          idleSeals:{increment:seals},
          ...(essence?{essence:{increment:essence},essenceEarnedTotal:{increment:essence}}:{}),
        },
      });
    });
  } catch(e) {
    if(e instanceof IdleError)return res.status(e.status).json({error:e.message});
    if(e?.code==='P2002')return res.status(409).json({error:'Certaines récompenses viennent déjà d’être réclamées'});
    throw e;
  }
  void recordIdleEvent(req.user.id, 'claim_all', { value: seals });
  res.json({ ok: true, claimed: toClaim.length, seals, essence, state: await buildState(req.user.id) });
});

router.post('/rift/attempt',requireAuth,requireIdleBeta,rateLimit({max:6,windowMs:60000,name:'idle-rift'}),async(req,res)=>{
  await withSettle(req.user.id);
  const state=await buildState(req.user.id);const rift=state.rift;
  if(!rift.unlocked)return res.status(403).json({error:`Faille débloquée au niveau ${rift.unlockLevel}`});
  if(rift.projectedFloor<=rift.bestFloor)return res.status(400).json({error:'Ton équipe manque encore de puissance pour battre ton record'});
  const floor=rift.projectedFloor;const essence=rift.reward.essence;const seals=rift.reward.seals;
  const currentRelicKeys=rift.relics.map((r)=>r.key);
  // Choix de relique : tous les 5 paliers franchis pour la première fois cette
  // semaine (et tant qu'aucun choix n'est déjà en attente), propose 3 options —
  // jamais bloquant, la progression continue même sans avoir tranché.
  const crossedThreshold=Math.floor(floor/5)>Math.floor(rift.bestFloor/5);
  const offerRelicChoice=crossedThreshold&&!rift.pendingChoice.length&&currentRelicKeys.length<Math.floor(rift.maxFloor/5);
  const offeredKeys=offerRelicChoice?rollRiftRelics(currentRelicKeys,3):null;
  // ── Butin d'équipement : chaque palier multiple de 5 franchi pour la
  // première fois cette semaine fait tomber une rune — la Faille devient LA
  // source RÉPÉTABLE d'objets (jusqu'à 4 par semaine), là où les coffres de
  // boss ne tombent qu'une fois par palier de progression. La rareté suit la
  // profondeur ; la magnitude des affixes suit le meilleur stage du joueur
  // (même logique de tier que les coffres), donc le butin reste pertinent à
  // tout niveau de compte.
  const bestStageForLoot=Math.max(1,state.permanentProgress?.bestStage||1);
  const lootFloors=Array.from({length:floor-rift.bestFloor},(_,i)=>rift.bestFloor+1+i).filter((f)=>f%5===0);
  const riftDrops=lootFloors.map((f)=>{
    const rarity=f>=20?'mythic':f>=10?'legendary':'epic';
    const tier=Math.floor(bestStageForLoot/10)+f;
    const base={epic:.06,legendary:.10,mythic:.16}[rarity];
    const bonus=Number((base+Math.min(.25,tier*.002)).toFixed(3));
    const kind=RUNE_KINDS[Math.floor(Math.random()*RUNE_KINDS.length)];
    return idleItemDrop(tier,kind,rarity,bonus,'Faille dimensionnelle');
  });
  const lootResults=[];
  try{await prisma.$transaction(async(tx)=>{
    const existing=await tx.idleProgressCounter.findUnique({where:{userId_key_period:{userId:req.user.id,key:'rift_floor',period:rift.period}}});
    if((existing?.value||0)!==rift.bestFloor)throw new IdleError(409,'La Faille a déjà été actualisée');
    if(existing){const advanced=await tx.idleProgressCounter.updateMany({where:{userId:req.user.id,key:'rift_floor',period:rift.period,value:rift.bestFloor},data:{value:floor}});if(!advanced.count)throw new IdleError(409,'La Faille a déjà été actualisée');}
    else{try{await tx.idleProgressCounter.create({data:{userId:req.user.id,key:'rift_floor',period:rift.period,value:floor}});}catch(error){if(error?.code==='P2002')throw new IdleError(409,'La Faille a déjà été actualisée');throw error;}}
    await tx.user.update({where:{id:req.user.id},data:{essence:{increment:essence},essenceEarnedTotal:{increment:essence},idleSeals:{increment:seals}}});
    if(offeredKeys)await tx.idleRiftRun.upsert({where:{userId_period:{userId:req.user.id,period:rift.period}},create:{userId:req.user.id,period:rift.period,relics:currentRelicKeys,pendingChoice:offeredKeys},update:{pendingChoice:offeredKeys}});
    // Inventaire plein → recyclage automatique (même règle que les coffres de
    // boss) : le drop n'est jamais silencieusement perdu.
    let inventoryCount=await tx.idleItem.count({where:{userId:req.user.id}});
    for(const drop of riftDrops){
      if(inventoryCount<IDLE_ITEM_CAPACITY){const item=await tx.idleItem.create({data:{userId:req.user.id,...drop}});inventoryCount++;lootResults.push({...drop,itemId:item.id,stored:true});}
      else{const salvage=itemSalvageValue(drop,bestStageForLoot);await tx.user.update({where:{id:req.user.id},data:{essence:{increment:salvage},essenceEarnedTotal:{increment:salvage}}});lootResults.push({...drop,stored:false,salvage});}
    }
  });}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void recordIdleEvent(req.user.id,'rift_record',{value:floor,stage:state.battle.stage});
  res.json({ok:true,floor,essence,seals,loot:lootResults,state:await buildState(req.user.id)});
});

router.post('/rift/relic',requireAuth,requireIdleBeta,rateLimit({max:20,name:'idle-rift-relic'}),async(req,res)=>{
  const key=String(req.body?.key||'');
  if(!RIFT_RELICS[key])return res.status(400).json({error:'Relique invalide'});
  const period=idlePeriods().week;
  try{await prisma.$transaction(async(tx)=>{
    const run=await tx.idleRiftRun.findUnique({where:{userId_period:{userId:req.user.id,period}}});
    const pending=run?.pendingChoice||[];
    if(!pending.includes(key))throw new IdleError(400,'Cette relique n’est pas proposée');
    const relics=[...(run?.relics||[]),key];
    await tx.idleRiftRun.upsert({where:{userId_period:{userId:req.user.id,period}},create:{userId:req.user.id,period,relics,pendingChoice:[]},update:{relics,pendingChoice:[]}});
  });}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void recordIdleEvent(req.user.id,'rift_relic_chosen',{value:1});
  res.json({ok:true,state:await buildState(req.user.id)});
});

router.get('/telemetry/beta', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-telemetry' }), async (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000);
  const [events, players] = await Promise.all([
    prisma.idleTelemetry.groupBy({ by: ['event'], where: { createdAt: { gte: since } }, _count: { _all: true }, _avg: { value: true, stage: true } }),
    prisma.user.count({ where: { roles: { has: 'idle_beta' } } }),
  ]);
  res.json({ windowDays: 30, betaPlayers: players, events: events.map((e) => ({ event: e.event, count: e._count._all, averageValue: e._avg.value, averageStage: e._avg.stage })) });
});

router.post('/feedback', requireAuth, requireIdleBeta, rateLimit({ max: 5, windowMs: 60000, name: 'idle-feedback' }), async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const context = String(req.body?.context || '').slice(0, 500);
  if (message.length < 10 || message.length > 1000) return res.status(400).json({ error: 'Le signalement doit contenir entre 10 et 1000 caractères' });
  await prisma.idleFeedback.create({ data: { userId: req.user.id, message, context } });
  void recordIdleEvent(req.user.id, 'feedback_sent');
  res.status(201).json({ ok: true });
});

router.post('/boss-chest', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-boss-chest' }), async (req, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id } });
      const defeated = Math.floor(Math.max(0, (user.idleBestStage || user.idleStage || 1) - 1) / 10);
      const tier = user.idleBossClaimed + 1;
      if (defeated < tier) throw new IdleError(400, 'Aucun coffre de boss disponible');
      // Ancient « Fortune des Gardiens » : multiplie l'Essence des coffres.
      let bossFortune = 1;
      try { bossFortune = 1 + ancientBonus(await loadAncientLevels(tx, user.id), 'bossRewardMult'); } catch { /* tests/migration */ }
      const {reward:baseAmount,sealReward,bonusEssence:baseBonus,lootRarity}=bossChestRewards(tier);
      const amount=Math.round(baseAmount*bossFortune);const bonusEssence=Math.round(baseBonus*bossFortune);const totalEssence=amount+bonusEssence;
      const updated = await tx.user.updateMany({ where: { id: user.id, idleBossClaimed: user.idleBossClaimed }, data: { idleBossClaimed: { increment: 1 },idleSeals:{increment:sealReward}, essence: { increment: totalEssence }, essenceEarnedTotal: { increment: totalEssence } } });
      if (!updated.count) throw new IdleError(409, 'Coffre déjà réclamé');
      const kind=RUNE_KINDS[(tier-1)%RUNE_KINDS.length];const rarity=lootRarity;
      const base={rare:.03,epic:.06,legendary:.10,mythic:.16}[rarity];const bonus=Number((base+Math.min(.25,tier*.002)).toFixed(3));
      const sourceWorld=campaignForStage(tier*10).name;const drop=idleItemDrop(tier,kind,rarity,bonus,sourceWorld);const inventoryCount=await tx.idleItem.count({where:{userId:user.id}});let loot;
      if(inventoryCount<IDLE_ITEM_CAPACITY){const item=await tx.idleItem.create({data:{userId:user.id,...drop}});loot={...drop,itemId:item.id,equipped:false,stored:true};}
      else{const equippedItems=await tx.idleItem.findMany({where:{userId:user.id,equippedCharacterId:{not:null}},select:{effectKey:true,effectValue:true,affixes:true,setKey:true,equippedCharacterId:true}});const fortuneBonus=equippedItems.flatMap((it)=>itemAffixList(it)).filter((a)=>ITEM_EFFECTS[a.effectKey]?.mode==='salvage').reduce((sum,a)=>sum+(a.effectValue||0),0);const salvage=Math.round(itemSalvageValue(drop,Math.max(user.idleBestStage||1,user.idleStage||1))*(1+fortuneBonus)*equipmentSetFlatMultiplier(equippedItems,'salvage'));await tx.user.update({where:{id:user.id},data:{essence:{increment:salvage},essenceEarnedTotal:{increment:salvage}}});loot={...drop,equipped:false,stored:false,salvage};}
      return { tier,reward:totalEssence,baseReward:amount,bonusEssence,seals:sealReward,loot };
    });
    await incrementIdleCounter(req.user.id,'boss_chest',1);
    res.json({ ok: true, ...result });
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// ── Orbe bonus (équivalent « golden cookie ») : le client fait traverser un
// orbe cliquable dans la scène toutes les 2 à 5 minutes ; le cliquer paie
// ~45 s de production d'un coup (rarement +1 Sceau, plus rarement un JACKPOT
// à ~4× la production, façon « Frenzy » de Cookie Clicker). Le serveur reste
// autoritaire sur la fréquence ET le tirage : un jeton anti-rejeu de
// ORB_COOLDOWN_SECONDS borne le gain, quoi que fasse le client.
router.post('/bonus-orb', requireAuth, requireIdleBeta, rateLimit({ max: 30, name: 'idle-orb' }), async (req, res) => {
  const fresh = await store.setIfAbsent(`idle:orb:${req.user.id}`, ORB_COOLDOWN_SECONDS);
  if (!fresh) return res.status(429).json({ error: 'L’orbe s’est déjà dissipé — le prochain arrive bientôt.' });
  let reward = 0;
  let seal = false;
  let jackpot = false;
  let buff = null;
  try {
    await withSettle(req.user.id, async (tx, user, ancientLevelsByKey) => {
      const [slots, recruitCount] = await Promise.all([loadSlots(tx, user.id), tx.dojoRecruit.count({ where: { userId: user.id } })]);
      const rate = computeTotalRate(slots, user.idleProdLevel, user.idleRankLevel || 1, ancientBonus(ancientLevelsByKey, 'prodMult'), user.idleHeroClass, user.idleHeroSpec, user.idleBattleSpeed, user.idleAutoSkills, recruitCount, user.idleFormation, user.idleLeaderCharacterId, rateExtrasFor(user, slots, recruitCount, ancientLevelsByKey));
      jackpot = Math.random() < ORB_JACKPOT_CHANCE;
      // Buff temporaire (« Frénésie »/« Précision divine ») : tiré seulement si
      // l'orbe n'est pas un jackpot ET qu'aucun buff n'est déjà actif. Un orbe
      // à buff ne verse PAS d'essence instantanée : sa valeur est le
      // multiplicateur à durée — c'est le moment d'adrénaline, pas la paie.
      const grantBuff = !jackpot && !activeOrbBuff(user) && Math.random() < ORB_BUFF_CHANCE;
      reward = grantBuff ? 0 : Math.min(orbReward(rate, jackpot), ROUTE_NUMBER_CAP - safeIdleNumber(user.essence));
      seal = Math.random() < ORB_SEAL_CHANCE;
      const rolledBuff = grantBuff ? rollOrbBuff() : null;
      const buffUntil = rolledBuff ? new Date(Date.now() + rolledBuff.seconds * 1000) : null;
      if (rolledBuff) buff = { key: rolledBuff.key, label: rolledBuff.label, description: rolledBuff.description, seconds: rolledBuff.seconds, prod: rolledBuff.prod, click: rolledBuff.click, until: buffUntil.toISOString() };
      await tx.user.update({
        where: { id: user.id },
        data: {
          essence: { increment: reward },
          essenceEarnedTotal: { increment: reward },
          idleRunEssenceEarned: { increment: reward },
          ...(seal ? { idleSeals: { increment: 1 } } : {}),
          ...(rolledBuff ? { idleBuffKey: rolledBuff.key, idleBuffUntil: buffUntil } : {}),
        },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  void recordIdleEvent(req.user.id, 'bonus_orb', { value: reward });
  res.json({ ok: true, reward, seal, jackpot, buff, cooldownSeconds: ORB_COOLDOWN_SECONDS });
});

// Détail d'une licence pour l'écran collection : personnages possédés en
// clair, les autres en silhouettes anonymes (nom masqué, façon Pokédex).
router.get('/collection', requireAuth, requireIdleBeta, rateLimit({ max: 60, name: 'idle-collection' }), async (req, res) => {
  const series = String(req.query.series || '').slice(0, 160);
  if (!series) return res.status(400).json({ error: 'Licence requise' });
  const characters = await prisma.character.findMany({
    where: { series },
    select: { id: true, name: true, imageUrl: true, rarity: true },
    orderBy: [{ rarity: 'desc' }, { name: 'asc' }],
    take: 150,
  });
  if (!characters.length) return res.status(404).json({ error: 'Licence inconnue' });
  let recruitRows = [];
  try { recruitRows = await prisma.dojoRecruit.findMany({ where: { userId: req.user.id, characterId: { in: characters.map((c) => c.id) } }, select: { characterId: true, awakened: true } }); }
  catch { recruitRows = (await prisma.dojoRecruit.findMany({ where: { userId: req.user.id, characterId: { in: characters.map((c) => c.id) } }, select: { characterId: true } })).map((r) => ({ ...r, awakened: false })); }
  const owned = new Map(recruitRows.map((r) => [r.characterId, r]));
  res.json({
    series,
    owned: owned.size,
    total: characters.length,
    characters: characters.map((c) => ({
      id: c.id,
      rarity: c.rarity,
      imageUrl: c.imageUrl,
      owned: owned.has(c.id),
      name: owned.has(c.id) ? c.name : null,
      awakened: owned.get(c.id)?.awakened || false,
    })),
  });
});

// Achète (ou monte) un Ancient : débite ancientCost(level) en Sagesse
// (wisdomPoints — PAS l'essence, monnaie séparée), incrémente son niveau.
// Indépendant de withSettle : les Ancients ne dépendent ni de la production
// ni de l'essence, pas besoin de solder quoi que ce soit avant.
router.post('/ancient', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), idleUserLockMiddleware, async (req, res) => {
  const key = String(req.body?.key || '');
  const ancient = ancientByKey(key);
  if (!ancient) return res.status(400).json({ error: 'Ancient invalide' });
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: req.user.id }, select: { wisdomPoints: true } });
      if (!user) throw new IdleError(404, 'Compte introuvable');
      if (ancient.requires) {
        const prereq = await tx.ancientLevel.findUnique({ where: { userId_ancientKey: { userId: req.user.id, ancientKey: ancient.requires } } });
        if (!prereq?.level) throw new IdleError(400, `Talent requis : ${ancientByKey(ancient.requires)?.name || ancient.requires}`);
      }
      const existing = await tx.ancientLevel.findUnique({ where: { userId_ancientKey: { userId: req.user.id, ancientKey: key } } });
      const level = existing?.level || 0;
      const cost = ancientCost(level);
      const debit=await tx.user.updateMany({where:{id:req.user.id,wisdomPoints:{gte:cost}},data:{wisdomPoints:{decrement:cost}}});
      if(!debit.count)throw new IdleError(400,'Sagesse insuffisante');
      if(existing){
        const advanced=await tx.ancientLevel.updateMany({where:{userId:req.user.id,ancientKey:key,level},data:{level:{increment:1}}});
        if(!advanced.count)throw new IdleError(409,'Cet Ancient vient déjà d’être amélioré');
      }else{
        try{await tx.ancientLevel.create({data:{userId:req.user.id,ancientKey:key,level:1}});}
        catch(error){if(error?.code==='P2002')throw new IdleError(409,'Cet Ancient vient déjà d’être amélioré');throw error;}
      }
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
  invalidateStarterPool,
  idleMissionList,
  seasonActivityScore,
  idleChallengeList,
  weeklyConvergence,
  weeklyRift,
  RIFT_RELICS,
  riftRelicModifiers,
  rollRiftRelics,
  bossChestRewards,
  idleItemDrop,
  rollItemAffixes,
  describeItemAffixes,
  itemProductionBonus,
  upgradedItemRarity,
  itemActionBonus,
  equipmentSetEffectMultiplier,
  equipmentSetFlatMultiplier,
  equipmentSetMultiplier,
  RUNE_SETS,
  itemSalvageValue,
  progressionBossesCrossed,
  synergyForSlots,
  SQUAD_SLOT_DEFS,
  isSquadSlotUnlocked,
  unlockedSquadPresetCount,
  squadPresetSlots,
  teamMetaBreakdown,
  computeRateBreakdown,
  characterLeaderSkill,
  ultimateBaseDamage,
  ULTIMATE_CLICK_MULTIPLIER,
  ULTIMATE_TEAM_SECONDS,
  SEASON_TIERS,
  currentIdleEvent,
  // Exportés pour la route admin de génération de portraits IA
  // (src/admin/admin.routes.js) — même sélection déterministe du gardien
  // que celle utilisée pour l'affichage, une seule source de vérité.
  pickBossForTheme,
};

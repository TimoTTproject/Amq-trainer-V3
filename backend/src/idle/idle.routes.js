// Routes du Dojo (idle/clicker) : état, récolte, recrutement, assignation
// d'emplacements, clic manuel, améliorations. Le roster reste séparé du gacha ;
// l'Essence sert d'alternative aux Sceaux à l'invocation.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin, requireIdleBeta } = require('../admin/admin');
const { rateLimit } = require('../util/ratelimit');
const store = require('../util/store');
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
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  simulateCombat,
  enemyMaxHp,
  enemyUnitMaxHp,
  enemyArchetype,
  enemyReward,
  enemiesRequiredForStage,
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
  RARITY_PASSIVE,
  RECRUIT_WEIGHTS,
  HERO_MILESTONES,
  dojoLevelMultiplier,
  rankQuestSeries,
  decorForLevel,
  DOJO_DECOR,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  PRESTIGE_MIN_STAGE,
  wisdomForRunStage,
  ANCIENTS,
  ancientByKey,
  ancientCost,
  ancientBonus,
  rollRecruitRarity,
  recruitCost,
  recruitEssenceCost,
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
  } catch { /* Compteurs non bloquants pendant une migration. */ }
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

function weeklyRift(counters,totalRate,bestStage,rankLevel,periods=idlePeriods()) {
  const best=Math.max(0,counters.get(`rift_floor:${periods.week}`)||0);
  const variants=[
    {key:'iron',name:'Armure astrale',description:'Les ennemis possèdent 35% de PV supplémentaires.',multiplier:1.35},
    {key:'haste',name:'Course du temps',description:'Chaque salle doit tomber en 15 secondes.',multiplier:20/15},
    {key:'void',name:'Instabilité du Néant',description:'La résistance augmente de 55% par salle.',multiplier:1.18},
  ];
  const variant=variants[Math.abs(Math.floor(Date.parse(`${periods.week}T00:00:00Z`)/604800000))%variants.length];
  const baseHp=enemyMaxHp(Math.max(1,bestStage||1));
  const targetFor=(floor)=>Math.round(baseHp*Math.pow(1.48,Math.max(0,floor-1))*variant.multiplier);
  let projected=0;for(let floor=1;floor<=20;floor++){if(totalRate*20<targetFor(floor))break;projected=floor;}
  return {period:periods.week,unlocked:(rankLevel||1)>=20,unlockLevel:20,maxFloor:20,bestFloor:best,projectedFloor:projected,nextFloor:Math.min(20,best+1),nextTarget:targetFor(Math.min(20,best+1)),variant,reward:{essence:Math.max(0,250*projected*projected-250*best*best),seals:Math.max(0,Math.floor(projected/5)-Math.floor(best/5))}};
}

function bossChestRewards(tier) {
  const reward=Math.round(80*Math.pow(1.4,Math.max(0,tier-1)));
  const sealReward=1+Math.min(3,Math.floor(tier/5));
  const bonusEssence=tier%5===0?Math.round(reward*.5):0;
  const lootRarity=tier%10===0?'mythic':tier%5===0?'legendary':tier%3===0?'epic':'rare';
  return {reward,sealReward,bonusEssence,lootRarity};
}

const IDLE_ITEM_CAPACITY=120;
const ITEM_KINDS={
  weapon:{label:'Arme',icon:'fa-khanda',effectKey:'assault',effectLabel:'Assaut'},
  relic:{label:'Relique',icon:'fa-gem',effectKey:'resonance',effectLabel:'Résonance'},
  accessory:{label:'Accessoire',icon:'fa-ring',effectKey:'salvage',effectLabel:'Fortune'},
};
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
const ITEM_EFFECT_POOLS={weapon:['assault','precision','overdrive'],relic:['resonance','focus','echo'],accessory:['salvage','aura','pact']};
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

function idleItemDrop(tier,kind,rarity,bonus,sourceWorld='Dojo ancestral') {
  const def=ITEM_KINDS[kind];
  const pool=ITEM_EFFECT_POOLS[kind]||[def.effectKey];
  const effectKey=pool[Math.floor(Math.max(0,tier-1)/3)%pool.length];
  const effect=ITEM_EFFECTS[effectKey];
  const effectValue=effect.mode==='salvage'?Number((.05+Math.min(.25,tier*.005)).toFixed(3)):Number((.01+Math.min(.09,tier*.002)).toFixed(3));
  const adjectives={rare:'Affûté',epic:'Héroïque',legendary:'Légendaire',mythic:'Transcendant'};
  const world=String(sourceWorld).split(' · ')[0];
  const family=Object.entries(WORLD_ITEM_NAMES).find(([name])=>world.startsWith(name))?.[1];
  const baseName=family?.[kind]||`${def.label} de ${world}`;
  return {kind,rarity,bonus,name:`${baseName} · ${adjectives[rarity]}`,effectKey,effectValue,sourceWorld:world};
}

function itemProductionBonus(item) {
  return item.bonus+(ITEM_EFFECTS[item.effectKey]?.mode==='dps'?item.effectValue:0);
}

function itemActionBonus(slots, mode) {
  return 1 + slots.flatMap((slot)=>(slot.items?.length?slot.items:slot.equipments)||[])
    .filter((item)=>ITEM_EFFECTS[item.effectKey]?.mode===mode)
    .reduce((sum,item)=>sum+(item.effectValue||0),0);
}

function equipmentSetMultiplier(items=[]) {
  return new Set(items.map((x)=>x.kind)).size>=3&&new Set(items.map((x)=>x.sourceWorld)).size===1?1.10:1;
}

function itemSalvageValue(item) {
  const rarity=ITEM_RARITY_ORDER[item.rarity]||1;
  return Math.max(25,Math.round(160*rarity*Math.pow(1+item.bonus,4)));
}

function progressionBossesCrossed(startStage, endStage, mode='progress') {
  if (mode === 'farm' || endStage <= startStage) return 0;
  return Math.max(0, Math.floor((endStage - 1) / 10) - Math.floor((startStage - 1) / 10));
}

function bossMechanicForStage(stage) {
  const wave = ((stage - 1) % 10) + 1; if (wave !== 10) return null;
  const zone = Math.floor((stage - 1) / 10) + 1;
  return [
    { key:'shield',name:'Bouclier',description:'Frappe 8 fois pour briser le bouclier.',required:8 },
    { key:'rage',name:'Rage',description:'Sous 30% PV, les frappes faiblissent : garde ton Ultime.' },
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
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } }, equipments: true,items:true },
  });
}

const HERO_CLASSES = {
  warrior: { name: 'Guerrier', icon: 'fa-shield-halved', description: '+50% frappe et 20% de critique', click: 1.5, prod: 1, burst: 1, team: 1,crit:.20 },
  mage: { name: 'Mage', icon: 'fa-hat-wizard', description: '+75% puissance de l’Ultime', click: 1, prod: 1, burst: 1.75, team: 1 },
  ninja: { name: 'Ninja', icon: 'fa-user-ninja', description: '+50% puissance du Combo', click: 1, prod: 1, burst: 1, team: 1.5 },
  swordsman: { name: 'Épéiste', icon: 'fa-khanda', description: '+25% frappe, exécution sous 20% PV', click: 1.25, prod: 1.1, burst: 1, team: 1,execute:2 },
  summoner: { name: 'Invocateur', icon: 'fa-dragon', description: '+20% production de l’équipe', click: 1, prod: 1.2, burst: 1, team: 1 },
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
function stableCharacterHash(character) {
  const text=typeof character==='object'?`${character?.name||''}|${character?.series||''}`:String(character||'');
  let hash=2166136261;for(const char of text){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return Math.abs(hash);
}
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
const FORMATIONS={
  balanced:{name:'Équilibrée',description:'Aucune condition, rendement stable.',bonus:()=>1},
  assault:{name:'Assaut',description:'2 Attaquants/Assassins : +15% DPS.',bonus:(roles)=>roles.filter((r)=>['attaquant','assassin'].includes(r)).length>=2?1.15:1},
  fortress:{name:'Forteresse',description:'Tank + Support : +20% DPS.',bonus:(roles)=>roles.includes('tank')&&roles.includes('support')?1.2:1},
  industry:{name:'Logistique',description:'Producteur + Support : +18% DPS.',bonus:(roles)=>roles.includes('producteur')&&roles.includes('support')?1.18:1},
};
const PRESTIGE_PATHS={balanced:{name:'Voie de l’Équilibre',prod:1,click:1},fist:{name:'Voie du Poing',prod:1,click:1.25},army:{name:'Voie de l’Armée',prod:1.2,click:1},time:{name:'Voie du Temps',prod:1.1,click:1.1}};
function characterCombatSkill(character){const role=roleForCharacter(character);return {attaquant:{name:'Ruée',description:'Renforce les formations d’assaut.'},support:{name:'Ralliement',description:'Active les formations combinées.'},tank:{name:'Rempart',description:'Stabilise les combats de boss.'},assassin:{name:'Exécution',description:'Excellent contre les ennemis affaiblis.'},producteur:{name:'Logistique',description:'Améliore le rendement hors combat.'}}[role];}
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

function computeTotalRate(slots, prodLevel, dojoLevel, prodAncientBonus, classKey, specKey, battleSpeed=1, autoSkills=false, recruitCount=0,formation='balanced',prestigePath='balanced') {
  const seriesLevels = new Map();
  for (const s of slots) if (s.character?.series) seriesLevels.set(s.character.series, (seriesLevels.get(s.character.series) || 0) + (s.level || 1));
  const masteryBonus = (series) => { const n = seriesLevels.get(series) || 0; return n >= 500 ? .25 : n >= 250 ? .15 : n >= 100 ? .10 : n >= 25 ? .05 : 0; };
  const talentTeamBonus=slots.reduce((n,s)=>n+(s.character?characterTalent(s.character).team:0),0);
  const base = slots.reduce((sum,s)=>{
    if(!s.characterId||!s.character)return sum;
    const equipped=(s.items?.length?s.items:s.equipments)||[];
    const gearMultiplier=(1+equipped.reduce((v,e)=>v+itemProductionBonus(e),0))*equipmentSetMultiplier(equipped);
    return sum+slotRate(s.character.rarity,s.level)*(1+characterTalent(s.character).self)*Math.pow(2,s.ascension||0)*gearMultiplier*(1+masteryBonus(s.character.series));
  },0);
  const teamPassive = slots.reduce((mult, s) => {
    if (!s.character || (s.level || 1) < 10) return mult;
    return mult + ({ epic: .03, legendary: .08, mythic: .15 }[s.character.rarity] || 0);
  }, 1);
  // battleSpeed ne modifie volontairement plus l'économie : c'est un réglage
  // d'animation et non un multiplicateur obligatoire de classement.
  const reserveBonus=1+Math.min(.20,Math.max(0,recruitCount-slots.filter((s)=>s.character).length)*.01);
  const roles=slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character));
  const roleMultiplier=1+roles.filter((role)=>role==='attaquant').length*.08+roles.filter((role)=>role==='producteur').length*.05;
  return safeIdleNumber(base * roleMultiplier * reserveBonus * (autoSkills?1.15:1) * (1+talentTeamBonus) * teamPassive * heroClass(classKey).prod * (heroSpec(classKey,specKey).prod||1) * currentIdleEvent().prod * prodMultiplier(prodLevel, prodAncientBonus) * dojoLevelMultiplier(dojoLevel) * synergyForSlots(slots).multiplier * (FORMATIONS[formation]||FORMATIONS.balanced).bonus(roles) * (PRESTIGE_PATHS[prestigePath]||PRESTIGE_PATHS.balanced).prod);
}

async function applyActiveDamage(tx, user, damage) {
  const stage = Math.max(1, user.idleStage || 1);
  const waveKills = Math.max(0, Math.min(enemiesRequiredForStage(stage) - 1, user.idleWaveKills || 0));
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
// écriture optimiste, pour que le taux utilisé au calcul soit celui d'avant la
// mutation (ex. avant de changer un emplacement) et que rien ne se perde.
// `essenceEarnedTotal` (jamais décrémentée) conserve aussi ce gain comme
// historique économique. Le rang progresse uniquement via ses épreuves.
async function withSettle(userId, mutate) {
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
    const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, ancientBonus(ancientLevelsByKey, 'prodMult'), user.idleHeroClass, user.idleHeroSpec, user.idleBattleSpeed, user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath);
    const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
    const elapsedMs = Math.min(offlineCapMs, Math.max(0, Date.now() - new Date(user.idleLastCollectAt).getTime()));
    const combat = simulateCombat({
      stage: user.idleStage,
      hp: user.idleEnemyHp,
      waveKills: user.idleWaveKills,
      dps: totalRate,
      elapsedSeconds: elapsedMs / 1000,
      mode: user.idleBattleMode,
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
          idleLastCollectAt: new Date(),
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
    if (mutate) await mutate(prisma, settledUser, ancientLevelsByKey);
    return settledUser;
  }
  throw new IdleError(409, 'Une autre action est déjà en cours, réessaie.');
}

// État complet pour l'affichage (essence, emplacements 0..MAX_SLOTS-1, coûts,
// niveau/décor du Dojo, recrutement).
async function buildState(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      essence: true, idleLastCollectAt: true, idleSlotsUnlocked: true, idleProdLevel: true, idleClickLevel: true,
      essenceEarnedTotal: true, idleRunEssenceEarned: true, idleStage: true, idleRunBestStage: true, idleBestStage: true, idleEnemyHp: true, idleWaveKills:true,
      idleMilestoneClaimed: true, prestigeLevel: true, wisdomPoints: true,
      idleBossClaimed: true,
      idleHeroClass: true, idleHeroClassChangedAt: true,
      idleHeroAura: true, idleHeroStance: true, idleHeroTitle: true, idleHeroHair:true, idleHeroOutfit:true, idleHeroColor:true, idleHeroSpec:true, idleBattleSpeed:true, idleBattleMode:true, idleAutoSkills:true,idleRecruitPity:true,idleOnboardingComplete:true,
      idleSeals:true,idleBurstReadyAt:true,idleTeamReadyAt:true,idleBossProgress:true,idleBossStartedAt:true,idleBestBossMs:true,idleFormation:true,idlePrestigePath:true,idlePrestigeMilestone:true,
      idleRankLevel:true,idleRankKills:true,idleRankClicks:true,idleRankUpgrades:true,idleRankBosses:true,idleRankStartedAt:true,
    },
  });
  if (!user) return null;
  const starterChoices = user.idleOnboardingComplete ? [] : await prisma.character.findMany({
    where: { rarity: 'rare', imageUrl: { not: null } },
    select: { id:true, name:true, imageUrl:true, rarity:true, series:true },
    orderBy: { id:'asc' },
    take: 6,
  });
  const [slots, recruitCount, ancientLevelsByKey,missionCounters,inventoryItems] = await Promise.all([
    loadSlots(prisma, userId),
    prisma.dojoRecruit.count({ where: { userId } }),
    loadAncientLevels(prisma, userId),
    loadIdleCounters(userId),
    prisma.idleItem.findMany({where:{userId},orderBy:[{rarity:'desc'},{obtainedAt:'desc'}],take:IDLE_ITEM_CAPACITY}),
  ]);
  let recruits = [];let presets=[];
  try { recruits = await prisma.dojoRecruit.findMany({ where: { userId }, include: { character: { select: { name:true, series: true, rarity: true } } }, orderBy:{recruitedAt:'desc'} }); } catch (e) { if (e?.code) throw e; }
  try{presets=await prisma.idleTeamPreset.findMany({where:{userId},select:{name:true,formation:true,slots:true},orderBy:{updatedAt:'desc'},take:3});}catch(e){if(e?.code&&e.code!=='P2021')throw e;}
  const prodAncientBonus = ancientBonus(ancientLevelsByKey, 'prodMult');
  const clickAncientBonus = ancientBonus(ancientLevelsByKey, 'clickMult');
  const offlineCapMs = OFFLINE_CAP_MS + ancientBonus(ancientLevelsByKey, 'offlineCapMs');
  const recruitDiscountBonus = ancientBonus(ancientLevelsByKey, 'recruitDiscount');
  const dojoLevel = user.idleRankLevel || 1;
  const totalRate = computeTotalRate(slots, user.idleProdLevel, dojoLevel, prodAncientBonus, user.idleHeroClass, user.idleHeroSpec, user.idleBattleSpeed, user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath);
  const strategy = synergyForSlots(slots);
  const previewElapsedMs = Math.min(offlineCapMs, Math.max(0, Date.now() - new Date(user.idleLastCollectAt).getTime()));
  const combatPreview = simulateCombat({
    stage: user.idleStage,
    hp: user.idleEnemyHp,
    waveKills: user.idleWaveKills,
    dps: totalRate,
    elapsedSeconds: previewElapsedMs / 1000,
    mode: user.idleBattleMode,
  });
  const pending = Math.floor(combatPreview.essence);

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
        equipments: ['weapon', 'relic', 'accessory'].map((kind) => { const e=(row.items?.length?row.items:row.equipments||[]).find((x)=>x.kind===kind); return e?{...e,effectiveBonus:itemProductionBonus(e),effectLabel:ITEM_EFFECTS[e.effectKey]?.label||ITEM_KINDS[kind].effectLabel,effectDescription:ITEM_EFFECTS[e.effectKey]?.description||'',enhanceCost:Math.max(100,Math.round(250*Math.pow(1+e.bonus,6))),powerLevel:Math.max(1,Math.round(e.bonus*100))}:{kind,empty:true}; }),
        talent: characterTalent(row.character),
        role: roleForCharacter(row.character),
        combatSkill: characterCombatSkill(row.character),
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
  const mechanicMultiplier=!clickMechanic?1:clickMechanic.key==='shield'&&(user.idleBossProgress||0)<8?.25:clickMechanic.key==='rage'&&hpRatio<=.3?.5:clickMechanic.key==='regen'&&(user.idleBossProgress||0)<1?.65:1;
  const worldClick=campaignForStage(stage).modifier?.click||1;
  const prestigeClick=(PRESTIGE_PATHS[user.idlePrestigePath]||PRESTIGE_PATHS.balanced).click;
  const clickDamage = Math.max(1, Math.round(clickBase * heroClass(user.idleHeroClass).click * (heroSpec(user.idleHeroClass,user.idleHeroSpec).click||1) * currentIdleEvent().click * worldClick * prestigeClick * mechanicMultiplier));
  const combatWorld=campaignForStage(stage);
  const combatArt=await decorArtForTheme(combatWorld.theme);
  Object.assign(combatWorld,{backgroundUrl:combatArt?.backgroundUrl||null,boss:combatArt?{characterId:combatArt.characterId,name:combatArt.name,imageUrl:combatArt.imageUrl,generatedImageUrl:combatArt.generatedImageUrl}:null});
  const xpIntoStage = maxEnemyHp - enemyHp;
  const xpForNextStage = maxEnemyHp;
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
  const now=new Date();const seasonPeriod=periods.month;const seasonName=['Hiver Éternel','Floraison des héros','Brasier des mondes','Crépuscule dimensionnel'][Math.floor(now.getUTCMonth()/3)];
  const seasonActivity=seasonActivityScore(missionCounters,seasonPeriod);
  let seasonClaims=[];try{seasonClaims=await prisma.idleMissionClaim.findMany({where:{userId,period:`season-${seasonPeriod}`,missionKey:{startsWith:'season_tier_'}},select:{missionKey:true}});}catch(e){if(e?.code)throw e;}const seasonClaimed=new Set(seasonClaims.map((x)=>x.missionKey));
  const activeSlots=slots.filter((s)=>s.character);
  const challengeDefs=idleChallengeList(missionCounters,slots,periods);
  let challengeClaims=[];try{challengeClaims=await prisma.idleMissionClaim.findMany({where:{userId,OR:challengeDefs.map((c)=>({missionKey:`challenge_${c.key}`,period:c.period}))},select:{missionKey:true,period:true}});}catch(e){if(e?.code)throw e;}const claimedChallenges=new Set(challengeClaims.map((c)=>`${c.missionKey}:${c.period}`));
  const challenges=challengeDefs.map((c)=>({...c,progress:Math.min(c.progress,c.target),completed:c.progress>=c.target,claimed:claimedChallenges.has(`challenge_${c.key}:${c.period}`)}));
  const rift=weeklyRift(missionCounters,totalRate,Math.max(user.idleBestStage||1,stage),dojoLevel,periods);
  const guide=[
    {key:'recruit',title:'Invoque ton premier héros',description:'Utilise 1 Sceau ou de l’Essence pour obtenir une recrue Rare ou supérieure.',done:recruitCount>0,tab:'home'},
    {key:'assign',title:'Forme ton équipe',description:'Assigne une recrue dans un emplacement pour produire automatiquement.',done:activeSlots.length>0,tab:'team'},
    {key:'train',title:'Entraîne un héros',description:'Monte un membre de l’équipe au niveau 10 pour activer son passif.',done:activeSlots.some((s)=>(s.level||1)>=10),tab:'team'},
    {key:'boss',title:'Vaincs un boss',description:'Atteins la vague 10 puis ouvre son coffre.',done:stage>10,tab:'home'},
    {key:'gear',title:'Équipe une pièce',description:'Les coffres donnent Armes, Reliques et Accessoires.',done:slots.some((s)=>(s.items||s.equipments||[]).length>0),tab:'equipment'},
    {key:'prestige',title:'Prépare ton premier Prestige',description:'Atteins le niveau requis pour obtenir de la Sagesse permanente.',done:user.prestigeLevel>0,tab:'upgrades'},
  ];
  const slotById=new Map(slots.map((s)=>[s.id,s]));
  const preparedInventoryItems=inventoryItems.map((item)=>{
    const equipped=slotById.get(item.equippedSlotId);
    return {...item,effectiveBonus:itemProductionBonus(item),effectLabel:ITEM_EFFECTS[item.effectKey]?.label||ITEM_KINDS[item.kind]?.effectLabel||'Effet',effectDescription:ITEM_EFFECTS[item.effectKey]?.description||'',kindLabel:ITEM_KINDS[item.kind]?.label||item.kind,salvageValue:itemSalvageValue(item),equippedSlotIndex:equipped?.slotIndex??null,equippedCharacter:equipped?.character?.name||null};
  });
  const inventoryFamilies=[...new Set(preparedInventoryItems.map((item)=>item.sourceWorld))].filter(Boolean).map((world)=>{
    const familyItems=preparedInventoryItems.filter((item)=>item.sourceWorld===world);
    const kinds=[...new Set(familyItems.map((item)=>item.kind))];
    return {world,count:familyItems.length,kinds,complete:kinds.length===3};
  }).sort((a,b)=>Number(b.complete)-Number(a.complete)||b.count-a.count);
  const inventory={
    capacity:IDLE_ITEM_CAPACITY,
    count:inventoryItems.length,
    items:preparedInventoryItems,
    summary:{worlds:inventoryFamilies.length,effects:new Set(preparedInventoryItems.map((item)=>item.effectKey)).size,equipped:preparedInventoryItems.filter((item)=>item.equippedSlotIndex!==null).length,completeFamilies:inventoryFamilies.filter((family)=>family.complete).length},
    families:inventoryFamilies,
    setBonus:{required:3,multiplier:1.10,label:'Trois pièces du même monde : +10% DPS sur le héros'},
  };
  return {
    essence: user.essence,
    pendingEssence: pending,
    totalRate,
    economy:{essence:user.essence,seals:user.idleSeals,pendingEssence:pending,dps:totalRate,offlineCapMs},
    run:{stage,bestStage:Math.max(user.idleRunBestStage||1,stage),essenceEarned:user.idleRunEssenceEarned||0,mode:user.idleBattleMode||'progress'},
    combat:{stage,hp:enemyHp,maxHp:maxEnemyHp,dps:totalRate,reward:enemyUnitReward(stage),isBoss:isBossStage(stage),timerSeconds:isBossStage(stage)?BOSS_TIMER_SECONDS:null,bossFailed:combatPreview.bossFailed,world:combatWorld},
    permanentProgress:{dojoLevel,xpTotal:user.essenceEarnedTotal,bestStage:Math.max(user.idleBestStage||1,stage),prestige:user.prestigeLevel,wisdom:user.wisdomPoints},
    rank:{...rank,startedAt:user.idleRankStartedAt?.toISOString()||null},
    collection:{recruits:recruitCount,masteries,worldsDiscovered},
    inventory,
    automation:{speed:user.idleBattleSpeed||1,mode:user.idleBattleMode||'progress',autoSkills:!!user.idleAutoSkills},
    onboarding:{
      required:!user.idleOnboardingComplete,
      classes:Object.entries(HERO_CLASSES).map(([key,value])=>({key,name:value.name,icon:value.icon,description:value.description})),
      starters:starterChoices.map((character)=>({...character,talent:characterTalent(character),role:roleForCharacter(character),baseRate:slotRate(character.rarity,1)})),
    },
    heroClass: { key: user.idleHeroClass, ...heroClass(user.idleHeroClass), changeReadyAt:user.idleHeroClassChangedAt?new Date(new Date(user.idleHeroClassChangedAt).getTime()+10*60*1000).toISOString():null, choices: Object.entries(HERO_CLASSES).map(([key, value]) => ({ key, ...value })) },
    heroSpecialization: { key:user.idleHeroSpec, active:heroSpec(user.idleHeroClass,user.idleHeroSpec), unlocked:dojoLevel>=25, choices:(HERO_SPECS[user.idleHeroClass]||[]).map((s)=>({...s,selected:s.key===user.idleHeroSpec})) },
    heroStyle: { aura:user.idleHeroAura, stance:user.idleHeroStance, title:user.idleHeroTitle, hair:user.idleHeroHair, outfit:user.idleHeroOutfit, color:user.idleHeroColor, choices:unlockedStyles(dojoLevel,{auras:user.idleHeroAura,stances:user.idleHeroStance,titles:user.idleHeroTitle,hairs:user.idleHeroHair,outfits:user.idleHeroOutfit,colors:user.idleHeroColor}) },
    strategy: { ...strategy, reserveBonus:Math.min(.20,Math.max(0,recruitCount-slots.filter((s)=>s.character).length)*.01), roles: slots.filter((s) => s.character).map((s) => roleForCharacter(s.character)),formation:user.idleFormation||'balanced',formations:Object.entries(FORMATIONS).map(([key,f])=>({key,name:f.name,description:f.description,active:key===(user.idleFormation||'balanced'),multiplier:f.bonus(slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character)))})),presets },
    lastCollectAt: user.idleLastCollectAt,
    offlineCapMs,
    offlineSummary:{awayMs:previewElapsedMs,essence:pending,kills:combatPreview.kills,waves:Math.max(0,combatPreview.stage-(user.idleStage||1)),bossBlocked:combatPreview.bossFailed,capped:Date.now()-new Date(user.idleLastCollectAt).getTime()>=offlineCapMs},
    slots: slotsOut,
    slotsUnlocked: user.idleSlotsUnlocked,
    maxSlots: MAX_SLOTS,
    startSlots: START_SLOTS,
    recruit: { count: recruitCount, nextCost:recruitCost(),nextCostAfter:recruitCost(),currency:'seals',balance:user.idleSeals,essenceCost:recruitEssenceCost(recruitCount,recruitDiscountBonus),essenceCostAfter:recruitEssenceCost(recruitCount+1,recruitDiscountBonus),essenceBalance:user.essence,pity:user.idleRecruitPity||0,guaranteedEpicIn:Math.max(1,10-(user.idleRecruitPity||0)),odds:Object.fromEntries(RECRUIT_WEIGHTS.map(([rarity,weight])=>[rarity,weight])),income:{daily:3,weekly:3} },
    recruitHistory: recruits.slice(0,8).map((r)=>({ id:r.characterId, name:r.character?.name, series:r.character?.series, rarity:r.character?.rarity, recruitedAt:r.recruitedAt, talent:characterTalent(r.character),role:roleForCharacter(r.character) })),
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
      enraged:isBossStage(stage)&&!!user.idleBossStartedAt&&(Date.now()-new Date(user.idleBossStartedAt).getTime()>=BOSS_TIMER_SECONDS*1000),
      bestTimeMs:user.idleBestBossMs||null,
      timerSeconds: isBossStage(stage) ? BOSS_TIMER_SECONDS : null,
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
      speed: { current:user.idleBattleSpeed||1, choices:[{value:1,level:1},{value:2,level:30},{value:4,level:75}].map((x)=>({...x,unlocked:dojoLevel>=x.level})) },
      mode: user.idleBattleMode||'progress',
      autoSkills:{enabled:!!user.idleAutoSkills,unlocked:dojoLevel>=50,level:50,bonus:.15},
      skills:{burstReadyAt:user.idleBurstReadyAt?.toISOString()||null,teamReadyAt:user.idleTeamReadyAt?.toISOString()||null},
    },
    missions,
    codex: { discovered: recruitCount, masteries, worlds: DOJO_DECOR.map((w,i) => ({ name: w.name, level:i*10+1, discovered:Math.max(user.idleBestStage||1,stage)>=i*10+1 })) },
    event: { ...currentIdleEvent(), weekly: { ...weeklyConvergence(missionCounters,periods), claimed: weeklyClaimed } },
    rift,
    achievements,
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
      maxed: user.idleProdLevel >= PROD_LEVEL_MAX,
    },
    click: {
      level: user.idleClickLevel,
      yield: clickBase,
      damage: clickDamage,
      nextDamage: user.idleClickLevel < CLICK_LEVEL_MAX ? Math.max(clickDamage+1,Math.round(clickYield(user.idleClickLevel+1,clickAncientBonus)*heroClass(user.idleHeroClass).click*(heroSpec(user.idleHeroClass,user.idleHeroSpec).click||1)*currentIdleEvent().click*worldClick*prestigeClick*mechanicMultiplier)) : null,
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
        reward: milestoneTier > user.idleMilestoneClaimed ? Array.from({length:milestoneTier-user.idleMilestoneClaimed},(_,i)=>milestoneReward(user.idleMilestoneClaimed+i+1)).reduce((a,b)=>a+b,0) : null,
      },
      // Le multiplicateur plat automatique a disparu : la Sagesse gagnée au
      // Prestige (cf. bloc `ancients` ci-dessus, `points`) se dépense
      // maintenant volontairement dans les Ancients.
      prestige: {
        level: user.prestigeLevel,
        minLevel: PRESTIGE_MIN_DOJO_LEVEL,
        minStage: PRESTIGE_MIN_STAGE,
        runBestStage: user.idleRunBestStage || 1,
        reward: wisdomForRunStage(user.idleRunBestStage || 1),
        eligible: (user.idleRunBestStage || 1) >= PRESTIGE_MIN_STAGE,
        path:user.idlePrestigePath||'balanced',paths:Object.entries(PRESTIGE_PATHS).map(([key,p])=>({key,name:p.name,prod:p.prod,click:p.click,selected:key===(user.idlePrestigePath||'balanced')})),milestone:user.idlePrestigeMilestone||0,
      },
    },
  };
}

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
  const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleOnboardingComplete:true}});
  if(!user)return res.status(404).json({error:'Compte introuvable'});
  if(user.idleOnboardingComplete)return res.status(409).json({error:'Ton aventure a déjà commencé'});
  const character=await prisma.character.findFirst({where:{id:characterId,rarity:'rare',imageUrl:{not:null}},select:{id:true}});
  if(!character)return res.status(400).json({error:'Ce personnage de départ n’est pas disponible'});
  // Opérations idempotentes : le marqueur est écrit en dernier. Une coupure
  // réseau peut donc être rejouée sans doublon ni perte de starter.
  await prisma.dojoRecruit.upsert({
    where:{userId_characterId:{userId:req.user.id,characterId}},
    update:{},create:{userId:req.user.id,characterId},
  });
  await prisma.idleSlot.upsert({
    where:{userId_slotIndex:{userId:req.user.id,slotIndex:0}},
    update:{characterId,assignedAt:new Date(),level:1,ascension:0},
    create:{userId:req.user.id,slotIndex:0,characterId,assignedAt:new Date(),level:1,ascension:0},
  });
  await prisma.user.update({where:{id:req.user.id},data:{idleHeroClass:classKey,idleHeroSpec:'none',idleHeroClassChangedAt:null,idleOnboardingComplete:true}});
  res.json(await buildState(req.user.id));
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
      id: r.character.id, name: r.character.name, imageUrl: r.character.imageUrl, rarity: r.character.rarity, series:r.character.series, recruitedAt:r.recruitedAt, talent:characterTalent(r.character),role:roleForCharacter(r.character),
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
  let paymentCost = 0;
  try {
    await withSettle(req.user.id, async (tx, user, ancientLevelsByKey) => {
      const count = await tx.dojoRecruit.count({ where: { userId: user.id } });
      const discount = ancientBonus(ancientLevelsByKey, 'recruitDiscount');
      const cost = currency === 'essence' ? recruitEssenceCost(count, discount) : recruitCost();
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
      const pityUpdate = ['epic', 'legendary', 'mythic'].includes(picked.rarity) ? 0 : { increment: 1 };
      if (currency === 'essence') {
        const debit = await tx.user.updateMany({ where: { id: user.id, essence: { gte: cost } }, data: { essence: { decrement: cost }, idleRecruitPity: pityUpdate } });
        if (!debit.count) throw new IdleError(400, 'Essence insuffisante');
      } else {
        await tx.user.update({ where: { id: user.id }, data: { idleSeals: { decrement: cost }, idleRecruitPity: pityUpdate } });
      }
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
  res.json({ ...(await buildState(req.user.id)), payment:{currency,cost:paymentCost}, recruited: { ...result, talent: characterTalent(result), role:roleForCharacter(result),baseRate:slotRate(result.rarity,1) } });
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

router.post('/upgrade', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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
  await incrementIdleCounter(req.user.id,'upgrade',1);
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
      if ((slot.level || 1) < 500) throw new IdleError(400, 'Niveau 500 requis');
      if ((slot.ascension || 0) >= 5) throw new IdleError(400, 'Ascension maximale atteinte');
      const cost = Math.round(({ rare: 25000, epic: 60000, legendary: 150000, mythic: 400000 }[slot.character.rarity] || 25000) * Math.pow(3, slot.ascension || 0));
      if (user.essence < cost) throw new IdleError(400, 'Essence insuffisante');
      await tx.user.update({ where: { id: user.id }, data: { essence: { decrement: cost } } });
      await tx.idleSlot.update({ where: { id: slot.id }, data: { level: 1, ascension: { increment: 1 } } });
      await tx.dojoRecruit.update({where:{userId_characterId:{userId:user.id,characterId:slot.characterId}},data:{trainingLevel:1,idleAscension:{increment:1}}});
    });
    await incrementIdleCounter(req.user.id,'upgrade',1);
    res.json(await buildState(req.user.id));
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

router.post('/optimize-team', requireAuth, requireIdleBeta, rateLimit({ max: 10, name: 'idle-optimize' }), async (req, res) => {
  let bought=0, spent=0;
  try {
    await withSettle(req.user.id,async(tx,user,levels)=>{
      const slots=await loadSlots(tx,user.id);const recruitCount=await tx.dojoRecruit.count({where:{userId:user.id}});let prodLevel=user.idleProdLevel||0;let prodBought=0;
      if(!slots.some((slot)=>slot.character))throw new IdleError(400,'Aucun héros actif');
      let balance=user.essence;
      for(let step=0;step<500;step++){
        let best=null;const current=computeTotalRate(slots,prodLevel,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath);
        for(const slot of slots){
          if(!slot.character)continue;const level=slot.level||1;const cost=charLevelUpCost(slot.character.rarity,level);slot.level=level+1;const gain=computeTotalRate(slots,prodLevel,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath)-current;slot.level=level;
          const roi=gain/Math.max(1,cost);
          if(!best||roi>best.roi)best={kind:'hero',slot,cost,roi};
        }
        if(prodLevel<PROD_LEVEL_MAX){const cost=prodUpgradeCost(prodLevel);const gain=computeTotalRate(slots,prodLevel+1,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath)-current;const roi=gain/Math.max(1,cost);if(!best||roi>best.roi)best={kind:'prod',cost,roi};}
        if(!best||best.cost>balance)break;
        balance-=best.cost;spent+=best.cost;bought++;
        if(best.kind==='prod'){prodLevel++;prodBought++;}else{best.slot.level=(best.slot.level||1)+1;await tx.idleSlot.update({where:{id:best.slot.id},data:{level:{increment:1}}});await tx.dojoRecruit.update({where:{userId_characterId:{userId:user.id,characterId:best.slot.characterId}},data:{trainingLevel:{increment:1}}});}
      }
      if(!bought)throw new IdleError(400,'Essence insuffisante pour un niveau');
      await tx.user.update({where:{id:user.id},data:{essence:{decrement:spent},...(prodBought?{idleProdLevel:{increment:prodBought}}:{})}});
    });
    await incrementIdleCounter(req.user.id,'upgrade',bought);
    res.json({...(await buildState(req.user.id)),optimization:{bought,spent}});
  }catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/battle-speed', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-speed' }), async (req,res)=>{
  const speed=Number(req.body?.speed);const required={1:1,2:30,4:75}[speed];if(!required)return res.status(400).json({error:'Vitesse invalide'});
  const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleRankLevel:true}});if((user.idleRankLevel||1)<required)return res.status(403).json({error:`Débloqué au niveau ${required}`});
  await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleBattleSpeed:speed}});});res.json(await buildState(req.user.id));
});
router.post('/battle-mode', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-mode' }), async(req,res)=>{const mode=String(req.body?.mode||'');if(!['progress','farm'].includes(mode))return res.status(400).json({error:'Mode invalide'});await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleBattleMode:mode}});});res.json(await buildState(req.user.id));});
router.post('/formation',requireAuth,requireIdleBeta,rateLimit({max:20,name:'idle-formation'}),async(req,res)=>{const formation=String(req.body?.formation||'');if(!FORMATIONS[formation])return res.status(400).json({error:'Formation invalide'});await withSettle(req.user.id,async(tx,u)=>tx.user.update({where:{id:u.id},data:{idleFormation:formation}}));void recordIdleEvent(req.user.id,'formation_change');res.json(await buildState(req.user.id));});
router.post('/prestige-path',requireAuth,requireIdleBeta,rateLimit({max:10,name:'idle-prestige-path'}),async(req,res)=>{const path=String(req.body?.path||'');if(!PRESTIGE_PATHS[path])return res.status(400).json({error:'Voie inconnue'});const user=await prisma.user.findUnique({where:{id:req.user.id},select:{prestigeLevel:true}});if((user?.prestigeLevel||0)<1)return res.status(403).json({error:'Effectue un Prestige pour choisir une voie'});await prisma.user.update({where:{id:req.user.id},data:{idlePrestigePath:path}});void recordIdleEvent(req.user.id,'prestige_path');res.json(await buildState(req.user.id));});
router.post('/team-preset/save',requireAuth,requireIdleBeta,rateLimit({max:15,name:'idle-preset'}),async(req,res)=>{const name=String(req.body?.name||'').trim().slice(0,24);if(!name)return res.status(400).json({error:'Nom du preset requis'});const count=await prisma.idleTeamPreset.count({where:{userId:req.user.id}});const existing=await prisma.idleTeamPreset.findUnique({where:{userId_name:{userId:req.user.id,name}}});if(count>=3&&!existing)return res.status(400).json({error:'Maximum de 3 presets'});const [slots,user]=await Promise.all([loadSlots(prisma,req.user.id),prisma.user.findUnique({where:{id:req.user.id},select:{idleFormation:true}})]);await prisma.idleTeamPreset.upsert({where:{userId_name:{userId:req.user.id,name}},update:{slots:slots.filter((s)=>s.characterId).map((s)=>({slotIndex:s.slotIndex,characterId:s.characterId})),formation:user.idleFormation},create:{userId:req.user.id,name,slots:slots.filter((s)=>s.characterId).map((s)=>({slotIndex:s.slotIndex,characterId:s.characterId})),formation:user.idleFormation}});res.json(await buildState(req.user.id));});
router.post('/team-preset/load',requireAuth,requireIdleBeta,rateLimit({max:15,name:'idle-preset'}),async(req,res)=>{const name=String(req.body?.name||'');const preset=await prisma.idleTeamPreset.findUnique({where:{userId_name:{userId:req.user.id,name}}});if(!preset)return res.status(404).json({error:'Preset introuvable'});await withSettle(req.user.id,async(tx,user)=>{await tx.idleSlot.updateMany({where:{userId:user.id},data:{characterId:null,assignedAt:null}});for(const item of Array.isArray(preset.slots)?preset.slots:[]){if(item.slotIndex>=user.idleSlotsUnlocked)continue;const owned=await tx.dojoRecruit.findUnique({where:{userId_characterId:{userId:user.id,characterId:Number(item.characterId)}}});if(owned)await tx.idleSlot.upsert({where:{userId_slotIndex:{userId:user.id,slotIndex:Number(item.slotIndex)}},update:{characterId:Number(item.characterId),assignedAt:new Date(),level:owned.trainingLevel||1},create:{userId:user.id,slotIndex:Number(item.slotIndex),characterId:Number(item.characterId),assignedAt:new Date(),level:owned.trainingLevel||1}});}await tx.user.update({where:{id:user.id},data:{idleFormation:preset.formation}});});void recordIdleEvent(req.user.id,'preset_load');res.json(await buildState(req.user.id));});
router.post('/auto-skills', requireAuth, requireIdleBeta, rateLimit({ max: 20, name: 'idle-auto-skills' }), async(req,res)=>{const enabled=!!req.body?.enabled;const user=await prisma.user.findUnique({where:{id:req.user.id},select:{idleRankLevel:true}});if((user.idleRankLevel||1)<50)return res.status(403).json({error:'Compétences automatiques débloquées au niveau 50'});await withSettle(req.user.id,async(tx,u)=>{await tx.user.update({where:{id:u.id},data:{idleAutoSkills:enabled}});});res.json(await buildState(req.user.id));});

router.post('/equipment/enhance', requireAuth, requireIdleBeta, rateLimit({ max: 60, name: 'idle-equipment' }), async(req,res)=>{
  const slotIndex=Number(req.body?.slotIndex);const kind=String(req.body?.kind||'');if(!Number.isInteger(slotIndex)||!['weapon','relic','accessory'].includes(kind))return res.status(400).json({error:'Équipement invalide'});
  try{await withSettle(req.user.id,async(tx,user)=>{const slot=await tx.idleSlot.findUnique({where:{userId_slotIndex:{userId:user.id,slotIndex}}});if(!slot)throw new IdleError(404,'Héros introuvable');const item=await tx.idleItem.findUnique({where:{equippedSlotId_kind:{equippedSlotId:slot.id,kind}}});if(!item)throw new IdleError(400,'Emplacement vide');const cost=Math.max(100,Math.round(250*Math.pow(1+item.bonus,6)));if(user.essence<cost)throw new IdleError(400,'Essence insuffisante');const bonus=Number((item.bonus+.01).toFixed(3));const rarity=bonus>=.25?'mythic':bonus>=.16?'legendary':bonus>=.09?'epic':'rare';await tx.user.update({where:{id:user.id},data:{essence:{decrement:cost}}});await tx.idleItem.update({where:{id:item.id},data:{bonus,rarity}});});await incrementIdleCounter(req.user.id,'upgrade',1);res.json(await buildState(req.user.id));}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/equip',requireAuth,requireIdleBeta,rateLimit({max:40,name:'idle-equipment-equip'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');const slotIndex=Number(req.body?.slotIndex);
  if(!itemId||!Number.isInteger(slotIndex))return res.status(400).json({error:'Choix d’équipement invalide'});
  try{await withSettle(req.user.id,async(tx,user)=>{const [item,slot]=await Promise.all([tx.idleItem.findFirst({where:{id:itemId,userId:user.id}}),tx.idleSlot.findUnique({where:{userId_slotIndex:{userId:user.id,slotIndex}}})]);if(!item)throw new IdleError(404,'Objet introuvable');if(!slot?.characterId)throw new IdleError(400,'Ce héros n’est pas assigné');await tx.idleItem.updateMany({where:{userId:user.id,equippedSlotId:slot.id,kind:item.kind,id:{not:item.id}},data:{equippedSlotId:null}});await tx.idleItem.update({where:{id:item.id},data:{equippedSlotId:slot.id}});});res.json(await buildState(req.user.id));}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/unequip',requireAuth,requireIdleBeta,rateLimit({max:40,name:'idle-equipment-unequip'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');
  try{await withSettle(req.user.id,async(tx,user)=>{const item=await tx.idleItem.findFirst({where:{id:itemId,userId:user.id}});if(!item)throw new IdleError(404,'Objet introuvable');await tx.idleItem.update({where:{id:item.id},data:{equippedSlotId:null}});});res.json(await buildState(req.user.id));}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
});

router.post('/equipment/lock',requireAuth,requireIdleBeta,rateLimit({max:60,name:'idle-equipment-lock'}),async(req,res)=>{
  const itemId=String(req.body?.itemId||'');const locked=!!req.body?.locked;const item=await prisma.idleItem.findFirst({where:{id:itemId,userId:req.user.id}});if(!item)return res.status(404).json({error:'Objet introuvable'});await prisma.idleItem.update({where:{id:item.id},data:{locked}});res.json({ok:true,locked});
});

router.post('/equipment/salvage',requireAuth,requireIdleBeta,rateLimit({max:30,name:'idle-equipment-salvage'}),async(req,res)=>{
  const ids=[...new Set((Array.isArray(req.body?.ids)?req.body.ids:[req.body?.itemId]).map(String).filter(Boolean))].slice(0,100);if(!ids.length)return res.status(400).json({error:'Aucun objet sélectionné'});
  try{const gained=await prisma.$transaction(async(tx)=>{const items=await tx.idleItem.findMany({where:{userId:req.user.id,id:{in:ids}}});if(items.some((x)=>x.locked))throw new IdleError(400,'Un objet verrouillé est sélectionné');if(items.some((x)=>x.equippedSlotId))throw new IdleError(400,'Retire les objets équipés avant de les recycler');const fortune=await tx.idleItem.findMany({where:{userId:req.user.id,equippedSlotId:{not:null},effectKey:'salvage'},select:{effectValue:true}});const multiplier=1+fortune.reduce((sum,x)=>sum+x.effectValue,0);const amount=Math.round(items.reduce((sum,x)=>sum+itemSalvageValue(x),0)*multiplier);await tx.idleItem.deleteMany({where:{userId:req.user.id,id:{in:items.map((x)=>x.id)}}});if(amount)await tx.user.update({where:{id:req.user.id},data:{essence:{increment:amount},essenceEarnedTotal:{increment:amount}}});return amount;});res.json({ok:true,gained,state:await buildState(req.user.id)});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
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
// (voir wisdomForPrestige), dépensée ensuite dans les Ancients — plus de
// multiplicateur automatique. Le rang du Dojo (épreuves d'Ascension), le
// roster recruté, les jalons réclamés ET les Ancients déjà achetés sont
// volontairement CONSERVÉS — seule la puissance personnelle (essence,
// emplacements, améliorations) repart à zéro, pas le lieu ni les personnages
// déjà recrutés. Passe par withSettle (comme toutes les autres actions) pour
// que la production en attente soit soldée AVANT le reset : sinon elle
// disparaissait sans même compter dans l'historique économique.
router.post('/prestige', requireAuth, requireIdleBeta, rateLimit({ max: 5, name: 'idle-prestige' }), async (req, res) => {
  let prestigeReward=0,prestigeStage=0,milestoneSeals=0;
  try {
    await withSettle(req.user.id, async (tx, user) => {
      const runBestStage = user.idleRunBestStage || 1;
      if (runBestStage < PRESTIGE_MIN_STAGE) {
        throw new IdleError(400, `Atteins le stage ${PRESTIGE_MIN_STAGE} pendant cette run avant de prestiger`);
      }
      prestigeStage=runBestStage;prestigeReward=wisdomForRunStage(runBestStage);
      const nextPrestige=(user.prestigeLevel||0)+1;const reached=[{level:1,reward:1},{level:3,reward:2},{level:5,reward:3},{level:10,reward:5}].filter((m)=>m.level>(user.idlePrestigeMilestone||0)&&m.level<=nextPrestige);milestoneSeals=reached.reduce((n,m)=>n+m.reward,0);const lastMilestone=reached.length?reached[reached.length-1].level:(user.idlePrestigeMilestone||0);
      await tx.idleSlot.updateMany({ where: { userId: user.id }, data: { characterId: null, assignedAt: null, level: 1 } });
      await tx.dojoRecruit.updateMany({where:{userId:user.id},data:{trainingLevel:1}});
      await tx.user.update({
        where: { id: user.id },
        data: {
          essence: 0,
          idleSlotsUnlocked: START_SLOTS,
          idleProdLevel: 0,
          idleClickLevel: 0,
          idleRunEssenceEarned: 0,
          idleStage: 1,
          idleWaveKills: 0,
          idleRunBestStage: 1,
          idleEnemyHp: enemyMaxHp(1),
          idleBossProgress: 0,
          idleBossStartedAt: null,
          idleBurstReadyAt: null,
          idleTeamReadyAt: null,
          prestigeLevel: { increment: 1 },
          wisdomPoints: { increment: prestigeReward },
          idleSeals:{increment:milestoneSeals},
          idlePrestigeMilestone:lastMilestone,
        },
      });
    });
  } catch (e) {
    if (e instanceof IdleError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  void recordIdleEvent(req.user.id,'prestige',{value:prestigeReward,stage:prestigeStage});
  res.json(await buildState(req.user.id));
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
  await withSettle(req.user.id, async (tx, liveUser, ancientLevelsByKey) => {
    let stage=Math.max(1,liveUser.idleStage||1);let waveKills=Math.max(0,Math.min(enemiesRequiredForStage(stage)-1,liveUser.idleWaveKills||0));let hp=liveUser.idleEnemyHp>0?liveUser.idleEnemyHp:enemyUnitMaxHp(stage,waveKills);let progress=liveUser.idleBossProgress||0;let bossStartedAt=liveUser.idleBossStartedAt?new Date(liveUser.idleBossStartedAt):null;let bestBossMs=liveUser.idleBestBossMs||null;
    let damageTotal=0,rewardTotal=0,kills=0,bosses=0,criticals=0,lastMechanic=null;
    const slots=await loadSlots(tx,liveUser.id);const roles=slots.filter((slot)=>slot.character).map((slot)=>roleForCharacter(slot.character));
    const base=clickYield(liveUser.idleClickLevel||0,ancientBonus(ancientLevelsByKey,'clickMult'))*heroClass(liveUser.idleHeroClass).click*(heroSpec(liveUser.idleHeroClass,liveUser.idleHeroSpec).click||1)*currentIdleEvent().click*(PRESTIGE_PATHS[liveUser.idlePrestigePath]||PRESTIGE_PATHS.balanced).click*itemActionBonus(slots,'click');
    for(let i=0;i<count;i++){
      const world=campaignForStage(stage);const mechanic=bossMechanicForStage(stage);lastMechanic=mechanic?.key||null;
      if(isBossStage(stage)&&!bossStartedAt)bossStartedAt=new Date();const hpRatio=hp/Math.max(1,enemyUnitMaxHp(stage,waveKills));let multiplier=world.modifier?.click||1;
      if(isBossStage(stage)&&hpRatio<=.5)multiplier*=.75;
      if(isBossStage(stage)&&bossStartedAt&&Date.now()-bossStartedAt.getTime()>=BOSS_TIMER_SECONDS*1000)multiplier*=.5;
      if(mechanic?.key==='shield'&&progress<8){multiplier*=.25;progress++;}
      if(mechanic?.key==='rage'&&hpRatio<=.3)multiplier*=.5;
      if(mechanic?.key==='regen'&&progress<1)multiplier*=.65;
      if(mechanic?.key==='counter'){if(progress===1)multiplier*=.35;progress=1;}
      const executeAt=world.modifier?.executeAt||.2;if(heroClass(liveUser.idleHeroClass).execute&&hpRatio<=executeAt)multiplier*=heroClass(liveUser.idleHeroClass).execute;
      if(hpRatio<=.2)multiplier*=1+Math.min(.5,roles.filter((role)=>role==='assassin').length*.25);
      if(isBossStage(stage))multiplier*=itemActionBonus(slots,'boss');
      const critical=Math.random()<((heroClass(liveUser.idleHeroClass).crit||.12)+(world.modifier?.critBonus||0));if(critical)criticals++;
      const damage=Math.max(1,Math.round(base*multiplier*(critical?2:1)));damageTotal+=damage;
      if(damage>=hp){const defeatedStage=stage;rewardTotal+=enemyUnitReward(stage,waveKills);kills++;waveKills++;const waveComplete=waveKills>=enemiesRequiredForStage(stage);if(isBossStage(stage)&&waveComplete&&bossStartedAt){const ms=Math.max(1,Date.now()-bossStartedAt.getTime());bestBossMs=!bestBossMs||ms<bestBossMs?ms:bestBossMs;if(liveUser.idleBattleMode!=='farm')bosses++;}if(waveComplete){waveKills=0;if(liveUser.idleBattleMode!=='farm')stage++;}hp=enemyUnitMaxHp(stage,waveKills);progress=stage!==defeatedStage?0:progress;bossStartedAt=isBossStage(stage)?new Date():null;}else hp-=damage;
    }
    const updated=await tx.user.update({where:{id:liveUser.id},data:{idleEnemyHp:hp,idleWaveKills:waveKills,idleBossProgress:progress,idleBossStartedAt:bossStartedAt,idleBestBossMs:bestBossMs,idleStage:stage,idleRunBestStage:Math.max(liveUser.idleRunBestStage||1,stage),idleBestStage:Math.max(liveUser.idleBestStage||1,stage),essence:{increment:rewardTotal},essenceEarnedTotal:{increment:rewardTotal},idleRunEssenceEarned:{increment:rewardTotal}}});
    result={essence:updated.essence,gained:damageTotal,damage:damageTotal,killed:kills>0,kills,bosses,critical:criticals>0,criticals,count,mechanic:lastMechanic,mechanicProgress:progress};
  });
  await incrementIdleCounter(req.user.id,'click',count);
  if(result?.kills)await incrementIdleCounter(req.user.id,'kill',result.kills);
  if(result?.bosses)await incrementIdleCounter(req.user.id,'boss_kill',result.bosses);
  if(result?.kills)void recordIdleEvent(req.user.id,'active_kill',{value:result.damage,count:result.kills});
  res.json(result);
});

router.post('/skill/burst', requireAuth, requireIdleBeta, rateLimit({ windowMs: 30000, max: 1, name: 'idle-skill-burst' }), async (req, res) => {
  let gained=0;let readyAt;let cooldownMs=30000;let killed=false,bossKilled=false;
  try{await withSettle(req.user.id, async(tx,user,levels)=>{if(user.idleBurstReadyAt&&new Date(user.idleBurstReadyAt)>new Date())throw new IdleError(429,'Ultime encore en recharge');const slots=await loadSlots(tx,user.id);const supportCount=slots.filter((slot)=>slot.character&&roleForCharacter(slot.character)==='support').length;cooldownMs=Math.round(30000*(1-Math.min(.3,supportCount*.1)));const mechanic=bossMechanicForStage(user.idleStage||1);let multiplier=campaignForStage(user.idleStage||1).modifier?.burst||1;let progress=user.idleBossProgress||0;if(mechanic?.key==='regen'){progress=1;multiplier*=1.5;}if(mechanic?.key==='counter'){if(progress===2)multiplier*=.35;progress=2;}readyAt=new Date(Date.now()+cooldownMs);await tx.user.update({where:{id:user.id},data:{idleBurstReadyAt:readyAt,idleBossProgress:progress}});gained=Math.round(clickYield(user.idleClickLevel||0,ancientBonus(levels,'clickMult'))*25*heroClass(user.idleHeroClass).burst*(heroSpec(user.idleHeroClass,user.idleHeroSpec).burst||1)*multiplier*itemActionBonus(slots,'burst'));({killed,bossKilled}=await applyActiveDamage(tx,user,gained));});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void incrementIdleCounter(req.user.id,'skill',1);
  if(killed)await incrementIdleCounter(req.user.id,'kill',1);
  if(bossKilled)await incrementIdleCounter(req.user.id,'boss_kill',1);
  res.json({ ok: true, gained, damage:gained, cooldownMs,readyAt:readyAt.toISOString() });
});

router.post('/skill/team', requireAuth, requireIdleBeta, rateLimit({ windowMs: 60000, max: 1, name: 'idle-skill-team' }), async (req, res) => {
  let gained=0,uniqueRoles=0,cooldownMs=60000,killed=false,bossKilled=false;
  try {
    await withSettle(req.user.id,async(tx,user,levels)=>{
      if(user.idleTeamReadyAt&&new Date(user.idleTeamReadyAt)>new Date())throw new IdleError(429,'Combo encore en recharge');
      const slots=await loadSlots(tx,user.id);
      const roles=slots.filter((s)=>s.character).map((s)=>roleForCharacter(s.character));
      if(roles.length<2)throw new IdleError(400,'Équipe insuffisante');
      const recruitCount=await tx.dojoRecruit.count({where:{userId:user.id}});
      const rate=computeTotalRate(slots,user.idleProdLevel,user.idleRankLevel||1,ancientBonus(levels,'prodMult'),user.idleHeroClass,user.idleHeroSpec,user.idleBattleSpeed,user.idleAutoSkills,recruitCount,user.idleFormation,user.idlePrestigePath);
      uniqueRoles=new Set(roles).size;
      const mechanic=bossMechanicForStage(user.idleStage||1);let multiplier=1;let progress=user.idleBossProgress||0;if(mechanic?.key==='counter'){if(progress===3)multiplier=.35;progress=3;}
      cooldownMs=Math.round(60000*(1-Math.min(.3,roles.filter((role)=>role==='support').length*.1)));
      await tx.user.update({where:{id:user.id},data:{idleTeamReadyAt:new Date(Date.now()+cooldownMs),idleBossProgress:progress}});
      gained=Math.max(1,Math.floor(rate*(20+uniqueRoles*5)*heroClass(user.idleHeroClass).team*(heroSpec(user.idleHeroClass,user.idleHeroSpec).team||1)*(campaignForStage(user.idleStage||1).modifier?.team||1)*multiplier*itemActionBonus(slots,'team')));
      ({killed,bossKilled}=await applyActiveDamage(tx,user,gained));
    });
  } catch(e) { if(e instanceof IdleError)return res.status(e.status).json({error:e.message}); throw e; }
  void incrementIdleCounter(req.user.id,'skill',1);
  if(killed)await incrementIdleCounter(req.user.id,'kill',1);
  if(bossKilled)await incrementIdleCounter(req.user.id,'boss_kill',1);
  res.json({ ok: true, gained, damage:gained, cooldownMs,readyAt:new Date(Date.now()+cooldownMs).toISOString(), uniqueRoles });
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

router.post('/rift/attempt',requireAuth,requireIdleBeta,rateLimit({max:6,windowMs:60000,name:'idle-rift'}),async(req,res)=>{
  await withSettle(req.user.id);
  const state=await buildState(req.user.id);const rift=state.rift;
  if(!rift.unlocked)return res.status(403).json({error:`Faille débloquée au niveau ${rift.unlockLevel}`});
  if(rift.projectedFloor<=rift.bestFloor)return res.status(400).json({error:'Ton équipe manque encore de puissance pour battre ton record'});
  const floor=rift.projectedFloor;const essence=Math.max(0,250*floor*floor-250*rift.bestFloor*rift.bestFloor);const seals=Math.max(0,Math.floor(floor/5)-Math.floor(rift.bestFloor/5));
  try{await prisma.$transaction(async(tx)=>{const existing=await tx.idleProgressCounter.findUnique({where:{userId_key_period:{userId:req.user.id,key:'rift_floor',period:rift.period}}});if((existing?.value||0)!==rift.bestFloor)throw new IdleError(409,'La Faille a déjà été actualisée');await tx.idleProgressCounter.upsert({where:{userId_key_period:{userId:req.user.id,key:'rift_floor',period:rift.period}},create:{userId:req.user.id,key:'rift_floor',period:rift.period,value:floor},update:{value:floor}});await tx.user.update({where:{id:req.user.id},data:{essence:{increment:essence},essenceEarnedTotal:{increment:essence},idleSeals:{increment:seals}}});});}catch(e){if(e instanceof IdleError)return res.status(e.status).json({error:e.message});throw e;}
  void recordIdleEvent(req.user.id,'rift_record',{value:floor,stage:state.battle.stage});
  res.json({ok:true,floor,essence,seals,state:await buildState(req.user.id)});
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
      const {reward:amount,sealReward,bonusEssence,lootRarity}=bossChestRewards(tier);const totalEssence=amount+bonusEssence;
      const updated = await tx.user.updateMany({ where: { id: user.id, idleBossClaimed: user.idleBossClaimed }, data: { idleBossClaimed: { increment: 1 },idleSeals:{increment:sealReward}, essence: { increment: totalEssence }, essenceEarnedTotal: { increment: totalEssence } } });
      if (!updated.count) throw new IdleError(409, 'Coffre déjà réclamé');
      const kinds=['weapon','relic','accessory'];const kind=kinds[(tier-1)%kinds.length];const rarity=lootRarity;
      const base={rare:.03,epic:.06,legendary:.10,mythic:.16}[rarity];const bonus=Number((base+Math.min(.25,tier*.002)).toFixed(3));
      const sourceWorld=campaignForStage(tier*10).name;const drop=idleItemDrop(tier,kind,rarity,bonus,sourceWorld);const inventoryCount=await tx.idleItem.count({where:{userId:user.id}});let loot;
      if(inventoryCount<IDLE_ITEM_CAPACITY){const item=await tx.idleItem.create({data:{userId:user.id,...drop}});loot={...drop,itemId:item.id,equipped:false,stored:true};}
      else{const equippedFortune=await tx.idleItem.findMany({where:{userId:user.id,equippedSlotId:{not:null},effectKey:'salvage'},select:{effectValue:true}});const salvage=Math.round(itemSalvageValue(drop)*(1+equippedFortune.reduce((sum,x)=>sum+x.effectValue,0)));await tx.user.update({where:{id:user.id},data:{essence:{increment:salvage},essenceEarnedTotal:{increment:salvage}}});loot={...drop,equipped:false,stored:false,salvage};}
      return { tier,reward:totalEssence,baseReward:amount,bonusEssence,seals:sealReward,loot };
    });
    await incrementIdleCounter(req.user.id,'boss_chest',1);
    res.json({ ok: true, ...result });
  } catch (e) { if (e instanceof IdleError) return res.status(e.status).json({ error: e.message }); throw e; }
});

// Achète (ou monte) un Ancient : débite ancientCost(level) en Sagesse
// (wisdomPoints — PAS l'essence, monnaie séparée), incrémente son niveau.
// Indépendant de withSettle : les Ancients ne dépendent ni de la production
// ni de l'essence, pas besoin de solder quoi que ce soit avant.
router.post('/ancient', requireAuth, requireIdleBeta, rateLimit({ max: 120, name: 'idle-mutate' }), async (req, res) => {
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
  idleMissionList,
  seasonActivityScore,
  idleChallengeList,
  weeklyConvergence,
  weeklyRift,
  bossChestRewards,
  idleItemDrop,
  itemProductionBonus,
  itemActionBonus,
  equipmentSetMultiplier,
  itemSalvageValue,
  progressionBossesCrossed,
  SEASON_TIERS,
  // Exportés pour la route admin de génération de portraits IA
  // (src/admin/admin.routes.js) — même sélection déterministe du gardien
  // que celle utilisée pour l'affichage, une seule source de vérité.
  pickBossForTheme,
};

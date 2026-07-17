// Tests de routes : /api/idle (Dojo idle/clicker) — sans BDD.
// Le roster du Dojo reste indépendant du gacha. L'Essence peut servir
// d'alternative de paiement lors d'une invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const idleRoutes = require('../src/idle/idle.routes');
const { idleMissionList,seasonActivityScore,weeklyConvergence,weeklyCommunityBoss,communityContribution,weeklyRift,RIFT_RELICS,riftRelicModifiers,rollRiftRelics,bossMechanicForStage,bossChestRewards,progressionBossesCrossed,SEASON_TIERS,idleItemDrop,rollItemAffixes,itemProductionBonus,itemActionBonus,equipmentSetEffectMultiplier,equipmentSetFlatMultiplier,equipmentSetMultiplier,RUNE_SETS,itemSalvageValue,upgradedItemRarity,synergyForSlots,teamMetaBreakdown,computeRateBreakdown,characterLeaderSkill,ultimateBaseDamage,ULTIMATE_CLICK_MULTIPLIER,ULTIMATE_TEAM_SECONDS,currentIdleEvent,squadPresetSlots,idleBalanceDiagnostic }=idleRoutes;
const {
  slotUpgradeCost, prodUpgradeCost, clickUpgradeCost, critUpgradeCost, cooldownUpgradeCost, multiStrikeUpgradeCost, runBlessingRerollCost, charLevelUpCost,
  milestoneTierForLevel, milestoneReward, PRESTIGE_MIN_STAGE, prestigeRequiredStage, wisdomForRunStage, enemyMaxHp,
  ANCIENTS, ancientCost, recruitCost, recruitEssenceCost, START_SLOTS, MAX_SLOTS, DOJO_DECOR, HERO_ASCENSION_LEVEL, enemiesDefeatedBeforeStage,
  RARITY_PASSIVE_POOL, characterPassiveEntry, characterPassiveMagnitude, characterPassiveBonus, characterPassiveDescription,
  heroAscensionRequiredLevel, prestigeStartingLevels,
} = require('../src/idle/idle');

// Les routes /api/idle sont réservées aux admins pendant la phase de test
// (voir requireAdmin dans idle.routes.js) — email admin par défaut.
function dbUser(over = {}) {
  return {
    id: 'u1', email: 'melfisk6@gmail.com', essence: 0, idleLastCollectAt: new Date(), idleSlotsUnlocked: START_SLOTS,
    idleProdLevel: 0, idleClickLevel: 0, idleCritLevel:0, idleCooldownLevel:0,idleMultiStrikeLevel:0,idleRunBlessings:'',idleRunBlessingRerolls:0,idleRunStartedAt:new Date(Date.now()-2*60*60*1000), essenceEarnedTotal: 0, idleRunEssenceEarned:0,
    idleRankLevel:1,idleRankKills:0,idleRankClicks:0,idleRankUpgrades:0,idleRankBosses:0,idleRankSkills:0,idleRankRecruits:0,idleRankStartedAt:new Date(),
    idleStage:1,idleRunBestStage:1,idleBestStage:1,idleEnemyHp:enemyMaxHp(1),idleWaveKills:0,idleMilestoneClaimed: 0, idleRecruitPity: 0, idleEssenceRecruitCount:0, idleOnboardingComplete: true, prestigeLevel: 0,
    wisdomPoints: 0,idleSeals:2,tokens:100,idleBossProgress:0,idleBossStartedAt:null,idleBestBossMs:null,idleFormation:'balanced',idleLeaderCharacterId:null,idlePrestigeMilestone:0,idleBurstReadyAt:null,idleTeamReadyAt:null,idleBuffKey:null,idleBuffUntil:null,idleCompletedSeries:0, ...over,
  };
}

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/idle', idleRoutes.router));
});
test.after(() => app.close());

test('Ultime : reste significatif face au Combo à tous les niveaux de progression', () => {
  assert.equal(ULTIMATE_CLICK_MULTIPLIER,75);
  assert.equal(ULTIMATE_TEAM_SECONDS,15);
  assert.equal(ultimateBaseDamage(10,0),750);
  assert.equal(ultimateBaseDamage(10,100),1500);
});

test('synergie : expose le bonus actif, sa condition et le prochain palier',()=>{
  const slot=(id,series)=>({characterId:id,character:{series}});
  const none=synergyForSlots([slot(1,'Naruto')]);
  assert.equal(none.multiplier,1);
  assert.match(none.next,/2 héros de la même licence/);
  const duo=synergyForSlots([slot(1,'Naruto'),slot(2,'Naruto')]);
  assert.equal(duo.bonus,.10);
  assert.match(duo.condition,/2\/2/);
  assert.match(duo.next,/3e héros Naruto/);
  const alliance=synergyForSlots([slot(1,'Naruto'),slot(2,'Naruto'),slot(3,'Naruto')]);
  assert.equal(alliance.bonus,.25);
  assert.match(alliance.next,/maximum/);
  const crossover=synergyForSlots([slot(1,'Naruto'),slot(2,'Bleach'),slot(3,'One Piece')]);
  assert.equal(crossover.bonus,.05);
  assert.equal(crossover.rules.find((rule)=>rule.key==='crossover').met,true);
});

test('synergie : plusieurs licences cumulent leurs bonus au lieu de ne garder que la meilleure',()=>{
  const slot=(id,series)=>({characterId:id,character:{series}});
  // Deux duos différents (Naruto + Bleach) : les deux bonus s'additionnent,
  // au lieu de ne compter que le meilleur comme avant ce correctif.
  const twoDuos=synergyForSlots([slot(1,'Naruto'),slot(2,'Naruto'),slot(3,'Bleach'),slot(4,'Bleach')]);
  assert.equal(twoDuos.bonus,.20);
  assert.equal(twoDuos.multiplier,1.20);
  assert.equal(twoDuos.rules.length,2);
  assert.ok(twoDuos.rules.every((rule)=>rule.met));
  // Un duo ET une alliance différents cumulent aussi (.10 + .25).
  const duoPlusAlliance=synergyForSlots([slot(1,'Naruto'),slot(2,'Naruto'),slot(3,'Bleach'),slot(4,'Bleach'),slot(5,'Bleach')]);
  assert.equal(duoPlusAlliance.bonus,.35);
  assert.match(duoPlusAlliance.next,/3e héros Naruto/); // priorité au duo qu'on peut encore upgrader
});

test('squadPresetSlots : chaque slot vérifie SA PROPRE condition (pas un simple comptage par index)',()=>{
  // Rang 22 sans aucun Prestige : Faille (index 3, condition = rang ≥20) doit
  // être débloquée, mais Boss (index 1, condition = Prestige ≥1) doit rester
  // verrouillée. L'ancien calcul par comptage (`index < unlocked`, où
  // `unlocked` ne comptait QUE le nombre total de slots déblocables) mélangeait
  // les deux : ici Alpha+Faille remplissent leur condition (2 au total), donc
  // l'ancien code marquait à tort les 2 PREMIERS index (Alpha, Boss) comme
  // débloqués, et Faille (index 3, pourtant bien débloquée) comme verrouillée.
  const user={prestigeLevel:0,idleRankLevel:22,idleBestStage:1,idleRunBestStage:1,idleStage:1};
  const slots=squadPresetSlots(user,[]);
  const byName=(name)=>slots.find((s)=>s.name===name);
  assert.equal(byName('Composition Alpha').unlocked,true);
  assert.equal(byName('Composition Boss').unlocked,false);
  assert.equal(byName('Composition Farm').unlocked,false);
  assert.equal(byName('Composition Faille').unlocked,true);
  assert.equal(byName('Composition Libre').unlocked,false);
});

test.beforeEach(() => {
  prisma.idleSlot.findMany = async () => [];
  prisma.dojoRecruit.count = async () => 0;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.dojoRecruit.update = async () => ({});
  prisma.dojoRecruit.updateMany = async () => ({count:0});
  // buildState()/withSettle() appellent systématiquement decorArtForTheme()
  // et loadAncientLevels() : sans stub par défaut, tous les tests existants
  // (qui ne testent ni l'habillage visuel ni les Ancients) planteraient sur
  // "non stubbé". Le cache mémoire du module doit aussi être vidé, sinon un
  // test pollue le suivant.
  prisma.character.findMany = async () => [];
  prisma.song.findFirst = async () => null;
  prisma.ancientLevel.findMany = async () => [];
  prisma.dojoBossArt.findUnique = async () => null;
  prisma.idleTeamPreset.findMany = async () => [];
  prisma.idleProgressCounter.findMany = async () => [];
  prisma.idleProgressCounter.upsert = async () => ({});
  prisma.idleItem.findMany = async () => [];
  prisma.idleRiftRun.findUnique = async () => null;
  prisma.idleRunHistory.findMany = async () => [];
  prisma.idleRunHistory.create = async ({data}) => ({id:1,...data});
  prisma.idleMissionClaim.findUnique = async () => null;
  idleRoutes.decorArtCache.clear();
  idleRoutes.invalidateStarterPool();
});

test('laboratoire tactique : compare formations et presets avec le DPS exact sans mutation',async()=>{
  const me=dbUser({idleSlotsUnlocked:3,idleBestStage:37,idleRunBestStage:37,idleFormation:'balanced',idleLeaderCharacterId:1,idleProdLevel:2});
  const characters=[
    {id:1,name:'Héros Alpha',imageUrl:'/alpha.png',rarity:'epic',series:'Naruto'},
    {id:2,name:'Héros Beta',imageUrl:'/beta.png',rarity:'epic',series:'Naruto'},
    {id:3,name:'Héros Gamma',imageUrl:'/gamma.png',rarity:'legendary',series:'Bleach'},
  ];
  const recruits=characters.map((character,index)=>({userId:'u1',characterId:character.id,trainingLevel:12+index*8,idleAscension:0,awakened:false,awakenStars:index,character}));
  prisma.user.findUnique=async()=>me;
  prisma.idleSlot.findMany=async()=>[{userId:'u1',slotIndex:0,characterId:1,level:12,ascension:0,character:characters[0]},{userId:'u1',slotIndex:1,characterId:3,level:28,ascension:0,character:characters[2]}];
  prisma.dojoRecruit.findMany=async()=>recruits;
  prisma.idleTeamPreset.findMany=async()=>[{name:'Composition Alpha',formation:'assault',slots:[{slotIndex:0,characterId:1,leader:true},{slotIndex:1,characterId:2,leader:false}],updatedAt:new Date()}];
  prisma.idleItem.findMany=async()=>[];
  prisma.user.update=async()=>{throw new Error('la route de lecture ne doit pas muter le joueur');};
  prisma.idleSlot.updateMany=async()=>{throw new Error('la route de lecture ne doit pas muter les slots');};

  const response=await app.request('/api/idle/strategy-lab',{cookie:app.authCookie('u1')});
  assert.equal(response.status,200);assert.equal(response.json.readOnly,true);
  assert.ok(response.json.current.totalRate>0);assert.equal(response.json.boss.stage,40);assert.ok(response.json.boss.requiredDps>0);
  assert.equal(response.json.formations.length,4);assert.ok(response.json.formations.every((formation)=>Number.isFinite(formation.totalRate)&&Number.isFinite(formation.delta)));
  assert.equal(response.json.presets[0].name,'Composition Alpha');assert.equal(response.json.presets[0].heroCount,2);
  assert.equal(response.json.presets[0].team[0].leader,true);assert.match(response.json.presets[0].synergy.name,/Naruto/);
  assert.ok(response.json.recommended?.totalRate>0);
});

test('classements Idle : progression, vitesse, Faille et collection exposent une métrique comparable',async()=>{
  const me=dbUser({id:'u1',idleBestStage:80,idleRankLevel:12});
  const rival={...dbUser({id:'u2',displayName:'Rivale',idleBestStage:120,idleRankLevel:18,prestigeLevel:2}),_count:{dojoRecruits:14}};
  prisma.user.findUnique=async()=>me;
  prisma.user.findMany=async()=>[rival,{...me,_count:{dojoRecruits:6}}];
  prisma.idleRunHistory.findMany=async()=>[
    {userId:'u2',durationSeconds:900,bestStage:100,completedAt:new Date(),user:rival},
    {userId:'u2',durationSeconds:1200,bestStage:110,completedAt:new Date(),user:rival},
  ];
  prisma.idleProgressCounter.findMany=async(args)=>args.where?.key==='rift_floor'?[{userId:'u2',value:17,user:rival}]:[];
  const stage=await app.request('/api/idle/leaderboard?type=stage',{cookie:app.authCookie('u1')});
  const speed=await app.request('/api/idle/leaderboard?type=speed',{cookie:app.authCookie('u1')});
  const rift=await app.request('/api/idle/leaderboard?type=rift',{cookie:app.authCookie('u1')});
  const collection=await app.request('/api/idle/leaderboard?type=collection',{cookie:app.authCookie('u1')});
  assert.equal(stage.status,200);assert.equal(stage.json.players[0].metric,120);
  assert.equal(speed.json.players.length,1);assert.equal(speed.json.players[0].metric,900);
  assert.equal(rift.json.players[0].metric,17);assert.ok(rift.json.period);
  assert.equal(collection.json.players[0].metric,14);
});

test('social Idle : compare les amis et rend leur composition active inspectable',async()=>{
  const me=dbUser({id:'u1'});const rival=dbUser({id:'u2',displayName:'Rivale',idleBestStage:140,idleRankLevel:22,prestigeLevel:3,idleLeaderCharacterId:7,idleFormation:'assault'});
  prisma.user.findUnique=async(args)=>args.where.id==='u2'?rival:me;
  prisma.friendship.findMany=async()=>[{requesterId:'u1',addresseeId:'u2',status:'accepted',requester:{...me,_count:{dojoRecruits:4}},addressee:{...rival,_count:{dojoRecruits:12}}}];
  prisma.idleProgressCounter.findMany=async()=>[{userId:'u2',value:15}];
  const social=await app.request('/api/idle/social',{cookie:app.authCookie('u1')});
  assert.equal(social.status,200);assert.equal(social.json.friends[0].name,'Rivale');assert.equal(social.json.friends[0].stage,140);
  assert.equal(social.json.friends[0].collection,12);assert.equal(social.json.friends[0].rift,15);

  prisma.idleSlot.findMany=async()=>[{userId:'u2',slotIndex:0,characterId:7,level:25,ascension:1,character:{id:7,name:'Rem',imageUrl:'/rem.png',rarity:'epic',series:'Re:Zero'}}];
  prisma.dojoRecruit.count=async()=>12;prisma.ancientLevel.findMany=async()=>[];prisma.idleItem.findMany=async()=>[];
  prisma.idleProgressCounter.findUnique=async()=>({value:15});
  const profile=await app.request('/api/idle/players/u2',{cookie:app.authCookie('u1')});
  assert.equal(profile.status,200);assert.equal(profile.json.player.name,'Rivale');assert.equal(profile.json.player.team[0].character.name,'Rem');assert.equal(profile.json.player.team[0].role,'support');
  assert.equal(profile.json.player.team[0].leader,true);assert.ok(profile.json.player.totalRate>0);
});

test('diagnostic d’équilibrage Idle : expose funnel, percentiles, murs et alertes sans donnée personnelle',async()=>{
  const users=Array.from({length:10},(_,index)=>({id:`u${index}`,idleBestStage:index<4?20:40+index*10,idleRankLevel:index<5?10:22,prestigeLevel:index===9?1:0}));
  const runs=[{userId:'u9',bestStage:100,wisdomGained:12,durationSeconds:3600,teamDps:5000}];
  const rifts=[{userId:'u7',value:8}];
  const diagnostic=idleBalanceDiagnostic(users,runs,rifts,[]);
  assert.equal(diagnostic.players,10);assert.equal(diagnostic.funnel[1].count,10);assert.ok(diagnostic.progression.stageMedian>=20);
  assert.equal(diagnostic.prestige.wisdomPerHourMedian,12);assert.equal(diagnostic.rift.participants,1);
  assert.ok(diagnostic.walls.some((wall)=>wall.stage===20&&wall.players===4));assert.ok(diagnostic.alerts.some((alert)=>alert.key==='wall'));

  prisma.user.findUnique=async()=>dbUser();prisma.user.findMany=async()=>users;
  prisma.idleRunHistory.findMany=async()=>runs;prisma.idleProgressCounter.findMany=async()=>rifts;prisma.idleTelemetry.groupBy=async()=>[];
  const response=await app.request('/api/idle/diagnostics/balance',{cookie:app.authCookie('u1')});
  assert.equal(response.status,200);assert.equal(response.json.players,10);assert.equal(response.json.prestige.runs,1);
  assert.equal(JSON.stringify(response.json).includes('displayName'),false);
});

test('boss communautaire : agrège les actions, classe les contributeurs et crédite une seule récompense',async()=>{
  const rows=[
    {userId:'u1',key:'kill',value:100},{userId:'u1',key:'click',value:100},{userId:'u1',key:'skill',value:2},{userId:'u1',key:'boss_kill',value:1},
    {userId:'u2',key:'kill',value:25000},
  ];
  assert.equal(communityContribution(rows).get('u1'),176);
  const event=weeklyCommunityBoss(rows,[{id:'u1',displayName:'Moi'},{id:'u2',displayName:'Rivale'}],'u1',false,'2026-07-13');
  assert.equal(event.completed,true);assert.equal(event.eligible,true);assert.equal(event.leaderboard[0].id,'u2');assert.equal(event.phase.key,'defeated');

  prisma.user.findUnique=async()=>dbUser();prisma.idleProgressCounter.findMany=async()=>rows;
  prisma.user.findMany=async()=>[{id:'u1',displayName:'Moi',avatarUrl:null},{id:'u2',displayName:'Rivale',avatarUrl:null}];
  prisma.idleMissionClaim.findUnique=async()=>null;let claim=null;let reward=null;
  prisma.idleMissionClaim.create=async({data})=>{claim=data;return{id:1,...data};};prisma.user.update=async({data})=>{reward=data;return dbUser();};
  const read=await app.request('/api/idle/community-boss',{cookie:app.authCookie('u1')});
  const claimed=await app.request('/api/idle/community-boss/claim',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(read.status,200);assert.equal(read.json.myContribution,176);assert.equal(claimed.status,200);assert.equal(claimed.json.claimed,true);
  assert.equal(claim.missionKey,'community_boss');assert.equal(reward.idleSeals.increment,5);assert.equal(reward.essence.increment,5000);
});

test('GET /state : reste fonctionnel avec un héros assigné ET des objets en inventaire (régression TDZ)', async () => {
  // Régression : la fiche héros référençait `stage` avant sa déclaration —
  // /state tombait en 500 pour TOUT joueur avec un héros assigné, mais les
  // tests n'utilisaient que des comptes aux emplacements vides.
  prisma.user.findUnique = async () => dbUser({ idleBestStage: 42, idleStage: 40 });
  prisma.user.update = async () => dbUser();
  const character = { id: 7, name: 'Rem', series: 'Re:Zero', rarity: 'epic' };
  prisma.idleSlot.findMany = async () => [{ id: 1, userId: 'u1', slotIndex: 0, characterId: 7, level: 12, ascension: 0, character }];
  prisma.idleItem.findMany = async ({ where }) => {
    const equipped = { id: 'eq-1', kind: 'rune1', rarity: 'epic', bonus: .06, effectKey: 'assault', effectValue: .02, equippedCharacterId: 7, setKey: 'energy', enhancementLevel: 2, affixes: [], subStats: {} };
    const bag = { id: 'bag-1', kind: 'rune2', rarity: 'rare', bonus: .03, effectKey: 'echo', effectValue: .01, equippedCharacterId: null, setKey: 'blade', enhancementLevel: 0, affixes: [], subStats: {} };
    return where?.equippedCharacterId?.in ? [equipped] : [equipped, bag];
  };
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  const hero = res.json.slots.find((slot) => slot.character?.id === 7)?.character;
  assert.ok(hero, 'le héros assigné doit être présent dans l’état');
  assert.ok(hero.equipments.some((e) => e.id === 'eq-1' && e.enhanceCost > 0));
  const bagItem = res.json.inventory.items.find((item) => item.id === 'bag-1');
  assert.ok(bagItem.salvageValue > 0 && bagItem.enhanceCost > 0 && bagItem.rerollCost > 0);
});

test('difficulté longue durée : missions tournantes et hebdomadaires renforcées', () => {
  const missions=idleMissionList({},0,0,1,new Map());
  assert.equal(missions.filter((m)=>m.cadence==='Quotidienne').length,3);
  assert.equal(missions.filter((m)=>m.cadence==='Hebdomadaire').length,4);
  assert.ok(missions.filter((m)=>m.cadence==='Hebdomadaire').every((m)=>m.target>=30));
});

test('méta transparente : Producteur, Leader, Lead Skill et Logistique reprennent les multiplicateurs réels', () => {
  const slots=[
    {characterId:1,level:10,character:{name:'Bulma',series:'Dragon Ball',rarity:'epic'}},
    {characterId:2,level:10,character:{name:'Sakura',series:'Naruto',rarity:'legendary'}},
  ];
  const meta=teamMetaBreakdown(slots,5,'industry',false,1);
  assert.equal(meta.roleDetails.find((role)=>role.key==='producteur').bonus,.04);
  assert.equal(meta.talents.find((talent)=>talent.character==='Bulma').name,'Stratège');
  assert.equal(meta.talents.find((talent)=>talent.character==='Sakura').name,'Leader');
  assert.equal(meta.multipliers.find((item)=>item.key==='talents').multiplier,1.11);
  assert.equal(meta.multipliers.find((item)=>item.key==='formation').multiplier,1.18);
  assert.equal(meta.leaderSkill.prod,1.15);
  assert.match(meta.leaderExplanation,/Maître logisticien/i);
  assert.equal(characterLeaderSkill(slots[1].character).prod,1.10);
});

test('DPS héros : la somme réelle inclut équipement et multiplicateurs d équipe',()=>{
  const slots=[
    {slotIndex:0,characterId:1,level:25,ascension:1,awakened:true,character:{id:1,name:'Artoria',rarity:'epic',series:'Fate'},items:[
      {kind:'weapon',bonus:.10,effectKey:'assault',effectValue:.04,sourceWorld:'Fate'},
      {kind:'relic',bonus:.08,effectKey:'echo',effectValue:.03,sourceWorld:'Fate'},
      {kind:'accessory',bonus:.06,effectKey:'aura',effectValue:.02,sourceWorld:'Fate'},
    ]},
    {slotIndex:1,characterId:2,level:20,ascension:0,awakened:false,character:{id:2,name:'Emiya',rarity:'rare',series:'Fate'},items:[]},
  ];
  const extras={achievementsCompleted:3,autoClickDps:17,runBlessings:'berserker',completedSeries:2,buffProd:2};
  const result=computeRateBreakdown(slots,5,12,.04,'warrior','none',1,true,5,'balanced',1,extras);
  assert.equal(result.heroes.length,2);
  assert.ok(result.heroes[0].personalMultiplier>result.heroes[1].personalMultiplier);
  assert.ok(result.heroes.every((hero)=>hero.rate===hero.personalRate*hero.teamMultiplier));
  assert.equal(result.heroRate,result.heroes.reduce((sum,hero)=>sum+hero.rate,0));
  assert.equal(result.totalRate,result.heroRate+17);
});

test('saison : huit paliers et aucune action unique ne termine le parcours', () => {
  const period='2026-07';
  const killsOnly=seasonActivityScore(new Map([[`kill:${period}`,999999]]),period);
  assert.equal(SEASON_TIERS.length,8);
  assert.ok(killsOnly.score<SEASON_TIERS.at(-1).level);
  assert.equal(killsOnly.breakdown.find((x)=>x.key==='kill').value,50000);
});

test('défi hebdomadaire : toutes les familles d actions sont obligatoires', () => {
  const periods={week:'2026-07-13'};
  const partial=weeklyConvergence(new Map([[`kill:${periods.week}`,99999]]),periods);
  assert.equal(partial.completed,false);
  const full=new Map([['kill',1500],['click',1000],['skill',40],['upgrade',100]].map(([key,value])=>[`${key}:${periods.week}`,value]));
  assert.equal(weeklyConvergence(full,periods).completed,true);
});

test('coffres : les paliers majeurs ajoutent de l Essence et une rareté garantie', () => {
  assert.equal(bossChestRewards(5).lootRarity,'legendary');
  assert.ok(bossChestRewards(5).bonusEssence>0);
  assert.equal(bossChestRewards(10).lootRarity,'mythic');
});

test('les gardiens sont comptés uniquement lors dune nouvelle progression', () => {
  assert.equal(progressionBossesCrossed(9,31,'progress'),3);
  assert.equal(progressionBossesCrossed(10,10,'farm'),0);
});

test('gardiens : six mécaniques tournent et les nouvelles imposent une séquence active', () => {
  const keys=Array.from({length:6},(_,index)=>bossMechanicForStage((index+1)*10)?.key);
  assert.deepEqual(keys,['shield','rage','regen','counter','ward','focus']);
  assert.equal(bossMechanicForStage(50).required,1);
  assert.ok(bossMechanicForStage(60).required>=5);
  assert.equal(bossMechanicForStage(59),null);
});

test('faille hebdomadaire : record, difficulté et récompense dépendent de la puissance',()=>{
  const counters=new Map([['rift_floor:2026-07-13',3]]);const rift=weeklyRift(counters,1e9,20,20,{week:'2026-07-13'});
  assert.equal(rift.unlocked,true);assert.equal(rift.bestFloor,3);assert.ok(rift.projectedFloor>3);assert.ok(rift.reward.essence>0);
  assert.equal(weeklyRift(counters,1e9,20,19,{week:'2026-07-13'}).unlocked,false);
});

test('faille hebdomadaire : les reliques modifient le palier projeté et la récompense',()=>{
  const counters=new Map([['rift_floor:2026-07-13',3]]);
  const base=weeklyRift(counters,1000,20,20,{week:'2026-07-13'});
  const buffed=weeklyRift(counters,1000,20,20,{week:'2026-07-13'},['rage_abyssale']);
  assert.ok(buffed.projectedFloor>=base.projectedFloor); // +35% DPS : jamais moins de paliers
  assert.ok(buffed.reward.essence<=base.reward.essence*1.01||buffed.projectedFloor>base.projectedFloor); // -20% Essence à palier égal
  assert.equal(buffed.relics.length,1);assert.equal(buffed.relics[0].key,'rage_abyssale');
  assert.equal(weeklyRift(counters,1000,20,20,{week:'2026-07-13'},['inexistant']).relics.length,0); // clé invalide ignorée
});

test('reliques de Faille : modificateurs cumulatifs, Écho Temporel monte en puissance avec le nombre de reliques',()=>{
  const solo=riftRelicModifiers(['souffle_continu']);
  assert.ok(Math.abs(solo.dpsMult-1.15)<1e-9);assert.ok(Math.abs(solo.rewardMult-1.15)<1e-9);
  const stacked=riftRelicModifiers(['lame_aiguisee','coffre_beni']);
  assert.ok(Math.abs(stacked.dpsMult-1.25*.90)<1e-9);assert.ok(Math.abs(stacked.rewardMult-.90*1.50)<1e-9);
  const echoAlone=riftRelicModifiers(['echo_temporel']);const echoWithTwo=riftRelicModifiers(['echo_temporel','focalisation','instinct_econome']);
  assert.ok(echoWithTwo.dpsMult>echoAlone.dpsMult); // le bonus scale avec le nombre total de reliques
  assert.deepEqual(riftRelicModifiers([]),{dpsMult:1,rewardMult:1,resistanceMult:1,sealBonus:0});
  const pact=riftRelicModifiers(['pacte_sceaux']);
  assert.equal(pact.sealBonus,1);
  const collectorAlone=riftRelicModifiers(['collectionneur']);
  const collectorStacked=riftRelicModifiers(['collectionneur','focalisation','instinct_econome']);
  assert.ok(collectorStacked.rewardMult>collectorAlone.rewardMult);
});

test('reliques de Faille : le tirage ne propose jamais une relique déjà possédée, respecte le nombre demandé',()=>{
  const owned=Object.keys(RIFT_RELICS).slice(0,3);
  const offered=rollRiftRelics(owned,3);
  assert.equal(offered.length,3);
  assert.equal(offered.filter((k)=>owned.includes(k)).length,0);
  assert.equal(new Set(offered).size,3); // pas de doublon dans le tirage lui-même
  const allButOne=Object.keys(RIFT_RELICS).slice(0,Object.keys(RIFT_RELICS).length-1);
  assert.equal(rollRiftRelics(allButOne,3).length,1); // ne peut pas inventer une relique si le pool est presque épuisé
});

test('inventaire : la rareté détermine le nombre d’affixes tirés, sans doublon',()=>{
  assert.equal(rollItemAffixes(5,'rare').length,1);
  assert.equal(rollItemAffixes(5,'epic').length,2);
  assert.equal(rollItemAffixes(5,'legendary').length,3);
  assert.equal(rollItemAffixes(5,'mythic').length,4);
  const affixes=rollItemAffixes(10,'mythic');
  assert.equal(new Set(affixes.map((a)=>a.effectKey)).size,4);
  assert.equal(idleItemDrop(5,'weapon','rare',.03,'Konoha').affixes.length,0);
  assert.equal(idleItemDrop(5,'weapon','mythic',.16,'Konoha').affixes.length,3);
});

test('inventaire : chaque type possède un effet utile et une valeur de recyclage',()=>{
  const item={bonus:.11,effectKey:'assault',effectValue:.05,affixes:[{effectKey:'echo',effectValue:.03},{effectKey:'precision',effectValue:.02}],subStats:{dps:.01,click:.01}};
  // assault et echo sont en mode dps (comptés), precision est en mode click (pas ici)
  assert.ok(Math.abs(itemProductionBonus(item)-(.11+.05+.03+.01))<1e-9);
  assert.ok(Math.abs(itemActionBonus([{items:[item]}],'click')-(1+.02+.01))<1e-9);
  assert.ok(itemSalvageValue(item)>25);
});

test('améliorer un objet conserve toujours sa rareté d’origine',()=>{
  assert.equal(upgradedItemRarity('legendary',.12),'legendary');
  assert.equal(upgradedItemRarity('epic',.16),'epic');
  assert.equal(upgradedItemRarity('mythic',.26),'mythic');
});

test('inventaire : les mondes et les paliers créent des familles variées',()=>{
  // Le set ne tourne plus à CHAQUE palier (tiers 1,2,3 partageaient le même
  // kind au coffre de boss ET un set toujours différent : bijection kind↔set
  // rigide qui rendait un 2/4 pièces impossible — cf. idleItemDrop). Il tourne
  // désormais par LOT de RUNE_KINDS.length paliers, pour qu'un cycle complet
  // de coffres (paliers 1 à 6, un par nature d'objet) livre le même set —
  // largement de quoi compléter un 2 ou 4 pièces — avant de changer de famille
  // au lot suivant (palier 7).
  const effects=new Set([1,7,13].map((tier)=>idleItemDrop(tier,'rune2','rare',.03,'Konoha').effectKey));
  assert.equal(effects.size,3);
  const sameBatch=new Set([1,2,3,4,5,6].map((tier)=>idleItemDrop(tier,'rune2','rare',.03,'Konoha').effectKey));
  assert.equal(sameBatch.size,1);
  assert.match(idleItemDrop(1,'rune1','rare',.03,'Konoha').name,/Kunai de la Feuille/);
  assert.match(idleItemDrop(1,'rune1','rare',.03,'Namek').name,/Lame de Ki/);
});

test('inventaire : chaque set possède un effet réel différent et respecte son seuil',()=>{
  assert.equal(new Set(Object.values(RUNE_SETS).map((set)=>set.mode)).size,Object.keys(RUNE_SETS).length);
  assert.equal(new Set(Object.values(RUNE_SETS).map((set)=>set.description)).size,Object.keys(RUNE_SETS).length);
  assert.equal(equipmentSetMultiplier([{kind:'weapon'},{kind:'relic'}]),1);
  assert.equal(equipmentSetMultiplier([{kind:'rune1',setKey:'energy'},{kind:'rune2',setKey:'energy'}]),1.06);
  assert.equal(equipmentSetMultiplier([{kind:'rune1',setKey:'blade'},{kind:'rune2',setKey:'blade'}]),1);
  assert.equal(equipmentSetEffectMultiplier([{setKey:'blade'},{setKey:'blade'}],'click'),1.12);
  assert.equal(itemActionBonus([{items:[{setKey:'blade'},{setKey:'blade'}]}],'click'),1.12);
  assert.equal(itemActionBonus([{items:[{setKey:'rage'},{setKey:'rage'},{setKey:'rage'},{setKey:'rage'}]}],'burst'),1.25);
  assert.equal(itemActionBonus([{items:[{setKey:'unity'},{setKey:'unity'},{setKey:'unity'},{setKey:'unity'}]}],'team'),1.22);
  assert.equal(itemActionBonus([{items:[{setKey:'hunter'},{setKey:'hunter'}]}],'boss'),1.15);
  assert.equal(equipmentSetFlatMultiplier([{setKey:'fortune',equippedCharacterId:1},{setKey:'fortune',equippedCharacterId:1}],'salvage'),1.25);
  assert.equal(equipmentSetMultiplier([{kind:'rune1',setKey:'rage'},{kind:'rune2',setKey:'rage'},{kind:'rune3',setKey:'rage'}]),1);
});

test('équipement automatique : comble uniquement les emplacements vides, sans jamais déséquiper',async()=>{
  // Nerf volontaire : l'auto-équipement ne construit plus le meilleur build
  // (sets/rôles ignorés) — il place le meilleur objet LIBRE (rareté puis
  // bonus) dans chaque emplacement de rune vide d'un héros actif.
  const user=dbUser();
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async()=>user;
  const character={id:1,name:'Sakura',series:'Naruto',rarity:'epic'};
  prisma.idleSlot.findMany=async()=>[{id:10,userId:'u1',slotIndex:0,characterId:1,level:1,ascension:0,character}];
  const worn={id:'worn',kind:'rune1',rarity:'rare',bonus:.02,effectKey:'assault',effectValue:.01,equippedCharacterId:1,setKey:'energy'};
  const freeWeak={id:'free-weak',kind:'rune2',rarity:'rare',bonus:.03,effectKey:'assault',effectValue:.01,equippedCharacterId:null,setKey:'energy'};
  const freeStrong={id:'free-strong',kind:'rune2',rarity:'mythic',bonus:.02,effectKey:'assault',effectValue:.01,equippedCharacterId:null,setKey:'blade'};
  prisma.idleItem.findMany=async({where})=>where?.equippedCharacterId?.in?[worn]:[worn,freeWeak,freeStrong];
  const updates=[];
  prisma.idleItem.update=async(args)=>{updates.push(args);return{};};
  const res=await app.request('/api/idle/equipment/auto-equip',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(res.status,200);
  // rune1 déjà porté : jamais retiré ; rune2 vide : le mythique gagne (rareté
  // avant bonus brut) ; un seul objet équipé au total.
  assert.equal(updates.length,1);
  assert.equal(updates[0].where.id,'free-strong');
  assert.equal(updates[0].data.equippedCharacterId,1);
  assert.equal(res.json.optimization.equipped,1);
});

test('inventaire : le verrouillage vérifie que l objet appartient au joueur',async()=>{
  prisma.user.findUnique=async()=>dbUser();
  prisma.idleItem.findFirst=async({where})=>where.userId==='u1'?{id:'item-1',userId:'u1'}:null;
  let locked=null;prisma.idleItem.update=async({data})=>{locked=data.locked;return{};};
  const res=await app.request('/api/idle/equipment/lock',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'item-1',locked:true}});
  assert.equal(res.status,200);assert.equal(locked,true);
});

test('équipement : améliorer cible l’objet par itemId, pas par slot+kind (jamais le mauvais objet équipé)',async()=>{
  const user=dbUser({essence:1000});prisma.user.findUnique=async()=>user;prisma.user.update=async()=>user;
  prisma.idleItem.findFirst=async({where})=>where.id==='item-1'&&where.userId==='u1'?{id:'item-1',userId:'u1',bonus:.05,rarity:'rare',equippedCharacterId:7}:null;
  let updateArgs=null;prisma.idleItem.update=async(args)=>{updateArgs=args;return{};};
  const res=await app.request('/api/idle/equipment/enhance',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'item-1'}});
  assert.equal(res.status,200);
  assert.equal(updateArgs.where.id,'item-1');
  assert.ok(Math.abs(updateArgs.data.bonus-.057)<1e-9);
  assert.equal(updateArgs.data.enhancementLevel,1);
});

test('équipement : améliorer refuse un objet non équipé ou appartenant à un autre joueur',async()=>{
  const user=dbUser({essence:1000});prisma.user.findUnique=async()=>user;prisma.user.update=async()=>user;
  prisma.idleItem.findFirst=async({where})=>where.id==='unequipped'&&where.userId==='u1'?{id:'unequipped',userId:'u1',bonus:.05,rarity:'rare',equippedCharacterId:null}:null;
  const unequipped=await app.request('/api/idle/equipment/enhance',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'unequipped'}});
  assert.equal(unequipped.status,400);assert.match(unequipped.json.error,/équipé/);
  const notOwned=await app.request('/api/idle/equipment/enhance',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'not-mine'}});
  assert.equal(notOwned.status,404);
});

test('équipement : améliorer ×10 coûte le total exact en une fois, tout ou rien (retour testeur : bouton en lot)',async()=>{
  const poor=dbUser({essence:1});prisma.user.findUnique=async()=>poor;let essenceSpent=false;
  // `withSettle` fait toujours un premier `update` pour la CAS de règlement
  // passif (idleLastCollectAt) — on vérifie donc précisément qu'aucune
  // décrémentation d'Essence n'a suivi, pas l'absence totale d'appel.
  prisma.user.update=async({data})=>{if(data.essence?.decrement)essenceSpent=true;return poor;};
  prisma.idleItem.findFirst=async({where})=>where.id==='item-1'&&where.userId==='u1'?{id:'item-1',userId:'u1',bonus:.05,rarity:'rare',equippedCharacterId:7}:null;
  prisma.idleItem.update=async()=>({});
  const poorRes=await app.request('/api/idle/equipment/enhance',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'item-1',amount:10}});
  assert.equal(poorRes.status,400);
  assert.equal(essenceSpent,false);

  const rich=dbUser({essence:100000});prisma.user.findUnique=async()=>rich;
  let essenceDecrement=null,bonusAfter=null,levelAfter=null;
  prisma.user.update=async({data})=>{essenceDecrement=data.essence.decrement;return rich;};
  prisma.idleItem.update=async({data})=>{bonusAfter=data.bonus;levelAfter=data.enhancementLevel;return{};};
  const richRes=await app.request('/api/idle/equipment/enhance',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'item-1',amount:10}});
  assert.equal(richRes.status,200);
  assert.ok(essenceDecrement>0&&essenceDecrement<rich.essence);
  assert.ok(Math.abs(bonusAfter-.12)<1e-9);
  assert.equal(levelAfter,10);
});

test('équipement : lié au personnage — échanger le héros d’un slot ne transfère pas son équipement au nouveau (retour testeur)',async()=>{
  const user=dbUser();prisma.user.findUnique=async()=>user;
  prisma.dojoRecruit.findMany=async()=>[{characterId:1,character:{name:'Ancien Héros'}},{characterId:2,character:{name:'Nouveau Héros'}}];
  const equippedItem={id:'w1',userId:'u1',kind:'weapon',rarity:'epic',name:'Épée',bonus:.1,effectKey:'assault',effectValue:0,affixes:[],sourceWorld:'Konoha',equippedCharacterId:1,obtainedAt:new Date(),locked:false};
  prisma.idleItem.findMany=async({where})=>{
    if(where?.equippedCharacterId?.in)return where.equippedCharacterId.in.includes(1)?[equippedItem]:[];
    return [equippedItem];
  };
  // Le héros d'origine (characterId 1) occupe le slot -> équipement actif.
  prisma.idleSlot.findMany=async()=>[{id:10,userId:'u1',slotIndex:0,level:1,characterId:1,character:{id:1,name:'Ancien Héros',imageUrl:null,rarity:'epic'}}];
  const before=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  const itemBefore=before.json.inventory.items.find((i)=>i.id==='w1');
  assert.equal(itemBefore.equipped,true);assert.equal(itemBefore.equippedSlotIndex,0);assert.equal(itemBefore.equippedResting,false);

  // Un AUTRE héros (characterId 2) prend le même slot -> l'objet doit rester
  // sur son propriétaire d'origine (au repos), pas suivre le slot.
  prisma.idleSlot.findMany=async()=>[{id:10,userId:'u1',slotIndex:0,level:1,characterId:2,character:{id:2,name:'Nouveau Héros',imageUrl:null,rarity:'epic'}}];
  const after=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  const itemAfter=after.json.inventory.items.find((i)=>i.id==='w1');
  assert.equal(itemAfter.equipped,true);
  assert.equal(itemAfter.equippedCharacter,'Ancien Héros');
  assert.equal(itemAfter.equippedSlotIndex,null);
  assert.equal(itemAfter.equippedResting,true);
});

test('inventaire : le recyclage exige une confirmation renforcée pour les objets précieux',async()=>{
  prisma.user.findUnique=async()=>dbUser();
  prisma.idleItem.findMany=async({where})=>where.id?.in?[{id:'legend-1',userId:'u1',rarity:'legendary',locked:false,equippedCharacterId:null,bonus:.14,effectValue:.03}]:[];
  const res=await app.request('/api/idle/equipment/salvage',{method:'POST',cookie:app.authCookie('u1'),body:{ids:['legend-1']}});
  assert.equal(res.status,400);
  assert.match(res.json.error,/Confirmation requise/);
});

test('inventaire : le recyclage refuse une sélection partiellement introuvable',async()=>{
  prisma.user.findUnique=async()=>dbUser();
  prisma.idleItem.findMany=async({where})=>where.id?.in?[{id:'item-1',userId:'u1',rarity:'rare',locked:false,equippedCharacterId:null,bonus:.04,effectValue:.02}]:[];
  const res=await app.request('/api/idle/equipment/salvage',{method:'POST',cookie:app.authCookie('u1'),body:{ids:['item-1','item-2']}});
  assert.equal(res.status,404);
  assert.match(res.json.error,/introuvable/);
});

test('GET /state : accessible à tout joueur non-invité depuis la sortie officielle (2026-07-17)', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com' });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
});

test('GET /state : un joueur portant idle_beta accède au jeu sans être administrateur', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com', roles: ['idle_beta'] });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.battle.stage, 1);
});

test('onboarding : impose un choix initial puis offre et assigne le starter', async () => {
  let user=dbUser({idleOnboardingComplete:false});
  const starter={id:77,name:'Starter',imageUrl:'https://cdn.example/starter.jpg',rarity:'rare',series:'Série'};
  prisma.user.findUnique=async()=>user;
  prisma.character.findMany=async(args)=>args.where?.rarity==='rare'?[starter]:[];
  prisma.character.findFirst=async()=>({id:starter.id});
  let recruitWrite=null,slotWrite=null;
  prisma.dojoRecruit.upsert=async(args)=>{recruitWrite=args;return{};};
  prisma.idleSlot.upsert=async(args)=>{slotWrite=args;return{};};
  prisma.user.update=async({data})=>{user={...user,...data};return user;};

  const before=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(before.status,200);
  assert.equal(before.json.onboarding.required,true);
  assert.equal(before.json.onboarding.starters[0].id,starter.id);

  const started=await app.request('/api/idle/onboarding',{method:'POST',cookie:app.authCookie('u1'),body:{classKey:'mage',characterId:starter.id}});
  assert.equal(started.status,200);
  assert.equal(user.idleOnboardingComplete,true);
  assert.equal(user.idleHeroClass,'mage');
  assert.equal(recruitWrite.create.characterId,starter.id);
  assert.equal(slotWrite.create.slotIndex,0);
  assert.equal(slotWrite.create.characterId,starter.id);
});

test('onboarding : un ancien compte marqué terminé mais sans aucun héros récupère un starter', async () => {
  const user=dbUser({idleOnboardingComplete:true});
  const starter={id:88,name:'Nouveau départ',imageUrl:'https://cdn.example/restart.jpg',rarity:'rare',series:'Série'};
  prisma.user.findUnique=async()=>user;
  prisma.dojoRecruit.count=async()=>0;
  prisma.character.findMany=async(args)=>args.where?.rarity==='rare'?[starter]:[];

  const res=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(res.status,200);
  assert.equal(res.json.onboarding.required,true);
  assert.equal(res.json.onboarding.starters[0].id,starter.id);
});

test('GET /state : joueur neuf → 3 emplacements libres, le reste verrouillé avec un coût, recrutement à son 1er coût', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.essence, 0);
  assert.equal(res.json.pendingEssence, 0);
  assert.equal(res.json.slots.length, MAX_SLOTS);
  const unlocked = res.json.slots.filter((s) => !s.locked);
  assert.equal(unlocked.length, START_SLOTS);
  unlocked.forEach((s) => assert.equal(s.character, null));
  const locked = res.json.slots.find((s) => s.locked);
  assert.equal(locked.unlockCost, slotUpgradeCost(locked.index));
  assert.equal(res.json.recruit.count, 0);
  assert.equal(res.json.recruit.nextCost, recruitCost(0));
  assert.equal(res.json.recruit.guaranteedEpicIn, 10);
  assert.equal(res.json.combat.stage, 1);
  assert.equal(res.json.economy.essence, 0);
  assert.equal(res.json.permanentProgress.prestige, 0);
  assert.equal(res.json.click.yield, 5);
  // Guerrier : 5 × 1,5, puis l'événement quotidien (rotation par date réelle,
  // cf. currentIdleEvent) peut ajouter son propre multiplicateur de frappe.
  assert.equal(res.json.click.damage, Math.round(5 * 1.5 * currentIdleEvent().click));
  assert.ok(res.json.battle.skills.burstDamage > res.json.click.damage);
  assert.equal(res.json.battle.skills.teamDamage, 0);
  assert.equal(res.json.battle.stage, 1);
  assert.equal(res.json.battle.kills, 0); // stage 1 = aucun kill encore
  assert.equal(res.json.battle.xpIntoStage, 0);
  assert.equal(res.json.dojo.tiers.length, DOJO_DECOR.length);
  assert.deepEqual(res.json.dojo.tiers[0], { level: DOJO_DECOR[0].level, name: DOJO_DECOR[0].name, theme: DOJO_DECOR[0].theme });
  assert.equal(res.json.ancients.points, 0);
  assert.equal(res.json.ancients.items.length, ANCIENTS.length);
  res.json.ancients.items.forEach((it) => {
    assert.equal(it.level, 0); // rien acheté par défaut
    assert.equal(it.cost, ancientCost(0));
  });
});

test('Épéiste : la frappe et l’aperçu appliquent bien l’Exécution sous 20% PV', async () => {
  let user=dbUser({idleHeroClass:'swordsman',idleEnemyHp:enemyMaxHp(1)});
  prisma.user.findUnique=async()=>user;
  const normal=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  user={...user,idleEnemyHp:1};
  const execute=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(normal.status,200);
  assert.equal(execute.status,200);
  assert.equal(normal.json.heroClass.passiveActive,false);
  assert.equal(execute.json.heroClass.passiveActive,true);
  assert.match(execute.json.heroClass.passiveStatus,/EXÉCUTION ACTIVE/);
  // Le multiplicateur est appliqué avant l'arrondi final : chaque valeur est
  // arrondie indépendamment (pas execute = round(normal)×2), donc la
  // comparaison tolère ±1 — sans quoi le multiplicateur d'événement journalier
  // (currentIdleEvent) fait dériver l'écart au-delà d'un arrondi unique selon
  // la date réelle du test (ex. ×1.2 aujourd'hui : normal=round(7.5)=8,
  // execute=round(15)=15, 15 < 8×2).
  assert.ok(Math.abs(execute.json.click.damage-normal.json.click.damage*2)<=1);
});

test('GET /state : reflète les niveaux d\'Ancients déjà achetés (bonus appliqués, coût du niveau suivant)', async () => {
  const key = ANCIENTS[0].key;
  const user = dbUser({ wisdomPoints: 7 });
  prisma.user.findUnique = async () => user;
  prisma.ancientLevel.findMany = async () => [{ ancientKey: key, level: 3 }];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.ancients.points, 7);
  const item = res.json.ancients.items.find((it) => it.key === key);
  assert.equal(item.level, 3);
  assert.equal(item.cost, ancientCost(3));
  // Discipline Éternelle (prodMult) : le bonus doit se refléter dans le
  // multiplicateur de production affiché.
  if (ANCIENTS[0].kind === 'prodMult') {
    assert.ok(res.json.prod.multiplier > 1);
  }
});

test('GET /state : le stage de run et le décompte de vague sont indépendants du niveau permanent du Dojo', async () => {
  const user = dbUser({ essenceEarnedTotal: 40, idleStage:7,idleRunBestStage:7,idleBestStage:7,idleEnemyHp:enemyMaxHp(7),idleWaveKills:4 });
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.level, 1);
  assert.ok(res.json.battle.stage > 1);
  assert.equal(res.json.battle.kills, enemiesDefeatedBeforeStage(res.json.battle.stage)+4);
  assert.equal(res.json.battle.enemiesRemaining, 6);
  assert.equal(res.json.battle.enemyNumber, 5);
});

test('GET /state : un boss expose un décompte serveur avant son enrage', async () => {
  const startedAt=new Date(Date.now()-10000);
  const user=dbUser({idleStage:10,idleWaveKills:0,idleEnemyHp:enemyMaxHp(10),idleBossStartedAt:startedAt,idleBossEngaged:true,idleLastCollectAt:new Date()});
  prisma.user.findUnique=async()=>user;
  const res=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(res.status,200);
  assert.equal(res.json.battle.isBoss,true);
  assert.ok(res.json.battle.timerRemainingMs<=21000&&res.json.battle.timerRemainingMs>=18000);
  assert.equal(res.json.battle.enraged,false);
});

test('GET /state : la production hors-ligne est plafonnée et reflétée dans pendingEssence', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: twoHoursAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 42, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.ok(res.json.totalRate > 0);
  assert.ok(res.json.pendingEssence > 0);
  assert.equal(res.json.slots[0].character.rarity, 'mythic');
});

test('GET /state : le niveau dépend du rang validé et expose sa série d’épreuves', async () => {
  const user = dbUser({ idleRankLevel:10, idleRankKills:60, idleRankClicks:50, idleRankUpgrades:3 });
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.level, 10);
  assert.equal(res.json.rank.level, 10);
  assert.equal(res.json.rank.nextLevel, 11);
  assert.equal(res.json.rank.quests.length, 3);
  assert.equal(res.json.dojo.xpIntoLevel, res.json.rank.completed);
  assert.ok(res.json.dojo.decor && res.json.dojo.decor.theme);
  assert.ok(res.json.dojo.multiplier > 1);
});

test('passage de niveau : refuse une série incomplète puis valide atomiquement la série complète', async () => {
  let user = dbUser({ idleRankLevel:1 });
  prisma.user.findUnique = async () => user;
  let res = await app.request('/api/idle/rank/advance', { method:'POST', cookie:app.authCookie('u1'), body:{} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /objectifs/);

  user = dbUser({ idleRankLevel:1, idleRankKills:23, idleRankClicks:55, idleRankUpgrades:4, idleSeals:2 });
  prisma.user.updateMany = async ({ where, data }) => {
    assert.equal(where.idleRankLevel, 1);
    user = { ...user, idleRankLevel:2, idleRankKills:0, idleRankClicks:0, idleRankUpgrades:0, idleRankBosses:0, idleSeals:user.idleSeals + data.idleSeals.increment, idleRankStartedAt:data.idleRankStartedAt };
    return { count:1 };
  };
  res = await app.request('/api/idle/rank/advance', { method:'POST', cookie:app.authCookie('u1'), body:{} });
  assert.equal(res.status, 200);
  assert.equal(res.json.level, 2);
  assert.equal(res.json.seals, 1);
  assert.equal(res.json.state.rank.level, 2);
  assert.equal(res.json.state.rank.completed, 0);
  assert.equal(res.json.state.economy.seals, 3);
});

test("GET /state : le décor porte un gardien mythique réel + le fond de son anime quand disponibles", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 101, name: 'Sans imageUrl (à ignorer)', imageUrl: null, seriesId: 1 },
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: 42 },
  ];
  prisma.song.findFirst = async ({ where }) => (where.anilistId === 42 ? { coverUrl: 'https://cdn.example/media/anime/cover/medium/bx42.jpg' } : null);
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.name, 'Yamato');
  assert.equal(res.json.dojo.decor.boss.imageUrl, 'https://cdn.example/yamato.jpg');
  // La jaquette stockée est la vignette /medium/ (~100 px) : trop petite pour
  // la scène, l'URL doit être réécrite vers /large/ (même image, CDN AniList).
  assert.equal(res.json.dojo.decor.backgroundUrl, 'https://cdn.example/media/anime/cover/large/bx42.jpg');
});

test("GET /state : le portrait IA généré (DojoBossArt) prime sur le portrait AniList quand il existe", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: null },
  ];
  prisma.dojoBossArt.findUnique = async ({ where }) => (
    where.characterId_theme.characterId === 102
      ? { imageUrl: 'https://r2.example/dojo-boss-art/wood-102.png' }
      : null
  );
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.imageUrl, 'https://cdn.example/yamato.jpg'); // portrait AniList inchangé
  assert.equal(res.json.dojo.decor.boss.generatedImageUrl, 'https://r2.example/dojo-boss-art/wood-102.png');
});

test('GET /state : sans portrait IA généré, generatedImageUrl reste null (repli sur le portrait AniList)', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: null },
  ];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.generatedImageUrl, null);
});

test('GET /state : sans mythique en base (ou sans portrait), le décor reste utilisable sans gardien', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [{ id: 101, name: 'Sans imageUrl', imageUrl: null, seriesId: 1 }];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss, null);
  assert.equal(res.json.dojo.decor.backgroundUrl, null);
});

test('GET /state : le gardien du décor est mis en cache (pas de re-requête tant que le thème ne change pas)', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.dojoRecruit.count = async () => 1;
  let calls = 0;
  prisma.character.findMany = async () => { calls++; return [{ id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/y.jpg', seriesId: null }]; };
  await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(calls, 1);
});

test('GET /roster : liste les personnages recrutés (pas la collection gacha)', async () => {
  prisma.dojoRecruit.findMany = async () => [
    { characterId: 3, recruitedAt: new Date(), character: { id: 3, name: 'Roy', imageUrl: null, rarity: 'epic' } },
  ];
  const res = await app.request('/api/idle/roster', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.recruits.length, 1);
  assert.equal(res.json.recruits[0].name, 'Roy');
  assert.ok(res.json.recruits[0].role);
  assert.ok(res.json.recruits[0].talent?.description);
  assert.ok(res.json.recruits[0].combatSkill?.description);
  assert.ok(res.json.recruits[0].baseRate > 0);
});

test('passif de rareté : le pool propose plusieurs TYPES distincts, chaque personnage tire type+magnitude de façon stable (retour testeur : plus de RNG)', () => {
  const candidates=[
    {name:'Naruto Uzumaki',series:'Naruto'},{name:'Killua Zoldyck',series:'Hunter x Hunter'},
    {name:'Sasuke Uchiha',series:'Naruto'},{name:'Edward Elric',series:'FMA'},
    {name:'Levi Ackerman',series:'Attack on Titan'},{name:'Gojo Satoru',series:'Jujutsu Kaisen'},
  ];
  const entries=candidates.map((c)=>characterPassiveEntry(c,'rare'));
  for(const entry of entries)assert.ok(RARITY_PASSIVE_POOL.rare.includes(entry));
  // Le pool propose plusieurs TYPES qualitativement différents, pas juste
  // une magnitude différente sur un seul type partagé par tous.
  assert.ok(new Set(entries.map((e)=>e.key)).size>1);
  candidates.forEach((c,i)=>{
    const magnitude=characterPassiveMagnitude(c,'rare');
    assert.ok(magnitude>=entries[i].min&&magnitude<=entries[i].max);
  });
  // Stable : même personnage ⇒ même tirage (type ET magnitude) à chaque appel
  assert.equal(characterPassiveEntry(candidates[0],'rare'),entries[0]);
  assert.equal(characterPassiveMagnitude(candidates[0],'rare'),characterPassiveMagnitude(candidates[0],'rare'));
  // common n'a pas de bonus mécanique
  assert.equal(characterPassiveEntry(candidates[0],'common'),null);
  assert.equal(characterPassiveBonus(candidates[0],'common','prodSelf'),0);
});

test('passif de rareté : la description reflète le type et la magnitude réellement tirés pour ce personnage', () => {
  const character={name:'Sasuke Uchiha',series:'Naruto'};
  const entry=characterPassiveEntry(character,'epic');
  const desc=characterPassiveDescription(character,'epic');
  assert.ok(desc.startsWith(`${entry.label} ·`));
  const magnitude=characterPassiveMagnitude(character,'epic');
  const percent=Math.round(magnitude*1000)/10;
  assert.ok(desc.includes(String(percent)));
});

test('production : le passif de personnage (quel que soit son type tiré) s\'applique correctement à niveau/rôle égal (retour testeur : plus de RNG sur les passifs)', async () => {
  // Même rôle ('support', reconnu littéralement par roleForCharacter sur les
  // deux noms) ⇒ même Talent Permanent pour les deux ⇒ tout écart de
  // production à niveau/rareté égaux ne peut venir QUE du passif de rareté
  // de chacun — quel que soit le TYPE qu'il a tiré (prodSelf/prodTeam
  // affectent la production ; click/crit/cooldown ne l'affectent pas du
  // tout, auquel cas la production doit être strictement identique).
  const sakura={id:1,name:'Sakura Haruno',series:'Naruto',rarity:'rare'};
  const orihime={id:2,name:'Orihime Inoue',series:'Bleach',rarity:'rare'};
  const user=dbUser();
  prisma.user.findUnique=async()=>user;
  const rateFor={};
  for(const character of [sakura,orihime]){
    prisma.idleSlot.findMany=async()=>[{id:10,userId:'u1',slotIndex:0,level:10,characterId:character.id,character}];
    const res=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
    rateFor[character.name]=res.json.totalRate;
  }
  const prodEffect=(character)=>{
    const entry=characterPassiveEntry(character,'rare');
    if(!entry||(entry.stat!=='prodSelf'&&entry.stat!=='prodTeam'))return 0;
    return characterPassiveMagnitude(character,'rare');
  };
  const observedRatio=rateFor[sakura.name]/rateFor[orihime.name];
  const expectedRatio=(1+prodEffect(sakura))/(1+prodEffect(orihime));
  assert.ok(Math.abs(observedRatio-expectedRatio)<1e-6);
});

test('clic : le passif "click" d\'un personnage actif de niveau 10+ augmente les dégâts de clic (retour testeur : types de passifs variés)', async () => {
  // Cherche un personnage synthétique dont le tirage tombe sur le type
  // 'click' du pool rare — le pool contenant aussi prodSelf/crit, il faut
  // trouver un nom qui roule spécifiquement sur 'click' pour ce test.
  let clickCharacter=null;
  for(let i=0;i<2000;i++){
    const candidate={name:`Perso Passif Test ${i}`,series:'Univers de Test'};
    if(characterPassiveEntry(candidate,'rare')?.stat==='click'){clickCharacter=candidate;break;}
  }
  assert.ok(clickCharacter,'aucun personnage synthétique ne tire le type "click" — pool ou hash a changé ?');
  const character={...clickCharacter,id:1,rarity:'rare'};
  const originalRandom=Math.random;
  Math.random=()=>0.99; // neutralise les critiques (aléatoires) pour isoler le seul effet du passif
  try{
    // Cookie sur un userId dédié : le budget de clic/seconde (store en
    // mémoire, clé userId+seconde courante) est partagé par TOUS les tests
    // qui utilisent 'u1' dans ce fichier — un userId à part évite de
    // consommer ce budget commun et de faire échouer un autre test de clic
    // qui tourne dans la même seconde.
    const withPassiveUser=dbUser({id:'u-passive-click',idleClickLevel:2,idleStage:9,idleEnemyHp:enemyMaxHp(9)});
    prisma.user.findUnique=async()=>withPassiveUser;
    prisma.idleSlot.findMany=async()=>[{id:10,userId:'u-passive-click',slotIndex:0,level:10,characterId:1,character}];
    prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')withPassiveUser.idleEnemyHp=data.idleEnemyHp;return withPassiveUser;};
    const withRes=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u-passive-click'),body:{requestId:'click-passive-with-0001'}});

    const withoutPassiveUser=dbUser({id:'u-passive-click-2',idleClickLevel:2,idleStage:9,idleEnemyHp:enemyMaxHp(9)});
    prisma.user.findUnique=async()=>withoutPassiveUser;
    prisma.idleSlot.findMany=async()=>[]; // aucun personnage actif : pas de passif d'équipe
    prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')withoutPassiveUser.idleEnemyHp=data.idleEnemyHp;return withoutPassiveUser;};
    const withoutRes=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u-passive-click-2'),body:{requestId:'click-passive-without-0001'}});

    assert.equal(withRes.status,200);assert.equal(withoutRes.status,200);
    assert.equal(withRes.json.critical,false);assert.equal(withoutRes.json.critical,false); // confirme la neutralisation du hasard
    assert.ok(withRes.json.damage>withoutRes.json.damage);
  }finally{Math.random=originalRandom;}
});

test('recruit : refuse si Sceaux insuffisants, sinon débite selon recruitCost et crée une ligne DojoRecruit', async () => {
  const cost = recruitCost(0);
  const poor = dbUser({ idleSeals: cost - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.user.update = async () => poor;
  const poorRes = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisants?/);

  const rich = dbUser({ idleSeals: cost });
  prisma.user.findUnique = async () => rich;
  prisma.user.update = async () => rich;
  let sealDebit=null;
  prisma.user.updateMany = async (args) => { sealDebit=args.data; return { count: 1 }; };
  prisma.dojoRecruit.findMany = async () => [];
  prisma.character.findMany = async () => [{ id: 5, name: 'Nouvelle Recrue', imageUrl: null, rarity: 'common' }];
  let created = null;
  prisma.dojoRecruit.create = async (args) => { created = args.data; return args.data; };
  const okRes = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(created.userId, 'u1');
  assert.equal(created.characterId, 5);
  assert.equal(okRes.json.recruited.name, 'Nouvelle Recrue');
  assert.equal(sealDebit.idleEssenceRecruitCount,undefined);
});

test('recruit : la débite des Sceaux est atomique (refuse si une autre requête a déjà consommé le solde)', async () => {
  // Couvre la garde ajoutée (idleSeals:{gte:cost}) : si updateMany ne trouve
  // plus de ligne correspondante (solde déjà consommé par une requête
  // concurrente), la recrue ne doit jamais être créée.
  const cost = recruitCost(0);
  const rich = dbUser({ idleSeals: cost });
  prisma.user.findUnique = async () => rich;
  prisma.user.update = async () => rich;
  prisma.user.updateMany = async () => ({ count: 0 });
  prisma.dojoRecruit.findMany = async () => [];
  prisma.character.findMany = async () => [{ id: 5, name: 'Nouvelle Recrue', imageUrl: null, rarity: 'common' }];
  let created = false;
  prisma.dojoRecruit.create = async () => { created = true; return {}; };
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /insuffisants?/);
  assert.equal(created, false);
});

test('recruit : accepte l Essence et la débite atomiquement', async () => {
  const cost = recruitEssenceCost(0);
  let user = dbUser({ idleSeals:0,essence:cost });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.character.findMany = async () => [{ id:6,name:'Invocation Essence',imageUrl:null,rarity:'rare' }];
  prisma.dojoRecruit.create = async () => ({});
  let debit = null;
  prisma.user.updateMany = async ({ data }) => {
    debit = data;
    user = { ...user, essence:user.essence-cost };
    return { count: 1 };
  };

  const res = await app.request('/api/idle/recruit', { method:'POST',cookie:app.authCookie('u1'),body:{currency:'essence'} });
  assert.equal(res.status, 200);
  assert.equal(res.json.payment.currency,'essence');
  assert.equal(res.json.payment.cost, cost);
  assert.deepEqual(debit.essence,{decrement:cost});
  assert.deepEqual(debit.idleEssenceRecruitCount,{increment:1});
  assert.equal(res.json.recruit.essenceBalance,0);
});

test('recruit : les Sceaux ne font jamais augmenter le prochain prix en Essence', async () => {
  const user=dbUser({idleSeals:1,idleEssenceRecruitCount:4});
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async()=>user;
  prisma.dojoRecruit.findMany=async()=>[];
  prisma.character.findMany=async()=>[{id:7,name:'Invocation Sceau',imageUrl:null,rarity:'rare'}];
  prisma.dojoRecruit.create=async()=>({});
  const before=recruitEssenceCost(user.idleEssenceRecruitCount);
  const res=await app.request('/api/idle/recruit',{method:'POST',cookie:app.authCookie('u1'),body:{currency:'seals'}});
  assert.equal(res.status,200);
  assert.equal(res.json.recruit.essenceCost,before);
  assert.equal(res.json.recruit.essenceRecruitCount,4);
});

test('recruit : refuse l Essence insuffisante sans consommer de Sceau', async () => {
  const user = dbUser({idleSeals:99,essence:recruitEssenceCost(0)-1});
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/recruit', {method:'POST',cookie:app.authCookie('u1'),body:{currency:'essence'}});
  assert.equal(res.status, 400);
  assert.match(res.json.error,/Essence insuffisante/);
  assert.equal(user.idleSeals, 99);
});

test('recruit : exclut les personnages déjà recrutés et retombe sur une autre rareté si celle tirée est épuisée', async () => {
  const user = dbUser({ idleSeals: recruitCost(0) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [{ characterId: 1 }]; // déjà tout recruté dans la rareté tirée
  // Le mock répond systématiquement vide pour la rareté tirée en 1er, mais
  // renvoie un candidat pour n'importe quelle autre — vérifie juste que la
  // route ne plante pas et retombe bien sur un résultat non vide.
  let firstCall = true;
  prisma.character.findMany = async ({ where }) => {
    if (firstCall) { firstCall = false; return []; }
    return where.rarity === 'rare' ? [{ id: 9, name: 'Repli', imageUrl: null, rarity: 'rare' }] : [];
  };
  let created = null;
  prisma.dojoRecruit.create = async (args) => { created = args.data; return args.data; };
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(created.characterId, 9);
});

test('recruit : refuse proprement si tout le pool est déjà recruté', async () => {
  const user = dbUser({ idleSeals: recruitCost(0) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [{ characterId: 1 }];
  prisma.character.findMany = async () => [];
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /roster disponible/);
});

test('slot-level : refuse un emplacement vide, sinon débite selon charLevelUpCost et incrémente le niveau', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.idleSlot.findUnique = async () => null;
  const emptyRes = await app.request('/api/idle/slot-level', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(emptyRes.status, 400);
  assert.match(emptyRes.json.error, /vide/);

  const cost = charLevelUpCost('rare', 1);
  const rich = dbUser({ essence: cost });
  prisma.user.findUnique = async () => rich;
  prisma.user.update = async () => rich;
  prisma.idleSlot.findUnique = async () => ({ id: 9, userId: 'u1', slotIndex: 0, characterId: 7, level: 1, character: { rarity: 'rare' } });
  const writes = [];
  prisma.idleSlot.update = async (args) => { writes.push(args); return {}; };
  const okRes = await app.request('/api/idle/slot-level', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(okRes.status, 200);
  assert.equal(writes[0].where.id, 9);
  assert.equal(writes[0].data.level.increment, 1);
});

test('slot-ascend : seuil progressif et niveaux conservés pendant la run', async () => {
  // Coût d'ascension désormais indexé sur le coût de niveau au palier requis
  // (≈ 12 niveaux à L100), soit de l'ordre du milliard pour un rare.
  const user = dbUser({ essence: 1e12 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.idleSlot.findUnique = async () => ({ id:9,userId:'u1',slotIndex:0,characterId:7,level:HERO_ASCENSION_LEVEL-1,ascension:0,character:{rarity:'rare'} });
  const locked = await app.request('/api/idle/slot-ascend', {method:'POST',cookie:app.authCookie('u1'),body:{slotIndex:0}});
  assert.equal(locked.status,400);
  assert.match(locked.json.error,/Niveau 100 requis/);

  prisma.idleSlot.findUnique = async () => ({ id:9,userId:'u1',slotIndex:0,characterId:7,level:HERO_ASCENSION_LEVEL,ascension:0,character:{rarity:'rare'} });
  let slotWrite=null,recruitWrite=null;
  prisma.idleSlot.update = async (args) => { slotWrite=args;return {}; };
  prisma.dojoRecruit.update = async (args) => { recruitWrite=args;return {}; };
  const ok = await app.request('/api/idle/slot-ascend', {method:'POST',cookie:app.authCookie('u1'),body:{slotIndex:0}});
  assert.equal(ok.status,200);
  assert.equal(slotWrite.data.level,undefined);
  assert.equal(slotWrite.data.ascension.increment,1);
  assert.equal(recruitWrite.data.trainingLevel,undefined);
  assert.equal(recruitWrite.data.idleAscension.increment,1);

  prisma.idleSlot.findUnique = async () => ({ id:9,userId:'u1',slotIndex:0,characterId:7,level:heroAscensionRequiredLevel(1)-1,ascension:1,character:{rarity:'rare'} });
  const secondLocked = await app.request('/api/idle/slot-ascend', {method:'POST',cookie:app.authCookie('u1'),body:{slotIndex:0}});
  assert.equal(secondLocked.status,400);
  assert.match(secondLocked.json.error,/Niveau 110 requis/);
});

test('assign : refuse un emplacement verrouillé', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: START_SLOTS, characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /verrouillé/);
});

test('assign : refuse un personnage non recruté', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => null;
  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /recruté/);
});

test('assign : succès → déplace le personnage hors de son ancien emplacement puis l\'assigne', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 7 });
  prisma.idleSlot.findUnique = async () => null; // emplacement vide avant l'assignation
  const writes = [];
  prisma.idleSlot.updateMany = async (args) => { writes.push(['updateMany', args]); return { count: 1 }; };
  prisma.idleSlot.upsert = async (args) => { writes.push(['upsert', args]); return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 1, characterId: 7 },
  });
  assert.equal(res.status, 200);
  assert.equal(writes[0][0], 'updateMany');
  assert.equal(writes[0][1].where.characterId, 7);
  assert.equal(writes[0][1].where.slotIndex.not, 1);
  assert.equal(writes[1][0], 'upsert');
  assert.equal(writes[1][1].create.characterId, 7);
  assert.equal(writes[1][1].create.slotIndex, 1);
});

test('chef d’équipe : mémorise un personnage actif sans modifier ses bonus', async () => {
  let user = dbUser();
  const character = { id:7, name:'Dova', series:'JoJo', rarity:'epic', imageUrl:null };
  const slot = { id:9, userId:'u1', slotIndex:1, characterId:7, level:12, ascension:0, assignedAt:new Date(), character, equipments:[], items:[] };
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findFirst = async ({ where }) => where.characterId===7 ? { id:slot.id } : null;
  prisma.idleSlot.findMany = async () => [slot];
  prisma.dojoRecruit.count = async () => 1;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.user.update = async ({ data }) => {
    if (data.idleLeaderCharacterId !== undefined) user = { ...user, idleLeaderCharacterId:data.idleLeaderCharacterId };
    return user;
  };
  const res = await app.request('/api/idle/team-leader', {
    method:'POST', cookie:app.authCookie('u1'), body:{ characterId:7 },
  });
  assert.equal(res.status, 200);
  assert.equal(user.idleLeaderCharacterId, 7);
  assert.equal(res.json.strategy.leaderCharacterId, 7);
  const milestones=res.json.slots.find((item)=>item.character?.id===7).character.milestones;
  assert.match(milestones[0].effect,/passif/i);
  assert.equal(milestones[1].cumulativeMultiplier,4);
});

test('navigation : revient sur un niveau débloqué en mode Farm puis reprend au maximum', async () => {
  let user=dbUser({idleStage:12,idleRunBestStage:12,idleBestStage:12,idleBattleMode:'progress',idleEnemyHp:enemyMaxHp(12)});
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async({data})=>{user={...user,...data};return user;};
  const previous=await app.request('/api/idle/stage',{method:'POST',cookie:app.authCookie('u1'),body:{stage:5}});
  assert.equal(previous.status,200);
  assert.equal(user.idleStage,5);
  assert.equal(user.idleBattleMode,'farm');
  assert.equal(previous.json.battle.stage,5);
  assert.equal(previous.json.battle.mode,'farm');

  const maximum=await app.request('/api/idle/stage',{method:'POST',cookie:app.authCookie('u1'),body:{stage:12}});
  assert.equal(maximum.status,200);
  assert.equal(user.idleBattleMode,'progress');
  assert.equal(maximum.json.battle.stage,12);
});

test("assign : remplacer un AUTRE personnage sur un emplacement déjà occupé remet le niveau à 1 (sinon héritage gratuit de puissance)", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 9 });
  prisma.idleSlot.findUnique = async () => ({ id: 5, userId: 'u1', slotIndex: 0, characterId: 3, level: 50 }); // occupant précédent, niveau 50
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  let upsertArgs = null;
  prisma.idleSlot.upsert = async (args) => { upsertArgs = args; return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 9 },
  });
  assert.equal(res.status, 200);
  assert.equal(upsertArgs.update.level, 1);
});

test('hero-awaken : débite de l’ESSENCE (pas des Sceaux) et incrémente les étoiles', async () => {
  const user = dbUser({ essence: 1e9, idleSeals: 0, idleBestStage: 50, idleStage: 50 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 7, awakenStars: 0, character: { rarity: 'rare' } });
  let debitArgs = null;
  prisma.user.updateMany = async (args) => { debitArgs = args; return { count: 1 }; };
  let upgradeArgs = null;
  prisma.dojoRecruit.updateMany = async (args) => { upgradeArgs = args; return { count: 1 }; };

  const res = await app.request('/api/idle/hero-awaken', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 7 },
  });
  assert.equal(res.status, 200);
  assert.ok('essence' in debitArgs.where, 'la garde optimiste porte sur le solde en essence');
  assert.equal('idleSeals' in debitArgs.where, false, 'les Sceaux ne doivent plus être touchés');
  assert.ok(debitArgs.data.essence.decrement > 0);
  assert.equal(upgradeArgs.data.awakenStars.increment, 1);
  assert.equal(res.json.awaken.stars, 1);
});

test('hero-awaken : refuse si l’essence est insuffisante', async () => {
  const user = dbUser({ essence: 0, idleBestStage: 50, idleStage: 50 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 7, awakenStars: 0, character: { rarity: 'rare' } });
  prisma.user.updateMany = async () => ({ count: 0 });
  const res = await app.request('/api/idle/hero-awaken', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 7 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Essence insuffisante/);
});

test('assign : réassigner un personnage restaure son niveau propre', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 3,trainingLevel:50,idleAscension:2 });
  prisma.idleSlot.findUnique = async () => ({ id: 5, userId: 'u1', slotIndex: 0, characterId: 3, level: 50 });
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  let upsertArgs = null;
  prisma.idleSlot.upsert = async (args) => { upsertArgs = args; return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 3 },
  });
  assert.equal(res.status, 200);
  assert.equal(upsertArgs.update.level, 50);
  assert.equal(upsertArgs.update.ascension, 2);
});

test('unassign : vide un emplacement', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  let cleared = null;
  prisma.idleSlot.updateMany = async (args) => { cleared = args; return { count: 1 }; };
  const res = await app.request('/api/idle/unassign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(res.status, 200);
  assert.equal(cleared.where.slotIndex, 0);
  assert.equal(cleared.data.characterId, null);
});

test('upgrade prod : refuse si essence insuffisante, sinon débite et incrémente le niveau', async () => {
  const cost = prodUpgradeCost(0);
  const poor = dbUser({ essence: cost - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.user.update = async () => poor;
  const poorRes = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'prod' },
  });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisante/);

  const rich = dbUser({ essence: cost });
  prisma.user.findUnique = async () => rich;
  let updateData = null;
  prisma.user.update = async (args) => {
    if (args.data.idleProdLevel) updateData = args.data;
    return { ...rich, ...(args.data.essence ? { essence: rich.essence } : {}) };
  };
  const okRes = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'prod' },
  });
  assert.equal(okRes.status, 200);
  assert.equal(updateData.essence.decrement, cost);
  assert.equal(updateData.idleProdLevel.increment, 1);
});

test('upgrade slot : refuse une fois tous les emplacements débloqués', async () => {
  const user = dbUser({ idleSlotsUnlocked: MAX_SLOTS, essence: 999999 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'slot' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /débloqués/);
});

test('upgrade click : coût suit clickUpgradeCost', async () => {
  const cost = clickUpgradeCost(0);
  const user = dbUser({ essence: cost });
  prisma.user.findUnique = async () => user;
  let updateData = null;
  prisma.user.update = async (args) => {
    if (args.data.idleClickLevel) updateData = args.data;
    return user;
  };
  const res = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'click' },
  });
  assert.equal(res.status, 200);
  assert.equal(updateData.essence.decrement, cost);
});

test('upgrade crit : débite le coût et augmente Instinct', async () => {
  const cost=critUpgradeCost(0);const user=dbUser({essence:cost});let updateData=null;
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async(args)=>{if(args.data.idleCritLevel)updateData=args.data;return user;};
  const res=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'crit'}});
  assert.equal(res.status,200);assert.equal(updateData.essence.decrement,cost);assert.equal(updateData.idleCritLevel.increment,1);
});

test('upgrade cooldown : débite le coût et augmente Flux', async () => {
  const cost=cooldownUpgradeCost(0);const user=dbUser({essence:cost});let updateData=null;
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async(args)=>{if(args.data.idleCooldownLevel)updateData=args.data;return user;};
  const res=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'cooldown'}});
  assert.equal(res.status,200);assert.equal(updateData.essence.decrement,cost);assert.equal(updateData.idleCooldownLevel.increment,1);
});

test('upgrade multistrike : débite le coût et augmente Frappes Multiples', async () => {
  const cost=multiStrikeUpgradeCost(0);const user=dbUser({essence:cost});let updateData=null;
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async(args)=>{if(args.data.idleMultiStrikeLevel)updateData=args.data;return user;};
  const res=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'multistrike'}});
  assert.equal(res.status,200);assert.equal(updateData.essence.decrement,cost);assert.equal(updateData.idleMultiStrikeLevel.increment,1);
});

test('upgrade prod : amount=5 achète 5 niveaux au prix exact, tout ou rien', async () => {
  const exactCost=[0,1,2,3,4].reduce((sum,lvl)=>sum+prodUpgradeCost(lvl),0);
  const poor=dbUser({essence:exactCost-1});let updateData=null;
  prisma.user.findUnique=async()=>poor;
  prisma.user.update=async(args)=>{if(args.data.idleProdLevel)updateData=args.data;return poor;};
  const poorRes=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'prod',amount:5}});
  assert.equal(poorRes.status,400); // pas de niveau partiel : le lot de 5 coûte tout ou rien
  assert.equal(updateData,null);

  const rich=dbUser({essence:exactCost});
  prisma.user.findUnique=async()=>rich;
  prisma.user.update=async(args)=>{if(args.data.idleProdLevel)updateData=args.data;return rich;};
  const res=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'prod',amount:5}});
  assert.equal(res.status,200);
  assert.equal(updateData.essence.decrement,exactCost);
  assert.equal(updateData.idleProdLevel.increment,5);
});

test('upgrade click : amount=max achète autant de niveaux que le budget permet', async () => {
  const twoLevels=clickUpgradeCost(0)+clickUpgradeCost(1);
  const user=dbUser({essence:twoLevels+5}); // pas assez pour un 3e niveau
  let updateData=null;
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async(args)=>{if(args.data.idleClickLevel)updateData=args.data;return user;};
  const res=await app.request('/api/idle/upgrade',{method:'POST',cookie:app.authCookie('u1'),body:{type:'click',amount:'max'}});
  assert.equal(res.status,200);
  assert.equal(updateData.idleClickLevel.increment,2);
  assert.equal(updateData.essence.decrement,twoLevels);
});

test('collect : crédite la production en attente et avance idleLastCollectAt', async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: anHourAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 5, character: { id: 5, name: 'X', imageUrl: null, rarity: 'rare' } },
  ];
  let increment = null;
  prisma.user.update = async (args) => {
    if (args.data.essence) increment = args.data.essence.increment;
    return { ...user, essence: user.essence + (increment || 0) };
  };
  const res = await app.request('/api/idle/collect', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.ok(increment > 0);
});

test('collect : retente proprement si une autre requête a déjà encaissé la même période', async () => {
  const user = dbUser({ idleLastCollectAt: new Date(Date.now() - 1000) });
  prisma.user.findUnique = async () => user;
  let calls = 0;
  prisma.user.update = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('conflit optimiste'), { code: 'P2025' });
    return user;
  };
  const res = await app.request('/api/idle/collect', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('click : inflige des dégâts autoritaires au gardien', async () => {
  let user = dbUser({ idleClickLevel: 3,idleStage:9,idleEnemyHp:enemyMaxHp(9) });
  prisma.user.findUnique = async () => user;
  let damageWrite=null;
  prisma.user.update = async (args) => {
    if(typeof args.data.idleEnemyHp==='number'){
      damageWrite=args.data;
      user={...user,idleEnemyHp:args.data.idleEnemyHp};
    }
    return user;
  };
  const res = await app.request('/api/idle/click', { method: 'POST', cookie: app.authCookie('u1'), body: {requestId:'click-test-0001'} });
  assert.equal(res.status, 200);
  assert.ok(res.json.damage > 0);
  assert.equal(res.json.passiveKills,0);
  assert.ok(damageWrite&&Number.isFinite(damageWrite.idleEnemyHp));
});

test('click : accepte une cadence de clicker sans 429 immédiat', async () => {
  let user = dbUser({ idleClickLevel: 1, idleStage: 9, idleEnemyHp: enemyMaxHp(9) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async ({ data }) => {
    if (typeof data.idleEnemyHp === 'number') user = { ...user, idleEnemyHp: data.idleEnemyHp };
    return user;
  };
  for (let i = 0; i < 5; i++) {
    const res = await app.request('/api/idle/click', { method: 'POST', cookie: app.authCookie('u1'), body: {requestId:`click-rate-000${i}`} });
    assert.equal(res.status, 200);
  }
});

test('click : regroupe plusieurs frappes dans une seule requête autoritaire', async () => {
  let user=dbUser({idleClickLevel:2,idleStage:3,idleEnemyHp:enemyMaxHp(3)});
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')user={...user,idleEnemyHp:data.idleEnemyHp,idleStage:data.idleStage};return user;};
  const res=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u1'),body:{count:5,requestId:'click-batch-0001'}});
  assert.equal(res.status,200);
  assert.equal(res.json.count,5);
  assert.ok(res.json.damage>=5);
});

test('click : Frappes Multiples augmente les dégâts simulés sans changer le compteur de clics (retour testeur)', async () => {
  const stage=99; // stage élevé mais hors vague de Boss (cf. gate idleBossEngaged), sinon le clic n'inflige plus rien tant que non engagé
  const originalRandom=Math.random;
  Math.random=()=>0.99; // neutralise les critiques (aléatoires) : sans ça, un crit chanceux sur le seul coup du baseline peut ponctuellement dépasser 2 coups non-crit du boosté
  try{
    const baseline=dbUser({id:'u-ms-base',idleClickLevel:2,idleMultiStrikeLevel:0,idleStage:stage,idleEnemyHp:enemyMaxHp(stage)});
    prisma.user.findUnique=async()=>baseline;
    prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')baseline.idleEnemyHp=data.idleEnemyHp;return baseline;};
    const baseRes=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u1'),body:{count:1,requestId:'click-ms-base-0001'}});
    assert.equal(baseRes.status,200);
    assert.equal(baseRes.json.count,1);

    const boosted=dbUser({id:'u-ms-boost',idleClickLevel:2,idleMultiStrikeLevel:20,idleStage:stage,idleEnemyHp:enemyMaxHp(stage)});
    prisma.user.findUnique=async()=>boosted;
    prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')boosted.idleEnemyHp=data.idleEnemyHp;return boosted;};
    const boostedRes=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u1'),body:{count:1,requestId:'click-ms-boost-0001'}});
    assert.equal(boostedRes.status,200);
    // Le compteur de clics physiques (quêtes) ne bouge pas...
    assert.equal(boostedRes.json.count,1);
    // ...mais les dégâts simulés augmentent (2 frappes de combat pour 1 tap au niveau max).
    assert.ok(boostedRes.json.damage>baseRes.json.damage);
  }finally{Math.random=originalRandom;}
});

test('click : rejouer le même requestId ne réapplique jamais les dégâts', async () => {
  let user=dbUser({id:'u-dedup',idleClickLevel:2,idleStage:4,idleEnemyHp:enemyMaxHp(4)});
  prisma.user.findUnique=async()=>user;
  let writes=0;
  prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number'){writes++;user={...user,idleEnemyHp:data.idleEnemyHp,idleStage:data.idleStage||user.idleStage};}return user;};
  const request={method:'POST',cookie:app.authCookie('u-dedup'),body:{count:3,requestId:'click-dedup-0001'}};
  const first=await app.request('/api/idle/click',request);
  const writesAfterFirst=writes;
  const second=await app.request('/api/idle/click',request);
  assert.equal(first.status,200);
  assert.equal(second.status,200);
  assert.equal(second.json.duplicate,true);
  assert.ok(writesAfterFirst>0);
  assert.equal(writes,writesAfterFirst);
});

test('feedback bêta : conserve le message et son contexte', async () => {
  prisma.user.findUnique=async()=>dbUser({roles:['idle_beta']});
  let created=null;
  prisma.idleFeedback.create=async({data})=>{created=data;return{id:1,...data};};
  const res=await app.request('/api/idle/feedback',{method:'POST',cookie:app.authCookie('u1'),body:{message:'Le bouton de boss reste bloqué.',context:'{"stage":20}'}});
  assert.equal(res.status,201);
  assert.equal(created.userId,'u1');
  assert.match(created.message,/boss/);
});

test('mode Farm : exige une confirmation explicite avant de bloquer la progression', async () => {
  prisma.user.findUnique=async()=>dbUser({roles:['idle_beta']});
  const res=await app.request('/api/idle/battle-mode',{method:'POST',cookie:app.authCookie('u1'),body:{mode:'farm'}});
  assert.equal(res.status,400);
  assert.match(res.json.error,/Confirme/);
});

test('claim-milestone : refuse si rien à réclamer, sinon crédite la récompense et avance idleMilestoneClaimed', async () => {
  const noneYet = dbUser({ idleRankLevel:1 }); // niveau 1, aucun palier atteint
  prisma.user.findUnique = async () => noneYet;
  prisma.user.update = async () => noneYet;
  const refusedRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(refusedRes.status, 400);
  assert.match(refusedRes.json.error, /coffre/);

  const tier = milestoneTierForLevel(5);
  const eligible = dbUser({ idleRankLevel:5 });
  prisma.user.findUnique = async () => eligible;
  let updateData = null;
  prisma.user.update = async (args) => { updateData = args.data; return eligible; };
  const okRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(updateData.essence.increment, milestoneReward(tier));
  assert.equal(updateData.idleMilestoneClaimed, tier);
});

test('claim-milestone : un palier déjà réclamé ne peut pas l\'être une seconde fois', async () => {
  const tier = milestoneTierForLevel(5);
  const already = dbUser({ idleRankLevel:5, idleMilestoneClaimed: tier });
  prisma.user.findUnique = async () => already;
  prisma.user.update = async () => already;
  const res = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 400);
});

test('prestige : refuse sous le niveau minimum, sinon reset la run (essence/emplacements/améliorations), incrémente prestigeLevel et crédite la Sagesse', async () => {
  const tooLow = dbUser({ essenceEarnedTotal: 0 });
  prisma.user.findUnique = async () => tooLow;
  prisma.user.update = async () => tooLow;
  const lowRes = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(lowRes.status, 400);

  const eligible = dbUser({
    idleRunBestStage:prestigeRequiredStage(1), idleBestStage:prestigeRequiredStage(1), essence: 5000, idleProdLevel: 10, idleClickLevel: 5, idleSlotsUnlocked: 8, prestigeLevel: 1,
  });
  prisma.user.findUnique = async () => eligible;
  const slotsReset = [];
  let recruitsReset = null;
  let userUpdate = null;
  let runHistory = null;
  prisma.idleSlot.updateMany = async (args) => { slotsReset.push(args); return { count: 3 }; };
  prisma.dojoRecruit.updateMany = async (args) => { recruitsReset = args; return { count: 3 }; };
  prisma.idleRunHistory.create = async (args) => { runHistory=args.data;return {id:1,...args.data}; };
  prisma.user.update = async (args) => { userUpdate = args.data; return eligible; };
  let tokenTx = null;
  prisma.tokenTransaction.create = async (args) => { tokenTx = args.data; return { id: 1, ...args.data }; };
  const okRes = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(slotsReset.length, 2);
  assert.deepEqual(slotsReset[0].where, { userId:'u1', slotIndex:{ lt:START_SLOTS } });
  assert.equal(slotsReset[0].data.characterId, undefined);
  assert.equal(slotsReset[0].data.level, 1);
  assert.equal(slotsReset[0].data.ascension, 0);
  assert.deepEqual(slotsReset[1].where, { userId:'u1', slotIndex:{ gte:START_SLOTS } });
  assert.equal(slotsReset[1].data.characterId, null);
  assert.equal(recruitsReset.data.trainingLevel, 1);
  assert.equal(recruitsReset.data.idleAscension, 0);
  assert.equal(runHistory.bestStage, prestigeRequiredStage(1));
  assert.equal(runHistory.prestigeLevel, 2);
  assert.ok(runHistory.durationSeconds > 0);
  assert.equal(userUpdate.essence, 0);
  assert.equal(userUpdate.idleSlotsUnlocked, START_SLOTS);
  // Mémoire du Maître (fast-start) : la nouvelle run (Prestige 2 ici) démarre
  // avec 2 niveaux gratuits de Discipline/Concentration par Prestige.
  assert.equal(userUpdate.idleProdLevel, prestigeStartingLevels(2));
  assert.equal(userUpdate.idleClickLevel, prestigeStartingLevels(2));
  assert.equal(userUpdate.idleProdLevel, 4);
  assert.equal(userUpdate.idleCritLevel, 0);
  assert.equal(userUpdate.idleCooldownLevel, 0);
  assert.equal(userUpdate.idleRunBlessings, '');
  assert.ok(userUpdate.idleRunStartedAt instanceof Date);
  assert.equal(userUpdate.prestigeLevel.increment, 1);
  assert.equal(userUpdate.essenceEarnedTotal, undefined); // le niveau du Dojo (le lieu) n'est jamais reset
  // Plus de multiplicateur automatique : la Sagesse gagnée dépend du niveau
  // du Dojo AU MOMENT du Prestige, à dépenser ensuite dans les Ancients.
  assert.equal(userUpdate.wisdomPoints.increment, wisdomForRunStage(prestigeRequiredStage(1),1));
  assert.equal(userUpdate.idleEssenceRecruitCount, 0); // le prix d'invocation en Essence redescend au Prestige
  assert.equal(userUpdate.idleStage,1);
  assert.equal(userUpdate.idleRunBestStage,1);
  // Tokens gacha : croissants avec le niveau de Prestige atteint (ici Prestige 2).
  assert.equal(userUpdate.tokens.increment, 140);
  assert.equal(tokenTx.amount, 140);
  assert.equal(tokenTx.reason, 'idle_prestige');
});

test("prestige : solde la production en attente AVANT le reset — elle compte dans l'XP du Dojo au lieu d'être perdue", async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const eligible = dbUser({ idleRunBestStage:PRESTIGE_MIN_STAGE,idleBestStage:PRESTIGE_MIN_STAGE,idleStage:9,idleBattleMode:'farm',idleEnemyHp:enemyMaxHp(9), idleLastCollectAt: anHourAgo });
  prisma.user.findUnique = async () => eligible;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 42, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  prisma.idleSlot.updateMany = async () => ({ count: 1 });
  const updateCalls = [];
  prisma.user.update = async (args) => { updateCalls.push(args.data); return eligible; };
  prisma.tokenTransaction.create = async (args) => ({ id: 1, ...args.data });
  const res = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  // 1er appel = solde de la production en attente (avant le reset) : doit créditer essenceEarnedTotal.
  assert.ok(updateCalls[0].essenceEarnedTotal.increment > 0);
  // Le compteur d'épreuve de combat peut s'intercaler après le règlement.
  const resetCall = updateCalls.find((data) => data.essence === 0);
  assert.ok(resetCall);
  assert.equal(resetCall.essenceEarnedTotal, undefined);
});

test('prestige : une même run ne peut pas être encaissée deux fois', async () => {
  let user = dbUser({ idleStage: PRESTIGE_MIN_STAGE, idleRunBestStage: PRESTIGE_MIN_STAGE, idleBestStage: PRESTIGE_MIN_STAGE });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  prisma.user.update = async ({ data }) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) user[key] = (user[key] || 0) + value.increment;
      else user[key] = value;
    }
    return user;
  };
  prisma.tokenTransaction.create = async (args) => ({ id: 1, ...args.data });
  const first = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  const second = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  assert.equal(user.prestigeLevel, 1);
  assert.equal(user.wisdomPoints, wisdomForRunStage(PRESTIGE_MIN_STAGE));
});

test('prestige : refuse une run trop courte même si le stage requis est déjà atteint',async()=>{
  const rushed=dbUser({id:'u2',idleStage:PRESTIGE_MIN_STAGE,idleRunBestStage:PRESTIGE_MIN_STAGE,idleBestStage:PRESTIGE_MIN_STAGE,idleRunStartedAt:new Date()});
  prisma.user.findUnique=async()=>rushed;prisma.user.update=async()=>rushed;prisma.idleSlot.updateMany=async()=>({count:0});
  const res=await app.request('/api/idle/prestige',{method:'POST',cookie:app.authCookie('u2'),body:{}});
  assert.equal(res.status,400);assert.match(res.json.error,/encore .* min/i);
});

test('roguelike : un choix se débloque au stage 21 et seuls les trois pouvoirs proposés sont acceptés',async()=>{
  let user=dbUser({idleStage:21,idleRunBestStage:21,idleBestStage:21});let written=null;
  prisma.user.findUnique=async(args={})=>args.select?Object.fromEntries(Object.keys(args.select).map((key)=>[key,user[key]])):user;
  prisma.user.update=async({data})=>{written=data;if(typeof data.idleRunBlessings==='string')user={...user,idleRunBlessings:data.idleRunBlessings};return user;};
  const state=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(state.status,200);const displayedKey=state.json.run.build.choices[0].key;
  const rejected=await app.request('/api/idle/run-blessing',{method:'POST',cookie:app.authCookie('u1'),body:{key:'pouvoir_triche'}});
  assert.equal(rejected.status,400);
  const accepted=await app.request('/api/idle/run-blessing',{method:'POST',cookie:app.authCookie('u1'),body:{key:displayedKey}});
  assert.equal(accepted.status,200);assert.equal(written.idleRunBlessings,displayedKey);
  const duplicate=await app.request('/api/idle/run-blessing',{method:'POST',cookie:app.authCookie('u1'),body:{key:displayedKey}});
  assert.equal(duplicate.status,400);
});

test('roguelike : le message de blocage reflète le vrai palier de stage, pas un combat de boss distinct (retour testeur)',async()=>{
  const user=dbUser({idleStage:5,idleRunBestStage:5,idleBestStage:5}); // aucun palier de bénédiction débloqué avant le stage 21
  prisma.user.findUnique=async(args={})=>args.select?Object.fromEntries(Object.keys(args.select).map((key)=>[key,user[key]])):user;
  prisma.user.update=async()=>user;
  const res=await app.request('/api/idle/run-blessing',{method:'POST',cookie:app.authCookie('u1'),body:{key:'berserker'}});
  assert.equal(res.status,400);
  assert.match(res.json.error,/stage 21/);
  assert.doesNotMatch(res.json.error,/gardien/);
});

test('roguelike : le reroll payant change l’offre de choix sans toucher aux bénédictions déjà choisies',async()=>{
  const cost=runBlessingRerollCost(0);
  let user=dbUser({idleStage:21,idleRunBestStage:21,idleBestStage:21,essence:cost});
  prisma.user.findUnique=async(args={})=>args.select?Object.fromEntries(Object.keys(args.select).map((key)=>[key,user[key]])):user;
  prisma.user.update=async({data})=>{user={...user,...(data.essence?.decrement!=null?{essence:user.essence-data.essence.decrement}:{}),...(data.idleRunBlessingRerolls?.increment!=null?{idleRunBlessingRerolls:(user.idleRunBlessingRerolls||0)+data.idleRunBlessingRerolls.increment}:{})};return user;};
  const before=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  const choicesBefore=before.json.run.build.choices.map((c)=>c.key);
  const reroll=await app.request('/api/idle/run-blessing/reroll',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(reroll.status,200);
  assert.equal(reroll.json.essence,0); // le coût exact a été débité
  assert.equal(reroll.json.run.build.choices.length,3);
  const choicesAfter=reroll.json.run.build.choices.map((c)=>c.key);
  assert.notDeepEqual(choicesAfter,choicesBefore); // l’offre change après reroll
});

test('roguelike : le reroll refuse si l’Essence est insuffisante ou si aucune bénédiction n’est disponible',async()=>{
  const poor=dbUser({idleStage:21,idleRunBestStage:21,idleBestStage:21,essence:runBlessingRerollCost(0)-1});
  prisma.user.findUnique=async(args={})=>args.select?Object.fromEntries(Object.keys(args.select).map((key)=>[key,poor[key]])):poor;
  prisma.user.update=async()=>poor;
  const poorRes=await app.request('/api/idle/run-blessing/reroll',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(poorRes.status,400);assert.match(poorRes.json.error,/Essence insuffisante/);

  const noneUnlocked=dbUser({idleStage:5,idleRunBestStage:5,idleBestStage:5,essence:1e9});
  prisma.user.findUnique=async(args={})=>args.select?Object.fromEntries(Object.keys(args.select).map((key)=>[key,noneUnlocked[key]])):noneUnlocked;
  prisma.user.update=async()=>noneUnlocked;
  const lockedRes=await app.request('/api/idle/run-blessing/reroll',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(lockedRes.status,400);assert.match(lockedRes.json.error,/stage 21/);
});

test('ancient : refuse une clé inconnue', async () => {
  const res = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key: 'inexistant' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invalide/);
});

test('ancient : refuse si Sagesse insuffisante, sinon débite selon ancientCost et crée/incrémente AncientLevel', async () => {
  const key = ANCIENTS[0].key;
  const poor = dbUser({ wisdomPoints: ancientCost(0) - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.ancientLevel.findUnique = async () => null; // jamais acheté → niveau 0
  prisma.user.updateMany = async () => ({ count:0 });
  const poorRes = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisante/);

  const rich = dbUser({ wisdomPoints: ancientCost(0) });
  prisma.user.findUnique = async () => rich;
  prisma.ancientLevel.findUnique = async () => null;
  let userDecrement = null;
  let createArgs = null;
  prisma.user.updateMany = async (args) => { userDecrement = args.data.wisdomPoints.decrement; return {count:1}; };
  prisma.ancientLevel.create = async (args) => { createArgs = args; return {}; };
  const okRes = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(okRes.status, 200);
  assert.equal(userDecrement, ancientCost(0));
  assert.equal(createArgs.data.ancientKey, key);
  assert.equal(createArgs.data.level, 1);
});

test('ancient : le coût du niveau suivant suit ancientCost(niveau actuel), pas ancientCost(0)', async () => {
  const key = ANCIENTS[0].key;
  const user = dbUser({ wisdomPoints: ancientCost(4) });
  prisma.user.findUnique = async () => user;
  prisma.ancientLevel.findUnique = async () => ({ level: 4 });
  let userDecrement = null;
  prisma.user.updateMany = async (args) => { userDecrement = args.data.wisdomPoints.decrement; return {count:1}; };
  prisma.ancientLevel.updateMany = async () => ({count:1});
  const res = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(res.status, 200);
  assert.equal(userDecrement, ancientCost(4));
});

test('ancient : un palier verrouillé refuse l’achat tant que le prérequis de branche n’est pas acheté',async()=>{
  const node=ANCIENTS.find((a)=>a.requires);assert.ok(node,'attendu au moins un palier avec prérequis');
  const user=dbUser({wisdomPoints:ancientCost(0)});prisma.user.findUnique=async()=>user;
  prisma.ancientLevel.findUnique=async({where})=>where.userId_ancientKey.ancientKey===node.requires?null:{level:0};
  const res=await app.request('/api/idle/ancient',{method:'POST',cookie:app.authCookie('u1'),body:{key:node.key}});
  assert.equal(res.status,400);assert.match(res.json.error,/requis/i);
});

test('ancient : un palier verrouillé s’achète normalement une fois le prérequis possédé',async()=>{
  const node=ANCIENTS.find((a)=>a.requires);
  const user=dbUser({wisdomPoints:ancientCost(0)});prisma.user.findUnique=async()=>user;
  prisma.ancientLevel.findUnique=async({where})=>where.userId_ancientKey.ancientKey===node.requires?{level:1}:null;
  let createArgs=null;prisma.user.updateMany=async()=>({count:1});prisma.ancientLevel.create=async(args)=>{createArgs=args;return{};};
  const res=await app.request('/api/idle/ancient',{method:'POST',cookie:app.authCookie('u1'),body:{key:node.key}});
  assert.equal(res.status,200);assert.equal(createArgs.data.ancientKey,node.key);
});

test('GET /state : chaque palier verrouillé indique son prérequis, tier1 toujours débloqué',async()=>{
  const user=dbUser({wisdomPoints:0});prisma.user.findUnique=async()=>user;
  prisma.ancientLevel.findMany=async()=>[];
  const res=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(res.status,200);
  const tier1=res.json.ancients.items.filter((it)=>!it.requires);
  assert.ok(tier1.length>0);tier1.forEach((it)=>assert.equal(it.unlocked,true));
  const locked=res.json.ancients.items.filter((it)=>it.requires);
  assert.ok(locked.length>0);locked.forEach((it)=>assert.equal(it.unlocked,false)); // rien acheté
});

test('rift/relic : refuse une relique qui n’est pas proposée, accepte celle qui l’est et vide l’offre',async()=>{
  const user=dbUser();prisma.user.findUnique=async()=>user;
  const relicKey=Object.keys(RIFT_RELICS)[0];const otherKey=Object.keys(RIFT_RELICS)[1];
  prisma.idleRiftRun.findUnique=async()=>({relics:[],pendingChoice:[relicKey,otherKey]});
  const rejected=await app.request('/api/idle/rift/relic',{method:'POST',cookie:app.authCookie('u1'),body:{key:Object.keys(RIFT_RELICS)[5]}});
  assert.equal(rejected.status,400);assert.match(rejected.json.error,/pas proposée/);
  let upsertArgs=null;prisma.idleRiftRun.upsert=async(args)=>{upsertArgs=args;return{};};
  const accepted=await app.request('/api/idle/rift/relic',{method:'POST',cookie:app.authCookie('u1'),body:{key:relicKey}});
  assert.equal(accepted.status,200);
  assert.deepEqual(upsertArgs.update.relics,[relicKey]);
  assert.deepEqual(upsertArgs.update.pendingChoice,[]);
});

test('rift/relic : refuse une clé de relique inconnue',async()=>{
  const res=await app.request('/api/idle/rift/relic',{method:'POST',cookie:app.authCookie('u1'),body:{key:'inexistant'}});
  assert.equal(res.status,400);assert.match(res.json.error,/invalide/);
});

test('claim-all : réclame en un appel tous les succès complétés et crédite les Sceaux une seule fois', async () => {
  // Stage 25 : complète « Chasseur de boss I » (cible 25) et « Voyageur des
  // mondes I » (cible 3 mondes découverts), sans toucher aux autres systèmes
  // (compteurs vides → aucune mission/défi/saison n'est complet).
  const user = dbUser({ idleBestStage: 25, idleStage: 25, prestigeLevel: 0 });
  prisma.user.findUnique = async () => user;
  prisma.idleMissionClaim.findMany = async () => [];
  let createManyData = null;
  prisma.idleMissionClaim.createMany = async (args) => { createManyData = args.data; return { count: args.data.length }; };
  let userUpdate = null;
  prisma.user.update = async (args) => { userUpdate = args.data; return user; };
  let tokenTx = null;
  prisma.tokenTransaction.create = async (args) => { tokenTx = args.data; return { id: 1, ...args.data }; };
  const res = await app.request('/api/idle/claim-all', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.claimed, 2);
  assert.equal(res.json.seals, 2);
  assert.equal(userUpdate.idleSeals.increment, 2);
  // Les deux succès complétés sont tous deux au palier I (tokenReward 25 chacun).
  assert.equal(res.json.tokens, 50);
  assert.equal(userUpdate.tokens.increment, 50);
  assert.equal(tokenTx.amount, 50);
  assert.equal(tokenTx.reason, 'idle_claim_all');
  assert.equal(createManyData.length, 2);
  assert.ok(createManyData.every((c) => c.userId === 'u1'));
  assert.ok(createManyData.some((c) => c.missionKey === 'achievement_boss_hunter_1' && c.period === 'lifetime'));
  assert.ok(createManyData.some((c) => c.missionKey === 'achievement_explorer_1' && c.period === 'lifetime'));
});

test('claim-all : ne réclame rien de plus si tout est déjà réclamé', async () => {
  const user = dbUser({ idleBestStage: 25, idleStage: 25 });
  prisma.user.findUnique = async () => user;
  prisma.idleMissionClaim.findMany = async () => [
    { missionKey: 'achievement_boss_hunter_1', period: 'lifetime' },
    { missionKey: 'achievement_explorer_1', period: 'lifetime' },
  ];
  let updateCalled = false;
  prisma.idleMissionClaim.createMany = async () => { updateCalled = true; return { count: 0 }; };
  const res = await app.request('/api/idle/claim-all', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.claimed, 0);
  assert.equal(updateCalled, false);
});

test('claim-all : ne crédite rien si une récompense concurrente a déjà créé une ligne', async () => {
  const user = dbUser({ idleBestStage:25,idleStage:25 });
  prisma.user.findUnique = async () => user;
  prisma.idleMissionClaim.findMany = async () => [];
  prisma.idleMissionClaim.createMany = async () => ({count:1}); // deux récompenses étaient attendues
  let credited=false;
  prisma.user.update = async () => { credited=true;return user; };
  const res=await app.request('/api/idle/claim-all',{method:'POST',cookie:app.authCookie('u1'),body:{}});
  assert.equal(res.status,409);
  assert.equal(credited,false);
});

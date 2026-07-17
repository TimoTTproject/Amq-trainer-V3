const test = require('node:test');
const assert = require('node:assert/strict');
const {
  START_SLOTS,
  MAX_SLOTS,
  slotRate,
  prodMultiplier,
  prodUpgradeCost,
  PROD_LEVEL_MAX,
  clickYield,
  clickUpgradeCost,
  CLICK_LEVEL_MAX,
  critUpgradeBonus,
  critUpgradeCost,
  CRIT_LEVEL_MAX,
  cooldownUpgradeBonus,
  cooldownUpgradeCost,
  COOLDOWN_LEVEL_MAX,
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  pendingEssence,
  charLevelMultiplier,
  charLevelUpCost,
  charLevelBulkCost,
  dojoXpForLevel,
  dojoLevelForXp,
  dojoLevelMultiplier,
  rankQuestSeries,
  ENEMY_HP_GROWTH,
  ENEMY_HP_BASE,
  stageXpForLevel,
  stageForXp,
  decorForLevel,
  DOJO_DECOR,
  MILESTONE_INTERVAL,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  ANCIENTS,
  ancientCost,
  ancientByKey,
  ancientBonus,
  RECRUIT_WEIGHTS,
  rollRecruitRarity,
  recruitCost,
  recruitEssenceCost,
  HERO_ASCENSION_MAX,
  heroAscensionRequiredLevel,
  heroAscensionMultiplier,
  heroAscensionCost,
  simulateCombat,
  enemyMaxHp,
  enemyReward,
  enemiesRequiredForStage,
  normalizeWaveProgress,
  enemyUnitReward,
  enemyUnitMaxHp,
  enemyArchetype,
  PRESTIGE_MIN_STAGE,
  PRESTIGE_STAGE_STEP,
  prestigeRequiredStage,
  wisdomForRunStage,
  prestigeMinimumRunMs,
  MAX_STAGE_ADVANCE_PER_SYNC,
  campaignForStage,
  campaignDifficulty,
  isBossStage,
  isEliteStage,
  RUN_BLESSINGS,
  parseRunBlessings,
  runBlessingEffects,
  runBlessingChoices,
} = require('../src/idle/idle');

test('roguelike : les choix de bénédictions sont stables, variés et cumulent leurs compromis',()=>{
  const first=runBlessingChoices('u1',2,0,[]);const again=runBlessingChoices('u1',2,0,[]);
  assert.deepEqual(first,again);assert.equal(first.length,3);assert.equal(new Set(first.map((item)=>item.key)).size,3);
  const effects=runBlessingEffects('berserker,deadeye');
  assert.equal(effects.prod,1.25*.92);assert.equal(effects.click,.85);assert.equal(effects.crit,.10);
  assert.deepEqual(parseRunBlessings('inconnu,berserker'),['berserker']);
  assert.ok(RUN_BLESSINGS.every((item)=>item.upside&&item.downside));
  const almostAll=RUN_BLESSINGS.slice(0,6).map((item)=>item.key);const late=runBlessingChoices('u1',2,6,almostAll);
  assert.ok(RUN_BLESSINGS.slice(6).every((item)=>late.some((choice)=>choice.key===item.key)));
});

test('améliorations de run : critique et recharge progressent et plafonnent', () => {
  assert.equal(critUpgradeBonus(0),0);
  assert.equal(critUpgradeBonus(1),.01);
  assert.equal(critUpgradeBonus(CRIT_LEVEL_MAX+10),.25);
  assert.ok(critUpgradeCost(1)>critUpgradeCost(0));
  assert.equal(cooldownUpgradeBonus(1),.02);
  assert.equal(cooldownUpgradeBonus(COOLDOWN_LEVEL_MAX+10),.4);
  assert.ok(cooldownUpgradeCost(1)>cooldownUpgradeCost(0));
});

test('campagne : 10 mondes par acte, boss tous les 10 stages et élite au milieu', () => {
  assert.deepEqual([campaignForStage(1).index,campaignForStage(1).wave,campaignForStage(1).act],[1,1,1]);
  assert.deepEqual([campaignForStage(10).index,campaignForStage(10).wave],[1,10]);
  assert.deepEqual([campaignForStage(11).index,campaignForStage(11).wave],[2,1]);
  assert.deepEqual([campaignForStage(91).index,campaignForStage(91).wave],[10,1]);
  assert.deepEqual([campaignForStage(101).index,campaignForStage(101).act],[1,2]);
  assert.equal(isEliteStage(5),true);
  assert.equal(isEliteStage(15),true);
  assert.equal(isEliteStage(10),false);
  assert.equal(campaignForStage(11).modifier.key,'gravity');
  assert.ok(campaignForStage(91).modifier.team>1);
  assert.equal(campaignForStage(1).difficulty.name,'Normal');
  assert.equal(campaignForStage(101).difficulty.name,'Héroïque');
  assert.equal(campaignForStage(201).difficulty.name,'Cauchemar');
});

test('post-stage 100 : chaque acte renforce réellement les ennemis, avec un butin qui progresse moins vite', () => {
  assert.deepEqual(
    [campaignDifficulty(100).name,campaignDifficulty(101).name,campaignDifficulty(201).name],
    ['Normal','Héroïque','Cauchemar'],
  );
  assert.equal(campaignDifficulty(101).power,1.35);
  assert.ok(campaignDifficulty(201).power>campaignDifficulty(101).power);
  assert.ok(campaignDifficulty(201).reward<campaignDifficulty(201).power);
  const naturalHpAt101=ENEMY_HP_BASE*Math.pow(ENEMY_HP_GROWTH,100);
  assert.ok(enemyMaxHp(101)>=naturalHpAt101*1.349);
});

test('économie : progresser ne rend jamais le farm moins rentable que le stage 4', () => {
  const cycleEfficiency=(stage)=>{
    let hp=0,reward=0;
    for(let enemy=0;enemy<enemiesRequiredForStage(stage);enemy++){
      hp+=enemyUnitMaxHp(stage,enemy);
      reward+=enemyUnitReward(stage,enemy);
    }
    return reward/hp;
  };
  const early=cycleEfficiency(4);
  assert.ok(cycleEfficiency(99)>=early*.95);
  assert.ok(cycleEfficiency(199)>=early*.90);
  assert.ok(cycleEfficiency(299)>=early*.85);
});

test('simulateCombat : progresse et ne rétrograde plus devant un boss trop fort', () => {
  const push = simulateCombat({stage:1,hp:enemyMaxHp(1),dps:10,elapsedSeconds:30,mode:'progress'});
  assert.ok(push.stage > 1);
  const wall = simulateCombat({stage:10,hp:enemyMaxHp(10),dps:1,elapsedSeconds:1,mode:'progress'});
  assert.equal(wall.stage,10);
  assert.equal(wall.bossFailed,false);
  assert.ok(wall.hp<enemyMaxHp(10));
});

test('anti-overkill : un DPS extrême ne saute plus plusieurs mondes ni des milliers de cibles faibles',()=>{
  const result=simulateCombat({stage:1,hp:enemyMaxHp(1),dps:1_500_000,elapsedSeconds:60,mode:'progress',maxStageAdvance:MAX_STAGE_ADVANCE_PER_SYNC});
  assert.ok(result.stage<=1+MAX_STAGE_ADVANCE_PER_SYNC);assert.equal(result.progressionCapped,true);assert.ok(result.kills<=500);
  const farm=simulateCombat({stage:1,hp:enemyMaxHp(1),dps:1_500_000,elapsedSeconds:60,mode:'farm'});
  assert.ok(farm.kills<=500);assert.ok(farm.essence<=2000);assert.ok(farm.hp>0);
});

test('le dixième ennemi de la vague 9 ouvre le boss même avec un DPS insuffisant', () => {
  const dps=10;
  const captainHp=enemyUnitMaxHp(9,9);
  const result=simulateCombat({stage:9,waveKills:9,hp:captainHp,dps,elapsedSeconds:captainHp/dps+1,mode:'progress'});
  assert.equal(result.stage,10);
  assert.equal(result.waveKills,0);
  assert.equal(result.bossFailed,false);
  assert.ok(result.hp<enemyUnitMaxHp(10,0));
});

test('chaque vague normale demande 10 ennemis et le boss reste un combat unique', () => {
  assert.equal(enemiesRequiredForStage(1), 10);
  assert.equal(enemiesRequiredForStage(5), 10);
  assert.equal(enemiesRequiredForStage(10), 1);
  const oneKill = simulateCombat({stage:1,hp:enemyMaxHp(1),dps:20,elapsedSeconds:1,mode:'progress'});
  assert.equal(oneKill.stage, 1);
  assert.equal(oneKill.waveKills, 1);
  const finishWave = simulateCombat({stage:1,hp:enemyMaxHp(1),waveKills:9,dps:20,elapsedSeconds:1,mode:'progress'});
  assert.equal(finishWave.stage, 2);
  assert.equal(finishWave.waveKills, 0);
  const finishBoss = simulateCombat({stage:10,hp:enemyMaxHp(10),dps:enemyMaxHp(10),elapsedSeconds:1,mode:'progress'});
  assert.equal(finishBoss.stage, 11);
  assert.equal(finishBoss.waveKills, 0);
});

test('un ancien compteur enregistré à 10 est réparé vers la vague suivante',()=>{
  assert.deepEqual(normalizeWaveProgress(1,10,'progress'),{stage:2,waveKills:0});
  assert.deepEqual(normalizeWaveProgress(9,10,'progress'),{stage:10,waveKills:0});
  assert.deepEqual(normalizeWaveProgress(10,1,'progress'),{stage:11,waveKills:0});
  const repaired=simulateCombat({stage:1,waveKills:10,hp:0,dps:0,elapsedSeconds:0,mode:'progress'});
  assert.equal(repaired.stage,2);
  assert.equal(repaired.waveKills,0);
});

test('le mode Farm répète explicitement la vague après le dixième ennemi',()=>{
  assert.deepEqual(normalizeWaveProgress(4,10,'farm'),{stage:4,waveKills:0});
});

test('les archétypes ennemis changent réellement les PV et le butin',()=>{
  assert.equal(enemyArchetype(1,9).key,'captain');
  assert.ok(enemyUnitMaxHp(1,9)>enemyMaxHp(1));
  assert.ok(enemyUnitReward(1,9)>enemyReward(1));
});

test('équilibrage : les coûts croissent plus vite que les récompenses et les achats restent espacés', () => {
  assert.equal(enemyMaxHp(1), 20);
  assert.ok(charLevelUpCost('mythic',50)/charLevelUpCost('mythic',10)>enemyReward(50)/enemyReward(10));
  assert.equal(clickUpgradeCost(0), 21);
  assert.equal(prodUpgradeCost(0), 26);
  assert.ok(clickUpgradeCost(5)>clickUpgradeCost(4));
  assert.ok(prodUpgradeCost(5)>prodUpgradeCost(4));
  assert.equal(slotUpgradeCost(START_SLOTS), 400);
  assert.ok(charLevelUpCost('rare', 25) > charLevelUpCost('rare', 10) * 5);
  assert.equal(charLevelUpCost('rare', 1), 28);
  assert.ok(slotRate('rare', 10) / slotRate('rare', 9) < 2.25);
  assert.ok(slotRate('rare', 25) / slotRate('rare', 24) < 2.25);
});

test('Prestige : le seuil progresse à chaque retraite et la Sagesse récompense le push sans emballement',()=>{
  assert.equal(PRESTIGE_MIN_STAGE,100); // la Retraite conclut une vraie run (choix du créateur)
  assert.equal(prestigeRequiredStage(0),PRESTIGE_MIN_STAGE);
  assert.equal(prestigeRequiredStage(1),PRESTIGE_MIN_STAGE+PRESTIGE_STAGE_STEP);
  assert.equal(prestigeRequiredStage(10),PRESTIGE_MIN_STAGE+10*PRESTIGE_STAGE_STEP);
  assert.equal(wisdomForRunStage(PRESTIGE_MIN_STAGE-1),0);
  assert.equal(wisdomForRunStage(PRESTIGE_MIN_STAGE),4);
  assert.ok(wisdomForRunStage(200)>wisdomForRunStage(100));
  assert.equal(wisdomForRunStage(PRESTIGE_MIN_STAGE,1),0);
  assert.equal(wisdomForRunStage(prestigeRequiredStage(1),1),4);
  for(let prestige=0;prestige<=50;prestige++){
    assert.equal(isBossStage(prestigeRequiredStage(prestige)),true);
  }
});

test('Prestige : la durée minimale bloque les retraites en chaîne et augmente progressivement',()=>{
  assert.equal(prestigeMinimumRunMs(0),45*60*1000);
  assert.equal(prestigeMinimumRunMs(5),60*60*1000);
  assert.equal(prestigeMinimumRunMs(99),90*60*1000);
});

test('long terme : le dernier décor ne peut pas être épuisé en 10 h de jeu actif',()=>{
  // Depuis la diversification du pool d'épreuves (5 types tournants au lieu
  // de kills/clics/améliorations à chaque niveau), chaque type n'apparaît
  // plus que ~3 niveaux sur 5 — les seuils sont donc abaissés en proportion
  // (×0,6), mais l'invariant reste vrai : au rythme maximal accepté par le
  // serveur, même le dernier décor demande largement plus de 10h de jeu actif.
  let requiredClicks=0,requiredKills=0,requiredUpgrades=0;
  for(let level=1;level<1000;level++){
    for(const quest of rankQuestSeries({level}).quests){
      if(quest.key==='clicks')requiredClicks+=quest.target;
      if(quest.key==='kills')requiredKills+=quest.target;
      if(quest.key==='upgrades')requiredUpgrades+=quest.target;
    }
  }
  // Le serveur accepte au maximum 30 frappes comptabilisées par seconde.
  assert.ok(requiredClicks/(30*3600)>15);
  assert.ok(requiredKills>1_800_000);
  assert.ok(requiredUpgrades>80_000);
});

test('nouveaux Ancients : Frappe Fantôme, Pas du Conquérant et Fortune des Gardiens exposés',()=>{
  const {achievementProdMultiplier,orbReward,AWAKENED_BONUS,AWAKENED_CHANCE,ORB_JACKPOT_CHANCE,ORB_JACKPOT_SECONDS,ORB_PRODUCTION_SECONDS}=require('../src/idle/idle');
  assert.ok(ANCIENTS.some((a)=>a.kind==='autoClickRate'));
  assert.ok(ANCIENTS.some((a)=>a.kind==='startStage'));
  assert.ok(ANCIENTS.some((a)=>a.kind==='bossRewardMult'));
  assert.equal(achievementProdMultiplier(0),1);
  assert.equal(achievementProdMultiplier(10),1.10);
  assert.equal(orbReward(0),10); // petit plancher, sans court-circuiter le farm initial
  assert.equal(orbReward(100),4500); // 45 s : précieux sans remplacer plusieurs minutes de farm
  // Jackpot rare (façon golden cookie « Frenzy ») : même appel, ~4x la production.
  assert.equal(ORB_JACKPOT_SECONDS,ORB_PRODUCTION_SECONDS*4);
  assert.equal(orbReward(100,true),orbReward(100)*4);
  assert.ok(ORB_JACKPOT_CHANCE>0&&ORB_JACKPOT_CHANCE<.2);
  assert.ok(AWAKENED_BONUS>1&&AWAKENED_CHANCE>0&&AWAKENED_CHANCE<.1);
});

test('étoiles d’Éveil : coût croissant en Essence (pas en Sceaux), bonus plafonné à 10 étoiles',()=>{
  const {AWAKEN_STAR_MAX,awakenStarCost,awakenStarMultiplier}=require('../src/idle/idle');
  assert.equal(AWAKEN_STAR_MAX,10);
  assert.ok(awakenStarCost('rare',1,50)>awakenStarCost('rare',0,50));
  assert.ok(awakenStarCost('rare',4,50)>awakenStarCost('rare',3,50));
  // Indexé sur la progression (comme le recyclage/l'amélioration des runes) :
  // plus le meilleur stage atteint est élevé, plus le coût suit.
  assert.ok(awakenStarCost('rare',0,200)>awakenStarCost('rare',0,50));
  // Une rareté plus élevée coûte plus cher à éveiller, à stage égal.
  assert.ok(awakenStarCost('mythic',0,50)>awakenStarCost('rare',0,50));
  assert.equal(awakenStarMultiplier(0),1);
  assert.ok(Math.abs(awakenStarMultiplier(10)-1.8)<1e-9);
  assert.equal(awakenStarMultiplier(99),awakenStarMultiplier(10)); // jamais au-delà du cap
});

test('Donjon des Runes : gratuit puis coût croissant en Essence, rareté tirée au sort selon le monde',()=>{
  const {RUNE_DUNGEON_FREE_ATTEMPTS,runeDungeonExtraCost,runeDungeonRarity}=require('../src/idle/idle');
  assert.equal(RUNE_DUNGEON_FREE_ATTEMPTS,5);
  // Première tentative payante (index 0) > deuxième tentative gratuite pure (coût 0 côté route),
  // et chaque tentative payante suivante coûte plus cher que la précédente.
  assert.ok(runeDungeonExtraCost(1,50)>runeDungeonExtraCost(0,50));
  assert.ok(runeDungeonExtraCost(0,200)>runeDungeonExtraCost(0,50)); // suit la progression
  // Vrai tirage pondéré (pas un plancher déterministe) : sur assez d'essais,
  // seules les raretés du bon palier de monde doivent sortir, et une rareté
  // plus haute doit devenir davantage probable à mesure que le stage monte.
  const rolls=(stage,n=400)=>Array.from({length:n},()=>runeDungeonRarity(stage));
  const early=rolls(1);
  assert.ok(early.every((r)=>['rare','epic'].includes(r)));
  assert.ok(early.includes('rare')&&early.includes('epic'));
  const late=rolls(650);
  assert.ok(late.every((r)=>['rare','epic','legendary','mythic'].includes(r)));
  assert.ok(late.includes('mythic'));
  const mythicShare=(stage)=>rolls(stage,1000).filter((r)=>r==='mythic').length;
  assert.ok(mythicShare(650)>mythicShare(250));
});

test('complétion de licence et Mémoire du Maître : bonus permanents bornés',()=>{
  const {completedSeriesMultiplier,prestigeStartingLevels,PRESTIGE_START_LEVELS_MAX}=require('../src/idle/idle');
  assert.equal(completedSeriesMultiplier(0),1);
  assert.ok(Math.abs(completedSeriesMultiplier(10)-1.2)<1e-9);
  assert.equal(prestigeStartingLevels(0),0);
  assert.equal(prestigeStartingLevels(1),2);
  assert.equal(prestigeStartingLevels(100),PRESTIGE_START_LEVELS_MAX); // plafonné
});

test('buffs d’orbe : actifs uniquement avant expiration, un seul à la fois',()=>{
  const {ORB_BUFFS,activeOrbBuff}=require('../src/idle/idle');
  assert.ok(ORB_BUFFS.frenzy.prod>1&&ORB_BUFFS.precision.click>1);
  const now=new Date();
  assert.equal(activeOrbBuff({idleBuffKey:null,idleBuffUntil:null},now),null);
  assert.equal(activeOrbBuff({idleBuffKey:'frenzy',idleBuffUntil:new Date(now.getTime()-1000)},now),null); // expiré
  assert.equal(activeOrbBuff({idleBuffKey:'inconnu',idleBuffUntil:new Date(now.getTime()+9000)},now),null); // clé invalide
  const active=activeOrbBuff({idleBuffKey:'frenzy',idleBuffUntil:new Date(now.getTime()+9000)},now);
  assert.equal(active.prod,2);
});

test('raretés : un personnage favori reste viable face à un Mythique', () => {
  for (const level of [1, 10, 50, 100, 500]) {
    const rare=slotRate('rare',level);
    const mythic=slotRate('mythic',level);
    assert.ok(mythic>rare,`le Mythique garde un avantage au niveau ${level}`);
    assert.ok(mythic/rare<=1.5,`l'écart reste contenu au niveau ${level}`);
  }
  assert.ok(charLevelUpCost('mythic',1)/charLevelUpCost('rare',1)<2);
});

test('les courbes restent finies aux niveaux extrêmes', () => {
  for (const value of [charLevelMultiplier(1e9), charLevelUpCost('mythic', 1e9), enemyMaxHp(1e9), enemyReward(1e9)]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
  }
});

test('slotRate : croît avec la rareté et le niveau d\'entraînement, indépendant de tout autre système', () => {
  const order = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(slotRate(order[i], 1) > slotRate(order[i - 1], 1), `${order[i]} > ${order[i - 1]}`);
  }
  assert.equal(slotRate('unknown-rarity', 1), 0);
  assert.ok(slotRate('rare', 10) > slotRate('rare', 1));
  assert.equal(slotRate('rare'), slotRate('rare', 1)); // niveau absent = niveau 1 (pas de bonus)
});

test('rollRecruitRarity : ne renvoie que des raretés connues, pondération propre au Dojo', () => {
  const known = new Set(RECRUIT_WEIGHTS.map(([r]) => r));
  for (let i = 0; i < 200; i++) assert.ok(known.has(rollRecruitRarity()));
});

test('rollRecruitRarity : aucun Commun et le bonus de chance réduit la part du Rare', () => {
  const known = new Set(RECRUIT_WEIGHTS.map(([r]) => r));
  const N = 3000;
  let rareBase = 0, rareBoosted = 0;
  for (let i = 0; i < N; i++) {
    const a = rollRecruitRarity();
    const b = rollRecruitRarity(0.9);
    assert.ok(known.has(a));
    assert.ok(known.has(b));
    assert.notEqual(a, 'common');
    assert.notEqual(b, 'common');
    if (a === 'rare') rareBase++;
    if (b === 'rare') rareBoosted++;
  }
  assert.ok(rareBoosted < rareBase);
});

test('recruitCost : un Sceau vaut toujours exactement une invocation', () => {
  assert.equal(recruitCost(0),1);
  assert.equal(recruitCost(20),1);
  assert.equal(recruitCost(999,999),1);
});

test('recruitEssenceCost : progresse seulement avec les achats Essence et respecte la remise', () => {
  assert.equal(recruitEssenceCost(0),1500);
  assert.ok(recruitEssenceCost(10)>recruitEssenceCost(0));
  assert.ok(recruitEssenceCost(10,.25)<recruitEssenceCost(10));
  assert.ok(recruitEssenceCost(50)>5000000);
  assert.ok(recruitEssenceCost(100)>recruitEssenceCost(50));
  assert.ok(recruitEssenceCost(999)>recruitEssenceCost(100));
  assert.ok(Number.isFinite(recruitEssenceCost(10000)));
});

test('simulation 1000 h : même une production extrême ne rend pas les invocations illimitées', () => {
  const simulatePulls = (hours, essencePerSecond, discount = .6) => {
    let balance = hours * 3600 * essencePerSecond;
    let pulls = 0;
    while (pulls < 10000) {
      const cost = recruitEssenceCost(pulls, discount);
      if (cost > balance) return { pulls, balance, nextCost: cost };
      balance -= cost;
      pulls++;
    }
    throw new Error('La simulation a atteint sa garde anti-boucle');
  };
  const at500h = simulatePulls(500, 1e12);
  const at1000h = simulatePulls(1000, 1e12);
  assert.ok(at1000h.pulls < 250);
  assert.ok(at1000h.pulls - at500h.pulls <= 6);
  assert.ok(at1000h.nextCost > at1000h.balance);
  assert.ok(Number.isFinite(at1000h.nextCost));
});

test('ascension : dix paliers à rendement décroissant, sans boucle auto-accélérante', () => {
  assert.deepEqual(
    Array.from({ length: HERO_ASCENSION_MAX }, (_, ascension) => heroAscensionRequiredLevel(ascension)),
    [100, 110, 120, 130, 140, 150, 160, 170, 180, 190],
  );
  assert.ok(heroAscensionMultiplier(HERO_ASCENSION_MAX) < 111);
  assert.equal(heroAscensionMultiplier(HERO_ASCENSION_MAX + 100), heroAscensionMultiplier(HERO_ASCENSION_MAX));
  for (let ascension = 0; ascension < HERO_ASCENSION_MAX; ascension++) {
    const requiredLevel = heroAscensionRequiredLevel(ascension);
    const nextRequiredLevel = heroAscensionRequiredLevel(ascension + 1);
    const previousLevel = ascension ? heroAscensionRequiredLevel(ascension - 1) : 1;
    const cycleCost = charLevelBulkCost('rare', previousLevel, requiredLevel - previousLevel) + heroAscensionCost('rare', ascension);
    const nextCycleCost = charLevelBulkCost('rare', requiredLevel, nextRequiredLevel - requiredLevel) + heroAscensionCost('rare', ascension + 1);
    const powerGain = heroAscensionMultiplier(ascension + 1) / heroAscensionMultiplier(ascension);
    assert.ok(nextCycleCost / cycleCost > powerGain);
  }
});

test('charLevelMultiplier/charLevelUpCost : illimités, croissance sans plafond', () => {
  assert.equal(charLevelMultiplier(1), 1);
  assert.ok(charLevelMultiplier(50) > charLevelMultiplier(10));
  assert.ok(charLevelMultiplier(1000) > charLevelMultiplier(100)); // pas de MAX, contrairement à Discipline/Concentration
  // Rareté plus élevée = plus cher à faire progresser, à niveau égal.
  assert.ok(charLevelUpCost('mythic', 5) > charLevelUpCost('common', 5));
  assert.ok(charLevelUpCost('rare', 10) > charLevelUpCost('rare', 1));
});

test('dojoXpForLevel/dojoLevelForXp : formule fermée, cohérente aux paliers', () => {
  assert.equal(dojoXpForLevel(1), 0);
  assert.equal(dojoLevelForXp(0), 1);
  for (const lvl of [2, 3, 10, 50, 80]) {
    const xp = dojoXpForLevel(lvl);
    assert.equal(dojoLevelForXp(xp), lvl, `pile au seuil du niveau ${lvl}`);
    assert.equal(dojoLevelForXp(xp - 1), lvl - 1, `juste avant le seuil du niveau ${lvl}`);
  }
});

test('stageXpForLevel/stageForXp : même formule fermée que le Dojo, cohérente aux paliers', () => {
  assert.equal(stageXpForLevel(1), 0);
  assert.equal(stageForXp(0), 1);
  for (const lvl of [2, 3, 10, 50, 80]) {
    const xp = stageXpForLevel(lvl);
    assert.equal(stageForXp(xp), lvl, `pile au seuil du stage ${lvl}`);
    assert.equal(stageForXp(xp - 1), lvl - 1, `juste avant le seuil du stage ${lvl}`);
  }
});

test('stageXpForLevel : courbe bien plus douce que le Dojo (kills fréquents)', () => {
  // Même formule, même point de départ (niveau/stage 2) : le stage doit être
  // nettement moins cher à atteindre pour rythmer le combat plus vite que la
  // progression du Dojo (décor, volontairement lente).
  assert.ok(stageXpForLevel(2) < dojoXpForLevel(2));
  assert.ok(stageXpForLevel(10) < dojoXpForLevel(10));
});

test('dojoLevelMultiplier : +1%/niveau, illimité', () => {
  assert.equal(dojoLevelMultiplier(1), 1);
  assert.ok(dojoLevelMultiplier(101) > dojoLevelMultiplier(1));
});

test('rankQuestSeries : impose combat, clics et améliorations avant le niveau suivant', () => {
  const started = rankQuestSeries({ level:1 });
  assert.equal(started.nextLevel, 2);
  assert.equal(started.ready, false);
  assert.deepEqual(started.quests.map((q) => q.target), [23, 55, 4]);
  assert.equal(started.quests.find((quest)=>quest.key==='clicks').name,'Frappes manuelles');
  assert.match(started.quests.find((quest)=>quest.key==='clicks').description,/bouton Attaquer/);
  const ready = rankQuestSeries({ level:1, kills:23, clicks:55, upgrades:4 });
  assert.equal(ready.completed, 3);
  assert.equal(ready.ready, true);
  assert.equal(ready.sealReward, 1);
  assert.equal(ready.powerReward,.01);
});

test('rankQuestSeries : chaque cinquième niveau ajoute une épreuve de stage et double les Sceaux', () => {
  // Niveau 4 (rotation (4-1)%5=3) tire skills/recruits/kills, pas clics ni
  // améliorations — voir le test de rotation ci-dessous pour la couverture
  // complète du pool.
  const full = { kills:999, clicks:999, upgrades:999, skills:999, recruits:999 };
  const series = rankQuestSeries({ level:4, ...full });
  assert.equal(series.total, 4);
  assert.equal(series.ready, false); // sans bestStage, l'épreuve de stage bloque
  assert.equal(series.quests.at(-1).key, 'stage');
  assert.equal(series.quests.at(-1).target, 25); // nextLevel(5) × 5
  assert.equal(series.sealReward, 2);
  assert.equal(rankQuestSeries({ level:4, ...full, bestStage:25 }).ready, true);
});

test('rankQuestSeries : le pool de 5 épreuves tourne par rang au lieu de répéter toujours les 3 mêmes', () => {
  // Retour testeur : « il faudrait diversifier les quêtes de montée de
  // niveau » — jusqu'ici toujours kills/clics/améliorations, dans cet ordre,
  // à chaque rang. Le pool complet doit apparaître sur un cycle de 5 niveaux,
  // et la combinaison ne doit jamais se répéter à l'identique deux rangs de
  // suite.
  const keysAt = (level) => rankQuestSeries({ level }).quests.slice(0, 3).map((q) => q.key);
  assert.deepEqual(keysAt(1), ['kills', 'clicks', 'upgrades']); // continuité avec le comportement historique
  const seen = new Set();
  let previous = null;
  for (let level = 1; level <= 10; level++) {
    const combo = keysAt(level).join(',');
    seen.add(combo);
    if (previous) assert.notEqual(combo, previous, `niveau ${level} répète la combinaison du niveau précédent`);
    previous = combo;
  }
  assert.equal(seen.size, 5); // les 5 rotations possibles apparaissent sur 2 cycles
  // Chaque type du pool doit être utilisé au moins une fois sur un cycle complet.
  const allKeysOverCycle = new Set([1,2,3,4,5].flatMap(keysAt));
  assert.deepEqual([...allKeysOverCycle].sort(), ['clicks','kills','recruits','skills','upgrades']);
});

test('rankQuestSeries : compétences actives et recrues sont des épreuves valides, avec des cibles progressives et plafonnées', () => {
  // Niveau 2 (rotation 1) tire clicks/upgrades/skills.
  const withSkills = rankQuestSeries({ level:2, skills:0 }).quests.find((q) => q.key === 'skills');
  assert.ok(withSkills);
  assert.ok(withSkills.target > 0);
  assert.ok(rankQuestSeries({ level:999 }).quests.find((q)=>q.key==='skills')?.target <= 200); // rotation (999-1)%5=3 -> skills présent
  // Niveau 5 (rotation 4) tire recruits/kills/clicks.
  const withRecruits = rankQuestSeries({ level:5, recruits:0 }).quests.find((q) => q.key === 'recruits');
  assert.ok(withRecruits);
  assert.ok(withRecruits.target >= 1);
  assert.ok(rankQuestSeries({ level:500 }).quests.find((q)=>q.key==='recruits')?.target <= 30); // jamais un mur d'invocations
});

test('decorForLevel : palier courant + prochain palier, cohérents avec DOJO_DECOR', () => {
  const first = decorForLevel(1);
  assert.equal(first.current.theme, DOJO_DECOR[0].theme);
  assert.equal(first.next.theme, DOJO_DECOR[1].theme);

  const lastTier = DOJO_DECOR[DOJO_DECOR.length - 1];
  const atLast = decorForLevel(lastTier.level + 500);
  assert.equal(atLast.current.theme, lastTier.theme);
  assert.equal(atLast.next, null); // plus de palier au-delà, mais le niveau continue de grimper
});

test('prodMultiplier/prodUpgradeCost : croissants, plafonnés à PROD_LEVEL_MAX ; bonus d\'Ancient cumulable', () => {
  assert.equal(prodMultiplier(0), 1);
  assert.ok(prodMultiplier(5) > prodMultiplier(0));
  assert.equal(prodMultiplier(PROD_LEVEL_MAX), prodMultiplier(PROD_LEVEL_MAX + 10)); // plafonné
  assert.ok(prodUpgradeCost(5) > prodUpgradeCost(0));
  assert.ok(prodMultiplier(5, 0.2) > prodMultiplier(5));
});

test('clickYield/clickUpgradeCost : croissants, plafonnés à CLICK_LEVEL_MAX ; bonus d\'Ancient cumulable', () => {
  assert.ok(clickYield(0) > 0);
  assert.ok(clickYield(5) > clickYield(0));
  assert.equal(clickYield(CLICK_LEVEL_MAX), clickYield(CLICK_LEVEL_MAX + 10));
  assert.ok(clickUpgradeCost(5) > clickUpgradeCost(0));
  assert.ok(clickYield(5, 0.5) > clickYield(5));
});

test('slotUpgradeCost : croît à chaque emplacement débloqué au-delà des gratuits', () => {
  assert.ok(slotUpgradeCost(START_SLOTS) > 0);
  assert.ok(slotUpgradeCost(MAX_SLOTS - 1) > slotUpgradeCost(START_SLOTS));
});

test('pendingEssence : 0 sans taux ni horodatage, sinon linéaire et plafonné à OFFLINE_CAP_MS', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  assert.equal(pendingEssence(null, 10, now), 0);
  assert.equal(pendingEssence(now, 0, now), 0);

  const oneMinAgo = new Date(now.getTime() - 60000);
  assert.equal(pendingEssence(oneMinAgo, 2, now), 120); // 60s * 2/s

  const wayBefore = new Date(now.getTime() - OFFLINE_CAP_MS - 3600000);
  assert.equal(pendingEssence(wayBefore, 2, now), (OFFLINE_CAP_MS / 1000) * 2); // plafonné à 12h

  // Plafond étendu (Ancient « Bourse Profonde ») : le surplus au-delà de
  // OFFLINE_CAP_MS mais dans le nouveau plafond compte désormais.
  const extendedCap = OFFLINE_CAP_MS + 3600000;
  assert.equal(pendingEssence(wayBefore, 2, now, extendedCap), (extendedCap / 1000) * 2);
});

test('milestoneTierForLevel/milestoneReward : un palier tous les MILESTONE_INTERVAL niveaux, récompense croissante', () => {
  assert.equal(milestoneTierForLevel(1), 0); // rien avant le premier palier
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL), 1);
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL * 2), 2);
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL * 2 - 1), 1); // pas encore atteint le 2e palier
  assert.equal(milestoneReward(0), 0);
  assert.ok(milestoneReward(2) > milestoneReward(1));
});

test('ancientCost : croissant, jamais nul, pas de plafond (puits de très long terme)', () => {
  assert.ok(PRESTIGE_MIN_DOJO_LEVEL > 1); // seuil historique toujours exposé pour l'affichage
  assert.ok(ancientCost(0) > 0);
  assert.ok(ancientCost(20) > ancientCost(0));
  // Croissance adoucie après le niveau 10 : les niveaux profonds restent un
  // puits, mais ne distancent plus la Sagesse gagnée par Retraite (linéaire).
  assert.ok(ancientCost(20) / ancientCost(19) < ancientCost(10) / ancientCost(9));
});

test('ancientByKey/ancientBonus : liste fermée, bonus cumulé par type, absent = 0 (pas acheté)', () => {
  for (const a of ANCIENTS) assert.equal(ancientByKey(a.key), a);
  assert.equal(ancientByKey('inexistant'), null);

  const prodKey = ANCIENTS.find((a) => a.kind === 'prodMult').key;
  const levels = new Map([[prodKey, 5]]);
  assert.equal(ancientBonus(levels, 'prodMult'), ancientByKey(prodKey).effectPerLevel * 5);
  assert.equal(ancientBonus(levels, 'clickMult'), 0); // absent de la map → pas acheté, pas 1 niveau gratuit
  assert.equal(ancientBonus(new Map(), 'prodMult'), 0);
});

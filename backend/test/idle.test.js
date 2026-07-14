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
  dojoXpForLevel,
  dojoLevelForXp,
  dojoLevelMultiplier,
  rankQuestSeries,
  stageXpForLevel,
  stageForXp,
  decorForLevel,
  DOJO_DECOR,
  MILESTONE_INTERVAL,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  wisdomForPrestige,
  ANCIENTS,
  ancientCost,
  ancientByKey,
  ancientBonus,
  RECRUIT_WEIGHTS,
  rollRecruitRarity,
  recruitCost,
  recruitEssenceCost,
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
  const naturalHpAt101=20*Math.pow(1.13,100);
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
  let requiredClicks=0,requiredKills=0,requiredUpgrades=0;
  for(let level=1;level<1000;level++){
    for(const quest of rankQuestSeries({level}).quests){
      if(quest.key==='clicks')requiredClicks+=quest.target;
      if(quest.key==='kills')requiredKills+=quest.target;
      if(quest.key==='upgrades')requiredUpgrades+=quest.target;
    }
  }
  // Le serveur accepte au maximum 30 frappes comptabilisées par seconde.
  assert.ok(requiredClicks/(30*3600)>30);
  assert.ok(requiredKills>3_000_000);
  assert.ok(requiredUpgrades>150_000);
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
  assert.ok(recruitEssenceCost(999)<=5000000);
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

test('rankQuestSeries : chaque cinquième niveau ajoute une épreuve de boss et double les Sceaux', () => {
  const series = rankQuestSeries({ level:4, kills:999, clicks:999, upgrades:999 });
  assert.equal(series.total, 4);
  assert.equal(series.ready, false);
  assert.equal(series.quests.at(-1).key, 'bosses');
  assert.equal(series.sealReward, 2);
  assert.equal(rankQuestSeries({ level:4, kills:999, clicks:999, upgrades:999, bosses:1 }).ready, true);
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

test('wisdomForPrestige : croît avec le niveau du Dojo au moment du Prestige, jamais nul ; seuil minimum exposé', () => {
  assert.ok(PRESTIGE_MIN_DOJO_LEVEL > 1); // pas prestigeable dès le niveau 1 (rien à gagner)
  assert.equal(wisdomForPrestige(0), 1); // plancher : jamais un Prestige pour rien
  assert.ok(wisdomForPrestige(50) > wisdomForPrestige(PRESTIGE_MIN_DOJO_LEVEL));
});

test('ancientCost : croissant, jamais nul, pas de plafond (puits de très long terme)', () => {
  assert.ok(ancientCost(0) > 0);
  assert.ok(ancientCost(20) > ancientCost(0));
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

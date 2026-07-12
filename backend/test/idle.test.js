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
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  pendingEssence,
  charLevelMultiplier,
  charLevelUpCost,
  dojoXpForLevel,
  dojoLevelForXp,
  dojoLevelMultiplier,
  stageXpForLevel,
  stageForXp,
  decorForLevel,
  DOJO_DECOR,
  MILESTONE_INTERVAL,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  prestigeMultiplier,
  RECRUIT_WEIGHTS,
  rollRecruitRarity,
  recruitCost,
} = require('../src/idle/idle');

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

test('recruitCost : croît avec le nombre déjà recruté, jamais nul', () => {
  assert.ok(recruitCost(0) > 0);
  assert.ok(recruitCost(20) > recruitCost(0));
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

test('decorForLevel : palier courant + prochain palier, cohérents avec DOJO_DECOR', () => {
  const first = decorForLevel(1);
  assert.equal(first.current.theme, DOJO_DECOR[0].theme);
  assert.equal(first.next.theme, DOJO_DECOR[1].theme);

  const lastTier = DOJO_DECOR[DOJO_DECOR.length - 1];
  const atLast = decorForLevel(lastTier.level + 500);
  assert.equal(atLast.current.theme, lastTier.theme);
  assert.equal(atLast.next, null); // plus de palier au-delà, mais le niveau continue de grimper
});

test('prodMultiplier/prodUpgradeCost : croissants, plafonnés à PROD_LEVEL_MAX', () => {
  assert.equal(prodMultiplier(0), 1);
  assert.ok(prodMultiplier(5) > prodMultiplier(0));
  assert.equal(prodMultiplier(PROD_LEVEL_MAX), prodMultiplier(PROD_LEVEL_MAX + 10)); // plafonné
  assert.ok(prodUpgradeCost(5) > prodUpgradeCost(0));
});

test('clickYield/clickUpgradeCost : croissants, plafonnés à CLICK_LEVEL_MAX', () => {
  assert.ok(clickYield(0) > 0);
  assert.ok(clickYield(5) > clickYield(0));
  assert.equal(clickYield(CLICK_LEVEL_MAX), clickYield(CLICK_LEVEL_MAX + 10));
  assert.ok(clickUpgradeCost(5) > clickUpgradeCost(0));
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
});

test('milestoneTierForLevel/milestoneReward : un palier tous les MILESTONE_INTERVAL niveaux, récompense croissante', () => {
  assert.equal(milestoneTierForLevel(1), 0); // rien avant le premier palier
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL), 1);
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL * 2), 2);
  assert.equal(milestoneTierForLevel(MILESTONE_INTERVAL * 2 - 1), 1); // pas encore atteint le 2e palier
  assert.equal(milestoneReward(0), 0);
  assert.ok(milestoneReward(2) > milestoneReward(1));
});

test('prestigeMultiplier : +10%/niveau, permanent et illimité ; seuil minimum exposé', () => {
  assert.equal(prestigeMultiplier(0), 1);
  assert.ok(prestigeMultiplier(1) > 1);
  assert.ok(prestigeMultiplier(10) > prestigeMultiplier(1));
  assert.ok(PRESTIGE_MIN_DOJO_LEVEL > 1); // pas prestigeable dès le niveau 1 (rien à gagner)
});

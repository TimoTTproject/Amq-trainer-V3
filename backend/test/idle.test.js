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
  decorForLevel,
  DOJO_DECOR,
} = require('../src/idle/idle');

test('slotRate : croît avec la rareté, le niveau ★ et le niveau d\'entraînement', () => {
  const order = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(slotRate(order[i], 1) > slotRate(order[i - 1], 1), `${order[i]} > ${order[i - 1]}`);
  }
  assert.ok(slotRate('mythic', 5) > slotRate('mythic', 1));
  assert.equal(slotRate('unknown-rarity', 1), 0);
  assert.ok(slotRate('rare', 1, 10) > slotRate('rare', 1, 1));
  assert.equal(slotRate('rare', 1), slotRate('rare', 1, 1)); // niveau absent = niveau 1 (pas de bonus)
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

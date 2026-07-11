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
} = require('../src/idle/idle');

test('slotRate : croît avec la rareté et le niveau ★', () => {
  const order = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(slotRate(order[i], 1) > slotRate(order[i - 1], 1), `${order[i]} > ${order[i - 1]}`);
  }
  assert.ok(slotRate('mythic', 5) > slotRate('mythic', 1));
  assert.equal(slotRate('unknown-rarity', 1), 0);
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

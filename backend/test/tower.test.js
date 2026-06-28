const test = require('node:test');
const assert = require('node:assert/strict');
const { computeReward, timeLimitForFloor, freeEntryAvailable, ENTRY_COST } = require('../src/tower/tower');

test('reward scales per floor with a bonus every 10 floors', () => {
  assert.equal(computeReward(0), 0);
  assert.equal(computeReward(5), 25); // 5 × 5
  assert.equal(computeReward(10), 75); // 10 × 5 + 25
  assert.equal(computeReward(20), 150); // 20 × 5 + 2 × 25
});

test('a run becomes profitable from ~8 floors (entry 40)', () => {
  assert.ok(computeReward(7) < ENTRY_COST, `7 étages = ${computeReward(7)}`);
  assert.ok(computeReward(8) >= ENTRY_COST, `8 étages = ${computeReward(8)}`);
});

test('time limit shrinks from 20s down to a 6s floor', () => {
  assert.equal(timeLimitForFloor(1), 20);
  assert.equal(timeLimitForFloor(11), 15);
  assert.ok(timeLimitForFloor(100) >= 6);
  assert.equal(timeLimitForFloor(100), 6);
});

test('free entry resets on a new calendar day', () => {
  assert.equal(freeEntryAvailable(null), true);
  assert.equal(freeEntryAvailable(new Date()), false);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  assert.equal(freeEntryAvailable(yesterday), true);
});

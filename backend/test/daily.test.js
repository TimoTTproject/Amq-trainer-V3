const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickDailySongIds, scoreSong, maxScore, computeSoloMmrDelta, applyMmr,
  BASE_RATING, DAILY_DURATION_MS,
} = require('../src/daily/daily');

test('pickDailySongIds returns the requested count of distinct ids', () => {
  const ids = pickDailySongIds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 10);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  ids.forEach((id) => assert.ok(id >= 1 && id <= 12));
});

test('pickDailySongIds caps at the number of candidates', () => {
  assert.equal(pickDailySongIds([1, 2, 3], 10).length, 3);
});

test('scoreSong rewards speed and gives 0 for wrong/late', () => {
  assert.equal(scoreSong({ correct: false, elapsedMs: 0 }), 0);
  assert.equal(scoreSong({ correct: true, elapsedMs: 0 }), 1000); // instantané
  assert.equal(scoreSong({ correct: true, elapsedMs: DAILY_DURATION_MS }), 300); // pile à la fin
  assert.equal(scoreSong({ correct: true, elapsedMs: DAILY_DURATION_MS * 2 }), 300); // hors-temps → plancher
  const mid = scoreSong({ correct: true, elapsedMs: DAILY_DURATION_MS / 2 });
  assert.ok(mid > 300 && mid < 1000);
});

test('computeSoloMmrDelta: perfect run gains, zero run loses, at baseline a ~50% run is neutral', () => {
  const max = maxScore(10);
  assert.ok(computeSoloMmrDelta(BASE_RATING, max, max) > 0); // parfait → gain
  assert.ok(computeSoloMmrDelta(BASE_RATING, 0, max) < 0); // nul → perte
  assert.equal(computeSoloMmrDelta(BASE_RATING, max / 2, max), 0); // 50 % à 1000 → neutre
});

test('computeSoloMmrDelta: a stronger player must perform better to keep gaining', () => {
  const max = maxScore(10);
  const score = Math.round(max * 0.7);
  const lowMmr = computeSoloMmrDelta(800, score, max);
  const highMmr = computeSoloMmrDelta(1600, score, max);
  assert.ok(lowMmr > highMmr, `${lowMmr} vs ${highMmr}`);
});

test('applyMmr respects the floor', () => {
  assert.equal(applyMmr(110, -50), 100);
  assert.equal(applyMmr(1000, 24), 1024);
});

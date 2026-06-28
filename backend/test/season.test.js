const test = require('node:test');
const assert = require('node:assert/strict');
const {
  currentSeason, seasonLabel, seasonStart, seasonEnd,
  tierIndexFromName, computeSeasonReward,
} = require('../src/season/season');

test('currentSeason / label / window', () => {
  assert.equal(currentSeason(new Date(2026, 5, 28)), '2026-06'); // juin (mois 5 = juin)
  assert.equal(seasonLabel('2026-06'), 'juin 2026');
  assert.deepEqual(seasonStart('2026-06'), new Date(2026, 5, 1));
  assert.deepEqual(seasonEnd('2026-06'), new Date(2026, 6, 1)); // 1er juillet
  assert.deepEqual(seasonEnd('2026-12'), new Date(2027, 0, 1)); // passage d'année
});

test('tierIndexFromName maps tiers to 0..5', () => {
  assert.equal(tierIndexFromName('Bronze'), 0);
  assert.equal(tierIndexFromName('Or'), 2);
  assert.equal(tierIndexFromName('Maître'), 5);
  assert.equal(tierIndexFromName(null), -1);
  assert.equal(tierIndexFromName('Inconnu'), -1);
});

test('computeSeasonReward scales with tier, zero if unranked', () => {
  assert.deepEqual(computeSeasonReward(-1), { tokens: 0, dust: 0 });
  assert.deepEqual(computeSeasonReward(0), { tokens: 60, dust: 10 });
  const bronze = computeSeasonReward(0).tokens;
  const master = computeSeasonReward(5).tokens;
  assert.ok(master > bronze);
});

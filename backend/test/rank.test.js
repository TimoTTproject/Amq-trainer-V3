const test = require('node:test');
const assert = require('node:assert/strict');
const { tierFromMmr, computeMmrDeltas } = require('../src/mp/rank');

test('tierFromMmr maps MMR to the right tier at boundaries', () => {
  assert.equal(tierFromMmr(0).name, 'Bronze');
  assert.equal(tierFromMmr(899).name, 'Bronze');
  assert.equal(tierFromMmr(900).name, 'Argent');
  assert.equal(tierFromMmr(1200).name, 'Or');
  assert.equal(tierFromMmr(1500).name, 'Platine');
  assert.equal(tierFromMmr(1800).name, 'Diamant');
  assert.equal(tierFromMmr(5000).name, 'Maître');
});

test('a single player has a zero delta', () => {
  const deltas = computeMmrDeltas([{ userId: 'a', score: 10, mmr: 1000 }]);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, 0);
  assert.equal(deltas[0].place, 1);
});

test('winner gains MMR and loser loses MMR (equal starting MMR)', () => {
  const deltas = computeMmrDeltas([
    { userId: 'win', score: 100, mmr: 1000 },
    { userId: 'lose', score: 10, mmr: 1000 },
  ]);
  const win = deltas.find((d) => d.userId === 'win');
  const lose = deltas.find((d) => d.userId === 'lose');
  assert.equal(win.place, 1);
  assert.equal(lose.place, 2);
  assert.ok(win.delta > 0, `win delta = ${win.delta}`);
  assert.ok(lose.delta < 0, `lose delta = ${lose.delta}`);
  // Symétrie en MMR égal : la somme des deltas est nulle.
  assert.equal(win.delta + lose.delta, 0);
});

test('beating a much stronger opponent yields a larger gain', () => {
  const upset = computeMmrDeltas([
    { userId: 'underdog', score: 100, mmr: 800 },
    { userId: 'favorite', score: 10, mmr: 1600 },
  ]).find((d) => d.userId === 'underdog');

  const expected = computeMmrDeltas([
    { userId: 'underdog', score: 100, mmr: 800 },
    { userId: 'peer', score: 10, mmr: 800 },
  ]).find((d) => d.userId === 'underdog');

  assert.ok(upset.delta > expected.delta, `${upset.delta} vs ${expected.delta}`);
});

test('places are assigned by score across a full lobby', () => {
  const deltas = computeMmrDeltas([
    { userId: 'a', score: 50, mmr: 1000 },
    { userId: 'b', score: 90, mmr: 1000 },
    { userId: 'c', score: 10, mmr: 1000 },
  ]);
  const byId = Object.fromEntries(deltas.map((d) => [d.userId, d]));
  assert.equal(byId.b.place, 1);
  assert.equal(byId.a.place, 2);
  assert.equal(byId.c.place, 3);
});

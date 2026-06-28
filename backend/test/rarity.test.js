const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RARITY_ORDER,
  RARITY_RATES,
  rarityForRank,
  rollRarity,
  MAX_SUPPLY,
} = require('../src/gacha/rarity');

test('rarityForRank follows the rank cutoffs (pyramid)', () => {
  const total = 1000;
  assert.equal(rarityForRank(0, total), 'mythic'); // top 1%
  assert.equal(rarityForRank(30, total), 'legendary'); // ~3% → 1–5%
  assert.equal(rarityForRank(100, total), 'epic'); // ~10% → 5–15%
  assert.equal(rarityForRank(300, total), 'rare'); // ~30% → 15–40%
  assert.equal(rarityForRank(999, total), 'common'); // dernier
});

test('RARITY_RATES sum to 100% and respect the order', () => {
  const sum = Object.values(RARITY_RATES).reduce((s, r) => s + r, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `somme = ${sum}`);
  assert.ok(RARITY_RATES.common > RARITY_RATES.rare);
  assert.ok(RARITY_RATES.rare > RARITY_RATES.epic);
  assert.ok(RARITY_RATES.legendary > RARITY_RATES.mythic);
});

test('rollRarity only returns known rarities and is roughly distributed', () => {
  const valid = new Set(Object.keys(RARITY_ORDER));
  const counts = { common: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const r = rollRarity();
    assert.ok(valid.has(r), `rareté inconnue: ${r}`);
    counts[r]++;
  }
  // Le commun doit largement dominer (taux attendu 70%).
  assert.ok(counts.common > counts.rare);
  assert.ok(counts.common / N > 0.5);
});

test('MAX_SUPPLY is scarcer for higher rarities', () => {
  assert.ok(MAX_SUPPLY.common > MAX_SUPPLY.rare);
  assert.ok(MAX_SUPPLY.rare > MAX_SUPPLY.epic);
  assert.ok(MAX_SUPPLY.epic > MAX_SUPPLY.legendary);
  assert.ok(MAX_SUPPLY.legendary > MAX_SUPPLY.mythic);
});

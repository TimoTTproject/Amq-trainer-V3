const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RARITY_ORDER,
  RARITY_RATES,
  rarityForRank,
  rollRarity,
  MAX_SUPPLY,
  MAX_STARS,
  ascendCost,
} = require('../src/gacha/rarity');

test('ascendCost grows per star and is 0 at max level', () => {
  assert.ok(ascendCost(1) > 0);
  assert.ok(ascendCost(4) > ascendCost(1)); // plus cher en montant
  assert.equal(ascendCost(MAX_STARS), 0); // niveau max → plus d'ascension
  assert.equal(ascendCost(99), 0);
});

test('rarityForRank : mythique (150) et légendaire (550) en effectif ABSOLU, épique/rare en % du total', () => {
  const total = 13000;
  assert.equal(rarityForRank(0, total), 'mythic');
  assert.equal(rarityForRank(149, total), 'mythic'); // 150ᵉ et dernier rang mythique (index 0-based)
  assert.equal(rarityForRank(150, total), 'legendary'); // 151ᵉ rang → 1er légendaire
  assert.equal(rarityForRank(699, total), 'legendary'); // 700ᵉ et dernier rang légendaire (150+550)
  assert.equal(rarityForRank(700, total), 'epic'); // 701ᵉ rang → 1er épique
  assert.equal(rarityForRank(1949, total), 'epic'); // encore sous 15% de 13000 (1950)
  assert.equal(rarityForRank(1950, total), 'rare'); // 15% pile → bascule rare
  assert.equal(rarityForRank(5199, total), 'rare'); // encore sous 40% (5200)
  assert.equal(rarityForRank(5200, total), 'common'); // 40% pile → bascule common
  assert.equal(rarityForRank(total - 1, total), 'common'); // dernier
});

test('rarityForRank : le quota absolu mythique+légendaire ne dépend pas de la taille du pool', () => {
  // Que le pool fasse 5000 ou 20000, exactement 150 mythiques et 550
  // légendaires — objectif de collection stable malgré la croissance du pool.
  for (const total of [5000, 13000, 20000]) {
    let mythic = 0, legendary = 0;
    for (let i = 0; i < total; i++) {
      const r = rarityForRank(i, total);
      if (r === 'mythic') mythic++;
      else if (r === 'legendary') legendary++;
    }
    assert.equal(mythic, 150, `total=${total}`);
    assert.equal(legendary, 550, `total=${total}`);
  }
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

// Configuration des raretés du gacha (5 niveaux)

const RARITY_LABELS = {
  common: 'Commun',
  rare: 'Rare',
  epic: 'Épique',
  legendary: 'Légendaire',
  mythic: 'Mythique',
};
const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3, mythic: 4 };

// Attribution de la rareté par RANG dans le pool (trié par favourites décroissant)
// → pyramide stable quelles que soient les valeurs absolues de favourites.
const RANK_CUTOFFS = [
  { rarity: 'mythic', upTo: 0.01 }, // top 1%
  { rarity: 'legendary', upTo: 0.05 }, // 1–5%
  { rarity: 'epic', upTo: 0.15 }, // 5–15%
  { rarity: 'rare', upTo: 0.4 }, // 15–40%
  { rarity: 'common', upTo: 1.0 }, // 40–100%
];
function rarityForRank(rankIndex, total) {
  const frac = (rankIndex + 1) / total;
  for (const c of RANK_CUTOFFS) if (frac <= c.upTo) return c.rarity;
  return 'common';
}

// Taux de tirage (probabilité par carte)
const PULL_WEIGHTS = [
  ['common', 70],
  ['rare', 20],
  ['epic', 7],
  ['legendary', 2.5],
  ['mythic', 0.5],
];
const TOTAL_WEIGHT = PULL_WEIGHTS.reduce((s, [, w]) => s + w, 0);
// Probabilité de tirage (en %) par rareté, pour l'affichage
const RARITY_RATES = Object.fromEntries(PULL_WEIGHTS.map(([r, w]) => [r, (w / TOTAL_WEIGHT) * 100]));
function rollRarity() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const [rarity, w] of PULL_WEIGHTS) {
    if (r < w) return rarity;
    r -= w;
  }
  return 'common';
}

// Remboursement en tokens d'un doublon, par rareté
const DUPLICATE_REFUND = { common: 2, rare: 5, epic: 15, legendary: 40, mythic: 100 };

// Poussière gagnée par doublon + coût de fabrication, par rareté
const DUST_GAIN = { common: 2, rare: 6, epic: 20, legendary: 60, mythic: 150 };
const CRAFT_COST = { common: 20, rare: 60, epic: 200, legendary: 600, mythic: 1500 };

// Pitié : nombre de tirages sans Légendaire+ avant garantie
const PITY_LIMIT = 60;

// Prix et contenu des achats
const PRICES = {
  single: { cost: 25, count: 1, guaranteeRarePlus: false },
  pack: { cost: 100, count: 5, guaranteeRarePlus: true },
};

module.exports = {
  RARITY_LABELS,
  RARITY_ORDER,
  RARITY_RATES,
  rarityForRank,
  rollRarity,
  DUPLICATE_REFUND,
  DUST_GAIN,
  CRAFT_COST,
  PITY_LIMIT,
  PRICES,
};

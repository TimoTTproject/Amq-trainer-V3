// Configuration des raretés du gacha (5 niveaux)

const RARITY_LABELS = {
  common: 'Commun',
  rare: 'Rare',
  epic: 'Épique',
  legendary: 'Légendaire',
  mythic: 'Mythique',
};
const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3, mythic: 4 };

// Attribution de la rareté par RANG dans le pool (trié par favourites décroissant).
// Hybride, décidé le 2026-07-06 : Mythique/Légendaire en EFFECTIF ABSOLU (le
// pool a grossi vite — 5000→13000+ — un % aurait fait fluctuer ces paliers à
// chaque import ; un nombre fixe donne un objectif de collection stable).
// Épique/Rare restent en % du total (évoluent avec le pool, comme avant) ;
// leur bande démarre juste après le quota absolu mythique+légendaire, donc
// légèrement plus étroite que leur pourcentage nominal tant que ce quota
// dépasse le seuil qu'il aurait occupé en %  — négligeable à cette échelle.
const MYTHIC_COUNT = 150;
const LEGENDARY_COUNT = 550;
const RANK_CUTOFFS_PCT = [
  { rarity: 'epic', upTo: 0.15 }, // jusqu'à 15% du total
  { rarity: 'rare', upTo: 0.4 }, // jusqu'à 40% du total
  { rarity: 'common', upTo: 1.0 }, // le reste
];
function rarityForRank(rankIndex, total) {
  if (rankIndex < MYTHIC_COUNT) return 'mythic';
  if (rankIndex < MYTHIC_COUNT + LEGENDARY_COUNT) return 'legendary';
  const frac = (rankIndex + 1) / total;
  for (const c of RANK_CUTOFFS_PCT) if (frac <= c.upTo) return c.rarity;
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

// Fusion (remplace poussière/craft depuis le 2026-07-06) : 3 exemplaires
// possédés (même personnage ou mélangés, même rareté) → 1 carte ALÉATOIRE de
// cette même rareté (peut retomber sur un doublon, pas de garantie de
// nouveauté). Voir POST /api/gacha/fuse.
const FUSE_COUNT = 3;

// Pitié : nombre de tirages sans Légendaire+ avant garantie
const PITY_LIMIT = 60;

// Ascension des cartes (★) : niveau 1 (base) → 5, purement cosmétique.
// Coût en DOUBLONS pour atteindre le niveau suivant (index = niveau actuel).
const MAX_STARS = 5;
const ASCEND_COST = { 1: 2, 2: 3, 3: 5, 4: 8 }; // ★2:2 doublons · ★3:3 · ★4:5 · ★5:8
// Doublons requis pour passer de `stars` à `stars+1` (0 = niveau max atteint).
function ascendCost(stars) {
  return ASCEND_COST[stars] || 0;
}

// Rareté réelle : stock max EN CIRCULATION simultanée, par rareté.
// Le recyclage rend l'exemplaire au stock (rareté dynamique, pas d'épuisement
// définitif). Les communs restent quasi illimités ; le reste est DÉRIVÉ du
// plafond mythique (25 exemplaires/personnage = l'aspect exclusif recherché)
// avec la même cascade ×4/×4/×5 qu'avant le resserrement (mythic→legendary→
// epic→rare), pour un pool élargi à ~5000 personnages (voir import-characters.js).
const MAX_SUPPLY = {
  common: 1000000,
  rare: 2000,
  epic: 400,
  legendary: 100,
  mythic: 25,
};

// Prix et contenu des achats
const PRICES = {
  pack: { cost: 100, count: 6, guaranteeRarePlus: true },
};

module.exports = {
  RARITY_LABELS,
  RARITY_ORDER,
  RARITY_RATES,
  rarityForRank,
  rollRarity,
  DUPLICATE_REFUND,
  FUSE_COUNT,
  PITY_LIMIT,
  MAX_STARS,
  ASCEND_COST,
  ascendCost,
  MAX_SUPPLY,
  PRICES,
};

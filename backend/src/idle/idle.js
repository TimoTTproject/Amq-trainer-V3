// Dojo (idle/clicker) — configuration et calculs purs (pas d'accès DB ici).
// Réutilise les raretés du gacha : un personnage assigné à un emplacement
// produit de l'essence en continu, proportionnellement à sa rareté et à son
// niveau d'ascension (★, cf. gacha/rarity.js).

const START_SLOTS = 3; // emplacements gratuits dès le départ
const MAX_SLOTS = 10; // emplacements max, débloqués un par un contre de l'essence

// Production d'essence par seconde, par carte assignée, à ★1 et avant
// multiplicateur global (amélioration « Discipline »).
const RARITY_RATE = {
  common: 0.05,
  rare: 0.2,
  epic: 0.8,
  legendary: 3,
  mythic: 12,
};

// Multiplicateur de production selon le niveau d'ascension de la carte assignée
// (même échelle 1-5 que l'ascension gacha, purement cosmétique là-bas — ici elle
// prend un sens : ascensionner ses meilleures cartes accélère le Dojo).
const STAR_MULTIPLIER = { 1: 1, 2: 1.2, 3: 1.5, 4: 2, 5: 3 };
function starMultiplier(stars) {
  return STAR_MULTIPLIER[Math.min(5, Math.max(1, stars || 1))] || 1;
}

// Taux de production d'un emplacement (essence/s), avant multiplicateur global.
function slotRate(rarity, stars) {
  return (RARITY_RATE[rarity] || 0) * starMultiplier(stars);
}

// Amélioration « Discipline » : multiplicateur de production globale.
const PROD_LEVEL_BONUS = 0.08; // +8% par niveau
const PROD_LEVEL_MAX = 40;
function prodMultiplier(level) {
  return 1 + Math.min(level, PROD_LEVEL_MAX) * PROD_LEVEL_BONUS;
}
function prodUpgradeCost(level) {
  return Math.round(50 * Math.pow(1.6, level));
}

// Amélioration « Concentration » : puissance du clic manuel.
const CLICK_BASE = 1;
const CLICK_LEVEL_BONUS = 1;
const CLICK_LEVEL_MAX = 30;
function clickYield(level) {
  return CLICK_BASE + Math.min(level, CLICK_LEVEL_MAX) * CLICK_LEVEL_BONUS;
}
function clickUpgradeCost(level) {
  return Math.round(30 * Math.pow(1.5, level));
}
const CLICK_COOLDOWN_MS = 900; // anti-spam serveur (rate-limit)

// Coût pour débloquer l'emplacement d'index `nextSlotIndex` (START_SLOTS..MAX_SLOTS-1).
function slotUpgradeCost(nextSlotIndex) {
  return Math.round(200 * Math.pow(2, nextSlotIndex - START_SLOTS));
}

// Plafond de production hors-ligne : au-delà, le surplus n'est plus compté —
// encourage à revenir régulièrement sans punir une grosse pause.
const OFFLINE_CAP_MS = 12 * 60 * 60 * 1000; // 12h

// Essence en attente depuis `lastCollectAt`, plafonnée à OFFLINE_CAP_MS, pour un
// taux de production total `totalRate` (essence/s).
function pendingEssence(lastCollectAt, totalRate, now = new Date()) {
  if (!lastCollectAt || totalRate <= 0) return 0;
  const elapsedMs = Math.min(OFFLINE_CAP_MS, Math.max(0, now.getTime() - new Date(lastCollectAt).getTime()));
  return (elapsedMs / 1000) * totalRate;
}

module.exports = {
  START_SLOTS,
  MAX_SLOTS,
  RARITY_RATE,
  STAR_MULTIPLIER,
  starMultiplier,
  slotRate,
  PROD_LEVEL_BONUS,
  PROD_LEVEL_MAX,
  prodMultiplier,
  prodUpgradeCost,
  CLICK_BASE,
  CLICK_LEVEL_BONUS,
  CLICK_LEVEL_MAX,
  clickYield,
  clickUpgradeCost,
  CLICK_COOLDOWN_MS,
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  pendingEssence,
};

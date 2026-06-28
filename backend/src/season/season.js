// Saisons (mensuelles) — récompenses SANS reset du MMR. Logique pure :
// identifiant/fenêtre de saison, palier→index, et barème de récompense.
const { TIERS } = require('../mp/rank');

const MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

// AAAA-MM (mois local)
function currentSeason(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function seasonLabel(season) {
  const [y, m] = season.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function seasonStart(season) {
  const [y, m] = season.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
function seasonEnd(season) {
  const [y, m] = season.split('-').map(Number);
  return new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1); // 1er du mois suivant
}

// Index 0..5 du palier (Bronze→Maître) à partir de son nom ; -1 si inconnu/non classé.
function tierIndexFromName(name) {
  if (!name) return -1;
  return TIERS.findIndex((t) => t.name === name);
}

// Barème de récompense par index de palier.
const SEASON_TOKENS = [60, 120, 220, 380, 600, 900];
const SEASON_DUST = [10, 20, 40, 70, 110, 160];
function computeSeasonReward(tierIndex) {
  if (tierIndex < 0) return { tokens: 0, dust: 0 };
  return { tokens: SEASON_TOKENS[tierIndex] || 0, dust: SEASON_DUST[tierIndex] || 0 };
}

module.exports = {
  currentSeason, seasonLabel, seasonStart, seasonEnd,
  tierIndexFromName, computeSeasonReward, SEASON_TOKENS, SEASON_DUST,
};

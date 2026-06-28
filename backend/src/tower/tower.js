// Château de l'Infini — règles du mode (économie « douce » + chrono qui se resserre)

const ENTRY_COST = 40; // coût en tokens (1 entrée gratuite par jour)
const START_LIVES = 3;
const MAX_LIVES = 5;
const LIFE_BONUS_EVERY = 5; // +1 vie tous les 5 étages franchis (jusqu'à MAX_LIVES)
const ANSWER_GRACE_MS = 2000; // marge réseau ajoutée au chrono côté serveur

// Temps de réponse autorisé (secondes) pour un étage : 20 s qui descendent
// progressivement jusqu'à un plancher de 6 s.
function timeLimitForFloor(floor) {
  return Math.max(6, Math.round(20 - (floor - 1) * 0.5));
}

// Récompense en tokens à la fin d'une partie selon le nombre d'étages franchis.
// Gain volontairement généreux : rentable dès ~8 étages (entrée 40), avec un
// bonus de palier tous les 10 étages pour récompenser les longues montées.
function computeReward(clearedFloors) {
  return clearedFloors * 5 + Math.floor(clearedFloors / 10) * 25;
}

// Une nouvelle entrée gratuite est-elle disponible aujourd'hui ?
function freeEntryAvailable(lastFreeAt) {
  if (!lastFreeAt) return true;
  const last = new Date(lastFreeAt);
  const now = new Date();
  return (
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth() ||
    last.getDate() !== now.getDate()
  );
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  ENTRY_COST,
  START_LIVES,
  MAX_LIVES,
  LIFE_BONUS_EVERY,
  ANSWER_GRACE_MS,
  timeLimitForFloor,
  computeReward,
  freeEntryAvailable,
  shuffle,
};

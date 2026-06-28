// Défi du jour (solo classé) — logique pure : tirage du set, score d'une chanson,
// et variation de MMR. Sans adversaire, le MMR évolue en ELO contre une difficulté
// de référence fixe (auto-équilibrant : on monte tant qu'on fait mieux qu'attendu).

const DAILY_SONG_COUNT = 10; // chansons par défi
const DAILY_DURATION_MS = 30000; // temps de réponse par chanson
const DAILY_GRACE_MS = 2000; // marge réseau ajoutée au chrono côté serveur
const BASE_RATING = 1000; // « niveau » de référence d'un défi (cible ELO)
const K_FACTOR = 24; // amplitude max d'une variation de MMR
const MIN_MMR = 100;

// AAAA-MM-JJ (jour local) — borne « 1 essai par jour ».
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayStr(d = new Date()) {
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  return todayStr(y);
}

// Nouvelle série après avoir terminé le défi : +1 si la veille était jouée,
// inchangée si déjà jouée aujourd'hui (sécurité), sinon repart à 1.
function computeStreak(lastDay, currentStreak, today = todayStr(), yest = yesterdayStr()) {
  if (lastDay === today) return currentStreak || 1;
  if (lastDay === yest) return (currentStreak || 0) + 1;
  return 1;
}

// Récompense en tokens du défi, croissante avec la série (plafonnée).
function streakReward(streak) {
  return Math.min(100, 20 + Math.max(0, streak - 1) * 10);
}

// Tire `count` ids distincts au hasard parmi des candidats (mélange de Fisher-Yates).
// Appelé UNE fois par jour ; le résultat est stocké → tout le monde a le même set.
function pickDailySongIds(candidateIds, count = DAILY_SONG_COUNT) {
  const a = [...new Set(candidateIds)];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(count, a.length));
}

// Score d'une chanson : 300 pour une bonne réponse + jusqu'à 700 selon la vitesse.
// Mauvais ou hors-temps → 0.
function scoreSong({ correct, elapsedMs, durationMs = DAILY_DURATION_MS }) {
  if (!correct) return 0;
  const left = Math.max(0, durationMs - Math.max(0, elapsedMs));
  return 300 + Math.round((left / durationMs) * 700);
}

// Score maximum atteignable sur un défi (toutes bonnes, instantanées).
function maxScore(songCount) {
  return songCount * 1000;
}

// Variation de MMR d'un run solo : ELO contre une difficulté fixe (BASE_RATING).
// perf = score / scoreMax (0..1) ; attendu = probabilité ELO de « battre » le défi.
function computeSoloMmrDelta(mmr, score, scoreMax) {
  if (!scoreMax) return 0;
  const perf = Math.max(0, Math.min(1, score / scoreMax));
  const expected = 1 / (1 + Math.pow(10, (BASE_RATING - mmr) / 400));
  return Math.round(K_FACTOR * (perf - expected));
}

// Applique la variation en respectant le plancher de MMR.
function applyMmr(mmr, delta) {
  return Math.max(MIN_MMR, mmr + delta);
}

module.exports = {
  DAILY_SONG_COUNT,
  DAILY_DURATION_MS,
  DAILY_GRACE_MS,
  BASE_RATING,
  K_FACTOR,
  MIN_MMR,
  todayStr,
  yesterdayStr,
  computeStreak,
  streakReward,
  pickDailySongIds,
  scoreSong,
  maxScore,
  computeSoloMmrDelta,
  applyMmr,
};

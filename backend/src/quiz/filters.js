// Filtres de sélection des musiques du quiz, partagés solo (quiz.routes) et
// multijoueur (mp.js) : difficulté par popularité AniList et période de
// diffusion. Renvoient des fragments de `where` Prisma à étaler.

// Difficulté RÉELLE d'abord : % de joueurs qui trouvent la musique
// (Song.guessRate, alimenté par song-stats.js), avec repli sur la popularité
// AniList tant que l'échantillon est trop petit (guessRate null). Paliers :
// faciles ≥ 60 % de réussite (repli : popularité ≥ 100 000), moyens 25-59 %
// (repli 30 000-99 999), difficiles < 25 % (repli < 30 000 — popularité
// inconnue = 0 y tombe aussi, faute de mieux).
// ATTENTION : le fragment renvoyé contient un OR — le combiner aux autres
// filtres OR (ex. preferMainContent) via AND: [...], jamais par étalement.
const DIFFICULTIES = ['all', 'popular', 'medium', 'obscure'];
function difficultyWhere(difficulty) {
  if (difficulty === 'popular') {
    return { OR: [{ guessRate: { gte: 60 } }, { guessRate: null, popularity: { gte: 100000 } }] };
  }
  if (difficulty === 'medium') {
    return { OR: [{ guessRate: { gte: 25, lt: 60 } }, { guessRate: null, popularity: { gte: 30000, lt: 100000 } }] };
  }
  if (difficulty === 'obscure') {
    return { OR: [{ guessRate: { lt: 25 } }, { guessRate: null, popularity: { lt: 30000 } }] };
  }
  return {};
}

// Période de diffusion (bornes incluses). Une borne à 0 = ouverte. Le plancher
// à 1 exclut les années inconnues (sentinelle 0) et pas-encore-backfillées
// (null) dès qu'un filtre est actif : mieux vaut rater quelques titres que
// servir un anime hors période demandée.
function yearWhere(yearMin, yearMax) {
  if (!yearMin && !yearMax) return {};
  return { seasonYear: { gte: yearMin || 1, lte: yearMax || 9999 } };
}

// Bornes d'année plausibles pour valider les entrées client.
function sanitizeYear(value) {
  const year = parseInt(value) || 0;
  return year >= 1950 && year <= 2100 ? year : 0;
}

module.exports = { DIFFICULTIES, difficultyWhere, yearWhere, sanitizeYear };

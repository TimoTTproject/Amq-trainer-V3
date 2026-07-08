// Filtres de sélection des musiques du quiz, partagés solo (quiz.routes) et
// multijoueur (mp.js) : difficulté par popularité AniList et période de
// diffusion. Renvoient des fragments de `where` Prisma à étaler.

// Paliers de popularité (nb de membres AniList de l'anime) :
// populaires ≥ 100 000, moyens 30 000–99 999, obscurs < 30 000 (les animes à
// popularité inconnue — 0 — tombent dans « obscurs », faute de mieux).
const DIFFICULTIES = ['all', 'popular', 'medium', 'obscure'];
function difficultyWhere(difficulty) {
  if (difficulty === 'popular') return { popularity: { gte: 100000 } };
  if (difficulty === 'medium') return { popularity: { gte: 30000, lt: 100000 } };
  if (difficulty === 'obscure') return { popularity: { lt: 30000 } };
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

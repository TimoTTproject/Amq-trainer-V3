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
  // Bornes inversées réordonnées ici (dernier filet) : l'UI solo et le salon
  // multi les échangent déjà à la saisie, mais une valeur persistée avant ce
  // garde-fou (localStorage) produirait un intervalle vide → « aucune musique ».
  if (yearMin && yearMax && yearMin > yearMax) [yearMin, yearMax] = [yearMax, yearMin];
  return { seasonYear: { gte: yearMin || 1, lte: yearMax || 9999 } };
}

// Bornes d'année plausibles pour valider les entrées client.
function sanitizeYear(value) {
  const year = parseInt(value) || 0;
  return year >= 1950 && year <= 2100 ? year : 0;
}

// Statuts AniList filtrables (mode « Ma liste » et pool multi « listes »).
// REPEATING (re-visionnage) est assimilé à COMPLETED côté client : cocher
// « Terminés » couvre les deux.
const LIST_STATUSES = ['COMPLETED', 'CURRENT', 'PAUSED', 'DROPPED', 'PLANNING'];
// Parse une liste de statuts venue du client (CSV) : whitelist + expansion
// COMPLETED→REPEATING. Renvoie null si vide ou complète (= pas de filtre).
function sanitizeListStatuses(raw) {
  const wanted = String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => LIST_STATUSES.includes(s));
  if (!wanted.length || wanted.length === LIST_STATUSES.length) return null;
  return wanted.includes('COMPLETED') ? [...wanted, 'REPEATING'] : wanted;
}

// Anti-doublon (solo « Ma liste »/« Catalogue global » — le multijoueur a son
// propre mécanisme serveur, room.usedAnilistIds, déjà actif dans tous les
// modes) : liste d'anilistId à exclure du tirage, reçue en CSV depuis le
// client (accumulée manche après manche, cf. anime-search-core côté client
// non — plutôt main.js). Whitelist stricte (entiers positifs) + plafond pour
// ne pas laisser un client malveillant gonfler la requête indéfiniment.
const MAX_EXCLUDE_ANILIST = 2000;
function sanitizeExcludeAnilist(raw) {
  if (!raw) return [];
  const ids = String(raw)
    .split(',')
    .map((s) => parseInt(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_EXCLUDE_ANILIST);
}

module.exports = {
  DIFFICULTIES, difficultyWhere, yearWhere, sanitizeYear,
  LIST_STATUSES, sanitizeListStatuses,
  sanitizeExcludeAnilist,
};

// Classification du format AniList (TV/MOVIE/OVA…) + fragment de requête Prisma.
// Sert à prioriser la série principale (TV) face aux contenus secondaires.

// Formats considérés « secondaires » (films, OAV/OAD, épisodes spéciaux, clips).
const SIDE_FORMATS = ['MOVIE', 'OVA', 'SPECIAL', 'MUSIC'];

// Un format est « principal » (série) s'il est inconnu, neutre ou non secondaire.
// (null = jamais tagué ; 'UNKNOWN' = AniList n'a pas renvoyé de format.)
function isMainFormat(format) {
  if (!format) return true;
  return !SIDE_FORMATS.includes(format);
}

// Fragment Prisma null-safe : exclut les contenus secondaires CONNUS, mais garde
// les morceaux non tagués (null / 'UNKNOWN'). À combiner sous AND avec d'autres
// filtres ; prévoir un repli si le résultat est vide (catalogue pas encore tagué).
const preferMainContent = { OR: [{ format: null }, { format: { notIn: SIDE_FORMATS } }] };

module.exports = { SIDE_FORMATS, isMainFormat, preferMainContent };

// Cœur de la recherche/autocomplétion d'animes, PARTAGÉ client + serveur :
// chargé tel quel dans le navigateur (globals) et via require() côté Node
// (src/quiz/quiz.routes.js). Une seule implémentation du matching et du tri —
// les copies séparées client/serveur ont causé plusieurs désynchronisations.

// Normalisation « collée » : minuscules, accents retirés, espaces/ponctuation
// supprimés — « re zero », « rezero » et « Re:Zero » deviennent tous « rezero ».
function animeSearchNormalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritiques
    .replace(/[^a-z0-9]/g, ''); // espaces + ponctuation
}

// Variante qui découpe en mots au lieu de tout coller : sert au matching
// multi-mots (chaque mot tapé doit matcher un début de mot du titre, dans
// n'importe quel ordre) et à la détection de match sur mot entier.
function animeSearchWordTokens(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Champs de recherche précalculés d'une entrée à partir de ses variantes de
// titre (titre + anglais + synonymes, déjà filtrées côté appelant) :
// - searchTitles : chaînes collées, pour exact/substring ;
// - titleTokens  : mots de chaque variante, pour le matching multi-mots ;
// - acronyms     : initiales de chaque variante multi-mots (« aot » pour
//                  Attack on Titan, « kny » pour Kimetsu no Yaiba…).
function buildAnimeSearchFields(titles) {
  const clean = titles.filter(Boolean);
  const titleTokens = clean.map(animeSearchWordTokens).filter((tokens) => tokens.length);
  return {
    searchTitles: [...new Set(clean.map(animeSearchNormalize).filter(Boolean))],
    titleTokens,
    acronyms: [...new Set(
      titleTokens
        .filter((tokens) => tokens.length >= 2)
        .map((tokens) => tokens.map((t) => t[0]).join(''))
        .filter((a) => a.length >= 2)
    )],
  };
}

// Paliers de correspondance, du meilleur au moins bon :
// 0 exact       — la saisie collée égale une variante entière ;
// 1 wholeWords  — chaque mot tapé est un mot ENTIER d'une même variante
//                 (« magi » ↛ « Magical Girl Site », ✓ « Magi: The Labyrinth… ») ;
// 2 acronym     — la saisie collée égale les initiales d'une variante (« aot ») ;
// 3 wordStarts  — chaque mot tapé est un DÉBUT de mot d'une même variante,
//                 dans n'importe quel ordre (« attack titan », « titan attack ») ;
// 4 substring   — la saisie collée est contenue quelque part (filet de sécurité).
// Renvoie null si l'entrée ne matche pas.
function scoreAnimeEntry(entry, needle, qTokens) {
  let tier = -1;
  let inOrder = false;
  let matchIndex = Number.MAX_SAFE_INTEGER;
  let matchLen = Number.MAX_SAFE_INTEGER;
  // Un candidat par palier atteignable ; on garde le meilleur.
  const consider = (t, ordered, index, len) => {
    if (
      tier < 0 || t < tier ||
      (t === tier && (
        (ordered - inOrder) > 0 ||
        (ordered === inOrder && (index < matchIndex || (index === matchIndex && len < matchLen)))
      ))
    ) {
      tier = t;
      inOrder = ordered;
      matchIndex = index;
      matchLen = len;
    }
  };

  for (const title of entry.searchTitles) {
    if (title === needle) consider(0, true, 0, title.length);
    const index = title.indexOf(needle);
    if (index >= 0) consider(4, false, index, title.length);
  }
  if (needle.length >= 2 && entry.acronyms.includes(needle)) consider(2, true, 0, needle.length);

  for (const words of entry.titleTokens) {
    let allWhole = true;
    let allStart = true;
    let firstIndex = Number.MAX_SAFE_INTEGER;
    for (const q of qTokens) {
      let whole = false;
      let start = false;
      for (let i = 0; i < words.length; i++) {
        if (!words[i].startsWith(q)) continue;
        start = true;
        if (words[i] === q) whole = true;
        if (i < firstIndex) firstIndex = i;
        if (whole) break;
      }
      if (!whole) allWhole = false;
      if (!start) { allStart = false; break; }
    }
    if (!allStart) continue;
    // Les mots tapés apparaissent-ils dans l'ordre du titre ? (bonus de tri)
    let cursor = 0;
    let ordered = true;
    for (const q of qTokens) {
      while (cursor < words.length && !words[cursor].startsWith(q)) cursor++;
      if (cursor >= words.length) { ordered = false; break; }
      cursor++;
    }
    const len = words.join('').length;
    if (allWhole) consider(1, ordered, firstIndex, len);
    consider(3, ordered, firstIndex, len);
  }

  return tier < 0 ? null : { entry, tier, inOrder, matchIndex, matchLen };
}

// Filtre + trie les entrées pour une saisie brute. Ordre : palier, mots dans
// l'ordre du titre, position du match, longueur de la variante matchée, saison
// (S1 avant S2…), popularité, titre le plus court, alphabétique.
function filterAnimeEntries(entries, rawQuery, limit = 20) {
  const needle = animeSearchNormalize(rawQuery);
  if (!needle) return [];
  const qTokens = animeSearchWordTokens(rawQuery);
  const scored = [];
  for (const entry of entries) {
    const s = scoreAnimeEntry(entry, needle, qTokens);
    if (s) scored.push(s);
  }
  scored.sort((a, b) =>
    a.tier - b.tier ||
    (b.inOrder - a.inOrder) ||
    a.matchIndex - b.matchIndex ||
    a.matchLen - b.matchLen ||
    (a.entry.seasonNumber || 0) - (b.entry.seasonNumber || 0) ||
    (b.entry.popularity || 0) - (a.entry.popularity || 0) ||
    a.entry.title.length - b.entry.title.length ||
    a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, limit).map(({ entry }) => entry);
}

// Export Node (le navigateur consomme directement les globals ci-dessus).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { animeSearchNormalize, animeSearchWordTokens, buildAnimeSearchFields, filterAnimeEntries };
}

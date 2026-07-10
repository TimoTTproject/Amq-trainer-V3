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
// - variants : une par titre distinct — { title (brut, pour l'affichage
//              « ≈ synonyme »), collapsed (chaîne collée, exact/substring),
//              words (mots, matching multi-mots) } ;
// - acronyms : initiales de chaque variante multi-mots — { acronym, title }
//              (« aot » pour Attack on Titan, « kny » pour Kimetsu no Yaiba…).
function buildAnimeSearchFields(titles) {
  const variants = [];
  const seen = new Set();
  for (const title of titles) {
    if (!title) continue;
    const collapsed = animeSearchNormalize(title);
    if (!collapsed || seen.has(collapsed)) continue;
    seen.add(collapsed);
    variants.push({ title, collapsed, words: animeSearchWordTokens(title) });
  }
  const acronyms = [];
  const seenAcronyms = new Set();
  for (const { title, words } of variants) {
    if (words.length < 2) continue;
    const acronym = words.map((w) => w[0]).join('');
    if (acronym.length < 2 || seenAcronyms.has(acronym)) continue;
    seenAcronyms.add(acronym);
    acronyms.push({ acronym, title });
  }
  return { variants, acronyms };
}

// Paliers de correspondance, du meilleur au moins bon :
// 0 exact       — la saisie collée égale une variante entière ;
// 1 wholeWords  — chaque mot tapé est un mot ENTIER d'une même variante
//                 (« magi » ↛ « Magical Girl Site », ✓ « Magi: The Labyrinth… ») ;
// 2 acronym     — la saisie collée égale les initiales d'une variante (« aot ») ;
// 3 wordStarts  — chaque mot tapé est un DÉBUT de mot d'une même variante,
//                 dans n'importe quel ordre (« attack titan », « titan attack ») ;
// 4 substring   — la saisie collée est contenue quelque part (filet de sécurité).
// Renvoie null si l'entrée ne matche pas, sinon le score + la variante qui a
// produit le meilleur match (matchedTitle brut, matchedAcronym si palier 2) —
// pour que l'UI puisse expliquer le résultat (« ≈ Demon Slayer », « ≈ AOT »).
function scoreAnimeEntry(entry, needle, qTokens) {
  let best = null;
  const consider = (tier, inOrder, matchIndex, matchLen, matchedTitle, matchedAcronym) => {
    if (
      !best || tier < best.tier ||
      (tier === best.tier && (
        (inOrder - best.inOrder) > 0 ||
        (inOrder === best.inOrder && (matchIndex < best.matchIndex ||
          (matchIndex === best.matchIndex && matchLen < best.matchLen)))
      ))
    ) {
      best = { entry, tier, inOrder, matchIndex, matchLen, matchedTitle, matchedAcronym: matchedAcronym || null };
    }
  };

  for (const { title, collapsed, words } of entry.variants) {
    if (collapsed === needle) consider(0, true, 0, collapsed.length, title);
    const index = collapsed.indexOf(needle);
    if (index >= 0) consider(4, false, index, collapsed.length, title);

    // Matching multi-mots : chaque mot tapé doit être un début de mot de CETTE
    // variante (mot entier → palier 1, simple début → palier 3).
    let allWhole = true;
    let allStart = true;
    let firstIndex = Number.MAX_SAFE_INTEGER;
    for (const q of qTokens) {
      let whole = false;
      let start = false;
      for (let i = 0; i < words.length; i++) {
        if (!words[i].startsWith(q)) continue;
        start = true;
        if (i < firstIndex) firstIndex = i;
        if (words[i] === q) { whole = true; break; }
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
    if (allWhole) consider(1, ordered, firstIndex, collapsed.length, title);
    consider(3, ordered, firstIndex, collapsed.length, title);
  }

  if (needle.length >= 2) {
    for (const { acronym, title } of entry.acronyms) {
      if (acronym === needle) consider(2, true, 0, acronym.length, title, acronym);
    }
  }

  return best;
}

// Filtre + trie les entrées pour une saisie brute. Ordre : palier, mots dans
// l'ordre du titre, ORDRE DE GRANDEUR de popularité (l'anime « évident » —
// One Piece pour « one » — doit remonter entre franchises différentes, alors
// que les tie-breaks textuels ci-dessous départagent surtout des titres
// proches), position du match, saison (S1 avant S2… — AVANT la longueur de la
// variante matchée, sinon « Yu-Gi-Oh! GX » passe devant « Yu-Gi-Oh! Duel
// Monsters » juste parce que son titre est plus court), longueur de la variante
// matchée, popularité exacte, titre le plus court, alphabétique.
// Renvoie des objets { entry, matchedTitle, matchedAcronym } — l'appelant
// affiche entry.* et peut expliquer le match via matchedTitle/matchedAcronym.
function filterAnimeEntries(entries, rawQuery, limit = 20) {
  const needle = animeSearchNormalize(rawQuery);
  if (!needle) return [];
  const qTokens = animeSearchWordTokens(rawQuery);
  const scored = [];
  for (const entry of entries) {
    const s = scoreAnimeEntry(entry, needle, qTokens);
    if (s) scored.push(s);
  }
  // seasonNumber 0 = hors chaîne numérotée (OAV/film/spécial, ou œuvre isolée
  // — cf. computeSeasonNumbers côté serveur), PAS « avant la saison 1 » : sans
  // ce garde-fou, un OAV (0) doublait la vraie saison 1 (1) puisque 0 < 1 en
  // tri ascendant (« dr stone » faisait ressortir Ryusui avant Dr. Stone S1).
  const seasonRank = (n) => (n > 0 ? n : Infinity);
  // Popularité par ordre de grandeur (log10) et non brute : au sein d'une même
  // franchise les saisons/OAV restent dans la même tranche, donc l'ordre
  // S1→S2→spin-offs (seasonRank, ci-dessus) continue de primer ; entre
  // franchises éloignées d'une tranche ou plus, la plus connue passe devant.
  const popBucket = (entry) => Math.floor(Math.log10((entry.popularity || 0) + 1));
  scored.sort((a, b) =>
    a.tier - b.tier ||
    (b.inOrder - a.inOrder) ||
    popBucket(b.entry) - popBucket(a.entry) ||
    a.matchIndex - b.matchIndex ||
    seasonRank(a.entry.seasonNumber) - seasonRank(b.entry.seasonNumber) ||
    a.matchLen - b.matchLen ||
    (b.entry.popularity || 0) - (a.entry.popularity || 0) ||
    a.entry.title.length - b.entry.title.length ||
    a.entry.title.localeCompare(b.entry.title));
  return scored.slice(0, limit).map(({ entry, matchedTitle, matchedAcronym }) => ({ entry, matchedTitle, matchedAcronym }));
}

// Plages [start, end) à surligner dans `raw` (chaîne BRUTE, telle qu'affichée)
// pour la saisie `rawQuery` : chaque mot tapé surligne le début de mot qu'il
// matche ; si aucun mot ne matche (match substring « collé »), on surligne la
// première occurrence de la saisie collée. Le mapping caractère normalisé →
// caractère brut absorbe accents, ponctuation et casse.
function animeSearchHighlightRanges(raw, rawQuery) {
  const needle = animeSearchNormalize(rawQuery);
  if (!raw || !needle) return [];
  // norm[j] = j-ième caractère normalisé ; map[j] = index du caractère brut d'origine.
  let norm = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const n = animeSearchNormalize(raw[i]);
    for (const c of n) { norm += c; map.push(i); }
  }
  const isWordStart = (j) => j === 0 || map[j] > map[j - 1] + 1; // caractère(s) séparateur(s) sautés
  const ranges = [];
  const pushRange = (j, len) => ranges.push({ start: map[j], end: map[j + len - 1] + 1 });

  let matchedToken = false;
  for (const q of animeSearchWordTokens(rawQuery)) {
    for (let j = 0; j + q.length <= norm.length; j++) {
      if (!isWordStart(j) || norm.slice(j, j + q.length) !== q) continue;
      pushRange(j, q.length);
      matchedToken = true;
      break;
    }
  }
  if (!matchedToken) {
    const idx = norm.indexOf(needle);
    if (idx >= 0) pushRange(idx, needle.length);
  }
  // Fusionne les plages qui se chevauchent (ex. saisie « ma mag »).
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push(r);
  }
  return merged;
}

// Export Node (le navigateur consomme directement les globals ci-dessus).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    animeSearchNormalize, animeSearchWordTokens, buildAnimeSearchFields,
    filterAnimeEntries, animeSearchHighlightRanges,
  };
}

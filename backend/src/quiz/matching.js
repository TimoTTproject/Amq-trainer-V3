// Matching de réponse : compare la saisie du joueur aux titres acceptés d'une
// musique (romaji/anglais/natif/synonymes), avec tolérance aux petites fautes.
const stringSimilarity = require('string-similarity');

// Normalisation : minuscules + on retire ponctuation/espaces. Le « ∞ » stylisé
// (ex. « SK∞ » = SK8 the Infinity) est converti en « 8 » pour rester saisissable.
// L'apostrophe est gardée (variantes ’/` ramenées à ') : certaines suites portent
// un titre qui ne diffère de l'original QUE par une apostrophe finale (ex. « Gintama »
// / « Gintama' », deux animes distincts) — sans ça, les deux deviennent la même
// chaîne et sont acceptés l'un pour l'autre.
const norm = (s) => (s || '').toLowerCase().replace(/∞/g, '8').replace(/[’`]/g, "'").replace(/[^a-z0-9']/g, '');

// Distance de Levenshtein (nombre de corrections entre deux chaînes)
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

function isCorrectGuess(guess, song) {
  const g = norm(guess);
  if (!g.length) return false;
  const candidates = [song.animeTitle, ...(song.altTitles || [])]
    .map(norm)
    .filter((t) => t.length);
  // Match exact accepté quelle que soit la longueur : sans ça, les titres très
  // courts (« 86 », « K »… → moins de 3 caractères normalisés) ne pouvaient
  // JAMAIS être validés, même tapés exactement. La tolérance aux fautes et les
  // variantes restent réservées aux saisies d'au moins 3 caractères (trop de
  // faux positifs en dessous).
  if (candidates.some((t) => t === g)) return true;
  if (g.length < 3) return false;
  return candidates.some((t) => {
    // Une apostrophe finale marque parfois une suite différente de l'original
    // (« Gintama' » est un autre anime que « Gintama », pas juste une saison) :
    // si les deux chaînes ne diffèrent QUE par cette apostrophe, on refuse — la
    // tolérance aux fautes ci-dessous ne doit pas l'avaler comme un simple typo.
    if (t === g + "'" || g === t + "'") return false;
    // Variante saison/partie : l'un est PRÉFIXE de l'autre et la partie commune
    // est majoritaire (≥ 50 %). Évite qu'un simple fragment (« online », « piece »…)
    // ou qu'un titre court contenu dans une AUTRE réponse ne valide à tort — et
    // qu'une suite marquée par une apostrophe (idem) ne passe pour l'original.
    const [shorter, longer] = g.length <= t.length ? [g, t] : [t, g];
    if (
      shorter.length >= 5 &&
      longer.startsWith(shorter) &&
      shorter.length / longer.length >= 0.5 &&
      longer[shorter.length] !== "'"
    ) return true;
    // 1-2 petites fautes, proportionnées à la longueur
    const dist = editDistance(g, t);
    if (dist <= 2 && dist / Math.max(g.length, t.length) <= 0.25) return true;
    // filet de sécurité : similarité globale élevée
    return stringSimilarity.compareTwoStrings(t, g) >= 0.85;
  });
}

module.exports = { norm, editDistance, isCorrectGuess };

// Matching de réponse : compare la saisie du joueur aux titres acceptés d'une
// musique (romaji/anglais/natif/synonymes), avec tolérance aux petites fautes.
const stringSimilarity = require('string-similarity');

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
  if (g.length < 3) return false;
  const candidates = [song.animeTitle, ...(song.altTitles || [])]
    .map(norm)
    .filter((t) => t.length);
  return candidates.some((t) => {
    if (t === g) return true;
    // Variante saison/partie : l'un est PRÉFIXE de l'autre et la partie commune
    // est majoritaire (≥ 50 %). Évite qu'un simple fragment (« online », « piece »…)
    // ou qu'un titre court contenu dans une AUTRE réponse ne valide à tort.
    const [shorter, longer] = g.length <= t.length ? [g, t] : [t, g];
    if (shorter.length >= 5 && longer.startsWith(shorter) && shorter.length / longer.length >= 0.5) return true;
    // 1-2 petites fautes, proportionnées à la longueur
    const dist = editDistance(g, t);
    if (dist <= 2 && dist / Math.max(g.length, t.length) <= 0.25) return true;
    // filet de sécurité : similarité globale élevée
    return stringSimilarity.compareTwoStrings(t, g) >= 0.85;
  });
}

module.exports = { norm, editDistance, isCorrectGuess };

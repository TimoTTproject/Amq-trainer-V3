const test = require('node:test');
const assert = require('node:assert/strict');
const { norm, editDistance, isCorrectGuess } = require('../src/quiz/matching');

test('norm strips case, spaces and punctuation', () => {
  assert.equal(norm('Attack on Titan!'), 'attackontitan');
  assert.equal(norm('  Re:ZERO  '), 'rezero');
  assert.equal(norm(null), '');
});

test('editDistance counts single-character corrections', () => {
  assert.equal(editDistance('naruto', 'naruto'), 0);
  assert.equal(editDistance('naruto', 'narut'), 1); // suppression
  assert.equal(editDistance('naruto', 'naruta'), 1); // substitution
  assert.equal(editDistance('', 'abc'), 3);
});

test('accepts the exact title (any alt title)', () => {
  const song = { animeTitle: 'Shingeki no Kyojin', altTitles: ['Attack on Titan', '進撃の巨人'] };
  assert.ok(isCorrectGuess('Attack on Titan', song));
  assert.ok(isCorrectGuess('shingeki no kyojin', song));
  assert.ok(isCorrectGuess('ATTACK ON TITAN!!', song));
});

test('tolerates small typos proportional to length', () => {
  const song = { animeTitle: 'Bleach', altTitles: [] };
  assert.ok(isCorrectGuess('Blech', song)); // 1 faute
  const long = { animeTitle: 'Jujutsu Kaisen', altTitles: [] };
  assert.ok(isCorrectGuess('Jujutsu Kaizen', long)); // 1 faute sur un titre long
});

test('matches meaningful sub/super titles (seasons, parts)', () => {
  const song = { animeTitle: 'Attack on Titan: The Final Season', altTitles: ['Attack on Titan'] };
  assert.ok(isCorrectGuess('Attack on Titan', song));
});

test('accepts base name for a season-only title (no base alt title)', () => {
  const song = { animeTitle: 'Jujutsu Kaisen Season 2', altTitles: [] };
  assert.ok(isCorrectGuess('Jujutsu Kaisen', song)); // préfixe majoritaire
});

test('handles the stylised ∞ title (SK∞ = SK8)', () => {
  assert.equal(norm('SK∞'), 'sk8');
  const song = { animeTitle: 'SK∞', altTitles: ['SK8 the Infinity'] };
  assert.ok(isCorrectGuess('SK8', song));
  assert.ok(isCorrectGuess('SK∞', song));
  assert.ok(isCorrectGuess('SK8 the Infinity', song));
});

test('rejects partial fragments that are not a majority prefix', () => {
  // « online » est contenu dans le titre mais n'en est pas un préfixe → refusé
  assert.equal(isCorrectGuess('online', { animeTitle: 'Sword Art Online', altTitles: [] }), false);
  // « piece » contenu dans « One Piece » mais pas préfixe → refusé
  assert.equal(isCorrectGuess('piece', { animeTitle: 'One Piece', altTitles: [] }), false);
  // « academia » contenu mais pas préfixe → refusé
  assert.equal(isCorrectGuess('academia', { animeTitle: 'Boku no Hero Academia', altTitles: [] }), false);
  // préfixe trop court par rapport au titre (< 50 %) → refusé
  assert.equal(isCorrectGuess('sword', { animeTitle: 'Sword Art Online', altTitles: [] }), false);
});

test('does not confuse a title with its apostrophe-suffixed sequel (Gintama vs Gintama\')', () => {
  // « Gintama' » est une suite distincte de « Gintama », pas une simple variante
  // de saison : les deux ne doivent pas se valider l'un l'autre.
  const gintama = { animeTitle: 'Gintama', altTitles: [] };
  const gintamaPrime = { animeTitle: "Gintama'", altTitles: [] };
  assert.equal(isCorrectGuess("Gintama'", gintama), false);
  assert.equal(isCorrectGuess('Gintama', gintamaPrime), false);
  // La suite plus longue (« Gintama': Enchousen ») ne doit pas non plus passer
  // pour « Gintama » via le préfixe majoritaire.
  const enchousen = { animeTitle: "Gintama': Enchousen", altTitles: [] };
  assert.equal(isCorrectGuess('Gintama', enchousen), false);
  // Les deux restent bien sûr reconnaissables par leur propre nom exact.
  assert.ok(isCorrectGuess('Gintama', gintama));
  assert.ok(isCorrectGuess("Gintama'", gintamaPrime));
});

test('rejects empty, too-short or wrong guesses', () => {
  const song = { animeTitle: 'Naruto', altTitles: ['ナルト'] };
  assert.equal(isCorrectGuess('', song), false);
  assert.equal(isCorrectGuess('na', song), false); // < 3 caractères
  assert.equal(isCorrectGuess('One Piece', song), false);
});

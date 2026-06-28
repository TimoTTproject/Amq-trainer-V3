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

test('rejects empty, too-short or wrong guesses', () => {
  const song = { animeTitle: 'Naruto', altTitles: ['ナルト'] };
  assert.equal(isCorrectGuess('', song), false);
  assert.equal(isCorrectGuess('na', song), false); // < 3 caractères
  assert.equal(isCorrectGuess('One Piece', song), false);
});

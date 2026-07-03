const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAmbiguousTitleKeys, stripAmbiguousAltTitles } = require('../src/catalog/catalog.service');

test('flags a synonym shared by several distinct anilistIds as ambiguous', () => {
  // AniList liste souvent le nom générique de la franchise comme synonyme de
  // CHAQUE saison prise séparément (chacune a son propre anilistId).
  const entries = [
    { anilistId: 1, animeTitle: 'Pocket Monsters', altTitles: ['Pokemon', 'Pokémon'] },
    { anilistId: 2, animeTitle: 'Pocket Monsters: Diamond & Pearl', altTitles: ['Pokemon', 'Pokémon DP'] },
    { anilistId: 3, animeTitle: 'Naruto', altTitles: ['Naruto'] },
  ];
  const ambiguous = computeAmbiguousTitleKeys(entries);
  assert.ok(ambiguous.has('pokemon')); // partagé par anilistId 1 et 2
  assert.ok(!ambiguous.has('pokmondp')); // propre à l'anilistId 2 seul
  assert.ok(!ambiguous.has('naruto')); // seul anilistId 3 le porte
});

test('does not flag a synonym only duplicated within the same anime', () => {
  const entries = [
    { anilistId: 1, animeTitle: 'Bleach', altTitles: ['Bleach', 'ブリーチ'] },
  ];
  const ambiguous = computeAmbiguousTitleKeys(entries);
  assert.equal(ambiguous.size, 0);
});

test('stripAmbiguousAltTitles removes only the ambiguous synonyms, keeps the rest', () => {
  const ambiguous = new Set(['pokemon']);
  const kept = stripAmbiguousAltTitles(['Pokemon', 'Pokémon DP', 'Satoshi'], ambiguous);
  assert.deepEqual(kept, ['Pokémon DP', 'Satoshi']);
});

test('never strips the primary animeTitle (it is not part of altTitles)', () => {
  // computeAmbiguousTitleKeys peut marquer un animeTitle comme ambigu (cas
  // pathologique de deux entrées identiques), mais stripAmbiguousAltTitles ne
  // touche jamais qu'à altTitles — animeTitle reste toujours la clé de secours.
  const entries = [
    { anilistId: 1, animeTitle: 'Gintama', altTitles: [] },
    { anilistId: 2, animeTitle: "Gintama'", altTitles: ['Gintama'] },
  ];
  const ambiguous = computeAmbiguousTitleKeys(entries);
  assert.ok(ambiguous.has('gintama'));
  const kept = stripAmbiguousAltTitles(entries[1].altTitles, ambiguous);
  assert.deepEqual(kept, []); // le synonyme ambigu est retiré…
  assert.equal(entries[1].animeTitle, "Gintama'"); // …mais le titre principal reste intact
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnimeName, isSeasonFragment } = require('../src/catalog/catalog.service');

test('normalizeAnimeName garde les crochets intégrés au nom', () => {
  // Bug historique : « [Oshi no Ko] » était réduit à « » → « Anime inconnu »,
  // et « [Oshi no Ko] 2nd Season » à « 2nd Season ».
  assert.equal(normalizeAnimeName('[Oshi no Ko]'), '[Oshi No Ko]');
  assert.equal(normalizeAnimeName('[Oshi no Ko] 2nd Season'), '[Oshi No Ko] 2nd Season');
});

test('normalizeAnimeName retire les annotations quand le reste reste valable', () => {
  assert.equal(
    normalizeAnimeName('Kanojo, Okarishimasu (Rent-a-Girlfriend) 2nd Season'),
    'Kanojo, Okarishimasu 2nd Season'
  );
  assert.equal(normalizeAnimeName('Kaguya-sama wa Kokurasetai? (Love is War)'), 'Kaguya-Sama Wa Kokurasetai?');
});

test('normalizeAnimeName ne produit jamais un fragment de saison nu', () => {
  // Si retirer la parenthèse ne laisse qu'un fragment, on garde le titre entier.
  assert.equal(normalizeAnimeName('(Test) 2nd Season'), '(Test) 2nd Season');
  assert.equal(normalizeAnimeName('[X] Season 2'), '[X] Season 2');
});

test('isSeasonFragment repère les titres cassés', () => {
  for (const bad of ['2nd Season', '3rd Season', 'Season 2', 'Part 1', 'Anime inconnu', '']) {
    assert.equal(isSeasonFragment(bad), true, `${bad} devrait être un fragment`);
  }
  for (const ok of ['[Oshi No Ko]', 'Naruto', 'Haikyuu!! 2nd Season', 'One Piece']) {
    assert.equal(isSeasonFragment(ok), false, `${ok} ne devrait pas être un fragment`);
  }
});

// Recherche/autocomplétion d'animes (public/anime-search-core.js, module
// partagé client + serveur) : normalisation, matching multi-mots, acronymes
// et ordre des suggestions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');
const core = require('../public/anime-search-core');
const { animeSearchNormalize, buildAnimeSearchFields, filterAnimeEntries, animeSearchHighlightRanges } = core;

fakePrisma(); // quiz.routes require('../db')

test('normalise : minuscules, accents, ponctuation et espaces retirés', () => {
  assert.equal(animeSearchNormalize('Re:Zero'), 'rezero');
  assert.equal(animeSearchNormalize('re zero'), 'rezero');
  assert.equal(animeSearchNormalize('Fate/Zero'), 'fatezero');
  assert.equal(animeSearchNormalize('K-On!'), 'kon');
  assert.equal(animeSearchNormalize('Ōkami'), 'okami');
  assert.equal(animeSearchNormalize('  Attack on Titan  '), 'attackontitan');
});

test('normalise : une saisie sans caractères spéciaux retrouve le titre stylisé', () => {
  const title = animeSearchNormalize('Re:Zero kara Hajimeru Isekai Seikatsu');
  assert.ok(title.includes(animeSearchNormalize('re zero')), 'préfixe « re zero » trouvé');
  assert.ok(title.includes(animeSearchNormalize('isekai')), 'mot du milieu « isekai » trouvé');
});

test('serveur : quiz.routes réutilise bien le module partagé (pas de copie)', () => {
  const quizRoutes = require('../src/quiz/quiz.routes');
  assert.equal(quizRoutes.animeSearchNormalize, animeSearchNormalize);
});

// Petit catalogue de test reproduisant les cas réels qui ont posé problème.
function entry(title, englishTitle, popularity, seasonNumber = 0, altTitles = []) {
  return {
    title, englishTitle, popularity, seasonNumber,
    ...buildAnimeSearchFields([title, englishTitle, ...altTitles]),
  };
}
const catalog = [
  entry('Kenja no Mago', "Wise Man's Grandchild", 9000),
  entry('Mahou Shoujo Site', 'Magical Girl Site', 5000),
  entry('Mahou Sensou', 'Magical Warfare', 4000),
  entry('Magi: The Labyrinth of Magic', null, 3000, 1),
  entry('Shingeki no Kyojin', 'Attack on Titan', 9500),
  entry('Kimetsu no Yaiba', 'Demon Slayer: Kimetsu no Yaiba', 9400),
  entry('Mahou Shoujo Madoka★Magica', 'Puella Magi Madoka Magica', 8000),
];
const titles = (q) => filterAnimeEntries(catalog, q).map(({ entry }) => entry.title);

test('mot entier avant milieu de mot : « magi » propose Magi en premier', () => {
  assert.equal(titles('magi')[0], 'Magi: The Labyrinth of Magic');
  assert.equal(titles('Magi:')[0], 'Magi: The Labyrinth of Magic');
});

test('multi-mots : chaque mot tapé matche un début de mot, ordre libre', () => {
  // « attack titan » : sans le « on », l'ancien indexOf collé échouait.
  assert.equal(titles('attack titan')[0], 'Shingeki no Kyojin');
  // Ordre inversé.
  assert.equal(titles('titan attack')[0], 'Shingeki no Kyojin');
  // Mots du milieu, ordre inversé, via synonyme.
  assert.equal(titles('magica madoka')[0], 'Mahou Shoujo Madoka★Magica');
});

test('acronymes : « aot » et « kny » trouvent le bon anime', () => {
  assert.equal(titles('aot')[0], 'Shingeki no Kyojin');
  assert.equal(titles('kny')[0], 'Kimetsu no Yaiba');
});

test('substring reste un filet de sécurité (saisie collée sans espaces)', () => {
  assert.ok(titles('okakyo').length === 0 || true); // pas de crash sur du bruit
  assert.equal(titles('shingekinokyojin')[0], 'Shingeki no Kyojin');
  assert.equal(titles('nokyojin')[0], 'Shingeki no Kyojin');
});

test('saisie vide ou sans caractères utiles : aucune suggestion', () => {
  assert.deepEqual(titles(''), []);
  assert.deepEqual(titles('  !! '), []);
});

test('le match remonte la variante qui a matché (pour le « ≈ … » de l\'UI)', () => {
  const [top] = filterAnimeEntries(catalog, 'demon slayer');
  assert.equal(top.entry.title, 'Kimetsu no Yaiba');
  assert.equal(top.matchedTitle, 'Demon Slayer: Kimetsu no Yaiba');
  assert.equal(top.matchedAcronym, null);
  const [aot] = filterAnimeEntries(catalog, 'aot');
  assert.equal(aot.entry.title, 'Shingeki no Kyojin');
  assert.equal(aot.matchedAcronym, 'aot');
});

test('surlignage : plages sur la chaîne brute, accents/ponctuation absorbés', () => {
  const slice = (raw, q) => animeSearchHighlightRanges(raw, q).map(({ start, end }) => raw.slice(start, end));
  // Début de mot simple.
  assert.deepEqual(slice('Magi: The Labyrinth of Magic', 'magi'), ['Magi']);
  // Multi-mots, ordre du titre non respecté : chaque mot tapé a sa plage.
  assert.deepEqual(slice('Attack on Titan', 'titan attack'), ['Attack', 'Titan']);
  // Ponctuation dans le titre, saisie sans ponctuation.
  assert.deepEqual(slice('Re:Zero kara Hajimeru', 're zero'), ['Re', 'Zero']);
  // Accent dans le titre, saisie sans accent.
  assert.deepEqual(slice('Mahou Shoujo Madoka★Magica', 'madoka magica'), ['Madoka', 'Magica']);
  // Match « collé » au milieu d'un mot (filet substring).
  assert.deepEqual(slice('Shingeki no Kyojin', 'nokyojin'), ['no Kyojin']);
  // Plages qui se chevauchent fusionnées.
  assert.deepEqual(slice('Magical Warfare', 'ma magic'), ['Magic']);
});

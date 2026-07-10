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

test('seasonNumber 0 (OAV/spécial hors chaîne) ne double pas la vraie saison 1', () => {
  // Ryusui (OAV, seasonNumber=0) plus populaire que Dr. Stone S1 : avant le
  // fix, 0 triait AVANT 1 (tri ascendant naïf) et prenait la tête malgré une
  // correspondance de même palier — Dr. Stone S1 ressortait 5e.
  const drStone = [
    entry('Dr. Stone', null, 200000, 1),
    entry('Dr. Stone: Stone Wars', null, 150000, 2),
    entry('Dr. Stone: New World', null, 140000, 3),
    entry('Dr. Stone: Ryusui', null, 999000, 0),
    entry('Dr. Stone: Reboot: Byakuya', null, 900000, 0),
  ];
  assert.deepEqual(
    filterAnimeEntries(drStone, 'dr stone').map(({ entry }) => entry.title),
    ['Dr. Stone', 'Dr. Stone: Stone Wars', 'Dr. Stone: New World', 'Dr. Stone: Ryusui', 'Dr. Stone: Reboot: Byakuya']
  );
});

test('à palier égal, la popularité prime entre franchises différentes', () => {
  // « one » matche « One Room » (S1 d'une chaîne) et « One Piece » (hors
  // chaîne) au même palier : avant le fix, le tie-break saison (1 < ∞) et la
  // position du match faisaient passer les petits titres devant l'évidence.
  const ones = [
    entry('One Room', null, 20000, 1),
    entry('One Outs', null, 60000, 0),
    entry('One Piece', null, 900000, 0),
  ];
  assert.equal(filterAnimeEntries(ones, 'one')[0].entry.title, 'One Piece');
  // « hero » : un titre obscur qui COMMENCE par « Hero » ne doit pas battre
  // My Hero Academia juste parce que son match est en position 0.
  const heroes = [
    entry('Hero Tales', null, 8000, 0),
    entry('Boku no Hero Academia', 'My Hero Academia', 500000, 1),
  ];
  assert.equal(filterAnimeEntries(heroes, 'hero')[0].entry.title, 'Boku no Hero Academia');
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

// Normalisation de l'autocomplétion de réponse : caractères spéciaux et accents
// doivent correspondre (« re zero » ↔ « Re:Zero »). La fonction serveur doit
// aussi rester identique à sa copie client (public/anime-autocomplete.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakePrisma } = require('./helpers/api');

fakePrisma(); // quiz.routes require('../db')
const { animeSearchNormalize } = require('../src/quiz/quiz.routes');

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

test('normalise : identique entre serveur et client (copie synchronisée)', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'public', 'anime-autocomplete.js'), 'utf8');
  const m = cli.match(/function animeSearchNormalize\(s\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'animeSearchNormalize présent côté client');
  let clientFn;
  eval(m[0].replace('function animeSearchNormalize', 'clientFn = function'));
  for (const s of ['Re:Zero', 'Fate/Zero', 'K-On!', 'Ōkami', 'JoJo\'s Bizarre Adventure', 'Mob Psycho 100']) {
    assert.equal(clientFn(s), animeSearchNormalize(s), 'divergence sur: ' + s);
  }
});

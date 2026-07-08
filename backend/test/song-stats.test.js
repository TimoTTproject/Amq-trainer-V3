// Stats globales de réussite par musique (difficulté réelle) : seuil
// d'échantillon minimal et recalcul du taux à chaque réponse.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

const prisma = fakePrisma();
const { recordGlobalGuess, MIN_GUESS_SAMPLE } = require('../src/quiz/song-stats');

test('recordGlobalGuess : taux null sous le seuil, calculé au-dessus', async () => {
  const writes = [];
  // 1er appel : increment (renvoie les nouveaux compteurs) ; 2e : pose guessRate.
  prisma.song.update = async ({ where, data, select }) => {
    writes.push({ where, data, select });
    if (select) return { guessCount: 4, guessCorrect: 3, guessRate: null };
    return {};
  };
  await recordGlobalGuess(42, true);
  // 4 réponses < seuil (10) : le taux doit rester null → pas de 2e écriture.
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data.guessCount, { increment: 1 });
  assert.deepEqual(writes[0].data.guessCorrect, { increment: 1 });

  writes.length = 0;
  prisma.song.update = async ({ where, data, select }) => {
    writes.push({ where, data, select });
    if (select) return { guessCount: 20, guessCorrect: 13, guessRate: null };
    return {};
  };
  await recordGlobalGuess(42, false);
  // 20 réponses ≥ seuil : le taux (65 %) doit être posé par une 2e écriture.
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data.guessCorrect, undefined, 'mauvaise réponse : pas d\'incrément correct');
  assert.equal(writes[1].data.guessRate, 65);
});

test('recordGlobalGuess : n\'écrit pas le taux s\'il est inchangé', async () => {
  const writes = [];
  prisma.song.update = async ({ data, select }) => {
    writes.push(data);
    if (select) return { guessCount: 30, guessCorrect: 15, guessRate: 50 };
    return {};
  };
  await recordGlobalGuess(42, true);
  assert.equal(writes.length, 1, 'taux déjà à 50 : pas de 2e écriture');
});

test('recordGlobalGuess : un échec ne remonte jamais (fire-and-forget)', async () => {
  prisma.song.update = async () => { throw new Error('boom'); };
  await assert.doesNotReject(recordGlobalGuess(42, true));
});

test('le seuil d\'échantillon est raisonnable', () => {
  assert.ok(MIN_GUESS_SAMPLE >= 5 && MIN_GUESS_SAMPLE <= 50);
});

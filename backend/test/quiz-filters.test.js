// Filtres de sélection du quiz (difficulté par popularité, période) —
// fragments de `where` Prisma partagés solo + multijoueur.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DIFFICULTIES, difficultyWhere, yearWhere, sanitizeYear } = require('../src/quiz/filters');

test('difficulté : paliers de popularité contigus (pas de zone morte)', () => {
  assert.deepEqual(difficultyWhere('popular'), { popularity: { gte: 100000 } });
  assert.deepEqual(difficultyWhere('medium'), { popularity: { gte: 30000, lt: 100000 } });
  assert.deepEqual(difficultyWhere('obscure'), { popularity: { lt: 30000 } });
  assert.deepEqual(difficultyWhere('all'), {});
  assert.deepEqual(difficultyWhere(undefined), {});
  assert.ok(DIFFICULTIES.includes('all'));
});

test('période : bornes ouvertes, années inconnues (0/null) exclues si filtre actif', () => {
  assert.deepEqual(yearWhere(0, 0), {});
  assert.deepEqual(yearWhere(2010, 2020), { seasonYear: { gte: 2010, lte: 2020 } });
  // Borne min seule : le gte à 1 exclut la sentinelle 0 (année inconnue).
  assert.deepEqual(yearWhere(2010, 0), { seasonYear: { gte: 2010, lte: 9999 } });
  assert.deepEqual(yearWhere(0, 1999), { seasonYear: { gte: 1, lte: 1999 } });
});

test('sanitizeYear : bornes plausibles uniquement', () => {
  assert.equal(sanitizeYear('2015'), 2015);
  assert.equal(sanitizeYear(1949), 0);
  assert.equal(sanitizeYear(2101), 0);
  assert.equal(sanitizeYear('abc'), 0);
  assert.equal(sanitizeYear(undefined), 0);
});

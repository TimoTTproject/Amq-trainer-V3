// Filtres de sélection du quiz (difficulté par popularité, période) —
// fragments de `where` Prisma partagés solo + multijoueur.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DIFFICULTIES, difficultyWhere, yearWhere, sanitizeYear, sanitizeExcludeAnilist } = require('../src/quiz/filters');

test('difficulté : taux de réussite réel d\'abord, popularité en repli, paliers contigus', () => {
  assert.deepEqual(difficultyWhere('popular'), {
    OR: [{ guessRate: { gte: 60 } }, { guessRate: null, popularity: { gte: 100000 } }],
  });
  assert.deepEqual(difficultyWhere('medium'), {
    OR: [{ guessRate: { gte: 25, lt: 60 } }, { guessRate: null, popularity: { gte: 30000, lt: 100000 } }],
  });
  assert.deepEqual(difficultyWhere('obscure'), {
    OR: [{ guessRate: { lt: 25 } }, { guessRate: null, popularity: { lt: 30000 } }],
  });
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
  // Bornes inversées : réordonnées (jamais d'intervalle vide silencieux).
  assert.deepEqual(yearWhere(2020, 2010), { seasonYear: { gte: 2010, lte: 2020 } });
});

test('sanitizeYear : bornes plausibles uniquement', () => {
  assert.equal(sanitizeYear('2015'), 2015);
  assert.equal(sanitizeYear(1949), 0);
  assert.equal(sanitizeYear(2101), 0);
  assert.equal(sanitizeYear('abc'), 0);
  assert.equal(sanitizeYear(undefined), 0);
});

test('sanitizeExcludeAnilist (anti-doublon) : entiers positifs, dédupliqués, plafonnés', () => {
  assert.deepEqual(sanitizeExcludeAnilist(''), []);
  assert.deepEqual(sanitizeExcludeAnilist(undefined), []);
  assert.deepEqual(sanitizeExcludeAnilist('101,102,101, 103'), [101, 102, 103]);
  assert.deepEqual(sanitizeExcludeAnilist('101,abc,-5,0,12.9'), [101, 12]);
  const huge = Array.from({ length: 3000 }, (_, i) => i + 1).join(',');
  assert.equal(sanitizeExcludeAnilist(huge).length, 2000);
});

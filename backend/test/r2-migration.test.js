// Boucle de migration R2 : elle ne doit s'arrêter QUE quand tout est migré ou
// qu'il ne reste que des échecs définitifs. Worker et délais injectés (aucun
// réseau, aucune BDD, aucune attente réelle).
const test = require('node:test');
const assert = require('node:assert/strict');
const { runContinuousMigration, _migrationInternals } = require('../src/storage/r2');
const { migrationState, failedAttempts, MAX_ATTEMPTS } = _migrationInternals;

const FAST = { stepMs: 0, waveMs: 0 };

function resetState() {
  migrationState.running = true;
  migrationState.uploaded = 0;
  migrationState.failed = 0;
  migrationState.retryWaves = 0;
  migrationState.lastError = null;
  failedAttempts.clear();
}

test('termine proprement quand tout est migré', async () => {
  resetState();
  const script = [
    { processed: 1, uploaded: 1, remaining: 2 },
    { processed: 1, uploaded: 1, remaining: 1 },
    { processed: 1, uploaded: 1, remaining: 0 },
  ];
  await runContinuousMigration(async () => script.shift(), FAST);
  assert.equal(migrationState.uploaded, 3);
  assert.equal(migrationState.running, false);
  assert.equal(migrationState.lastError, null);
});

test('un échec passager est retenté par vague au lieu d\'arrêter la boucle', async () => {
  resetState();
  failedAttempts.set(42, 1); // le titre 42 vient d'échouer une fois
  const calls = [];
  const script = [
    // Plus de candidat hors exclusions mais il reste à migrer → AVANT ce fix,
    // la boucle faisait `break` ici et la migration « s'arrêtait toute seule ».
    { processed: 0, uploaded: 0, remaining: 1 },
    // Après la vague, le titre 42 est réintégré et passe.
    { processed: 1, uploaded: 1, remaining: 0 },
  ];
  await runContinuousMigration(async () => { const r = script.shift(); calls.push(r); return r; }, FAST);
  assert.equal(calls.length, 2);
  assert.equal(migrationState.retryWaves, 1);
  assert.equal(failedAttempts.has(42), false); // réintégré par la vague
  assert.equal(migrationState.uploaded, 1);
});

test('s\'arrête avec un message clair quand il ne reste que des échecs définitifs', async () => {
  resetState();
  failedAttempts.set(1, MAX_ATTEMPTS);
  failedAttempts.set(2, MAX_ATTEMPTS);
  await runContinuousMigration(async () => ({ processed: 0, uploaded: 0, remaining: 2 }), FAST);
  assert.equal(migrationState.running, false);
  assert.match(migrationState.lastError, /2 musique\(s\) en échec/);
  assert.equal(failedAttempts.size, 2); // gardés de côté (retentés au prochain start)
});

test('une erreur de boucle (BDD…) fait patienter puis réessayer, sans tuer la migration', async () => {
  resetState();
  let calls = 0;
  await runContinuousMigration(async () => {
    calls++;
    if (calls <= 2) throw new Error('database timeout');
    return { processed: 1, uploaded: 1, remaining: 0 };
  }, FAST);
  assert.equal(calls, 3);
  assert.equal(migrationState.uploaded, 1);
});

test('abandonne après trop d\'erreurs de boucle consécutives (pas de boucle chaude infinie)', async () => {
  resetState();
  let calls = 0;
  await runContinuousMigration(async () => { calls++; throw new Error('down'); }, FAST);
  assert.equal(calls, 10); // MAX_CONSECUTIVE_ERRORS
  assert.equal(migrationState.running, false);
  assert.equal(migrationState.lastError, 'down');
});

test('stop demandé pendant la migration → la boucle s\'arrête au prochain tour', async () => {
  resetState();
  let calls = 0;
  await runContinuousMigration(async () => {
    calls++;
    if (calls === 2) migrationState.running = false; // stopContinuousMigration()
    return { processed: 1, uploaded: 1, remaining: 99 };
  }, FAST);
  assert.equal(calls, 2);
  assert.equal(migrationState.running, false);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/util/store');

test('verrou distribué : une seule mutation possède la clé jusqu’à sa libération', async () => {
  const key = `test:lock:${Date.now()}:${Math.random()}`;
  const first = await store.acquireLock(key, 5000);
  assert.ok(first);
  assert.equal(await store.acquireLock(key, 5000), null);

  // Un mauvais token ne peut jamais libérer le verrou d'un autre appel.
  await store.releaseLock(key, 'token-invalide');
  assert.equal(await store.acquireLock(key, 5000), null);

  await store.releaseLock(key, first);
  const second = await store.acquireLock(key, 5000);
  assert.ok(second);
  await store.releaseLock(key, second);
});

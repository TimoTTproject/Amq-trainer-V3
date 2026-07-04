const test = require('node:test');
const assert = require('node:assert/strict');
const { BASELINE, migrationState } = require('../scripts/deploy-migrations');

function fakePrisma(responses) {
  let index = 0;
  return {
    $queryRaw: async () => responses[index++],
  };
}

test('migration baseline name matches the versioned directory', () => {
  assert.equal(BASELINE, '20260704130000_baseline');
});

test('migrationState detects a fresh database', async () => {
  const state = await migrationState(fakePrisma([[]]));
  assert.deepEqual(state, {
    hasAppSchema: false,
    hasMigrationTable: false,
    appliedMigrations: 0,
  });
});

test('migrationState detects the historical schema before baselining', async () => {
  const state = await migrationState(fakePrisma([[{ table_name: 'User' }]]));
  assert.equal(state.hasAppSchema, true);
  assert.equal(state.appliedMigrations, 0);
});

test('migrationState preserves an already migrated database', async () => {
  const prisma = fakePrisma([
    [{ table_name: 'User' }, { table_name: '_prisma_migrations' }],
    [{ count: 3 }],
  ]);
  const state = await migrationState(prisma);
  assert.equal(state.hasAppSchema, true);
  assert.equal(state.hasMigrationTable, true);
  assert.equal(state.appliedMigrations, 3);
});

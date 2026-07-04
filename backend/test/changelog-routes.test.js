// Tests de route : /api/changelog (journal des nouveautés) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const changelogRoutes = require('../src/changelog/changelog.routes');
const { ENTRIES } = require('../src/changelog/changelog.data');

const USER = { id: 'u1', email: 'a@b.fr', displayName: 'Timo' };

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/changelog', changelogRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => (where.id === USER.id ? USER : null);
});

test('401 sans session', async () => {
  const res = await app.request('/api/changelog');
  assert.equal(res.status, 401);
});

test('renvoie les entrées triées du plus récent au plus ancien', async () => {
  const res = await app.request('/api/changelog', { cookie: app.authCookie(USER.id) });
  assert.equal(res.status, 200);
  const ids = res.json.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
});

test('respecte la limite demandée (bornée à 50)', async () => {
  const res = await app.request('/api/changelog?limit=2', { cookie: app.authCookie(USER.id) });
  assert.equal(res.json.entries.length, 2);
  const huge = await app.request('/api/changelog?limit=9999', { cookie: app.authCookie(USER.id) });
  assert.ok(huge.json.entries.length <= 50);
});

test('chaque entrée a un id, un tag valide, un titre et une description', () => {
  for (const e of ENTRIES) {
    assert.equal(typeof e.id, 'number');
    assert.ok(['feature', 'improvement', 'fix'].includes(e.tag), `tag invalide: ${e.tag}`);
    assert.ok(e.title && e.title.length > 0);
    assert.ok(e.description && e.description.length > 0);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('les ids sont uniques', () => {
  const ids = ENTRIES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

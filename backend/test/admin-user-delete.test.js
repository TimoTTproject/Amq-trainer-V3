// Tests de route : DELETE /api/admin/user/:id — suppression de compte (admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin' };
const PLAIN = { id: 'u1', email: 'joueur@b.fr', displayName: 'Joueur' };

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/admin', adminRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === ADMIN.id) return ADMIN;
    if (where.id === PLAIN.id) return PLAIN;
    return null;
  };
});

test('refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/user/whatever', { method: 'DELETE', cookie: app.authCookie(PLAIN.id) });
  assert.equal(res.status, 403);
});

test('refuse de supprimer son propre compte', async () => {
  const res = await app.request(`/api/admin/user/${ADMIN.id}`, { method: 'DELETE', cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 400);
});

test('404 si le compte cible n\'existe pas', async () => {
  prisma.user.findUnique = async ({ where }) => (where.id === ADMIN.id ? ADMIN : null);
  const res = await app.request('/api/admin/user/inexistant', { method: 'DELETE', cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 404);
});

test('supprime le compte : rend le stock des cartes possédées puis cascade', async () => {
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === ADMIN.id) return ADMIN;
    if (where.id === 'target1') return { id: 'target1', displayName: 'DiagBot', email: 'diag@x.fr' };
    return null;
  };
  prisma.cardInstance.groupBy = async () => [
    { characterId: 10, _count: { _all: 2 } },
    { characterId: 20, _count: { _all: 1 } },
  ];
  const characterUpdates = [];
  prisma.character.update = async ({ where, data }) => { characterUpdates.push({ where, data }); return {}; };
  let deletedId = null;
  prisma.user.delete = async ({ where }) => { deletedId = where.id; return {}; };

  const res = await app.request('/api/admin/user/target1', { method: 'DELETE', cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.deleted, { id: 'target1', displayName: 'DiagBot', email: 'diag@x.fr' });
  assert.equal(characterUpdates.length, 2);
  assert.equal(characterUpdates[0].data.minted.decrement, 2);
  assert.equal(characterUpdates[0].data.soldOut, false);
  assert.equal(deletedId, 'target1');
});

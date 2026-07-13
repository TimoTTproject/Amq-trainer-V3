const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const { router: profileRoutes } = require('../src/profile/profile.routes');

let app;
let user;

test.before(async () => {
  app = await createApp((a) => a.use('/api/profile', profileRoutes));
});

test.after(() => app?.close());

test.beforeEach(() => {
  user = {
    id: 'u1',
    email: 'test@example.com',
    displayName: 'Ancien pseudo',
    avatarUrl: null,
    bio: null,
    tokens: 0,
    isAdmin: false,
    isGuest: false,
    bannedAt: null,
  };
  prisma.user.findUnique = async ({ where }) => (where.id === user.id ? user : null);
  prisma.user.findFirst = async () => null;
  prisma.user.update = async ({ data }) => ({ ...user, ...data });
});

function rename(displayName) {
  return app.request('/api/profile', {
    method: 'PATCH',
    cookie: app.authCookie(user.id),
    body: { displayName },
  });
}

test('profil : le joueur peut changer son pseudo', async () => {
  const result = await rename('Nouveau pseudo');
  assert.equal(result.status, 200);
  assert.equal(result.json.user.displayName, 'Nouveau pseudo');
});

test('profil : refuse un pseudo déjà utilisé sans tenir compte des majuscules', async () => {
  prisma.user.findFirst = async ({ where }) => {
    assert.equal(where.id.not, user.id);
    assert.deepEqual(where.displayName, { equals: 'Dova', mode: 'insensitive' });
    return { id: 'u2' };
  };
  const result = await rename('Dova');
  assert.equal(result.status, 409);
  assert.match(result.json.error, /déjà utilisé/);
});

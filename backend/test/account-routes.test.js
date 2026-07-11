// Compte : changement de mot de passe / d'email et auto-suppression (RGPD).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const authRoutes = require('../src/auth/auth.routes');

let app;
let user;
let updates;
test.before(async () => {
  app = await createApp((a) => a.use('/api/auth', authRoutes.router));
});
test.after(() => app.close());
test.beforeEach(async () => {
  user = { id: 'u1', email: 'a@b.fr', displayName: 'Timo', passwordHash: await bcrypt.hash('ancien-mdp', 4), bannedAt: null };
  updates = [];
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
  prisma.user.update = async ({ data }) => { updates.push(data); return { ...user, ...data }; };
});

function post(path, body) {
  return app.request(path, { method: 'POST', cookie: app.authCookie('u1'), body });
}

test('change-password : refuse sans le bon mot de passe actuel, accepte avec', async () => {
  const bad = await post('/api/auth/change-password', { currentPassword: 'faux', newPassword: 'nouveau-mdp-8' });
  assert.equal(bad.status, 401);
  const short = await post('/api/auth/change-password', { currentPassword: 'ancien-mdp', newPassword: 'court' });
  assert.equal(short.status, 400);
  const ok = await post('/api/auth/change-password', { currentPassword: 'ancien-mdp', newPassword: 'nouveau-mdp-8' });
  assert.equal(ok.status, 200);
  assert.ok(await bcrypt.compare('nouveau-mdp-8', updates[0].passwordHash));
});

test('change-password : compte OAuth sans mot de passe → peut en définir un directement', async () => {
  user.passwordHash = null;
  const ok = await post('/api/auth/change-password', { newPassword: 'premier-mdp-8' });
  assert.equal(ok.status, 200);
});

test('change-email : mot de passe exigé, email validé, P2002 → message clair', async () => {
  const bad = await post('/api/auth/change-email', { email: 'nouveau@b.fr', password: 'faux' });
  assert.equal(bad.status, 401);
  const invalid = await post('/api/auth/change-email', { email: 'pas-un-email', password: 'ancien-mdp' });
  assert.equal(invalid.status, 400);
  const ok = await post('/api/auth/change-email', { email: 'Nouveau@B.fr', password: 'ancien-mdp' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.email, 'nouveau@b.fr'); // normalisé en minuscules
  prisma.user.update = async () => { const e = new Error('dup'); e.code = 'P2002'; throw e; };
  const dup = await post('/api/auth/change-email', { email: 'pris@b.fr', password: 'ancien-mdp' });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /déjà utilisée/);
});

test('suppression : mot de passe exigé, cascade + stock de cartes rendus', async () => {
  const returned = [];
  prisma.cardInstance.groupBy = async () => [{ characterId: 7, _count: { _all: 3 } }];
  prisma.character.update = async ({ where, data }) => { returned.push({ where, data }); return {}; };
  prisma.user.delete = async ({ where }) => { returned.push({ deleted: where.id }); return {}; };

  const bad = await app.request('/api/auth/account', { method: 'DELETE', cookie: app.authCookie('u1'), body: { password: 'faux' } });
  assert.equal(bad.status, 401);
  const ok = await app.request('/api/auth/account', { method: 'DELETE', cookie: app.authCookie('u1'), body: { password: 'ancien-mdp' } });
  assert.equal(ok.status, 200);
  assert.equal(returned[0].data.minted.decrement, 3); // exemplaires rendus au stock
  assert.deepEqual(returned[1], { deleted: 'u1' });
});

// Tests de routes : /api/auth (register, login, me, guest) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const authRoutes = require('../src/auth/auth.routes');

// Utilisateur type tel que renvoyé par Prisma (les champs consommés par publicUser).
function dbUser(over = {}) {
  return {
    id: 'u1', email: 'a@b.fr', displayName: 'Timo', passwordHash: null,
    avatarUrl: null, bio: null, anilistName: null, anilistListName: null,
    tokens: 120, dust: 3, pity: 0, towerBestFloor: 0, mmr: 1000, rankedGames: 0,
    lastDailyAt: null, createdAt: new Date('2026-06-01'),
    cardBack: null, cardBorder: null, profileBanner: null, avatarFrame: null,
    ...over,
  };
}

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/auth', authRoutes.router));
});
test.after(() => app.close());

test('register : refuse un mot de passe trop court', async () => {
  const res = await app.request('/api/auth/register', {
    method: 'POST', body: { email: 'a@b.fr', password: '123' },
  });
  assert.equal(res.status, 400);
});

test('register : valide aussi le format de l’email', async () => {
  const res = await app.request('/api/auth/register', {
    method: 'POST', body: { email: 'pas-un-email', password: 'secret68' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /e-mail invalide/i);
});

test('register : refuse un email déjà utilisé', async () => {
  prisma.user.findUnique = async () => dbUser();
  const res = await app.request('/api/auth/register', {
    method: 'POST', body: { email: 'a@b.fr', password: 'secret68' },
  });
  assert.equal(res.status, 409);
});

test('register : crée le compte, pose le cookie, ne renvoie aucun secret', async () => {
  prisma.user.findUnique = async () => null;
  let created = null;
  prisma.user.create = async ({ data }) => { created = data; return dbUser({ ...data, id: 'u-new' }); };

  const res = await app.request('/api/auth/register', {
    method: 'POST', body: { email: '  New@B.FR ', password: 'secret68' },
  });
  assert.equal(res.status, 201);
  assert.equal(created.email, 'new@b.fr'); // normalisé (trim + minuscules)
  assert.ok(created.passwordHash && created.passwordHash !== 'secret68'); // jamais en clair
  assert.equal(created.displayName, 'new'); // déduit de l'email normalisé si absent
  assert.match(res.headers.get('set-cookie') || '', /amq_token=/);
  assert.equal(res.json.user.passwordHash, undefined); // publicUser filtre les secrets
});

test('login : identifiants invalides → 401 (compte inconnu ou mauvais mot de passe)', async () => {
  prisma.user.findUnique = async () => null;
  const unknown = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'x@y.fr', password: 'whatever' },
  });
  assert.equal(unknown.status, 401);

  prisma.user.findUnique = async () => dbUser({ passwordHash: await bcrypt.hash('bonmdp', 4) });
  const wrong = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'a@b.fr', password: 'mauvais' },
  });
  assert.equal(wrong.status, 401);
});

test('login : succès → cookie + profil public', async () => {
  const hash = await bcrypt.hash('bonmdp', 4);
  prisma.user.findUnique = async ({ where }) => (where.email === 'a@b.fr' ? dbUser({ passwordHash: hash }) : null);
  const res = await app.request('/api/auth/login', {
    method: 'POST', body: { email: 'A@B.fr', password: 'bonmdp' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') || '', /amq_token=/);
  assert.equal(res.json.user.id, 'u1');
  assert.equal(res.json.user.tokens, 120);
  assert.equal(res.json.user.passwordHash, undefined);
});

test('me : 401 sans cookie, profil avec cookie, invité reconnu', async () => {
  const anon = await app.request('/api/auth/me');
  assert.equal(anon.status, 401);

  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? dbUser() : null);
  const authed = await app.request('/api/auth/me', { cookie: app.authCookie('u1') });
  assert.equal(authed.status, 200);
  assert.equal(authed.json.user.id, 'u1');

  // Session invité : /guest pose un cookie spécial, /me le reconnaît sans BDD.
  const guest = await app.request('/api/auth/guest', { method: 'POST' });
  assert.equal(guest.status, 201);
  const guestCookie = (guest.headers.get('set-cookie') || '').split(';')[0];
  const guestMe = await app.request('/api/auth/me', { cookie: guestCookie });
  assert.equal(guestMe.status, 200);
  assert.equal(guestMe.json.user.isGuest, true);
  assert.equal(guestMe.json.user.tokens, 0);
});

test('logout : passe l’Idle en mode farm avant de fermer la session', async () => {
  prisma.user.findUnique = async () => dbUser({ idleBattleMode: 'progress' });
  let update = null;
  prisma.user.update = async (query) => { update = query; return dbUser({ idleBattleMode: 'farm' }); };

  const res = await app.request('/api/auth/logout', {
    method: 'POST', cookie: app.authCookie('u1'),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(update, { where: { id: 'u1' }, data: { idleBattleMode: 'farm' } });
  assert.equal(res.json.idleBattleMode, 'farm');
  assert.match(res.headers.get('set-cookie') || '', /amq_token=;/);
});

test('login : bloque les tentatives répétées', async () => {
  prisma.user.findUnique = async () => null;
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await app.request('/api/auth/login', {
      method: 'POST', body: { email: 'bruteforce@example.com', password: 'incorrect' },
    });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429));
  assert.equal(statuses.at(-1), 429);
});

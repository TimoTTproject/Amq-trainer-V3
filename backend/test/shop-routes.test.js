// Tests de routes : /api/shop (achat + équipement de cosmétiques) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const shopRoutes = require('../src/shop/shop.routes');
const { COSMETICS } = require('../src/shop/cosmetics');

// Un cosmétique payant non-exclusif du catalogue réel (le test suit le catalogue).
const PAID = COSMETICS.find((c) => c.price > 0 && !c.exclusive && !c.unlockOnly);
const FREE = COSMETICS.find((c) => c.price === 0);
assert.ok(PAID && FREE, 'le catalogue doit contenir un item payant et un item gratuit');

function dbUser(over = {}) {
  return {
    id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 1000, dust: 0,
    mmr: 1000, rankedGames: 0, soloMmr: 1000, soloGames: 0, lastDailyAt: null,
    cardBack: null, cardBorder: null, profileBanner: null, avatarFrame: null,
    ...over,
  };
}

let app;
let user; // renvoyé par attachUser à chaque requête
test.before(async () => {
  app = await createApp((a) => a.use('/api/shop', shopRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test('buy : cosmétique inconnu → 404, item gratuit → 400', async () => {
  const unknown = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: 'nexiste-pas' },
  });
  assert.equal(unknown.status, 404);

  const free = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: FREE.id },
  });
  assert.equal(free.status, 400);
});

test('buy : refuse si déjà possédé ou tokens insuffisants', async () => {
  prisma.userCosmetic.findUnique = async () => ({ id: 9, userId: 'u1', cosmeticId: PAID.id });
  const dup = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: PAID.id },
  });
  assert.equal(dup.status, 400);

  user = dbUser({ tokens: PAID.price - 1 });
  prisma.userCosmetic.findUnique = async () => null;
  const poor = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: PAID.id },
  });
  assert.equal(poor.status, 400);
});

test('buy : succès → débit atomique + possession + trace de transaction', async () => {
  prisma.userCosmetic.findUnique = async () => null;
  const writes = [];
  prisma.user.update = async ({ data }) => {
    writes.push(['user.update', data]);
    return dbUser({ tokens: user.tokens - PAID.price });
  };
  prisma.userCosmetic.create = async ({ data }) => { writes.push(['userCosmetic.create', data]); return data; };
  prisma.tokenTransaction.create = async ({ data }) => { writes.push(['tokenTransaction.create', data]); return data; };

  const res = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: PAID.id },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.tokens, 1000 - PAID.price);
  assert.deepEqual(writes.map(([w]) => w), ['user.update', 'userCosmetic.create', 'tokenTransaction.create']);
  assert.equal(writes[0][1].tokens.decrement, PAID.price);
  assert.equal(writes[2][1].amount, -PAID.price);
  assert.equal(writes[2][1].reason, 'cosmetic_purchase');
});

test('buy : exclusif de palier → 403 (jamais achetable)', async () => {
  const exclusive = COSMETICS.find((c) => c.exclusive);
  if (!exclusive) return; // pas d'exclusif au catalogue → rien à vérifier
  const res = await app.request('/api/shop/buy', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: exclusive.id },
  });
  assert.equal(res.status, 403);
});

test('equip : possession exigée, équipe puis retour au défaut (null)', async () => {
  prisma.userCosmetic.findUnique = async () => null;
  const notOwned = await app.request('/api/shop/equip', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: PAID.id },
  });
  assert.equal(notOwned.status, 400);

  prisma.userCosmetic.findUnique = async () => ({ id: 9, userId: 'u1', cosmeticId: PAID.id });
  let updated = null;
  prisma.user.update = async ({ data }) => { updated = data; return user; };
  const ok = await app.request('/api/shop/equip', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: PAID.id },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(updated, { [PAID.slot]: PAID.id });

  // L'item gratuit du slot = retour au défaut → on stocke null.
  const reset = await app.request('/api/shop/equip', {
    method: 'POST', cookie: app.authCookie('u1'), body: { cosmeticId: FREE.id },
  });
  assert.equal(reset.status, 200);
  assert.equal(updated[FREE.slot], null);
});

test('shop : 401 sans session, y compris pour un invité', async () => {
  const anon = await app.request('/api/shop/buy', { method: 'POST', body: { cosmeticId: PAID.id } });
  assert.equal(anon.status, 401);
});

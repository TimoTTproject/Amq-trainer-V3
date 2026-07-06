// Tests de routes : /api/promotion (vote « Édition 2 ») — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const promotionRoutes = require('../src/promotion/promotion.routes');
const { MAX_VOTES } = promotionRoutes;

function dbUser(over = {}) {
  return { id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 0, ...over };
}
function dbCharacter(over = {}) {
  return { id: 1, anilistId: 100, name: 'Naruto', imageUrl: null, rarity: 'common', series: 'Naruto', edition: 1, ...over };
}

let app;
let user;
test.before(async () => {
  app = await createApp((a) => a.use('/api/promotion', promotionRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test('vote : personnage inconnu → 404', async () => {
  prisma.character.findUnique = async () => null;
  const res = await app.request('/api/promotion/vote', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 999 },
  });
  assert.equal(res.status, 404);
});

test('vote : déjà voté pour ce personnage → idempotent (pas de doublon)', async () => {
  prisma.character.findUnique = async () => dbCharacter();
  prisma.promotionVote.findUnique = async () => ({ id: 1, userId: 'u1', characterId: 1 });
  const res = await app.request('/api/promotion/vote', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.alreadyVoted, true);
});

test(`vote : refuse au-delà de ${MAX_VOTES} voix distinctes`, async () => {
  prisma.character.findUnique = async () => dbCharacter();
  prisma.promotionVote.findUnique = async () => null;
  prisma.promotionVote.count = async () => MAX_VOTES;
  const res = await app.request('/api/promotion/vote', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 1 },
  });
  assert.equal(res.status, 400);
});

test('vote : succès → crée le vote', async () => {
  prisma.character.findUnique = async () => dbCharacter();
  prisma.promotionVote.findUnique = async () => null;
  prisma.promotionVote.count = async () => 3;
  let created = null;
  prisma.promotionVote.create = async ({ data }) => { created = data; return data; };
  const res = await app.request('/api/promotion/vote', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 1 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(created, { userId: 'u1', characterId: 1 });
  assert.equal(res.json.remaining, MAX_VOTES - 4);
});

test('status : renvoie mes votes + voix restantes', async () => {
  prisma.promotionVote.findMany = async () => [
    { character: dbCharacter({ id: 1 }), createdAt: new Date() },
    { character: dbCharacter({ id: 2, name: 'Sasuke' }), createdAt: new Date() },
  ];
  const res = await app.request('/api/promotion/status', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.used, 2);
  assert.equal(res.json.remaining, MAX_VOTES - 2);
  assert.equal(res.json.votes.length, 2);
});

test('leaderboard : classe par nombre de votes, sans authentification requise', async () => {
  prisma.promotionVote.groupBy = async ({ by }) => {
    if (by[0] === 'userId') return [{ userId: 'u1' }, { userId: 'u2' }];
    return [{ characterId: 1, _count: { characterId: 5 } }, { characterId: 2, _count: { characterId: 2 } }];
  };
  prisma.character.findMany = async () => [dbCharacter({ id: 1 }), dbCharacter({ id: 2, name: 'Sasuke' })];
  const res = await app.request('/api/promotion/leaderboard');
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 2);
  assert.equal(res.json.entries[0].votes, 5);
  assert.equal(res.json.entries[0].name, 'Naruto');
});

test('vote/status : 401 sans session', async () => {
  const res = await app.request('/api/promotion/vote', { method: 'POST', body: { characterId: 1 } });
  assert.equal(res.status, 401);
});

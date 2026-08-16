// Fusion (remplace poussière/craft, 2026-07-06) : 3 exemplaires possédés
// (même personnage ou mélangés, même rareté) → 1 carte ALÉATOIRE de cette
// rareté (peut retomber sur un doublon, pas de garantie de nouveauté).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const gachaRoutes = require('../src/gacha/gacha.routes');
const { FUSE_COUNT } = require('../src/gacha/rarity');

function dbUser(over = {}) {
  return { id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 0, ...over };
}
function dbCharacter(id, over = {}) {
  return {
    id, name: `Char${id}`, rarity: 'rare', soldOut: false,
    minted: 10, maxSupply: 100, nextSerial: 10, imageUrl: null, featured: false, ...over,
  };
}

let app;
let user;
test.before(async () => {
  app = await createApp((a) => a.use('/api/gacha', gachaRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  prisma.appSetting.findUnique = async () => null; // avant lancement : pool Edition 1
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test(`fuse : refuse si le total ne fait pas exactement ${FUSE_COUNT}`, async () => {
  const res = await app.request('/api/gacha/fuse', {
    method: 'POST', cookie: app.authCookie('u1'), body: { items: [{ characterId: 1, count: 2 }] },
  });
  assert.equal(res.status, 400);
});

test('fuse : refuse si les personnages ne sont pas de la même rareté', async () => {
  prisma.character.findMany = async () => [dbCharacter(1, { rarity: 'rare' }), dbCharacter(2, { rarity: 'epic' })];
  const res = await app.request('/api/gacha/fuse', {
    method: 'POST', cookie: app.authCookie('u1'),
    body: { items: [{ characterId: 1, count: 2 }, { characterId: 2, count: 1 }] },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /rareté/);
});

test("fuse : refuse si le joueur n'a pas assez d'exemplaires", async () => {
  prisma.character.findMany = async () => [dbCharacter(1)];
  prisma.cardInstance.count = async () => 2; // < 3 requis (exemplaires réellement disponibles, hors marché)
  const res = await app.request('/api/gacha/fuse', {
    method: 'POST', cookie: app.authCookie('u1'), body: { items: [{ characterId: 1, count: 3 }] },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /exemplaires/);
});

test('fuse : refuse si plus aucun personnage disponible dans la rareté (jamais de repli vers une autre)', async () => {
  prisma.character.findMany = async () => [dbCharacter(1)];
  prisma.character.findUnique = async () => null; // pas de boost vedette
  prisma.character.findFirst = async () => null; // ni vedette, ni pick final
  prisma.cardInstance.count = async () => 3; // exemplaires réellement disponibles : suffisant
  prisma.character.count = async () => 0; // rareté épuisée
  const res = await app.request('/api/gacha/fuse', {
    method: 'POST', cookie: app.authCookie('u1'), body: { items: [{ characterId: 1, count: 3 }] },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /disponible/);
});

test('fuse : succès → consomme les 3 exemplaires et mint 1 nouvelle carte aléatoire', async () => {
  prisma.character.findMany = async () => [dbCharacter(1)];
  prisma.cardInstance.count = async () => 3;
  prisma.character.findUnique = async ({ where }) => (where.id === 42 ? dbCharacter(42, { minted: 5, nextSerial: 5 }) : null);
  prisma.character.findFirst = async ({ where }) => (where.featured ? null : dbCharacter(42));
  prisma.character.count = async () => 3;
  const destroyedIds = [];
  prisma.cardInstance.findMany = async ({ take }) => Array.from({ length: take }, (_, i) => ({ id: 100 + i }));
  prisma.cardInstance.deleteMany = async ({ where }) => { destroyedIds.push(...where.id.in); return {}; };
  prisma.character.update = async () => ({});
  prisma.userCard.findUnique = async ({ where }) =>
    (where.userId_characterId.characterId === 1 ? { characterId: 1, copies: 3 } : null);
  prisma.userCard.deleteMany = async () => ({});
  prisma.userCard.create = async ({ data }) => data;
  prisma.cardInstance.create = async () => ({});

  const res = await app.request('/api/gacha/fuse', {
    method: 'POST', cookie: app.authCookie('u1'), body: { items: [{ characterId: 1, count: 3 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.card.id, 42);
  assert.equal(destroyedIds.length, 3);
});

test('fuse : 401 sans session', async () => {
  const res = await app.request('/api/gacha/fuse', { method: 'POST', body: { items: [{ characterId: 1, count: 3 }] } });
  assert.equal(res.status, 401);
});

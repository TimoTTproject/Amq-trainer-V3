// Règle : un personnage ne peut être fabriqué (craft, en poussière) que s'il a
// déjà été obtenu par tirage (gacha) au moins une fois, par n'importe quel
// joueur — pas de personnage qui n'existe QUE via craft.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const gachaRoutes = require('../src/gacha/gacha.routes');

function dbUser(over = {}) {
  return { id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 0, dust: 5000, ...over };
}
function dbCharacter(over = {}) {
  return {
    id: 1, name: 'Test Char', rarity: 'rare', soldOut: false,
    minted: 10, maxSupply: 100, nextSerial: 10, ...over,
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
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test('craft : refusé si le personnage n\'a jamais été tiré (pull)', async () => {
  prisma.character.findUnique = async () => dbCharacter();
  prisma.cardInstance.findFirst = async ({ where }) => {
    assert.equal(where.source, 'pull');
    return null; // jamais tiré
  };
  const res = await app.request('/api/gacha/craft', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /tirage/);
});

test('craft : autorisé si déjà tiré au moins une fois et poussière suffisante', async () => {
  prisma.character.findUnique = async () => dbCharacter();
  prisma.cardInstance.findFirst = async () => ({ id: 999 }); // déjà tiré par quelqu'un
  prisma.cardInstance.create = async () => ({});
  prisma.character.update = async () => ({});
  prisma.userCard.findUnique = async () => null;
  prisma.userCard.create = async () => ({});
  prisma.user.update = async ({ data }) => ({ dust: user.dust - data.dust.decrement });

  const res = await app.request('/api/gacha/craft', {
    method: 'POST', cookie: app.authCookie('u1'), body: { characterId: 1 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.isNew, true);
  assert.equal(res.json.cost, 60); // CRAFT_COST.rare
});

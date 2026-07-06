const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const gachaRoutes = require('../src/gacha/gacha.routes');

let app;
let user;

test.before(async () => {
  app = await createApp((a) => a.use('/api/gacha', gachaRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = {
    id: 'u1',
    email: 'joueur@example.com',
    displayName: 'Joueur',
    pity: 4,
    pullCommon: 9,
    pullRare: 0,
    pullEpic: 0,
    pullLegendary: 0,
    pullMythic: 1,
  };
  prisma.user.findUnique = async ({ where }) => (where.id === user.id ? user : null);
});

test("stats gacha : expose la chance comme indice relatif et non comme probabilité", async () => {
  const res = await app.request('/api/gacha/stats', { cookie: app.authCookie(user.id) });

  assert.equal(res.status, 200);
  assert.equal(res.json.total, 10);
  assert.ok(res.json.luck.percent > 100); // ancien format conservé pour compatibilité
  assert.equal(res.json.luck.index, res.json.luck.percent / 100);
  assert.ok(res.json.luck.index > 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const leaderboardRoutes = require('../src/leaderboard/leaderboard.routes');

let app;

test.before(async () => {
  app = await createApp((a) => a.use('/api/leaderboard', leaderboardRoutes.router));
});
test.after(() => app.close());

test('classement chance : trie par indice et ignore les échantillons trop petits', async () => {
  const users = [
    {
      id: 'u-hot', displayName: 'Chanceux', avatarUrl: null, avatarFrame: null,
      pullCommon: 0, pullRare: 25, pullEpic: 25, pullLegendary: 0, pullMythic: 0,
    },
    {
      id: 'u-me', displayName: 'Moi', avatarUrl: null, avatarFrame: null,
      pullCommon: 49, pullRare: 0, pullEpic: 0, pullLegendary: 0, pullMythic: 1,
    },
    {
      id: 'u-cold', displayName: 'Poisseux', avatarUrl: null, avatarFrame: null,
      pullCommon: 100, pullRare: 0, pullEpic: 0, pullLegendary: 0, pullMythic: 0,
    },
    {
      id: 'u-small', displayName: 'Trop petit', avatarUrl: null, avatarFrame: null,
      pullCommon: 0, pullRare: 0, pullEpic: 0, pullLegendary: 0, pullMythic: 10,
    },
  ];
  prisma.user.findUnique = async ({ where }) => users.find((u) => u.id === where.id) || null;
  prisma.user.findMany = async () => users;

  const res = await app.request('/api/leaderboard?type=luck', { cookie: app.authCookie('u-me') });

  assert.equal(res.status, 200);
  assert.equal(res.json.type, 'luck');
  assert.equal(res.json.minPulls, 50);
  assert.deepEqual(res.json.top.map((u) => u.userId), ['u-hot', 'u-me', 'u-cold']);
  assert.equal(res.json.top.some((u) => u.userId === 'u-small'), false);
  assert.equal(res.json.me.rank, 2);
  assert.equal(res.json.me.pullCount, 50);
  assert.ok(res.json.me.value > 1);
});

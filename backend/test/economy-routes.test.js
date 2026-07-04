// Tests de routes : /api/economy (bonus quotidien, solde, historique) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const economyRoutes = require('../src/economy/economy.routes');

function dbUser(over = {}) {
  return {
    id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 100, dust: 0,
    lastDailyAt: null, quizRewardAt: null, quizRewardWindow: 0,
    mpRewardAt: null, mpRewardWindow: 0,
    ...over,
  };
}

let app;
let user;
test.before(async () => {
  app = await createApp((a) => a.use('/api/economy', economyRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  prisma.user.findUnique = async ({ where, select }) => {
    if (where.id !== 'u1') return null;
    if (!select) return user;
    return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, user[k]]));
  };
});

test('daily : crédite 50 🪙 une fois, puis 400 le même jour', async () => {
  const writes = [];
  prisma.user.update = async ({ data }) => {
    writes.push(data);
    return dbUser({ tokens: 150, lastDailyAt: data.lastDailyAt });
  };
  prisma.tokenTransaction.create = async ({ data }) => { writes.push(data); return data; };

  const first = await app.request('/api/economy/daily', { method: 'POST', cookie: app.authCookie('u1') });
  assert.equal(first.status, 200);
  assert.equal(first.json.granted, 50);
  assert.equal(first.json.tokens, 150);
  assert.equal(writes[0].tokens.increment, 50);
  assert.equal(writes[1].reason, 'daily_bonus');

  user = dbUser({ lastDailyAt: new Date() }); // déjà réclamé aujourd'hui
  const again = await app.request('/api/economy/daily', { method: 'POST', cookie: app.authCookie('u1') });
  assert.equal(again.status, 400);
});

test('daily : re-disponible le lendemain', async () => {
  user = dbUser({ lastDailyAt: new Date(Date.now() - 26 * 3600 * 1000) });
  prisma.user.update = async () => dbUser({ tokens: 150 });
  prisma.tokenTransaction.create = async ({ data }) => data;
  const res = await app.request('/api/economy/daily', { method: 'POST', cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
});

test('balance : solde autoritaire depuis la BDD (pas le cookie)', async () => {
  user = dbUser({ tokens: 777, dust: 12 });
  const res = await app.request('/api/economy/balance', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { tokens: 777, dust: 12 });
});

test('transactions : libellés traduits + plus récentes en premier (take 30)', async () => {
  let query = null;
  prisma.tokenTransaction.findMany = async (q) => {
    query = q;
    return [
      { amount: 50, reason: 'daily_bonus', createdAt: new Date('2026-07-01') },
      { amount: -25, reason: 'raison_inconnue', createdAt: new Date('2026-06-30') },
    ];
  };
  const res = await app.request('/api/economy/transactions', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(query.take, 30);
  assert.deepEqual(query.orderBy, { createdAt: 'desc' });
  assert.equal(res.json.transactions[0].reason, 'Bonus quotidien');
  assert.equal(res.json.transactions[1].reason, 'raison_inconnue'); // repli brut
  assert.equal(res.json.balance, 100);
});

test('economy : 401 sans session', async () => {
  const res = await app.request('/api/economy/balance');
  assert.equal(res.status, 401);
});

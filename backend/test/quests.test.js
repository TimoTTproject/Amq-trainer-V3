// Quêtes quotidiennes : génération (4/jour, types distincts issus du pool).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

const prisma = fakePrisma();
const { ensureDailyQuests, progressQuests, todayStr } = require('../src/quests/quests');

test('ensureDailyQuests : génère 4 quêtes de types distincts', async () => {
  let created = null;
  let call = 0;
  prisma.quest.findMany = async () => (call++ === 0 ? [] : created.map((d, i) => ({ id: i + 1, progress: 0, claimed: false, ...d })));
  prisma.quest.createMany = async ({ data }) => { created = data; return { count: data.length }; };

  const quests = await ensureDailyQuests('u1');
  assert.equal(created.length, 4, '4 quêtes par jour');
  const types = created.map((q) => q.type);
  assert.equal(new Set(types).size, 4, 'types tous distincts');
  // Chaque quête a un label, une cible > 0 et une récompense > 0.
  for (const q of created) {
    assert.ok(q.label && q.target > 0 && q.reward > 0, 'quête valide: ' + JSON.stringify(q));
  }
  assert.equal(quests.length, 4);
});

test('ensureDailyQuests : ne recrée pas si les 4 quêtes du jour existent déjà', async () => {
  const existing = [
    { id: 1, type: 'correct', label: 'x', target: 10, reward: 40, progress: 0, claimed: false },
    { id: 2, type: 'played', label: 'x', target: 15, reward: 35, progress: 0, claimed: false },
    { id: 3, type: 'pull', label: 'x', target: 5, reward: 30, progress: 0, claimed: false },
    { id: 4, type: 'tower', label: 'x', target: 8, reward: 40, progress: 0, claimed: false },
  ];
  prisma.quest.findMany = async () => existing;
  let createCalled = false;
  prisma.quest.createMany = async () => { createCalled = true; return { count: 0 }; };

  const quests = await ensureDailyQuests('u1');
  assert.equal(createCalled, false, 'pas de recréation');
  assert.deepEqual(quests, existing);
});

test('ensureDailyQuests : complète la quête daily si le défi est déjà fini', async () => {
  const day = todayStr();
  const existing = [
    { id: 1, userId: 'u1', day, type: 'daily', label: 'Termine le défi du jour', target: 1, reward: 30, progress: 0, claimed: false },
    { id: 2, userId: 'u1', day, type: 'correct', label: 'x', target: 10, reward: 40, progress: 0, claimed: false },
    { id: 3, userId: 'u1', day, type: 'pull', label: 'x', target: 5, reward: 30, progress: 0, claimed: false },
    { id: 4, userId: 'u1', day, type: 'tower', label: 'x', target: 8, reward: 40, progress: 0, claimed: false },
  ];
  let update = null;

  prisma.quest.findMany = async () => existing;
  prisma.quest.createMany = async () => { throw new Error('createMany ne doit pas être appelé'); };
  prisma.dailyRun.findUnique = async ({ where, select }) => {
    assert.deepEqual(where, { userId_day: { userId: 'u1', day } });
    assert.deepEqual(select, { finished: true });
    return { finished: true };
  };
  prisma.quest.updateMany = async ({ where, data }) => {
    update = { where, data };
    return { count: 1 };
  };

  const quests = await ensureDailyQuests('u1');
  assert.deepEqual(update.data, { progress: 1 });
  assert.deepEqual(update.where.id, { in: [1] });
  assert.equal(quests.find((q) => q.type === 'daily').progress, 1);
});

test('ensureDailyQuests : garde les anciennes quêtes non réclamées avec celles du jour', async () => {
  const day = todayStr();
  const today = [
    { id: 1, userId: 'u1', day, type: 'correct', label: 'x', target: 10, reward: 40, progress: 0, claimed: false },
    { id: 2, userId: 'u1', day, type: 'played', label: 'x', target: 15, reward: 35, progress: 0, claimed: false },
    { id: 3, userId: 'u1', day, type: 'pull', label: 'x', target: 5, reward: 30, progress: 0, claimed: false },
    { id: 4, userId: 'u1', day, type: 'tower', label: 'x', target: 8, reward: 40, progress: 0, claimed: false },
  ];
  const carried = { id: 99, userId: 'u1', day: '2026-07-01', type: 'mp', label: 'x', target: 2, reward: 50, progress: 1, claimed: false };

  prisma.quest.findMany = async ({ where }) => (where.OR ? [carried, ...today] : today);
  prisma.quest.createMany = async () => { throw new Error('createMany ne doit pas être appelé'); };

  const quests = await ensureDailyQuests('u1');
  assert.equal(quests.length, 5);
  assert.equal(quests.find((q) => q.id === 99), carried);
});

test('progressQuests : fait progresser les quêtes actives même reportées', async () => {
  let update = null;
  prisma.quest.updateMany = async ({ where, data }) => {
    update = { where, data };
    return { count: 2 };
  };

  await progressQuests('u1', 'correct', 3);
  assert.deepEqual(update, {
    where: { userId: 'u1', type: 'correct', claimed: false },
    data: { progress: { increment: 3 } },
  });
});

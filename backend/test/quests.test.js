// Quêtes quotidiennes : génération (4/jour, types distincts issus du pool).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

const prisma = fakePrisma();
const { ensureDailyQuests } = require('../src/quests/quests');

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

test('ensureDailyQuests : ne recrée pas si les quêtes du jour existent déjà', async () => {
  const existing = [{ id: 1, type: 'correct', label: 'x', target: 10, reward: 40, progress: 0, claimed: false }];
  prisma.quest.findMany = async () => existing;
  let createCalled = false;
  prisma.quest.createMany = async () => { createCalled = true; return { count: 0 }; };

  const quests = await ensureDailyQuests('u1');
  assert.equal(createCalled, false, 'pas de recréation');
  assert.deepEqual(quests, existing);
});

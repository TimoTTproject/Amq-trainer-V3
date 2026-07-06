// pickRandomCharacter : ne doit JAMAIS retomber sur une autre rareté que celle
// tirée — sinon un tirage Mythique pourrait être livré comme Commun en
// silence dès que le palier Mythique est épuisé (bug corrigé ici).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma } = require('./helpers/api');

const prisma = fakePrisma();
const { pickRandomCharacter } = require('../src/gacha/gacha.routes');

test.beforeEach(() => {
  prisma.character.findUnique = async () => null; // pas de boost vedette
  prisma.character.findFirst = async () => null;  // pas de vedette de la rareté (par défaut)
});

test('pickRandomCharacter : renvoie null si la rareté ciblée est épuisée, sans repli vers une autre rareté', async () => {
  const calls = [];
  prisma.character.count = async ({ where }) => { calls.push(where); return 0; };
  const result = await pickRandomCharacter(prisma, 'mythic', {});
  assert.equal(result, null);
  // Une seule tentative de comptage, bornée à la rareté demandée — jamais de
  // second essai avec { soldOut:false } seul (l'ancien repli fautif).
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { rarity: 'mythic', soldOut: false });
});

test('pickRandomCharacter : pioche bien DANS la rareté demandée quand elle a du stock', async () => {
  let countWhere = null;
  let pickWhere = null;
  prisma.character.count = async ({ where }) => { countWhere = where; return 3; };
  prisma.character.findFirst = async ({ where }) => {
    if (where.featured) return null; // pas de vedette pour cette rareté
    pickWhere = where;
    return { id: 42, name: 'Test', rarity: 'mythic' };
  };
  const result = await pickRandomCharacter(prisma, 'mythic', {});
  assert.equal(result.id, 42);
  assert.deepEqual(countWhere, { rarity: 'mythic', soldOut: false });
  assert.deepEqual(pickWhere, { rarity: 'mythic', soldOut: false });
});

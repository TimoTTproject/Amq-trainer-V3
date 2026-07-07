// POST /api/gacha/refresh-featured : relance la vedette de la semaine en cours
// d'après les votes déjà émis (personnage le plus voté par rareté), via un
// override horodaté. Admin uniquement, sans suppression de votes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const gachaRoutes = require('../src/gacha/gacha.routes');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin', isAdmin: true };
const PLAIN = { id: 'u1', email: 'j@b.fr', displayName: 'Joueur' };

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/gacha', gachaRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => (where.id === ADMIN.id ? ADMIN : where.id === PLAIN.id ? PLAIN : null);
});

test('refresh-featured : refuse un non-admin', async () => {
  const res = await app.request('/api/gacha/refresh-featured', { method: 'POST', cookie: app.authCookie(PLAIN.id) });
  assert.equal(res.status, 403);
});

test('refresh-featured : 400 si aucun vote cette semaine', async () => {
  prisma.featuredVote.groupBy = async () => [];
  const res = await app.request('/api/gacha/refresh-featured', { method: 'POST', cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Aucun vote/);
});

test('refresh-featured : fixe le plus voté par rareté dans un override horodaté', async () => {
  // Mythic : perso 7 (3 voix) gagne contre 9 (1 voix). Legendary : perso 5 (2 voix).
  // Epic : aucun vote.
  prisma.featuredVote.groupBy = async ({ where }) => {
    if (where.rarity === 'mythic') return [{ characterId: 7, _count: { characterId: 3 } }, { characterId: 9, _count: { characterId: 1 } }];
    if (where.rarity === 'legendary') return [{ characterId: 5, _count: { characterId: 2 } }];
    return [];
  };
  let savedOverride = null;
  prisma.appSetting.upsert = async ({ create, update }) => { savedOverride = JSON.parse((update || create).value); return {}; };
  prisma.appSetting.findUnique = async ({ where }) => (where.key === 'featuredOverride' && savedOverride ? { value: JSON.stringify(savedOverride) } : null);
  // getWeeklyFeatured (rafraîchi après invalidation) : stubs minimaux.
  prisma.character.count = async () => 0; // pas de tirage déterministe
  prisma.character.findUnique = async ({ where }) => ({ id: where.id, name: 'Char' + where.id, imageUrl: null, rarity: where.id === 7 ? 'mythic' : 'legendary' });

  const res = await app.request('/api/gacha/refresh-featured', { method: 'POST', cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 200);
  // Le plus voté est retenu par rareté (7 en mythic, 5 en legendary), epic ignoré.
  assert.equal(savedOverride.byRarity.mythic, 7);
  assert.equal(savedOverride.byRarity.legendary, 5);
  assert.equal('epic' in savedOverride.byRarity, false);
  assert.ok(typeof savedOverride.week === 'number', 'override horodaté sur la semaine');
  assert.deepEqual(res.json.applied.sort(), ['legendary', 'mythic']);
});

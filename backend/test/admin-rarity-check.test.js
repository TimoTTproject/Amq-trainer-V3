// Tests de route : GET /api/admin/rarity-check (diagnostic lecture seule des
// raretés + probabilités + overrides manuels) et POST /api/admin/fix-supply-
// mismatch (recale maxSupply/soldOut sur la rareté).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');
const { MAX_SUPPLY, RARITY_RATES } = require('../src/gacha/rarity');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin' };
const PLAIN = { id: 'u1', email: 'joueur@b.fr', displayName: 'Joueur' };

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/admin', adminRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === ADMIN.id) return ADMIN;
    if (where.id === PLAIN.id) return PLAIN;
    return null;
  };
});

test('rarity-check : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/rarity-check', { cookie: app.authCookie(PLAIN.id) });
  assert.equal(res.status, 403);
});

test('rarity-check : calcule la chance par perso et détecte les overrides manuels', async () => {
  // Petit pool où le rang détermine la rareté : les 150 premiers seraient
  // mythiques, etc. On force un cas simple avec 3 persos et un override : le
  // perso rang #2 (qui SERAIT mythique dans ce mini-pool) est stocké "common".
  // Comme MYTHIC_COUNT=150 > 3, rarityForRank renvoie 'mythic' pour tous ici,
  // donc tout perso non-mythic est un override — pratique pour le test.
  prisma.character.findMany = async () => [
    { id: 1, name: 'A', favourites: 100, rarity: 'mythic', maxSupply: MAX_SUPPLY.mythic, minted: 0, soldOut: false },
    { id: 2, name: 'B', favourites: 90, rarity: 'common', maxSupply: MAX_SUPPLY.common, minted: 0, soldOut: false },
    { id: 3, name: 'C', favourites: 80, rarity: 'mythic', maxSupply: MAX_SUPPLY.mythic, minted: 0, soldOut: true },
  ];
  const res = await app.request('/api/admin/rarity-check', { cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 3);

  const mythic = res.json.rarities.find((r) => r.rarity === 'mythic');
  assert.equal(mythic.count, 2);
  assert.equal(mythic.notSoldOut, 1); // #3 est épuisé
  assert.equal(mythic.tierRatePct, RARITY_RATES.mythic);
  // Chance par perso = taux du palier / nb tirables (1 seul non épuisé).
  assert.equal(mythic.perCharChancePct, RARITY_RATES.mythic);

  // #2 (stocké common) est un override vs sa rareté par rang (mythic dans ce mini-pool).
  assert.equal(res.json.overrides.total, 1);
  assert.equal(res.json.overrides.sample[0].id, 2);
  assert.equal(res.json.overrides.sample[0].stored, 'common');
  assert.equal(res.json.overrides.sample[0].byRank, 'mythic');
});

test('rarity-check : signale un maxSupply incohérent avec la rareté', async () => {
  // Un perso "mythic" mais avec un maxSupply de common (1000000) → incohérent.
  prisma.character.findMany = async () => [
    { id: 1, name: 'A', favourites: 100, rarity: 'mythic', maxSupply: 1000000, minted: 0, soldOut: false },
  ];
  const res = await app.request('/api/admin/rarity-check', { cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 200);
  assert.equal(res.json.supplyMismatches.total, 1);
  assert.equal(res.json.supplyMismatches.sample[0].expected, MAX_SUPPLY.mythic);
  assert.equal(res.json.supplyMismatches.sample[0].maxSupply, 1000000);
});

test('fix-supply-mismatch : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/fix-supply-mismatch', { method: 'POST', cookie: app.authCookie(PLAIN.id), body: {} });
  assert.equal(res.status, 403);
});

test('fix-supply-mismatch : recale maxSupply/soldOut, jamais sous le nombre en circulation', async () => {
  prisma.character.findMany = async () => [
    // Incohérent : mythic avec plafond common → à ramener à MAX_SUPPLY.mythic.
    { id: 1, rarity: 'mythic', maxSupply: 1000000, minted: 0 },
    // Déjà cohérent → ignoré.
    { id: 2, rarity: 'legendary', maxSupply: MAX_SUPPLY.legendary, minted: 0 },
    // Sursouscrit : plus en circulation que le plafond → garde minted, soldOut=true.
    { id: 3, rarity: 'mythic', maxSupply: 999, minted: 30 },
  ];
  const updates = [];
  prisma.character.update = async ({ where, data }) => { updates.push({ id: where.id, data }); return {}; };

  const res = await app.request('/api/admin/fix-supply-mismatch', { method: 'POST', cookie: app.authCookie(ADMIN.id), body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.fixed, 2); // #1 et #3

  const u1 = updates.find((u) => u.id === 1);
  assert.equal(u1.data.maxSupply, MAX_SUPPLY.mythic);
  assert.equal(u1.data.soldOut, false);
  const u3 = updates.find((u) => u.id === 3);
  assert.equal(u3.data.maxSupply, 30); // max(MAX_SUPPLY.mythic=25, minted=30) = 30
  assert.equal(u3.data.soldOut, true);
  assert.equal(updates.find((u) => u.id === 2), undefined); // #2 non touché
});

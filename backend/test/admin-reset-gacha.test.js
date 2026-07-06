// Tests de route : POST /api/admin/reset-gacha (collection remise à zéro +
// compensation en tokens, sans toucher aux autres systèmes de jeu) et
// GET /api/gacha/reset-notice (horodatage exposé au client pour la modale).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');
const gachaRoutes = require('../src/gacha/gacha.routes');
const { GACHA_RESET_COMPENSATION } = require('../src/gacha/rarity');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin' };
const PLAIN = { id: 'u1', email: 'joueur@b.fr', displayName: 'Joueur' };

let app;
test.before(async () => {
  app = await createApp((a) => {
    a.use('/api/admin', adminRoutes.router);
    a.use('/api/gacha', gachaRoutes.router);
  });
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === ADMIN.id) return ADMIN;
    if (where.id === PLAIN.id) return PLAIN;
    return null;
  };
});

test('reset-gacha : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/reset-gacha', {
    method: 'POST', cookie: app.authCookie(PLAIN.id), body: { confirm: 'RESET_GACHA' },
  });
  assert.equal(res.status, 403);
});

test('reset-gacha : refuse sans la confirmation exacte', async () => {
  const res = await app.request('/api/admin/reset-gacha', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET' },
  });
  assert.equal(res.status, 400);
});

test('reset-gacha : succès → compense chaque joueur et ne touche pas les autres champs', async () => {
  prisma.user.findMany = async () => [{ id: 'u1' }, { id: 'u2' }];
  const writes = [];
  prisma.userCard.deleteMany = async () => { writes.push('userCard'); return {}; };
  prisma.cardInstance.deleteMany = async () => { writes.push('cardInstance'); return {}; };
  prisma.trade.deleteMany = async () => { writes.push('trade'); return {}; };
  prisma.cardAlbumItem.deleteMany = async () => { writes.push('cardAlbumItem'); return {}; };
  prisma.cardAlbum.deleteMany = async () => { writes.push('cardAlbum'); return {}; };
  prisma.character.updateMany = async ({ data }) => {
    assert.deepEqual(data, { minted: 0, nextSerial: 0, soldOut: false });
    writes.push('character');
    return {};
  };
  let userUpdateData = null;
  prisma.user.updateMany = async ({ data }) => { userUpdateData = data; writes.push('user'); return {}; };
  let txCreated = null;
  prisma.tokenTransaction.createMany = async ({ data }) => { txCreated = data; writes.push('tokenTransaction'); return {}; };
  prisma.appSetting.upsert = async () => { writes.push('appSetting'); return {}; };

  const res = await app.request('/api/admin/reset-gacha', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET_GACHA' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.users, 2);
  assert.equal(res.json.compensation, GACHA_RESET_COMPENSATION);
  assert.equal(userUpdateData.tokens, GACHA_RESET_COMPENSATION);
  assert.equal(userUpdateData.dust, 0);
  // Ne doit PAS toucher aux stats quiz/Château/multijoueur/défi/niveaux.
  for (const field of ['towerBestFloor', 'mmr', 'soloMmr', 'dailyStreak', 'claimedLevel']) {
    assert.equal(field in userUpdateData, false, `${field} ne devrait pas être touché`);
  }
  assert.equal(txCreated.length, 2);
  assert.equal(txCreated[0].reason, 'gacha_reset_compensation');
  assert.equal(txCreated[0].amount, GACHA_RESET_COMPENSATION);
  assert.ok(['userCard', 'cardInstance', 'trade', 'cardAlbumItem', 'cardAlbum', 'character', 'user', 'tokenTransaction', 'appSetting'].every((w) => writes.includes(w)));
});

test('reset-notice : renvoie null si aucun reset n\'a jamais eu lieu', async () => {
  prisma.appSetting.findUnique = async () => null;
  const res = await app.request('/api/gacha/reset-notice', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.resetAt, null);
});

test('reset-notice : renvoie l\'horodatage + la compensation après un reset', async () => {
  prisma.appSetting.findUnique = async () => ({ key: 'lastGachaReset', value: '1751800000000' });
  const res = await app.request('/api/gacha/reset-notice', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.resetAt, 1751800000000);
  assert.equal(res.json.compensation, GACHA_RESET_COMPENSATION);
});

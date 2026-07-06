// Tests de route : POST /api/admin/reset-gacha (collection remise à zéro +
// remboursement PROPRE À CHAQUE JOUEUR du montant réellement dépensé en
// tirages depuis toujours, sans toucher aux autres systèmes de jeu) et
// GET /api/gacha/reset-notice (horodatage + compensation personnelle pour la modale).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');
const gachaRoutes = require('../src/gacha/gacha.routes');

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

test('reset-gacha : rembourse chaque joueur du montant BRUT réellement dépensé en tirages (u1=300, u2=0)', async () => {
  prisma.user.findMany = async () => [{ id: 'u1' }, { id: 'u2' }];
  // u1 a dépensé 100+200=300 en pack_open (amount négatif) ; u2 n'a jamais tiré.
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    assert.equal(where.reason, 'pack_open');
    return [{ userId: 'u1', _sum: { amount: -300 } }];
  };
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
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  const txCreated = [];
  prisma.tokenTransaction.create = async ({ data }) => { txCreated.push(data); return data; };
  prisma.appSetting.upsert = async () => { writes.push('appSetting'); return {}; };

  const res = await app.request('/api/admin/reset-gacha', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET_GACHA' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.users, 2);
  assert.equal(res.json.totalCompensation, 300);
  // Dédommagement forfaitaire de cet incident (500/joueur), en plus du remboursement réel.
  assert.equal(res.json.totalBonus, 1000);

  const u1 = userUpdates.find((u) => u.id === 'u1');
  const u2 = userUpdates.find((u) => u.id === 'u2');
  // increment (jamais un remplacement) : préserve les tokens gagnés hors gacha.
  assert.deepEqual(u1.data.tokens, { increment: 800 }); // 300 dépensé + 500 dédommagement
  assert.deepEqual(u2.data.tokens, { increment: 500 }); // jamais tiré, mais reçoit le dédommagement
  assert.equal(u1.data.dust, 0);
  for (const field of ['towerBestFloor', 'mmr', 'soloMmr', 'dailyStreak', 'claimedLevel']) {
    assert.equal(field in u1.data, false, `${field} ne devrait pas être touché`);
  }
  // u1 (compensation > 0) reçoit compensation + bonus ; u2 (jamais tiré) reçoit seulement le bonus.
  assert.equal(txCreated.length, 3);
  const u1Comp = txCreated.find((t) => t.userId === 'u1' && t.reason === 'gacha_reset_compensation');
  assert.equal(u1Comp.amount, 300);
  const bonuses = txCreated.filter((t) => t.reason === 'gacha_incident_bonus');
  assert.equal(bonuses.length, 2);
  assert.ok(bonuses.every((t) => t.amount === 500));
  assert.ok(['userCard', 'cardInstance', 'trade', 'cardAlbumItem', 'cardAlbum', 'character', 'appSetting'].every((w) => writes.includes(w)));
});

test('reset-notice : renvoie resetAt=null si aucun reset n\'a jamais eu lieu', async () => {
  prisma.appSetting.findUnique = async () => null;
  const res = await app.request('/api/gacha/reset-notice', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.resetAt, null);
});

test('reset-notice : renvoie MA compensation ET mon bonus personnels (pas un forfait partagé)', async () => {
  prisma.appSetting.findUnique = async () => ({ key: 'lastGachaReset', value: '1751800000000' });
  prisma.tokenTransaction.findFirst = async ({ where }) => {
    assert.equal(where.userId, 'u1');
    if (where.reason === 'gacha_reset_compensation') return { userId: 'u1', amount: 300, reason: where.reason };
    if (where.reason === 'gacha_incident_bonus') return { userId: 'u1', amount: 500, reason: where.reason };
    throw new Error('reason inattendue: ' + where.reason);
  };
  const res = await app.request('/api/gacha/reset-notice', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.resetAt, 1751800000000);
  assert.equal(res.json.compensation, 300);
  assert.equal(res.json.bonus, 500);
});

test('reset-notice : compensation = 0 si le joueur n\'a jamais tiré (pas de transaction), bonus reste dû', async () => {
  prisma.appSetting.findUnique = async () => ({ key: 'lastGachaReset', value: '1751800000000' });
  prisma.tokenTransaction.findFirst = async ({ where }) => {
    if (where.reason === 'gacha_incident_bonus') return { userId: 'u1', amount: 500, reason: where.reason };
    return null;
  };
  const res = await app.request('/api/gacha/reset-notice', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.compensation, 0);
  assert.equal(res.json.bonus, 500);
});

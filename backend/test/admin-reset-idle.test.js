// Tests de route : POST /api/admin/reset-idle (remise à zéro DOJO uniquement,
// pour tous les comptes — essence, roster, objets, Ancients/Prestige) SANS
// toucher au reste du jeu (quiz, gacha, tokens).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin' };
const PLAIN = { id: 'u1', email: 'joueur@b.fr', displayName: 'Joueur' };

let app;
test.before(async () => {
  app = await createApp((a) => {
    a.use('/api/admin', adminRoutes.router);
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

test('reset-idle : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/reset-idle', {
    method: 'POST', cookie: app.authCookie(PLAIN.id), body: { confirm: 'RESET_IDLE' },
  });
  assert.equal(res.status, 403);
});

test('reset-idle : refuse sans la confirmation exacte', async () => {
  const res = await app.request('/api/admin/reset-idle', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET' },
  });
  assert.equal(res.status, 400);
});

test('reset-idle : vide le roster/inventaire Dojo et remet à zéro les compteurs idle SANS toucher aux tokens/gacha', async () => {
  prisma.user.count = async () => 5;
  const writes = [];
  prisma.idleSlot.deleteMany = async () => { writes.push('idleSlot'); return {}; };
  prisma.idleItem.deleteMany = async () => { writes.push('idleItem'); return {}; };
  prisma.dojoRecruit.deleteMany = async () => { writes.push('dojoRecruit'); return {}; };
  prisma.ancientLevel.deleteMany = async () => { writes.push('ancientLevel'); return {}; };
  prisma.idleTeamPreset.deleteMany = async () => { writes.push('idleTeamPreset'); return {}; };
  prisma.idleRiftRun.deleteMany = async () => { writes.push('idleRiftRun'); return {}; };
  prisma.idleRunHistory.deleteMany = async () => { writes.push('idleRunHistory'); return {}; };
  prisma.idleMissionClaim.deleteMany = async () => { writes.push('idleMissionClaim'); return {}; };
  prisma.idleProgressCounter.deleteMany = async () => { writes.push('idleProgressCounter'); return {}; };
  let userUpdateData = null;
  prisma.user.updateMany = async ({ data }) => { userUpdateData = data; writes.push('user'); return {}; };

  const res = await app.request('/api/admin/reset-idle', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET_IDLE' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.users, 5);

  assert.equal(userUpdateData.essence, 20);
  assert.equal(userUpdateData.idleSlotsUnlocked, 3);
  assert.equal(userUpdateData.prestigeLevel, 0);
  assert.equal(userUpdateData.wisdomPoints, 0);
  assert.equal(userUpdateData.idleStage, 1);
  assert.equal(userUpdateData.idleSeals, 2);
  // Aucun champ hors idle/prestige/wisdom/essence ne doit être touché.
  for (const field of ['tokens', 'dust', 'pity', 'towerBestFloor', 'mmr', 'claimedLevel']) {
    assert.equal(field in userUpdateData, false, `${field} ne devrait pas être touché`);
  }
  assert.ok(['idleSlot', 'idleItem', 'dojoRecruit', 'ancientLevel', 'idleTeamPreset', 'idleRiftRun', 'idleRunHistory', 'idleMissionClaim', 'idleProgressCounter', 'user'].every((w) => writes.includes(w)));
});

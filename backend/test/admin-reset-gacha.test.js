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

test('reset-gacha : rembourse chaque joueur du montant BRUT réellement dépensé en tirages depuis le reset précédent (u1=300, u2=0)', async () => {
  prisma.user.findMany = async () => [{ id: 'u1' }, { id: 'u2' }];
  // Aucun reset précédent → pas de borne de date, tout l'historique pack_open compte.
  prisma.appSetting.findUnique = async () => null;
  // u1 a dépensé 100+200=300 en pack_open (amount négatif) ; u2 n'a jamais tiré.
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    assert.equal(where.reason, 'pack_open');
    assert.equal('createdAt' in where, false);
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

test('reset-gacha : ne rembourse QUE les tirages postérieurs au reset précédent (jamais deux fois la même dépense)', async () => {
  prisma.user.findMany = async () => [{ id: 'u1' }];
  const prevResetMs = 1751800000000;
  prisma.appSetting.findUnique = async () => ({ key: 'lastGachaReset', value: String(prevResetMs) });
  let capturedWhere;
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    capturedWhere = where;
    return [{ userId: 'u1', _sum: { amount: -50 } }]; // seuls les tirages APRÈS le reset précédent
  };
  prisma.userCard.deleteMany = async () => ({});
  prisma.cardInstance.deleteMany = async () => ({});
  prisma.trade.deleteMany = async () => ({});
  prisma.cardAlbumItem.deleteMany = async () => ({});
  prisma.cardAlbum.deleteMany = async () => ({});
  prisma.character.updateMany = async () => ({});
  prisma.user.update = async () => ({});
  prisma.tokenTransaction.create = async ({ data }) => data;
  prisma.appSetting.upsert = async () => ({});

  const res = await app.request('/api/admin/reset-gacha', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RESET_GACHA' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.totalCompensation, 50);
  assert.ok(capturedWhere.createdAt.gt instanceof Date);
  assert.equal(capturedWhere.createdAt.gt.getTime(), prevResetMs);
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

// ── Relevé complet des tokens d'un joueur (diagnostic) ──
test('token-ledger : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/token-ledger?user=Dova', { cookie: app.authCookie(PLAIN.id) });
  assert.equal(res.status, 403);
});

test('token-ledger : 404 si le joueur est introuvable', async () => {
  prisma.user.findFirst = async () => null;
  const res = await app.request('/api/admin/token-ledger?user=Inconnu', { cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 404);
});

test('token-ledger : regroupe les transactions par raison et fournit le détail chronologique', async () => {
  prisma.user.findFirst = async () => ({ id: 'dova1', displayName: 'Dova', tokens: 9000 });
  const rows = [
    { id: 1, amount: -100, reason: 'pack_open', createdAt: new Date('2026-07-01T00:00:00Z') },
    { id: 2, amount: 4000, reason: 'gacha_reset_compensation', createdAt: new Date('2026-07-04T00:00:00Z') },
    { id: 3, amount: 500, reason: 'gacha_incident_bonus', createdAt: new Date('2026-07-06T00:00:00Z') },
    { id: 4, amount: 4500, reason: 'gacha_reset_compensation', createdAt: new Date('2026-07-06T00:00:01Z') },
  ];
  prisma.tokenTransaction.findMany = async () => rows;
  const res = await app.request('/api/admin/token-ledger?user=Dova', { cookie: app.authCookie(ADMIN.id) });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.displayName, 'Dova');
  assert.equal(res.json.byReason.gacha_reset_compensation.count, 2);
  assert.equal(res.json.byReason.gacha_reset_compensation.total, 8500);
  assert.equal(res.json.transactions.length, 4);
  assert.equal(res.json.sumOfAllTransactions, -100 + 4000 + 500 + 4500);
});

// ── Correction du remboursement en double (2 évènements de reset détectés) ──
test('fix-double-refund : refuse sans la confirmation exacte', async () => {
  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: {},
  });
  assert.equal(res.status, 400);
});

test('fix-double-refund : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(PLAIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 403);
});

test('fix-double-refund : refuse s\'il n\'y a qu\'un seul évènement de reset détecté', async () => {
  const onlyOne = new Date('2026-07-01T10:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation' && !where.createdAt) {
      return [{ createdAt: onlyOne }];
    }
    return [];
  };
  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Un seul évènement/);
});

test('fix-double-refund : retire uniquement l\'excédent du dernier reset (dépense réelle entre les 2 évènements)', async () => {
  // Évènement 1 (le vrai premier reset) : 01/07 10:00. Évènement 2 (buggé,
  // remboursement sur TOUT l'historique au lieu de depuis l'évènement 1) : 06/07 09:00.
  const firstEventAt = new Date('2026-07-01T10:00:00Z');
  const lastEventAt = new Date('2026-07-06T09:00:00Z');

  // u1 a été compensé aux 2 évènements (donc 2 lignes 'gacha_reset_compensation'
  // dans l'historique complet, groupées en 2 clusters distincts par le code).
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation' && !where.createdAt) {
      // Historique complet, utilisé par findResetEvents() pour détecter les clusters.
      return [{ createdAt: firstEventAt }, { createdAt: lastEventAt }];
    }
    if (where?.reason === 'gacha_reset_compensation' && where.createdAt) {
      // Transactions du DERNIER évènement seulement : u1 a reçu 64000 (buggé :
      // tout l'historique pack_open, y compris avant le 1er reset).
      return [{ userId: 'u1', amount: 64000, reason: 'gacha_reset_compensation', createdAt: lastEventAt }];
    }
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null; // pas encore corrigé
  // Dépense RÉELLE entre les 2 évènements (ce qui aurait dû être remboursé) : 16000.
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    assert.equal(where.userId, 'u1');
    assert.equal(where.reason, 'pack_open');
    assert.ok(where.createdAt.gt.getTime() === firstEventAt.getTime());
    assert.ok(where.createdAt.lte.getTime() === lastEventAt.getTime());
    return [{ userId: 'u1', _sum: { amount: -16000 } }];
  };
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === ADMIN.id) return ADMIN;
    if (where.id === 'u1') return { tokens: 200000 }; // largement de quoi couvrir la correction
    return null;
  };
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  const txCreated = [];
  prisma.tokenTransaction.create = async ({ data }) => { txCreated.push(data); return data; };

  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersFixed, 1);
  const fix = res.json.corrections[0];
  assert.equal(fix.userId, 'u1');
  assert.equal(fix.wrongAmount, 64000);
  assert.equal(fix.correctAmount, 16000);
  assert.equal(fix.excess, 48000); // 64000 - 16000 : l'excédent à retirer
  assert.equal(fix.removed, 48000);
  assert.equal(fix.clamped, false);

  const u1Update = userUpdates.find((u) => u.id === 'u1');
  assert.deepEqual(u1Update.data.tokens, { decrement: 48000 });
  const correction = txCreated.find((t) => t.reason === 'gacha_reset_correction');
  assert.equal(correction.amount, -48000);
});

test('fix-double-refund : plafonne le retrait si le joueur a déjà tout dépensé (jamais de solde négatif)', async () => {
  const firstEventAt = new Date('2026-07-01T10:00:00Z');
  const lastEventAt = new Date('2026-07-06T09:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation' && !where.createdAt) {
      return [{ createdAt: firstEventAt }, { createdAt: lastEventAt }];
    }
    if (where?.reason === 'gacha_reset_compensation' && where.createdAt) {
      return [{ userId: 'u1', amount: 64000, reason: 'gacha_reset_compensation', createdAt: lastEventAt }];
    }
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null;
  prisma.tokenTransaction.groupBy = async () => [{ userId: 'u1', _sum: { amount: -16000 } }];
  // Il ne lui reste que 1000 tokens (il a déjà dépensé l'excédent reçu par erreur).
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? { tokens: 1000 } : ADMIN);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  prisma.tokenTransaction.create = async ({ data }) => data;

  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 200);
  const fix = res.json.corrections[0];
  assert.equal(fix.excess, 48000);
  assert.equal(fix.removed, 1000); // plafonné à ce qu'il lui reste
  assert.equal(fix.clamped, true);
  assert.deepEqual(userUpdates.find((u) => u.id === 'u1').data.tokens, { decrement: 1000 });
});

test('fix-double-refund : corrige TOUS les évènements après le 1er, pas seulement le dernier (3 resets ou plus)', async () => {
  // 3 évènements de reset : le 1er est correct par définition (pas de
  // prédécesseur). Le 2e ET le 3e ont chacun été calculés en buggé (tout
  // l'historique pack_open), donc les DEUX doivent être corrigés — une
  // correction limitée au seul dernier évènement laisserait l'excédent du
  // 2e non retiré (bug signalé : "il y a encore une fois de trop").
  const e1 = new Date('2026-07-01T10:00:00Z');
  const e2 = new Date('2026-07-04T10:00:00Z');
  const e3 = new Date('2026-07-06T09:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation' && !where.createdAt) {
      return [{ createdAt: e1 }, { createdAt: e2 }, { createdAt: e3 }];
    }
    if (where?.reason === 'gacha_reset_compensation' && where.createdAt) {
      const from = where.createdAt.gte.getTime();
      if (from === e2.getTime()) return [{ userId: 'u1', amount: 20000, reason: 'gacha_reset_compensation', createdAt: e2 }];
      if (from === e3.getTime()) return [{ userId: 'u1', amount: 64000, reason: 'gacha_reset_compensation', createdAt: e3 }];
    }
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null; // rien encore corrigé
  // Dépense réelle : 5000 entre e1→e2, puis 9000 entre e2→e3.
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    if (where.createdAt.gt.getTime() === e1.getTime()) return [{ userId: 'u1', _sum: { amount: -5000 } }];
    if (where.createdAt.gt.getTime() === e2.getTime()) return [{ userId: 'u1', _sum: { amount: -9000 } }];
    return [];
  };
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? { tokens: 200000 } : ADMIN);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  prisma.tokenTransaction.create = async ({ data }) => data;

  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.eventsChecked, 2); // e2 et e3
  assert.equal(res.json.usersFixed, 2);
  const fixE2 = res.json.corrections.find((c) => c.event === 2);
  const fixE3 = res.json.corrections.find((c) => c.event === 3);
  assert.equal(fixE2.wrongAmount, 20000);
  assert.equal(fixE2.correctAmount, 5000);
  assert.equal(fixE2.excess, 15000);
  assert.equal(fixE3.wrongAmount, 64000);
  assert.equal(fixE3.correctAmount, 9000);
  assert.equal(fixE3.excess, 55000);
  // Total retiré = 15000 + 55000 = 70000, en 2 décréments distincts.
  assert.equal(userUpdates.length, 2);
  assert.ok(userUpdates.every((u) => u.id === 'u1'));
  const totalRemoved = userUpdates.reduce((s, u) => s + u.data.tokens.decrement, 0);
  assert.equal(totalRemoved, 70000);
});

test('fix-double-refund : idempotent — un 2e appel ne retire rien de plus si déjà corrigé', async () => {
  const firstEventAt = new Date('2026-07-01T10:00:00Z');
  const lastEventAt = new Date('2026-07-06T09:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation' && !where.createdAt) {
      return [{ createdAt: firstEventAt }, { createdAt: lastEventAt }];
    }
    if (where?.reason === 'gacha_reset_compensation' && where.createdAt) {
      return [{ userId: 'u1', amount: 64000, reason: 'gacha_reset_compensation', createdAt: lastEventAt }];
    }
    return [];
  };
  // Une correction existe déjà pour u1 sur cet évènement.
  prisma.tokenTransaction.findFirst = async ({ where }) => (where.reason === 'gacha_reset_correction' ? { id: 1 } : null);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };

  const res = await app.request('/api/admin/reset-gacha/fix-double-refund', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'FIX_DOUBLE_REFUND' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersFixed, 0);
  assert.equal(userUpdates.length, 0);
});

// ── Annulation complète (garde le 1er remboursement, annule le reste + les
// corrections déjà appliquées) — cas réel : 3 remboursements (78900 au
// total), 2 corrections déjà appliquées (-30600), toujours trop élevé.
test('rollback-to-first : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/reset-gacha/rollback-to-first', {
    method: 'POST', cookie: app.authCookie(PLAIN.id), body: { confirm: 'ROLLBACK_TO_FIRST' },
  });
  assert.equal(res.status, 403);
});

test('rollback-to-first : refuse sans la confirmation exacte', async () => {
  const res = await app.request('/api/admin/reset-gacha/rollback-to-first', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: {},
  });
  assert.equal(res.status, 400);
});

test('rollback-to-first : refuse s\'il n\'y a qu\'un seul remboursement détecté', async () => {
  prisma.tokenTransaction.findMany = async ({ where }) =>
    (where?.reason === 'gacha_reset_compensation' ? [{ userId: 'u1', amount: 500, createdAt: new Date() }] : []);
  const res = await app.request('/api/admin/reset-gacha/rollback-to-first', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'ROLLBACK_TO_FIRST' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Un seul remboursement/);
});

test('rollback-to-first : annule tout sauf le 1er remboursement, plus les corrections déjà appliquées', async () => {
  // Reproduit le relevé réel : 3 remboursements gacha_reset_compensation
  // (le 1er est légitime, gardé), 2 corrections déjà appliquées (-30600 au
  // total, insuffisantes). netExcess = (event2+event3) - corrections déjà retirées.
  const e1 = new Date('2026-07-01T10:00:00Z');
  const e2 = new Date('2026-07-04T10:00:00Z');
  const e3 = new Date('2026-07-06T09:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation') {
      return [
        { userId: 'u1', amount: 4000, reason: 'gacha_reset_compensation', createdAt: e1 },
        { userId: 'u1', amount: 20000, reason: 'gacha_reset_compensation', createdAt: e2 },
        { userId: 'u1', amount: 54900, reason: 'gacha_reset_compensation', createdAt: e3 },
      ];
    }
    if (where?.reason === 'gacha_reset_correction') {
      return [
        { userId: 'u1', amount: -15000, reason: 'gacha_reset_correction', createdAt: e2 },
        { userId: 'u1', amount: -15600, reason: 'gacha_reset_correction', createdAt: e3 },
      ];
    }
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null; // pas encore rollback
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? { tokens: 200000 } : ADMIN);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  const txCreated = [];
  prisma.tokenTransaction.create = async ({ data }) => { txCreated.push(data); return data; };

  const res = await app.request('/api/admin/reset-gacha/rollback-to-first', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'ROLLBACK_TO_FIRST' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersAffected, 1);
  const fix = res.json.results[0];
  assert.equal(fix.userId, 'u1');
  // À annuler : (20000 + 54900) - (15000 + 15600) = 74900 - 30600 = 44300.
  assert.equal(fix.netExcess, 44300);
  assert.equal(fix.removed, 44300);
  assert.equal(fix.clamped, false);

  const rollback = txCreated.find((t) => t.reason === 'gacha_reset_rollback');
  assert.equal(rollback.amount, -44300);
  assert.deepEqual(userUpdates.find((u) => u.id === 'u1').data.tokens, { decrement: 44300 });
});

test('rollback-to-first : idempotent — ignore un joueur déjà rollback', async () => {
  const e1 = new Date('2026-07-01T10:00:00Z');
  const e2 = new Date('2026-07-04T10:00:00Z');
  prisma.tokenTransaction.findMany = async ({ where }) => {
    if (where?.reason === 'gacha_reset_compensation') {
      return [
        { userId: 'u1', amount: 4000, reason: 'gacha_reset_compensation', createdAt: e1 },
        { userId: 'u1', amount: 20000, reason: 'gacha_reset_compensation', createdAt: e2 },
      ];
    }
    return [];
  };
  prisma.tokenTransaction.findFirst = async ({ where }) => (where.reason === 'gacha_reset_rollback' ? { id: 1 } : null);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };

  const res = await app.request('/api/admin/reset-gacha/rollback-to-first', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'ROLLBACK_TO_FIRST' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersAffected, 1);
  assert.equal(res.json.results[0].skipped, true);
  assert.equal(userUpdates.length, 0);
});

// ── Correction finale calculée depuis zéro (pas d'hypothèse sur des
// "évènements" ni sur "le 1er remboursement est le bon") — remplace les 2
// approches précédentes, qui se sont avérées fausses en pratique : le total
// remboursé doit juste égaler la dépense pack_open réelle + le bonus
// forfaitaire, point final. ──
test('recompute-final : refuse un utilisateur non-admin', async () => {
  const res = await app.request('/api/admin/reset-gacha/recompute-final', {
    method: 'POST', cookie: app.authCookie(PLAIN.id), body: { confirm: 'RECOMPUTE_FINAL' },
  });
  assert.equal(res.status, 403);
});

test('recompute-final : refuse sans la confirmation exacte', async () => {
  const res = await app.request('/api/admin/reset-gacha/recompute-final', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: {},
  });
  assert.equal(res.status, 400);
});

test('recompute-final : cas réel Dova — sous-remboursé après le rollback, complète la différence', async () => {
  // Dépense réelle à vie : 31800. Net actuel des transactions liées au reset
  // (compensation 78900 + bonus 500 + correction -30600 + rollback -33000) : 15800.
  // Correct = 31800 + 500 = 32300. Diff = 32300 - 15800 = 16500 (à AJOUTER).
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    if (where.reason === 'pack_open') return [{ userId: 'dova1', _sum: { amount: -31800 } }];
    if (where.reason?.in) return [{ userId: 'dova1', _sum: { amount: 15800 } }];
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null; // pas encore appliqué
  prisma.user.findUnique = async ({ where }) => (where.id === 'dova1' ? { tokens: 506 } : ADMIN);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  const txCreated = [];
  prisma.tokenTransaction.create = async ({ data }) => { txCreated.push(data); return data; };

  const res = await app.request('/api/admin/reset-gacha/recompute-final', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RECOMPUTE_FINAL' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersAffected, 1);
  const fix = res.json.corrections[0];
  assert.equal(fix.userId, 'dova1');
  assert.equal(fix.spent, 31800);
  assert.equal(fix.correctGachaNet, 32300);
  assert.equal(fix.currentGachaNet, 15800);
  assert.equal(fix.diff, 16500);
  assert.equal(fix.applied, 16500);
  assert.deepEqual(userUpdates.find((u) => u.id === 'dova1').data.tokens, { increment: 16500 });
  const correction = txCreated.find((t) => t.reason === 'gacha_reset_final_correction');
  assert.equal(correction.amount, 16500);
});

test('recompute-final : un joueur qui n\'a jamais tiré ne doit recevoir QUE le bonus (500), pas plus', async () => {
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    if (where.reason === 'pack_open') return []; // jamais tiré
    if (where.reason?.in) return [{ userId: 'gebaie1', _sum: { amount: 0 } }]; // tout a été annulé par le rollback
    return [];
  };
  prisma.tokenTransaction.findFirst = async () => null;
  prisma.user.findUnique = async ({ where }) => (where.id === 'gebaie1' ? { tokens: 0 } : ADMIN);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };
  prisma.tokenTransaction.create = async ({ data }) => data;

  const res = await app.request('/api/admin/reset-gacha/recompute-final', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RECOMPUTE_FINAL' },
  });
  assert.equal(res.status, 200);
  const fix = res.json.corrections[0];
  assert.equal(fix.userId, 'gebaie1');
  assert.equal(fix.spent, 0);
  assert.equal(fix.correctGachaNet, 500); // bonus seul, pas de remboursement de tirages
  assert.equal(fix.applied, 500);
});

test('recompute-final : ne retire jamais sous 0 et est idempotent (déjà appliqué → ignoré)', async () => {
  prisma.tokenTransaction.groupBy = async ({ where }) => {
    if (where.reason === 'pack_open') return [{ userId: 'u1', _sum: { amount: -1000 } }];
    if (where.reason?.in) return [{ userId: 'u1', _sum: { amount: 999999 } }]; // trop-perçu énorme
    return [];
  };
  // Déjà corrigé une fois → ignoré, quel que soit le diff recalculé.
  prisma.tokenTransaction.findFirst = async ({ where }) => (where.reason === 'gacha_reset_final_correction' ? { id: 1 } : null);
  const userUpdates = [];
  prisma.user.update = async ({ where, data }) => { userUpdates.push({ id: where.id, data }); return {}; };

  const res = await app.request('/api/admin/reset-gacha/recompute-final', {
    method: 'POST', cookie: app.authCookie(ADMIN.id), body: { confirm: 'RECOMPUTE_FINAL' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.usersAffected, 0);
  assert.equal(userUpdates.length, 0);
});

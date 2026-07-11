// Tests de routes : /api/idle (Dojo idle/clicker) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const idleRoutes = require('../src/idle/idle.routes');
const {
  slotUpgradeCost, prodUpgradeCost, clickUpgradeCost, charLevelUpCost, dojoXpForLevel,
  milestoneTierForLevel, milestoneReward, PRESTIGE_MIN_DOJO_LEVEL,
  START_SLOTS, MAX_SLOTS,
} = require('../src/idle/idle');

// Les routes /api/idle sont réservées aux admins pendant la phase de test
// (voir requireAdmin dans idle.routes.js) — email admin par défaut.
function dbUser(over = {}) {
  return {
    id: 'u1', email: 'melfisk6@gmail.com', essence: 0, idleLastCollectAt: new Date(), idleSlotsUnlocked: START_SLOTS,
    idleProdLevel: 0, idleClickLevel: 0, essenceEarnedTotal: 0, idleMilestoneClaimed: 0, prestigeLevel: 0, ...over,
  };
}

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/idle', idleRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.idleSlot.findMany = async () => [];
  prisma.userCard.findMany = async () => [];
});

test('GET /state : refusé (403) pour un joueur non-admin — Dojo en phase de test', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com' });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 403);
});

test('GET /state : joueur neuf → 3 emplacements libres, le reste verrouillé avec un coût', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.essence, 0);
  assert.equal(res.json.pendingEssence, 0);
  assert.equal(res.json.slots.length, MAX_SLOTS);
  const unlocked = res.json.slots.filter((s) => !s.locked);
  assert.equal(unlocked.length, START_SLOTS);
  unlocked.forEach((s) => assert.equal(s.character, null));
  const locked = res.json.slots.find((s) => s.locked);
  assert.equal(locked.unlockCost, slotUpgradeCost(locked.index));
});

test('GET /state : la production hors-ligne est plafonnée et reflétée dans pendingEssence', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: twoHoursAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, characterId: 42, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  prisma.userCard.findMany = async () => [{ characterId: 42, stars: 1 }];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.ok(res.json.totalRate > 0);
  assert.ok(res.json.pendingEssence > 0);
  assert.equal(res.json.slots[0].character.rarity, 'mythic');
});

test("GET /state : un personnage échangé/vendu/fusionné pendant qu'il était assigné ne produit plus rien et s'affiche vide", async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: twoHoursAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, characterId: 42, level: 3, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  // Le personnage n'a plus de ligne UserCard (dernier exemplaire perdu) : la
  // ligne IdleSlot le référence encore, mais starsMap ne le contient plus.
  prisma.userCard.findMany = async () => [];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.totalRate, 0);
  assert.equal(res.json.pendingEssence, 0);
  assert.equal(res.json.slots[0].character, null);
});

test('collect : nettoie automatiquement en base un emplacement dont le personnage n\'est plus possédé', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, characterId: 42, level: 3, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  prisma.userCard.findMany = async () => [];
  prisma.user.update = async () => user;
  let cleared = null;
  prisma.idleSlot.updateMany = async (args) => { cleared = args; return { count: 1 }; };
  const res = await app.request('/api/idle/collect', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.ok(cleared);
  assert.deepEqual(cleared.where.slotIndex.in, [0]);
  assert.equal(cleared.data.characterId, null);
  assert.equal(cleared.data.level, 1);
});

test('GET /state : le niveau du Dojo dérive de essenceEarnedTotal, décor + XP cohérents', async () => {
  const user = dbUser({ essenceEarnedTotal: dojoXpForLevel(10) });
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.level, 10);
  assert.equal(res.json.dojo.xpIntoLevel, 0);
  assert.ok(res.json.dojo.decor && res.json.dojo.decor.theme);
  assert.ok(res.json.dojo.multiplier > 1);
});

test('slot-level : refuse un emplacement vide, sinon débite selon charLevelUpCost et incrémente le niveau', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.idleSlot.findUnique = async () => null;
  const emptyRes = await app.request('/api/idle/slot-level', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(emptyRes.status, 400);
  assert.match(emptyRes.json.error, /vide/);

  const cost = charLevelUpCost('rare', 1);
  const rich = dbUser({ essence: cost });
  prisma.user.findUnique = async () => rich;
  prisma.user.update = async () => rich;
  prisma.idleSlot.findUnique = async () => ({ id: 9, userId: 'u1', slotIndex: 0, characterId: 7, level: 1, character: { rarity: 'rare' } });
  const writes = [];
  prisma.idleSlot.update = async (args) => { writes.push(args); return {}; };
  const okRes = await app.request('/api/idle/slot-level', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(okRes.status, 200);
  assert.equal(writes[0].where.id, 9);
  assert.equal(writes[0].data.level.increment, 1);
});

test('assign : refuse un emplacement verrouillé', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: START_SLOTS, characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /verrouillé/);
});

test("assign : refuse un personnage non possédé", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.userCard.findUnique = async () => null;
  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /possèdes pas/);
});

test('assign : succès → déplace le personnage hors de son ancien emplacement puis l\'assigne', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.userCard.findUnique = async () => ({ userId: 'u1', characterId: 7, copies: 1, stars: 2 });
  const writes = [];
  prisma.idleSlot.updateMany = async (args) => { writes.push(['updateMany', args]); return { count: 1 }; };
  prisma.idleSlot.upsert = async (args) => { writes.push(['upsert', args]); return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 1, characterId: 7 },
  });
  assert.equal(res.status, 200);
  assert.equal(writes[0][0], 'updateMany');
  assert.equal(writes[0][1].where.characterId, 7);
  assert.equal(writes[0][1].where.slotIndex.not, 1);
  assert.equal(writes[1][0], 'upsert');
  assert.equal(writes[1][1].create.characterId, 7);
  assert.equal(writes[1][1].create.slotIndex, 1);
});

test('unassign : vide un emplacement', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  let cleared = null;
  prisma.idleSlot.updateMany = async (args) => { cleared = args; return { count: 1 }; };
  const res = await app.request('/api/idle/unassign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0 },
  });
  assert.equal(res.status, 200);
  assert.equal(cleared.where.slotIndex, 0);
  assert.equal(cleared.data.characterId, null);
});

test('upgrade prod : refuse si essence insuffisante, sinon débite et incrémente le niveau', async () => {
  const cost = prodUpgradeCost(0);
  const poor = dbUser({ essence: cost - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.user.update = async () => poor;
  const poorRes = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'prod' },
  });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisante/);

  const rich = dbUser({ essence: cost });
  prisma.user.findUnique = async () => rich;
  let updateData = null;
  prisma.user.update = async (args) => {
    if (args.data.idleProdLevel) updateData = args.data;
    return { ...rich, ...(args.data.essence ? { essence: rich.essence } : {}) };
  };
  const okRes = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'prod' },
  });
  assert.equal(okRes.status, 200);
  assert.equal(updateData.essence.decrement, cost);
  assert.equal(updateData.idleProdLevel.increment, 1);
});

test('upgrade slot : refuse une fois tous les emplacements débloqués', async () => {
  const user = dbUser({ idleSlotsUnlocked: MAX_SLOTS, essence: 999999 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'slot' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /débloqués/);
});

test('upgrade click : coût suit clickUpgradeCost', async () => {
  const cost = clickUpgradeCost(0);
  const user = dbUser({ essence: cost });
  prisma.user.findUnique = async () => user;
  let updateData = null;
  prisma.user.update = async (args) => {
    if (args.data.idleClickLevel) updateData = args.data;
    return user;
  };
  const res = await app.request('/api/idle/upgrade', {
    method: 'POST', cookie: app.authCookie('u1'), body: { type: 'click' },
  });
  assert.equal(res.status, 200);
  assert.equal(updateData.essence.decrement, cost);
});

test('collect : crédite la production en attente et avance idleLastCollectAt', async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: anHourAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, characterId: 5, character: { id: 5, name: 'X', imageUrl: null, rarity: 'rare' } },
  ];
  prisma.userCard.findMany = async () => [{ characterId: 5, stars: 1 }];
  let increment = null;
  prisma.user.update = async (args) => {
    if (args.data.essence) increment = args.data.essence.increment;
    return { ...user, essence: user.essence + (increment || 0) };
  };
  const res = await app.request('/api/idle/collect', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.ok(increment > 0);
});

test('click : ajoute le gain instantané, indépendant des emplacements', async () => {
  const user = dbUser({ idleClickLevel: 3 });
  prisma.user.findUnique = async () => user;
  let gainApplied = null;
  prisma.user.update = async (args) => {
    gainApplied = args.data.essence.increment;
    return { essence: user.essence + gainApplied };
  };
  const res = await app.request('/api/idle/click', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.gained, gainApplied);
  assert.ok(res.json.gained > 0);
});

test('claim-milestone : refuse si rien à réclamer, sinon crédite la récompense et avance idleMilestoneClaimed', async () => {
  const noneYet = dbUser({ essenceEarnedTotal: 0 }); // niveau 1, aucun palier atteint
  prisma.user.findUnique = async () => noneYet;
  prisma.user.update = async () => noneYet;
  const refusedRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(refusedRes.status, 400);
  assert.match(refusedRes.json.error, /coffre/);

  const dojoLevel5 = dojoXpForLevel(5); // MILESTONE_INTERVAL = 5 → 1er palier atteint pile au niveau 5
  const tier = milestoneTierForLevel(5);
  const eligible = dbUser({ essenceEarnedTotal: dojoLevel5 });
  prisma.user.findUnique = async () => eligible;
  let updateData = null;
  prisma.user.update = async (args) => { updateData = args.data; return eligible; };
  const okRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(updateData.essence.increment, milestoneReward(tier));
  assert.equal(updateData.idleMilestoneClaimed, tier);
});

test('claim-milestone : un palier déjà réclamé ne peut pas l\'être une seconde fois', async () => {
  const dojoLevel5 = dojoXpForLevel(5);
  const tier = milestoneTierForLevel(5);
  const already = dbUser({ essenceEarnedTotal: dojoLevel5, idleMilestoneClaimed: tier });
  prisma.user.findUnique = async () => already;
  prisma.user.update = async () => already;
  const res = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 400);
});

test('prestige : refuse sous le niveau minimum, sinon reset la run (essence/emplacements/améliorations) et incrémente prestigeLevel', async () => {
  const tooLow = dbUser({ essenceEarnedTotal: 0 });
  prisma.user.findUnique = async () => tooLow;
  prisma.user.update = async () => tooLow;
  const lowRes = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(lowRes.status, 400);

  const xpAtMin = dojoXpForLevel(PRESTIGE_MIN_DOJO_LEVEL);
  const eligible = dbUser({
    essenceEarnedTotal: xpAtMin, essence: 5000, idleProdLevel: 10, idleClickLevel: 5, idleSlotsUnlocked: 8, prestigeLevel: 1,
  });
  prisma.user.findUnique = async () => eligible;
  let slotsReset = null;
  let userUpdate = null;
  prisma.idleSlot.updateMany = async (args) => { slotsReset = args; return { count: 3 }; };
  prisma.user.update = async (args) => { userUpdate = args.data; return eligible; };
  const okRes = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(slotsReset.where.userId, 'u1');
  assert.equal(slotsReset.data.characterId, null);
  assert.equal(slotsReset.data.level, 1);
  assert.equal(userUpdate.essence, 0);
  assert.equal(userUpdate.idleSlotsUnlocked, START_SLOTS);
  assert.equal(userUpdate.idleProdLevel, 0);
  assert.equal(userUpdate.idleClickLevel, 0);
  assert.equal(userUpdate.prestigeLevel.increment, 1);
  assert.equal(userUpdate.essenceEarnedTotal, undefined); // le niveau du Dojo (le lieu) n'est jamais reset
});

test("prestige : solde la production en attente AVANT le reset — elle compte dans l'XP du Dojo au lieu d'être perdue", async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const xpAtMin = dojoXpForLevel(PRESTIGE_MIN_DOJO_LEVEL);
  const eligible = dbUser({ essenceEarnedTotal: xpAtMin, idleLastCollectAt: anHourAgo });
  prisma.user.findUnique = async () => eligible;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, characterId: 42, level: 1, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  prisma.userCard.findMany = async () => [{ characterId: 42, stars: 1 }];
  prisma.idleSlot.updateMany = async () => ({ count: 1 });
  const updateCalls = [];
  prisma.user.update = async (args) => { updateCalls.push(args.data); return eligible; };
  const res = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  // 1er appel = solde de la production en attente (avant le reset) : doit créditer essenceEarnedTotal.
  assert.ok(updateCalls[0].essenceEarnedTotal.increment > 0);
  // 2e appel = le reset lui-même : ne touche jamais essenceEarnedTotal.
  assert.equal(updateCalls[1].essenceEarnedTotal, undefined);
  assert.equal(updateCalls[1].essence, 0);
});

// Tests de routes : /api/idle (Dojo idle/clicker) — sans BDD.
// Le Dojo est indépendant du gacha : aucun test ici ne touche UserCard,
// CardInstance ou les tokens — seul DojoRecruit fait foi de la possession.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const idleRoutes = require('../src/idle/idle.routes');
const {
  slotUpgradeCost, prodUpgradeCost, clickUpgradeCost, charLevelUpCost, dojoXpForLevel,
  milestoneTierForLevel, milestoneReward, PRESTIGE_MIN_DOJO_LEVEL, wisdomForPrestige,
  ANCIENTS, ancientCost, recruitCost, START_SLOTS, MAX_SLOTS, DOJO_DECOR,
} = require('../src/idle/idle');

// Les routes /api/idle sont réservées aux admins pendant la phase de test
// (voir requireAdmin dans idle.routes.js) — email admin par défaut.
function dbUser(over = {}) {
  return {
    id: 'u1', email: 'melfisk6@gmail.com', essence: 0, idleLastCollectAt: new Date(), idleSlotsUnlocked: START_SLOTS,
    idleProdLevel: 0, idleClickLevel: 0, essenceEarnedTotal: 0, idleMilestoneClaimed: 0, prestigeLevel: 0,
    wisdomPoints: 0, ...over,
  };
}

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/idle', idleRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.idleSlot.findMany = async () => [];
  prisma.dojoRecruit.count = async () => 0;
  // buildState()/withSettle() appellent systématiquement decorArtForTheme()
  // et loadAncientLevels() : sans stub par défaut, tous les tests existants
  // (qui ne testent ni l'habillage visuel ni les Ancients) planteraient sur
  // "non stubbé". Le cache mémoire du module doit aussi être vidé, sinon un
  // test pollue le suivant.
  prisma.character.findMany = async () => [];
  prisma.song.findFirst = async () => null;
  prisma.ancientLevel.findMany = async () => [];
  prisma.dojoBossArt.findUnique = async () => null;
  idleRoutes.decorArtCache.clear();
});

test('GET /state : refusé (403) pour un joueur non-admin — Dojo en phase de test', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com' });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 403);
});

test('GET /state : joueur neuf → 3 emplacements libres, le reste verrouillé avec un coût, recrutement à son 1er coût', async () => {
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
  assert.equal(res.json.recruit.count, 0);
  assert.equal(res.json.recruit.nextCost, recruitCost(0));
  assert.equal(res.json.battle.stage, 1);
  assert.equal(res.json.battle.kills, 0); // stage 1 = aucun kill encore
  assert.equal(res.json.battle.xpIntoStage, 0);
  assert.equal(res.json.dojo.tiers.length, DOJO_DECOR.length);
  assert.deepEqual(res.json.dojo.tiers[0], { level: DOJO_DECOR[0].level, name: DOJO_DECOR[0].name, theme: DOJO_DECOR[0].theme });
  assert.equal(res.json.ancients.points, 0);
  assert.equal(res.json.ancients.items.length, ANCIENTS.length);
  res.json.ancients.items.forEach((it) => {
    assert.equal(it.level, 0); // rien acheté par défaut
    assert.equal(it.cost, ancientCost(0));
  });
});

test('GET /state : reflète les niveaux d\'Ancients déjà achetés (bonus appliqués, coût du niveau suivant)', async () => {
  const key = ANCIENTS[0].key;
  const user = dbUser({ wisdomPoints: 7 });
  prisma.user.findUnique = async () => user;
  prisma.ancientLevel.findMany = async () => [{ ancientKey: key, level: 3 }];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.ancients.points, 7);
  const item = res.json.ancients.items.find((it) => it.key === key);
  assert.equal(item.level, 3);
  assert.equal(item.cost, ancientCost(3));
  // Discipline Éternelle (prodMult) : le bonus doit se refléter dans le
  // multiplicateur de production affiché.
  if (ANCIENTS[0].kind === 'prodMult') {
    assert.ok(res.json.prod.multiplier > 1);
  }
});

test('GET /state : le stage de combat avance BEAUCOUP plus vite que le niveau de Dojo, à essence égale', async () => {
  // Assez d'essence gagnée pour plusieurs stages, mais pas de quoi bouger le
  // niveau du Dojo (courbe bien plus raide) — prouve le découplage voulu :
  // le combat doit rester vivant même quand le Dojo (décor) n'a pas bougé.
  const user = dbUser({ essenceEarnedTotal: 40 });
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.level, 1);
  assert.ok(res.json.battle.stage > 1);
  assert.equal(res.json.battle.kills, res.json.battle.stage - 1);
});

test('GET /state : la production hors-ligne est plafonnée et reflétée dans pendingEssence', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const user = dbUser({ idleLastCollectAt: twoHoursAgo });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 42, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.ok(res.json.totalRate > 0);
  assert.ok(res.json.pendingEssence > 0);
  assert.equal(res.json.slots[0].character.rarity, 'mythic');
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

test("GET /state : le décor porte un gardien mythique réel + le fond de son anime quand disponibles", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 101, name: 'Sans imageUrl (à ignorer)', imageUrl: null, seriesId: 1 },
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: 42 },
  ];
  prisma.song.findFirst = async ({ where }) => (where.anilistId === 42 ? { coverUrl: 'https://cdn.example/media/anime/cover/medium/bx42.jpg' } : null);
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.name, 'Yamato');
  assert.equal(res.json.dojo.decor.boss.imageUrl, 'https://cdn.example/yamato.jpg');
  // La jaquette stockée est la vignette /medium/ (~100 px) : trop petite pour
  // la scène, l'URL doit être réécrite vers /large/ (même image, CDN AniList).
  assert.equal(res.json.dojo.decor.backgroundUrl, 'https://cdn.example/media/anime/cover/large/bx42.jpg');
});

test("GET /state : le portrait IA généré (DojoBossArt) prime sur le portrait AniList quand il existe", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: null },
  ];
  prisma.dojoBossArt.findUnique = async ({ where }) => (
    where.characterId_theme.characterId === 102
      ? { imageUrl: 'https://r2.example/dojo-boss-art/wood-102.png' }
      : null
  );
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.imageUrl, 'https://cdn.example/yamato.jpg'); // portrait AniList inchangé
  assert.equal(res.json.dojo.decor.boss.generatedImageUrl, 'https://r2.example/dojo-boss-art/wood-102.png');
});

test('GET /state : sans portrait IA généré, generatedImageUrl reste null (repli sur le portrait AniList)', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [
    { id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/yamato.jpg', seriesId: null },
  ];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss.generatedImageUrl, null);
});

test('GET /state : sans mythique en base (ou sans portrait), le décor reste utilisable sans gardien', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.character.findMany = async () => [{ id: 101, name: 'Sans imageUrl', imageUrl: null, seriesId: 1 }];
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.decor.boss, null);
  assert.equal(res.json.dojo.decor.backgroundUrl, null);
});

test('GET /state : le gardien du décor est mis en cache (pas de re-requête tant que le thème ne change pas)', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  let calls = 0;
  prisma.character.findMany = async () => { calls++; return [{ id: 102, name: 'Yamato', imageUrl: 'https://cdn.example/y.jpg', seriesId: null }]; };
  await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(calls, 1);
});

test('GET /roster : liste les personnages recrutés (pas la collection gacha)', async () => {
  prisma.dojoRecruit.findMany = async () => [
    { characterId: 3, recruitedAt: new Date(), character: { id: 3, name: 'Roy', imageUrl: null, rarity: 'epic' } },
  ];
  const res = await app.request('/api/idle/roster', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.recruits.length, 1);
  assert.equal(res.json.recruits[0].name, 'Roy');
});

test('recruit : refuse si essence insuffisante, sinon débite selon recruitCost et crée une ligne DojoRecruit', async () => {
  const cost = recruitCost(0);
  const poor = dbUser({ essence: cost - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.user.update = async () => poor;
  const poorRes = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisante/);

  const rich = dbUser({ essence: cost });
  prisma.user.findUnique = async () => rich;
  prisma.user.update = async () => rich;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.character.findMany = async () => [{ id: 5, name: 'Nouvelle Recrue', imageUrl: null, rarity: 'common' }];
  let created = null;
  prisma.dojoRecruit.create = async (args) => { created = args.data; return args.data; };
  const okRes = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(created.userId, 'u1');
  assert.equal(created.characterId, 5);
  assert.equal(okRes.json.recruited.name, 'Nouvelle Recrue');
});

test('recruit : exclut les personnages déjà recrutés et retombe sur une autre rareté si celle tirée est épuisée', async () => {
  const user = dbUser({ essence: recruitCost(0) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [{ characterId: 1 }]; // déjà tout recruté dans la rareté tirée
  // Le mock répond systématiquement vide pour la rareté tirée en 1er, mais
  // renvoie un candidat pour n'importe quelle autre — vérifie juste que la
  // route ne plante pas et retombe bien sur un résultat non vide.
  let firstCall = true;
  prisma.character.findMany = async ({ where }) => {
    if (firstCall) { firstCall = false; return []; }
    return where.rarity === 'rare' ? [{ id: 9, name: 'Repli', imageUrl: null, rarity: 'rare' }] : [];
  };
  let created = null;
  prisma.dojoRecruit.create = async (args) => { created = args.data; return args.data; };
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(created.characterId, 9);
});

test('recruit : refuse proprement si tout le pool est déjà recruté', async () => {
  const user = dbUser({ essence: recruitCost(0) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [{ characterId: 1 }];
  prisma.character.findMany = async () => [];
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /roster disponible/);
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

test('assign : refuse un personnage non recruté', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => null;
  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 1 },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /recruté/);
});

test('assign : succès → déplace le personnage hors de son ancien emplacement puis l\'assigne', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 7 });
  prisma.idleSlot.findUnique = async () => null; // emplacement vide avant l'assignation
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

test("assign : remplacer un AUTRE personnage sur un emplacement déjà occupé remet le niveau à 1 (sinon héritage gratuit de puissance)", async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 9 });
  prisma.idleSlot.findUnique = async () => ({ id: 5, userId: 'u1', slotIndex: 0, characterId: 3, level: 50 }); // occupant précédent, niveau 50
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  let upsertArgs = null;
  prisma.idleSlot.upsert = async (args) => { upsertArgs = args; return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 9 },
  });
  assert.equal(res.status, 200);
  assert.equal(upsertArgs.update.level, 1);
});

test('assign : réassigner le MÊME personnage déjà en place (clic redondant) ne touche pas son niveau', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 3 });
  prisma.idleSlot.findUnique = async () => ({ id: 5, userId: 'u1', slotIndex: 0, characterId: 3, level: 50 });
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  let upsertArgs = null;
  prisma.idleSlot.upsert = async (args) => { upsertArgs = args; return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 3 },
  });
  assert.equal(res.status, 200);
  assert.equal(upsertArgs.update.level, undefined);
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
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 5, character: { id: 5, name: 'X', imageUrl: null, rarity: 'rare' } },
  ];
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

test('prestige : refuse sous le niveau minimum, sinon reset la run (essence/emplacements/améliorations), incrémente prestigeLevel et crédite la Sagesse', async () => {
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
  // Plus de multiplicateur automatique : la Sagesse gagnée dépend du niveau
  // du Dojo AU MOMENT du Prestige, à dépenser ensuite dans les Ancients.
  assert.equal(userUpdate.wisdomPoints.increment, wisdomForPrestige(PRESTIGE_MIN_DOJO_LEVEL));
});

test("prestige : solde la production en attente AVANT le reset — elle compte dans l'XP du Dojo au lieu d'être perdue", async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const xpAtMin = dojoXpForLevel(PRESTIGE_MIN_DOJO_LEVEL);
  const eligible = dbUser({ essenceEarnedTotal: xpAtMin, idleLastCollectAt: anHourAgo });
  prisma.user.findUnique = async () => eligible;
  prisma.idleSlot.findMany = async () => [
    { id: 1, userId: 'u1', slotIndex: 0, level: 1, characterId: 42, character: { id: 42, name: 'Mika', imageUrl: null, rarity: 'mythic' } },
  ];
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

test('ancient : refuse une clé inconnue', async () => {
  const res = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key: 'inexistant' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invalide/);
});

test('ancient : refuse si Sagesse insuffisante, sinon débite selon ancientCost et crée/incrémente AncientLevel', async () => {
  const key = ANCIENTS[0].key;
  const poor = dbUser({ wisdomPoints: ancientCost(0) - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.ancientLevel.findUnique = async () => null; // jamais acheté → niveau 0
  const poorRes = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisante/);

  const rich = dbUser({ wisdomPoints: ancientCost(0) });
  prisma.user.findUnique = async () => rich;
  prisma.ancientLevel.findUnique = async () => null;
  let userDecrement = null;
  let upsertArgs = null;
  prisma.user.update = async (args) => { userDecrement = args.data.wisdomPoints.decrement; return rich; };
  prisma.ancientLevel.upsert = async (args) => { upsertArgs = args; return {}; };
  const okRes = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(okRes.status, 200);
  assert.equal(userDecrement, ancientCost(0));
  assert.equal(upsertArgs.create.ancientKey, key);
  assert.equal(upsertArgs.create.level, 1);
  assert.equal(upsertArgs.update.level.increment, 1);
});

test('ancient : le coût du niveau suivant suit ancientCost(niveau actuel), pas ancientCost(0)', async () => {
  const key = ANCIENTS[0].key;
  const user = dbUser({ wisdomPoints: ancientCost(4) });
  prisma.user.findUnique = async () => user;
  prisma.ancientLevel.findUnique = async () => ({ level: 4 });
  let userDecrement = null;
  prisma.user.update = async (args) => { userDecrement = args.data.wisdomPoints.decrement; return user; };
  prisma.ancientLevel.upsert = async () => ({});
  const res = await app.request('/api/idle/ancient', {
    method: 'POST', cookie: app.authCookie('u1'), body: { key },
  });
  assert.equal(res.status, 200);
  assert.equal(userDecrement, ancientCost(4));
});

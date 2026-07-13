// Tests de routes : /api/idle (Dojo idle/clicker) — sans BDD.
// Le roster du Dojo reste indépendant du gacha. Les Golds peuvent uniquement
// servir d'alternative de paiement lors d'une invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const idleRoutes = require('../src/idle/idle.routes');
const { idleMissionList,seasonActivityScore,weeklyConvergence,bossChestRewards,progressionBossesCrossed,SEASON_TIERS,idleItemDrop,itemProductionBonus,equipmentSetMultiplier,itemSalvageValue }=idleRoutes;
const {
  slotUpgradeCost, prodUpgradeCost, clickUpgradeCost, charLevelUpCost,
  milestoneTierForLevel, milestoneReward, PRESTIGE_MIN_STAGE, wisdomForRunStage, enemyMaxHp,
  ANCIENTS, ancientCost, recruitCost, recruitGoldCost, START_SLOTS, MAX_SLOTS, DOJO_DECOR,
} = require('../src/idle/idle');

// Les routes /api/idle sont réservées aux admins pendant la phase de test
// (voir requireAdmin dans idle.routes.js) — email admin par défaut.
function dbUser(over = {}) {
  return {
    id: 'u1', email: 'melfisk6@gmail.com', essence: 0, idleLastCollectAt: new Date(), idleSlotsUnlocked: START_SLOTS,
    idleProdLevel: 0, idleClickLevel: 0, essenceEarnedTotal: 0, idleRunEssenceEarned:0,
    idleRankLevel:1,idleRankKills:0,idleRankClicks:0,idleRankUpgrades:0,idleRankBosses:0,idleRankStartedAt:new Date(),
    idleStage:1,idleRunBestStage:1,idleBestStage:1,idleEnemyHp:enemyMaxHp(1),idleMilestoneClaimed: 0, idleRecruitPity: 0, idleOnboardingComplete: true, prestigeLevel: 0,
    wisdomPoints: 0,idleSeals:2,tokens:100,idleBossProgress:0,idleBossStartedAt:null,idleBestBossMs:null,idleFormation:'balanced',idlePrestigePath:'balanced',idlePrestigeMilestone:0,idleBurstReadyAt:null,idleTeamReadyAt:null, ...over,
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
  prisma.dojoRecruit.update = async () => ({});
  prisma.dojoRecruit.updateMany = async () => ({count:0});
  // buildState()/withSettle() appellent systématiquement decorArtForTheme()
  // et loadAncientLevels() : sans stub par défaut, tous les tests existants
  // (qui ne testent ni l'habillage visuel ni les Ancients) planteraient sur
  // "non stubbé". Le cache mémoire du module doit aussi être vidé, sinon un
  // test pollue le suivant.
  prisma.character.findMany = async () => [];
  prisma.song.findFirst = async () => null;
  prisma.ancientLevel.findMany = async () => [];
  prisma.dojoBossArt.findUnique = async () => null;
  prisma.idleTeamPreset.findMany = async () => [];
  prisma.idleProgressCounter.findMany = async () => [];
  prisma.idleProgressCounter.upsert = async () => ({});
  prisma.idleItem.findMany = async () => [];
  idleRoutes.decorArtCache.clear();
});

test('difficulté longue durée : missions tournantes et hebdomadaires renforcées', () => {
  const missions=idleMissionList({},0,0,1,new Map());
  assert.equal(missions.filter((m)=>m.cadence==='Quotidienne').length,3);
  assert.equal(missions.filter((m)=>m.cadence==='Hebdomadaire').length,4);
  assert.ok(missions.filter((m)=>m.cadence==='Hebdomadaire').every((m)=>m.target>=30));
});

test('saison : huit paliers et aucune action unique ne termine le parcours', () => {
  const period='2026-07';
  const killsOnly=seasonActivityScore(new Map([[`kill:${period}`,999999]]),period);
  assert.equal(SEASON_TIERS.length,8);
  assert.ok(killsOnly.score<SEASON_TIERS.at(-1).level);
  assert.equal(killsOnly.breakdown.find((x)=>x.key==='kill').value,5000);
});

test('défi hebdomadaire : toutes les familles d actions sont obligatoires', () => {
  const periods={week:'2026-07-13'};
  const partial=weeklyConvergence(new Map([[`kill:${periods.week}`,99999]]),periods);
  assert.equal(partial.completed,false);
  const full=new Map([['kill',1500],['click',1000],['skill',40],['upgrade',100]].map(([key,value])=>[`${key}:${periods.week}`,value]));
  assert.equal(weeklyConvergence(full,periods).completed,true);
});

test('coffres : les paliers majeurs ajoutent Golds et rareté garantie', () => {
  assert.equal(bossChestRewards(5).lootRarity,'legendary');
  assert.ok(bossChestRewards(5).goldReward>0);
  assert.equal(bossChestRewards(10).lootRarity,'mythic');
});

test('les gardiens sont comptés uniquement lors dune nouvelle progression', () => {
  assert.equal(progressionBossesCrossed(9,31,'progress'),3);
  assert.equal(progressionBossesCrossed(10,10,'farm'),0);
});

test('inventaire : chaque type possède un effet utile et une valeur de recyclage',()=>{
  const weapon=idleItemDrop(5,'weapon','legendary',.11,'Hueco Mundo');const accessory=idleItemDrop(5,'accessory','legendary',.11,'Hueco Mundo');
  assert.equal(weapon.effectKey,'assault');assert.ok(itemProductionBonus(weapon)>.11);
  assert.equal(accessory.effectKey,'salvage');assert.ok(itemSalvageValue(accessory)>25);
});

test('inventaire : une panoplie des trois types accorde le bonus complet',()=>{
  assert.equal(equipmentSetMultiplier([{kind:'weapon'},{kind:'relic'}]),1);
  assert.equal(equipmentSetMultiplier([{kind:'weapon',sourceWorld:'A'},{kind:'relic',sourceWorld:'A'},{kind:'accessory',sourceWorld:'A'}]),1.10);
  assert.equal(equipmentSetMultiplier([{kind:'weapon',sourceWorld:'A'},{kind:'relic',sourceWorld:'B'},{kind:'accessory',sourceWorld:'A'}]),1);
});

test('inventaire : le verrouillage vérifie que l objet appartient au joueur',async()=>{
  prisma.user.findUnique=async()=>dbUser();
  prisma.idleItem.findFirst=async({where})=>where.userId==='u1'?{id:'item-1',userId:'u1'}:null;
  let locked=null;prisma.idleItem.update=async({data})=>{locked=data.locked;return{};};
  const res=await app.request('/api/idle/equipment/lock',{method:'POST',cookie:app.authCookie('u1'),body:{itemId:'item-1',locked:true}});
  assert.equal(res.status,200);assert.equal(locked,true);
});

test('GET /state : refusé (403) pour un joueur non-admin — Dojo en phase de test', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com' });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 403);
});

test('GET /state : un joueur portant idle_beta accède au jeu sans être administrateur', async () => {
  prisma.user.findUnique = async () => dbUser({ email: 'joueur@example.com', roles: ['idle_beta'] });
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.battle.stage, 1);
});

test('onboarding : impose un choix initial puis offre et assigne le starter', async () => {
  let user=dbUser({idleOnboardingComplete:false});
  const starter={id:77,name:'Starter',imageUrl:'https://cdn.example/starter.jpg',rarity:'rare',series:'Série'};
  prisma.user.findUnique=async()=>user;
  prisma.character.findMany=async(args)=>args.where?.rarity==='rare'?[starter]:[];
  prisma.character.findFirst=async()=>({id:starter.id});
  let recruitWrite=null,slotWrite=null;
  prisma.dojoRecruit.upsert=async(args)=>{recruitWrite=args;return{};};
  prisma.idleSlot.upsert=async(args)=>{slotWrite=args;return{};};
  prisma.user.update=async({data})=>{user={...user,...data};return user;};

  const before=await app.request('/api/idle/state',{cookie:app.authCookie('u1')});
  assert.equal(before.status,200);
  assert.equal(before.json.onboarding.required,true);
  assert.equal(before.json.onboarding.starters[0].id,starter.id);

  const started=await app.request('/api/idle/onboarding',{method:'POST',cookie:app.authCookie('u1'),body:{classKey:'mage',characterId:starter.id}});
  assert.equal(started.status,200);
  assert.equal(user.idleOnboardingComplete,true);
  assert.equal(user.idleHeroClass,'mage');
  assert.equal(recruitWrite.create.characterId,starter.id);
  assert.equal(slotWrite.create.slotIndex,0);
  assert.equal(slotWrite.create.characterId,starter.id);
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
  assert.equal(res.json.recruit.guaranteedEpicIn, 10);
  assert.equal(res.json.combat.stage, 1);
  assert.equal(res.json.economy.essence, 0);
  assert.equal(res.json.permanentProgress.prestige, 0);
  assert.equal(res.json.click.yield, 5);
  assert.equal(res.json.click.damage, 8); // Guerrier : 5 × 1,5, arrondi
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

test('GET /state : le stage de run est indépendant du niveau permanent du Dojo', async () => {
  const user = dbUser({ essenceEarnedTotal: 40, idleStage:7,idleRunBestStage:7,idleBestStage:7,idleEnemyHp:enemyMaxHp(7) });
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

test('GET /state : le niveau dépend du rang validé et expose sa série d’épreuves', async () => {
  const user = dbUser({ idleRankLevel:10, idleRankKills:60, idleRankClicks:50, idleRankUpgrades:3 });
  prisma.user.findUnique = async () => user;
  const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.dojo.level, 10);
  assert.equal(res.json.rank.level, 10);
  assert.equal(res.json.rank.nextLevel, 11);
  assert.equal(res.json.rank.quests.length, 3);
  assert.equal(res.json.dojo.xpIntoLevel, res.json.rank.completed);
  assert.ok(res.json.dojo.decor && res.json.dojo.decor.theme);
  assert.ok(res.json.dojo.multiplier > 1);
});

test('passage de niveau : refuse une série incomplète puis valide atomiquement la série complète', async () => {
  let user = dbUser({ idleRankLevel:1 });
  prisma.user.findUnique = async () => user;
  let res = await app.request('/api/idle/rank/advance', { method:'POST', cookie:app.authCookie('u1'), body:{} });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /épreuves/);

  user = dbUser({ idleRankLevel:1, idleRankKills:23, idleRankClicks:55, idleRankUpgrades:4, idleSeals:2 });
  prisma.user.updateMany = async ({ where, data }) => {
    assert.equal(where.idleRankLevel, 1);
    user = { ...user, idleRankLevel:2, idleRankKills:0, idleRankClicks:0, idleRankUpgrades:0, idleRankBosses:0, idleSeals:user.idleSeals + data.idleSeals.increment, idleRankStartedAt:data.idleRankStartedAt };
    return { count:1 };
  };
  res = await app.request('/api/idle/rank/advance', { method:'POST', cookie:app.authCookie('u1'), body:{} });
  assert.equal(res.status, 200);
  assert.equal(res.json.level, 2);
  assert.equal(res.json.seals, 1);
  assert.equal(res.json.state.rank.level, 2);
  assert.equal(res.json.state.rank.completed, 0);
  assert.equal(res.json.state.economy.seals, 3);
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

test('recruit : refuse si Sceaux insuffisants, sinon débite selon recruitCost et crée une ligne DojoRecruit', async () => {
  const cost = recruitCost(0);
  const poor = dbUser({ idleSeals: cost - 1 });
  prisma.user.findUnique = async () => poor;
  prisma.user.update = async () => poor;
  const poorRes = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(poorRes.status, 400);
  assert.match(poorRes.json.error, /insuffisants?/);

  const rich = dbUser({ idleSeals: cost });
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

test('recruit : accepte les Golds, débite atomiquement et journalise la dépense', async () => {
  const cost = recruitGoldCost(0);
  let user = dbUser({ idleSeals: 0, tokens: cost });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.character.findMany = async () => [{ id: 6, name: 'Invocation Gold', imageUrl: null, rarity: 'rare' }];
  prisma.dojoRecruit.create = async () => ({});
  let debit = null;
  prisma.user.updateMany = async ({ data }) => {
    debit = data;
    user = { ...user, tokens: user.tokens - cost };
    return { count: 1 };
  };
  let transaction = null;
  prisma.tokenTransaction.create = async ({ data }) => { transaction = data; return data; };

  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: { currency: 'gold' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.payment.currency, 'gold');
  assert.equal(res.json.payment.cost, cost);
  assert.deepEqual(debit.tokens, { decrement: cost });
  assert.deepEqual(transaction, { userId: 'u1', amount: -cost, reason: 'idle_recruit' });
  assert.equal(res.json.recruit.goldBalance, 0);
});

test('recruit : refuse les Golds insuffisants sans consommer de Sceau', async () => {
  const user = dbUser({ idleSeals: 99, tokens: recruitGoldCost(0) - 1 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  const res = await app.request('/api/idle/recruit', { method: 'POST', cookie: app.authCookie('u1'), body: { currency: 'gold' } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Golds insuffisants/);
  assert.equal(user.idleSeals, 99);
});

test('recruit : exclut les personnages déjà recrutés et retombe sur une autre rareté si celle tirée est épuisée', async () => {
  const user = dbUser({ idleSeals: recruitCost(0) });
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
  const user = dbUser({ idleSeals: recruitCost(0) });
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

test('assign : réassigner un personnage restaure son niveau propre', async () => {
  const user = dbUser();
  prisma.user.findUnique = async () => user;
  prisma.user.update = async () => user;
  prisma.dojoRecruit.findUnique = async () => ({ userId: 'u1', characterId: 3,trainingLevel:50,idleAscension:2 });
  prisma.idleSlot.findUnique = async () => ({ id: 5, userId: 'u1', slotIndex: 0, characterId: 3, level: 50 });
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  let upsertArgs = null;
  prisma.idleSlot.upsert = async (args) => { upsertArgs = args; return {}; };

  const res = await app.request('/api/idle/assign', {
    method: 'POST', cookie: app.authCookie('u1'), body: { slotIndex: 0, characterId: 3 },
  });
  assert.equal(res.status, 200);
  assert.equal(upsertArgs.update.level, 50);
  assert.equal(upsertArgs.update.ascension, 2);
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

test('collect : retente proprement si une autre requête a déjà encaissé la même période', async () => {
  const user = dbUser({ idleLastCollectAt: new Date(Date.now() - 1000) });
  prisma.user.findUnique = async () => user;
  let calls = 0;
  prisma.user.update = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('conflit optimiste'), { code: 'P2025' });
    return user;
  };
  const res = await app.request('/api/idle/collect', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('click : inflige des dégâts autoritaires au gardien', async () => {
  let user = dbUser({ idleClickLevel: 3,idleStage:9,idleEnemyHp:enemyMaxHp(9) });
  prisma.user.findUnique = async () => user;
  let damageWrite=null;
  prisma.user.update = async (args) => {
    if(typeof args.data.idleEnemyHp==='number'){
      damageWrite=args.data;
      user={...user,idleEnemyHp:args.data.idleEnemyHp};
    }
    return user;
  };
  const res = await app.request('/api/idle/click', { method: 'POST', cookie: app.authCookie('u1'), body: {requestId:'click-test-0001'} });
  assert.equal(res.status, 200);
  assert.ok(res.json.damage > 0);
  assert.ok(damageWrite&&Number.isFinite(damageWrite.idleEnemyHp));
});

test('click : accepte une cadence de clicker sans 429 immédiat', async () => {
  let user = dbUser({ idleClickLevel: 1, idleStage: 9, idleEnemyHp: enemyMaxHp(9) });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async ({ data }) => {
    if (typeof data.idleEnemyHp === 'number') user = { ...user, idleEnemyHp: data.idleEnemyHp };
    return user;
  };
  for (let i = 0; i < 5; i++) {
    const res = await app.request('/api/idle/click', { method: 'POST', cookie: app.authCookie('u1'), body: {requestId:`click-rate-000${i}`} });
    assert.equal(res.status, 200);
  }
});

test('click : regroupe plusieurs frappes dans une seule requête autoritaire', async () => {
  let user=dbUser({idleClickLevel:2,idleStage:3,idleEnemyHp:enemyMaxHp(3)});
  prisma.user.findUnique=async()=>user;
  prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number')user={...user,idleEnemyHp:data.idleEnemyHp,idleStage:data.idleStage};return user;};
  const res=await app.request('/api/idle/click',{method:'POST',cookie:app.authCookie('u1'),body:{count:5,requestId:'click-batch-0001'}});
  assert.equal(res.status,200);
  assert.equal(res.json.count,5);
  assert.ok(res.json.damage>=5);
});

test('click : rejouer le même requestId ne réapplique jamais les dégâts', async () => {
  let user=dbUser({id:'u-dedup',idleClickLevel:2,idleStage:4,idleEnemyHp:enemyMaxHp(4)});
  prisma.user.findUnique=async()=>user;
  let writes=0;
  prisma.user.update=async({data})=>{if(typeof data.idleEnemyHp==='number'){writes++;user={...user,idleEnemyHp:data.idleEnemyHp,idleStage:data.idleStage||user.idleStage};}return user;};
  const request={method:'POST',cookie:app.authCookie('u-dedup'),body:{count:3,requestId:'click-dedup-0001'}};
  const first=await app.request('/api/idle/click',request);
  const writesAfterFirst=writes;
  const second=await app.request('/api/idle/click',request);
  assert.equal(first.status,200);
  assert.equal(second.status,200);
  assert.equal(second.json.duplicate,true);
  assert.ok(writesAfterFirst>0);
  assert.equal(writes,writesAfterFirst);
});

test('feedback bêta : conserve le message et son contexte', async () => {
  prisma.user.findUnique=async()=>dbUser({roles:['idle_beta']});
  let created=null;
  prisma.idleFeedback.create=async({data})=>{created=data;return{id:1,...data};};
  const res=await app.request('/api/idle/feedback',{method:'POST',cookie:app.authCookie('u1'),body:{message:'Le bouton de boss reste bloqué.',context:'{"stage":20}'}});
  assert.equal(res.status,201);
  assert.equal(created.userId,'u1');
  assert.match(created.message,/boss/);
});

test('claim-milestone : refuse si rien à réclamer, sinon crédite la récompense et avance idleMilestoneClaimed', async () => {
  const noneYet = dbUser({ idleRankLevel:1 }); // niveau 1, aucun palier atteint
  prisma.user.findUnique = async () => noneYet;
  prisma.user.update = async () => noneYet;
  const refusedRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(refusedRes.status, 400);
  assert.match(refusedRes.json.error, /coffre/);

  const tier = milestoneTierForLevel(5);
  const eligible = dbUser({ idleRankLevel:5 });
  prisma.user.findUnique = async () => eligible;
  let updateData = null;
  prisma.user.update = async (args) => { updateData = args.data; return eligible; };
  const okRes = await app.request('/api/idle/claim-milestone', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(okRes.status, 200);
  assert.equal(updateData.essence.increment, milestoneReward(tier));
  assert.equal(updateData.idleMilestoneClaimed, tier);
});

test('claim-milestone : un palier déjà réclamé ne peut pas l\'être une seconde fois', async () => {
  const tier = milestoneTierForLevel(5);
  const already = dbUser({ idleRankLevel:5, idleMilestoneClaimed: tier });
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

  const eligible = dbUser({
    idleRunBestStage:PRESTIGE_MIN_STAGE, idleBestStage:PRESTIGE_MIN_STAGE, essence: 5000, idleProdLevel: 10, idleClickLevel: 5, idleSlotsUnlocked: 8, prestigeLevel: 1,
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
  assert.equal(userUpdate.wisdomPoints.increment, wisdomForRunStage(PRESTIGE_MIN_STAGE));
  assert.equal(userUpdate.idleStage,1);
  assert.equal(userUpdate.idleRunBestStage,1);
});

test("prestige : solde la production en attente AVANT le reset — elle compte dans l'XP du Dojo au lieu d'être perdue", async () => {
  const anHourAgo = new Date(Date.now() - 3600 * 1000);
  const eligible = dbUser({ idleRunBestStage:PRESTIGE_MIN_STAGE,idleBestStage:PRESTIGE_MIN_STAGE,idleStage:9,idleBattleMode:'farm',idleEnemyHp:enemyMaxHp(9), idleLastCollectAt: anHourAgo });
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
  // Le compteur d'épreuve de combat peut s'intercaler après le règlement.
  const resetCall = updateCalls.find((data) => data.essence === 0);
  assert.ok(resetCall);
  assert.equal(resetCall.essenceEarnedTotal, undefined);
});

test('prestige : une même run ne peut pas être encaissée deux fois', async () => {
  let user = dbUser({ idleStage: PRESTIGE_MIN_STAGE, idleRunBestStage: PRESTIGE_MIN_STAGE, idleBestStage: PRESTIGE_MIN_STAGE });
  prisma.user.findUnique = async () => user;
  prisma.idleSlot.updateMany = async () => ({ count: 0 });
  prisma.user.update = async ({ data }) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) user[key] = (user[key] || 0) + value.increment;
      else user[key] = value;
    }
    return user;
  };
  const first = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  const second = await app.request('/api/idle/prestige', { method: 'POST', cookie: app.authCookie('u1'), body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 400);
  assert.equal(user.prestigeLevel, 1);
  assert.equal(user.wisdomPoints, wisdomForRunStage(PRESTIGE_MIN_STAGE));
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

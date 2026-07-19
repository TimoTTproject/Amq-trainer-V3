// Parcours Dojo (Anime Ascension) SANS base de données : l'état du jeu est
// généré par le vrai `buildState` serveur (harnais de test + faux Prisma),
// puis servi au navigateur par interception réseau. On teste ainsi le VRAI
// rendu front — la couche où vivaient tous les bugs remontés par les joueurs
// (bénédictions figées sans F5, mode Farm invisible, donjon) — sans Postgres
// ni compte seedé.
const { test, expect } = require('@playwright/test');

let idleState;
let fixtureReady;

async function buildIdleStateFixture() {
  const { fakePrisma, createApp } = require('../test/helpers/api');
  const prisma = fakePrisma();
  const idleRoutes = require('../src/idle/idle.routes');
  const { START_SLOTS, enemyMaxHp } = require('../src/idle/idle');
  // Joueur en cours de run : stage 25 (donc un choix de bénédiction EN
  // ATTENTE, palier 21) et mode Farm actif — les deux surfaces récemment
  // corrigées.
  const user = {
    id: 'u1', email: 'melfisk6@gmail.com', essence: 5000, idleLastCollectAt: new Date(), idleSlotsUnlocked: START_SLOTS,
    idleProdLevel: 3, idleClickLevel: 2, idleCritLevel: 0, idleCooldownLevel: 0, idleMultiStrikeLevel: 0,
    idleRunBlessings: '', idleRunBlessingRerolls: 0, idleRunStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    essenceEarnedTotal: 90000, idleRunEssenceEarned: 4000,
    idleRankLevel: 12, idleRankKills: 0, idleRankClicks: 0, idleRankUpgrades: 0, idleRankBosses: 0, idleRankSkills: 0, idleRankRecruits: 0, idleRankStartedAt: new Date(),
    idleStage: 25, idleRunBestStage: 25, idleBestStage: 40, idleEnemyHp: enemyMaxHp(25), idleWaveKills: 2,
    idleMilestoneClaimed: 0, idleRecruitPity: 0, idleEssenceRecruitCount: 0, idleOnboardingComplete: true, prestigeLevel: 0,
    wisdomPoints: 0, idleSeals: 3, tokens: 0, idleBossProgress: 0, idleBossStartedAt: null, idleBestBossMs: null,
    idleFormation: 'balanced', idleLeaderCharacterId: null, idlePrestigeMilestone: 0, idleBurstReadyAt: null, idleTeamReadyAt: null,
    idleBuffKey: null, idleBuffUntil: null, idleCompletedSeries: 0, idleBattleMode: 'farm', displayName: 'Testeur E2E',
  };
  prisma.user.findUnique = async () => user;
  prisma.user.update = async ({ data }) => Object.assign(user, Object.fromEntries(Object.entries(data || {}).filter(([, value]) => typeof value !== 'object' || value instanceof Date)));
  prisma.user.updateMany = async () => ({ count: 1 });
  const character = { id: 7, name: 'Rem', imageUrl: null, rarity: 'epic', series: 'Re:Zero' };
  prisma.idleSlot.findMany = async () => [{ id: 1, userId: 'u1', slotIndex: 0, characterId: 7, level: 12, ascension: 0, awakened: false, awakenStars: 0, assignedAt: new Date(), character, items: [] }];
  prisma.dojoRecruit.count = async () => 1;
  prisma.dojoRecruit.findMany = async () => [];
  prisma.ancientLevel.findMany = async () => [];
  prisma.idleItem.findMany = async () => [];
  prisma.idleItem.count = async () => 0;
  prisma.idleProgressCounter.findMany = async () => [];
  prisma.idleProgressCounter.findUnique = async () => null;
  prisma.idleTeamPreset.findMany = async () => [];
  prisma.idleRunHistory.findMany = async () => [];
  prisma.idleRiftRun.findUnique = async () => null;
  prisma.idleMissionClaim.findMany = async () => [];
  prisma.idleExpedition = prisma.idleExpedition || {};
  prisma.idleExpedition.findUnique = async () => null;
  prisma.idleTelemetry.create = async () => ({});
  prisma.character.findMany = async () => [];
  prisma.character.count = async () => 50;
  const app = await createApp((a) => a.use('/api/idle', idleRoutes.router));
  try {
    const res = await app.request('/api/idle/state', { cookie: app.authCookie('u1') });
    if (res.status !== 200) throw new Error(`fixture /api/idle/state → ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
    return res.json;
  } finally {
    await app.close();
  }
}

test.beforeAll(async () => {
  fixtureReady = fixtureReady || buildIdleStateFixture();
  idleState = await fixtureReady;
});

async function openDojo(page) {
  const sessionUser = { id: 'u1', displayName: 'Testeur E2E', email: 'melfisk6@gmail.com', isGuest: false, tokens: 0, avatarUrl: null };
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') return route.fulfill({ json: { user: sessionUser } });
    if (pathname === '/api/idle/state' || pathname === '/api/idle/collect') return route.fulfill({ json: idleState });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(() => navTo('idle'));
  await expect(page.locator('#view-idle')).toBeVisible();
  // Attend la première synchro d'état (la scène affiche le monde/vague).
  await expect(page.locator('#idle-stage-location')).toContainText('Vague');
}

test('le Dojo rend la scène de combat depuis l’état serveur', async ({ page }) => {
  await openDojo(page);
  await expect(page.locator('#idle-stage-location')).toContainText('Monde 3');
  await expect(page.locator('#idle-essence-val')).not.toHaveText('');
  // Mode Farm : bandeau explicite + sortie à un clic (retours joueurs :
  // « bloqué stage 1 », « le boss regen », « je peux pas changer de monde »).
  await expect(page.locator('#idle-next-objective')).toContainText('MODE FARM');
  await expect(page.locator('#idle-next-objective [data-idle-farm-exit]')).toBeVisible();
  // Le conseil permanent appartient à la colonne principale : sur desktop il
  // ne doit plus commencer derrière le rail de navigation.
  await expect(page.locator('#idle-focus-objective')).toBeVisible();
  const placement=await page.evaluate(()=>{
    const objective=document.querySelector('#idle-focus-objective')?.getBoundingClientRect();
    const navigation=document.querySelector('#view-idle .idle-tabs')?.getBoundingClientRect();
    return {
      desktop:innerWidth>=901,
      parent:document.querySelector('#idle-focus-objective')?.parentElement?.classList.contains('idle-content'),
      objectiveLeft:objective?.left||0,
      objectiveRight:objective?.right||0,
      navigationRight:navigation?.right||0,
      viewportWidth:innerWidth,
    };
  });
  expect(placement.parent).toBe(true);
  expect(placement.objectiveLeft).toBeGreaterThanOrEqual(0);
  expect(placement.objectiveRight).toBeLessThanOrEqual(placement.viewportWidth);
  if(placement.desktop) expect(placement.objectiveLeft).toBeGreaterThan(placement.navigationRight);
});

test('les bénédictions en attente apparaissent sur l’onglet Niveaux sans F5', async ({ page }) => {
  await openDojo(page);
  // Régression joueurs : les propositions ne se rendaient que depuis
  // l'onglet Équipe (où la section ne vit plus) — il fallait recharger.
  await page.evaluate(() => idleShowPanel('progression'));
  await expect(page.locator('#idle-run-choice')).toBeVisible();
  await expect(page.locator('#idle-run-choices button[data-run-blessing]')).toHaveCount(3);
});

test('le Donjon des Objets passe du choix de cible à une vraie scène de combat', async ({ page }) => {
  await openDojo(page);
  await page.evaluate(() => idleShowPanel('farm'));
  await expect(page.locator('#idle-rune-dungeon-progress span')).toHaveCount(10);
  await expect(page.locator('#idle-rune-dungeon-status')).toContainText('Gratuit');
  await expect(page.locator('#idle-rune-dungeon-auto')).toBeVisible();
  await expect(page.locator('#idle-rune-dungeon-grid [data-rune-dungeon]')).toHaveCount(6);
  await page.evaluate(() => {
    idleState.runeDungeon={...idleState.runeDungeon,active:true,selectedKind:'rune1',floor:3,encounter:{floor:4,guardian:false,hp:7200,maxHp:10000,dps:850,clickDamage:420,enemyName:'Sentinelle de l’étage 4',backgroundUrl:null,enemyImageUrl:null}};
    renderIdleRuneDungeon(idleState);
  });
  await expect(page.locator('#idle-rune-dungeon-grid')).toBeHidden();
  await expect(page.locator('#idle-rune-dungeon-scene')).toBeVisible();
  await expect(page.locator('.idle-rune-dungeon-hp')).toContainText('7.2K / 10K PV');
  await expect(page.locator('[data-rune-hit]')).toContainText('FRAPPER');
  await expect(page.locator('.idle-rune-dungeon-combat-stats')).toContainText('DPS ÉQUIPE');
});

test('la navigation entre onglets rend chaque panneau avec le dernier état connu', async ({ page }) => {
  await openDojo(page);
  await page.evaluate(() => idleShowPanel('upgrades'));
  await expect(page.locator('#idle-upgrades .idle-upgrade-card').first()).toBeVisible();
  await expect(page.locator('#idle-upgrades')).toContainText('APRÈS ACHAT');
  await page.evaluate(() => idleShowPanel('team'));
  await expect(page.locator('#idle-slots')).toContainText('Rem');
  await page.evaluate(() => idleShowPanel('home'));
  await expect(page.locator('#idle-stage-location')).toContainText('Vague');
});

// Routes gacha : infos, tirage de cartes, collection
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { requireAdmin } = require('../admin/admin');
const { rollRarity, DUPLICATE_REFUND, FUSE_COUNT, PITY_LIMIT, PRICES, RARITY_LABELS, RARITY_ORDER, RARITY_RATES, MAX_STARS, ascendCost } = require('./rarity');
const { rateLimit } = require('../util/ratelimit');
const { progressQuests } = require('../quests/quests');

const router = express.Router();

// Horodatage du dernier reset gacha global (voir POST /api/admin/reset-gacha) —
// permet au front d'afficher une modale d'explication une seule fois par
// joueur (comparaison avec un horodatage gardé en localStorage), sans champ
// dédié sur User ni notification poussée à chacun individuellement. Le reset
// ne rembourse rien : la modale explique juste la remise à zéro.
router.get('/reset-notice', requireAuth, async (req, res) => {
  const s = await prisma.appSetting.findUnique({ where: { key: 'lastGachaReset' } });
  if (!s) return res.json({ resetAt: null });
  res.json({ resetAt: parseInt(s.value) });
});

// ── Bannière hebdomadaire (vedettes de la semaine, rate-up) ──
// Sélection déterministe par n° de semaine → pas de cron ni d'action admin.
// Le reset tombe pile à minuit heure de Paris chaque LUNDI (DST géré via Intl),
// pas toutes les 7×24h depuis 1970 (ce qui ne tombait sur aucun jour précis).
const WEEKLY_BOOST = 0.6; // proba de tomber sur la vedette de la rareté tirée
const RESET_TZ = 'Europe/Paris';
const REF_MONDAY_WALL_MS = Date.UTC(2024, 0, 1); // lundi de référence (arbitraire, stable)
let weeklyCache = { week: -1, byRarity: {}, chars: [], resetAt: 0 };

function seededIndex(wk, salt, mod) {
  let h = (wk * 2654435761 + salt) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h % mod;
}

// Décalage (ms) entre UTC et l'heure murale de `timeZone` à l'instant `instant`.
function tzOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// Minuit du lundi de la semaine de `instant`, en heure murale de Paris ENCODÉE
// COMME SI C'ÉTAIT DE L'UTC (Y-M-D 00:00:00) — pratique pour faire de
// l'arithmétique calendaire en jours entiers sans se soucier du DST.
function mondayWallMs(instant) {
  const wall = new Date(instant.getTime() + tzOffsetMs(instant, RESET_TZ));
  const daysSinceMonday = (wall.getUTCDay() + 6) % 7;
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - daysSinceMonday);
}

// Convertit une heure murale Paris (encodée en UTC, cf. ci-dessus) en véritable
// instant UTC. Deux passes pour converger correctement autour d'un changement d'heure.
function wallToRealMs(wallMs) {
  let real = wallMs - tzOffsetMs(new Date(wallMs), RESET_TZ);
  real = wallMs - tzOffsetMs(new Date(real), RESET_TZ);
  return real;
}

// Numéro de semaine ENTIER et stable, incrémenté chaque lundi minuit (Paris).
// Basé sur une différence de jours calendaires (toujours multiple exact de 7),
// donc insensible aux changements d'heure — contrairement à une division par ms.
function currentWeek() {
  const days = Math.round((mondayWallMs(new Date()) - REF_MONDAY_WALL_MS) / 86400000);
  return days / 7;
}

// Instant réel (epoch ms) du prochain lundi minuit heure de Paris.
function nextMondayResetAt() {
  return wallToRealMs(mondayWallMs(new Date()) + 7 * 86400000);
}

// Tirage au sort pondéré par les votes d'une semaine/rareté donnée (chaque
// vote = un ticket ; plus un perso a de votes, plus il a de chances, sans que
// ce soit automatique). Déterministe (même graine que le reste) → pas de vrai
// hasard, reproductible pour tous. Renvoie null si aucun vote pour cette rareté.
async function drawWeightedWinner(week, rarity) {
  const votes = await prisma.featuredVote.groupBy({
    by: ['characterId'], where: { week, rarity },
    _count: { characterId: true },
  });
  if (!votes.length) return null;
  const total = votes.reduce((sum, v) => sum + v._count.characterId, 0);
  const ticket = seededIndex(week, 999, total);
  let acc = 0;
  for (const v of votes) {
    acc += v._count.characterId;
    if (ticket < acc) return v.characterId;
  }
  return votes[votes.length - 1].characterId;
}

// Suppression manuelle (admin) de la bannière en cours : persistée en DB pour
// survivre aux redéploiements, contrairement à weeklyCache.
async function bannerSuppressedWeek() {
  const s = await prisma.appSetting.findUnique({ where: { key: 'bannerSuppressedWeek' } });
  return s ? parseInt(s.value) : null;
}

async function getWeeklyFeatured() {
  const wk = currentWeek();
  if (weeklyCache.week === wk) return weeklyCache;
  if ((await bannerSuppressedWeek()) === wk) {
    weeklyCache = { week: wk, byRarity: {}, chars: [], resetAt: nextMondayResetAt() };
    return weeklyCache;
  }
  const chars = [];
  const byRarity = {};
  const salts = { mythic: 101, legendary: 211, epic: 307 };
  for (const r of ['mythic', 'legendary', 'epic']) {
    const count = await prisma.character.count({ where: { rarity: r } });
    if (!count) continue;
    const idx = seededIndex(wk, salts[r], count);
    const c = await prisma.character.findFirst({
      where: { rarity: r }, orderBy: [{ favourites: 'desc' }, { id: 'asc' }], skip: idx,
      select: { id: true, name: true, imageUrl: true, rarity: true },
    });
    if (c) { chars.push(c); byRarity[r] = c.id; }
  }
  // Vedette élue par les votes de la semaine PRÉCÉDENTE, PAR RARETÉ : remplace
  // le slot de sa rareté, avec le même rate-up. Repli sur le déterministe sinon.
  try {
    for (const r of ['mythic', 'legendary', 'epic']) {
      const winnerId = await drawWeightedWinner(wk - 1, r);
      if (!winnerId) continue;
      const w = await prisma.character.findUnique({
        where: { id: winnerId }, select: { id: true, name: true, imageUrl: true, rarity: true },
      });
      if (!w) continue;
      byRarity[w.rarity] = w.id;
      const i = chars.findIndex((c) => c.rarity === w.rarity);
      const entry = { ...w, voted: true };
      if (i >= 0) chars[i] = entry; else chars.push(entry);
    }
  } catch (e) { console.warn('weekly vote winner unavailable:', e.message); }

  weeklyCache = { week: wk, byRarity, chars, resetAt: nextMondayResetAt() };
  return weeklyCache;
}

// Vide TOUS les caches en mémoire dérivés de la rareté des personnages
// (bannière hebdo + pools de candidats au vote). Nécessaire après tout
// changement des raretés en base (ex. /admin/recompute-rarities) : sinon
// `weeklyCache.byRarity` peut continuer à pointer, PENDANT LE RESTE DE LA
// SEMAINE, vers un personnage dont la rareté RÉELLE a changé — le rate-up
// vedette (50-60% de chance) livre alors silencieusement une carte d'une
// rareté différente de celle tirée (ex. un tirage Épique/Légendaire, bien
// plus fréquent que Mythique, qui ressort en Mythique si le perso vedette a
// été promu). Exportée pour être appelée depuis l'admin après un recalcul.
function invalidateWeeklyCaches() {
  weeklyCache = { week: -1, byRarity: {}, chars: [], resetAt: 0 };
  candidatesWeek = -1;
  rarityPoolCache = {};
  candidatesByUser = new Map();
}

// Efface la bannière en cours jusqu'au prochain reset (lundi). N'affecte pas
// les votes déjà en cours pour la semaine prochaine.
router.post('/banner-suppress', requireAuth, requireAdmin, async (req, res) => {
  const wk = currentWeek();
  await prisma.appSetting.upsert({
    where: { key: 'bannerSuppressedWeek' },
    update: { value: String(wk) },
    create: { key: 'bannerSuppressedWeek', value: String(wk) },
  });
  weeklyCache = { week: -1, byRarity: {}, chars: [], resetAt: 0 };
  res.json({ ok: true, week: wk });
});

// Réinitialise le vote de vedette hebdo après un changement de raretés (ex.
// pool agrandi + « Recalculer les raretés ») qui invaliderait les votes déjà
// émis : les votes stockent la rareté AU MOMENT DU VOTE, donc un personnage
// qui change de palier fausse le tirage pondéré. Efface les votes qui ont
// fixé la bannière ACTUELLE (week-1) et ceux en cours pour la semaine
// prochaine (week), puis force le recalcul de tous les caches en mémoire
// (bannière + pools de candidats par joueur) sur la nouvelle répartition.
// Note : /admin/recompute-rarities appelle déjà invalidateWeeklyCaches()
// automatiquement ; cette route reste utile pour en plus PURGER les votes
// devenus invalides (ce que le recalcul seul ne fait pas).
router.post('/reset-weekly-votes', requireAuth, requireAdmin, async (req, res) => {
  const wk = currentWeek();
  const { count } = await prisma.featuredVote.deleteMany({ where: { week: { in: [wk - 1, wk] } } });
  invalidateWeeklyCaches();
  const weekly = await getWeeklyFeatured();
  res.json({ ok: true, deletedVotes: count, week: wk, weekly });
});

// ── Candidats du vote hebdomadaire (légendaires/mythiques/épiques tirés au sort) ──
// La liste est PROPRE À CHAQUE JOUEUR (graine = semaine + son userId) : deux
// joueurs ne voient pas forcément les mêmes candidats la même semaine.
const CANDIDATES_PER_RARITY = { mythic: 4, legendary: 4, epic: 4 };
let candidatesWeek = -1;
let rarityPoolCache = {}; // rarity -> tous les persos de cette rareté (1 requête/semaine, partagée par tous)
let candidatesByUser = new Map(); // userId -> { ids, chars }

// Liste complète d'une rareté, mise en cache pour la semaine (une seule requête
// pour TOUS les joueurs, au lieu d'un findFirst par candidat et par joueur —
// ça évite de saturer le pool de connexions DB quand beaucoup de joueurs
// ouvrent le gacha en même temps).
async function getRarityPool(rarity) {
  if (!rarityPoolCache[rarity]) {
    rarityPoolCache[rarity] = await prisma.character.findMany({
      where: { rarity }, orderBy: [{ favourites: 'desc' }, { id: 'asc' }],
      select: { id: true, name: true, imageUrl: true, rarity: true },
    });
  }
  return rarityPoolCache[rarity];
}

function hashUserId(userId) {
  let h = 0;
  const s = String(userId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// Combine semaine + hash(userId) + sel en un index 0..mod-1, en arithmétique
// 32 bits (Math.imul) — seededIndex() ci-dessus multiplie par 2654435761 en
// virgule flottante, ce qui perd de la précision (donc du "hasard") dès que
// l'entrée dépasse ~2^32 ; ici les opérandes restent toujours des int32.
function seededIndexForUser(wk, userHash, salt, mod) {
  let h = Math.imul(wk ^ userHash, 2654435761) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ salt, 2246822519) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % mod;
}

async function getWeeklyCandidatesFor(userId) {
  const wk = currentWeek();
  if (candidatesWeek !== wk) {
    candidatesWeek = wk;
    rarityPoolCache = {};
    candidatesByUser = new Map();
  }
  if (candidatesByUser.has(userId)) return candidatesByUser.get(userId);
  const userHash = hashUserId(userId);
  const chars = [];
  let saltBase = 400;
  for (const [rarity, n] of Object.entries(CANDIDATES_PER_RARITY)) {
    const pool = await getRarityPool(rarity);
    const count = pool.length;
    if (!count) continue;
    const picked = new Set();
    for (let i = 0; i < n && picked.size < count; i++) {
      let idx;
      let guard = 0;
      do {
        idx = seededIndexForUser(wk, userHash, saltBase + i * 37, count);
        guard++;
      } while (picked.has(idx) && guard < 20);
      picked.add(idx);
      chars.push(pool[idx]);
    }
    saltBase += 1000;
  }
  const entry = { ids: chars.map((c) => c.id), chars };
  candidatesByUser.set(userId, entry);
  return entry;
}

// Infos pour l'UI : prix, taille du pool, répartition par rareté
router.get('/info', async (req, res) => {
  const total = await prisma.character.count();
  const groups = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const byRarity = {};
  groups.forEach((g) => (byRarity[g.rarity] = g._count._all));
  const featured = await prisma.character.findMany({
    where: { featured: true },
    select: { id: true, name: true, imageUrl: true, rarity: true },
    take: 12,
  });
  const weekly = await getWeeklyFeatured();
  res.json({
    prices: PRICES, total, byRarity, labels: RARITY_LABELS, featured, pityLimit: PITY_LIMIT,
    weeklyFeatured: weekly.chars, weeklyResetAt: weekly.resetAt, weeklyBoost: Math.round(WEEKLY_BOOST * 100),
  });
});

// Fil des derniers tirages Légendaire+ (tous joueurs confondus), pour le hub d'accueil.
router.get('/recent-pulls', requireAuth, async (req, res) => {
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 12));
  const pulls = await prisma.cardInstance.findMany({
    where: { character: { rarity: { in: ['legendary', 'mythic'] } } },
    orderBy: { obtainedAt: 'desc' },
    take: limit,
    select: {
      serial: true,
      obtainedAt: true,
      character: { select: { id: true, name: true, imageUrl: true, rarity: true, series: true } },
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
  res.json({
    pulls: pulls.map((p) => ({
      characterId: p.character.id,
      name: p.character.name,
      imageUrl: p.character.imageUrl,
      rarity: p.character.rarity,
      rarityLabel: RARITY_LABELS[p.character.rarity],
      series: p.character.series,
      serial: p.serial,
      obtainedAt: p.obtainedAt,
      user: { id: p.user.id, displayName: p.user.displayName, avatarUrl: p.user.avatarUrl },
    })),
  });
});

// Stats de tirage de l'utilisateur : répartition par rareté (réelle vs attendue)
// + indice de chance. La « valeur » d'une rareté = 1/probabilité, si bien que
// l'espérance par tirage vaut le nombre de raretés → indice 100% = pile dans la moyenne.
const RARITY_KEYS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const LUCK_MIN_PULLS = 10;
router.get('/stats', requireAuth, async (req, res) => {
  const u = req.user;
  const counts = {
    common: u.pullCommon || 0, rare: u.pullRare || 0, epic: u.pullEpic || 0,
    legendary: u.pullLegendary || 0, mythic: u.pullMythic || 0,
  };
  const total = RARITY_KEYS.reduce((s, r) => s + counts[r], 0);

  const perRarity = RARITY_KEYS.map((r) => ({
    rarity: r,
    label: RARITY_LABELS[r],
    count: counts[r],
    actualRate: total ? (counts[r] / total) * 100 : 0,
    expectedRate: RARITY_RATES[r], // en %
    expectedCount: total * (RARITY_RATES[r] / 100),
  }));

  let luckPercent = null;
  let luckLabel = `Encore ${Math.max(0, LUCK_MIN_PULLS - total)} tirage(s) pour évaluer ta chance`;
  if (total >= LUCK_MIN_PULLS) {
    let actualValue = 0;
    for (const r of RARITY_KEYS) {
      const p = RARITY_RATES[r] / 100;
      if (p > 0) actualValue += counts[r] * (1 / p);
    }
    const expectedValue = total * RARITY_KEYS.length;
    luckPercent = Math.round((actualValue / expectedValue) * 100);
    luckLabel =
      luckPercent >= 140 ? 'Très chanceux 🍀🍀' :
      luckPercent >= 112 ? 'Chanceux 🍀' :
      luckPercent >= 88 ? 'Dans la moyenne ⚖️' :
      luckPercent >= 60 ? 'Malchanceux 😕' : 'Très malchanceux 💀';
  }

  res.json({
    total, pity: u.pity || 0, pityLimit: PITY_LIMIT,
    perRarity, luck: { percent: luckPercent, label: luckLabel, min: LUCK_MIN_PULLS },
  });
});

// Choisit un personnage aléatoire d'une rareté donnée, NON épuisé (fallback : n'importe lequel non épuisé).
// Si un personnage « vedette » non épuisé existe pour cette rareté, 50% de chance de l'obtenir.
async function pickRandomCharacter(tx, rarity, boost) {
  // Rate-up vedette de la semaine (prioritaire)
  const boostId = boost && boost[rarity];
  if (boostId) {
    const bc = await tx.character.findUnique({ where: { id: boostId }, select: { id: true, name: true, imageUrl: true, rarity: true, featured: true, soldOut: true } });
    // Garde-fou : `boost` vient d'un cache hebdomadaire qui peut devenir
    // périmé si les raretés ont été recalculées entre-temps (cf.
    // invalidateWeeklyCaches). Sans cette vérification, un tirage d'une
    // rareté commune pourrait silencieusement livrer une carte devenue
    // Mythique entre-temps via ce rate-up.
    if (bc && bc.rarity === rarity && !bc.soldOut && Math.random() < 0.6) return bc;
  }
  const feat = await tx.character.findFirst({ where: { rarity, featured: true, soldOut: false } });
  if (feat && Math.random() < 0.5) return feat;
  const where = { rarity, soldOut: false };
  const count = await tx.character.count({ where });
  // Pas de repli vers une autre rareté si celle-ci est épuisée : ça fausserait
  // le taux annoncé (ex. un tirage Mythique livré comme Commun en silence).
  // Le pool est actuellement rééquilibré à la main → un palier peut être
  // temporairement vide ou totalement épuisé ; l'appelant (POST /pull) doit
  // alors rembourser l'emplacement plutôt que de faire encaisser une rareté
  // non promise.
  if (count === 0) return null;
  const skip = Math.floor(Math.random() * count);
  return tx.character.findFirst({ where, skip });
}

// Frappe une nouvelle instance numérotée d'un personnage pour un joueur (dans tx).
// Re-lit le perso (anti-course) ; retourne null si épuisé entre-temps. Sync UserCard.
async function mintInstance(tx, userId, characterId, source = 'pull') {
  const c = await tx.character.findUnique({
    where: { id: characterId },
    select: { id: true, minted: true, maxSupply: true, nextSerial: true },
  });
  if (!c || c.minted >= c.maxSupply) return null;
  const serial = c.nextSerial + 1;
  await tx.cardInstance.create({ data: { characterId: c.id, serial, userId, source } });
  await tx.character.update({
    where: { id: c.id },
    data: { minted: { increment: 1 }, nextSerial: serial, soldOut: c.minted + 1 >= c.maxSupply },
  });
  const existing = await tx.userCard.findUnique({ where: { userId_characterId: { userId, characterId: c.id } } });
  if (existing) {
    await tx.userCard.update({ where: { userId_characterId: { userId, characterId: c.id } }, data: { copies: { increment: 1 } } });
  } else {
    await tx.userCard.create({ data: { userId, characterId: c.id, copies: 1 } });
  }
  return { serial, isNew: !existing };
}

// Détruit jusqu'à n exemplaires (les n° de série les plus hauts) d'un perso pour un joueur.
// Rend les places au stock mondial (minted décrémenté, soldOut levé). Retourne le nb détruit.
// Exclut les exemplaires en vente sur le marché (`listed`) : gelés tant que
// l'annonce est active, ne doivent jamais être consommés par la fusion/l'ascension.
async function destroyInstances(tx, userId, characterId, n) {
  if (n <= 0) return 0;
  const insts = await tx.cardInstance.findMany({
    where: { userId, characterId, listed: false }, orderBy: { serial: 'desc' }, take: n, select: { id: true },
  });
  if (!insts.length) return 0;
  await tx.cardInstance.deleteMany({ where: { id: { in: insts.map((i) => i.id) } } });
  await tx.character.update({
    where: { id: characterId },
    data: { minted: { decrement: insts.length }, soldOut: false },
  });
  return insts.length;
}

// Active/désactive le rate-up de la bannière vedette en cours pour les tirages
// du joueur (la bannière elle-même reste imposée, changée chaque lundi).
router.post('/banner-boost', requireAuth, async (req, res) => {
  const enabled = !!req.body?.enabled;
  await prisma.user.update({ where: { id: req.user.id }, data: { bannerBoostEnabled: enabled } });
  res.json({ ok: true, bannerBoostEnabled: enabled });
});

// Tirage : type = 'single' | 'pack'
router.post('/pull', requireAuth, rateLimit({ max: 60, name: 'pull' }), async (req, res) => {
  const type = req.body?.type === 'pack' ? 'pack' : 'single';
  const cfg = PRICES[type];
  const userId = req.user.id;

  const poolSize = await prisma.character.count();
  if (poolSize === 0) {
    return res.status(503).json({ error: "Le gacha n'est pas encore disponible (pool vide)" });
  }
  if (req.user.tokens < cfg.cost) {
    return res.status(400).json({ error: 'Pas assez de tokens' });
  }

  // Tirage des raretés avec PITIÉ : garantie d'un Légendaire+ au bout de PITY_LIMIT
  // tirages sans en obtenir. Le compteur est suivi sur le compte.
  let pity = req.user.pity || 0;
  const rarities = [];
  for (let i = 0; i < cfg.count; i++) {
    let r = rollRarity();
    pity++;
    if (pity >= PITY_LIMIT && r !== 'legendary' && r !== 'mythic') r = 'legendary';
    if (r === 'legendary' || r === 'mythic') pity = 0;
    rarities.push(r);
  }
  if (cfg.guaranteeRarePlus && !rarities.some((r) => r !== 'common')) {
    rarities[Math.floor(Math.random() * rarities.length)] = 'rare';
  }

  const weekly = await getWeeklyFeatured();
  // Le joueur choisit d'utiliser ou non le rate-up de la bannière (la bannière
  // elle-même reste imposée, changée chaque lundi) : désactivé → tirage normal.
  const useBoost = req.user.bannerBoostEnabled !== false;
  const boostByRarity = useBoost ? weekly.byRarity : {};
  const result = await prisma.$transaction(async (tx) => {
    // Débit du coût
    await tx.user.update({ where: { id: userId }, data: { tokens: { decrement: cfg.cost } } });
    await tx.tokenTransaction.create({ data: { userId, amount: -cfg.cost, reason: 'pack_open' } });

    const cards = [];
    let refundTotal = 0;
    let unavailableCount = 0; // emplacements sans personnage dispo dans la rareté tirée → remboursés, jamais rétrogradés
    const perSlotCost = cfg.cost / cfg.count;
    const pullCounts = { common: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };
    for (const rarity of rarities) {
      const character = await pickRandomCharacter(tx, rarity, boostByRarity);
      if (!character) { unavailableCount++; continue; }
      const mint = await mintInstance(tx, userId, character.id);
      if (!mint) { unavailableCount++; continue; } // épuisé entre-temps (course)
      pullCounts[character.rarity] = (pullCounts[character.rarity] || 0) + 1;
      const isNew = mint.isNew;
      let refund = 0;
      if (!isNew) {
        refund = DUPLICATE_REFUND[character.rarity] || 0;
        refundTotal += refund;
      }
      cards.push({
        id: character.id, name: character.name, imageUrl: character.imageUrl,
        rarity: character.rarity, featured: character.featured, isNew, refund, serial: mint.serial,
      });
    }

    const unavailableRefund = Math.round(unavailableCount * perSlotCost);
    const u = await tx.user.update({
      where: { id: userId },
      data: {
        pity,
        ...((refundTotal + unavailableRefund) > 0 ? { tokens: { increment: refundTotal + unavailableRefund } } : {}),
        ...(pullCounts.common ? { pullCommon: { increment: pullCounts.common } } : {}),
        ...(pullCounts.rare ? { pullRare: { increment: pullCounts.rare } } : {}),
        ...(pullCounts.epic ? { pullEpic: { increment: pullCounts.epic } } : {}),
        ...(pullCounts.legendary ? { pullLegendary: { increment: pullCounts.legendary } } : {}),
        ...(pullCounts.mythic ? { pullMythic: { increment: pullCounts.mythic } } : {}),
      },
    });
    if (refundTotal > 0) {
      await tx.tokenTransaction.create({ data: { userId, amount: refundTotal, reason: 'duplicate_refund' } });
    }
    if (unavailableRefund > 0) {
      await tx.tokenTransaction.create({ data: { userId, amount: unavailableRefund, reason: 'rarity_unavailable_refund' } });
    }
    return { cards, refundTotal, unavailableCount, unavailableRefund, tokens: u.tokens, pity: u.pity };
  });

  progressQuests(userId, 'pull', cfg.count);
  res.json({ type, cost: cfg.cost, pityLimit: PITY_LIMIT, ...result });
});

// Fusion (remplace poussière/craft depuis le 2026-07-06) : le joueur choisit
// `items` = [{characterId, count}] possédés, même rareté, total = FUSE_COUNT
// (3) exemplaires quelconques (même perso ou mélangés). Ils sont recyclés
// (rendus au stock mondial) contre 1 carte ALÉATOIRE de cette même rareté —
// vraiment aléatoire, peut retomber sur un doublon (pas de garantie de
// nouveauté).
router.post('/fuse', requireAuth, async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const wanted = new Map(); // characterId -> count (fusionne les doublons d'entrée)
  for (const it of raw) {
    const cid = parseInt(it?.characterId);
    const n = parseInt(it?.count);
    if (!cid || !(n > 0)) continue;
    wanted.set(cid, (wanted.get(cid) || 0) + n);
  }
  const items = [...wanted.entries()].map(([characterId, count]) => ({ characterId, count }));
  const total = items.reduce((s, it) => s + it.count, 0);
  if (!items.length || total !== FUSE_COUNT) {
    return res.status(400).json({ error: `Choisis exactement ${FUSE_COUNT} exemplaires à fusionner.` });
  }

  const chars = await prisma.character.findMany({ where: { id: { in: items.map((it) => it.characterId) } } });
  if (chars.length !== items.length) return res.status(404).json({ error: 'Personnage introuvable.' });
  const rarity = chars[0].rarity;
  if (!chars.every((c) => c.rarity === rarity)) {
    return res.status(400).json({ error: 'Les exemplaires choisis doivent être de la même rareté.' });
  }

  // Compte les exemplaires réellement disponibles (non gelés par une annonce
  // active sur le marché) plutôt que l'agrégat UserCard.copies, qui inclut
  // les exemplaires en vente.
  for (const it of items) {
    const available = await prisma.cardInstance.count({
      where: { userId: req.user.id, characterId: it.characterId, listed: false },
    });
    if (available < it.count) {
      return res.status(400).json({ error: 'Tu ne possèdes pas assez d’exemplaires disponibles de ce personnage (certains sont peut-être en vente sur le marché).' });
    }
  }

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const won = await pickRandomCharacter(tx, rarity, {});
      if (!won) throw new Error('NONE_AVAILABLE');
      for (const it of items) {
        await destroyInstances(tx, req.user.id, it.characterId, it.count); // rend les places au stock
        const card = await tx.userCard.findUnique({
          where: { userId_characterId: { userId: req.user.id, characterId: it.characterId } },
        });
        if (!card || card.copies <= it.count) {
          await tx.userCard.deleteMany({ where: { userId: req.user.id, characterId: it.characterId } });
        } else {
          await tx.userCard.update({
            where: { userId_characterId: { userId: req.user.id, characterId: it.characterId } },
            data: { copies: { decrement: it.count } },
          });
        }
      }
      const mint = await mintInstance(tx, req.user.id, won.id, 'fuse');
      if (!mint) throw new Error('NONE_AVAILABLE'); // épuisé entre le tirage et la frappe (course rarissime)
      return {
        id: won.id, name: won.name, imageUrl: won.imageUrl, rarity: won.rarity,
        isNew: mint.isNew, serial: mint.serial,
      };
    });
  } catch (e) {
    if (e.message === 'NONE_AVAILABLE') {
      return res.status(400).json({ error: 'Plus aucun personnage disponible dans cette rareté pour le moment.' });
    }
    throw e;
  }
  res.json({ ok: true, card: result });
});

// Ascension d'une carte (★) : consomme des DOUBLONS pour monter d'un niveau.
// Purement cosmétique (prestige/vitrine) ; ne touche ni la rareté ni les classements.
router.post('/ascend', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const out = await prisma.$transaction(async (tx) => {
    const card = await tx.userCard.findUnique({
      where: { userId_characterId: { userId: req.user.id, characterId } },
    });
    if (!card) return { error: 'Tu ne possèdes pas cette carte' };
    const stars = card.stars || 1;
    if (stars >= MAX_STARS) return { error: 'Carte déjà au niveau maximum (★' + MAX_STARS + ')' };
    const cost = ascendCost(stars);
    // Exemplaires réellement disponibles (hors ceux gelés par une annonce
    // active sur le marché) : garde 1 exemplaire + consomme `cost` doublons.
    const available = await tx.cardInstance.count({ where: { userId: req.user.id, characterId, listed: false } });
    if (available < 1 + cost) return { error: `Il faut ${cost} doublon(s) disponible(s) pour passer ★${stars + 1} (tu en as ${Math.max(0, available - 1)}, certains sont peut-être en vente sur le marché).` };
    // Consomme les doublons (rend les places au stock) et garde 1 exemplaire.
    await destroyInstances(tx, req.user.id, characterId, cost);
    const updated = await tx.userCard.update({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      data: { copies: { decrement: cost }, stars: { increment: 1 } },
    });
    return { stars: updated.stars, copies: updated.copies, consumed: cost };
  });
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

// Catalogue (pokédex) des personnages : filtre rareté/recherche (nom ou série),
// pagination, et indicateur de possession pour l'utilisateur.
const VALID_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];
router.get('/characters', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 60;
  const q = (req.query.search || '').trim();
  const rarity = VALID_RARITIES.includes(req.query.rarity) ? req.query.rarity : null;
  const sort = req.query.sort === 'name' ? 'name' : 'favourites';

  const where = {};
  if (rarity) where.rarity = rarity;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { series: { contains: q, mode: 'insensitive' } },
    ];
  }
  // Filtre possession : owned=1 (possédés) | owned=0 (manquants) | absent (tous)
  if (req.query.owned === '0' || req.query.owned === '1') {
    const mine = await prisma.userCard.findMany({ where: { userId: req.user.id }, select: { characterId: true } });
    const ids = mine.map((m) => m.characterId);
    where.id = req.query.owned === '1' ? { in: ids.length ? ids : [0] } : { notIn: ids.length ? ids : [0] };
  }
  // `id` en tiebreak : même critère que le tri utilisé pour l'assignation des
  // raretés (recompute-rarities) — sinon des personnages à égalité de favoris
  // peuvent apparaître dans un ordre différent ici, donnant l'impression que
  // la frontière de rareté « fuit » (un Épique glissé entre des Mythiques).
  const orderBy = sort === 'name' ? [{ name: 'asc' }, { id: 'asc' }] : [{ favourites: 'desc' }, { id: 'asc' }];

  const [total, chars, pool] = await Promise.all([
    prisma.character.count({ where }),
    prisma.character.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, name: true, imageUrl: true, rarity: true, series: true, favourites: true, soldOut: true },
    }),
    prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } }),
  ]);

  // Possession (copies) pour les personnages de la page
  const owned = await prisma.userCard.findMany({
    where: { userId: req.user.id, characterId: { in: chars.map((c) => c.id) } },
    select: { characterId: true, copies: true },
  });
  const ownedById = Object.fromEntries(owned.map((o) => [o.characterId, o.copies]));
  const byRarity = {};
  pool.forEach((g) => (byRarity[g.rarity] = g._count._all));

  res.json({
    characters: chars.map((c) => ({ ...c, owned: ownedById[c.id] || 0 })), // c.soldOut inclus via select
    total,
    page,
    pages: Math.ceil(total / perPage),
    byRarity,
    labels: RARITY_LABELS,
  });
});

// Marque/retire un personnage des favoris (vitrine du profil). Doit être possédé.
router.post('/favorite', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  const favorite = !!req.body?.favorite;
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const card = await prisma.userCard.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId } },
  });
  if (!card) return res.status(400).json({ error: 'Tu ne possèdes pas ce personnage' });
  await prisma.userCard.update({
    where: { userId_characterId: { userId: req.user.id, characterId } },
    data: { favorite },
  });
  res.json({ favorite });
});

// ── Wishlist (liste de souhaits) ──
// Ajoute/retire un personnage de sa liste de souhaits (souhait d'obtention).
router.post('/wishlist', requireAuth, async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  const wish = !!req.body?.wish;
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  if (wish) {
    const exists = await prisma.character.findUnique({ where: { id: characterId }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Personnage introuvable' });
    await prisma.wishlist.upsert({
      where: { userId_characterId: { userId: req.user.id, characterId } },
      update: {}, create: { userId: req.user.id, characterId },
    });
  } else {
    await prisma.wishlist.deleteMany({ where: { userId: req.user.id, characterId } });
  }
  res.json({ wished: wish });
});

// Wishlist d'un joueur (la sienne par défaut, ou celle d'un autre via ?userId).
router.get('/wishlist', requireAuth, async (req, res) => {
  const userId = req.query.userId || req.user.id;
  const rows = await prisma.wishlist.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { character: { select: { id: true, name: true, imageUrl: true, rarity: true, soldOut: true } } },
  });
  // Que possède le joueur CONSULTÉ (pour griser les déjà-obtenus).
  const ownedIds = new Set(
    (await prisma.userCard.findMany({ where: { userId }, select: { characterId: true } })).map((c) => c.characterId)
  );
  res.json({
    items: rows.map((r) => ({ ...r.character, owned: ownedIds.has(r.character.id) })),
  });
});

// Fiche détaillée d'un personnage (+ possession de l'utilisateur)
router.get('/character/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id invalide' });
  const character = await prisma.character.findUnique({ where: { id } });
  if (!character) return res.status(404).json({ error: 'Personnage introuvable' });

  const card = await prisma.userCard.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId: id } },
  });
  // Rang de popularité au sein de sa rareté (1 = le plus populaire)
  const rankInRarity =
    1 +
    (await prisma.character.count({
      where: { rarity: character.rarity, favourites: { gt: character.favourites } },
    }));
  const totalInRarity = await prisma.character.count({ where: { rarity: character.rarity } });

  // Numéros de série possédés par l'utilisateur pour ce personnage
  const myInstances = await prisma.cardInstance.findMany({
    where: { userId: req.user.id, characterId: id }, orderBy: { serial: 'asc' }, select: { id: true, serial: true, listed: true },
  });
  // Mes annonces actives sur le marché pour ce personnage (pour proposer
  // « annuler la vente » directement depuis la fiche).
  const myListings = await prisma.marketListing.findMany({
    where: { sellerId: req.user.id, characterId: id, status: 'active' },
    select: { id: true, price: true, cardInstance: { select: { serial: true } } },
  });
  const wished = !!(await prisma.wishlist.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId: id } }, select: { id: true },
  }));
  const promotionVoteCount = await prisma.promotionVote.count({ where: { characterId: id } });
  const votedByMe = !!(await prisma.promotionVote.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId: id } }, select: { id: true },
  }));

  res.json({
    character: {
      id: character.id,
      anilistId: character.anilistId,
      name: character.name,
      imageUrl: character.imageUrl,
      rarity: character.rarity,
      favourites: character.favourites,
      fromManga: character.fromManga,
      series: character.series,
      edition: character.edition,
    },
    promotionVoteCount,
    votedByMe,
    rarityLabel: RARITY_LABELS[character.rarity] || character.rarity,
    pullRate: RARITY_RATES[character.rarity] ?? null,
    dupRefund: DUPLICATE_REFUND[character.rarity] ?? 0,
    rankInRarity,
    totalInRarity,
    owned: card ? card.copies : 0,
    wished,
    stars: card ? (card.stars || 1) : 0,
    ascendCost: card && (card.stars || 1) < MAX_STARS ? ascendCost(card.stars || 1) : 0,
    maxStars: MAX_STARS,
    favorite: card ? card.favorite : false,
    featured: character.featured,
    // Rareté réelle : stock mondial + n° de série possédés
    maxSupply: character.maxSupply,
    minted: character.minted,
    available: Math.max(0, character.maxSupply - character.minted),
    soldOut: character.soldOut,
    serials: myInstances.map((i) => i.serial),
    instances: myInstances.map((i) => ({ id: i.id, serial: i.serial, listed: i.listed })),
    listings: myListings.map((l) => ({ id: l.id, price: l.price, serial: l.cardInstance.serial })),
    anilistUrl: `https://anilist.co/character/${character.anilistId}`,
  });
});

// Collection de l'utilisateur
router.get('/collection', requireAuth, async (req, res) => {
  const cards = await prisma.userCard.findMany({
    where: { userId: req.user.id },
    include: { character: true },
  });
  cards.sort(
    (a, b) =>
      RARITY_ORDER[b.character.rarity] - RARITY_ORDER[a.character.rarity] ||
      (b.character.favourites || 0) - (a.character.favourites || 0)
  );

  // Progression par rareté (possédés / total du pool)
  const pool = await prisma.character.groupBy({ by: ['rarity'], _count: { _all: true } });
  const poolByRarity = {};
  pool.forEach((g) => (poolByRarity[g.rarity] = g._count._all));
  const ownedByRarity = {};
  cards.forEach((c) => (ownedByRarity[c.character.rarity] = (ownedByRarity[c.character.rarity] || 0) + 1));

  res.json({
    cards: cards.map((c) => ({
      id: c.character.id,
      name: c.character.name,
      imageUrl: c.character.imageUrl,
      rarity: c.character.rarity,
      series: c.character.series || null,
      copies: c.copies,
      stars: c.stars || 1,
    })),
    poolByRarity,
    ownedByRarity,
    labels: RARITY_LABELS,
  });
});

// ── Progression « par série » : pour chaque anime du pool, combien de
// personnages le joueur possède sur le total existant. Sert à l'onglet
// « Par série » de la collection (barres de progression, tri par avancement).
router.get('/collection/series', requireAuth, async (req, res) => {
  const [all, owned] = await Promise.all([
    prisma.character.findMany({
      select: { id: true, series: true, imageUrl: true, favourites: true },
    }),
    prisma.userCard.findMany({
      where: { userId: req.user.id },
      select: { characterId: true },
    }),
  ]);
  const ownedSet = new Set(owned.map((c) => c.characterId));
  const bySeries = new Map();
  for (const c of all) {
    const key = c.series || 'Autre';
    if (!bySeries.has(key)) bySeries.set(key, { series: key, total: 0, owned: 0, cover: c.imageUrl || null, topFav: -1 });
    const g = bySeries.get(key);
    g.total += 1;
    if (ownedSet.has(c.id)) g.owned += 1;
    // Couverture = personnage le plus populaire de la série
    if ((c.favourites || 0) > g.topFav) { g.topFav = c.favourites || 0; g.cover = c.imageUrl || g.cover; }
  }
  // Une « série » d'un seul personnage n'a rien à compléter (c'est juste une
  // carte comme une autre) : on l'exclut pour ne pas noyer les vraies franchises
  // à plusieurs personnages sous des dizaines de lignes triviales « 1/1 ✓ ».
  const series = [...bySeries.values()]
    .filter((s) => s.total >= 2)
    .map(({ topFav, ...s }) => s)
    // À faire d'abord (les moins avancées), les séries déjà complètes en bas.
    // Tri par nombre de cartes possédées EN VALEUR ABSOLUE (pas en %) : une
    // série 8/20 passe avant une 1/1... pardon, une 2/2 (100 % mais 2 cartes).
    .sort((a, b) => {
      const aDone = a.owned >= a.total, bDone = b.owned >= b.total;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return b.owned - a.owned || b.total - a.total;
    });
  res.json({ series });
});

// ── Vote pour la vedette de la semaine prochaine ──
// Un vote par joueur, par semaine ET par rareté (mythique/légendaire/épique
// votent séparément) : un petit cadre par catégorie côté client.
router.get('/vote', requireAuth, async (req, res) => {
  const wk = currentWeek();
  const mine = await prisma.featuredVote.findMany({
    where: { userId: req.user.id, week: wk },
    select: { rarity: true, characterId: true },
  });
  const mineByRarity = Object.fromEntries(mine.map((m) => [m.rarity, m.characterId]));
  const { chars: candidates } = await getWeeklyCandidatesFor(req.user.id);
  const counts = await prisma.featuredVote.groupBy({
    by: ['characterId'],
    where: { week: wk, characterId: { in: candidates.map((c) => c.id) } },
    _count: { characterId: true },
  });
  const votesById = Object.fromEntries(counts.map((g) => [g.characterId, g._count.characterId]));

  // Vote GLOBAL (tous les joueurs confondus, y compris les candidats qui ne sont
  // PAS dans MA liste personnalisée) : chacun a une sélection différente, donc
  // sans ça on ne voit jamais comment les autres joueurs votent.
  const globalCounts = await prisma.featuredVote.groupBy({
    by: ['characterId', 'rarity'],
    where: { week: wk },
    _count: { characterId: true },
    orderBy: { _count: { characterId: 'desc' } },
  });
  const globalIds = globalCounts.map((g) => g.characterId);
  const globalChars = globalIds.length
    ? await prisma.character.findMany({ where: { id: { in: globalIds } }, select: { id: true, name: true, imageUrl: true, rarity: true } })
    : [];
  const globalCharById = Object.fromEntries(globalChars.map((c) => [c.id, c]));

  const byRarity = {};
  const globalByRarity = {};
  for (const rarity of Object.keys(CANDIDATES_PER_RARITY)) {
    const list = candidates
      .filter((c) => c.rarity === rarity)
      .map((c) => ({ ...c, votes: votesById[c.id] || 0 }))
      .sort((a, b) => b.votes - a.votes);
    byRarity[rarity] = { candidates: list, myVote: mineByRarity[rarity] || null };
    globalByRarity[rarity] = globalCounts
      .filter((g) => g.rarity === rarity && globalCharById[g.characterId])
      .slice(0, 6)
      .map((g) => ({ ...globalCharById[g.characterId], votes: g._count.characterId }));
  }
  const weekly = await getWeeklyFeatured();
  res.json({
    week: wk,
    closesAt: nextMondayResetAt(),
    byRarity,
    globalByRarity,
    current: weekly.chars, // vedettes en cours (dont le gagnant du vote précédent)
  });
});

// Émet/modifie mon vote pour une rareté de la semaine en cours, parmi les
// candidats tirés au sort (décide la vedette de cette rareté la semaine suivante).
router.post('/vote', requireAuth, rateLimit({ max: 30, name: 'gacha-vote' }), async (req, res) => {
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const { chars: candidates } = await getWeeklyCandidatesFor(req.user.id);
  const candidate = candidates.find((c) => c.id === characterId);
  if (!candidate) {
    return res.status(400).json({ error: 'Ce personnage ne fait pas partie des candidats de cette semaine' });
  }
  const wk = currentWeek();
  await prisma.featuredVote.upsert({
    where: { userId_week_rarity: { userId: req.user.id, week: wk, rarity: candidate.rarity } },
    update: { characterId },
    create: { userId: req.user.id, week: wk, rarity: candidate.rarity, characterId },
  });
  res.json({ ok: true, characterId, rarity: candidate.rarity });
});

module.exports = { router, pickRandomCharacter, invalidateWeeklyCaches };

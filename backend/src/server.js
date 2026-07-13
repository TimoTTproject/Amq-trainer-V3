// Point d'entrée du serveur Anime Music Quiz
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

const { validateEnv } = require('./util/env');
// Vérifie la configuration avant toute initialisation (arrête le serveur si la prod est dangereuse).
validateEnv();

let server;
let shuttingDown = false;

// Après une erreur non récupérable, un redémarrage propre est plus sûr que de
// continuer avec un processus potentiellement incohérent. Railway le relance.
function shutdownAfterFatal(label, error) {
  console.error(`${label}:`, error && error.stack ? error.stack : error);
  if (shuttingDown) return;
  shuttingDown = true;
  const exit = () => process.exit(1);
  if (server?.listening) server.close(exit);
  else exit();
  setTimeout(exit, 10000).unref();
}
process.on('unhandledRejection', (reason) => shutdownAfterFatal('UnhandledRejection', reason));
process.on('uncaughtException', (error) => shutdownAfterFatal('UncaughtException', error));

const { attachUser } = require('./auth/auth.middleware');
const authRoutes = require('./auth/auth.routes');
const anilistOAuthRoutes = require('./auth/anilist-oauth.routes');
const googleOAuthRoutes = require('./auth/google-oauth.routes');
const catalogRoutes = require('./catalog/catalog.routes');
const quizRoutes = require('./quiz/quiz.routes');
const profileRoutes = require('./profile/profile.routes');
const economyRoutes = require('./economy/economy.routes');
const gachaRoutes = require('./gacha/gacha.routes');
const towerRoutes = require('./tower/tower.routes');
const adminRoutes = require('./admin/admin.routes');
const leaderboardRoutes = require('./leaderboard/leaderboard.routes');
const questsRoutes = require('./quests/quests.routes');
const friendsRoutes = require('./friends/friends.routes');
const shopRoutes = require('./shop/shop.routes');
const tradeRoutes = require('./trade/trade.routes');
const marketRoutes = require('./market/market.routes');
const statsRoutes = require('./stats/stats.routes');
const dailyRoutes = require('./daily/daily.routes');
const seasonRoutes = require('./season/season.routes');
const pushRoutes = require('./push/push.routes');
const mpRoutes = require('./mp/mp.routes');
const playlistsRoutes = require('./playlists/playlists.routes');
const albumsRoutes = require('./albums/albums.routes');
const changelogRoutes = require('./changelog/changelog.routes');
const feedbackRoutes = require('./feedback/feedback.routes');
const promotionRoutes = require('./promotion/promotion.routes');
const idleRoutes = require('./idle/idle.routes');
const { isEnabled: pushEnabled, sendDailyReminder } = require('./push/push');
const store = require('./util/store');
const { initMp } = require('./mp/mp');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

// Derrière le proxy Cloudflare/Railway : nécessaire pour les cookies "secure"
app.set('trust proxy', 1);

const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: ["'self'", 'https:', 'wss:'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  mediaSrc: ["'self'", 'blob:', 'https:'],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
  upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
};
const secureHeaders = helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  crossOriginEmbedderPolicy: false,
});
const legacyHeaders = helmet({
  contentSecurityPolicy: {
    directives: { ...cspDirectives, scriptSrc: ["'self'", "'unsafe-inline'"] },
  },
  crossOriginEmbedderPolicy: false,
});
app.use((req, res, next) =>
  (req.path.startsWith('/legacy/') ? legacyHeaders : secureHeaders)(req, res, next)
);
app.use(compression());

// Le frontend est servi par Express → même origine, cookies simples.
// CORS autorisé quand même pour un éventuel front séparé (Live Server, etc.).
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
app.use(
  cors({
    origin: [FRONTEND_URL, 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' })); // marge pour les avatars en base64
app.use(cookieParser());
app.use(attachUser);

// API
app.use('/api/auth', authRoutes.router);
app.use('/api/auth', anilistOAuthRoutes.router);
app.use('/api/auth', googleOAuthRoutes.router);
app.use('/api/catalog', catalogRoutes.router);
app.use('/api/quiz', quizRoutes.router);
app.use('/api/profile', profileRoutes.router);
app.use('/api/economy', economyRoutes.router);
app.use('/api/gacha', gachaRoutes.router);
app.use('/api/tower', towerRoutes.router);
app.use('/api/admin', adminRoutes.router);
app.use('/api/leaderboard', leaderboardRoutes.router);
app.use('/api/quests', questsRoutes.router);
app.use('/api/friends', friendsRoutes.router);
app.use('/api/shop', shopRoutes.router);
app.use('/api/trade', tradeRoutes.router);
app.use('/api/market', marketRoutes.router);
app.use('/api/stats', statsRoutes.router);
app.use('/api/daily', dailyRoutes.router);
app.use('/api/season', seasonRoutes.router);
app.use('/api/push', pushRoutes.router);
app.use('/api/mp', mpRoutes.router);
app.use('/api/playlists', playlistsRoutes.router);
app.use('/api/albums', albumsRoutes.router);
app.use('/api/changelog', changelogRoutes.router);
app.use('/api/feedback', feedbackRoutes.router);
app.use('/api/promotion', promotionRoutes.router);
app.use('/api/idle', idleRoutes.router);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Aperçu de partage personnalisé : sur /?u=<id>, on sert le HTML avec des balises
// Open Graph/Twitter du profil (carte riche sur Discord/Twitter). Doit passer
// AVANT le statique. Sinon, repli sur l'index par défaut.
const { prisma } = require('./db');
const { indexHtml, injectMeta, versionize } = require('./share/og');
const { tierFromMmr } = require('./mp/rank');
app.get('/', async (req, res, next) => {
  const uid = req.query.u;
  if (!uid) return next();
  try {
    const user = await prisma.user.findUnique({
      where: { id: String(uid) },
      select: { displayName: true, mmr: true, rankedGames: true, towerBestFloor: true },
    });
    if (!user) return next();
    const cards = await prisma.userCard.count({ where: { userId: String(uid) } });
    const bits = [];
    if (user.rankedGames > 0) { const t = tierFromMmr(user.mmr); bits.push(`${t.icon} ${t.name}`); }
    if (user.towerBestFloor > 0) bits.push(`Château étage ${user.towerBestFloor}`);
    bits.push(`${cards} carte${cards > 1 ? 's' : ''}`);
    const title = `${user.displayName} · Anime Music Quiz`;
    const description = `Profil de ${user.displayName} — ${bits.join(' · ')}. Affronte-le sur Anime Music Quiz !`;
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(versionize(injectMeta(indexHtml(), { title, description, url: `https://amqtrainer.fr/?u=${encodeURIComponent(String(uid))}` })));
  } catch {
    next();
  }
});

// Page d'accueil normale (pas de partage de profil) et /index.html direct :
// même HTML que express.static servirait, mais avec les scripts/styles
// locaux versionnés (?v=<commit>) pour qu'un déploiement soit visible
// immédiatement — cf. versionize() dans og.js pour le pourquoi. Doit passer
// AVANT express.static (sinon celui-ci sert le fichier brut, non versionné).
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(versionize(indexHtml()));
});

// Frontend statique (dans backend/public pour être inclus au déploiement)
const FRONTEND_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(FRONTEND_DIR, {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    const base = path.basename(filePath);
    if (base === 'index.html' || base === 'sw.js') {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

// Gestion centralisée des erreurs : on logge côté serveur et on renvoie un JSON
// générique (jamais de stack au client). Express 5 capture aussi les rejets des
// handlers async, donc une route qui oublie son try/catch ne tue plus le process.
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', req.method, req.originalUrl, '-', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur. Réessaie dans un instant.' });
});

// Serveur HTTP + Socket.io (multijoueur temps réel)
server = http.createServer(app);
initMp(server);

// Rappel quotidien du Défi du jour (si push activé). On vérifie toutes les 5 min ;
// le store partagé (Redis/mémoire) garantit un envoi unique par jour, même
// multi-instance ou après redéploiement.
if (pushEnabled()) {
  const REMINDER_HOUR = parseInt(process.env.DAILY_REMINDER_HOUR || '18', 10); // heure UTC
  setInterval(async () => {
    if (new Date().getUTCHours() !== REMINDER_HOUR) return;
    const day = new Date().toISOString().slice(0, 10);
    try {
      if (!(await store.setIfAbsent('daily-reminder:' + day, 82800))) return; // déjà envoyé aujourd'hui
      const r = await sendDailyReminder();
      console.log(`  → Rappel défi du jour : ${r.sent}/${r.targets} envoyés`);
    } catch (e) {
      console.error('Rappel quotidien échoué:', e.message);
    }
  }, 5 * 60 * 1000);
}

// Récompense coop hebdomadaire : les 2 meilleurs étages de la SEMAINE écoulée
// gagnent 800 / 400 🪙. Idempotent (store partagé + flag `rewarded` en BDD).
// NB : le coop est TOUJOURS en catalogue global (pas de farm sur ses listes).
const { weekKey } = require('./util/week');
async function payCoopWeekly(week) {
  const rows = await prisma.coopWeeklyScore.findMany({
    where: { week, floor: { gt: 0 }, rewarded: false },
    orderBy: { floor: 'desc' },
  });
  // Les 2 meilleurs ÉTAGES (pas les 2 premières lignes) sont récompensés : en cas
  // d'égalité sur un étage, tout le monde à ce rang touche le même montant.
  const distinctFloors = [...new Set(rows.map((r) => r.floor))].slice(0, 2);
  const amountByFloor = new Map(distinctFloors.map((floor, i) => [floor, [800, 400][i]]));
  const top = rows.filter((r) => amountByFloor.has(r.floor));
  for (const row of top) {
    const amt = amountByFloor.get(row.floor);
    try {
      // Le flag `rewarded` est posé sous condition (WHERE rewarded=false) DANS la
      // transaction : si deux process (ou deux passages) traitent la même ligne en
      // parallèle, un seul obtient count===1 et crédite les tokens — l'autre voit
      // count===0 et n'y touche pas. Le store `coop-weekly:<week>` seul ne suffisait
      // pas (Map en mémoire non partagée entre process sans REDIS_URL), d'où le
      // double paiement constaté.
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.coopWeeklyScore.updateMany({
          where: { id: row.id, rewarded: false },
          data: { rewarded: true },
        });
        if (!count) return;
        await tx.user.update({ where: { id: row.userId }, data: { tokens: { increment: amt } } });
        await tx.tokenTransaction.create({ data: { userId: row.userId, amount: amt, reason: 'coop_weekly' } });
      });
    } catch (e) { console.error('coop weekly pay:', e && e.message); }
  }
  if (top.length) console.log(`  → Récompenses coop hebdo (${week}) : ${top.length} joueur(s) payé(s)`);
}
async function checkCoopWeeklyPayout() {
  try {
    // Rattrape TOUTES les semaines passées non payées (pas seulement la dernière),
    // au cas où un incident (ex : redéploiements trop fréquents pour laisser le
    // temps au setInterval de se déclencher) ait empêché le paiement plus tôt.
    const current = weekKey();
    const pending = await prisma.coopWeeklyScore.findMany({
      where: { rewarded: false, floor: { gt: 0 }, week: { not: current } },
      distinct: ['week'], select: { week: true },
    });
    for (const { week } of pending) {
      if (!(await store.setIfAbsent('coop-weekly:' + week, 14 * 86400))) continue; // déjà traité
      await payCoopWeekly(week);
    }
  } catch (e) { console.error('coop weekly check:', e && e.message); }
}
// Exécution immédiate au démarrage (les redéploiements fréquents faisaient que le
// setInterval seul n'atteignait jamais 1h d'uptime continu, donc le paiement ne
// se déclenchait jamais) + vérification périodique pour un process longue durée.
checkCoopWeeklyPayout();
setInterval(checkCoopWeeklyPayout, 60 * 60 * 1000);

// Réparation unique des titres d'anime corrompus (bug crochets « [Oshi no Ko] »
// → « 2nd Season »). Re-récupère les vrais noms sur AniList, par lots throttlés.
// Idempotent : une fois corrigés, ces titres ne matchent plus le filtre.
const { repairBrokenTitlesBatch, dedupeAmbiguousAltTitles, backfillFormatsBatch, backfillCoversBatch, backfillYearsBatch, backfillGenresBatch } = require('./catalog/catalog.service');

// Backfill AUTOMATIQUE des formats (TV/Film/OAV…) : tant que des musiques ont
// `format: null`, elles passent le filtre « série principale » et polluent les
// modes de jeu avec des OP d'OAV/spéciaux (faux positifs). Plus besoin du clic
// admin : on tague le restant en tâche de fond à chaque démarrage, par lots
// throttlés AniList. Idempotent (ne traite que format: null).
async function autoBackfillFormats() {
  try {
    let total = 0;
    for (let guard = 0; guard < 120; guard++) {
      const r = await backfillFormatsBatch(50);
      if (!r.processed) break;
      total += r.updated;
      if (r.remaining) console.log(`  → Formats : ${r.updated} tagués (${r.remaining} restants)`);
      if (!r.remaining) break;
      await new Promise((res) => setTimeout(res, 1500)); // limite de débit AniList
    }
    if (total) console.log(`  → Backfill formats terminé : ${total} musique(s) taguée(s).`);
  } catch (e) { console.error('backfill formats:', e && e.message); }
  // Puis les jaquettes AniList (même passe, même throttle).
  try {
    let covers = 0;
    for (let guard = 0; guard < 120; guard++) {
      const r = await backfillCoversBatch(50);
      if (!r.processed) break;
      covers += r.updated;
      if (r.remaining) console.log(`  → Jaquettes : ${r.updated} récupérées (${r.remaining} restants)`);
      if (!r.remaining) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (covers) console.log(`  → Backfill jaquettes terminé : ${covers} musique(s).`);
  } catch (e) { console.error('backfill jaquettes:', e && e.message); }
  // Puis les années de diffusion (filtre par période du quiz), même passe.
  try {
    let years = 0;
    for (let guard = 0; guard < 120; guard++) {
      const r = await backfillYearsBatch(50);
      if (!r.processed) break;
      years += r.updated;
      if (r.remaining) console.log(`  → Années : ${r.updated} taguées (${r.remaining} restantes)`);
      if (!r.remaining) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (years) console.log(`  → Backfill années terminé : ${years} musique(s).`);
  } catch (e) { console.error('backfill années:', e && e.message); }
  // Puis les genres AniList (filtre par genre du quiz), même passe.
  try {
    let genres = 0;
    for (let guard = 0; guard < 120; guard++) {
      const r = await backfillGenresBatch(50);
      if (!r.processed) break;
      genres += r.updated;
      if (r.remaining) console.log(`  → Genres : ${r.updated} tagués (${r.remaining} restants)`);
      if (!r.remaining) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (genres) console.log(`  → Backfill genres terminé : ${genres} musique(s).`);
  } catch (e) { console.error('backfill genres:', e && e.message); }
}
setTimeout(() => {
  // Verrou court partagé : évite deux passes simultanées (multi-instance/redémarrages rapprochés).
  store.setIfAbsent('format-backfill-run', 3600)
    .then((ok) => { if (ok) autoBackfillFormats(); })
    .catch(() => {});
}, 35000);
async function repairCatalogTitles() {
  try {
    let total = 0;
    for (let guard = 0; guard < 60; guard++) {
      const r = await repairBrokenTitlesBatch(50);
      if (!r.processed) break;
      total += r.fixed;
      console.log(`  → Réparation titres : ${r.fixed}/${r.processed} corrigés (${r.remaining} restants)`);
      await new Promise((res) => setTimeout(res, 1500)); // limite de débit AniList
    }
    if (total) console.log(`  → Réparation titres terminée : ${total} anime(s) corrigé(s).`);
  } catch (e) { console.error('réparation titres:', e && e.message); }
}
setTimeout(() => {
  // Lock partagé : ne lance la passe qu'une fois (réessaie après 12 h si échec).
  store.setIfAbsent('catalog-title-repair:v1', 12 * 3600)
    .then((ok) => { if (ok) repairCatalogTitles(); })
    .catch(() => {});
}, 25000);

// Migration R2 : REPRISE AUTOMATIQUE au démarrage s'il reste des musiques à
// migrer (sinon chaque redéploiement Railway l'interrompait jusqu'au prochain
// clic dans l'admin). Désactivable via R2_AUTO_MIGRATE=0.
const { isR2Configured, startContinuousMigration } = require('./storage/r2');
if (isR2Configured() && process.env.R2_AUTO_MIGRATE !== '0') {
  setTimeout(async () => {
    try {
      const remaining = await prisma.song.count({ where: { videoUrl: { not: null }, audioUrl: null } });
      if (!remaining) return;
      startContinuousMigration();
      console.log(`  → Migration R2 reprise automatiquement : ${remaining} musique(s) restantes`);
    } catch (e) {
      console.error('reprise migration R2:', e.message);
    }
  }, 20000); // laisse le serveur démarrer tranquillement d'abord
}

// Nettoyage unique des synonymes ambigus (franchises à nombreuses saisons — le
// nom générique de la franchise, ex. « Pokemon », listé comme synonyme AniList
// de chaque saison, rendait n'importe laquelle acceptée comme réponse pour
// n'importe quelle autre). Aucun appel réseau → une seule passe suffit.
setTimeout(() => {
  store.setIfAbsent('catalog-alt-titles-dedupe:v1', 12 * 3600)
    .then(async (ok) => {
      if (!ok) return;
      try {
        const r = await dedupeAmbiguousAltTitles();
        if (r.updated) console.log(`  → Synonymes ambigus retirés : ${r.updated} anime(s) sur ${r.scanned} (${r.ambiguousKeys} synonyme(s) ambigu(s)).`);
      } catch (e) { console.error('dédup synonymes ambigus:', e && e.message); }
    })
    .catch(() => {});
}, 30000);

server.listen(PORT, () => {
  console.log(`\n  Anime Music Quiz`);
  console.log(`  → App        : http://localhost:${PORT}`);
  console.log(`  → API health : http://localhost:${PORT}/api/health\n`);
});

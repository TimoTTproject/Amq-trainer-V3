// Point d'entrée du serveur Anime Music Quiz
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { validateEnv } = require('./util/env');
// Vérifie la configuration avant toute initialisation (arrête le serveur si la prod est dangereuse).
validateEnv();

// Filet de sécurité : une erreur asynchrone isolée (ex. dans un timer de partie)
// ne doit PAS tuer le process et figer toutes les parties en cours. On logue.
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('UncaughtException:', err && err.stack ? err.stack : err);
});

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
const statsRoutes = require('./stats/stats.routes');
const dailyRoutes = require('./daily/daily.routes');
const seasonRoutes = require('./season/season.routes');
const pushRoutes = require('./push/push.routes');
const mpRoutes = require('./mp/mp.routes');
const { isEnabled: pushEnabled, sendDailyReminder } = require('./push/push');
const store = require('./util/store');
const { initMp } = require('./mp/mp');

const app = express();
const PORT = process.env.PORT || 3000;

// Derrière le proxy Cloudflare/Railway : nécessaire pour les cookies "secure"
app.set('trust proxy', 1);

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
app.use('/api/stats', statsRoutes.router);
app.use('/api/daily', dailyRoutes.router);
app.use('/api/season', seasonRoutes.router);
app.use('/api/push', pushRoutes.router);
app.use('/api/mp', mpRoutes.router);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Aperçu de partage personnalisé : sur /?u=<id>, on sert le HTML avec des balises
// Open Graph/Twitter du profil (carte riche sur Discord/Twitter). Doit passer
// AVANT le statique. Sinon, repli sur l'index par défaut.
const { prisma } = require('./db');
const { indexHtml, injectMeta } = require('./share/og');
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
    res.type('html').send(injectMeta(indexHtml(), { title, description, url: `https://amqtrainer.fr/?u=${encodeURIComponent(String(uid))}` }));
  } catch {
    next();
  }
});

// Frontend statique (dans backend/public pour être inclus au déploiement)
const FRONTEND_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(FRONTEND_DIR));

// Gestion centralisée des erreurs : on logge côté serveur et on renvoie un JSON
// générique (jamais de stack au client). Express 5 capture aussi les rejets des
// handlers async, donc une route qui oublie son try/catch ne tue plus le process.
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', req.method, req.originalUrl, '-', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur serveur. Réessaie dans un instant.' });
});

// Serveur HTTP + Socket.io (multijoueur temps réel)
const server = http.createServer(app);
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
// gagnent 1000 / 500 🪙. Idempotent (store partagé + flag `rewarded` en BDD).
const { previousWeekKey } = require('./util/week');
async function payCoopWeekly(week) {
  const top = await prisma.coopWeeklyScore.findMany({
    where: { week, floor: { gt: 0 }, rewarded: false },
    orderBy: { floor: 'desc' }, take: 2,
  });
  const amounts = [1000, 500];
  for (let i = 0; i < top.length; i++) {
    const amt = amounts[i]; const row = top[i];
    try {
      await prisma.$transaction([
        prisma.user.update({ where: { id: row.userId }, data: { tokens: { increment: amt } } }),
        prisma.tokenTransaction.create({ data: { userId: row.userId, amount: amt, reason: 'coop_weekly' } }),
        prisma.coopWeeklyScore.update({ where: { id: row.id }, data: { rewarded: true } }),
      ]);
    } catch (e) { console.error('coop weekly pay:', e && e.message); }
  }
  if (top.length) console.log(`  → Récompenses coop hebdo (${week}) : ${top.length} joueur(s) payé(s)`);
}
setInterval(async () => {
  const prev = previousWeekKey(); // semaine qui vient de se terminer
  try {
    if (!(await store.setIfAbsent('coop-weekly:' + prev, 14 * 86400))) return; // déjà traité
    await payCoopWeekly(prev);
  } catch (e) { console.error('coop weekly check:', e && e.message); }
}, 60 * 60 * 1000);

// Réparation unique des titres d'anime corrompus (bug crochets « [Oshi no Ko] »
// → « 2nd Season »). Re-récupère les vrais noms sur AniList, par lots throttlés.
// Idempotent : une fois corrigés, ces titres ne matchent plus le filtre.
const { repairBrokenTitlesBatch, dedupeAmbiguousAltTitles } = require('./catalog/catalog.service');
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

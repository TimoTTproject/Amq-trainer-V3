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
// eslint-disable-next-line no-unused-vars
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

server.listen(PORT, () => {
  console.log(`\n  Anime Music Quiz`);
  console.log(`  → App        : http://localhost:${PORT}`);
  console.log(`  → API health : http://localhost:${PORT}/api/health\n`);
});

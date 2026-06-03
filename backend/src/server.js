// Point d'entrée du serveur Anime Music Quiz
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { attachUser } = require('./auth/auth.middleware');
const authRoutes = require('./auth/auth.routes');
const anilistOAuthRoutes = require('./auth/anilist-oauth.routes');
const catalogRoutes = require('./catalog/catalog.routes');
const quizRoutes = require('./quiz/quiz.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Le frontend est servi par Express → même origine, cookies simples.
// CORS autorisé quand même pour un éventuel front séparé (Live Server, etc.).
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';
app.use(
  cors({
    origin: [FRONTEND_URL, 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(attachUser);

// API
app.use('/api/auth', authRoutes.router);
app.use('/api/auth', anilistOAuthRoutes.router);
app.use('/api/catalog', catalogRoutes.router);
app.use('/api/quiz', quizRoutes.router);
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Frontend statique
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(FRONTEND_DIR));

app.listen(PORT, () => {
  console.log(`\n  Anime Music Quiz`);
  console.log(`  → App        : http://localhost:${PORT}`);
  console.log(`  → API health : http://localhost:${PORT}/api/health\n`);
});

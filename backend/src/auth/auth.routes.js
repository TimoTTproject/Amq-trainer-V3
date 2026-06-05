// Routes d'authentification email/mot de passe
const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db');
const { setAuthCookie, clearAuthCookie } = require('./jwt');
const { requireAuth } = require('./auth.middleware');
const { isAdmin } = require('../admin/admin');
const { tierFromMmr } = require('../mp/rank');
const { resolveEquipped } = require('../shop/cosmetics');

const router = express.Router();

function dailyAvailable(last) {
  if (!last) return true;
  const a = new Date(last);
  const b = new Date();
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

// Renvoie une version sûre de l'utilisateur (sans secrets)
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    anilistName: u.anilistName,
    anilistListName: u.anilistListName,
    tokens: u.tokens,
    dust: u.dust || 0,
    pity: u.pity || 0,
    towerBestFloor: u.towerBestFloor || 0,
    mmr: u.mmr,
    rankTier: (u.rankedGames || 0) > 0 ? tierFromMmr(u.mmr) : null,
    dailyAvailable: dailyAvailable(u.lastDailyAt),
    createdAt: u.createdAt,
    isAdmin: isAdmin(u),
    cosmetics: resolveEquipped(u),
  };
}

router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: 'Cet email est déjà utilisé' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, displayName: displayName || email.split('@')[0] },
  });
  setAuthCookie(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  setAuthCookie(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { router, publicUser };

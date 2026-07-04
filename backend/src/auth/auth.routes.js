// Routes d'authentification email/mot de passe
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma } = require('../db');
const { setAuthCookie, setGuestCookie, clearAuthCookie } = require('./jwt');
const { requirePlayer } = require('./auth.middleware');
const { isAdmin } = require('../admin/admin');
const { tierFromMmr } = require('../mp/rank');
const { resolveEquipped } = require('../shop/cosmetics');
const { rateLimit } = require('../util/ratelimit');
const { sendPasswordResetEmail } = require('./email');

const router = express.Router();
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Mot de passe trop court (min. ${MIN_PASSWORD_LENGTH} caractères)`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Mot de passe trop long (max. ${MAX_PASSWORD_LENGTH} caractères)`;
  }
  return null;
}

function dailyAvailable(last) {
  if (!last) return true;
  const a = new Date(last);
  const b = new Date();
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

// Renvoie une version sûre de l'utilisateur (sans secrets)
function publicUser(u) {
  if (!u) return null;
  if (u.isGuest) {
    return {
      id: u.id,
      displayName: 'Invité',
      tokens: 0,
      dust: 0,
      isGuest: true,
      isAdmin: false,
      dailyAvailable: false,
      cosmetics: {},
    };
  }
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

router.post(
  '/register',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'register' }),
  async (req, res) => {
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim().slice(0, 40);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
    const invalidPassword = passwordError(password);
    if (invalidPassword) return res.status(400).json({ error: invalidPassword });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, passwordHash, displayName: displayName || email.split('@')[0] },
    });
    setAuthCookie(res, user.id, req);
    res.status(201).json({ user: publicUser(user) });
  }
);

router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'login' }),
  async (req, res) => {
    const password = String(req.body?.password || '');
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    if (email.length > 254 || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    setAuthCookie(res, user.id, req);
    res.json({ user: publicUser(user) });
  }
);

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.post('/guest', rateLimit({ windowMs: 60000, max: 10, name: 'guest-session' }), (req, res) => {
  const guestId = `guest:${crypto.randomUUID()}`;
  setGuestCookie(res, guestId, req);
  res.status(201).json({ user: publicUser({ id: guestId, isGuest: true }) });
});

router.post(
  '/forgot-password',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, name: 'forgot-password' }),
  async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const result = { message: 'Si un compte correspond à cet e-mail, un lien vient d’être envoyé.' };
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) return res.json(result);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.$transaction([
      prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
      }),
    ]);

    const origin = (process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const resetUrl = `${origin}/?reset=${encodeURIComponent(token)}`;
    try {
      const delivery = await sendPasswordResetEmail({ to: email, resetUrl });
      if (!delivery.sent && process.env.NODE_ENV !== 'production') {
        console.log(`Lien de réinitialisation (dev) : ${resetUrl}`);
        result.devResetUrl = resetUrl;
      }
    } catch (err) {
      console.error('Envoi du lien de réinitialisation échoué :', err.message);
    }
    res.json(result);
  }
);

router.post(
  '/reset-password',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, name: 'reset-password' }),
  async (req, res) => {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    const invalidPassword = passwordError(password);
    if (!token || invalidPassword) {
      return res.status(400).json({ error: !token ? 'Lien invalide' : invalidPassword });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const reset = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date()) {
      return res.status(400).json({ error: 'Ce lien est invalide ou a expiré.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    ]);
    res.json({ message: 'Mot de passe modifié. Tu peux maintenant te connecter.' });
  }
);

router.get('/me', requirePlayer, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

module.exports = { router, publicUser, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, passwordError };

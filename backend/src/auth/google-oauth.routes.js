// OAuth Google : "Se connecter avec Google"
// Prérequis : créer un ID client OAuth 2.0 (type Web) sur
// https://console.cloud.google.com/apis/credentials et renseigner
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI dans .env
const express = require('express');
const { prisma } = require('../db');
const { setAuthCookie } = require('./jwt');

const router = express.Router();

// .trim() : évite les espaces/retours à la ligne collés par erreur (redirect_uri_mismatch)
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.GOOGLE_REDIRECT_URI || '').trim();

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

router.get('/google/status', (req, res) => {
  res.json({ configured: isConfigured() });
});

// Étape 1 : redirige vers l'écran de consentement Google
router.get('/google', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Google OAuth non configuré (voir .env)' });
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Étape 2 : Google redirige ici avec ?code=...
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?auth=error');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Pas de access_token');

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await infoRes.json();
    if (!profile?.sub) throw new Error('Profil Google introuvable');

    // 1) compte déjà lié à ce Google id ?
    let user = await prisma.user.findUnique({ where: { googleId: profile.sub } });
    // 2) sinon, lier à un compte email existant
    if (!user && profile.email) {
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
      if (byEmail) {
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleId: profile.sub, avatarUrl: byEmail.avatarUrl || profile.picture || null },
        });
      }
    }
    // 3) sinon, créer un nouveau compte
    if (!user) {
      user = await prisma.user.create({
        data: {
          googleId: profile.sub,
          email: profile.email || null,
          displayName: profile.name || (profile.email ? profile.email.split('@')[0] : 'Joueur'),
          avatarUrl: profile.picture || null,
        },
      });
    }

    setAuthCookie(res, user.id, req);
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    res.redirect('/?auth=error');
  }
});

module.exports = { router };

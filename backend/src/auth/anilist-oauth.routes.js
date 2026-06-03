// OAuth AniList : "Se connecter avec AniList"
// Prérequis : créer une app sur https://anilist.co/settings/developer
// et renseigner ANILIST_CLIENT_ID / ANILIST_CLIENT_SECRET / ANILIST_REDIRECT_URI dans .env
const express = require('express');
const { prisma } = require('../db');
const { setAuthCookie } = require('./jwt');
const { getViewer } = require('../anilist/anilist.service');

const router = express.Router();

const CLIENT_ID = process.env.ANILIST_CLIENT_ID;
const CLIENT_SECRET = process.env.ANILIST_CLIENT_SECRET;
const REDIRECT_URI = process.env.ANILIST_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5500';

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

// Indique au front si le bouton AniList doit être affiché
router.get('/anilist/status', (req, res) => {
  res.json({ configured: isConfigured() });
});

// Étape 1 : redirige vers la page d'autorisation AniList
router.get('/anilist', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'AniList OAuth non configuré (voir .env)' });
  }
  const url = `https://anilist.co/api/v2/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI
  )}&response_type=code`;
  res.redirect(url);
});

// Étape 2 : AniList redirige ici avec ?code=...
router.get('/anilist/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(`${FRONTEND_URL}/?auth=error`);
  try {
    // Échange du code contre un access token
    const tokenRes = await fetch('https://anilist.co/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Pas de access_token');

    const viewer = await getViewer(tokenData.access_token);
    if (!viewer?.id) throw new Error('Profil AniList introuvable');

    // Créer ou retrouver le compte lié à cet AniList id
    const user = await prisma.user.upsert({
      where: { anilistId: viewer.id },
      update: {
        anilistName: viewer.name,
        anilistToken: tokenData.access_token,
        avatarUrl: viewer.avatar?.large,
      },
      create: {
        anilistId: viewer.id,
        anilistName: viewer.name,
        anilistToken: tokenData.access_token,
        displayName: viewer.name,
        avatarUrl: viewer.avatar?.large,
      },
    });

    setAuthCookie(res, user.id);
    res.redirect(`${FRONTEND_URL}/?auth=success`);
  } catch (err) {
    console.error('AniList OAuth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}/?auth=error`);
  }
});

module.exports = { router };

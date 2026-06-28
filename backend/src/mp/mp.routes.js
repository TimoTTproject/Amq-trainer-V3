// Route multijoueur : flux vidéo de la manche en cours, proxifié (anti-triche).
const express = require('express');
const { requireAuth } = require('../auth/auth.middleware');
const { proxyVideo } = require('../util/stream');
const { getCurrentVideo } = require('./mp');
const { r2Config } = require('../storage/r2');

const router = express.Router();

router.get('/clip/:gameId', requireAuth, async (req, res) => {
  const videoUrl = getCurrentVideo(req.params.gameId, req.user.id, req.query.r);
  if (!videoUrl) return res.status(404).end();
  const publicUrl = r2Config().publicUrl;
  if (publicUrl && videoUrl.startsWith(`${publicUrl}/`)) return res.redirect(302, videoUrl);
  await proxyVideo(req, res, videoUrl);
});

module.exports = { router };

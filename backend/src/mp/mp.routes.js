// Route multijoueur : flux vidéo de la manche en cours, proxifié (anti-triche).
const express = require('express');
const { requireAuth } = require('../auth/auth.middleware');
const { proxyVideo } = require('../util/stream');
const { getCurrentVideo } = require('./mp');

const router = express.Router();

router.get('/clip/:gameId', requireAuth, async (req, res) => {
  const videoUrl = getCurrentVideo(req.params.gameId, req.user.id);
  if (!videoUrl) return res.status(404).end();
  await proxyVideo(req, res, videoUrl);
});

module.exports = { router };

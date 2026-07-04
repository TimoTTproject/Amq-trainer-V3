// Journal des nouveautés (features/améliorations/corrections livrées). Source
// de données maintenue à la main dans changelog.data.js — pas de BDD, pas
// d'admin UI : chaque livraison y ajoute une entrée au moment du déploiement.
const express = require('express');
const { requireAuth } = require('../auth/auth.middleware');
const { listEntries } = require('./changelog.data');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  res.json({ entries: listEntries(limit) });
});

module.exports = { router };

// Limiteur de débit (fenêtre fixe) par utilisateur (sinon IP), via le store partagé
// (Redis si dispo, sinon mémoire). Renvoie 429 au-delà du quota.
const store = require('./store');

let instanceSeq = 0;

function rateLimit({ windowMs = 60000, max = 60, name } = {}) {
  const ns = 'rl:' + (name || 'r' + ++instanceSeq) + ':';
  const ttlSec = Math.max(1, Math.round(windowMs / 1000));

  return async (req, res, next) => {
    const id = (req.user && req.user.id) || req.ip || 'anon';
    try {
      const n = await store.incr(ns + id, ttlSec);
      if (n > max) return res.status(429).json({ error: 'Trop de requêtes, réessaie dans un instant.' });
    } catch {
      // En cas d'erreur du store, on ne bloque pas la requête.
    }
    next();
  };
}

module.exports = { rateLimit };

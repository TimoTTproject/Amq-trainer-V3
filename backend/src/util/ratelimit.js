// Limiteur de débit en mémoire (fenêtre fixe), par utilisateur (sinon IP).
// Suffisant pour une instance unique (Railway). Renvoie 429 au-delà du quota.
function rateLimit({ windowMs = 60000, max = 60 } = {}) {
  const hits = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.reset < now) hits.delete(k);
  };
  setInterval(sweep, windowMs).unref?.();

  return (req, res, next) => {
    const id = (req.user && req.user.id) || req.ip || 'anon';
    const now = Date.now();
    let e = hits.get(id);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(id, e); }
    e.count++;
    if (e.count > max) {
      return res.status(429).json({ error: 'Trop de requêtes, réessaie dans un instant.' });
    }
    next();
  };
}

module.exports = { rateLimit };

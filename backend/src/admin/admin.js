// Désignation des comptes admin (pour les tests).
// Par défaut : email du propriétaire, surchargeable via ADMIN_EMAILS (séparés par virgule).
const DEFAULT_ADMINS = ['melfisk6@gmail.com'];

const ADMIN_EMAILS = new Set(
  [...DEFAULT_ADMINS, ...(process.env.ADMIN_EMAILS || '').split(',')]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function isAdmin(user) {
  return !!(user && user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
}

// Middleware : réserve une route aux admins (à placer après requireAuth)
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Réservé aux administrateurs' });
  next();
}

module.exports = { isAdmin, requireAdmin };

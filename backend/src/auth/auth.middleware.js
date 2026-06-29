// Middlewares d'authentification
const { prisma } = require('../db');
const { verifyToken, COOKIE_NAME } = require('./jwt');

// Charge l'utilisateur depuis le cookie si présent (n'échoue jamais)
async function attachUser(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    const payload = verifyToken(token);
    if (payload?.sub && payload.guest) {
      req.user = {
        id: payload.sub,
        displayName: 'Invité',
        isGuest: true,
        tokens: 0,
        dust: 0,
      };
    } else if (payload?.sub) {
      req.user = await prisma.user.findUnique({ where: { id: payload.sub } });
    }
  }
  next();
}

// Exige un utilisateur connecté
function requireAuth(req, res, next) {
  if (!req.user || req.user.isGuest) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  next();
}

function requirePlayer(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Session requise' });
  next();
}

module.exports = { attachUser, requireAuth, requirePlayer };

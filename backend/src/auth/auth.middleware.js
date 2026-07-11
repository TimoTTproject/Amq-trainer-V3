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

// Compte suspendu par la modération : refus explicite (HTTP 403), quel que
// soit le niveau d'accès demandé — le socket multi refuse aussi (cf. mp.js).
function rejectBanned(req, res) {
  if (req.user?.bannedAt) {
    res.status(403).json({ error: 'Compte suspendu. Contacte un administrateur.' });
    return true;
  }
  return false;
}

// Exige un utilisateur connecté
function requireAuth(req, res, next) {
  if (!req.user || req.user.isGuest) {
    return res.status(401).json({ error: 'Authentification requise' });
  }
  if (rejectBanned(req, res)) return;
  next();
}

function requirePlayer(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Session requise' });
  if (rejectBanned(req, res)) return;
  next();
}

module.exports = { attachUser, requireAuth, requirePlayer };

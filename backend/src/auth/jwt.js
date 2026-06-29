// Gestion des JSON Web Tokens stockés dans un cookie httpOnly
const jwt = require('jsonwebtoken');
const { JWT_SECRET, isProduction } = require('../util/env');

const COOKIE_NAME = 'amq_token';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Pose le cookie d'auth sur la réponse.
// `req` (optionnel) permet de marquer le cookie "secure" dès que la requête
// arrive en HTTPS (via trust proxy), même si NODE_ENV n'est pas défini.
function setAuthCookie(res, userId, req) {
  const token = signToken({ sub: userId });
  setCookie(res, token, req, MAX_AGE_MS);
}

function setGuestCookie(res, guestId, req) {
  const maxAge = 24 * 60 * 60 * 1000;
  const token = jwt.sign({ sub: guestId, guest: true }, JWT_SECRET, { expiresIn: '1d' });
  setCookie(res, token, req, maxAge);
}

function setCookie(res, token, req, maxAge) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction || !!(req && req.secure), // HTTPS en prod / derrière proxy
    maxAge,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = { signToken, verifyToken, setAuthCookie, setGuestCookie, clearAuthCookie, COOKIE_NAME };

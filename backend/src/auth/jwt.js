// Gestion des JSON Web Tokens stockés dans un cookie httpOnly
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me';
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

// Pose le cookie d'auth sur la réponse
function setAuthCookie(res, userId) {
  const token = signToken({ sub: userId });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    // secure: true, // à activer en HTTPS/prod
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

module.exports = { signToken, verifyToken, setAuthCookie, clearAuthCookie, COOKIE_NAME };

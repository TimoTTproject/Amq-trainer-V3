// Jeton de manche : émis par le serveur au tirage, rejoué à la validation.
// Empêche le client de décider lui-même s'il joue en classé (et donc de farmer
// des tokens en mode entraînement) et de revalider plusieurs fois la même manche.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me';
const ROUND_TTL = '30m'; // une manche doit être validée dans les 30 min

// Manches déjà consommées (jti → expiration). En mémoire : suffisant pour une
// instance unique (Railway). Si on passe à plusieurs instances, déplacer en BDD/Redis.
const consumed = new Map();
function sweep() {
  const now = Date.now();
  for (const [jti, exp] of consumed) if (exp < now) consumed.delete(jti);
}
setInterval(sweep, 5 * 60 * 1000).unref?.();

// Émet un jeton liant la manche à l'utilisateur, à la musique et au mode classé.
function issueRoundToken({ userId, songId, ranked }) {
  return jwt.sign(
    { rt: true, uid: userId, sid: songId, ranked: !!ranked, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: ROUND_TTL }
  );
}

// Vérifie un jeton sans le consommer. Retourne le payload ou null.
function verifyRoundToken(token, { userId, songId } = {}) {
  if (!token) return null;
  let p;
  try {
    p = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
  if (!p?.rt) return null;
  if (userId != null && p.uid !== userId) return null;
  if (songId != null && p.sid !== songId) return null;
  return p;
}

// Marque la manche comme jouée. Retourne false si elle l'a déjà été (rejeu).
function consumeRound(payload) {
  if (!payload?.jti) return false;
  if (consumed.has(payload.jti)) return false;
  const exp = (payload.exp ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000);
  consumed.set(payload.jti, exp);
  return true;
}

module.exports = { issueRoundToken, verifyRoundToken, consumeRound };

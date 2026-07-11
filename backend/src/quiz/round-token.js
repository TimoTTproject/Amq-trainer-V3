// Jeton de manche : émis par le serveur au tirage, rejoué à la validation.
// Empêche le client de décider lui-même s'il joue en classé (et donc de farmer
// des tokens en mode entraînement) et de revalider plusieurs fois la même manche.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const store = require('../util/store');
const { JWT_SECRET } = require('../util/env');

const ROUND_TTL = '30m'; // une manche doit être validée dans les 30 min

// Émet un jeton liant la manche à l'utilisateur, à la musique, au mode classé
// et au niveau d'aide (cash | carre | duo, qui détermine le multiplicateur de gain).
// `sat` (start-at, en secondes epoch) date le DÉBUT de la manche : il sert de
// référence au bonus de vitesse et est préservé quand on passe en Carré/Duo
// (sinon l'aide remettrait le chrono à zéro). Signé → non falsifiable par le client.
// `mode`/`source`/`series` mémorisent le périmètre (catalogue perso, entraînement…)
// dans lequel la musique a été tirée, pour piocher les distracteurs Carré/Duo dans
// ce même périmètre (sinon la bonne réponse est la seule que le joueur connaît).
function issueRoundToken({ userId, songId, ranked, level = 'cash', startedAt, mode, source, series, playlistId }) {
  return jwt.sign(
    {
      rt: true, uid: userId, sid: songId, ranked: !!ranked, level,
      sat: startedAt || Math.floor(Date.now() / 1000),
      ...(mode ? { mode } : {}),
      ...(source ? { source } : {}),
      ...(series ? { series } : {}),
      ...(playlistId ? { plid: playlistId } : {}), // source 'playlist' : périmètre des distracteurs
      jti: crypto.randomUUID(),
    },
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

// Marque la manche comme jouée (anti-rejeu, store partagé). Retourne false si déjà jouée.
async function consumeRound(payload) {
  if (!payload?.jti) return false;
  const ttl = payload.exp ? Math.max(1, payload.exp - Math.floor(Date.now() / 1000)) : 1800;
  return store.setIfAbsent('rt:' + payload.jti, ttl);
}

module.exports = { issueRoundToken, verifyRoundToken, consumeRound };

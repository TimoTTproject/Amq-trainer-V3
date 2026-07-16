// Store clé-valeur partagé avec TTL.
// Utilise Redis si REDIS_URL est défini (robuste aux redéploiements + multi-instance),
// sinon repli automatique sur une Map en mémoire (dev / mono-instance).
let redis = null;
const mem = new Map(); // key -> { exp, n }

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', (e) => console.error('Redis:', e.message));
    redis.on('connect', () => console.log('  → Redis connecté (store partagé)'));
  } catch (e) {
    console.warn('ioredis indisponible → repli mémoire :', e.message);
    redis = null;
  }
}

// Nettoyage périodique du repli mémoire
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of mem) if (e.exp && e.exp < now) mem.delete(k);
}, 60000).unref?.();

// Pose une clé seulement si absente (NX), avec TTL en secondes.
// Retourne true si elle vient d'être posée (= « première fois »), false sinon.
async function setIfAbsent(key, ttlSec) {
  if (redis) {
    const r = await redis.set(key, '1', 'EX', Math.max(1, ttlSec), 'NX');
    return r === 'OK';
  }
  const now = Date.now();
  const e = mem.get(key);
  if (e && (!e.exp || e.exp > now)) return false;
  mem.set(key, { exp: now + ttlSec * 1000 });
  return true;
}

// Incrémente un compteur (TTL posé au premier hit). Retourne la valeur courante.
async function incr(key, ttlSec) {
  if (redis) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, Math.max(1, ttlSec));
    return n;
  }
  const now = Date.now();
  let e = mem.get(key);
  if (!e || (e.exp && e.exp < now)) { e = { exp: now + ttlSec * 1000, n: 0 }; mem.set(key, e); }
  e.n = (e.n || 0) + 1;
  return e.n;
}

async function incrBy(key, amount, ttlSec) {
  const delta=Math.max(0,Math.floor(Number(amount)||0));
  if(redis){const n=await redis.incrby(key,delta);if(n===delta)await redis.expire(key,Math.max(1,ttlSec));return n;}
  const now=Date.now();let e=mem.get(key);
  if(!e||(e.exp&&e.exp<now)){e={exp:now+ttlSec*1000,n:0};mem.set(key,e);}
  e.n=(e.n||0)+delta;return e.n;
}

// Verrou distribué court. Le token empêche une requête expirée de libérer le
// verrou acquis entre-temps par une autre requête.
async function acquireLock(key, ttlMs = 30000) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (redis) {
    const result = await redis.set(key, token, 'PX', Math.max(1000, ttlMs), 'NX');
    return result === 'OK' ? token : null;
  }
  const now = Date.now();
  const existing = mem.get(key);
  if (existing && (!existing.exp || existing.exp > now)) return null;
  mem.set(key, { exp: now + Math.max(1000, ttlMs), token });
  return token;
}

async function releaseLock(key, token) {
  if (!token) return;
  if (redis) {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
    return;
  }
  const existing = mem.get(key);
  if (existing?.token === token) mem.delete(key);
}

function redisEnabled() { return !!redis; }

module.exports = { setIfAbsent, incr, incrBy, acquireLock, releaseLock, redisEnabled };

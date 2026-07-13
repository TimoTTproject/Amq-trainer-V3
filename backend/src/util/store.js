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

function redisEnabled() { return !!redis; }

module.exports = { setIfAbsent, incr, incrBy, redisEnabled };

// Harnais de test des routes API — sans base de données ni navigateur.
//
// Principe : `src/db.js` exporte un singleton `{ prisma }` que toutes les routes
// importent. On injecte ici un FAUX prisma dans le cache require AVANT de charger
// le moindre module de route → aucune connexion Postgres n'est tentée, et chaque
// test stubbe exactement les méthodes dont sa route a besoin :
//
//   const { createApp, fakePrisma } = require('./helpers/api');
//   const prisma = fakePrisma();            // installe le fake (idempotent)
//   prisma.user.findUnique = async () => …  // stub par test
//   const app = await createApp((r) => r.use('/api/shop', require('../src/shop/shop.routes').router));
//   const res = await app.request('/api/shop', { cookie: app.authCookie('u1') });
//
// Les méthodes non stubbées lèvent une erreur explicite (pas d'échec silencieux).

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Un secret déterministe AVANT tout require de src/util/env (lu à l'import).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.SKIP_BACKGROUND_REFRESH = 'true';

const DB_PATH = path.join(__dirname, '..', '..', 'src', 'db.js');

function buildFakePrisma() {
  const models = new Map();
  const modelProxy = (name) => {
    const stubs = {};
    return new Proxy(stubs, {
      get(t, method) {
        if (method in t) return t[method];
        if (typeof method !== 'string') return undefined;
        return () => {
          throw new Error(`prisma.${name}.${method} appelé mais non stubbé dans ce test`);
        };
      },
    });
  };
  const base = {
    // Forme tableau : les promesses sont déjà lancées → on attend tout.
    // Forme callback : on repasse le fake en guise de client transactionnel.
    $transaction: async (arg) => (Array.isArray(arg) ? Promise.all(arg) : arg(fake)),
    $disconnect: async () => {},
  };
  const fake = new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string' || prop.startsWith('$')) return t[prop];
      if (!models.has(prop)) models.set(prop, modelProxy(prop));
      return models.get(prop);
    },
  });
  return fake;
}

// Installe (une fois) le fake dans le cache require, à la place du vrai client.
function fakePrisma() {
  const cached = require.cache[DB_PATH];
  if (cached && cached.exports.__fake) return cached.exports.prisma;
  const prisma = buildFakePrisma();
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: { prisma, __fake: true },
  };
  return prisma;
}

// Monte une app Express minimale reproduisant la vraie chaîne de middlewares
// (json + cookies + attachUser + handler d'erreurs) et l'écoute sur un port
// éphémère. `mount(app)` branche les routers à tester.
async function createApp(mount) {
  fakePrisma(); // garantit le fake même si le test a oublié de l'appeler d'abord
  const { attachUser } = require('../../src/auth/auth.middleware');
  const { signToken, COOKIE_NAME } = require('../../src/auth/jwt');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(attachUser);
  mount(app);
  // Même contrat qu'en prod : JSON générique, jamais de stack au client.
  // DEBUG_TEST_ERRORS=1 imprime la stack — indispensable pour diagnostiquer
  // un 500 inattendu dans un test de route (sinon avalé en silence).
  app.use((err, req, res, next) => {
    if (process.env.DEBUG_TEST_ERRORS) console.error('[test 500]', req.method, req.originalUrl, '\n', err && (err.stack || err));
    if (res.headersSent) return;
    res.status(500).json({ error: 'Erreur serveur. Réessaie dans un instant.' });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    // Cookie d'auth signé pour un userId arbitraire (attachUser fera le lookup).
    authCookie: (userId) => `${COOKIE_NAME}=${signToken({ sub: userId })}`,
    async request(pathname, { method = 'GET', body, cookie } = {}) {
      const res = await fetch(base + pathname, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* réponse non-JSON */ }
      return { status: res.status, json, headers: res.headers };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { fakePrisma, createApp };

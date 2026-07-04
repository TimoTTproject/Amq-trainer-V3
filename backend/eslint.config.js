// ESLint (flat config) — ciblé « vrais bugs », pas le style.
//
// Particularité du projet : le front (public/) = scripts classiques à SCOPE
// GLOBAL PARTAGÉ (pas de modules ES). Les identifiants d'un fichier sont
// utilisés par les autres → `no-undef` et `no-unused-vars` y produiraient des
// centaines de faux positifs. On les coupe pour public/ uniquement : la
// cohérence inter-fichiers y est déjà couverte par scripts/static-checks.js
// (syntaxe + redéclarations), et les règles anti-bug restantes s'appliquent.
const js = require('@eslint/js');

module.exports = [
  { ignores: ['node_modules/**', 'public/legacy/**', 'prisma/**'] },

  // Backend Node (CommonJS) : src, scripts, test — règles recommandées complètes.
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        clearTimeout: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Response: 'readonly', Request: 'readonly', Headers: 'readonly',
        Blob: 'readonly', FormData: 'readonly',
        AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly', crypto: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // `catch {}` volontaires (repli silencieux documenté) et args d'API non
      // utilisés (ex. `next` d'Express) : autorisés via préfixe _ ou vide.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Pattern défensif volontaire partout dans le code : `let x = repli;
      // try { x = … } catch { … }` → l'initialiseur « inutile » est un filet.
      'no-useless-assignment': 'off',
    },
  },

  // Front navigateur à scope global partagé.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off', // globals inter-fichiers → faux positifs (voir en-tête)
      'no-unused-vars': 'off', // fonctions consommées par les autres fichiers
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off', // même pattern défensif que côté serveur
      // `no-redeclare` d'ESLint est intra-fichier ; l'inter-fichiers est géré
      // par scripts/static-checks.js.
    },
  },
];

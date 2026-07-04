#!/usr/bin/env node
// Checks statiques rapides, sans navigateur ni base de données. Comble deux trous
// que `npm test` (logique pure) ne couvre pas :
//   1. SYNTAXE de TOUS les .js — y compris les modules front lazy-loadés
//      (gacha.js, mp-client.js…) et les fichiers de routes serveur, qui ne sont
//      jamais `require`d par les tests → un typo y partirait en prod sans alerte.
//   2. REDÉCLARATIONS entre fichiers front à SCOPE GLOBAL PARTAGÉ. Ces scripts
//      sont injectés en <script> classiques (pas de modules ES) : un même
//      `const`/`let`/`class` déclaré dans deux fichiers = SyntaxError au runtime,
//      invisible côté CI. Cf. la note « scope global partagé » dans les modules.
//
// Usage : node scripts/static-checks.js  (exit ≠ 0 si un problème est trouvé)

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_DIRS = ['src', 'public', 'scripts', 'test'];
const EXCLUDE_DIRS = new Set(['node_modules', 'legacy']);

// Fichiers navigateur chargés dans un MÊME scope global (index.html + lazy-load
// via ensureAppReady dans main.js). sw.js (service worker) a son propre scope,
// donc il est exclu du contrôle de redéclaration.
const BROWSER_BUNDLE = [
  'public/i18n.js', 'public/sfx.js', 'public/main.js',
  'public/tower.js', 'public/admin.js', 'public/playlist.js', 'public/daily.js',
  'public/gacha.js', 'public/catalog.js', 'public/community.js', 'public/profile.js',
  'public/anime-autocomplete.js', 'public/mp-client.js',
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Remplace le contenu des commentaires et des chaînes par des espaces, en
// préservant les sauts de ligne (les numéros de ligne restent justes). Évite de
// prendre un `const` situé dans un commentaire ou une chaîne pour une déclaration.
function blankCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  const keepNewlines = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i + 2;
      while (j < n && code[j] !== '\n') j++;
      out += '  ' + keepNewlines(code.slice(i + 2, j));
      i = j;
    } else if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j = Math.min(j + 2, n);
      out += '  ' + keepNewlines(code.slice(i + 2, j));
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j++; break; }
        j++;
      }
      out += ' ' + keepNewlines(code.slice(i + 1, Math.min(j, n) - 1)) + ' ';
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Déclarations de haut niveau = commençant en colonne 0 (ces fichiers indentent
// tout ce qui est imbriqué). On retient le type pour appliquer la vraie règle JS :
// une déclaration lexicale (let/const/class) entre en conflit avec TOUTE autre
// déclaration du même nom ; deux var/function ensemble sont légales.
const DECL_RE = /^(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

function collectDeclarations(relFile) {
  const code = blankCommentsAndStrings(fs.readFileSync(path.join(ROOT, relFile), 'utf8'));
  const decls = [];
  const lines = code.split('\n');
  for (let l = 0; l < lines.length; l++) {
    const m = DECL_RE.exec(lines[l]);
    if (!m) continue;
    const kind = m[1].includes('function') ? 'function' : m[1];
    decls.push({ name: m[2], kind, file: relFile, line: l + 1 });
  }
  return decls;
}

function main() {
  const files = SRC_DIRS
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => walk(d, []))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

  const errors = [];

  // 1. Contrôle de syntaxe (équivaut à `node --check`, sans exécuter le code).
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    try {
      new vm.Script(code, { filename: rel });
    } catch (e) {
      errors.push(`SYNTAXE  ${rel}: ${e.message}`);
    }
  }

  // 2. Redéclarations dans le scope global partagé du front.
  const byName = new Map();
  for (const rel of BROWSER_BUNDLE) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      errors.push(`BUNDLE   ${rel}: fichier introuvable (mettre à jour BROWSER_BUNDLE ?)`);
      continue;
    }
    for (const d of collectDeclarations(rel)) {
      if (!byName.has(d.name)) byName.set(d.name, []);
      byName.get(d.name).push(d);
    }
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    // Conflit uniquement si au moins une déclaration est lexicale (let/const/class).
    // Plusieurs var/function du même nom sont autorisées en scope global.
    if (!list.some((d) => d.kind === 'const' || d.kind === 'let' || d.kind === 'class')) continue;
    const where = list.map((d) => `${d.file}:${d.line} (${d.kind})`).join(', ');
    errors.push(`REDECL   « ${name} » déclaré ${list.length}× dans le scope partagé : ${where}`);
  }

  if (errors.length) {
    console.error(`\n✗ Checks statiques : ${errors.length} problème(s)\n`);
    for (const e of errors) console.error('  ' + e);
    console.error('');
    process.exit(1);
  }
  const declCount = [...byName.values()].reduce((s, l) => s + l.length, 0);
  console.log(
    `✓ Checks statiques OK — ${files.length} fichier(s) syntaxiquement valides, ` +
    `${declCount} déclaration(s) de haut niveau uniques dans le bundle front.`
  );
}

main();

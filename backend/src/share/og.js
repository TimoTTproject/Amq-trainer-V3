// Aperçus de partage : injection de balises Open Graph / Twitter personnalisées
// dans le HTML de la SPA, pour que les liens partagés affichent une vraie carte
// (les crawlers Discord/Twitter/Facebook lisent le HTML, pas le JS).
const fs = require('fs');
const path = require('path');

let cachedHtml = null;
function indexHtml() {
  if (cachedHtml == null) {
    cachedHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  }
  return cachedHtml;
}

// Identifiant de ce déploiement : le SHA du commit sur Railway (variable
// standard des plateformes Nixpacks/Railway), sinon l'heure de démarrage du
// process en local/repli. Sert à « casser le cache » des scripts statiques
// (cf. versionize) — sans lui, un navigateur (ou un cache intermédiaire type
// Cloudflare) peut continuer à servir un ancien main.js/gacha.js après un
// déploiement malgré les en-têtes Cache-Control de l'origine, ce qui a déjà
// fait croire à des fixes "qui ne marchent pas" alors qu'ils étaient corrects
// côté code mais pas encore vus par le navigateur.
const BUILD_ID = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || String(Date.now());

// Ajoute ?v=BUILD_ID aux scripts/styles LOCAUX (chemin relatif sans domaine :
// styles.css, main.js…) référencés dans le HTML — jamais aux URLs absolues
// (fonts Google, cdnjs) ni à sw.js (enregistré par JS via une URL stable,
// pas par une balise <script> — le versionner casserait sa mise à jour).
function versionize(html) {
  return html
    .replace(/(src|href)="([\w.-]+\.js)"/g, `$1="$2?v=${BUILD_ID}"`)
    .replace(/(src|href)="([\w.-]+\.css)"/g, `$1="$2?v=${BUILD_ID}"`)
    .replace(/window\.BUILD_ID\s*=\s*"[^"]*"/, `window.BUILD_ID = "${BUILD_ID}"`);
}

// Échappe pour une valeur d'attribut HTML / le contenu de <title>.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setMeta(html, selectorAttr, key, value) {
  const re = new RegExp(`(<meta\\s+${selectorAttr}="${key}"\\s+content=")[^"]*(")`, 'i');
  return html.replace(re, `$1${value}$2`);
}

// Remplace titre + descriptions + URL de partage. `title`/`description` sont bruts
// (échappés ici). Renvoie le HTML modifié.
function injectMeta(html, { title, description, url } = {}) {
  let out = html;
  if (title) {
    const t = esc(title);
    out = out.replace(/<title>[^<]*<\/title>/i, `<title>${t}</title>`);
    out = setMeta(out, 'property', 'og:title', t);
    out = setMeta(out, 'name', 'twitter:title', t);
  }
  if (description) {
    const d = esc(description);
    out = setMeta(out, 'property', 'og:description', d);
    out = setMeta(out, 'name', 'twitter:description', d);
    out = setMeta(out, 'name', 'description', d);
  }
  if (url) out = setMeta(out, 'property', 'og:url', esc(url));
  return out;
}

module.exports = { indexHtml, injectMeta, esc, versionize, BUILD_ID };

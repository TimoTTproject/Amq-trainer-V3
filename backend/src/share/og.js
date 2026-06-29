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

module.exports = { indexHtml, injectMeta, esc };

// i18n minimal (fondation). Le FRANÇAIS est la langue source : le texte par
// défaut est dans le HTML, et `data-i18n="<texte FR>"` sert de clé. t() renvoie
// la traduction EN si dispo, sinon le texte FR (repli gracieux). Les contenus
// rendus dynamiquement en JS restent en FR tant qu'ils ne passent pas par t().
let LANG = localStorage.getItem('amq_lang') || 'fr';

const I18N = {
  en: {
    // Navigation
    'Accueil': 'Home', 'Jouer': 'Play', 'Collection': 'Collection',
    'Communauté': 'Community', 'Admin': 'Admin',
    // Écran de connexion
    "Reconnais l'anime.": 'Name the anime.',
    'Dès la première note.': 'From the very first note.',
    "Openings, endings, duel entre amis et collection. Pas de blabla : lance un extrait et joue.":
      'Openings, endings, duels with friends and a card collection. No fluff — hit play and guess.',
    'Solo & multi': 'Solo & multiplayer',
    'Openings + endings': 'Openings + endings',
    'Cartes à collectionner': 'Collectible cards',
    'Classement': 'Leaderboard',
    'Règles & crédits': 'Rules & credits',
    'ESPACE JOUEUR': 'PLAYER AREA',
    'Connexion sécurisée': 'Secure sign-in',
    'Connexion': 'Sign in',
    'Inscription': 'Sign up',
    'Entrer dans le jeu': 'Enter the game',
    'Créer un compte': 'Create account',
    'ou continuer avec': 'or continue with',
    'Connexion externe non configurée (voir': 'External sign-in not configured (see',
    // Placeholders
    'Email': 'Email',
    'Mot de passe': 'Password',
    'Pseudo (optionnel)': 'Username (optional)',
    'Mot de passe (min. 6)': 'Password (min. 6)',
  },
};

function currentLang() { return LANG; }

function t(s) {
  if (LANG !== 'fr' && I18N[LANG] && I18N[LANG][s] != null) return I18N[LANG][s];
  return s;
}

// Traduit tous les éléments tagués dans `root` (texte, placeholder).
function translatePage(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  r.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
}

function updateLangToggle() {
  document.querySelectorAll('.lang-toggle').forEach((b) => { b.textContent = LANG === 'fr' ? 'EN' : 'FR'; });
}

function setLang(l) {
  LANG = l === 'en' ? 'en' : 'fr';
  localStorage.setItem('amq_lang', LANG);
  document.documentElement.lang = LANG;
  translatePage();
  updateLangToggle();
}

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.lang = LANG;
  translatePage();
  updateLangToggle();
  document.querySelectorAll('.lang-toggle').forEach((b) =>
    b.addEventListener('click', () => setLang(LANG === 'fr' ? 'en' : 'fr'))
  );
});

// Exposé pour les autres scripts (traduction de chaînes dynamiques au besoin).
window.t = t;
window.currentLang = currentLang;
window.translatePage = translatePage;

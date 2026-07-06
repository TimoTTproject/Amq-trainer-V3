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
    'Mot de passe (min. 8)': 'Password (min. 8)',
    // Accueil
    'Bienvenue,': 'Welcome,',
    'Que veux-tu faire ?': 'What do you want to do?',
    'Partager le jeu': 'Share the game',
    'Règles': 'Rules',
    // Hub Jouer
    'Choisis ton mode de jeu.': 'Choose your game mode.',
    'Quiz classique': 'Classic quiz',
    "Devine l'anime, gagne des tokens": 'Guess the anime, earn tokens',
    'Coop · Tour en équipe': 'Co-op · Team tower',
    'NOUVEAU': 'NEW',
    'Montez le plus haut possible ensemble — vies partagées, étages infinis':
      'Climb as high as you can together — shared lives, endless floors',
    'Entraînement': 'Training',
    'Révise sans pression (séries, répétition espacée)': 'Practice with no stakes (series, spaced repetition)',
    "Château de l'Infini": 'The Infinite Castle',
    'QCM en survie : 3 vies, monte le plus haut possible': 'Survival multiple-choice: 3 lives, climb as high as you can',
    'Multijoueur': 'Multiplayer',
    "Affronte d'autres joueurs en temps réel": 'Face other players in real time',
    'Défi du jour': 'Daily challenge',
    'Classé solo : mêmes chansons pour tous, 1 essai, MMR': 'Solo ranked: same songs for everyone, 1 try, MMR',
    'Épingler dans le menu': 'Pin to menu',
    // Hub Collection
    'Tes cartes, ton style et ton catalogue.': 'Your cards, your style, your catalog.',
    'Gacha': 'Gacha',
    'Dépense tes tokens pour collectionner des cartes': 'Spend your tokens to collect cards',
    'Boutique': 'Shop',
    'Cosmétiques : dos de cartes, bordures, bannières': 'Cosmetics: card backs, borders, banners',
    'Atelier': 'Workshop',
    'Fabrique les cartes qui te manquent avec ta poussière 🌟': "Craft the cards you're missing with your dust 🌟",
    'Catalogue': 'Catalog',
    'Parcours tous les openings (anime, titre, artiste)': 'Browse every opening (anime, title, artist)',
    'Playlist': 'Playlist',
    'Favoris likés et listes thématiques à partager': 'Liked favorites and shareable themed lists',
    // Hub Communauté
    'Tes amis, les classements et tous les joueurs.': 'Your friends, the leaderboards and every player.',
    'Amis': 'Friends',
    'Ajoute des amis, vois qui est en ligne, invite en partie': 'Add friends, see who\'s online, invite them to play',
    'Classé, Château, Collection — qui domine ?': 'Ranked, Castle, Collection — who\'s on top?',
    'Joueurs': 'Players',
    'Parcours tous les joueurs et visite leurs profils': "Browse every player and visit their profile",
    'Échanges': 'Trades',
    'Propose et reçois des échanges de cartes': 'Send and receive card trade offers',
    'Rejoins-nous': 'Join us',
    'Entraide, retours, annonces — toute la communauté est là-bas': 'Help, feedback, announcements — the whole community is there',
  },
};

function currentLang() { return LANG; }

function t(s) {
  if (LANG !== 'fr' && I18N[LANG] && I18N[LANG][s] != null) return I18N[LANG][s];
  return s;
}

// Traduit tous les éléments tagués dans `root` (texte, placeholder, title).
function translatePage(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  r.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  r.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
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

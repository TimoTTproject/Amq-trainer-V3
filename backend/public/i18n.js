// i18n minimal (fondation). Le FRANÇAIS est la langue source : le texte par
// défaut est dans le HTML, et `data-i18n="<texte FR>"` sert de clé. t() renvoie
// la traduction EN si dispo, sinon le texte FR (repli gracieux). Les contenus
// rendus dynamiquement en JS restent en FR tant qu'ils ne passent pas par t().
let LANG = localStorage.getItem('amq_lang') || 'fr';

const I18N = {
  en: {
    // Navigation
    'Accueil': 'Home', 'Jouer': 'Play', 'Collection': 'Collection', 'Extras': 'Extras',
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
    // Hub Gacha
    'Dépense tes tokens, complète ta collection et fais vivre tes albums.': 'Spend your tokens, complete your collection and bring your albums to life.',
    'Gacha': 'Gacha',
    'Tirage': 'Pull',
    'Dépense tes tokens pour collectionner des cartes': 'Spend your tokens to collect cards',
    'Ma collection': 'My collection',
    'Toutes tes cartes possédées, triées et filtrées': 'All your owned cards, sorted and filtered',
    'Vedettes & vote': 'Featured & vote',
    'Personnages en vedette et vote hebdomadaire de la communauté': 'Featured characters and the community\'s weekly vote',
    'Par série': 'By series',
    'Ta progression de collection, anime par anime': 'Your collection progress, anime by anime',
    'Albums': 'Albums',
    'Compose et partage des albums thématiques de tes cartes': 'Build and share themed albums of your cards',
    // Hub Extras
    'Cosmétiques, fusion de doublons, catalogue et playlists.': 'Cosmetics, duplicate fusion, catalog and playlists.',
    'Boutique': 'Shop',
    'Cosmétiques : dos de cartes, bordures, bannières': 'Cosmetics: card backs, borders, banners',
    'Atelier': 'Workshop',
    'Fusionne 3 exemplaires possédés pour 1 carte aléatoire de la même rareté': 'Fuse 3 owned copies for 1 random card of the same rarity',
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
    // Boucle de quiz (chaînes dynamiques, via t())
    'Chargement…': 'Loading…',
    'Chargement du son…': 'Loading the song…',
    "🎵 Devine l'anime à partir de l'extrait.": '🎵 Guess the anime from the clip.',
    '⏱ Temps écoulé !': '⏱ Time is up!',
    'Bonne réponse !': 'Correct!',
    '❌ Raté': '❌ Missed',
    '🎓 Réponse révélée (entraînement)': '🎓 Answer revealed (practice)',
    'Manche suivante': 'Next round',
    'Nouvelle partie': 'New game',
    'Extrait terminé': 'Clip finished',
    'Propose une réponse ou passe': 'Submit an answer or skip',
    '▶ Lecture bloquée par le navigateur — clique sur le bouton lecture.': '▶ Playback blocked by the browser — press the play button.',
    '▶ Son prêt — appuie sur lecture pour démarrer.': '▶ Song ready — press play to start.',
    '⚠️ Le son ne charge pas. Clique sur réécouter pour relancer.': "⚠️ The song won't load. Click replay to retry.",
    'Noté ✓ — clique sur « Manche suivante » pour continuer.': 'Saved ✓ — click “Next round” to continue.',
    'Rejeu : gain réduit (anti-farm)': 'Replay: reduced reward (anti-farm)',
    'Artiste inconnu': 'Unknown artist',
    'Historique de la session': 'Session history',
    'Thème clair': 'Light theme',
    'Thème sombre': 'Dark theme',
    'Réponse :': 'Answer:',
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

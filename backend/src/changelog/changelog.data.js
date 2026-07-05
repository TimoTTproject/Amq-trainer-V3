// Journal des nouveautés — maintenu à la main à chaque livraison (feature/fix/
// amélioration livrée en prod). Le plus récent en premier. `id` doit être
// stable et croissant (sert de repère « déjà vu » côté client, cf. localStorage
// amq_changelog_seen). tag ∈ 'feature' | 'improvement' | 'fix'.
const ENTRIES = [
  {
    id: 36, date: '2026-07-05', tag: 'fix',
    title: 'Recommandations plus variées, playlists sans doublon',
    description: "Les recommandations excluent maintenant les morceaux déjà suggérés récemment (au lieu de les remontrer quand même) pour proposer de vraies nouveautés. Impossible aussi d'ajouter deux fois le même morceau à une playlist, même quand le catalogue le liste sous deux fiches différentes.",
  },
  {
    id: 35, date: '2026-07-05', tag: 'improvement',
    title: 'Le craft respecte maintenant le tirage',
    description: "Un personnage doit avoir été obtenu au moins une fois par tirage (par n'importe quel joueur) avant de pouvoir être fabriqué en poussière — plus de personnage qui n'existerait que par craft.",
  },
  {
    id: 34, date: '2026-07-05', tag: 'feature',
    title: 'Quêtes du jour toujours accessibles',
    description: "Un bouton dans l'en-tête (🎯) ouvre tes quêtes du jour et te laisse réclamer tes récompenses sans quitter l'écran où tu es — plus besoin de revenir sur l'Accueil.",
  },
  {
    id: 33, date: '2026-07-05', tag: 'improvement',
    title: 'Un vote de vedette par rareté',
    description: "Le vote de vedette se sépare maintenant en 3 petits cadres (Mythique / Légendaire / Épique) : tu votes une fois par catégorie, et chacune élit sa propre vedette la semaine suivante.",
  },
  {
    id: 32, date: '2026-07-05', tag: 'improvement',
    title: 'Bannière vedette : reset le lundi à minuit + rate-up optionnel',
    description: "La rotation de la bannière tombe désormais pile le lundi à minuit (heure de Paris) au lieu d'un décalage arbitraire. Tu peux aussi choisir d'utiliser ou non son rate-up sur tes tirages, via un interrupteur sous la bannière.",
  },
  {
    id: 31, date: '2026-07-05', tag: 'improvement',
    title: 'Vote de la vedette : un vrai sondage',
    description: "Fini le vote ouvert sur n'importe quel personnage : chaque semaine, une sélection de candidats épiques/légendaires/mythiques (différente pour chaque joueur) t'est proposée, et la vedette suivante est tirée au sort au prorata des votes reçus. Le compte à rebours est aussi mieux placé dans le panneau.",
  },
  {
    id: 30, date: '2026-07-05', tag: 'feature',
    title: 'Nouvelle identité visuelle AMQTrainer',
    description: "Nouveau logo, favicon et palette (rouge/cyan) sur tout le site : en-tête, écran de connexion, icônes PWA et aperçu de partage.",
  },
  {
    id: 29, date: '2026-07-05', tag: 'feature',
    title: 'Menu latéral personnalisable',
    description: "La navigation passe en menu latéral, et tu peux épingler jusqu'à 8 raccourcis (Classement, Gacha, Amis…) depuis Jouer/Collection/Communauté pour les retrouver directement dans ta sidebar.",
  },
  {
    id: 28, date: '2026-07-05', tag: 'feature',
    title: "Qui a ajouté ce son au catalogue ?",
    description: "Chaque opening/ending affiche maintenant le joueur qui l'a fait entrer dans le catalogue via son import AniList — visible dans le Catalogue et à la révélation de chaque manche en multijoueur.",
  },
  {
    id: 27, date: '2026-07-05', tag: 'improvement',
    title: "Numéros de saison dans les propositions du quiz",
    description: "Les choix (Carré/Duo) et l'autocomplétion affichent un repère S1/S2… quand une chaîne de saisons est détectée, et préfèrent le titre anglais quand il existe — Kaguya-sama S1/S2 ne se confondent plus.",
  },
  {
    id: 26, date: '2026-07-05', tag: 'improvement',
    title: "Accueil : le catalogue en chiffres",
    description: "Nouvelle section mettant en avant les sons les plus difficiles, les plus faciles et les plus joués, tous joueurs confondus.",
  },
  {
    id: 25, date: '2026-07-05', tag: 'improvement',
    title: "Ajouter un ami directement depuis un profil",
    description: "Bouton « Ajouter en ami » sur toute fiche publique, à côté de « Proposer un échange » — plus besoin de passer par Communauté → Amis → recherche.",
  },
  {
    id: 24, date: '2026-07-05', tag: 'fix',
    title: "Multijoueur : le vote pour passer un son exigeait un vote de trop peu",
    description: "À 2 joueurs, un seul vote suffisait à écourter la manche unilatéralement. Le vote-skip demande maintenant une vraie majorité (les deux joueurs à 2, 2 sur 3, etc.).",
  },
  {
    id: 23, date: '2026-07-05', tag: 'fix',
    title: "Consulter un profil en multijoueur ne quitte plus la partie",
    description: "Cliquer sur un joueur du salon ou sur « ajouté par » à la révélation ouvre sa fiche en fenêtre, sans jamais donner l'impression d'avoir quitté la partie en cours.",
  },
  {
    id: 22, date: '2026-07-04', tag: 'feature',
    title: 'Mes listes : des playlists à partager entre joueurs',
    description: "Crée des listes thématiques (nom, description, publique ou privée), parcours celles des autres joueurs dans l'onglet Découvrir, et clone-les dans ton compte. Importe aussi ta playlist de favoris en un clic.",
  },
  {
    id: 21, date: '2026-07-04', tag: 'improvement',
    title: 'Playlist : vraies jaquettes AniList et volume intégré',
    description: 'Chaque son affiche la jaquette officielle de son anime (identité visuelle par licence) au lieu de simples pastilles, et un curseur de volume est accessible directement dans le lecteur.',
  },
  {
    id: 20, date: '2026-07-04', tag: 'improvement',
    title: 'Recommandations de playlist moins répétitives',
    description: "Les suggestions tournent maintenant d'une visite à l'autre au lieu de rester figées sur le même top fixe. « Pas intéressé » continue d'exclure un son pour toujours.",
  },
  {
    id: 19, date: '2026-07-04', tag: 'fix',
    title: 'Catalogue : moins de faux positifs (OAV, versions polluées)',
    description: "Les openings/endings de films, OAV et spéciaux sont désormais mieux exclus des modes classiques, et l'import évite les versions avec dialogues par-dessus la musique.",
  },
  {
    id: 18, date: '2026-07-04', tag: 'improvement',
    title: 'Coop : openings uniquement, catalogue global imposé',
    description: "La Tour en équipe ne pioche plus que des openings sur le catalogue global (plus de choix de pool). L'étage record affiché est désormais l'étage réellement atteint.",
  },
  {
    id: 17, date: '2026-07-04', tag: 'fix',
    title: 'Multijoueur : plus de partie figée en pleine manche',
    description: "Un pépin serveur ou une reconnexion ne bloque plus la partie indéfiniment — le jeu se rattrape tout seul ou te ramène proprement au menu avec un message clair.",
  },
  {
    id: 16, date: '2026-07-04', tag: 'feature',
    title: 'Multijoueur : qui connaissait déjà cet anime ?',
    description: "À la révélation de chaque manche, un indicateur 👁 montre quels joueurs avaient cet anime dans leur liste AniList.",
  },
  {
    id: 15, date: '2026-07-04', tag: 'fix',
    title: "La migration du stockage audio ne s'arrête plus toute seule",
    description: "Elle reprend automatiquement après chaque mise à jour du site et retente les fichiers en échec par vagues au lieu d'abandonner.",
  },
  {
    id: 14, date: '2026-07-03', tag: 'feature',
    title: 'Le Défi du jour et le multijoueur au clavier',
    description: 'QCM jouable au clavier (touches 1 à 9), Échap pour passer une manche.',
  },
  {
    id: 13, date: '2026-07-03', tag: 'improvement',
    title: 'Page Économie : vois où vont tes tokens',
    description: 'Nouvelle page dédiée au solde, aux gains de chaque mode et à tes plafonds anti-farm en cours.',
  },
  {
    id: 12, date: '2026-07-01', tag: 'fix',
    title: 'Corrections diverses : import AniList, doublons de recommandations',
    description: "Neuf retours joueurs corrigés d'un coup : import AniList plus fiable, doublons de recommandations éliminés, matching amélioré sur plusieurs franchises.",
  },
];

function listEntries(limit) {
  const sorted = [...ENTRIES].sort((a, b) => b.id - a.id);
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

module.exports = { ENTRIES, listEntries };

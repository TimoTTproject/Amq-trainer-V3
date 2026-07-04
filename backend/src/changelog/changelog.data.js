// Journal des nouveautés — maintenu à la main à chaque livraison (feature/fix/
// amélioration livrée en prod). Le plus récent en premier. `id` doit être
// stable et croissant (sert de repère « déjà vu » côté client, cf. localStorage
// amq_changelog_seen). tag ∈ 'feature' | 'improvement' | 'fix'.
const ENTRIES = [
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

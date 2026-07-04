-- Le gain réduit anti-farm doit sanctionner uniquement le rejeu en mode classé,
-- pas les bonnes réponses données en entraînement (qui utilisaient jusqu'ici le
-- même compteur "correctCount" et déclenchaient le gain réduit à tort).
ALTER TABLE "UserSongStat" ADD COLUMN "rankedCorrectCount" INTEGER NOT NULL DEFAULT 0;

-- Rétro-remplissage best-effort : les stats existantes ne distinguent pas
-- classé/entraînement, donc on part de l'hypothèse la plus favorable au joueur
-- (aucun historique classé connu) plutôt que de pénaliser les parties déjà en cours.

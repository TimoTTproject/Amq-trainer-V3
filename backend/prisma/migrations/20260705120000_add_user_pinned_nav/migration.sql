-- Raccourcis épinglés par le joueur dans le menu latéral (ex. "leaderboard",
-- "gacha"). Tableau vide par défaut = sidebar inchangée (4 items racine).
ALTER TABLE "User" ADD COLUMN "pinnedNav" TEXT[] NOT NULL DEFAULT '{}';

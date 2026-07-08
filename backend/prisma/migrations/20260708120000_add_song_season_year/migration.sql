-- Année de diffusion AniList (seasonYear sinon startDate.year) pour le filtre
-- par période du quiz. 0 = inconnue côté AniList, NULL = pas encore récupérée
-- (backfill automatique au démarrage, cf. server.js).
ALTER TABLE "Song" ADD COLUMN "seasonYear" INTEGER;

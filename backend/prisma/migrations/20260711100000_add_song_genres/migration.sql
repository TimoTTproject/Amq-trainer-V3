-- Genres AniList par musique (filtre par genre du quiz, stats par genre du
-- profil). genresFetched=false = pas encore récupérés (backfill automatique
-- au démarrage, cf. server.js), à distinguer d'un tableau vide légitime.
ALTER TABLE "Song" ADD COLUMN "genres" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Song" ADD COLUMN "genresFetched" BOOLEAN NOT NULL DEFAULT false;

-- Jaquette AniList par musique (identité visuelle par licence dans la playlist).
-- null = pas encore récupérée, '' = introuvable sur AniList.
ALTER TABLE "Song" ADD COLUMN "coverUrl" TEXT;

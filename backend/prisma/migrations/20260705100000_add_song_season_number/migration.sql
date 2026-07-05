-- Numéro de saison (position dans la chaîne PREQUEL/SEQUEL AniList) pour
-- distinguer les saisons d'une même œuvre dans les propositions du quiz.
-- NULL = pas encore calculé (backfill différé, cf. backfillSeasonsBatch) ;
-- 0 = anime hors chaîne (pas de saison à afficher).
ALTER TABLE "Song" ADD COLUMN "seasonNumber" INTEGER;

-- Anti-répétition des recommandations playlist : date de dernière suggestion.
ALTER TABLE "UserSongStat" ADD COLUMN "recShownAt" TIMESTAMP(3);

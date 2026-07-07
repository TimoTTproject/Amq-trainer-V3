-- Metadonnees AniList du lien joueur -> musique, revelees en multi apres la manche.
ALTER TABLE "UserCatalogEntry" ADD COLUMN "mediaStatus" TEXT;
ALTER TABLE "UserCatalogEntry" ADD COLUMN "mediaScore" DOUBLE PRECISION;

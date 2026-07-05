-- Vote de vedette : un vote par joueur/semaine/rareté au lieu d'un seul vote
-- global par semaine. Backfille la rareté des votes déjà émis depuis le
-- personnage voté, pour ne pas perdre les votes de cette semaine.
ALTER TABLE "FeaturedVote" ADD COLUMN "rarity" TEXT;
UPDATE "FeaturedVote" fv SET "rarity" = c."rarity" FROM "Character" c WHERE c.id = fv."characterId";
ALTER TABLE "FeaturedVote" ALTER COLUMN "rarity" SET NOT NULL;

DROP INDEX "FeaturedVote_userId_week_key";
CREATE UNIQUE INDEX "FeaturedVote_userId_week_rarity_key" ON "FeaturedVote"("userId", "week", "rarity");

-- Magasin clé/valeur générique pour des réglages ponctuels (ex. suppression
-- manuelle de la bannière vedette en cours).
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

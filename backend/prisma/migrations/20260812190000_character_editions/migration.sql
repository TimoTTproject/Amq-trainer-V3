DROP INDEX IF EXISTS "Character_anilistId_key";

CREATE UNIQUE INDEX "Character_anilistId_edition_key"
ON "Character"("anilistId", "edition");

CREATE INDEX "Character_edition_rarity_soldOut_idx"
ON "Character"("edition", "rarity", "soldOut");

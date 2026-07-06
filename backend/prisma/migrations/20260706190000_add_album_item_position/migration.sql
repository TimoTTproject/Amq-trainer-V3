-- Aspect « classeur » : chaque carte occupe un emplacement fixe (9 par page)
-- au lieu d'une simple liste triée — la retirer libère SON emplacement plutôt
-- que de décaler les suivantes.
ALTER TABLE "CardAlbumItem" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill : attribue des emplacements séquentiels aux cartes déjà rangées,
-- dans leur ordre d'ajout actuel.
UPDATE "CardAlbumItem" t
SET "position" = sub.rn - 1
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "albumId" ORDER BY "addedAt" ASC) AS rn
  FROM "CardAlbumItem"
) sub
WHERE t.id = sub.id;

CREATE INDEX "CardAlbumItem_albumId_position_idx" ON "CardAlbumItem"("albumId", "position");

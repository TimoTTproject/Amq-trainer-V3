-- Équipement lié au personnage plutôt qu'à l'emplacement d'équipe : un héros
-- retiré de l'équipe active garde désormais son équipement (réservé) au lieu
-- de le faire hériter au prochain personnage placé dans le même slot.

-- 1) Nouvelle colonne (additive).
ALTER TABLE "IdleItem" ADD COLUMN "equippedCharacterId" INTEGER;

-- 2) Backfill : les objets déjà équipés suivent le personnage actuellement
--    dans leur emplacement — aucune perte d'équipement pour les joueurs.
UPDATE "IdleItem" i
SET "equippedCharacterId" = s."characterId"
FROM "IdleSlot" s
WHERE i."equippedSlotId" = s."id" AND s."characterId" IS NOT NULL;

-- 3) Retire l'ancien lien (FK + index + contrainte unique) puis la colonne.
ALTER TABLE "IdleItem" DROP CONSTRAINT "IdleItem_equippedSlotId_fkey";
DROP INDEX "IdleItem_equippedSlotId_kind_key";
DROP INDEX "IdleItem_equippedSlotId_idx";
ALTER TABLE "IdleItem" DROP COLUMN "equippedSlotId";

-- 4) Nouveau lien sur le personnage : characterId seul n'est pas unique par
--    joueur (catalogue partagé), d'où userId dans la contrainte.
CREATE INDEX "IdleItem_equippedCharacterId_idx" ON "IdleItem"("equippedCharacterId");
CREATE UNIQUE INDEX "IdleItem_userId_equippedCharacterId_kind_key" ON "IdleItem"("userId", "equippedCharacterId", "kind");
ALTER TABLE "IdleItem" ADD CONSTRAINT "IdleItem_equippedCharacterId_fkey" FOREIGN KEY ("equippedCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

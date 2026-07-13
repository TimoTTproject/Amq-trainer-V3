CREATE TABLE "IdleItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "equippedSlotId" INTEGER,
  "kind" TEXT NOT NULL,
  "rarity" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "bonus" DOUBLE PRECISION NOT NULL,
  "effectKey" TEXT NOT NULL,
  "effectValue" DOUBLE PRECISION NOT NULL,
  "sourceWorld" TEXT NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdleItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdleItem_userId_obtainedAt_idx" ON "IdleItem"("userId", "obtainedAt");
CREATE INDEX "IdleItem_equippedSlotId_idx" ON "IdleItem"("equippedSlotId");
CREATE UNIQUE INDEX "IdleItem_equippedSlotId_kind_key" ON "IdleItem"("equippedSlotId", "kind");
ALTER TABLE "IdleItem" ADD CONSTRAINT "IdleItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdleItem" ADD CONSTRAINT "IdleItem_equippedSlotId_fkey" FOREIGN KEY ("equippedSlotId") REFERENCES "IdleSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Convertit les pièces déjà équipées : aucun joueur ne perd son équipement.
INSERT INTO "IdleItem" ("id", "userId", "equippedSlotId", "kind", "rarity", "name", "bonus", "effectKey", "effectValue", "sourceWorld", "locked", "obtainedAt")
SELECT
  CONCAT('legacy_', e."id"), s."userId", e."idleSlotId", e."kind", e."rarity",
  CASE e."kind" WHEN 'weapon' THEN 'Arme du pionnier' WHEN 'relic' THEN 'Relique du pionnier' ELSE 'Talisman du pionnier' END,
  e."bonus",
  CASE e."kind" WHEN 'weapon' THEN 'assault' WHEN 'relic' THEN 'resonance' ELSE 'salvage' END,
  CASE e."kind" WHEN 'weapon' THEN 0.01 WHEN 'relic' THEN 0.01 ELSE 0.05 END,
  'Héritage du Dojo',
  true,
  e."obtainedAt"
FROM "IdleEquipment" e
JOIN "IdleSlot" s ON s."id" = e."idleSlotId";

DELETE FROM "IdleEquipment";

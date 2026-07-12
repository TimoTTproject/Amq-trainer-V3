CREATE TABLE "IdleEquipment" (
  "id" SERIAL NOT NULL,
  "idleSlotId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "rarity" TEXT NOT NULL,
  "bonus" DOUBLE PRECISION NOT NULL,
  "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdleEquipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdleEquipment_idleSlotId_kind_key" ON "IdleEquipment"("idleSlotId", "kind");
CREATE INDEX "IdleEquipment_idleSlotId_idx" ON "IdleEquipment"("idleSlotId");
ALTER TABLE "IdleEquipment" ADD CONSTRAINT "IdleEquipment_idleSlotId_fkey" FOREIGN KEY ("idleSlotId") REFERENCES "IdleSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

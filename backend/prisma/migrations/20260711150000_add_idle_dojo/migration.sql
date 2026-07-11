-- Dojo (idle/clicker) : monnaie "essence" séparée des tokens + emplacements
-- d'entraînement où les personnages possédés génèrent de l'essence en continu.
ALTER TABLE "User" ADD COLUMN "essence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "idleLastCollectAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "User" ADD COLUMN "idleSlotsUnlocked" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "User" ADD COLUMN "idleProdLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "idleClickLevel" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "IdleSlot" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "characterId" INTEGER,
    "assignedAt" TIMESTAMP(3),

    CONSTRAINT "IdleSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdleSlot_userId_slotIndex_key" ON "IdleSlot"("userId", "slotIndex");
CREATE INDEX "IdleSlot_userId_idx" ON "IdleSlot"("userId");

ALTER TABLE "IdleSlot" ADD CONSTRAINT "IdleSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdleSlot" ADD CONSTRAINT "IdleSlot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

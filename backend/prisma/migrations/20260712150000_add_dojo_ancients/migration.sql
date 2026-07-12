-- Dojo : arbre de Prestige permanent ("Ancients"), remplace l'ancien
-- multiplicateur plat de Prestige par des choix stratégiques payés en
-- Sagesse (voir src/idle/idle.js).
ALTER TABLE "User" ADD COLUMN "wisdomPoints" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "AncientLevel" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "ancientKey" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AncientLevel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AncientLevel_userId_ancientKey_key" ON "AncientLevel"("userId", "ancientKey");
CREATE INDEX "AncientLevel_userId_idx" ON "AncientLevel"("userId");

ALTER TABLE "AncientLevel" ADD CONSTRAINT "AncientLevel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

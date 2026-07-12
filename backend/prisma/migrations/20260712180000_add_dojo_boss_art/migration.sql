-- Dojo : cache permanent du portrait IA généré pour le gardien d'un palier
-- de décor (voir POST /api/admin/dojo/generate-boss-art).
CREATE TABLE "DojoBossArt" (
    "id" SERIAL NOT NULL,
    "characterId" INTEGER NOT NULL,
    "theme" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DojoBossArt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DojoBossArt_characterId_theme_key" ON "DojoBossArt"("characterId", "theme");

ALTER TABLE "DojoBossArt" ADD CONSTRAINT "DojoBossArt_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

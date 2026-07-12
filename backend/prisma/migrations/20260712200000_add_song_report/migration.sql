-- Signalement "ce son ne correspond pas" (bouton à côté du ❤ en révélation) —
-- permet de retrouver précisément l'entrée fautive du catalogue au lieu de
-- deviner à l'aveugle sans titre ni id AniList sous les yeux.
CREATE TABLE "SongReport" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "songId" INTEGER NOT NULL,
    "context" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SongReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SongReport_songId_idx" ON "SongReport"("songId");
CREATE INDEX "SongReport_createdAt_idx" ON "SongReport"("createdAt");

ALTER TABLE "SongReport" ADD CONSTRAINT "SongReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SongReport" ADD CONSTRAINT "SongReport_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

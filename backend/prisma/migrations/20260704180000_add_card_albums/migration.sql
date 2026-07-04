-- Albums de cartes nommés, partageables entre joueurs (même principe que Playlist).
CREATE TABLE "CardAlbum" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardAlbum_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CardAlbumItem" (
    "id" SERIAL NOT NULL,
    "albumId" INTEGER NOT NULL,
    "characterId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardAlbumItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CardAlbum_userId_idx" ON "CardAlbum"("userId");
CREATE INDEX "CardAlbum_isPublic_idx" ON "CardAlbum"("isPublic");
CREATE UNIQUE INDEX "CardAlbumItem_albumId_characterId_key" ON "CardAlbumItem"("albumId", "characterId");
CREATE INDEX "CardAlbumItem_albumId_idx" ON "CardAlbumItem"("albumId");

ALTER TABLE "CardAlbum" ADD CONSTRAINT "CardAlbum_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAlbumItem" ADD CONSTRAINT "CardAlbumItem_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "CardAlbum"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAlbumItem" ADD CONSTRAINT "CardAlbumItem_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

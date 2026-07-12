-- Dojo v4 : indépendance totale de la collection gacha. Le Dojo a maintenant
-- son propre roster ("recrutement" contre de l'essence), sans lien avec
-- UserCard/CardInstance/tokens.
CREATE TABLE "DojoRecruit" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" INTEGER NOT NULL,
    "recruitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DojoRecruit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DojoRecruit_userId_characterId_key" ON "DojoRecruit"("userId", "characterId");
CREATE INDEX "DojoRecruit_userId_idx" ON "DojoRecruit"("userId");

ALTER TABLE "DojoRecruit" ADD CONSTRAINT "DojoRecruit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DojoRecruit" ADD CONSTRAINT "DojoRecruit_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

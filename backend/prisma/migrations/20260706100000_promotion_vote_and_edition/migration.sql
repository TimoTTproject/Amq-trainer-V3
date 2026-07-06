-- Édition de carte : les personnages actuels sont l'Édition 1. Une future
-- Édition 2 réutilisera les mêmes personnages (même anilistId) avec une
-- rareté et un visuel différents, comme une carte distincte.
ALTER TABLE "Character" ADD COLUMN "edition" INTEGER NOT NULL DEFAULT 1;

-- Vote « quel personnage promouvoir en Mythique/Légendaire à l'Édition 2 » —
-- 10 personnages distincts max par joueur (contrôlé côté application), 1 voix
-- chacun, tous personnages éligibles.
CREATE TABLE "PromotionVote" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionVote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromotionVote_userId_characterId_key" ON "PromotionVote"("userId", "characterId");
CREATE INDEX "PromotionVote_characterId_idx" ON "PromotionVote"("characterId");

ALTER TABLE "PromotionVote" ADD CONSTRAINT "PromotionVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromotionVote" ADD CONSTRAINT "PromotionVote_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Marché des joueurs : mise en vente d'exemplaires précis (CardInstance)
-- contre des tokens. `listed` gèle l'exemplaire (protégé de la fusion,
-- de l'ascension et des échanges) tant qu'une annonce active existe.
ALTER TABLE "CardInstance" ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "MarketListing" (
    "id" SERIAL NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerId" TEXT,
    "cardInstanceId" INTEGER NOT NULL,
    "characterId" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "MarketListing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarketListing_cardInstanceId_key" ON "MarketListing"("cardInstanceId");
CREATE INDEX "MarketListing_status_characterId_idx" ON "MarketListing"("status", "characterId");
CREATE INDEX "MarketListing_status_price_idx" ON "MarketListing"("status", "price");
CREATE INDEX "MarketListing_sellerId_status_idx" ON "MarketListing"("sellerId", "status");

ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_cardInstanceId_fkey" FOREIGN KEY ("cardInstanceId") REFERENCES "CardInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

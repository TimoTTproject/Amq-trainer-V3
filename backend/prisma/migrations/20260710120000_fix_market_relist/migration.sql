-- Remise en vente d'un exemplaire déjà passé par le marché : les annonces
-- résolues (cancelled/sold) restent en base pour l'historique, or l'index
-- UNIQUE sur cardInstanceId interdisait toute nouvelle annonce du même
-- exemplaire (P2002 → « Erreur serveur » au /list). On le remplace par un
-- index simple (perfs des jointures) + un index unique PARTIEL limité aux
-- annonces actives : le garde-fou anti-double-annonce reste au niveau base,
-- sans bloquer l'historique. (Index partiel non exprimable dans schema.prisma
-- — ne pas le « corriger » lors d'une future migration générée.)
DROP INDEX "MarketListing_cardInstanceId_key";
CREATE INDEX "MarketListing_cardInstanceId_idx" ON "MarketListing"("cardInstanceId");
CREATE UNIQUE INDEX "MarketListing_active_instance_key" ON "MarketListing"("cardInstanceId") WHERE "status" = 'active';

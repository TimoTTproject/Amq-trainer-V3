-- Attribution : quel joueur a fait entrer ce son dans le catalogue global
-- (via son import AniList). NULL = catalogué avant cette fonctionnalité, ou
-- via un chemin sans utilisateur (scripts admin).
ALTER TABLE "Song" ADD COLUMN "addedByUserId" TEXT;
ALTER TABLE "Song" ADD CONSTRAINT "Song_addedByUserId_fkey"
  FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

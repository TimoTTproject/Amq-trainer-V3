-- Recrues « Éveillées » (équivalent shiny) : marqueur permanent sur la recrue.
ALTER TABLE "DojoRecruit" ADD COLUMN "awakened" BOOLEAN NOT NULL DEFAULT false;

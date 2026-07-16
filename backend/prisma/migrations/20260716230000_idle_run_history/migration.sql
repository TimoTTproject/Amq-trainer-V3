CREATE TABLE "IdleRunHistory" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "prestigeLevel" INTEGER NOT NULL,
    "bestStage" INTEGER NOT NULL,
    "essenceEarned" DOUBLE PRECISION NOT NULL,
    "wisdomGained" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "teamDps" DOUBLE PRECISION NOT NULL,
    "heroCount" INTEGER NOT NULL,
    "blessings" JSONB NOT NULL DEFAULT '[]',
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdleRunHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdleRunHistory_userId_completedAt_idx" ON "IdleRunHistory"("userId", "completedAt");
CREATE INDEX "IdleRunHistory_bestStage_completedAt_idx" ON "IdleRunHistory"("bestStage", "completedAt");

ALTER TABLE "IdleRunHistory"
ADD CONSTRAINT "IdleRunHistory_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "User"
  ADD COLUMN "idleSeals" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "idleBurstReadyAt" TIMESTAMP(3),
  ADD COLUMN "idleTeamReadyAt" TIMESTAMP(3),
  ADD COLUMN "idleBossProgress" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "IdleProgressCounter" (
  "id" SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "value" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdleProgressCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdleProgressCounter_userId_key_period_key"
  ON "IdleProgressCounter"("userId", "key", "period");
CREATE INDEX "IdleProgressCounter_userId_period_idx"
  ON "IdleProgressCounter"("userId", "period");
ALTER TABLE "IdleProgressCounter"
  ADD CONSTRAINT "IdleProgressCounter_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IdleMissionClaim" (
  "id" SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "missionKey" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdleMissionClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdleMissionClaim_userId_missionKey_period_key" ON "IdleMissionClaim"("userId", "missionKey", "period");
CREATE INDEX "IdleMissionClaim_userId_period_idx" ON "IdleMissionClaim"("userId", "period");
ALTER TABLE "IdleMissionClaim" ADD CONSTRAINT "IdleMissionClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

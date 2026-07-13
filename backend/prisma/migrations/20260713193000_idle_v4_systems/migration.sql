ALTER TABLE "User"
ADD COLUMN "idleBossStartedAt" TIMESTAMP(3),
ADD COLUMN "idleBestBossMs" INTEGER,
ADD COLUMN "idleFormation" TEXT NOT NULL DEFAULT 'balanced',
ADD COLUMN "idlePrestigePath" TEXT NOT NULL DEFAULT 'balanced',
ADD COLUMN "idlePrestigeMilestone" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "IdleTeamPreset" (
  "id" SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slots" JSONB NOT NULL,
  "formation" TEXT NOT NULL DEFAULT 'balanced',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdleTeamPreset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdleTeamPreset_userId_name_key" ON "IdleTeamPreset"("userId", "name");
CREATE INDEX "IdleTeamPreset_userId_idx" ON "IdleTeamPreset"("userId");
ALTER TABLE "IdleTeamPreset" ADD CONSTRAINT "IdleTeamPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IdleFeedback" (
  "id" SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "context" TEXT,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdleFeedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IdleFeedback_resolved_createdAt_idx" ON "IdleFeedback"("resolved", "createdAt");
CREATE INDEX "IdleFeedback_userId_createdAt_idx" ON "IdleFeedback"("userId", "createdAt");
ALTER TABLE "IdleFeedback" ADD CONSTRAINT "IdleFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

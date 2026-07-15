CREATE TABLE "IdleRiftRun" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "relics" JSONB NOT NULL DEFAULT '[]',
    "pendingChoice" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdleRiftRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdleRiftRun_userId_period_key" ON "IdleRiftRun"("userId", "period");

CREATE INDEX "IdleRiftRun_userId_period_idx" ON "IdleRiftRun"("userId", "period");

ALTER TABLE "IdleRiftRun" ADD CONSTRAINT "IdleRiftRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

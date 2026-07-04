-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "anilistId" INTEGER,
    "anilistName" TEXT,
    "anilistToken" TEXT,
    "googleId" TEXT,
    "anilistListName" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "bio" TEXT,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "towerLastFreeAt" TIMESTAMP(3),
    "towerBestFloor" INTEGER NOT NULL DEFAULT 0,
    "coopBestFloor" INTEGER NOT NULL DEFAULT 0,
    "claimedLevel" INTEGER NOT NULL DEFAULT 1,
    "lastDailyAt" TIMESTAMP(3),
    "mmr" INTEGER NOT NULL DEFAULT 1000,
    "rankedGames" INTEGER NOT NULL DEFAULT 0,
    "rankedWins" INTEGER NOT NULL DEFAULT 0,
    "soloMmr" INTEGER NOT NULL DEFAULT 1000,
    "soloGames" INTEGER NOT NULL DEFAULT 0,
    "soloBestScore" INTEGER NOT NULL DEFAULT 0,
    "dailyStreak" INTEGER NOT NULL DEFAULT 0,
    "dailyStreakBest" INTEGER NOT NULL DEFAULT 0,
    "dailyLastDay" TEXT,
    "mpRewardAt" TIMESTAMP(3),
    "mpRewardWindow" INTEGER NOT NULL DEFAULT 0,
    "quizRewardAt" TIMESTAMP(3),
    "quizRewardWindow" INTEGER NOT NULL DEFAULT 0,
    "pity" INTEGER NOT NULL DEFAULT 0,
    "dust" INTEGER NOT NULL DEFAULT 0,
    "pullCommon" INTEGER NOT NULL DEFAULT 0,
    "pullRare" INTEGER NOT NULL DEFAULT 0,
    "pullEpic" INTEGER NOT NULL DEFAULT 0,
    "pullLegendary" INTEGER NOT NULL DEFAULT 0,
    "pullMythic" INTEGER NOT NULL DEFAULT 0,
    "cardBack" TEXT,
    "cardBorder" TEXT,
    "profileBanner" TEXT,
    "avatarFrame" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" SERIAL NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "offeredIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "requestedIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "offeredTokens" INTEGER NOT NULL DEFAULT 0,
    "requestedTokens" INTEGER NOT NULL DEFAULT 0,
    "offeredDust" INTEGER NOT NULL DEFAULT 0,
    "requestedDust" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCosmetic" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCosmetic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyStat" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "played" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" SERIAL NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quest" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "target" INTEGER NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "reward" INTEGER NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoopWeeklyScore" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "week" TEXT NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 0,
    "rewarded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CoopWeeklyScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpResult" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "ranked" BOOLEAN NOT NULL DEFAULT false,
    "placement" INTEGER NOT NULL,
    "players" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "mmrBefore" INTEGER,
    "mmrAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MpResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyChallenge" (
    "id" SERIAL NOT NULL,
    "day" TEXT NOT NULL,
    "songIds" INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyRun" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "songIds" INTEGER[],
    "index" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "finished" BOOLEAN NOT NULL DEFAULT false,
    "songStartedAt" TIMESTAMP(3),
    "mmrBefore" INTEGER,
    "mmrAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonClaim" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "dust" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeaturedVote" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "characterId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeaturedVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Song" (
    "id" SERIAL NOT NULL,
    "anilistId" INTEGER NOT NULL,
    "animeTitle" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "videoUrl" TEXT,
    "audioUrl" TEXT,
    "format" TEXT,
    "popularity" INTEGER NOT NULL DEFAULT 0,
    "altTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Song_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" SERIAL NOT NULL,
    "visitorId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "authed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannedAnime" (
    "anilistId" INTEGER NOT NULL,
    "animeTitle" TEXT NOT NULL,
    "songCount" INTEGER NOT NULL DEFAULT 0,
    "edScanned" BOOLEAN NOT NULL DEFAULT false,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedAnime_pkey" PRIMARY KEY ("anilistId")
);

-- CreateTable
CREATE TABLE "UserSongStat" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "songId" INTEGER NOT NULL,
    "easyCount" INTEGER NOT NULL DEFAULT 0,
    "hardCount" INTEGER NOT NULL DEFAULT 0,
    "againCount" INTEGER NOT NULL DEFAULT 0,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "liked" BOOLEAN NOT NULL DEFAULT false,
    "recHidden" BOOLEAN NOT NULL DEFAULT false,
    "srsStreak" INTEGER NOT NULL DEFAULT 0,
    "srsInterval" INTEGER NOT NULL DEFAULT 0,
    "srsDueAt" TIMESTAMP(3),

    CONSTRAINT "UserSongStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCatalogEntry" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "songId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenTransaction" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" SERIAL NOT NULL,
    "anilistId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "favourites" INTEGER NOT NULL DEFAULT 0,
    "rarity" TEXT NOT NULL DEFAULT 'common',
    "fromManga" BOOLEAN NOT NULL DEFAULT false,
    "series" TEXT,
    "seriesId" INTEGER,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "maxSupply" INTEGER NOT NULL DEFAULT 0,
    "minted" INTEGER NOT NULL DEFAULT 0,
    "nextSerial" INTEGER NOT NULL DEFAULT 0,
    "soldOut" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardInstance" (
    "id" SERIAL NOT NULL,
    "characterId" INTEGER NOT NULL,
    "serial" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCard" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "characterId" INTEGER NOT NULL,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "stars" INTEGER NOT NULL DEFAULT 1,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "obtainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pack" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "costTokens" INTEGER NOT NULL,
    "cardCount" INTEGER NOT NULL DEFAULT 5,

    CONSTRAINT "Pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TowerRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "floor" INTEGER NOT NULL DEFAULT 1,
    "lives" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentSongId" INTEGER,
    "currentOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currentAnswer" INTEGER,
    "floorStartedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TowerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_anilistId_key" ON "User"("anilistId");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Trade_toUserId_status_idx" ON "Trade"("toUserId", "status");

-- CreateIndex
CREATE INDEX "Trade_fromUserId_status_idx" ON "Trade"("fromUserId", "status");

-- CreateIndex
CREATE INDEX "UserCosmetic_userId_idx" ON "UserCosmetic"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCosmetic_userId_cosmeticId_key" ON "UserCosmetic"("userId", "cosmeticId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyStat_userId_day_key" ON "DailyStat"("userId", "day");

-- CreateIndex
CREATE INDEX "Friendship_addresseeId_idx" ON "Friendship"("addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_requesterId_addresseeId_key" ON "Friendship"("requesterId", "addresseeId");

-- CreateIndex
CREATE INDEX "Quest_userId_day_idx" ON "Quest"("userId", "day");

-- CreateIndex
CREATE INDEX "CoopWeeklyScore_week_floor_idx" ON "CoopWeeklyScore"("week", "floor");

-- CreateIndex
CREATE UNIQUE INDEX "CoopWeeklyScore_userId_week_key" ON "CoopWeeklyScore"("userId", "week");

-- CreateIndex
CREATE INDEX "MpResult_userId_idx" ON "MpResult"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyChallenge_day_key" ON "DailyChallenge"("day");

-- CreateIndex
CREATE INDEX "DailyRun_day_idx" ON "DailyRun"("day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRun_userId_day_key" ON "DailyRun"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonClaim_userId_season_key" ON "SeasonClaim"("userId", "season");

-- CreateIndex
CREATE INDEX "Wishlist_userId_idx" ON "Wishlist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wishlist_userId_characterId_key" ON "Wishlist"("userId", "characterId");

-- CreateIndex
CREATE INDEX "FeaturedVote_week_idx" ON "FeaturedVote"("week");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedVote_userId_week_key" ON "FeaturedVote"("userId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX "Song_anilistId_idx" ON "Song"("anilistId");

-- CreateIndex
CREATE UNIQUE INDEX "Song_anilistId_type_number_title_key" ON "Song"("anilistId", "type", "number", "title");

-- CreateIndex
CREATE INDEX "Visit_day_idx" ON "Visit"("day");

-- CreateIndex
CREATE UNIQUE INDEX "Visit_visitorId_day_key" ON "Visit"("visitorId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "UserSongStat_userId_songId_key" ON "UserSongStat"("userId", "songId");

-- CreateIndex
CREATE UNIQUE INDEX "UserCatalogEntry_userId_songId_key" ON "UserCatalogEntry"("userId", "songId");

-- CreateIndex
CREATE UNIQUE INDEX "Character_anilistId_key" ON "Character"("anilistId");

-- CreateIndex
CREATE INDEX "Character_rarity_idx" ON "Character"("rarity");

-- CreateIndex
CREATE INDEX "Character_series_idx" ON "Character"("series");

-- CreateIndex
CREATE INDEX "Character_rarity_soldOut_idx" ON "Character"("rarity", "soldOut");

-- CreateIndex
CREATE INDEX "CardInstance_userId_idx" ON "CardInstance"("userId");

-- CreateIndex
CREATE INDEX "CardInstance_userId_characterId_idx" ON "CardInstance"("userId", "characterId");

-- CreateIndex
CREATE INDEX "CardInstance_obtainedAt_idx" ON "CardInstance"("obtainedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardInstance_characterId_serial_key" ON "CardInstance"("characterId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "UserCard_userId_characterId_key" ON "UserCard"("userId", "characterId");

-- CreateIndex
CREATE INDEX "TowerRun_userId_status_idx" ON "TowerRun"("userId", "status");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmetic" ADD CONSTRAINT "UserCosmetic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyStat" ADD CONSTRAINT "DailyStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quest" ADD CONSTRAINT "Quest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoopWeeklyScore" ADD CONSTRAINT "CoopWeeklyScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpResult" ADD CONSTRAINT "MpResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyRun" ADD CONSTRAINT "DailyRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonClaim" ADD CONSTRAINT "SeasonClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedVote" ADD CONSTRAINT "FeaturedVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedVote" ADD CONSTRAINT "FeaturedVote_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSongStat" ADD CONSTRAINT "UserSongStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSongStat" ADD CONSTRAINT "UserSongStat_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCatalogEntry" ADD CONSTRAINT "UserCatalogEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCatalogEntry" ADD CONSTRAINT "UserCatalogEntry_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardInstance" ADD CONSTRAINT "CardInstance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardInstance" ADD CONSTRAINT "CardInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCard" ADD CONSTRAINT "UserCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCard" ADD CONSTRAINT "UserCard_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TowerRun" ADD CONSTRAINT "TowerRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

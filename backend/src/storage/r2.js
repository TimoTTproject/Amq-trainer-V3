const crypto = require('crypto');
const { Readable } = require('stream');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { prisma } = require('../db');
const { fetchVideoUpstream } = require('../util/stream');

const failedSongIds = new Set();
let client = null;
let migrationPromise = null;
const migrationState = {
  running: false,
  uploaded: 0,
  failed: 0,
  startedAt: null,
  lastError: null,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim() || (accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : '');
  return {
    accountId,
    endpoint: endpoint.replace(/\/+$/, ''),
    accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
    bucket: process.env.R2_BUCKET?.trim(),
    publicUrl: process.env.R2_PUBLIC_URL?.trim().replace(/\/+$/, ''),
  };
}

function isR2Configured() {
  const c = r2Config();
  return !!(c.endpoint && c.accessKeyId && c.secretAccessKey && c.bucket && c.publicUrl);
}

function r2Client() {
  if (client) return client;
  const c = r2Config();
  if (!isR2Configured()) throw new Error('Variables R2 incomplètes');
  client = new S3Client({
    region: 'auto',
    endpoint: c.endpoint,
    credentials: {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
    },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  return client;
}

function extensionFor(contentType, sourceUrl) {
  if (/audio\/mpeg/i.test(contentType || '')) return 'mp3';
  if (/audio\/mp4|video\/mp4/i.test(contentType || '')) return 'm4a';
  if (/ogg/i.test(contentType || '')) return 'ogg';
  if (/webm/i.test(contentType || '')) return 'webm';
  const match = String(sourceUrl || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  return match?.[1]?.toLowerCase() || 'webm';
}

async function migrateOneSongToR2() {
  if (!isR2Configured()) throw new Error('R2 non configuré sur Railway');
  const where = {
    videoUrl: { not: null },
    audioUrl: null,
    ...(failedSongIds.size ? { id: { notIn: [...failedSongIds] } } : {}),
  };
  const song = await prisma.song.findFirst({
    where,
    orderBy: [{ popularity: 'desc' }, { id: 'asc' }],
    select: { id: true, videoUrl: true },
  });
  if (!song) {
    const remaining = await prisma.song.count({ where: { videoUrl: { not: null }, audioUrl: null } });
    return { processed: 0, uploaded: 0, remaining };
  }

  try {
    const upstream = await fetchVideoUpstream(song.videoUrl, {
      'User-Agent': 'AnimeMusicQuiz/1.0 (+https://amqtrainer.fr)',
      Accept: '*/*',
    });
    if (!upstream.ok || !upstream.body) throw new Error(`Source HTTP ${upstream.status}`);

    const contentType = upstream.headers.get('content-type') || 'video/webm';
    const extension = extensionFor(contentType, song.videoUrl);
    const key = `media/v1/${crypto.randomUUID()}.${extension}`;
    const contentLength = parseInt(upstream.headers.get('content-length')) || undefined;
    const upload = new Upload({
      client: r2Client(),
      params: {
        Bucket: r2Config().bucket,
        Key: key,
        Body: Readable.fromWeb(upstream.body),
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        ContentDisposition: 'inline',
        ...(contentLength ? { ContentLength: contentLength } : {}),
      },
      queueSize: 1,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();

    const audioUrl = `${r2Config().publicUrl}/${key}`;
    await prisma.song.update({ where: { id: song.id }, data: { audioUrl } });
    const remaining = await prisma.song.count({ where: { videoUrl: { not: null }, audioUrl: null } });
    return { processed: 1, uploaded: 1, remaining };
  } catch (error) {
    failedSongIds.add(song.id);
    const remaining = await prisma.song.count({ where: { videoUrl: { not: null }, audioUrl: null } });
    return { processed: 1, uploaded: 0, failed: 1, remaining, error: error.message };
  }
}

async function r2Status() {
  let connected = false;
  let error = null;
  if (isR2Configured()) {
    try {
      await r2Client().send(new HeadBucketCommand({ Bucket: r2Config().bucket }));
      connected = true;
    } catch (connectionError) {
      error = connectionError.message;
    }
  }
  const [total, uploaded] = await Promise.all([
    prisma.song.count({ where: { videoUrl: { not: null } } }),
    prisma.song.count({ where: { audioUrl: { not: null } } }),
  ]);
  return {
    configured: isR2Configured(),
    connected,
    error,
    publicUrl: r2Config().publicUrl || null,
    total,
    uploaded,
    remaining: Math.max(0, total - uploaded),
    migration: { ...migrationState },
  };
}

function preferredMediaUrl(song) {
  return song?.audioUrl || song?.videoUrl || null;
}

async function runContinuousMigration() {
  try {
    while (migrationState.running) {
      const result = await migrateOneSongToR2();
      migrationState.uploaded += result.uploaded || 0;
      migrationState.failed += result.failed || 0;
      migrationState.lastError = result.error || null;
      if (!result.processed || !result.remaining) break;
      await sleep(400);
    }
  } catch (error) {
    migrationState.lastError = error.message;
  } finally {
    migrationState.running = false;
    migrationPromise = null;
  }
}

function startContinuousMigration() {
  if (migrationState.running) return { ...migrationState };
  migrationState.running = true;
  migrationState.uploaded = 0;
  migrationState.failed = 0;
  migrationState.startedAt = Date.now();
  migrationState.lastError = null;
  migrationPromise = runContinuousMigration();
  return { ...migrationState };
}

function stopContinuousMigration() {
  migrationState.running = false;
  return { ...migrationState };
}

module.exports = {
  isR2Configured,
  migrateOneSongToR2,
  preferredMediaUrl,
  r2Config,
  r2Status,
  startContinuousMigration,
  stopContinuousMigration,
};

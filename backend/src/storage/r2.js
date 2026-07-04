const crypto = require('crypto');
const { Readable } = require('stream');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { prisma } = require('../db');
const { fetchVideoUpstream } = require('../util/stream');

// Échecs par musique DANS CE PROCESSUS : on n'insiste pas en boucle sur un titre
// qui vient d'échouer, mais on le retente par « vagues » (animethemes rend des
// 403/429/timeout passagers). Au-delà de MAX_ATTEMPTS, le titre est mis de côté
// jusqu'au prochain redémarrage.
const failedAttempts = new Map(); // songId → nombre d'échecs
const MAX_ATTEMPTS = 4;
const STEP_MS = 400; // souffle entre deux fichiers
const RETRY_WAVE_MS = 30000; // pause avant de retenter les titres en échec
const MAX_CONSECUTIVE_ERRORS = 10; // erreurs de boucle (BDD…) avant abandon

let client = null;
const migrationState = {
  running: false,
  uploaded: 0,
  failed: 0,
  retryWaves: 0,
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
    ...(failedAttempts.size ? { id: { notIn: [...failedAttempts.keys()] } } : {}),
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
    failedAttempts.set(song.id, (failedAttempts.get(song.id) || 0) + 1);
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
    migration: {
      ...migrationState,
      permanentFailures: [...failedAttempts.values()].filter((n) => n >= MAX_ATTEMPTS).length,
    },
  };
}

function preferredMediaUrl(song) {
  return song?.audioUrl || song?.videoUrl || null;
}

// Boucle de migration « incassable » : elle ne s'arrête QUE quand tout est migré
// ou qu'il ne reste que des titres en échec définitif (MAX_ATTEMPTS). Un raté
// passager (403/429/timeout animethemes) est retenté par vagues espacées, et une
// erreur de boucle (BDD…) fait patienter au lieu de tout stopper.
// `migrateOnce`/`delays` sont injectables pour les tests.
async function runContinuousMigration(migrateOnce = migrateOneSongToR2, delays = {}) {
  const stepMs = delays.stepMs ?? STEP_MS;
  const waveMs = delays.waveMs ?? RETRY_WAVE_MS;
  let consecutiveErrors = 0;
  try {
    while (migrationState.running) {
      let result;
      try {
        result = await migrateOnce();
        consecutiveErrors = 0;
      } catch (error) {
        // Erreur hors upload (ex. hoquet BDD) : on patiente puis on réessaie,
        // au lieu de tuer la migration entière.
        consecutiveErrors++;
        migrationState.lastError = error.message;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        await sleep(waveMs);
        continue;
      }
      migrationState.uploaded += result.uploaded || 0;
      migrationState.failed += result.failed || 0;
      if (result.error) migrationState.lastError = result.error;
      if (!result.remaining) break; // ✅ terminé

      if (!result.processed) {
        // Plus aucun candidat hors exclusions : tout ce qui reste a déjà échoué.
        const retryable = [...failedAttempts].filter(([, n]) => n < MAX_ATTEMPTS);
        if (!retryable.length) {
          migrationState.lastError =
            `${failedAttempts.size} musique(s) en échec après ${MAX_ATTEMPTS} tentatives — redémarre la migration pour réessayer.`;
          break;
        }
        // Nouvelle vague : on redonne leur chance aux échecs passagers.
        retryable.forEach(([id]) => failedAttempts.delete(id));
        migrationState.retryWaves++;
        await sleep(waveMs);
        continue;
      }
      await sleep(stepMs);
    }
  } catch (error) {
    migrationState.lastError = error.message;
  } finally {
    migrationState.running = false;
  }
}

function startContinuousMigration() {
  if (migrationState.running) return { ...migrationState };
  migrationState.running = true;
  migrationState.uploaded = 0;
  migrationState.failed = 0;
  migrationState.retryWaves = 0;
  migrationState.startedAt = Date.now();
  migrationState.lastError = null;
  failedAttempts.clear(); // un (re)démarrage manuel redonne sa chance à tout
  runContinuousMigration(); // tourne en tâche de fond ; suivi via migrationState
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
  runContinuousMigration, // exporté pour les tests (worker injectable)
  startContinuousMigration,
  stopContinuousMigration,
  _migrationInternals: { migrationState, failedAttempts, MAX_ATTEMPTS }, // tests
};

// Proxy de flux vidéo : relaie un .webm distant en masquant son URL (anti-triche).
// Supporte les requêtes Range (seek / lecture partielle).
const { Readable } = require('stream');

const ANIMETHEMES_HEADERS = {
  'User-Agent': 'AnimeMusicQuiz/1.0 (+https://github.com/local/amq)',
  Accept: '*/*',
};

const RETRY_DELAYS_MS = [0, 180, 450];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchVideoUpstream(videoUrl, headers, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const upstream = await fetchImpl(videoUrl, {
        headers,
        signal: AbortSignal.timeout(12000),
      });
      if (upstream.status !== 429 && upstream.status < 500) return upstream;
      lastError = new Error(`AnimeThemes ${upstream.status}`);
      await upstream.body?.cancel();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Flux AnimeThemes indisponible');
}

async function proxyVideo(req, res, videoUrl, options = {}) {
  if (!videoUrl) return res.status(404).end();
  try {
    const headers = { ...ANIMETHEMES_HEADERS };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetchVideoUpstream(videoUrl, headers);
    await options.onReady?.();
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('proxyVideo error:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
}

module.exports = { proxyVideo, fetchVideoUpstream };

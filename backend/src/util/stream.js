// Proxy de flux vidéo : relaie un .webm distant en masquant son URL (anti-triche).
// Supporte les requêtes Range (seek / lecture partielle).
const { Readable } = require('stream');

const ANIMETHEMES_HEADERS = {
  'User-Agent': 'AnimeMusicQuiz/1.0 (+https://github.com/local/amq)',
  Accept: '*/*',
};

const RETRY_DELAYS_MS = [0, 250];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchVideoUpstream(videoUrl, headers, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
    const controller = new AbortController();
    // Ce délai ne concerne que l'obtention des en-têtes. Il doit absolument
    // être annulé ensuite, sinon il coupe le corps de la vidéo en pleine lecture.
    const headerTimeout = setTimeout(() => controller.abort(), 5000);
    try {
      const upstream = await fetchImpl(videoUrl, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(headerTimeout);
      if (upstream.status !== 429 && upstream.status < 500) return upstream;
      lastError = new Error(`AnimeThemes ${upstream.status}`);
      await upstream.body?.cancel();
    } catch (error) {
      clearTimeout(headerTimeout);
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
    const stream = Readable.fromWeb(upstream.body);
    // Une coupure distante ne doit jamais devenir une exception non gérée qui
    // arrête tout le serveur et transforme ensuite chaque route en 502.
    stream.on('error', (error) => {
      console.error('proxyVideo stream error:', error.message);
      if (!res.destroyed) res.destroy(error);
    });
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('proxyVideo error:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
}

module.exports = { proxyVideo, fetchVideoUpstream };

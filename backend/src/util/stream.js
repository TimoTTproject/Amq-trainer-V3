// Proxy de flux vidéo : relaie un .webm distant en masquant son URL (anti-triche).
// Supporte les requêtes Range (seek / lecture partielle).
const { Readable } = require('stream');

const ANIMETHEMES_HEADERS = {
  'User-Agent': 'AnimeMusicQuiz/1.0 (+https://github.com/local/amq)',
  Accept: '*/*',
};

async function proxyVideo(req, res, videoUrl) {
  if (!videoUrl) return res.status(404).end();
  try {
    const headers = { ...ANIMETHEMES_HEADERS };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(videoUrl, { headers });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('proxyVideo error:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
}

module.exports = { proxyVideo };

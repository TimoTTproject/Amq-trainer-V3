const test = require('node:test');
const assert = require('node:assert/strict');
const { preferredMediaUrl, r2Config } = require('../src/storage/r2');

test('prefers the Cloudflare media URL and keeps AnimeThemes as fallback', () => {
  assert.equal(
    preferredMediaUrl({ audioUrl: 'https://media.amqtrainer.fr/a.webm', videoUrl: 'https://source.test/a.webm' }),
    'https://media.amqtrainer.fr/a.webm'
  );
  assert.equal(
    preferredMediaUrl({ audioUrl: null, videoUrl: 'https://source.test/a.webm' }),
    'https://source.test/a.webm'
  );
});

test('normalizes R2 endpoint and public URL variables', () => {
  const previous = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  };
  process.env.R2_ACCOUNT_ID = 'account';
  process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com/';
  process.env.R2_PUBLIC_URL = 'https://media.amqtrainer.fr/';
  try {
    const config = r2Config();
    assert.equal(config.endpoint, 'https://account.r2.cloudflarestorage.com');
    assert.equal(config.publicUrl, 'https://media.amqtrainer.fr');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

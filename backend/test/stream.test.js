const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchVideoUpstream } = require('../src/util/stream');

test('retries temporary AnimeThemes errors before serving a video', async () => {
  const statuses = [503, 206];
  let calls = 0;
  const response = await fetchVideoUpstream('https://example.test/video.webm', {}, async () => {
    const status = statuses[calls++];
    return new Response(status === 206 ? 'video' : 'temporary error', { status });
  });

  assert.equal(response.status, 206);
  assert.equal(calls, 2);
});

test('does not retry permanent upstream errors', async () => {
  let calls = 0;
  const response = await fetchVideoUpstream('https://example.test/missing.webm', {}, async () => {
    calls++;
    return new Response('missing', { status: 404 });
  });

  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

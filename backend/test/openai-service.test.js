// Tests de src/ai/openai.service.js — uniquement le chemin sans réseau (pas
// de vraie clé API en test) : absence de clé détectée avant tout appel HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateImageBuffer, OpenAIError } = require('../src/ai/openai.service');

test('generateImageBuffer : rejette immédiatement sans OPENAI_API_KEY, pas d\'appel réseau', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => generateImageBuffer('un prompt quelconque'), (err) => {
    assert.ok(err instanceof OpenAIError);
    assert.equal(err.code, 'missing_api_key');
    return true;
  });
});

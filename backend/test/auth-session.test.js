const test = require('node:test');
const assert = require('node:assert/strict');

const { requireAuth, requirePlayer } = require('../src/auth/auth.middleware');
const { sendPasswordResetEmail } = require('../src/auth/email');

function responseStub() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('un invité peut jouer mais pas accéder aux fonctions de compte', () => {
  const req = { user: { id: 'guest:test', isGuest: true } };
  const accountResponse = responseStub();
  let accountNext = false;
  requireAuth(req, accountResponse, () => { accountNext = true; });
  assert.equal(accountNext, false);
  assert.equal(accountResponse.statusCode, 401);

  const playerResponse = responseStub();
  let playerNext = false;
  requirePlayer(req, playerResponse, () => { playerNext = true; });
  assert.equal(playerNext, true);
  assert.equal(playerResponse.statusCode, 200);
});

test('l’envoi de récupération reste inactif sans clé e-mail', async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const result = await sendPasswordResetEmail({
      to: 'test@example.com',
      resetUrl: 'http://localhost/reset',
    });
    assert.deepEqual(result, { sent: false, reason: 'not_configured' });
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  }
});

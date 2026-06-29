async function sendPasswordResetEmail({ to, resetUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.AUTH_FROM_EMAIL || 'AMQ Trainer <noreply@amqtrainer.fr>';
  if (!apiKey) return { sent: false, reason: 'not_configured' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Réinitialise ton mot de passe AMQ Trainer',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#15171d">
          <h1 style="font-size:24px">Réinitialisation du mot de passe</h1>
          <p>Une demande de réinitialisation a été faite pour ton compte AMQ Trainer.</p>
          <p><a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#ff5c7a;color:#16070b;text-decoration:none;font-weight:700">Choisir un nouveau mot de passe</a></p>
          <p style="color:#646b78;font-size:13px">Ce lien expire dans 30 minutes. Si tu n’as rien demandé, ignore cet e-mail.</p>
        </div>`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 200)}`);
  }
  return { sent: true };
}

module.exports = { sendPasswordResetEmail };

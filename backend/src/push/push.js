// Web Push (notifications PWA). Désactivé tant que les clés VAPID ne sont pas
// définies (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) → aucun risque en prod.
// Générer les clés une fois : `npx web-push generate-vapid-keys`.
const webpush = require('web-push');
const { prisma } = require('../db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@amqtrainer.fr';
let ready = false;

if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    ready = true;
  } catch (e) {
    console.warn('  ⚠ Clés VAPID invalides — push désactivé :', e.message);
  }
}

function isEnabled() { return ready; }
function publicKey() { return PUBLIC_KEY; }

// Envoie à un abonnement ; supprime l'abonnement s'il est périmé (404/410).
async function sendToSub(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
    }
    return false;
  }
}

// Notifie tous les appareils d'un utilisateur.
async function sendToUser(userId, payload) {
  if (!ready) return 0;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  for (const s of subs) if (await sendToSub(s, payload)) sent++;
  return sent;
}

// Rappel quotidien : abonnés n'ayant PAS terminé le défi du jour.
async function sendDailyReminder() {
  if (!ready) return { sent: 0, targets: 0 };
  const { todayStr } = require('../daily/daily');
  const day = todayStr();
  const played = await prisma.dailyRun.findMany({ where: { day, finished: true }, select: { userId: true } });
  const playedIds = played.map((r) => r.userId);
  const subs = await prisma.pushSubscription.findMany({
    where: playedIds.length ? { userId: { notIn: playedIds } } : {},
  });
  const payload = {
    title: 'Défi du jour 🎵',
    body: 'Ton défi t\'attend — garde ta série en vie !',
    url: '/?nav=daily',
  };
  let sent = 0;
  for (const s of subs) if (await sendToSub(s, payload)) sent++;
  return { sent, targets: subs.length };
}

module.exports = { isEnabled, publicKey, sendToUser, sendDailyReminder };

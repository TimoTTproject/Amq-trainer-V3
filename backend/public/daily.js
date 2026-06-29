// Défi du jour (solo classé) — extrait autonome (scope global partagé).
// Réutilise les globals de main.js (api, currentUser, showView, getVolume, sfx,
// escapeHtml, navTo, mediaUrlWithRetry, waitForMediaEvent, burstConfetti).
let dailyIndex = -1;        // index de la chanson en cours (anti-stale)
let dailyTotal = 0;
let dailyScore = 0;
let dailyDuration = 30000;  // ms (fourni par le serveur)
let dailyTimer = null;      // chrono de la chanson
let dailyAnswering = false;
let dailyMyScore = 0; // mon score du jour (pour le partage)
const dailyVideo = () => document.getElementById('daily-video');

function dailyShow(panel) {
  ['intro', 'game', 'over'].forEach((p) =>
    document.getElementById('daily-' + p).classList.toggle('hidden', p !== panel)
  );
}

async function openDaily() {
  showView('daily');
  stopDailyMedia();
  dailyShow('intro');
  document.getElementById('daily-intro-msg').textContent = 'Chargement…';
  try {
    const d = await api('/api/daily/status');
    renderDailyIntro(d);
  } catch (e) {
    document.getElementById('daily-intro-msg').textContent = e.message;
  }
  loadDailyBoard();
  initDailyNotif();
}

// ── Notifications push (rappel du défi du jour) ──
let dailyPushKey = null;
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function initDailyNotif() {
  const btn = document.getElementById('daily-notif-btn');
  if (!btn) return;
  btn.classList.add('hidden');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  let info;
  try { info = await api('/api/push/key'); } catch { return; }
  if (!info.enabled || !info.publicKey) return; // push non configuré côté serveur
  dailyPushKey = info.publicKey;
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const existing = reg && (await reg.pushManager.getSubscription());
  btn.classList.remove('hidden');
  if (Notification.permission === 'granted' && existing) {
    btn.innerHTML = '<i class="fas fa-bell"></i> Rappels activés ✓';
    btn.disabled = true;
  } else {
    btn.innerHTML = '<i class="fas fa-bell"></i> Activer les rappels';
    btn.disabled = false;
  }
}
async function enableDailyNotif() {
  const btn = document.getElementById('daily-notif-btn');
  if (!dailyPushKey) return;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { btn.innerHTML = '<i class="fas fa-bell-slash"></i> Notifications refusées'; return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(dailyPushKey),
    });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
    btn.innerHTML = '<i class="fas fa-bell"></i> Rappels activés ✓';
    btn.disabled = true;
  } catch (e) {
    btn.innerHTML = '<i class="fas fa-bell"></i> Réessayer';
    console.warn('push subscribe failed:', e.message);
  }
}

// Classement du JOUR (meilleurs scores du jour) — rempli dans accueil + résultats.
async function loadDailyBoard() {
  let d;
  try { d = await api('/api/daily/board'); } catch { return; }
  renderDailyBoard(d, 'daily-board-intro');
  renderDailyBoard(d, 'daily-board-over');
}
function renderDailyBoard(d, containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  if (!d.top || !d.top.length) {
    box.innerHTML = '<h3 class="daily-board-title">Classement du jour</h3><p class="muted">Personne n\'a encore joué aujourd\'hui — sois le premier !</p>';
    return;
  }
  const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
  const rows = d.top.map((e) => {
    const av = (typeof otherAvatar === 'function')
      ? otherAvatar({ avatarUrl: e.avatarUrl, frame: e.frame, displayName: e.displayName }, 'avatar-xs')
      : '';
    return `<li class="lb-row${e.isMe ? ' me' : ''}">
      <span class="lb-rank">${medal(e.rank)}</span>${av}
      <span class="lb-name">${escapeHtml(e.displayName)}</span>
      <span class="lb-value">${e.score} pts</span>
    </li>`;
  }).join('');
  const meOut = d.me && !d.top.some((e) => e.isMe)
    ? `<li class="lb-row me"><span class="lb-rank">#${d.me.rank}</span><span class="lb-name">Toi</span><span class="lb-value">${d.me.score} pts</span></li>`
    : '';
  box.innerHTML = `<h3 class="daily-board-title">Classement du jour · ${d.players} joueur(s)</h3><ol class="lb-list">${rows}${meOut}</ol>`;
}

function shareDaily() {
  const text = `J'ai marqué ${dailyMyScore} pts au Défi du jour sur Anime Music Quiz 🎵 — bats-moi !`;
  const url = location.origin;
  if (navigator.share) {
    navigator.share({ title: 'Anime Music Quiz', text, url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(`${text} ${url}`).then(() => {
      const b = document.getElementById('daily-share');
      if (b) { const old = b.innerHTML; b.innerHTML = '<i class="fas fa-check"></i> Copié !'; setTimeout(() => (b.innerHTML = old), 1800); }
    }).catch(() => {});
  }
}

function renderDailyIntro(d) {
  dailyTotal = d.total;
  document.getElementById('daily-total').textContent = d.total;
  document.getElementById('daily-mmr').textContent = d.soloGames > 0 ? d.soloMmr : '—';
  document.getElementById('daily-tier').innerHTML = d.tier ? tierBadge(d.tier) : 'Non classé';
  document.getElementById('daily-best').textContent = d.soloBestScore || 0;
  document.getElementById('daily-streak').textContent = d.streak || 0;
  const rank = document.getElementById('daily-rank');
  rank.innerHTML = d.tier ? `${tierBadge(d.tier)} <span class="mmr-value">${d.soloMmr}</span> <span class="mmr-unit">MMR</span>` : 'Pas encore classé';

  const done = document.getElementById('daily-done');
  const start = document.getElementById('daily-start');
  document.getElementById('daily-intro-msg').textContent = '';
  if (d.played && d.run) {
    done.classList.remove('hidden');
    document.getElementById('daily-done-detail').textContent =
      `Score du jour : ${d.run.score} · ${d.run.correct}/${d.run.total} bonnes réponses. Reviens demain !`;
    start.classList.add('hidden');
  } else {
    done.classList.add('hidden');
    start.classList.remove('hidden');
    start.innerHTML = d.inProgress
      ? '<i class="fas fa-play"></i> Reprendre le défi'
      : '<i class="fas fa-play"></i> Jouer le défi';
  }
}

async function startDaily() {
  document.getElementById('daily-intro-msg').textContent = 'Préparation…';
  let s;
  try {
    s = await api('/api/daily/start', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    document.getElementById('daily-intro-msg').textContent = e.message;
    return;
  }
  dailyScore = 0;
  document.getElementById('daily-score').textContent = '0 pts';
  dailyShow('game');
  playDailySong(s);
}

async function playDailySong(s) {
  dailyAnswering = false;
  dailyIndex = s.index;
  dailyDuration = s.durationMs || 30000;
  document.getElementById('daily-index').textContent = s.index + 1;
  document.getElementById('daily-total').textContent = s.total;
  const fb = document.getElementById('daily-feedback');
  fb.textContent = '';
  const input = document.getElementById('daily-input');
  input.value = '';
  input.disabled = false;
  document.getElementById('daily-submit').disabled = false;
  document.getElementById('daily-skip').disabled = false;

  const v = dailyVideo();
  v.volume = (typeof getVolume === 'function' ? getVolume() : 0.8);
  document.getElementById('daily-overlay').classList.remove('hidden');
  let playing = false;
  for (let attempt = 0; attempt < 3 && !playing; attempt++) {
    try {
      fb.textContent = attempt ? `Chargement du son… tentative ${attempt + 1}/3` : 'Chargement du son…';
      v.src = attempt ? mediaUrlWithRetry(s.clipUrl, attempt) : s.clipUrl;
      v.load();
      await waitForMediaEvent(v, 'canplay');
      await v.play();
      playing = true;
    } catch {}
  }
  if (dailyIndex !== s.index) return; // une autre chanson a pris le relais
  fb.textContent = playing ? '' : '⚠️ Son indisponible — tu peux passer cette chanson.';
  setDailyPlayIcon();
  input.focus();
  startDailyTimer(dailyDuration);
}

function startDailyTimer(ms) {
  clearTimeout(dailyTimer);
  const fill = document.getElementById('daily-timefill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.classList.remove('low');
  void fill.offsetWidth;
  fill.style.transition = `width ${ms}ms linear`;
  fill.style.width = '0%';
  setTimeout(() => fill.classList.add('low'), Math.max(0, ms - 5000));
  dailyTimer = setTimeout(() => submitDaily(''), ms); // temps écoulé = réponse vide
}

async function submitDaily(forced) {
  if (dailyAnswering) return;
  dailyAnswering = true;
  clearTimeout(dailyTimer);
  document.getElementById('daily-timefill').style.width = '0%';
  const input = document.getElementById('daily-input');
  const guess = typeof forced === 'string' ? forced : input.value;
  input.disabled = true;
  document.getElementById('daily-submit').disabled = true;
  document.getElementById('daily-skip').disabled = true;
  if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('daily-input');

  let r;
  try {
    r = await api('/api/daily/guess', { method: 'POST', body: JSON.stringify({ guess }) });
  } catch (e) {
    document.getElementById('daily-feedback').textContent = e.message;
    return;
  }

  dailyVideo().play().catch(() => {}); // révèle le son en entier
  dailyScore += r.points || 0;
  document.getElementById('daily-score').textContent = `${dailyScore} pts`;
  const fb = document.getElementById('daily-feedback');
  const eng = r.answer ? `<strong>${escapeHtml(r.answer.animeTitle)}</strong>` : '';
  fb.innerHTML = (r.correct ? `✅ +${r.points} · ` : '❌ ') + `Réponse : ${eng}`;
  r.correct ? sfx.correct() : sfx.wrong();

  if (r.done) {
    setTimeout(() => renderDailyResult(r.result), 1600);
  } else {
    setTimeout(() => playDailySong(r.next), 1600);
  }
}

function renderDailyResult(res) {
  stopDailyMedia();
  dailyShow('over');
  dailyMyScore = res.score;
  document.getElementById('daily-over-score').textContent = res.score;
  document.getElementById('daily-over-correct').textContent = `${res.correct}/${res.total}`;
  document.getElementById('daily-over-mmr').textContent = res.mmrAfter;
  const delta = res.delta;
  const sign = delta >= 0 ? '+' : '';
  document.getElementById('daily-over-delta').innerHTML =
    `${res.mmrBefore} → <b>${res.mmrAfter}</b> MMR <span class="${delta >= 0 ? 'gain' : 'spend'}">(${sign}${delta})</span>`
    + (res.tier ? ` ${tierBadge(res.tier)}` : '');
  const streakLine = document.getElementById('daily-over-streak');
  if (streakLine) {
    const best = res.streak >= res.streakBest && res.streak > 1 ? ' · record !' : '';
    streakLine.innerHTML = `🔥 Série de <b>${res.streak}</b> jour${res.streak > 1 ? 's' : ''}${best} · <span class="gain">+${res.reward} 🪙</span>`;
  }
  // Le serveur a crédité la récompense : on relit le solde autoritaire.
  if (res.reward && typeof syncTokenBalance === 'function') syncTokenBalance();
  if (delta > 0) { sfx.win(); if (typeof burstConfetti === 'function') burstConfetti(30); } else { sfx.lose(); }
  loadDailyBoard(); // rafraîchit le classement du jour avec mon score
}

function stopDailyMedia() {
  clearTimeout(dailyTimer);
  const v = dailyVideo();
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}
function setDailyPlayIcon() {
  const i = document.querySelector('#daily-play i');
  if (i) i.className = dailyVideo().paused ? 'fas fa-play' : 'fas fa-pause';
}
function toggleDailyPlay() {
  const v = dailyVideo();
  if (!v.src) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
  setDailyPlayIcon();
}
function replayDaily() {
  const v = dailyVideo();
  if (!v.src) return;
  v.currentTime = 0;
  v.play().catch(() => {});
  setDailyPlayIcon();
}

function initDailyUI() {
  document.getElementById('daily-start').addEventListener('click', startDaily);
  document.getElementById('daily-submit').addEventListener('click', () => submitDaily());
  document.getElementById('daily-skip').addEventListener('click', () => submitDaily(''));
  document.getElementById('daily-play').addEventListener('click', toggleDailyPlay);
  document.getElementById('daily-replay').addEventListener('click', replayDaily);
  document.getElementById('daily-video').addEventListener('play', setDailyPlayIcon);
  document.getElementById('daily-video').addEventListener('pause', setDailyPlayIcon);
  document.getElementById('daily-volume').addEventListener('input', (e) => {
    if (typeof setVolume === 'function') setVolume(+e.target.value);
    dailyVideo().volume = +e.target.value;
  });
  document.getElementById('daily-share').addEventListener('click', shareDaily);
  document.getElementById('daily-notif-btn').addEventListener('click', enableDailyNotif);
  document.getElementById('back-home-daily').addEventListener('click', () => { stopDailyMedia(); navTo('play'); });
  document.getElementById('daily-see-lb').addEventListener('click', () => {
    if (typeof openLeaderboard === 'function') { navTo('leaderboard'); setTimeout(() => { const t = document.querySelector('.lb-tab[data-lb="solo"]'); if (t) t.click(); }, 50); }
  });
  if (typeof setupAnimeAutocomplete === 'function') {
    setupAnimeAutocomplete({ inputId: 'daily-input', listId: 'daily-suggestions', onSubmit: () => submitDaily() });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDailyUI);

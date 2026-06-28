// Défi du jour (solo classé) — extrait autonome (scope global partagé).
// Réutilise les globals de main.js (api, currentUser, showView, getVolume, sfx,
// escapeHtml, navTo, mediaUrlWithRetry, waitForMediaEvent, burstConfetti).
let dailyToken = null;      // jeton de manche de la chanson en cours
let dailySongId = null;
let dailyTotal = 0;
let dailyScore = 0;
let dailyDuration = 30000;  // ms (fourni par le serveur)
let dailyTimer = null;      // chrono de la chanson
let dailyAnswering = false;
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
}

function renderDailyIntro(d) {
  dailyTotal = d.total;
  document.getElementById('daily-total').textContent = d.total;
  document.getElementById('daily-mmr').textContent = d.soloGames > 0 ? d.soloMmr : '—';
  document.getElementById('daily-tier').textContent = d.tier ? `${d.tier.icon} ${d.tier.name}` : 'Non classé';
  document.getElementById('daily-best').textContent = d.soloBestScore || 0;
  document.getElementById('daily-streak').textContent = d.streak || 0;
  const rank = document.getElementById('daily-rank');
  rank.innerHTML = d.tier ? `${d.tier.icon} <b>${escapeHtml(d.tier.name)}</b> · ${d.soloMmr} MMR` : 'Pas encore classé';

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
  dailyToken = s.roundToken;
  dailySongId = s.songId;
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
  if (dailySongId !== s.songId) return; // une autre chanson a pris le relais
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
    r = await api('/api/daily/guess', { method: 'POST', body: JSON.stringify({ roundToken: dailyToken, guess }) });
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
  document.getElementById('daily-over-score').textContent = res.score;
  document.getElementById('daily-over-correct').textContent = `${res.correct}/${res.total}`;
  document.getElementById('daily-over-mmr').textContent = res.mmrAfter;
  const delta = res.delta;
  const sign = delta >= 0 ? '+' : '';
  document.getElementById('daily-over-delta').innerHTML =
    `${res.mmrBefore} → <b>${res.mmrAfter}</b> MMR <span class="${delta >= 0 ? 'gain' : 'spend'}">(${sign}${delta})</span>`
    + (res.tier ? ` · ${res.tier.icon} ${escapeHtml(res.tier.name)}` : '');
  const streakLine = document.getElementById('daily-over-streak');
  if (streakLine) {
    const best = res.streak >= res.streakBest && res.streak > 1 ? ' · record !' : '';
    streakLine.innerHTML = `🔥 Série de <b>${res.streak}</b> jour${res.streak > 1 ? 's' : ''}${best} · <span class="gain">+${res.reward} 🪙</span>`;
  }
  // Le serveur a crédité la récompense : on relit le solde autoritaire.
  if (res.reward && typeof syncTokenBalance === 'function') syncTokenBalance();
  if (delta > 0) { sfx.win(); if (typeof burstConfetti === 'function') burstConfetti(30); } else { sfx.lose(); }
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

document.addEventListener('DOMContentLoaded', () => {
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
  document.getElementById('back-home-daily').addEventListener('click', () => { stopDailyMedia(); navTo('play'); });
  document.getElementById('daily-see-lb').addEventListener('click', () => {
    if (typeof openLeaderboard === 'function') { navTo('leaderboard'); setTimeout(() => { const t = document.querySelector('.lb-tab[data-lb="solo"]'); if (t) t.click(); }, 50); }
  });
  if (typeof setupAnimeAutocomplete === 'function') {
    setupAnimeAutocomplete({ inputId: 'daily-input', listId: 'daily-suggestions', onSubmit: () => submitDaily() });
  }
});

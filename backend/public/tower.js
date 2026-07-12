// Château de l'Infini — extrait de main.js (script classique, scope global partagé).
// Chargé APRÈS main.js dans index.html : réutilise ses globals (currentUser, api,
// settings, escapeHtml, otherAvatar, getVolume…). Ne pas charger comme module ES.

// ── CHÂTEAU DE L'INFINI ──
let towerRun = null; // payload de l'étage en cours
let towerAnswering = false;
let towerTimer = null; // setTimeout d'expiration du chrono
let towerEntryCost = 40;
let towerFreeAvailable = false;
let towerEntryKnown = false;
const towerVideo = () => document.getElementById('tower-video');

function towerShowPanel(which) {
  document.getElementById('tower-intro').classList.toggle('hidden', which !== 'intro');
  document.getElementById('tower-game').classList.toggle('hidden', which !== 'game');
  document.getElementById('tower-over').classList.toggle('hidden', which !== 'over');
}

async function openTower() {
  showView('tower');
  document.getElementById('tower-tokens').textContent = currentUser.tokens;
  document.getElementById('tower-intro-msg').textContent = '';
  try {
    const s = await api('/api/tower/status');
    document.getElementById('tower-best').textContent = s.bestFloor;
    document.getElementById('tower-cost').textContent = s.entryCost;
    document.getElementById('tower-free').textContent = s.freeAvailable ? 'Dispo ✅' : 'Utilisée';
    towerEntryCost = s.entryCost;
    towerFreeAvailable = s.freeAvailable;
    towerEntryKnown = true;
    const notice = document.getElementById('tower-entry-notice');
    const title = document.getElementById('tower-entry-title');
    const detail = document.getElementById('tower-entry-detail');
    const start = document.getElementById('tower-start');
    notice.classList.toggle('free', towerFreeAvailable);
    notice.classList.toggle('paid', !towerFreeAvailable);
    if (s.freeAvailable) {
      title.textContent = 'Ton entrée gratuite du jour est disponible';
      detail.textContent = 'Cette partie ne coûtera aucun token.';
      start.innerHTML = '<i class="fas fa-ticket"></i> Utiliser mon entrée gratuite';
    } else {
      title.textContent = `Cette entrée coûte ${s.entryCost} pièces`;
      detail.textContent = `Solde actuel : ${s.tokens} 🪙 · après l’entrée : ${Math.max(0, s.tokens - s.entryCost)} 🪙`;
      start.innerHTML = `<i class="fas fa-coins"></i> Payer ${s.entryCost} 🪙 et entrer`;
    }
    if (s.activeRun) {
      enterFloor(s.activeRun); // reprise d'une partie interrompue
      return;
    }
  } catch {}
  towerShowPanel('intro');
}

async function startTower() {
  const btn = document.getElementById('tower-start');
  if (towerEntryKnown && !towerFreeAvailable && currentUser.tokens < towerEntryCost) {
    document.getElementById('tower-intro-msg').textContent = `Il te faut ${towerEntryCost} 🪙 pour entrer.`;
    return;
  }
  btn.disabled = true;
  document.getElementById('tower-intro-msg').textContent = 'Ouverture des portes…';
  try {
    const r = await api('/api/tower/start', { method: 'POST', body: JSON.stringify({}) });
    if (typeof r.tokens === 'number') { currentUser.tokens = r.tokens; renderHeaderUser(); }
    enterFloor(r);
  } catch (e) {
    document.getElementById('tower-intro-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderTowerLives(lives) {
  const el = document.getElementById('tower-lives');
  el.innerHTML = Array.from({ length: Math.max(lives, 0) }, () => '❤️').join('') || '💀';
}

async function enterFloor(floor) {
  towerRun = floor;
  towerAnswering = false;
  towerShowPanel('game');
  document.getElementById('tower-tokens').textContent = currentUser.tokens;
  document.getElementById('tower-floor').textContent = floor.floor;
  renderTowerLives(floor.lives);
  const towerMsg = document.getElementById('tower-msg');
  towerMsg.textContent = 'Chargement du son…';
  document.getElementById('tower-like')?.classList.add('hidden'); // ❤ caché tant que le son n'est pas révélé
  document.getElementById('tower-report')?.classList.add('hidden');

  // 4 propositions
  document.getElementById('tower-choices').innerHTML = floor.options
    .map((o, i) => `<button class="tower-choice" data-choice="${i}">${escapeHtml(o)}</button>`)
    .join('');

  // Vidéo proxifiée (le titre ne fuite pas via l'URL). URL unique par question
  // (?t=...) + load() pour forcer le rechargement et éviter la lecture en cache.
  const v = towerVideo();
  await closePictureInPictureFor(v);
  v.volume = getVolume();
  document.getElementById('tower-overlay').classList.remove('hidden'); // audio seul
  const buttons = [...document.querySelectorAll('#tower-choices .tower-choice')];
  buttons.forEach((button) => { button.disabled = true; });
  let playing = false;
  for (let attempt = 0; attempt < 3 && !playing; attempt++) {
    try {
      towerMsg.textContent = attempt ? `Chargement du son… tentative ${attempt + 1}/3` : 'Chargement du son…';
      v.src = attempt ? mediaUrlWithRetry(floor.clipUrl, attempt) : floor.clipUrl;
      v.load();
      await waitForMediaEvent(v, 'canplay');
      await v.play();
      playing = true;
    } catch {}
  }
  if (towerRun !== floor) return;
  if (!playing) {
    towerMsg.textContent = '⚠️ Son indisponible — nouvelle tentative…';
    setTimeout(() => { if (towerRun === floor && !towerAnswering) enterFloor(floor); }, 1200);
    return;
  }
  towerMsg.textContent = '';
  buttons.forEach((button) => { button.disabled = false; });
  setTowerPlayIcon();

  startTowerTimer(floor.timeLimit);
}

function startTowerTimer(seconds) {
  clearTimeout(towerTimer);
  const fill = document.getElementById('tower-timefill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.classList.remove('low');
  // force reflow puis lance l'animation linéaire
  void fill.offsetWidth;
  fill.style.transition = `width ${seconds}s linear`;
  fill.style.width = '0%';
  setTimeout(() => fill.classList.add('low'), Math.max(0, (seconds - 4) * 1000));
  towerTimer = setTimeout(() => answerTower(null, true), seconds * 1000);
}

async function answerTower(choice, timeout = false) {
  if (!towerRun || towerAnswering) return;
  towerAnswering = true;
  clearTimeout(towerTimer);
  document.getElementById('tower-timefill').style.width = '0%';
  const buttons = [...document.querySelectorAll('#tower-choices .tower-choice')];
  buttons.forEach((b) => (b.disabled = true));
  if (choice != null && buttons[choice]) buttons[choice].classList.add('chosen');

  let r;
  try {
    r = await api('/api/tower/answer', {
      method: 'POST',
      body: JSON.stringify({ runId: towerRun.runId, choice, timeout }),
    });
  } catch (e) {
    document.getElementById('tower-msg').textContent = e.message;
    towerAnswering = false;
    return;
  }

  // Révèle la bonne réponse
  if (buttons[r.correctIndex]) buttons[r.correctIndex].classList.add('correct');
  if (!r.correct && choice != null && buttons[choice]) buttons[choice].classList.add('wrong');

  if (typeof r.tokens === 'number') { currentUser.tokens = r.tokens; renderHeaderUser(); }

  const msg = document.getElementById('tower-msg');
  if (r.correct) {
    msg.textContent = r.lifeGained ? '✅ Bien vu ! ❤️ +1 vie !' : '✅ Bien vu !';
    sfx.correct();
  } else {
    msg.textContent = r.timedOut ? '⏱️ Temps écoulé !' : '❌ Raté !';
    sfx.wrong();
  }
  // Bouton ❤ : on connaît enfin la musique (révélée) → on peut l'ajouter à la playlist.
  if (typeof setupQuickLike === 'function') setupQuickLike(document.getElementById('tower-like'), r.songId);
  setupTowerReport(r.songId);

  if (r.status === 'over') {
    setTimeout(() => showTowerOver(r), 2200);
  } else {
    setTimeout(() => enterFloor(r.next), 2200);
  }
}

// Bouton « Signaler » (drapeau) à côté du ❤ en révélation — même position que
// le son ne correspond à aucune des 4 réponses proposées ne peut être décrit
// précisément qu'à ce moment-là (avant révélation, ni titre ni id AniList ne
// sont visibles côté client, cf. commentaire anti-triche de floorPayload).
function setupTowerReport(songId) {
  const btn = document.getElementById('tower-report');
  if (!btn) return;
  if (!songId || !currentUser || currentUser.isGuest) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.disabled = false;
  btn.classList.remove('liked');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('/api/quiz/report-song', { method: 'POST', body: JSON.stringify({ songId, context: 'tower' }) });
      btn.classList.add('liked'); // réutilise le style ❤ « actif » du bouton pour confirmer visuellement
      btn.title = 'Signalé — merci !';
    } catch {
      btn.disabled = false; // échec réseau : on laisse réessayer
    }
  };
}

function showTowerOver(result) {
  stopTowerMedia();
  towerShowPanel('over');
  document.getElementById('tower-over-floor').textContent = result.bestFloor ?? '—';
  document.getElementById('tower-over-cleared').textContent = result.cleared ?? 0;
  document.getElementById('tower-over-reward').textContent = result.reward ?? 0;
  document.getElementById('tower-tokens').textContent = currentUser.tokens;
  if ((result.cleared ?? 0) >= 10) { sfx.win(); burstConfetti(); } else if (result.cleared > 0) sfx.win(); else sfx.lose();
}

async function abandonTower() {
  if (!towerRun) return;
  if (!confirm('Abandonner la partie ? Tu gardes les tokens des étages déjà franchis.')) return;
  clearTimeout(towerTimer);
  try {
    const r = await api('/api/tower/abandon', { method: 'POST', body: JSON.stringify({ runId: towerRun.runId }) });
    if (typeof r.tokens === 'number') { currentUser.tokens = r.tokens; renderHeaderUser(); }
    showTowerOver(r);
  } catch (e) {
    document.getElementById('tower-msg').textContent = e.message;
  }
}

function stopTowerMedia() {
  clearTimeout(towerTimer);
  const v = towerVideo();
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
}
function setTowerPlayIcon() {
  const i = document.querySelector('#tower-play i');
  if (i) i.className = towerVideo().paused ? 'fas fa-play' : 'fas fa-pause';
}
function toggleTowerPlay() {
  const v = towerVideo();
  if (!v.src) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
  setTowerPlayIcon();
}
function replayTower() {
  const v = towerVideo();
  if (!v.src) return;
  v.currentTime = 0;
  v.play().catch(() => {});
  setTowerPlayIcon();
}

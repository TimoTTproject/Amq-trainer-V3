// Anime Music Quiz — frontend (Phase 1 : auth + quiz solo)
const API = ''; // même origine que le serveur Express

// ── état ──
let currentSong = null;
let answered = false;
let mode = localStorage.getItem('amq_mode') || 'mine';
let clipTimer = null; // coupe l'extrait après la durée choisie
const video = () => document.getElementById('quiz-video');

// Réglages quiz (persistés)
const settings = {
  randomStart: localStorage.getItem('amq_randomStart') !== 'false',
  clipSeconds: parseInt(localStorage.getItem('amq_clip') ?? '20'),
};

// ── helpers API ──
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

// ── init ──
document.addEventListener('DOMContentLoaded', async () => {
  setupAuthUI();
  setupAppUI();

  // Retour d'OAuth AniList
  const params = new URLSearchParams(location.search);
  if (params.get('auth')) {
    history.replaceState({}, '', location.pathname);
    if (params.get('auth') === 'error') showAuthError("La connexion AniList a échoué.");
  }

  // Bouton AniList visible seulement si configuré côté serveur
  try {
    const { configured } = await api('/api/auth/anilist/status');
    document.getElementById('anilist-login-btn').classList.toggle('hidden', !configured);
    document.getElementById('anilist-sep').classList.toggle('hidden', !configured);
    document.getElementById('anilist-disabled').classList.toggle('hidden', configured);
  } catch {}

  // Déjà connecté ?
  try {
    const { user } = await api('/api/auth/me');
    showApp(user);
  } catch {
    showAuth();
  }
});

// ── AUTH UI ──
function setupAuthUI() {
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      document.getElementById('login-form').classList.toggle('hidden', !isLogin);
      document.getElementById('register-form').classList.toggle('hidden', isLogin);
      showAuthError('');
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      });
      showApp(user);
    } catch (err) { showAuthError(err.message); }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: document.getElementById('register-name').value,
          email: document.getElementById('register-email').value,
          password: document.getElementById('register-password').value,
        }),
      });
      showApp(user);
    } catch (err) { showAuthError(err.message); }
  });

  document.getElementById('anilist-login-btn').addEventListener('click', () => {
    location.href = '/api/auth/anilist';
  });
}

function showAuthError(msg) { document.getElementById('auth-error').textContent = msg || ''; }
function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}
function showApp(user) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('user-name').textContent = user.displayName;
  document.getElementById('user-tokens').textContent = user.tokens;
  if (user.anilistName) document.getElementById('anilist-username').value = user.anilistName;
  chooseInitialMode().then(() => {
    applyModeUI();
    refreshCatalogInfo();
  });
  refreshStats();
}

// Si l'utilisateur n'a jamais choisi de mode et que sa liste perso est vide,
// on démarre sur le catalogue global pour que ça marche tout de suite.
async function chooseInitialMode() {
  if (localStorage.getItem('amq_mode')) return;
  try {
    const { songs } = await api('/api/catalog/my-list');
    if (!songs.length) mode = 'global';
  } catch {}
}

// ── APP UI ──
function setupAppUI() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      localStorage.setItem('amq_mode', mode);
      applyModeUI();
      refreshCatalogInfo();
    });
  });

  document.getElementById('import-btn').addEventListener('click', startImport);
  document.getElementById('next-btn').addEventListener('click', nextSong);
  document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('replay-btn').addEventListener('click', replayClip);
  document.getElementById('reveal-video-btn').addEventListener('click', toggleVideo);

  // Réglages quiz
  const optRandom = document.getElementById('opt-random-start');
  const optClip = document.getElementById('opt-clip');
  optRandom.checked = settings.randomStart;
  optClip.value = String(settings.clipSeconds);
  optRandom.addEventListener('change', () => {
    settings.randomStart = optRandom.checked;
    localStorage.setItem('amq_randomStart', optRandom.checked);
  });
  optClip.addEventListener('change', () => {
    settings.clipSeconds = parseInt(optClip.value);
    localStorage.setItem('amq_clip', optClip.value);
  });
  document.getElementById('volume').addEventListener('input', (e) => { video().volume = +e.target.value; });
  document.getElementById('answer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') revealAnswer();
  });
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => {
    b.addEventListener('click', () => sendFeedback(b.dataset.fb));
  });
}

function applyModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
}

async function refreshCatalogInfo() {
  try {
    if (mode === 'global') {
      const s = await api('/api/catalog/stats');
      document.getElementById('catalog-info').textContent = `${s.totalSongs} musiques · ${s.totalAnimes} animes`;
    } else {
      const { songs } = await api('/api/catalog/my-list');
      document.getElementById('catalog-info').textContent = `${songs.length} musiques dans ma liste`;
    }
  } catch (e) { document.getElementById('catalog-info').textContent = ''; }
}

async function refreshStats() {
  try {
    const s = await api('/api/quiz/stats');
    document.getElementById('stat-played').textContent = s.played;
    document.getElementById('stat-correct').textContent = s.correct;
    document.getElementById('stat-rate').textContent = s.rate + '%';
  } catch {}
}

// ── Import (SSE) ──
function startImport() {
  const username = document.getElementById('anilist-username').value.trim();
  const limit = document.getElementById('import-limit').value || 50;
  if (!username) return alert('Renseigne un pseudo AniList.');

  const prog = document.getElementById('import-progress');
  const fill = document.getElementById('progress-fill');
  const status = document.getElementById('progress-status');
  prog.classList.remove('hidden');
  status.textContent = 'Connexion…';

  const es = new EventSource(`/api/catalog/import?username=${encodeURIComponent(username)}&limit=${limit}`);
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.error) { status.textContent = 'Erreur : ' + d.error; es.close(); return; }
    if (d.progress != null) fill.style.width = d.progress + '%';
    if (d.message) status.textContent = d.message;
    if (d.completed) {
      status.textContent = `Terminé : ${d.totalSongs} musiques (${d.matchedAnime} animes).`;
      es.close();
      refreshCatalogInfo();
      setTimeout(() => prog.classList.add('hidden'), 4000);
    }
  };
  es.onerror = () => { status.textContent = 'Connexion interrompue.'; es.close(); };
}

// ── Quiz ──
function setHint(msg) { document.getElementById('quiz-hint').textContent = msg || ''; }
function showOverlay(show) { document.getElementById('audio-overlay').classList.toggle('hidden', !show); }

async function nextSong() {
  resetQuizUI();
  setHint('Chargement…');
  let song;
  try {
    ({ song } = await api(`/api/quiz/random?mode=${mode}`));
  } catch (err) {
    setHint(err.message + (mode === 'mine' ? " — importe d'abord ta liste, ou passe en « Catalogue global »." : ''));
    return;
  }
  currentSong = song;
  answered = false;
  const v = video();
  v.src = song.videoUrl;
  v.volume = +document.getElementById('volume').value;
  showOverlay(true); // mode audio : on masque l'image, le son joue quand même

  document.getElementById('answer-input').disabled = false;
  document.getElementById('reveal-btn').disabled = false;
  document.getElementById('answer-input').focus();

  await startClip(); // applique départ aléatoire + coupure, puis lance
}

// Positionne l'extrait (départ aléatoire) et le joue, en coupant après la durée choisie.
async function startClip() {
  const v = video();
  clearTimeout(clipTimer);

  const seek = () => {
    if (settings.randomStart && v.duration && isFinite(v.duration)) {
      const clip = settings.clipSeconds || 20;
      const max = Math.max(0, v.duration - clip);
      v.currentTime = Math.random() * max;
    } else {
      v.currentTime = 0;
    }
  };
  if (v.readyState >= 1 && v.duration) seek();
  else await new Promise((r) => v.addEventListener('loadedmetadata', () => { seek(); r(); }, { once: true }));

  try {
    await v.play();
    setHint("🎵 Devine l'anime à partir de l'extrait.");
  } catch {
    setHint('▶ Lecture bloquée par le navigateur — clique sur le bouton lecture.');
  }
  setPlayIcon();

  // Coupure après la durée choisie (sauf "Illimitée" ou si la vidéo est révélée)
  if (settings.clipSeconds > 0) {
    clipTimer = setTimeout(() => {
      if (!answered) v.pause();
      setPlayIcon();
    }, settings.clipSeconds * 1000);
  }
}

function replayClip() {
  if (currentSong) startClip();
}

function resetQuizUI() {
  document.getElementById('answer-result').classList.add('hidden');
  document.getElementById('answer-input').value = '';
  showOverlay(true);
}

function normalize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function revealAnswer() {
  if (!currentSong || answered) return;
  answered = true;
  clearTimeout(clipTimer); // plus de coupure une fois révélé
  video().play().catch(() => {});
  const typed = normalize(document.getElementById('answer-input').value);
  const target = normalize(currentSong.animeTitle);
  currentSong._correct = typed.length > 2 && (target.includes(typed) || typed.includes(target));

  document.getElementById('answer-anime').textContent = currentSong.animeTitle;
  document.getElementById('answer-title').textContent = currentSong.title;
  document.getElementById('answer-artist').textContent = currentSong.artist || 'Artiste inconnu';
  document.getElementById('answer-result').classList.remove('hidden');
  document.getElementById('answer-input').disabled = true;
  document.getElementById('reveal-btn').disabled = true;
  showOverlay(false); // révèle la vidéo
}

async function sendFeedback(type) {
  if (!currentSong) return;
  if (!answered) revealAnswer();
  try {
    await api('/api/quiz/feedback', {
      method: 'POST',
      body: JSON.stringify({ songId: currentSong.id, feedbackType: type, correct: !!currentSong._correct }),
    });
    await refreshStats();
  } catch {}
  nextSong();
}

// ── lecteur média ──
function togglePlay() {
  const v = video();
  if (!v.src) return;
  if (v.paused) v.play(); else v.pause();
  setPlayIcon();
}
function setPlayIcon() {
  const i = document.querySelector('#play-btn i');
  i.className = video().paused ? 'fas fa-play' : 'fas fa-pause';
}
function toggleVideo() {
  const overlay = document.getElementById('audio-overlay');
  overlay.classList.toggle('hidden'); // affiche/masque la vidéo
}

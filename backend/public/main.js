// Anime Music Quiz — frontend (Phase 1 : auth + quiz solo)
const API = ''; // même origine que le serveur Express

// ── état ──
let currentUser = null;
let pendingAvatar; // undefined = inchangé, null = retiré, string = nouvelle data URL
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
function showView(name) {
  document.getElementById('view-home').classList.toggle('hidden', name !== 'home');
  document.getElementById('view-quiz').classList.toggle('hidden', name !== 'quiz');
}

function showApp(user) {
  currentUser = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('home-name').textContent = user.displayName;
  showView('home');
  renderHeaderUser();
  if (user.anilistName) document.getElementById('anilist-username').value = user.anilistName;
  chooseInitialMode().then(() => {
    applyModeUI();
    refreshCatalogInfo();
  });
  refreshStats();
}

// Affiche un avatar : image si dispo, sinon initiale colorée
function renderAvatar(el, user) {
  if (user.avatarUrl) {
    el.style.backgroundImage = `url("${user.avatarUrl}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.textContent = (user.displayName || '?').charAt(0).toUpperCase();
  }
}

function renderHeaderUser() {
  document.getElementById('user-name').textContent = currentUser.displayName;
  document.getElementById('user-tokens').textContent = currentUser.tokens;
  renderAvatar(document.getElementById('header-avatar'), currentUser);
}

// ── PROFIL ──
function setupProfileUI() {
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  document.getElementById('profile-close').addEventListener('click', closeProfile);
  document.getElementById('profile-modal').addEventListener('click', (e) => {
    if (e.target.id === 'profile-modal') closeProfile();
  });
  document.getElementById('avatar-upload-btn').addEventListener('click', () =>
    document.getElementById('avatar-input').click()
  );
  document.getElementById('avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingAvatar = await fileToResizedDataURL(file);
      renderProfileAvatar();
    } catch {
      setProfileError("Impossible de lire cette image.");
    }
    e.target.value = '';
  });
  document.getElementById('avatar-remove-btn').addEventListener('click', () => {
    pendingAvatar = null;
    renderProfileAvatar();
  });
  document.getElementById('profile-save').addEventListener('click', saveProfile);
}

function setProfileError(msg) { document.getElementById('profile-error').textContent = msg || ''; }

function effectiveAvatar() {
  return pendingAvatar !== undefined ? pendingAvatar : currentUser.avatarUrl;
}
function renderProfileAvatar() {
  renderAvatar(document.getElementById('profile-avatar'), {
    avatarUrl: effectiveAvatar(),
    displayName: document.getElementById('profile-name').value || currentUser.displayName,
  });
}

async function openProfile() {
  pendingAvatar = undefined;
  setProfileError('');
  document.getElementById('profile-name').value = currentUser.displayName;
  document.getElementById('profile-bio').value = currentUser.bio || '';
  document.getElementById('profile-tokens').textContent = currentUser.tokens;
  document.getElementById('profile-since').textContent = currentUser.createdAt
    ? new Date(currentUser.createdAt).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
    : '—';
  renderProfileAvatar();
  document.getElementById('profile-modal').classList.remove('hidden');
  try {
    const s = await api('/api/quiz/stats');
    document.getElementById('profile-played').textContent = s.played;
    document.getElementById('profile-rate').textContent = s.rate + '%';
  } catch {}
  loadTokenHistory();
}

async function loadTokenHistory() {
  const list = document.getElementById('token-history-list');
  try {
    const { transactions } = await api('/api/economy/transactions');
    if (!transactions.length) {
      list.innerHTML = '<li class="muted">Aucune transaction pour l\'instant.</li>';
      return;
    }
    list.innerHTML = transactions
      .map((t) => {
        const d = new Date(t.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        const sign = t.amount >= 0 ? '+' : '';
        const cls = t.amount >= 0 ? 'gain' : 'spend';
        return `<li><span>${t.reason}</span><span class="amt ${cls}">${sign}${t.amount} 🪙</span><span class="date">${d}</span></li>`;
      })
      .join('');
  } catch {
    list.innerHTML = '<li class="muted">—</li>';
  }
}

function closeProfile() { document.getElementById('profile-modal').classList.add('hidden'); }

async function saveProfile() {
  setProfileError('');
  const payload = {
    displayName: document.getElementById('profile-name').value,
    bio: document.getElementById('profile-bio').value,
  };
  if (pendingAvatar !== undefined) payload.avatar = pendingAvatar;
  try {
    const { user } = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(payload) });
    currentUser = { ...currentUser, ...user };
    renderHeaderUser();
    closeProfile();
  } catch (err) {
    setProfileError(err.message);
  }
}

// Recadre une image en carré et la compresse en data URL JPEG
function fileToResizedDataURL(file, size = 256, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('img'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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

  setupProfileUI();

  // Navigation accueil ⇄ quiz
  document.getElementById('card-play').addEventListener('click', () => showView('quiz'));
  document.getElementById('card-profile').addEventListener('click', openProfile);
  document.getElementById('back-home').addEventListener('click', () => showView('home'));

  document.getElementById('import-btn').addEventListener('click', startImport);
  document.getElementById('next-btn').addEventListener('click', nextSong);
  document.getElementById('reveal-btn').addEventListener('click', guessAnswer);
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
    if (e.key === 'Enter') guessAnswer();
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

// Valide la réponse côté serveur, révèle l'anime et attribue les tokens.
async function guessAnswer() {
  if (!currentSong || answered) return;
  answered = true;
  clearTimeout(clipTimer); // plus de coupure une fois validé
  video().play().catch(() => {});
  document.getElementById('answer-input').disabled = true;
  document.getElementById('reveal-btn').disabled = true;

  let r;
  try {
    r = await api('/api/quiz/guess', {
      method: 'POST',
      body: JSON.stringify({ songId: currentSong.id, guess: document.getElementById('answer-input').value }),
    });
  } catch (e) {
    setHint(e.message);
    answered = false;
    document.getElementById('answer-input').disabled = false;
    document.getElementById('reveal-btn').disabled = false;
    return;
  }

  const verdict = document.getElementById('answer-verdict');
  verdict.textContent = r.correct
    ? `✅ Bonne réponse !  +${r.reward} 🪙`
    : '❌ Raté';
  verdict.className = 'verdict ' + (r.correct ? 'ok' : 'ko');

  document.getElementById('answer-anime').textContent = r.answer.animeTitle;
  document.getElementById('answer-title').textContent = r.answer.title;
  document.getElementById('answer-artist').textContent = r.answer.artist || 'Artiste inconnu';
  document.getElementById('answer-result').classList.remove('hidden');
  showOverlay(false); // révèle la vidéo

  if (typeof r.tokens === 'number' && currentUser) {
    currentUser.tokens = r.tokens;
    renderHeaderUser();
  }
  refreshStats();
}

async function sendFeedback(type) {
  if (!currentSong || !answered) return;
  try {
    await api('/api/quiz/feedback', {
      method: 'POST',
      body: JSON.stringify({ songId: currentSong.id, feedbackType: type }),
    });
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

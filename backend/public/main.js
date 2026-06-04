// Anime Music Quiz — frontend (Phase 1 : auth + quiz solo)
const API = ''; // même origine que le serveur Express

// ── état ──
let currentUser = null;
let pendingAvatar; // undefined = inchangé, null = retiré, string = nouvelle data URL
let currentSong = null;
let currentRoundToken = null; // jeton de manche émis par le serveur au tirage
let answered = false;
let mode = localStorage.getItem('amq_mode') || 'mine';
let gameMode = localStorage.getItem('amq_gamemode') || 'ranked'; // 'ranked' | 'casual'
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
  if (name !== 'catalog' && typeof stopCatalogAudio === 'function') stopCatalogAudio();
  if (name !== 'tower' && typeof stopTowerMedia === 'function') stopTowerMedia();
  document.getElementById('view-home').classList.toggle('hidden', name !== 'home');
  document.getElementById('view-quiz').classList.toggle('hidden', name !== 'quiz');
  document.getElementById('view-gacha').classList.toggle('hidden', name !== 'gacha');
  document.getElementById('view-catalog').classList.toggle('hidden', name !== 'catalog');
  document.getElementById('view-tower').classList.toggle('hidden', name !== 'tower');
}

function showApp(user) {
  currentUser = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('home-name').textContent = user.displayName;
  showView('home');
  applyGameModeUI();
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
  document.getElementById('profile-best-card').addEventListener('click', (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  });
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
  loadProfileCollection();
}

async function loadProfileCollection() {
  const best = document.getElementById('profile-best-card');
  try {
    const { cards } = await api('/api/gacha/collection');
    document.getElementById('profile-cards-count').textContent = cards.length;
    if (cards.length) {
      best.innerHTML = cardHTML(cards[0]);
      document.getElementById('profile-best-label').textContent =
        `Meilleure carte : ${cards[0].name} (${RARITY_LABELS[cards[0].rarity] || cards[0].rarity})`;
    } else {
      best.innerHTML = '';
      document.getElementById('profile-best-label').textContent = 'Joue au gacha pour débloquer des cartes !';
    }
  } catch {
    best.innerHTML = '';
  }
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

  // Navigation accueil ⇄ quiz ⇄ gacha
  document.getElementById('card-play').addEventListener('click', () => showView('quiz'));
  document.getElementById('card-profile').addEventListener('click', openProfile);
  document.getElementById('card-gacha').addEventListener('click', openGacha);
  document.getElementById('card-catalog').addEventListener('click', openCatalog);
  document.getElementById('card-tower').addEventListener('click', openTower);
  document.getElementById('back-home').addEventListener('click', () => showView('home'));
  document.getElementById('back-home-gacha').addEventListener('click', () => showView('home'));
  document.getElementById('back-home-catalog').addEventListener('click', () => showView('home'));
  document.getElementById('back-home-tower').addEventListener('click', () => showView('home'));
  document.getElementById('tower-start').addEventListener('click', startTower);
  document.getElementById('tower-again').addEventListener('click', openTower);
  document.getElementById('tower-abandon').addEventListener('click', abandonTower);
  document.getElementById('tower-play').addEventListener('click', toggleTowerPlay);
  document.getElementById('tower-replay').addEventListener('click', replayTower);
  document.getElementById('tower-volume').addEventListener('input', (e) => { towerVideo().volume = +e.target.value; });
  document.getElementById('tower-choices').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choice]');
    if (btn) answerTower(parseInt(btn.dataset.choice));
  });
  let catSearchTimer;
  document.getElementById('catalog-search').addEventListener('input', (e) => {
    clearTimeout(catSearchTimer);
    catSearchTimer = setTimeout(() => loadCatalogList(1, e.target.value.trim()), 300);
  });
  document.getElementById('cat-prev').addEventListener('click', () => loadCatalogList(catalogPage - 1, catalogSearch));
  document.getElementById('cat-next').addEventListener('click', () => loadCatalogList(catalogPage + 1, catalogSearch));
  document.getElementById('pull-single').addEventListener('click', () => doPull('single'));
  document.getElementById('pull-pack').addEventListener('click', () => doPull('pack'));

  // Collection : filtre par rareté, tri, et clic sur une carte → fiche perso
  document.getElementById('coll-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    collFilter = btn.dataset.filter;
    document.querySelectorAll('#coll-filters .coll-chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.filter === collFilter)
    );
    renderCollection();
  });
  document.getElementById('coll-sort').addEventListener('change', (e) => {
    collSort = e.target.value;
    renderCollection();
  });
  const openCardFromEvent = (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  };
  document.getElementById('collection-grid').addEventListener('click', openCardFromEvent);
  document.getElementById('pull-result').addEventListener('click', openCardFromEvent);
  document.getElementById('character-close').addEventListener('click', closeCharacter);
  document.getElementById('character-modal').addEventListener('click', (e) => {
    if (e.target.id === 'character-modal') closeCharacter();
  });

  // Catalogue : lecteur audio (clic sur le bouton lecture d'une ligne)
  document.getElementById('catalog-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (btn) toggleCatalogAudio(btn);
  });

  document.getElementById('import-btn').addEventListener('click', startImport);
  document.getElementById('next-btn').addEventListener('click', nextSong);
  document.getElementById('reveal-btn').addEventListener('click', guessAnswer);
  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('replay-btn').addEventListener('click', replayClip);
  document.getElementById('reveal-video-btn').addEventListener('click', toggleVideo);
  document.getElementById('show-answer-btn').addEventListener('click', showAnswerCasual);

  // Sélecteur Classé / Entraînement
  document.querySelectorAll('.gm-btn').forEach((b) => {
    b.addEventListener('click', () => {
      gameMode = b.dataset.gm;
      localStorage.setItem('amq_gamemode', gameMode);
      applyGameModeUI();
    });
  });

  // Pause la lecture quand on quitte l'onglet
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const v = video();
      if (v && !v.paused) { v.pause(); setPlayIcon(); }
    }
  });

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

function applyGameModeUI() {
  const ranked = gameMode === 'ranked';
  document.querySelectorAll('.gm-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.gm === gameMode)
  );
  document.getElementById('gm-hint').textContent = ranked
    ? '🏆 Gagne des tokens — vidéo et réponse cachées avant validation.'
    : '🎓 Entraînement libre — vidéo et réponse accessibles, aucun token.';
  document.getElementById('show-answer-btn').classList.toggle('hidden', ranked);
  updateVideoButtonVisibility();
}

// En classé, la vidéo n'est accessible qu'après avoir validé
function updateVideoButtonVisibility() {
  const allow = gameMode === 'casual' || answered;
  document.getElementById('reveal-video-btn').classList.toggle('hidden', !allow);
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
  let song, roundToken;
  try {
    ({ song, roundToken } = await api(`/api/quiz/random?mode=${mode}&ranked=${gameMode === 'ranked'}`));
  } catch (err) {
    setHint(err.message + (mode === 'mine' ? " — importe d'abord ta liste, ou passe en « Catalogue global »." : ''));
    return;
  }
  currentSong = song;
  currentRoundToken = roundToken;
  answered = false;
  const v = video();
  v.src = song.videoUrl;
  v.volume = +document.getElementById('volume').value;
  showOverlay(true); // mode audio : on masque l'image, le son joue quand même

  document.getElementById('answer-input').disabled = false;
  document.getElementById('reveal-btn').disabled = false;
  document.getElementById('answer-input').focus();
  document.getElementById('next-btn').innerHTML = '<i class="fas fa-forward"></i> Manche suivante';
  updateVideoButtonVisibility(); // cache la vidéo en classé tant qu'on n'a pas répondu

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
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => (b.disabled = false));
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
      body: JSON.stringify({
        songId: currentSong.id,
        guess: document.getElementById('answer-input').value,
        roundToken: currentRoundToken,
      }),
    });
  } catch (e) {
    setHint(e.message);
    answered = false;
    document.getElementById('answer-input').disabled = false;
    document.getElementById('reveal-btn').disabled = false;
    return;
  }

  const verdict = document.getElementById('answer-verdict');
  if (r.correct) {
    verdict.textContent = r.reward ? `✅ Bonne réponse !  +${r.reward} 🪙` : '✅ Bonne réponse !';
  } else {
    verdict.textContent = '❌ Raté';
  }
  verdict.className = 'verdict ' + (r.correct ? 'ok' : 'ko');

  revealAnswerBox(r.answer);

  if (typeof r.tokens === 'number' && currentUser) {
    currentUser.tokens = r.tokens;
    renderHeaderUser();
  }
  refreshStats();
}

// Affiche le bloc réponse + autorise la vidéo
function revealAnswerBox(answer) {
  document.getElementById('answer-anime').textContent = answer.animeTitle;
  document.getElementById('answer-title').textContent = answer.title;
  document.getElementById('answer-artist').textContent = answer.artist || 'Artiste inconnu';
  document.getElementById('answer-result').classList.remove('hidden');
  showOverlay(false); // révèle la vidéo
  updateVideoButtonVisibility();
}

// Mode entraînement : révèle la réponse sans scorer ni gagner de tokens
async function showAnswerCasual() {
  if (!currentSong || answered) return;
  answered = true;
  clearTimeout(clipTimer);
  document.getElementById('answer-input').disabled = true;
  document.getElementById('reveal-btn').disabled = true;
  document.getElementById('answer-verdict').textContent = '🎓 Réponse révélée (entraînement)';
  document.getElementById('answer-verdict').className = 'verdict';
  try {
    const { answer } = await api(`/api/quiz/answer/${currentSong.id}?roundToken=${encodeURIComponent(currentRoundToken || '')}`);
    revealAnswerBox(answer);
  } catch (e) { setHint(e.message); }
}

async function sendFeedback(type) {
  if (!currentSong || !answered) return;
  try {
    await api('/api/quiz/feedback', {
      method: 'POST',
      body: JSON.stringify({ songId: currentSong.id, feedbackType: type }),
    });
  } catch {}
  setHint('Noté ✓ — clique sur « Manche suivante » pour continuer.');
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => (b.disabled = true));
}

// ── GACHA ──
const RARITY_LABELS = { common: 'Commun', rare: 'Rare', epic: 'Épique', legendary: 'Légendaire', mythic: 'Mythique' };
const RARITY_ORDER = ['mythic', 'legendary', 'epic', 'rare', 'common'];

function setGachaTokens() {
  document.getElementById('gacha-tokens').textContent = currentUser.tokens;
}

async function openGacha() {
  showView('gacha');
  setGachaTokens();
  document.getElementById('gacha-msg').textContent = '';
  document.getElementById('pull-result').classList.add('hidden');
  try {
    const info = await api('/api/gacha/info');
    document.getElementById('price-single').textContent = info.prices.single.cost;
    document.getElementById('price-pack').textContent = info.prices.pack.cost;
    document.getElementById('gacha-pool').textContent = `${info.total} personnages à collectionner`;
  } catch {}
  loadCollection();
}

function cardHTML(c, opts = {}) {
  const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
  const badges = [];
  if (opts.isNew) badges.push('<span class="badge new">NOUVEAU</span>');
  if (opts.refund) badges.push(`<span class="badge refund">+${opts.refund} 🪙</span>`);
  if (c.copies > 1) badges.push(`<span class="badge copies">×${c.copies}</span>`);
  const cls = 'gcard r-' + c.rarity + (opts.reveal ? ' revealing' : '');
  const delay = opts.index != null ? ` style="animation-delay:${(opts.index * 0.45).toFixed(2)}s"` : '';
  const cid = c.id != null ? ` data-cid="${c.id}"` : '';
  return `<div class="${cls}"${delay}${cid}>
    <div class="gcard-img" ${img}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
    </div>
    ${badges.join('')}
  </div>`;
}

async function doPull(type) {
  const single = document.getElementById('pull-single');
  const pack = document.getElementById('pull-pack');
  single.disabled = pack.disabled = true;
  document.getElementById('gacha-msg').textContent = 'Ouverture…';
  try {
    const r = await api('/api/gacha/pull', { method: 'POST', body: JSON.stringify({ type }) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    setGachaTokens();
    const result = document.getElementById('pull-result');
    result.innerHTML = r.cards
      .map((c, i) => cardHTML(c, { isNew: c.isNew, refund: c.refund, reveal: true, index: i }))
      .join('');
    result.classList.remove('hidden');
    const refundMsg = r.refundTotal ? ` · ${r.refundTotal} 🪙 remboursés (doublons)` : '';
    document.getElementById('gacha-msg').textContent = `−${r.cost} 🪙${refundMsg}`;
    // recharge la collection une fois l'animation terminée
    setTimeout(loadCollection, r.cards.length * 450 + 400);
  } catch (err) {
    document.getElementById('gacha-msg').textContent = err.message;
  } finally {
    single.disabled = pack.disabled = false;
  }
}

// État de la collection (pour filtrer/trier sans recharger)
let collectionCards = [];
let collFilter = 'all'; // 'all' | rareté
let collSort = 'rarity'; // 'rarity' | 'name' | 'copies'

async function loadCollection() {
  const grid = document.getElementById('collection-grid');
  const prog = document.getElementById('collection-progress');
  try {
    const { cards, poolByRarity, ownedByRarity } = await api('/api/gacha/collection');
    collectionCards = cards;
    prog.innerHTML = RARITY_ORDER.map((r) => {
      const owned = ownedByRarity[r] || 0;
      const total = poolByRarity[r] || 0;
      return `<span class="prog r-${r}">${RARITY_LABELS[r]} ${owned}/${total}</span>`;
    }).join('');
    renderCollFilters(ownedByRarity);
    renderCollection();
  } catch {
    grid.innerHTML = '';
  }
}

// Boutons de filtre par rareté (n'affiche que les raretés possédées)
function renderCollFilters(ownedByRarity) {
  const total = collectionCards.length;
  const chips = [`<button class="coll-chip${collFilter === 'all' ? ' active' : ''}" data-filter="all">Toutes (${total})</button>`];
  RARITY_ORDER.forEach((r) => {
    const n = ownedByRarity[r] || 0;
    if (!n) return;
    chips.push(`<button class="coll-chip r-${r}${collFilter === r ? ' active' : ''}" data-filter="${r}">${RARITY_LABELS[r]} (${n})</button>`);
  });
  document.getElementById('coll-filters').innerHTML = chips.join('');
}

function renderCollection() {
  const grid = document.getElementById('collection-grid');
  if (!collectionCards.length) {
    grid.innerHTML = '<p class="muted">Aucune carte pour l\'instant. Tire ton premier personnage !</p>';
    return;
  }
  let list = collectionCards.filter((c) => collFilter === 'all' || c.rarity === collFilter);
  const rank = (r) => RARITY_ORDER.indexOf(r); // 0 = mythic … (du plus rare au plus commun)
  if (collSort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (collSort === 'copies') list = [...list].sort((a, b) => b.copies - a.copies || rank(a.rarity) - rank(b.rarity));
  else list = [...list].sort((a, b) => rank(a.rarity) - rank(b.rarity) || a.name.localeCompare(b.name));
  grid.innerHTML = list.length
    ? list.map((c) => cardHTML(c)).join('')
    : '<p class="muted">Aucune carte dans ce filtre.</p>';
}

// ── Détail personnage (modale) ──
async function openCharacter(id) {
  const modal = document.getElementById('character-modal');
  const body = document.getElementById('character-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  try {
    const d = await api(`/api/gacha/character/${id}`);
    const c = d.character;
    const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
    const rate = d.pullRate != null ? `${d.pullRate.toFixed(d.pullRate < 1 ? 2 : 1)} %` : '—';
    body.innerHTML = `
      <div class="char-hero r-${c.rarity}">
        <div class="char-img" ${img}></div>
        ${d.owned ? `<span class="badge copies">×${d.owned}</span>` : '<span class="badge new">Non possédé</span>'}
      </div>
      <h2 class="char-name">${escapeHtml(c.name)}</h2>
      <div class="char-rarity r-${c.rarity}">${d.rarityLabel}</div>
      <div class="char-stats">
        <div class="cstat"><span>${rate}</span><label>Taux de tirage</label></div>
        <div class="cstat"><span>#${d.rankInRarity}/${d.totalInRarity}</span><label>Rang en ${d.rarityLabel}</label></div>
        <div class="cstat"><span>${(c.favourites || 0).toLocaleString('fr-FR')}</span><label>❤ AniList</label></div>
        <div class="cstat"><span>+${d.dupRefund} 🪙</span><label>Doublon</label></div>
      </div>
      <a class="btn-secondary char-link" href="${d.anilistUrl}" target="_blank" rel="noopener">
        <i class="fas fa-external-link-alt"></i> Voir sur AniList
      </a>`;
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}
function closeCharacter() { document.getElementById('character-modal').classList.add('hidden'); }

// ── CATALOGUE ──
let catalogPage = 1;
let catalogSearch = '';
let catalogPages = 1;

function openCatalog() {
  showView('catalog');
  document.getElementById('catalog-search').value = '';
  loadCatalogList(1, '');
}

async function loadCatalogList(page, search) {
  if (page < 1 || (catalogPages && page > catalogPages && page !== 1)) return;
  catalogSearch = search;
  const tbody = document.getElementById('catalog-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
  try {
    const r = await api(`/api/catalog/list?page=${page}&search=${encodeURIComponent(search)}`);
    catalogPage = r.page;
    catalogPages = r.pages || 1;
    stopCatalogAudio();
    document.getElementById('catalog-total').textContent = `${r.total} openings`;
    if (!r.songs.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">Aucun résultat.</td></tr>';
    } else {
      tbody.innerHTML = r.songs
        .map((s) => {
          const playBtn = s.videoUrl
            ? `<button class="btn-play-row" data-play data-src="${escapeHtml(s.videoUrl)}" title="Écouter"><i class="fas fa-play"></i></button>`
            : '';
          return `<tr>
            <td class="cat-play-cell">${playBtn}</td>
            <td>${escapeHtml(s.animeTitle)}</td>
            <td class="nowrap">${s.type}${s.number}</td>
            <td>${escapeHtml(s.title)}</td>
            <td>${escapeHtml(s.artist || '—')}</td>
          </tr>`;
        })
        .join('');
    }
    document.getElementById('cat-pageinfo').textContent = `Page ${r.page} / ${catalogPages}`;
    document.getElementById('cat-prev').disabled = r.page <= 1;
    document.getElementById('cat-next').disabled = r.page >= catalogPages;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${e.message}</td></tr>`;
  }
}

// Lecteur audio du catalogue : un seul extrait à la fois (réutilise l'élément <audio>)
let catalogPlayingBtn = null;
function setRowPlayIcon(btn, playing) {
  const i = btn.querySelector('i');
  if (i) i.className = playing ? 'fas fa-pause' : 'fas fa-play';
}
function stopCatalogAudio() {
  const audio = document.getElementById('catalog-audio');
  audio.pause();
  if (catalogPlayingBtn) { setRowPlayIcon(catalogPlayingBtn, false); catalogPlayingBtn = null; }
}
function toggleCatalogAudio(btn) {
  const audio = document.getElementById('catalog-audio');
  // Reclic sur la ligne en cours → pause/reprise
  if (catalogPlayingBtn === btn) {
    if (audio.paused) { audio.play().catch(() => {}); setRowPlayIcon(btn, true); }
    else { audio.pause(); setRowPlayIcon(btn, false); }
    return;
  }
  if (catalogPlayingBtn) setRowPlayIcon(catalogPlayingBtn, false);
  catalogPlayingBtn = btn;
  audio.src = btn.dataset.src;
  audio.volume = +(document.getElementById('volume')?.value ?? 0.8);
  audio.play().catch(() => {});
  setRowPlayIcon(btn, true);
  audio.onended = () => stopCatalogAudio();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

// ── CHÂTEAU DE L'INFINI ──
let towerRun = null; // payload de l'étage en cours
let towerAnswering = false;
let towerTimer = null; // setTimeout d'expiration du chrono
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
    if (s.activeRun) {
      enterFloor(s.activeRun); // reprise d'une partie interrompue
      return;
    }
  } catch {}
  towerShowPanel('intro');
}

async function startTower() {
  const btn = document.getElementById('tower-start');
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

function enterFloor(floor) {
  towerRun = floor;
  towerAnswering = false;
  towerShowPanel('game');
  document.getElementById('tower-tokens').textContent = currentUser.tokens;
  document.getElementById('tower-floor').textContent = floor.floor;
  renderTowerLives(floor.lives);
  document.getElementById('tower-msg').textContent = '';

  // 4 propositions
  document.getElementById('tower-choices').innerHTML = floor.options
    .map((o, i) => `<button class="tower-choice" data-choice="${i}">${escapeHtml(o)}</button>`)
    .join('');

  // Vidéo proxifiée (le titre ne fuite pas via l'URL). URL unique par question
  // (?t=...) + load() pour forcer le rechargement et éviter la lecture en cache.
  const v = towerVideo();
  v.src = floor.clipUrl;
  v.volume = +document.getElementById('tower-volume').value;
  v.load();
  document.getElementById('tower-overlay').classList.remove('hidden'); // audio seul
  v.play().catch(() => {});
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
  } else {
    msg.textContent = r.timedOut ? '⏱️ Temps écoulé !' : '❌ Raté !';
  }

  if (r.status === 'over') {
    setTimeout(() => showTowerOver(r), 1400);
  } else {
    setTimeout(() => enterFloor(r.next), 1400);
  }
}

function showTowerOver(result) {
  stopTowerMedia();
  towerShowPanel('over');
  document.getElementById('tower-over-floor').textContent = result.bestFloor ?? '—';
  document.getElementById('tower-over-cleared').textContent = result.cleared ?? 0;
  document.getElementById('tower-over-reward').textContent = result.reward ?? 0;
  document.getElementById('tower-tokens').textContent = currentUser.tokens;
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

// Anime Music Quiz — frontend (Phase 1 : auth + quiz solo)
const API = ''; // même origine que le serveur Express

// ── état ──
let currentUser = null;
let pendingAvatar; // undefined = inchangé, null = retiré, string = nouvelle data URL
let currentSong = null;
let currentRoundToken = null; // jeton de manche émis par le serveur au tirage
let currentLiked = false; // la musique en cours est-elle dans la playlist
let isTraining = false; // session du centre d'entraînement
let trainingSource = null; // review | missed | liked | due | series | mine | global
let trainingSeries = null; // série choisie quand trainingSource === 'series'
let currentLevel = 'cash'; // cash | carre | duo (Duo/Carré/Cash)
let trainPlayed = 0, trainCorrect = 0, trainStreak = 0; // suivi de session d'entraînement
let trainingChrono = false; // mode chrono (auto-révélation)
let chronoTimer = null;
let answered = false;
let mode = localStorage.getItem('amq_mode') || 'mine';
let gameMode = 'ranked'; // « Jouer » = mode classique (tokens). L'entraînement passe par isTraining.
let quizType = localStorage.getItem('amq_quiz_type') || 'all'; // 'all' | 'OP' | 'ED'
let clipTimer = null; // coupe l'extrait après la durée choisie
const video = () => document.getElementById('quiz-video');

async function closePictureInPictureFor(media) {
  if (!media) return;
  media.disablePictureInPicture = true;
  if (document.pictureInPictureElement === media && document.exitPictureInPicture) {
    try { await document.exitPictureInPicture(); } catch {}
  }
}

function mediaUrlWithRetry(url, attempt) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}retry=${attempt}`;
}

function waitForMediaEvent(media, eventName, timeoutMs = 9000) {
  if (eventName === 'loadedmetadata' && media.readyState >= 1) return Promise.resolve();
  if (eventName === 'canplay' && media.readyState >= 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      media.removeEventListener(eventName, onReady);
      media.removeEventListener('error', onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('media')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    media.addEventListener(eventName, onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
  });
}

// ── Volume global de la musique (persistant, partagé par tous les médias) ──
function getVolume() {
  const v = parseFloat(localStorage.getItem('amq_volume'));
  return isNaN(v) ? 0.8 : Math.min(1, Math.max(0, v));
}
function applyVolume() {
  const v = getVolume();
  document.querySelectorAll('audio, video').forEach((el) => { el.volume = v; });
}
function setVolume(v) {
  v = Math.min(1, Math.max(0, v));
  localStorage.setItem('amq_volume', String(v));
  applyVolume();
  // garde tous les curseurs de volume (header + en-vue) synchronisés
  ['header-volume', 'volume', 'tower-volume'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && +el.value !== v) el.value = v;
  });
}

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
// Analytics léger : un ping de visite par chargement (visiteur anonyme persistant)
function pingVisit() {
  let vid = localStorage.getItem('amq_vid');
  if (!vid) {
    vid = (crypto.randomUUID ? crypto.randomUUID() : 'v' + Date.now() + Math.random().toString(36).slice(2));
    localStorage.setItem('amq_vid', vid);
  }
  fetch('/api/stats/hit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ visitorId: vid }),
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', async () => {
  setupAuthUI();
  setupAppUI();
  pingVisit();
  window.addEventListener('focus', () => { if (currentUser) syncTokenBalance(); });

  // Retour d'OAuth AniList
  const params = new URLSearchParams(location.search);
  if (params.get('auth')) {
    history.replaceState({}, '', location.pathname);
    if (params.get('auth') === 'error') showAuthError("La connexion AniList a échoué.");
  }

  // Boutons OAuth visibles seulement si configurés côté serveur
  try {
    const [anilist, google] = await Promise.all([
      api('/api/auth/anilist/status').catch(() => ({ configured: false })),
      api('/api/auth/google/status').catch(() => ({ configured: false })),
    ]);
    document.getElementById('anilist-login-btn').classList.toggle('hidden', !anilist.configured);
    document.getElementById('google-login-btn').classList.toggle('hidden', !google.configured);
    const any = anilist.configured || google.configured;
    document.getElementById('oauth-sep').classList.toggle('hidden', !any);
    document.getElementById('oauth-disabled').classList.toggle('hidden', any);
  } catch {}

  // Déjà connecté ?
  try {
    const { user } = await api('/api/auth/me');
    showApp(user);
    // Lien de profil partagé (?u=<id>) → ouvre la fiche du joueur
    const shared = params.get('u');
    if (shared) {
      history.replaceState({}, '', location.pathname);
      openPlayer(shared);
    }
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
  document.getElementById('google-login-btn').addEventListener('click', () => {
    location.href = '/api/auth/google';
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
  if (name !== 'mp' && typeof mpHandleLeaveView === 'function') mpHandleLeaveView(); // quitter la vue = quitter la salle
  if (name !== 'mp' && typeof stopMpMedia === 'function') stopMpMedia();
  if (name !== 'playlist' && typeof stopPlaylistAudio === 'function') stopPlaylistAudio();
  if (name !== 'quiz') { const qv = document.getElementById('quiz-video'); if (qv && !qv.paused) { qv.pause(); clearTimeout(clipTimer); } }
  document.getElementById('view-home').classList.toggle('hidden', name !== 'home');
  document.getElementById('view-play').classList.toggle('hidden', name !== 'play');
  document.getElementById('view-collection').classList.toggle('hidden', name !== 'collection');
  document.getElementById('view-community').classList.toggle('hidden', name !== 'community');
  document.getElementById('view-players').classList.toggle('hidden', name !== 'players');
  document.getElementById('view-trades').classList.toggle('hidden', name !== 'trades');
  document.getElementById('view-trade').classList.toggle('hidden', name !== 'trade');
  document.getElementById('view-quiz').classList.toggle('hidden', name !== 'quiz');
  document.getElementById('view-gacha').classList.toggle('hidden', name !== 'gacha');
  document.getElementById('view-shop').classList.toggle('hidden', name !== 'shop');
  document.getElementById('view-catalog').classList.toggle('hidden', name !== 'catalog');
  document.getElementById('view-tower').classList.toggle('hidden', name !== 'tower');
  document.getElementById('view-leaderboard').classList.toggle('hidden', name !== 'leaderboard');
  document.getElementById('view-characters').classList.toggle('hidden', name !== 'characters');
  document.getElementById('view-craft').classList.toggle('hidden', name !== 'craft');
  document.getElementById('view-admin').classList.toggle('hidden', name !== 'admin');
  document.getElementById('view-profile').classList.toggle('hidden', name !== 'profile');
  document.getElementById('view-mp').classList.toggle('hidden', name !== 'mp');
  document.getElementById('view-playlist').classList.toggle('hidden', name !== 'playlist');
  document.getElementById('view-training').classList.toggle('hidden', name !== 'training');
  document.getElementById('view-friends').classList.toggle('hidden', name !== 'friends');
  // Les sous-vues gardent leur hub parent en surbrillance dans la navbar
  const navActive = NAV_GROUP[name] || name;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === navActive));
  if (name === 'home' && typeof loadQuests === 'function') loadQuests();
}

// Rattache chaque vue de mode à son onglet hub (pour la surbrillance navbar)
const NAV_GROUP = {
  quiz: 'play', training: 'play', tower: 'play', mp: 'play',
  gacha: 'collection', shop: 'collection', catalog: 'collection', playlist: 'collection', characters: 'collection', craft: 'collection',
  friends: 'community', leaderboard: 'community', players: 'community', trades: 'community', trade: 'community',
};

// Navigation depuis la navbar
function navTo(name) {
  if (name === 'play') return showView('play');
  if (name === 'collection') return showView('collection');
  if (name === 'community') return showView('community');
  if (name === 'players') return openPlayers();
  if (name === 'trades') return openTrades();
  if (name === 'craft') return openCraft();
  if (name === 'gacha') return openGacha();
  if (name === 'shop') return openShop();
  if (name === 'catalog') return openCatalog();
  if (name === 'tower') return openTower();
  if (name === 'leaderboard') return openLeaderboard();
  if (name === 'admin') return openAdmin();
  if (name === 'profile') return openProfile();
  if (name === 'mp') return openMultiplayer();
  if (name === 'playlist') return openPlaylist();
  if (name === 'quiz') return openQuiz();
  if (name === 'training') return openTraining();
  if (name === 'friends') return openFriends();
  showView(name); // home, quiz
}

function showApp(user) {
  currentUser = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('home-name').textContent = user.displayName;
  showView('home');
  applyGameModeUI();
  renderHeaderUser();
  const linked = user.anilistListName || user.anilistName;
  if (linked) document.getElementById('anilist-username').value = linked;
  chooseInitialMode().then(() => {
    applyModeUI();
    refreshCatalogInfo();
  });
  refreshStats();
  if (typeof connectMp === 'function') connectMp(); // socket prêt → reconnexion auto si partie en cours
  if (typeof loadTradesBadge === 'function') loadTradesBadge();
  maybeOnboard();
}

// Affiche un avatar : image si dispo, sinon initiale colorée.
// Applique le cadre cosmétique de l'utilisateur connecté (renderAvatar ne sert
// que pour l'avatar du joueur courant : header + son propre profil).
function renderAvatar(el, user) {
  if (user.avatarUrl) {
    el.style.backgroundImage = `url("${user.avatarUrl}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = 'none';
    el.textContent = (user.displayName || '?').charAt(0).toUpperCase();
  }
  applyAvatarFrame(el, currentUser && currentUser.cosmetics && currentUser.cosmetics.avatarFrame);
}

// ── Cosmétiques : helpers d'application ─────────────────────
// Classes animées définies dans styles.css (à retirer avant ré-application).
const COSM_CLASSES = ['cb-neon', 'cb-shine', 'cosm-rainbow-border', 'cosm-holo-banner', 'cosm-mythic-frame'];
// Fragment de classe à injecter dans un template literal
function cosmClass(cos) { return cos && cos.className ? ' ' + cos.className : ''; }
// Fragment de style à injecter (fusion avec un style existant)
function cosmStyle(cos) { return cos && cos.css ? cos.css : ''; }

// Cadre d'avatar : un anneau (box-shadow) + éventuelle classe animée,
// sans toucher au fond (image/initiale) déjà posé.
function applyAvatarFrame(el, cos) {
  if (!el) return;
  COSM_CLASSES.forEach((c) => el.classList.remove(c));
  el.style.boxShadow = '';
  if (cos) {
    if (cos.className) el.classList.add(cos.className);
    if (cos.css) el.style.boxShadow = cos.css.replace(/^box-shadow:/, '');
  }
}

// Applique fond + classe à un conteneur (bannière de profil).
function applyBackgroundCosmetic(el, cos, baseStyle = '') {
  if (!el) return;
  COSM_CLASSES.forEach((c) => el.classList.remove(c));
  el.style.cssText = baseStyle;
  if (cos) {
    if (cos.css) el.style.cssText = (baseStyle ? baseStyle + ';' : '') + cos.css;
    if (cos.className) el.classList.add(cos.className);
  }
}

let _lastTokens = null;
function renderHeaderUser() {
  document.getElementById('user-name').textContent = currentUser.displayName;
  const tk = document.getElementById('user-tokens');
  tk.textContent = currentUser.tokens;
  if (_lastTokens !== null && currentUser.tokens !== _lastTokens) {
    tk.parentElement.classList.remove('token-bump');
    void tk.parentElement.offsetWidth;
    tk.parentElement.classList.add('token-bump');
  }
  _lastTokens = currentUser.tokens;
  const du = document.getElementById('user-dust');
  if (du) du.textContent = currentUser.dust || 0;
  renderAvatar(document.getElementById('header-avatar'), currentUser);
  document.getElementById('admin-badge').classList.toggle('hidden', !currentUser.isAdmin);
  document.getElementById('dev-tokens-btn').classList.toggle('hidden', !currentUser.isAdmin);
  document.getElementById('nav-admin').classList.toggle('hidden', !currentUser.isAdmin);
  const rk = document.getElementById('header-rank');
  if (currentUser.rankTier) {
    rk.innerHTML = `${currentUser.rankTier.icon} ${escapeHtml(currentUser.rankTier.name)}`;
    rk.classList.remove('hidden');
  } else rk.classList.add('hidden');
  document.getElementById('daily-btn').classList.toggle('hidden', !currentUser.dailyAvailable);
}

let tokenBalanceSync = null;
function syncTokenBalance() {
  if (!currentUser) return Promise.resolve(null);
  if (tokenBalanceSync) return tokenBalanceSync;
  tokenBalanceSync = api('/api/economy/balance')
    .then((balance) => {
      if (!currentUser) return balance;
      currentUser.tokens = balance.tokens;
      if (typeof balance.dust === 'number') currentUser.dust = balance.dust;
      renderHeaderUser();
      return balance;
    })
    .catch(() => null)
    .finally(() => { tokenBalanceSync = null; });
  return tokenBalanceSync;
}

async function claimDaily() {
  const btn = document.getElementById('daily-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/economy/daily', { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = r.tokens;
    currentUser.dailyAvailable = false;
    renderHeaderUser();
    if (typeof sfx !== 'undefined') sfx.levelup();
    if (typeof burstConfetti === 'function') burstConfetti();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

// Dev (admin) : se créditer des tokens
async function devGrantTokens() {
  try {
    const r = await api('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ amount: 1000 }) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
  } catch (e) { alert(e.message); }
}

// ── PROFIL ──
function setupProfileUI() {
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  document.getElementById('profile-share').addEventListener('click', shareProfile);
  document.getElementById('profile-claim').addEventListener('click', claimLevels);
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
  document.getElementById('profile-showcase').addEventListener('click', (e) => {
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

let profileData = null; // réponse riche de /api/profile/:id

async function openProfile() {
  showView('profile');
  pendingAvatar = undefined;
  setProfileError('');
  document.getElementById('profile-name').value = currentUser.displayName;
  document.getElementById('profile-bio').value = currentUser.bio || '';
  document.getElementById('profile-hero-name').textContent = currentUser.displayName;
  document.getElementById('profile-tokens').textContent = currentUser.tokens;
  renderProfileAvatar();
  loadTokenHistory();

  try {
    profileData = await api(`/api/profile/${currentUser.id}`);
  } catch {
    profileData = null;
    return;
  }
  renderProfile(profileData);
}

// Rendu commun (utilisé pour le profil perso et la fiche publique)
function renderProfile(d) {
  applyBackgroundCosmetic(
    document.querySelector('#view-profile .profile-banner'),
    d.cosmetics && d.cosmetics.profileBanner
  );
  const s = d.stats || { played: 0, correct: 0, rate: 0 };
  document.getElementById('profile-played').textContent = s.played;
  document.getElementById('profile-correct').textContent = s.correct;
  document.getElementById('profile-rate').textContent = s.rate + '%';
  document.getElementById('profile-tower').textContent = d.user.towerBestFloor || 0;
  document.getElementById('profile-cards-count').textContent = d.cardsCount || 0;
  document.getElementById('profile-tokens').textContent = d.user.tokens;
  const dustEl = document.getElementById('profile-dust');
  if (dustEl) dustEl.textContent = currentUser.dust || 0;
  const since = d.user.createdAt
    ? new Date(d.user.createdAt).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : '—';
  document.getElementById('profile-since').textContent = 'Membre depuis ' + since;

  // Niveau / XP
  const lv = d.level || { level: 1, intoLevel: 0, forNext: 1, progress: 0 };
  document.getElementById('profile-level').textContent = 'Niv. ' + lv.level;
  document.getElementById('profile-level-fill').style.width = Math.round(lv.progress * 100) + '%';
  document.getElementById('profile-level-xp').textContent = `${lv.intoLevel} / ${lv.forNext} XP`;

  // Paliers de récompense
  const lr = d.levelReward || { pending: 0, nextLevel: lv.level + 1, nextReward: 0 };
  const claimBtn = document.getElementById('profile-claim');
  const nextEl = document.getElementById('profile-next-reward');
  if (lr.pending > 0) {
    claimBtn.innerHTML = `<i class="fas fa-gift"></i> Réclamer ${lr.pending} 🪙`;
    claimBtn.disabled = false;
    claimBtn.classList.remove('hidden');
  } else {
    claimBtn.classList.add('hidden');
  }
  nextEl.textContent = `🎁 Niveau ${lr.nextLevel} = +${lr.nextReward} 🪙`;

  // Répartition + vitrine
  const owned = d.ownedByRarity || {};
  const pool = d.poolByRarity || {};
  document.getElementById('profile-rarity-breakdown').innerHTML = RARITY_ORDER.map((r) =>
    `<span class="rb-pill r-${r}">${RARITY_LABELS[r]} <b>${owned[r] || 0}</b><i>/${pool[r] || 0}</i></span>`
  ).join('');
  const show = document.getElementById('profile-showcase');
  const cards = d.showcase || [];
  if (cards.length) {
    show.innerHTML = cards.map((c) => cardHTML(c)).join('');
    document.getElementById('profile-best-label').textContent =
      `Meilleure carte : ${cards[0].name} (${RARITY_LABELS[cards[0].rarity] || cards[0].rarity})`;
  } else {
    show.innerHTML = '';
    document.getElementById('profile-best-label').textContent = 'Aucune carte pour l\'instant.';
  }

  renderProgression(d.progression || []);
  renderProfileRanked(d.ranked, d.mpRecent || []);
  renderTowerHistory(d.towerHistory || []);
  renderTopSeries(d.topSeries || []);
  renderProfileBadges(d);
}

// Graphe SVG de la réussite par jour (14 derniers jours)
function renderProgression(data) {
  const box = document.getElementById('profile-progression');
  if (!box) return;
  if (data.length < 2) { box.innerHTML = '<p class="muted">Joue sur plusieurs jours pour voir ta courbe de progression.</p>'; return; }
  const W = 300, H = 90, pad = 6;
  const n = data.length;
  const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1);
  const y = (v) => H - pad - (v / 100) * (H - 2 * pad);
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.rate).toFixed(1)}`).join(' ');
  const dots = data.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.rate).toFixed(1)}" r="2.5" fill="#6c8cff"><title>${d.day} : ${d.rate}% (${d.played} jouées)</title></circle>`).join('');
  box.innerHTML = `<svg class="prog-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${y(50)}" x2="${W - pad}" y2="${y(50)}" stroke="#2a2f42" stroke-dasharray="3 3"/>
      <polyline points="${pts}" fill="none" stroke="url(#pg)" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6c8cff"/><stop offset="1" stop-color="#8a6cff"/></linearGradient></defs>
    </svg>
    <div class="prog-legend"><span>${data[0].day.slice(5)}</span><span>Réussite % · ${data.length} j</span><span>${data[n - 1].day.slice(5)}</span></div>`;
}

function renderProfileRanked(r, recent) {
  const box = document.getElementById('profile-ranked');
  if (!r || !r.games) {
    box.innerHTML = '<p class="muted">Aucune partie classée. Lance une « Partie classée » dans le multi !</p>';
  } else {
    box.innerHTML = `<div class="ranked-card">
      <span class="ranked-tier">${r.tier.icon} ${escapeHtml(r.tier.name)}</span>
      <span class="ranked-mmr">${r.mmr} MMR</span>
      <span class="hint">${r.wins} victoire(s) · ${r.games} partie(s) · ${r.winrate}% WR</span>
    </div>`;
  }
  const hist = document.getElementById('profile-mp-history');
  hist.innerHTML = (recent || []).length
    ? recent.map((m) => {
        const d = new Date(m.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        const delta = m.ranked && m.mmrAfter != null ? m.mmrAfter - m.mmrBefore : null;
        const deltaTxt = delta != null ? ` <span class="${delta >= 0 ? 'gain' : 'spend'}">${delta >= 0 ? '+' : ''}${delta}</span>` : '';
        return `<li><span class="th-floor">${m.ranked ? '🏅' : '🎮'} ${m.placement}ᵉ/${m.players}${deltaTxt}</span><span class="date">${d}</span></li>`;
      }).join('')
    : '';
}

function renderTowerHistory(runs) {
  const el = document.getElementById('profile-tower-history');
  if (!runs.length) { el.innerHTML = '<li class="muted">Aucune partie pour l\'instant.</li>'; return; }
  el.innerHTML = runs.map((r) => {
    const d = r.finishedAt ? new Date(r.finishedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '';
    return `<li><span class="th-floor">🏰 Étage ${r.floor}</span><span class="date">${d}</span></li>`;
  }).join('');
}

function renderTopSeries(series) {
  const el = document.getElementById('profile-top-series');
  if (!series.length) { el.innerHTML = '<li class="muted">Joue des musiques pour remplir ce classement.</li>'; return; }
  const max = series[0].plays || 1;
  el.innerHTML = series.map((s) => `
    <li class="ts-row">
      <span class="ts-name">${escapeHtml(s.title)}</span>
      <span class="ts-bar"><span class="ts-fill" style="width:${Math.round((s.plays / max) * 100)}%"></span></span>
      <span class="ts-plays">${s.plays}</span>
    </li>`).join('');
}

// Réclame les récompenses de niveau
async function claimLevels() {
  const btn = document.getElementById('profile-claim');
  btn.disabled = true;
  try {
    const r = await api('/api/profile/claim-levels', { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    if (r.granted > 0) { sfx.levelup(); burstConfetti(); }
    btn.innerHTML = `<i class="fas fa-check"></i> +${r.granted} 🪙 !`;
    profileData = await api(`/api/profile/${currentUser.id}`);
    setTimeout(() => renderProfile(profileData), 1200);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
}

// Lien de profil partageable
function shareProfile() {
  const url = `${location.origin}/?u=${currentUser.id}`;
  const btn = document.getElementById('profile-share');
  navigator.clipboard?.writeText(url).then(
    () => { btn.innerHTML = '<i class="fas fa-check"></i> Lien copié !'; setTimeout(() => (btn.innerHTML = '<i class="fas fa-share-nodes"></i> Partager mon profil'), 2000); },
    () => prompt('Copie ce lien :', url)
  );
}

// Hauts faits : badges débloqués selon la progression
function renderProfileBadges(d) {
  const played = d?.stats?.played || 0;
  const rate = d?.stats?.rate || 0;
  const tower = d?.user?.towerBestFloor || 0;
  const cards = d?.cardsCount || 0;
  const owned = d?.ownedByRarity || {};
  const tokens = d?.user?.tokens || 0;
  const defs = [
    { ic: '🌟', nm: 'Premier pas', desc: 'Jouer 1 musique', got: played >= 1 },
    { ic: '🎵', nm: 'Mélomane', desc: '100 musiques jouées', got: played >= 100 },
    { ic: '🎯', nm: 'Oreille affûtée', desc: '80% de réussite (20+ parties)', got: rate >= 80 && played >= 20 },
    { ic: '🏰', nm: 'Grimpeur', desc: 'Atteindre l\'étage 10 au Château', got: tower >= 10 },
    { ic: '👑', nm: 'Maître du Château', desc: 'Atteindre l\'étage 25', got: tower >= 25 },
    { ic: '🎴', nm: 'Collectionneur', desc: 'Posséder 50 cartes', got: cards >= 50 },
    { ic: '✨', nm: 'Chasseur de légendes', desc: 'Obtenir un Légendaire', got: (owned.legendary || 0) > 0 },
    { ic: '💖', nm: 'Mythique !', desc: 'Obtenir un Mythique', got: (owned.mythic || 0) > 0 },
    { ic: '💰', nm: 'Fortune', desc: 'Avoir 1000 tokens', got: tokens >= 1000 },
  ];
  const earned = defs.filter((b) => b.got).length;
  document.getElementById('profile-badges').innerHTML =
    `<div class="badges-count">${earned}/${defs.length} débloqués</div>` +
    defs
      .map(
        (b) => `<div class="badge-item${b.got ? ' got' : ''}" title="${escapeHtml(b.desc)}">
          <span class="badge-ic">${b.ic}</span>
          <span class="badge-nm">${escapeHtml(b.nm)}</span>
        </div>`
      )
      .join('');
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

async function saveProfile() {
  setProfileError('');
  const payload = {
    displayName: document.getElementById('profile-name').value,
    bio: document.getElementById('profile-bio').value,
  };
  if (pendingAvatar !== undefined) payload.avatar = pendingAvatar;
  const btn = document.getElementById('profile-save');
  const original = btn.innerHTML;
  try {
    const { user } = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(payload) });
    currentUser = { ...currentUser, ...user };
    pendingAvatar = undefined;
    renderHeaderUser();
    document.getElementById('profile-hero-name').textContent = currentUser.displayName;
    renderProfileAvatar();
    btn.innerHTML = '<i class="fas fa-check"></i> Enregistré !';
    setTimeout(() => (btn.innerHTML = original), 1800);
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
  document.getElementById('dev-tokens-btn').addEventListener('click', devGrantTokens);
  const muteBtn = document.getElementById('mute-btn');
  const updateMuteIcon = () => {
    muteBtn.querySelector('i').className = sfx.isMuted() ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
  };
  updateMuteIcon();
  muteBtn.addEventListener('click', () => { sfx.toggleMute(); updateMuteIcon(); });
  const headerVol = document.getElementById('header-volume');
  if (headerVol) headerVol.addEventListener('input', (e) => setVolume(+e.target.value));
  setVolume(getVolume()); // synchronise tous les curseurs au volume sauvegardé
  // Filtre OP/ED du quiz
  syncTypeFilter();
  document.getElementById('type-filter').addEventListener('click', (e) => {
    const b = e.target.closest('.tf-btn');
    if (!b) return;
    quizType = b.dataset.type;
    localStorage.setItem('amq_quiz_type', quizType);
    syncTypeFilter();
  });
  document.getElementById('daily-btn').addEventListener('click', claimDaily);
  document.getElementById('share-btn').addEventListener('click', shareGame);
  // Modale À propos / Règles (déclencheurs [data-about], dispo connecté ou non)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-about]')) { e.preventDefault(); document.getElementById('about-modal').classList.remove('hidden'); }
  });
  document.getElementById('about-close').addEventListener('click', () => document.getElementById('about-modal').classList.add('hidden'));
  document.getElementById('about-modal').addEventListener('click', (e) => { if (e.target.id === 'about-modal') e.currentTarget.classList.add('hidden'); });

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
  document.getElementById('card-play').addEventListener('click', openQuiz);
  document.getElementById('card-training').addEventListener('click', openTraining);
  document.getElementById('card-profile').addEventListener('click', openProfile);
  document.getElementById('card-gacha').addEventListener('click', openGacha);
  document.getElementById('card-shop').addEventListener('click', openShop);
  document.getElementById('card-catalog').addEventListener('click', openCatalog);
  document.getElementById('card-tower').addEventListener('click', openTower);
  document.getElementById('card-mp').addEventListener('click', openMultiplayer);
  document.getElementById('back-home-shop').addEventListener('click', () => showView('collection'));
  document.getElementById('shop-groups').addEventListener('click', onShopClick);
  document.getElementById('training-exit').addEventListener('click', openTraining);
  document.getElementById('training-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-src]');
    if (!card || card.classList.contains('disabled')) return;
    if (card.dataset.src === 'series') return openSeriesPicker();
    startTraining(card.dataset.src, card.dataset.label);
  });
  let seriesTimer;
  document.getElementById('series-search').addEventListener('input', (e) => {
    clearTimeout(seriesTimer);
    seriesTimer = setTimeout(() => searchSeries(e.target.value), 300);
  });
  document.getElementById('series-results').addEventListener('click', (e) => {
    const b = e.target.closest('[data-series]');
    if (b) { trainingSeries = b.dataset.series; startTraining('series', `Série : ${b.dataset.series}`); }
  });
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.addEventListener('click', () => navTo(b.dataset.nav))
  );
  // Hubs « Jouer » et « Collection » : les cartes portent data-nav
  const hubClick = (e) => { const b = e.target.closest('[data-nav]'); if (b) navTo(b.dataset.nav); };
  document.getElementById('view-play').addEventListener('click', hubClick);
  document.getElementById('view-collection').addEventListener('click', hubClick);
  document.getElementById('view-community').addEventListener('click', hubClick);
  document.getElementById('back-community-players').addEventListener('click', () => showView('community'));
  let playersSearchTimer;
  document.getElementById('players-search').addEventListener('input', (e) => {
    clearTimeout(playersSearchTimer);
    playersSearch = e.target.value.trim();
    playersSearchTimer = setTimeout(() => loadPlayers(1), 300);
  });
  document.getElementById('players-prev').addEventListener('click', () => loadPlayers(playersPage - 1));
  document.getElementById('players-next').addEventListener('click', () => loadPlayers(playersPage + 1));
  document.getElementById('players-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-userid]');
    if (row) openPlayer(row.dataset.userid);
  });
  // Échanges
  document.getElementById('back-community-trades').addEventListener('click', () => showView('community'));
  document.getElementById('back-trade').addEventListener('click', () => showView('community'));
  document.getElementById('trade-give').addEventListener('click', (e) => {
    const b = e.target.closest('.serial-chip'); if (b) toggleTradeChip('trade-give', tradeGiveSel, b);
  });
  document.getElementById('trade-want').addEventListener('click', (e) => {
    const b = e.target.closest('.serial-chip'); if (b) toggleTradeChip('trade-want', tradeWantSel, b);
  });
  document.getElementById('trade-send').addEventListener('click', sendTrade);
  document.getElementById('trades-list').addEventListener('click', (e) => {
    const b = e.target.closest('.trade-act'); if (b) resolveTrade(b.dataset.id, b.dataset.act);
  });
  document.getElementById('back-home-lb').addEventListener('click', () => showView('community'));
  document.getElementById('back-community-friends').addEventListener('click', () => showView('community'));
  document.getElementById('lb-list').addEventListener('click', (e) => {
    const row = e.target.closest('.lb-row[data-userid]');
    if (row) openPlayer(row.dataset.userid);
  });
  document.getElementById('player-close').addEventListener('click', () =>
    document.getElementById('player-modal').classList.add('hidden')
  );
  document.getElementById('player-modal').addEventListener('click', (e) => {
    if (e.target.id === 'player-modal') document.getElementById('player-modal').classList.add('hidden');
  });
  // Pokédex personnages
  document.getElementById('open-chars-btn').addEventListener('click', openCharacters);
  document.getElementById('back-gacha-chars').addEventListener('click', () => showView('gacha'));
  // Stats de tirage (chance)
  document.getElementById('gacha-stats-btn').addEventListener('click', openGachaStats);
  document.getElementById('gacha-stats-close').addEventListener('click', () =>
    document.getElementById('gacha-stats-modal').classList.add('hidden'));
  document.getElementById('gacha-stats-modal').addEventListener('click', (e) => {
    if (e.target.id === 'gacha-stats-modal') e.currentTarget.classList.add('hidden');
  });
  let charsSearchTimer;
  document.getElementById('chars-search').addEventListener('input', (e) => {
    clearTimeout(charsSearchTimer);
    charsSearchTimer = setTimeout(() => loadCharacters(1, e.target.value.trim()), 300);
  });
  document.getElementById('chars-prev').addEventListener('click', () => loadCharacters(charsPage - 1, charsSearch));
  document.getElementById('chars-next').addEventListener('click', () => loadCharacters(charsPage + 1, charsSearch));
  document.getElementById('chars-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) { charsRarity = btn.dataset.filter; loadCharacters(1, charsSearch); }
  });
  document.getElementById('chars-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  });
  // Atelier (craft)
  document.getElementById('back-collection-craft').addEventListener('click', () => showView('collection'));
  let craftSearchTimer;
  document.getElementById('craft-search').addEventListener('input', (e) => {
    clearTimeout(craftSearchTimer);
    craftSearch = e.target.value.trim();
    craftSearchTimer = setTimeout(() => loadCraft(1), 300);
  });
  document.getElementById('craft-missing').addEventListener('change', (e) => { craftMissing = e.target.checked; loadCraft(1); });
  document.getElementById('craft-prev').addEventListener('click', () => loadCraft(craftPage - 1));
  document.getElementById('craft-next').addEventListener('click', () => loadCraft(craftPage + 1));
  document.getElementById('craft-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) { craftRarity = btn.dataset.filter; loadCraft(1); }
  });
  document.getElementById('craft-grid').addEventListener('click', (e) => {
    const btn = e.target.closest('.craft-btn');
    if (btn) craftFromAtelier(btn);
  });
  // Admin personnages
  document.getElementById('back-home-admin').addEventListener('click', () => showView('home'));
  let adminSearchTimer;
  document.getElementById('admin-search').addEventListener('input', (e) => {
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => loadAdminChars(1, e.target.value.trim()), 300);
  });
  document.getElementById('admin-prev').addEventListener('click', () => loadAdminChars(adminPage - 1, adminSearch));
  document.getElementById('admin-next').addEventListener('click', () => loadAdminChars(adminPage + 1, adminSearch));
  document.getElementById('admin-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) { adminRarity = btn.dataset.filter; loadAdminChars(1, adminSearch); }
  });
  document.getElementById('admin-tbody').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-cid]');
    if (sel) setCharacterRarity(sel.dataset.cid, sel.value, sel);
  });
  document.getElementById('admin-tbody').addEventListener('click', (e) => {
    const fb = e.target.closest('[data-feat]');
    if (fb) toggleFeatured(fb);
  });
  document.getElementById('admin-backfill-btn').addEventListener('click', runBackfillSeries);
  document.getElementById('admin-import-btn').addEventListener('click', runImportCharacters);
  document.getElementById('admin-endings-btn').addEventListener('click', runImportEndings);
  document.getElementById('admin-format-btn').addEventListener('click', runBackfillFormat);
  document.getElementById('admin-r2-btn').addEventListener('click', runR2Migration);
  document.getElementById('admin-recompute-btn').addEventListener('click', runRecomputeRarities);
  document.getElementById('admin-reset-btn').addEventListener('click', runResetMe);
  document.getElementById('admin-reset-all-btn').addEventListener('click', runResetAll);
  document.querySelectorAll('.lb-tab').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.lb-tab').forEach((t) => t.classList.remove('active'));
      b.classList.add('active');
      loadLeaderboard(b.dataset.lb);
    })
  );
  document.getElementById('back-home').addEventListener('click', () => showView('play'));
  document.getElementById('back-home-gacha').addEventListener('click', () => showView('collection'));
  document.getElementById('back-home-catalog').addEventListener('click', () => showView('collection'));
  document.getElementById('back-home-tower').addEventListener('click', () => showView('play'));
  document.getElementById('back-play-training').addEventListener('click', () => showView('play'));
  document.getElementById('back-collection-playlist').addEventListener('click', () => showView('collection'));
  document.getElementById('back-play-mp').addEventListener('click', () => showView('play'));
  document.getElementById('tower-start').addEventListener('click', startTower);
  document.getElementById('tower-again').addEventListener('click', openTower);
  document.getElementById('tower-abandon').addEventListener('click', abandonTower);
  document.getElementById('tower-play').addEventListener('click', toggleTowerPlay);
  document.getElementById('tower-replay').addEventListener('click', replayTower);
  document.getElementById('tower-volume').addEventListener('input', (e) => setVolume(+e.target.value));
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
  document.getElementById('recycle-all-btn').addEventListener('click', recycleAllDupes);
  const openCardFromEvent = (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  };
  document.getElementById('collection-grid').addEventListener('click', openCardFromEvent);
  // Tirage : clic = retourner la carte (puis ouvrir la fiche une fois révélée)
  document.getElementById('pull-result').addEventListener('click', (e) => {
    const card = e.target.closest('.flip-card[data-cid]');
    if (card) flipPullCard(card);
  });
  document.getElementById('reveal-all-btn').addEventListener('click', revealAllPull);
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
  document.getElementById('like-btn').addEventListener('click', toggleLike);
  document.getElementById('assist-carre').addEventListener('click', () => requestChoices('carre'));
  document.getElementById('assist-duo').addEventListener('click', () => requestChoices('duo'));
  document.getElementById('choice-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('.choice-opt');
    if (b && !b.disabled) guessAnswer(b.textContent);
  });
  document.getElementById('reveal-video-btn').addEventListener('click', toggleVideo);
  document.getElementById('show-answer-btn').addEventListener('click', showAnswerCasual);

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
  document.getElementById('volume').addEventListener('input', (e) => setVolume(+e.target.value));
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => {
    b.addEventListener('click', () => sendFeedback(b.dataset.fb));
  });
}

function applyModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  // L'import AniList ne concerne que « Ma liste »
  document.getElementById('import-row').classList.toggle('hidden', mode === 'global');
  document.getElementById('import-hint').classList.toggle('hidden', mode === 'global');
}

function applyGameModeUI() {
  const ranked = gameMode === 'ranked' && !isTraining; // l'entraînement est toujours casual
  document.getElementById('gm-hint').textContent = ranked
    ? 'Gagne des tokens — vidéo et réponse cachées avant validation.'
    : '🎓 Entraînement libre — vidéo et réponse accessibles, aucun token.';
  document.getElementById('show-answer-btn').classList.toggle('hidden', ranked);
  updateVideoButtonVisibility();
}

// En classé, la vidéo n'est accessible qu'après avoir validé
function updateVideoButtonVisibility() {
  const allow = gameMode === 'casual' || isTraining || answered;
  document.getElementById('reveal-video-btn').classList.toggle('hidden', !allow);
}

// Les réglages (durée d'écoute, Openings/Endings, départ aléatoire) ne s'appliquent
// qu'à la manche SUIVANTE. On les verrouille pendant une manche en cours pour éviter
// la confusion : ils se règlent AVANT « Démarrer » ou entre deux manches.
function refreshQuizOptionsLock() {
  const active = !!currentSong && !answered;
  ['opt-clip', 'opt-random-start'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = active;
  });
  const tf = document.getElementById('type-filter');
  if (tf) {
    tf.classList.toggle('locked', active);
    tf.querySelectorAll('.tf-btn').forEach((b) => { b.disabled = active; });
    tf.title = active ? 'Réglable avant de lancer une manche (ou entre deux manches)' : 'Filtrer openings / endings';
  }
}

// ── QUIZ CLASSIQUE vs CENTRE D'ENTRAÎNEMENT ──
function openQuiz() {
  isTraining = false;
  trainingSource = null;
  document.getElementById('training-banner').classList.add('hidden');
  document.querySelector('.gamemode-switch').classList.remove('hidden');
  document.getElementById('quiz-mode-panel').classList.remove('hidden');
  applyGameModeUI();
  refreshCatalogInfo();
  refreshQuizOptionsLock();
  showView('quiz');
}

async function openTraining() {
  showView('training');
  document.getElementById('series-picker').classList.add('hidden');
  const grid = document.getElementById('training-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  let s = {};
  try { s = await api('/api/quiz/training-stats'); } catch {}
  document.getElementById('srs-overview').innerHTML = `
    <div class="srs-stat"><span>${s.due ?? 0}</span><label>À réviser aujourd'hui</label></div>
    <div class="srs-stat"><span>${s.scheduled ?? 0}</span><label>Programmés</label></div>
    <div class="srs-stat"><span>${s.mastered ?? 0}</span><label>Maîtrisés 🏆</label></div>`;
  const opts = [
    { src: 'due', icon: 'fa-brain', title: 'Révision du jour', desc: 'Répétition espacée : les sons à revoir maintenant', count: s.due },
    { src: 'review', icon: 'fa-rotate-left', title: 'À revoir', desc: 'Auto : tes sons mal maîtrisés (réussite < 50 %) + ceux marqués', count: s.review },
    { src: 'missed', icon: 'fa-circle-xmark', title: 'Sons ratés', desc: 'Les sons que tu n\'as jamais trouvés', count: s.missed },
    { src: 'series', icon: 'fa-tags', title: 'Par série', desc: 'Choisis un anime et entraîne-toi uniquement dessus', count: null },
    { src: 'mine', icon: 'fa-list', title: 'Ma liste', desc: 'Ton import AniList', count: s.mine },
    { src: 'global', icon: 'fa-globe', title: 'Catalogue global', desc: 'Tout le catalogue partagé', count: null },
  ];
  grid.innerHTML = opts
    .map((o) => {
      const empty = o.count === 0;
      const badge = o.count != null ? `<span class="train-count">${o.count}</span>` : '';
      return `<button class="home-card train-card${empty ? ' disabled' : ''}"${empty ? ' disabled' : ''} data-src="${o.src}" data-label="${escapeHtml(o.title)}">
        <i class="fas ${o.icon}"></i>
        <h3>${o.title} ${badge}</h3>
        <p>${o.desc}${empty ? ' — vide pour l\'instant' : ''}</p>
      </button>`;
    })
    .join('');
}

function openSeriesPicker() {
  const p = document.getElementById('series-picker');
  p.classList.remove('hidden');
  document.getElementById('series-search').value = '';
  document.getElementById('series-results').innerHTML = '<p class="hint">Tape le nom d\'un anime…</p>';
  document.getElementById('series-search').focus();
}
async function searchSeries(q) {
  const box = document.getElementById('series-results');
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  try {
    const { series } = await api(`/api/quiz/series?q=${encodeURIComponent(q.trim())}`);
    box.innerHTML = series.length
      ? series.map((s) => `<button class="series-opt" data-series="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')
      : '<p class="muted">Aucune série trouvée.</p>';
  } catch {}
}

function startTraining(source, label) {
  isTraining = true;
  trainingSource = source;
  trainingChrono = document.getElementById('train-chrono').checked;
  trainPlayed = trainCorrect = trainStreak = 0;
  document.getElementById('training-banner').classList.remove('hidden');
  document.getElementById('training-label').innerHTML = `🎓 <b>${escapeHtml(label || 'Entraînement')}</b>${trainingChrono ? ' · ⏱' : ''}`;
  renderTrainSession();
  document.querySelector('.gamemode-switch').classList.add('hidden');
  document.getElementById('quiz-mode-panel').classList.add('hidden');
  applyGameModeUI();
  showView('quiz');
  nextSong();
}

function renderTrainSession() {
  const el = document.getElementById('training-session');
  if (!el) return;
  const rate = trainPlayed ? Math.round((trainCorrect / trainPlayed) * 100) : 0;
  el.textContent = trainPlayed ? `🎯 ${trainCorrect}/${trainPlayed} (${rate}%) · série ${trainStreak}` : '';
}
function recordTraining(correct) {
  if (!isTraining) return;
  trainPlayed++;
  if (correct) { trainCorrect++; trainStreak++; } else trainStreak = 0;
  renderTrainSession();
}

async function refreshCatalogInfo() {
  try {
    if (mode === 'global') {
      const s = await api('/api/catalog/stats');
      document.getElementById('catalog-info').textContent = `${s.totalSongs} musiques · ${s.totalAnimes} animes`;
    } else {
      const { songs } = await api('/api/catalog/my-list');
      const name = currentUser && currentUser.anilistListName ? ` (${currentUser.anilistListName})` : '';
      document.getElementById('catalog-info').textContent = `${songs.length} musiques dans ma liste${name}`;
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
  if (!username) return alert('Renseigne un pseudo AniList.');

  const prog = document.getElementById('import-progress');
  const fill = document.getElementById('progress-fill');
  const status = document.getElementById('progress-status');
  prog.classList.remove('hidden');
  status.textContent = 'Connexion…';

  const es = new EventSource(`/api/catalog/import?username=${encodeURIComponent(username)}`);
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.error) { status.textContent = 'Erreur : ' + d.error; es.close(); return; }
    if (d.progress != null) fill.style.width = d.progress + '%';
    if (d.message) status.textContent = d.message;
    if (d.completed) {
      status.textContent = `Terminé : ${d.totalSongs} musiques (${d.matchedAnime} animes).`;
      es.close();
      if (currentUser) currentUser.anilistListName = username; // liste liée au compte
      refreshCatalogInfo();
      setTimeout(() => prog.classList.add('hidden'), 4000);
    }
  };
  es.onerror = () => { status.textContent = 'Connexion interrompue.'; es.close(); };
}

// ── Quiz ──
function setHint(msg) { document.getElementById('quiz-hint').textContent = msg || ''; }
function showOverlay(show) { document.getElementById('audio-overlay').classList.toggle('hidden', !show); }

// Bouton ❤ playlist (quiz)
function setLikeButton() {
  const btn = document.getElementById('like-btn');
  btn.disabled = !currentSong;
  btn.querySelector('i').className = currentLiked ? 'fas fa-heart' : 'far fa-heart';
  btn.classList.toggle('liked', currentLiked);
}
async function toggleLike() {
  if (!currentSong) return;
  try {
    const r = await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId: currentSong.id, liked: !currentLiked }) });
    currentLiked = r.liked;
    setLikeButton();
    if (currentLiked && typeof sfx !== 'undefined') sfx.correct();
  } catch (e) { setHint(e.message); }
}

// Partage du jeu : Web Share API (mobile) sinon copie du lien
async function shareGame() {
  const url = location.origin || 'https://amqtrainer.fr';
  const btn = document.getElementById('share-btn');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Anime Music Quiz', text: "Devine l'anime à son opening — rejoins-moi !", url });
      return;
    }
    await navigator.clipboard.writeText(url);
    const old = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check"></i> Lien copié !';
    setTimeout(() => { btn.innerHTML = old; }, 1800);
  } catch {}
}

function syncTypeFilter() {
  document.querySelectorAll('#type-filter .tf-btn').forEach((b) => b.classList.toggle('active', b.dataset.type === quizType));
}

async function nextSong() {
  resetQuizUI();
  setHint('Chargement…');
  let song, roundToken, liked;
  const SOURCES = ['review', 'missed', 'liked', 'due', 'series'];
  let qs;
  if (trainingSource && SOURCES.includes(trainingSource)) {
    qs = `source=${trainingSource}&ranked=false`;
    if (trainingSource === 'series') qs += `&series=${encodeURIComponent(trainingSeries || '')}`;
  } else if (trainingSource) {
    qs = `mode=${trainingSource}&ranked=false`; // 'mine' | 'global'
  } else {
    qs = `mode=${mode}&ranked=${gameMode === 'ranked'}`;
  }
  if (quizType && quizType !== 'all') qs += `&type=${quizType}`;
  try {
    ({ song, roundToken, liked } = await api(`/api/quiz/random?${qs}`));
  } catch (err) {
    setHint(err.message + (!trainingSource && mode === 'mine' ? " — importe d'abord ta liste, ou passe en « Catalogue global »." : ''));
    return;
  }
  currentSong = song;
  currentRoundToken = roundToken;
  currentLiked = !!liked;
  currentLevel = 'cash';
  setLikeButton();
  resetAssist();
  answered = false;
  const v = video();
  await closePictureInPictureFor(v);
  const clipUrl = `/api/quiz/clip/${song.id}?rt=${encodeURIComponent(roundToken)}`;
  v.dataset.clipUrl = clipUrl;
  v.src = clipUrl; // flux proxifié (anti-triche)
  v.preload = 'auto';
  v.load();
  v.volume = getVolume();
  showOverlay(true); // mode audio : on masque l'image, le son joue quand même

  document.getElementById('answer-input').disabled = false;
  document.getElementById('reveal-btn').disabled = false;
  document.getElementById('answer-input').focus();
  document.getElementById('next-btn').innerHTML = '<i class="fas fa-forward"></i> Manche suivante';
  updateVideoButtonVisibility(); // cache la vidéo en classé tant qu'on n'a pas répondu
  refreshQuizOptionsLock(); // manche en cours → fige les réglages

  await startClip(); // applique départ aléatoire + coupure, puis lance
}

// Positionne l'extrait (départ aléatoire) et le joue, en coupant après la durée choisie.
async function startClip() {
  const v = video();
  clearTimeout(clipTimer);
  const clipUrl = v.dataset.clipUrl || v.getAttribute('src');
  if (!clipUrl) return;

  const seek = () => {
    if (settings.randomStart && v.duration && isFinite(v.duration)) {
      const clip = settings.clipSeconds || 20;
      const max = Math.max(0, v.duration - clip);
      v.currentTime = Math.random() * max;
    } else {
      v.currentTime = 0;
    }
  };
  let playing = false;
  for (let attempt = 0; attempt < 3 && !playing; attempt++) {
    try {
      if (attempt > 0) {
        setHint(`Chargement du son… tentative ${attempt + 1}/3`);
        v.src = mediaUrlWithRetry(clipUrl, attempt);
        v.load();
      } else {
        setHint('Chargement du son…');
      }
      await waitForMediaEvent(v, 'loadedmetadata');
      seek();
      await waitForMediaEvent(v, 'canplay');
      await v.play();
      playing = true;
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        setHint('▶ Lecture bloquée par le navigateur — clique sur le bouton lecture.');
        break;
      }
    }
  }
  if (!playing && !v.paused) playing = true;
  if (!playing) {
    setHint('⚠️ Le son ne charge pas. Clique sur réécouter pour relancer.');
    setPlayIcon();
    return;
  }
  setHint("🎵 Devine l'anime à partir de l'extrait.");
  setPlayIcon();

  // Coupure après la durée choisie (sauf "Illimitée" ou si la vidéo est révélée)
  if (settings.clipSeconds > 0) {
    clipTimer = setTimeout(() => {
      if (!answered) v.pause();
      setPlayIcon();
    }, settings.clipSeconds * 1000);
  }

  // Mode chrono (entraînement) : auto-révélation un peu après la fin de l'extrait
  clearTimeout(chronoTimer);
  if (isTraining && trainingChrono) {
    const limitMs = ((settings.clipSeconds || 20) + 4) * 1000;
    chronoTimer = setTimeout(() => {
      if (!answered) { setHint('⏱ Temps écoulé !'); showAnswerCasual(); }
    }, limitMs);
  }
}

function replayClip() {
  if (currentSong) startClip();
}

function resetQuizUI() {
  document.getElementById('answer-result').classList.add('hidden');
  document.getElementById('answer-input').value = '';
  if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('answer-input');
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => (b.disabled = false));
  showOverlay(true);
}

// Duo / Carré / Cash : état des aides
function resetAssist() {
  document.getElementById('answer-area').classList.remove('hidden');
  document.getElementById('choice-buttons').classList.add('hidden');
  document.getElementById('choice-buttons').innerHTML = '';
  const row = document.getElementById('assist-row');
  row.classList.toggle('hidden', isTraining); // aides (gain réduit) réservées au mode classique
  document.getElementById('assist-carre').disabled = false;
  document.getElementById('assist-duo').disabled = false;
}
function hideAssist() {
  document.getElementById('assist-row').classList.add('hidden');
}

// Passe en Carré (4) ou Duo (2) : récupère les propositions
async function requestChoices(level) {
  if (!currentSong || answered) return;
  try {
    const r = await api('/api/quiz/choices', { method: 'POST', body: JSON.stringify({ roundToken: currentRoundToken, level }) });
    currentRoundToken = r.roundToken;
    currentLevel = level;
    hideAssist();
    document.getElementById('answer-area').classList.add('hidden');
    const box = document.getElementById('choice-buttons');
    box.innerHTML = r.options.map((o) => `<button class="choice-opt">${escapeHtml(o)}</button>`).join('');
    box.classList.remove('hidden');
  } catch (e) { setHint(e.message); }
}

// Valide la réponse côté serveur, révèle l'anime et attribue les tokens.
async function guessAnswer(forcedGuess) {
  if (!currentSong || answered) return;
  if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('answer-input');
  answered = true;
  clearTimeout(clipTimer); // plus de coupure une fois validé
  clearTimeout(chronoTimer);
  video().play().catch(() => {});
  document.getElementById('answer-input').disabled = true;
  document.getElementById('reveal-btn').disabled = true;
  hideAssist();
  document.querySelectorAll('#choice-buttons .choice-opt').forEach((b) => (b.disabled = true));

  const guess = typeof forcedGuess === 'string' ? forcedGuess : document.getElementById('answer-input').value;
  let r;
  try {
    r = await api('/api/quiz/guess', {
      method: 'POST',
      body: JSON.stringify({
        songId: currentSong.id,
        guess,
        roundToken: currentRoundToken,
      }),
    });
  } catch (e) {
    setHint(e.message);
    answered = false;
    document.getElementById('answer-input').disabled = false;
    document.getElementById('reveal-btn').disabled = false;
    refreshQuizOptionsLock(); // la manche redevient active → re-fige les réglages
    return;
  }

  const verdict = document.getElementById('answer-verdict');
  if (r.correct) {
    verdict.textContent = r.reward ? `✅ Bonne réponse !  +${r.reward} 🪙` : '✅ Bonne réponse !';
    sfx.correct();
  } else {
    verdict.textContent = '❌ Raté';
    sfx.wrong();
  }
  verdict.className = 'verdict ' + (r.correct ? 'ok' : 'ko');

  revealAnswerBox(r.answer);
  recordTraining(r.correct);

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
  refreshQuizOptionsLock(); // manche résolue → réglages de nouveau modifiables
}

// Mode entraînement : révèle la réponse sans scorer ni gagner de tokens
async function showAnswerCasual() {
  if (!currentSong || answered) return;
  answered = true;
  clearTimeout(clipTimer);
  clearTimeout(chronoTimer);
  recordTraining(false); // abandon = compté comme raté dans la session
  hideAssist();
  document.querySelectorAll('#choice-buttons .choice-opt').forEach((b) => (b.disabled = true));
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

// ── QUÊTES QUOTIDIENNES ──
async function loadQuests() {
  const box = document.getElementById('home-quests');
  if (!box) return;
  try {
    const { quests } = await api('/api/quests');
    box.innerHTML =
      `<h3 class="quests-title"><i class="fas fa-bullseye"></i> Quêtes du jour</h3><div class="quests-list">` +
      quests.map((q) => {
        const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
        const right = q.claimed
          ? '<span class="quest-claimed">✓ Réclamé</span>'
          : q.done
          ? `<button class="btn-primary quest-claim" data-qid="${q.id}">Réclamer +${q.reward} 🪙</button>`
          : `<span class="quest-reward">+${q.reward} 🪙</span>`;
        return `<div class="quest-item${q.done && !q.claimed ? ' ready' : ''}">
          <div class="quest-top"><span>${escapeHtml(q.label)}</span>${right}</div>
          <div class="quest-bar"><div class="quest-fill" style="width:${pct}%"></div></div>
          <div class="quest-prog">${Math.min(q.progress, q.target)}/${q.target}</div>
        </div>`;
      }).join('') + '</div>';
  } catch { box.innerHTML = ''; }
}

async function claimQuest(id, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/quests/claim/${id}`, { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    if (typeof sfx !== 'undefined') sfx.levelup();
    if (typeof burstConfetti === 'function') burstConfetti();
    loadQuests();
  } catch (e) { alert(e.message); btn.disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('home-quests').addEventListener('click', (e) => {
    const b = e.target.closest('.quest-claim');
    if (b) claimQuest(b.dataset.qid, b);
  });
});

// ── AMIS ──
function openFriends() {
  showView('friends');
  document.getElementById('friends-search-input').value = '';
  document.getElementById('friends-search-results').innerHTML = '';
  loadFriends();
}

function friendAvatar(u) { return otherAvatar(u, 'avatar-sm'); }

async function loadFriends() {
  try {
    const d = await api('/api/friends');
    document.getElementById('friends-count').textContent = d.friends.length;
    const inc = document.getElementById('friends-incoming');
    inc.innerHTML = d.incoming.length
      ? `<h3><i class="fas fa-user-clock"></i> Demandes reçues</h3>` + d.incoming.map((u) => `
          <div class="friend-row" data-uid="${u.id}">
            ${friendAvatar(u)}<span class="friend-name">${escapeHtml(u.displayName)}</span>
            <button class="btn-primary fr-accept" data-uid="${u.id}">Accepter</button>
            <button class="btn-secondary fr-remove" data-uid="${u.id}">✕</button>
          </div>`).join('')
      : '';
    const list = document.getElementById('friends-list');
    list.innerHTML = d.friends.length
      ? d.friends.map((u) => `
          <div class="friend-row" data-uid="${u.id}">
            ${friendAvatar(u)}
            <span class="friend-name">${escapeHtml(u.displayName)} <span class="friend-dot ${u.online ? 'on' : 'off'}" title="${u.online ? 'En ligne' : 'Hors ligne'}"></span></span>
            <button class="btn-secondary fr-profile" data-uid="${u.id}">Profil</button>
            <button class="btn-secondary fr-invite" data-uid="${u.id}" ${u.online ? '' : 'disabled'}>Inviter</button>
            <button class="btn-secondary fr-remove" data-uid="${u.id}">✕</button>
          </div>`).join('')
      : '<p class="muted">Aucun ami pour l\'instant. Cherche un joueur ci-dessus !</p>';
  } catch (e) { document.getElementById('friends-list').innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`; }
}

let friendsSearchTimer;
async function searchFriends(q) {
  const box = document.getElementById('friends-search-results');
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  try {
    const { results } = await api(`/api/friends/search?q=${encodeURIComponent(q.trim())}`);
    box.innerHTML = results.length
      ? results.map((u) => `<div class="friend-row" data-uid="${u.id}">
          ${friendAvatar(u)}<span class="friend-name">${escapeHtml(u.displayName)}</span>
          <button class="btn-primary fr-add" data-uid="${u.id}">+ Ajouter</button>
        </div>`).join('')
      : '<p class="muted">Aucun joueur trouvé.</p>';
  } catch {}
}

async function friendAction(path, userId) {
  await api(`/api/friends/${path}`, { method: 'POST', body: JSON.stringify({ userId }) });
}
function inviteFriend(userId) {
  if (typeof connectMp === 'function') connectMp();
  if (!window.mpRoom || mpRoom.isPublic || !mpRoom.code) {
    alert('Crée d\'abord une salle privée (Multi → Créer une salle), puis invite ton ami.');
    return;
  }
  if (mpSocket) mpSocket.emit('mp:invite', userId);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('friends-search-input').addEventListener('input', (e) => {
    clearTimeout(friendsSearchTimer);
    friendsSearchTimer = setTimeout(() => searchFriends(e.target.value), 300);
  });
  document.getElementById('friends-search-results').addEventListener('click', async (e) => {
    const b = e.target.closest('.fr-add');
    if (b) { await friendAction('request', b.dataset.uid); b.textContent = '✓ Demandé'; b.disabled = true; loadFriends(); }
  });
  const onFriendsClick = async (e) => {
    const uid = (e.target.closest('[data-uid]') || {}).dataset?.uid;
    if (e.target.closest('.fr-accept')) { await friendAction('accept', uid); loadFriends(); }
    else if (e.target.closest('.fr-remove')) { await friendAction('remove', uid); loadFriends(); }
    else if (e.target.closest('.fr-profile')) { openPlayer(uid); }
    else if (e.target.closest('.fr-invite')) { inviteFriend(uid); }
  };
  document.getElementById('friends-incoming').addEventListener('click', onFriendsClick);
  document.getElementById('friends-list').addEventListener('click', onFriendsClick);
});

// PWA : enregistre le service worker (installable + repli hors-ligne)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ── ONBOARDING (1ʳᵉ connexion) ──
function maybeOnboard() {
  if (localStorage.getItem('amq_onboarded')) return;
  document.getElementById('onboard-modal').classList.remove('hidden');
}
function closeOnboard() {
  localStorage.setItem('amq_onboarded', '1');
  document.getElementById('onboard-modal').classList.add('hidden');
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboard-modal').addEventListener('click', (e) => {
    if (e.target.id === 'onboard-modal') closeOnboard();
  });
  document.getElementById('onboard-import').addEventListener('click', () => {
    closeOnboard();
    mode = 'mine'; localStorage.setItem('amq_mode', 'mine');
    applyModeUI();
    openQuiz();
    document.getElementById('anilist-username').focus();
  });
  document.getElementById('onboard-play').addEventListener('click', () => {
    closeOnboard();
    mode = 'global'; localStorage.setItem('amq_mode', 'global');
    applyModeUI(); refreshCatalogInfo();
    openQuiz();
  });
});

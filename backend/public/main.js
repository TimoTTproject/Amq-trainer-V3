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

// ── QUIZ CLASSIQUE vs CENTRE D'ENTRAÎNEMENT ──
function openQuiz() {
  isTraining = false;
  trainingSource = null;
  document.getElementById('training-banner').classList.add('hidden');
  document.querySelector('.gamemode-switch').classList.remove('hidden');
  document.getElementById('quiz-mode-panel').classList.remove('hidden');
  applyGameModeUI();
  refreshCatalogInfo();
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
    renderGachaMeta(info.pityLimit);
    const feat = document.getElementById('gacha-featured');
    feat.innerHTML = (info.featured && info.featured.length)
      ? `<div class="featured-title">⭐ Personnages en vedette (taux boosté)</div><div class="featured-row">${info.featured.map((c) => cardHTML(c)).join('')}</div>`
      : '';
    renderWeeklyBanner(info);
  } catch {}
  loadCollection();
}

// Bannière « vedettes de la semaine » + compte à rebours
function renderWeeklyBanner(info) {
  const el = document.getElementById('gacha-weekly');
  if (!el) return;
  const chars = info.weeklyFeatured || [];
  if (!chars.length) { el.innerHTML = ''; return; }
  const left = Math.max(0, (info.weeklyResetAt || 0) - Date.now());
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const countdown = days > 0 ? `${days}j ${hours}h` : `${hours}h`;
  el.innerHTML = `
    <div class="weekly-head">
      <span><i class="fas fa-star"></i> Vedettes de la semaine <span class="weekly-boost">+${info.weeklyBoost || 60}% de chance</span></span>
      <span class="weekly-timer"><i class="fas fa-clock"></i> ${countdown}</span>
    </div>
    <div class="featured-row">${chars.map((c) => cardHTML(c)).join('')}</div>`;
}

function renderGachaMeta(pityLimit = 60) {
  const pity = currentUser.pity || 0;
  const pct = Math.min(100, Math.round((pity / pityLimit) * 100));
  document.getElementById('gacha-meta').innerHTML = `
    <span class="gacha-dust">🌟 <b>${currentUser.dust || 0}</b> poussière</span>
    <span class="gacha-pity">Pitié <b>${pity}/${pityLimit}</b>
      <span class="pity-bar"><span class="pity-fill" style="width:${pct}%"></span></span>
    </span>`;
}

function cardHTML(c, opts = {}) {
  const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
  const badges = [];
  if (opts.isNew) badges.push('<span class="badge new">NOUVEAU</span>');
  if (opts.refund) badges.push(`<span class="badge refund">+${opts.refund} 🪙</span>`);
  if (c.copies > 1) badges.push(`<span class="badge copies">×${c.copies}</span>`);
  if (c.favorite) badges.push('<span class="badge fav">★</span>');
  if (c.featured) badges.push('<span class="badge feat-badge">VEDETTE</span>');
  const bd = !opts.noBorder && currentUser.cosmetics && currentUser.cosmetics.cardBorder;
  const cls = 'gcard r-' + c.rarity + (opts.reveal ? ' revealing' : '') + cosmClass(bd);
  const delayCss = opts.index != null ? `animation-delay:${(opts.index * 0.45).toFixed(2)}s` : '';
  const style = [delayCss, cosmStyle(bd)].filter(Boolean).join(';');
  const styleAttr = style ? ` style="${style}"` : '';
  const cid = c.id != null ? ` data-cid="${c.id}"` : '';
  return `<div class="${cls}"${styleAttr}${cid}>
    <div class="gcard-img" ${img}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
    </div>
    ${badges.join('')}
  </div>`;
}

// Carte à retourner (face cachée → face révélée), style « booster »
function flipCardHTML(c, i) {
  const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
  const badges = [];
  if (c.isNew) badges.push('<span class="badge new">NOUVEAU</span>');
  if (c.refund) badges.push(`<span class="badge refund">+${c.refund} 🪙</span>`);
  if (c.copies > 1) badges.push(`<span class="badge copies">×${c.copies}</span>`);
  if (c.featured) badges.push('<span class="badge feat-badge">VEDETTE</span>');
  const holo = ['epic', 'legendary', 'mythic'].includes(c.rarity) ? '<span class="holo"></span>' : '';
  const cb = currentUser.cosmetics && currentUser.cosmetics.cardBack;
  const bd = currentUser.cosmetics && currentUser.cosmetics.cardBorder;
  const backIcon = (cb && cb.icon) || 'fa-music';
  return `<div class="flip-card r-${c.rarity}" data-cid="${c.id}" style="animation-delay:${(i * 0.08).toFixed(2)}s">
    <div class="flip-inner">
      <div class="flip-face flip-back${cosmClass(cb)}" style="${cosmStyle(cb)}"><div class="flip-back-inner"><i class="fas ${backIcon}"></i></div></div>
      <div class="flip-face flip-front">
        <div class="gcard r-${c.rarity}${cosmClass(bd)}" style="${cosmStyle(bd)}">
          <div class="gcard-img" ${img}>${holo}</div>
          <div class="gcard-info">
            <div class="gcard-name">${escapeHtml(c.name)}</div>
            <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}${c.serial ? ` · <span class="gcard-serial">#${c.serial}</span>` : ''}</div>
          </div>
          ${badges.join('')}
        </div>
      </div>
    </div>
  </div>`;
}

async function doPull(type) {
  const single = document.getElementById('pull-single');
  const pack = document.getElementById('pull-pack');
  single.disabled = pack.disabled = true;
  document.getElementById('gacha-msg').textContent = 'Ouverture…';
  document.getElementById('reveal-all-btn').classList.add('hidden');
  try {
    const r = await api('/api/gacha/pull', { method: 'POST', body: JSON.stringify({ type }) });
    currentUser.tokens = r.tokens;
    if (typeof r.dust === 'number') currentUser.dust = r.dust;
    if (typeof r.pity === 'number') currentUser.pity = r.pity;
    renderHeaderUser();
    setGachaTokens();
    renderGachaMeta(r.pityLimit);
    pullRefundMsg = (r.refundTotal ? ` · ${r.refundTotal} 🪙` : '') + (r.dustTotal ? ` · +${r.dustTotal} 🌟` : '');
    pullCost = r.cost;
    const result = document.getElementById('pull-result');
    result.innerHTML = r.cards.map((c, i) => flipCardHTML(c, i)).join('');
    result.classList.remove('hidden');
    if (r.cards.length > 1) document.getElementById('reveal-all-btn').classList.remove('hidden');
    document.getElementById('gacha-msg').textContent = `−${r.cost} 🪙 — clique sur les cartes pour les retourner ! 🎴`;
  } catch (err) {
    document.getElementById('gacha-msg').textContent = err.message;
  } finally {
    single.disabled = pack.disabled = false;
  }
}

let pullRefundMsg = '';
let pullCost = 0;

function flipPullCard(card) {
  if (card.classList.contains('flipped')) { openCharacter(card.dataset.cid); return; }
  card.classList.add('flipped');
  const rarity = (card.className.match(/r-(\w+)/) || [])[1] || 'common';
  sfx.reveal(rarity);
  if (rarity === 'legendary' || rarity === 'mythic') burstConfetti(rarity === 'mythic' ? 40 : 26);
  if ([...document.querySelectorAll('#pull-result .flip-card')].every((c) => c.classList.contains('flipped'))) {
    onAllRevealed();
  }
}

function revealAllPull() {
  const cards = [...document.querySelectorAll('#pull-result .flip-card:not(.flipped)')];
  cards.forEach((c, i) =>
    setTimeout(() => {
      c.classList.add('flipped');
      const rarity = (c.className.match(/r-(\w+)/) || [])[1] || 'common';
      sfx.reveal(rarity);
      if (rarity === 'legendary' || rarity === 'mythic') burstConfetti(rarity === 'mythic' ? 40 : 26);
      if (i === cards.length - 1) onAllRevealed();
    }, i * 160)
  );
}

function onAllRevealed() {
  document.getElementById('reveal-all-btn').classList.add('hidden');
  document.getElementById('gacha-msg').textContent = `−${pullCost} 🪙${pullRefundMsg}`;
  loadCollection();
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

// Recycle tous les doublons de la collection en poussière
async function recycleAllDupes() {
  const dupes = collectionCards.filter((c) => c.copies > 1).reduce((s, c) => s + (c.copies - 1), 0);
  if (!dupes) { alert('Aucun doublon à recycler.'); return; }
  if (!confirm(`Recycler ${dupes} doublon(s) en poussière ? (tu gardes 1 exemplaire de chaque carte)`)) return;
  const btn = document.getElementById('recycle-all-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/gacha/recycle-all', { method: 'POST' });
    currentUser.dust = r.dust;
    renderHeaderUser();
    sfx.correct && sfx.correct();
    document.getElementById('gacha-msg').textContent = `♻️ ${r.recycled} doublon(s) recyclé(s) · +${r.gain} 🌟 (total ${r.dust})`;
    loadCollection();
  } catch (e) {
    document.getElementById('gacha-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
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

// ── Boutique de cosmétiques ─────────────────────────────────
let shopData = null;

async function openShop() {
  showView('shop');
  document.getElementById('shop-tokens').textContent = currentUser.tokens;
  document.getElementById('shop-msg').textContent = '';
  const wrap = document.getElementById('shop-groups');
  wrap.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    shopData = await api('/api/shop');
    renderShop();
  } catch (e) {
    wrap.innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

// Aperçu visuel d'un item selon son slot
function shopPreview(slot, item) {
  const cls = item.className ? ' ' + item.className : '';
  const style = item.css || '';
  if (slot === 'cardBack') {
    const icon = item.icon || 'fa-music';
    return `<span class="shop-prev shop-prev-back${cls}" style="${style}"><i class="fas ${icon}"></i></span>`;
  }
  if (slot === 'cardBorder') {
    return `<span class="shop-prev shop-prev-card${cls}" style="${style}"></span>`;
  }
  if (slot === 'profileBanner') {
    return `<span class="shop-prev shop-prev-banner${cls}" style="${style}"></span>`;
  }
  // avatarFrame
  const box = style.replace(/^box-shadow:/, '');
  return `<span class="shop-prev shop-prev-frame${cls}" style="${box ? 'box-shadow:' + box : ''}">A</span>`;
}

function renderShop() {
  document.getElementById('shop-tokens').textContent = shopData.tokens;
  const wrap = document.getElementById('shop-groups');
  wrap.innerHTML = shopData.groups.map((g) => `
    <div class="shop-group">
      <h3>${g.label}</h3>
      <div class="shop-grid">
        ${g.items.map((item) => {
          const owned = item.owned;
          const equipped = item.equipped;
          let action;
          if (equipped) action = '<span class="shop-tag equipped">Équipé</span>';
          else if (owned) action = `<button class="btn-secondary shop-btn" data-act="equip" data-id="${item.id}">Équiper</button>`;
          else action = `<button class="btn-primary shop-btn" data-act="buy" data-id="${item.id}"><b>${item.price}</b> 🪙</button>`;
          return `<div class="shop-item${equipped ? ' is-equipped' : ''}">
            ${shopPreview(g.slot, item)}
            <div class="shop-name">${escapeHtml(item.name)}</div>
            ${action}
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function onShopClick(e) {
  const btn = e.target.closest('.shop-btn');
  if (!btn) return;
  if (btn.dataset.act === 'buy') buyCosmetic(btn.dataset.id);
  else equipCosmetic(btn.dataset.id);
}

async function buyCosmetic(id) {
  const msg = document.getElementById('shop-msg');
  try {
    const r = await api('/api/shop/buy', { method: 'POST', body: JSON.stringify({ cosmeticId: id }) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    sfx.correct && sfx.correct();
    msg.textContent = 'Acheté ! Clique sur « Équiper » pour l\'utiliser.';
    // Marque l'item possédé localement puis re-rend
    markOwned(id);
    shopData.tokens = r.tokens;
    renderShop();
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function equipCosmetic(id) {
  const msg = document.getElementById('shop-msg');
  try {
    const r = await api('/api/shop/equip', { method: 'POST', body: JSON.stringify({ cosmeticId: id }) });
    // Met à jour le cosmétique équipé du joueur courant pour application immédiate
    const item = findShopItem(id);
    if (item && currentUser.cosmetics) {
      currentUser.cosmetics[r.slot] = r.equipped
        ? { id: item.id, slot: r.slot, name: item.name, css: item.css || '', className: item.className || '', icon: item.icon || null }
        : defaultCosmetic(r.slot);
    }
    setEquipped(r.slot, r.equipped);
    renderShop();
    renderHeaderUser();
    msg.textContent = 'Équipé ✓';
  } catch (err) {
    msg.textContent = err.message;
  }
}

// Le slot revient au défaut : on garde l'item gratuit (price 0) du slot
function defaultCosmetic(slot) {
  const g = shopData.groups.find((x) => x.slot === slot);
  const def = g && g.items.find((i) => i.price === 0);
  return def ? { id: def.id, slot, name: def.name, css: def.css || '', className: def.className || '', icon: def.icon || null } : null;
}
function findShopItem(id) {
  for (const g of shopData.groups) { const it = g.items.find((i) => i.id === id); if (it) return it; }
  return null;
}
function markOwned(id) {
  for (const g of shopData.groups) { const it = g.items.find((i) => i.id === id); if (it) it.owned = true; }
}
function setEquipped(slot, equippedId) {
  const g = shopData.groups.find((x) => x.slot === slot);
  if (!g) return;
  g.equipped = equippedId;
  g.items.forEach((i) => { i.equipped = equippedId ? i.id === equippedId : i.price === 0; });
}

// ── Stats de tirage (modale chance) ──
async function openGachaStats() {
  const modal = document.getElementById('gacha-stats-modal');
  const body = document.getElementById('gacha-stats-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  try {
    body.innerHTML = renderGachaStats(await api('/api/gacha/stats'));
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function renderGachaStats(d) {
  const luck = d.luck || {};
  const cls = luck.percent == null ? 'neutral' : luck.percent >= 112 ? 'lucky' : luck.percent <= 88 ? 'unlucky' : 'neutral';
  const luckHead = luck.percent == null
    ? `<div class="luck-head neutral"><div class="luck-label">${escapeHtml(luck.label)}</div></div>`
    : `<div class="luck-head ${cls}">
         <div class="luck-pct">${luck.percent}<span>%</span></div>
         <div class="luck-label">${escapeHtml(luck.label)}</div>
         <div class="hint">100 % = pile dans les taux théoriques</div>
       </div>`;
  const rows = (d.perRarity || []).map((r) => {
    const delta = r.actualRate - r.expectedRate;
    const dcls = Math.abs(delta) < 0.5 ? '' : delta > 0 ? 'up' : 'down';
    const sign = delta >= 0 ? '+' : '';
    return `<div class="gs-row">
      <div class="gs-line">
        <span class="rb-pill r-${r.rarity}">${escapeHtml(r.label)}</span>
        <span class="gs-rates">${r.actualRate.toFixed(1)}% <i class="hint">(attendu ${r.expectedRate.toFixed(1)}%)</i>
          ${dcls ? `<span class="gs-delta ${dcls}">${sign}${delta.toFixed(1)}</span>` : ''}</span>
        <span class="gs-count">×${r.count}</span>
      </div>
      <div class="gs-bar">
        <div class="gs-fill r-${r.rarity}" style="width:${Math.min(100, r.actualRate)}%"></div>
        <span class="gs-exp" style="left:${Math.min(100, r.expectedRate)}%" title="Taux attendu"></span>
      </div>
    </div>`;
  }).join('');
  return `<h2 class="gs-title"><i class="fas fa-chart-simple"></i> Mes stats de tirage</h2>
    ${luckHead}
    <div class="gs-meta"><span><b>${d.total}</b> tirage(s)</span><span>Pitié : <b>${d.pity}</b>/${d.pityLimit}</span></div>
    <div class="gs-rows">${rows}</div>
    <p class="hint gs-foot">Le repère clair sur chaque barre indique le taux attendu.</p>`;
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
      ${c.series && c.series !== '—' ? `<div class="char-series">${escapeHtml(c.series)}</div>` : ''}
      <div class="char-rarity r-${c.rarity}">${d.rarityLabel}${d.soldOut ? ' <span class="soldout-badge">ÉPUISÉ</span>' : ''}</div>
      <div class="char-stats">
        <div class="cstat"><span>${rate}</span><label>Taux de tirage</label></div>
        <div class="cstat"><span>#${d.rankInRarity}/${d.totalInRarity}</span><label>Rang en ${d.rarityLabel}</label></div>
        <div class="cstat"><span>${d.minted}/${d.maxSupply}</span><label>En circulation</label></div>
        <div class="cstat"><span>+${d.dupRefund} 🪙</span><label>Doublon</label></div>
      </div>
      ${d.serials && d.serials.length ? `<div class="char-serials"><i class="fas fa-hashtag"></i> Tes exemplaires : ${d.serials.map((s) => '#' + s).join(', ')}</div>` : ''}
      ${d.owned ? `<button class="btn-secondary char-fav${d.favorite ? ' on' : ''}" id="char-fav-btn" data-cid="${c.id}">
        <i class="fa-star ${d.favorite ? 'fas' : 'far'}"></i> ${d.favorite ? 'Favori ★' : 'Mettre en favori'}
      </button>` : ''}
      ${d.soldOut
        ? `<button class="btn-secondary char-craft" disabled><i class="fas fa-ban"></i> Épuisé — échange seulement</button>`
        : `<button class="btn-secondary char-craft" id="char-craft-btn" data-cid="${c.id}" ${(currentUser.dust || 0) < d.craftCost ? 'disabled' : ''}>
        <i class="fas fa-hammer"></i> Fabriquer · ${d.craftCost} 🌟 ${(currentUser.dust || 0) < d.craftCost ? `(tu as ${currentUser.dust || 0})` : ''}
      </button>`}
      ${d.owned > 1 ? `<button class="btn-secondary char-recycle" id="char-recycle-btn">
        <i class="fas fa-recycle"></i> Recycler ${d.owned - 1} doublon(s) · +${(d.owned - 1) * d.dustGain} 🌟
      </button>` : ''}
      <a class="btn-secondary char-link" href="${d.anilistUrl}" target="_blank" rel="noopener">
        <i class="fas fa-external-link-alt"></i> Voir sur AniList
      </a>`;
    const craftBtn = document.getElementById('char-craft-btn');
    if (craftBtn) {
      craftBtn.addEventListener('click', async () => {
        if (!confirm(`Fabriquer ${c.name} pour ${d.craftCost} 🌟 ?`)) return;
        craftBtn.disabled = true;
        try {
          const r = await api('/api/gacha/craft', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
          currentUser.dust = r.dust;
          if (typeof sfx !== 'undefined') sfx.reveal(c.rarity);
          if (typeof burstConfetti === 'function') burstConfetti();
          openCharacter(c.id); // recharge la fiche (possession + poussière à jour)
          loadCollection();
        } catch (e) { alert(e.message); craftBtn.disabled = false; }
      });
    }
    const recycleBtn = document.getElementById('char-recycle-btn');
    if (recycleBtn) {
      recycleBtn.addEventListener('click', async () => {
        if (!confirm(`Recycler ${d.owned - 1} doublon(s) de ${c.name} en poussière ?`)) return;
        recycleBtn.disabled = true;
        try {
          const r = await api('/api/gacha/recycle', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
          currentUser.dust = r.dust;
          sfx.correct && sfx.correct();
          openCharacter(c.id); // recharge la fiche (copies + poussière à jour)
          loadCollection();
        } catch (e) { alert(e.message); recycleBtn.disabled = false; }
      });
    }
    const favBtn = document.getElementById('char-fav-btn');
    if (favBtn) {
      let fav = d.favorite;
      favBtn.addEventListener('click', async () => {
        favBtn.disabled = true;
        try {
          const r = await api('/api/gacha/favorite', { method: 'POST', body: JSON.stringify({ characterId: c.id, favorite: !fav }) });
          fav = r.favorite;
          favBtn.classList.toggle('on', fav);
          favBtn.innerHTML = `<i class="fa-star ${fav ? 'fas' : 'far'}"></i> ${fav ? 'Favori ★' : 'Mettre en favori'}`;
          if (fav) sfx.correct();
        } catch (e) { alert(e.message); }
        finally { favBtn.disabled = false; }
      });
    }
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
  audio.volume = getVolume();
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
let towerEntryCost = 50;
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
    document.getElementById('tower-cost').textContent = s.admin ? '0' : s.entryCost;
    document.getElementById('tower-free').textContent = s.admin
      ? 'Admin ∞'
      : s.freeAvailable ? 'Dispo ✅' : 'Utilisée';
    towerEntryCost = s.admin ? 0 : s.entryCost;
    towerFreeAvailable = s.admin || s.freeAvailable;
    towerEntryKnown = true;
    const notice = document.getElementById('tower-entry-notice');
    const title = document.getElementById('tower-entry-title');
    const detail = document.getElementById('tower-entry-detail');
    const start = document.getElementById('tower-start');
    notice.classList.toggle('free', towerFreeAvailable);
    notice.classList.toggle('paid', !towerFreeAvailable);
    if (s.admin) {
      title.textContent = 'Entrée administrateur gratuite';
      detail.textContent = 'Aucun token ne sera débité.';
      start.innerHTML = '<i class="fas fa-play"></i> Entrer gratuitement';
    } else if (s.freeAvailable) {
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

// ── CLASSEMENT ──
const LB_UNITS = {
  tower: (v) => `Étage ${v}`,
  tokens: (v) => `${v} 🪙`,
  collection: (v) => `${v} cartes`,
  ranked: (v) => `${v} MMR`,
};

function openLeaderboard() {
  showView('leaderboard');
  document.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('active', t.dataset.lb === 'ranked'));
  loadLeaderboard('ranked');
}

// Petit avatar (image ou initiale colorée) en HTML
function lbAvatar(entry) { return otherAvatar(entry, 'avatar-sm'); }

// Avatar d'un AUTRE joueur en HTML, avec son cadre cosmétique (entry.frame) éventuel
function otherAvatar(entry, sizeClass = 'avatar-sm') {
  const fr = entry.frame;
  const cls = fr && fr.className ? ' ' + fr.className : '';
  const frameStyle = fr && fr.css ? fr.css + ';' : '';
  const bg = entry.avatarUrl ? `background-image:url('${entry.avatarUrl}');` : '';
  const inner = entry.avatarUrl ? '' : escapeHtml((entry.displayName || '?').charAt(0).toUpperCase());
  return `<span class="avatar ${sizeClass}${cls}" style="${bg}${frameStyle}">${inner}</span>`;
}

async function loadLeaderboard(type) {
  const list = document.getElementById('lb-list');
  const meBox = document.getElementById('lb-me');
  list.innerHTML = '<li class="muted">Chargement…</li>';
  meBox.innerHTML = '';
  const unit = LB_UNITS[type] || ((v) => v);
  try {
    const { top, me } = await api(`/api/leaderboard?type=${type}`);
    if (me) {
      meBox.innerHTML = `<span class="lb-rank">#${me.rank}</span>
        <span class="lb-me-label">Ton rang</span>
        <span class="lb-value">${unit(me.value)}</span>`;
    } else {
      meBox.innerHTML = '<span class="muted">Pas encore classé sur ce tableau.</span>';
    }
    if (!top.length) {
      list.innerHTML = '<li class="muted">Personne n\'est encore classé.</li>';
      return;
    }
    const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
    list.innerHTML = top
      .map(
        (e) => `<li class="lb-row${e.isMe ? ' me' : ''}" data-userid="${e.userId}">
          <span class="lb-rank">${medal(e.rank)}</span>
          ${lbAvatar(e)}
          <span class="lb-name">${escapeHtml(e.displayName)}${e.tier ? ` <span class="lb-tier">${e.tier.icon} ${escapeHtml(e.tier.name)}</span>` : ''}</span>
          <span class="lb-value">${unit(e.value)}</span>
        </li>`
      )
      .join('');
  } catch (e) {
    list.innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
  }
}

// ── ANNUAIRE DES JOUEURS (vue Communauté) ──
let playersPage = 1, playersSearch = '', playersPages = 1;

function openPlayers() {
  showView('players');
  document.getElementById('players-search').value = '';
  playersSearch = '';
  loadPlayers(1);
}

async function loadPlayers(page) {
  if (page < 1) return;
  const list = document.getElementById('players-list');
  list.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const r = await api(`/api/profile/players/list?page=${page}&search=${encodeURIComponent(playersSearch)}`);
    playersPage = r.page; playersPages = r.pages || 1;
    document.getElementById('players-total').textContent = `${r.total} joueur(s)`;
    if (!r.players.length) {
      list.innerHTML = '<p class="muted">Aucun joueur trouvé.</p>';
    } else {
      list.innerHTML = r.players.map((p) => {
        const tier = p.tier ? `<span class="lb-tier">${p.tier.icon} ${escapeHtml(p.tier.name)}</span>` : '';
        const floor = p.towerBestFloor ? `<span class="pl-floor"><i class="fas fa-chess-rook"></i> ${p.towerBestFloor}</span>` : '';
        return `<div class="pl-row${p.isMe ? ' me' : ''}" data-userid="${p.userId}">
          ${otherAvatar(p, 'avatar-sm')}
          <span class="pl-name">${escapeHtml(p.displayName)}${p.isMe ? ' <span class="hint">(toi)</span>' : ''}</span>
          ${tier}${floor}
          <i class="fas fa-chevron-right pl-go"></i>
        </div>`;
      }).join('');
    }
    document.getElementById('players-pageinfo').textContent = `Page ${playersPage} / ${playersPages}`;
    document.getElementById('players-prev').disabled = playersPage <= 1;
    document.getElementById('players-next').disabled = playersPage >= playersPages;
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── ÉCHANGE : builder ──
let tradeTarget = null; // { id, name }
const tradeGiveSel = new Set(); // instance ids que je donne
const tradeWantSel = new Set(); // instance ids que je veux

async function openTradeBuilder(userId, displayName) {
  tradeTarget = { id: userId, name: displayName };
  tradeGiveSel.clear(); tradeWantSel.clear();
  showView('trade');
  document.getElementById('trade-with').textContent = displayName;
  document.getElementById('trade-msg').textContent = '';
  ['trade-give-tokens', 'trade-give-dust', 'trade-want-tokens', 'trade-want-dust'].forEach((id) => { document.getElementById(id).value = 0; });
  document.getElementById('trade-give').innerHTML = '<p class="muted">Chargement…</p>';
  document.getElementById('trade-want').innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const [mine, theirs] = await Promise.all([
      api(`/api/trade/instances/${currentUser.id}`),
      api(`/api/trade/instances/${userId}`),
    ]);
    renderTradePool('trade-give', mine.characters, tradeGiveSel);
    renderTradePool('trade-want', theirs.characters, tradeWantSel);
  } catch (e) {
    document.getElementById('trade-msg').textContent = e.message;
  }
}

function renderTradePool(containerId, characters, selSet) {
  const el = document.getElementById(containerId);
  if (!characters.length) { el.innerHTML = '<p class="muted">Aucune carte.</p>'; return; }
  el.innerHTML = characters.map((c) => `
    <div class="trade-char">
      <span class="rb-pill r-${c.rarity}">${escapeHtml(c.name)}</span>
      <div class="trade-serials">
        ${c.serials.map((s) => `<button class="serial-chip${selSet.has(s.id) ? ' on' : ''}" data-iid="${s.id}">#${s.serial}</button>`).join('')}
      </div>
    </div>`).join('');
}

function toggleTradeChip(containerId, selSet, btn) {
  const iid = parseInt(btn.dataset.iid);
  if (selSet.has(iid)) { selSet.delete(iid); btn.classList.remove('on'); }
  else { selSet.add(iid); btn.classList.add('on'); }
}

async function sendTrade() {
  if (!tradeTarget) return;
  const body = {
    toUserId: tradeTarget.id,
    offeredIds: [...tradeGiveSel],
    requestedIds: [...tradeWantSel],
    offeredTokens: +document.getElementById('trade-give-tokens').value || 0,
    requestedTokens: +document.getElementById('trade-want-tokens').value || 0,
    offeredDust: +document.getElementById('trade-give-dust').value || 0,
    requestedDust: +document.getElementById('trade-want-dust').value || 0,
  };
  const msg = document.getElementById('trade-msg');
  const btn = document.getElementById('trade-send');
  btn.disabled = true;
  try {
    await api('/api/trade', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✅ Proposition envoyée !';
    sfx.correct && sfx.correct();
    setTimeout(() => openTrades(), 700);
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── ÉCHANGE : offres reçues / envoyées ──
function tradeItemsHTML(items, tokens, dust) {
  const chips = items.map((i) => `<span class="trade-mini r-${i.rarity}">${escapeHtml(i.name)} <b>#${i.serial}</b></span>`);
  if (tokens) chips.push(`<span class="trade-mini cur">${tokens} 🪙</span>`);
  if (dust) chips.push(`<span class="trade-mini cur">${dust} 🌟</span>`);
  return chips.length ? chips.join('') : '<span class="muted">rien</span>';
}

async function openTrades() {
  showView('trades');
  const list = document.getElementById('trades-list');
  list.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { trades } = await api('/api/trade/list');
    updateTradesBadge(trades.filter((t) => t.direction === 'incoming').length);
    if (!trades.length) { list.innerHTML = '<p class="muted">Aucun échange en attente.</p>'; return; }
    list.innerHTML = trades.map((t) => {
      const other = t.direction === 'incoming' ? t.from : t.to;
      const head = t.direction === 'incoming'
        ? `<b>${escapeHtml(other.displayName)}</b> te propose`
        : `Proposition à <b>${escapeHtml(other.displayName)}</b>`;
      const actions = t.direction === 'incoming'
        ? `<button class="btn-primary trade-act" data-act="accept" data-id="${t.id}">Accepter</button>
           <button class="btn-secondary trade-act" data-act="decline" data-id="${t.id}">Refuser</button>`
        : `<button class="btn-secondary trade-act" data-act="decline" data-id="${t.id}">Annuler</button>`;
      return `<div class="trade-offer">
        <div class="trade-offer-head">${head}</div>
        <div class="trade-offer-body">
          <div class="trade-side"><label>${t.direction === 'incoming' ? 'Tu reçois' : 'Tu donnes'}</label>${tradeItemsHTML(t.offered, t.offeredTokens, t.offeredDust)}</div>
          <i class="fas fa-right-left trade-arrow"></i>
          <div class="trade-side"><label>${t.direction === 'incoming' ? 'Tu donnes' : 'Tu reçois'}</label>${tradeItemsHTML(t.requested, t.requestedTokens, t.requestedDust)}</div>
        </div>
        <div class="trade-offer-actions">${actions}</div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
  loadTradeHistory();
}

async function loadTradeHistory() {
  const box = document.getElementById('trades-history');
  if (!box) return;
  try {
    const { trades } = await api('/api/trade/history');
    if (!trades.length) { box.innerHTML = '<p class="muted">Aucun échange passé.</p>'; return; }
    const STATUS = { accepted: '✅ Accepté', declined: '✖️ Refusé', cancelled: '↩️ Annulé' };
    box.innerHTML = trades.map((t) => {
      const give = `${t.offeredCount} carte(s)${t.offeredTokens ? ` +${t.offeredTokens}🪙` : ''}${t.offeredDust ? ` +${t.offeredDust}🌟` : ''}`;
      const want = `${t.requestedCount} carte(s)${t.requestedTokens ? ` +${t.requestedTokens}🪙` : ''}${t.requestedDust ? ` +${t.requestedDust}🌟` : ''}`;
      const date = t.resolvedAt ? new Date(t.resolvedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
      return `<div class="trade-hist-row">
        <span class="th-status">${STATUS[t.status] || t.status}</span>
        <span class="th-other">${t.direction === 'incoming' ? 'de' : 'à'} <b>${escapeHtml(t.other)}</b></span>
        <span class="th-detail hint">${give} ⇄ ${want}</span>
        <span class="th-date hint">${date}</span>
      </div>`;
    }).join('');
  } catch { box.innerHTML = ''; }
}

async function resolveTrade(id, act) {
  try {
    if (act === 'accept') {
      await api(`/api/trade/${id}/accept`, { method: 'POST' });
      // solde tokens/poussière peut avoir changé → recharge le profil minimal
      try { const me = await api('/api/auth/me'); if (me && me.user) { currentUser = me.user; renderHeaderUser(); } } catch {}
      sfx.win && sfx.win();
    } else {
      await api(`/api/trade/${id}/decline`, { method: 'POST' });
    }
    openTrades();
    loadTradesBadge();
  } catch (e) {
    alert(e.message);
  }
}

// Badge « échanges reçus » (navbar + hub)
function updateTradesBadge(n) {
  ['trades-nav-badge', 'trades-hub-badge'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = n || '';
    el.classList.toggle('hidden', !n);
  });
}
async function loadTradesBadge() {
  try { const { incoming } = await api('/api/trade/list'); updateTradesBadge(incoming); } catch {}
}

// ── PROFIL JOUEUR (public, depuis le classement) ──
async function openPlayer(userId) {
  const modal = document.getElementById('player-modal');
  const body = document.getElementById('player-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  try {
    const d = await api(`/api/profile/${userId}`);
    const u = d.user;
    const af = d.cosmetics && d.cosmetics.avatarFrame;
    const frameCls = af && af.className ? ' ' + af.className : '';
    const frameStyle = af && af.css ? af.css : '';
    const avatar = u.avatarUrl
      ? `<span class="avatar avatar-lg${frameCls}" style="background-image:url('${u.avatarUrl}');${frameStyle}"></span>`
      : `<span class="avatar avatar-lg${frameCls}" style="${frameStyle}">${escapeHtml((u.displayName || '?').charAt(0).toUpperCase())}</span>`;
    const since = u.createdAt
      ? new Date(u.createdAt).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
      : '—';
    const best = d.bestCard
      ? `<div class="player-best">${cardHTML({ ...d.bestCard, copies: 1 }, { noBorder: true })}<p class="hint">Meilleure carte</p></div>`
      : '';
    const lv = d.level || { level: 1 };
    const series = (d.topSeries || []).slice(0, 4);
    const seriesHtml = series.length
      ? `<div class="player-series"><p class="hint">Séries les plus jouées</p>${series
          .map((s) => `<span class="rb-pill">${escapeHtml(s.title)} <b>${s.plays}</b></span>`)
          .join('')}</div>`
      : '';
    body.innerHTML = `
      <div class="player-head">${avatar}<h2>${escapeHtml(u.displayName)}</h2>
        <span class="level-badge">Niv. ${lv.level}</span></div>
      ${u.bio ? `<p class="player-bio">${escapeHtml(u.bio)}</p>` : ''}
      <div class="char-stats">
        <div class="cstat"><span>${d.stats.played}</span><label>Jouées</label></div>
        <div class="cstat"><span>${d.stats.rate}%</span><label>Réussite</label></div>
        <div class="cstat"><span>${u.towerBestFloor || 0}</span><label>Étage max</label></div>
        <div class="cstat"><span>${d.cardsCount}</span><label>Cartes</label></div>
      </div>
      ${best}
      ${seriesHtml}
      <p class="hint">Membre depuis ${since}</p>
      ${userId !== currentUser.id ? `<button class="btn-primary" id="player-trade-btn"><i class="fas fa-right-left"></i> Proposer un échange</button>` : ''}`;
    const tradeBtn = document.getElementById('player-trade-btn');
    if (tradeBtn) tradeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      openTradeBuilder(userId, u.displayName);
    });
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── POKÉDEX PERSONNAGES (côté joueur) ──
let charsPage = 1, charsSearch = '', charsRarity = 'all', charsPages = 1;

function openCharacters() {
  showView('characters');
  document.getElementById('chars-search').value = '';
  charsSearch = ''; charsRarity = 'all';
  loadCharacters(1, '');
}

function rarityFilterChips(byRarity, current) {
  const total = Object.values(byRarity).reduce((s, n) => s + n, 0);
  const chips = [`<button class="coll-chip${current === 'all' ? ' active' : ''}" data-filter="all">Tous (${total})</button>`];
  RARITY_ORDER.forEach((r) => {
    if (!byRarity[r]) return;
    chips.push(`<button class="coll-chip r-${r}${current === r ? ' active' : ''}" data-filter="${r}">${RARITY_LABELS[r]} (${byRarity[r]})</button>`);
  });
  return chips.join('');
}

async function loadCharacters(page, search) {
  if (page < 1) return;
  charsSearch = search;
  const grid = document.getElementById('chars-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = charsRarity !== 'all' ? `&rarity=${charsRarity}` : '';
    const r = await api(`/api/gacha/characters?page=${page}&search=${encodeURIComponent(search)}${rq}`);
    charsPage = r.page; charsPages = r.pages || 1;
    document.getElementById('chars-total').textContent = `${r.total} personnages`;
    document.getElementById('chars-filters').innerHTML = rarityFilterChips(r.byRarity, charsRarity);
    if (!r.characters.length) {
      grid.innerHTML = '<p class="muted">Aucun personnage.</p>';
    } else {
      grid.innerHTML = r.characters
        .map((c) => {
          const owned = c.owned > 0;
          const sub = c.series && c.series !== '—' ? `<div class="gcard-series">${escapeHtml(c.series)}</div>` : '';
          return `<div class="gcard r-${c.rarity}${owned ? '' : ' locked'}" data-cid="${c.id}">
            <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
            <div class="gcard-info">
              <div class="gcard-name">${escapeHtml(c.name)}</div>
              <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
              ${sub}
            </div>
            ${owned ? `<span class="badge copies">×${c.owned}</span>` : '<span class="badge locked-badge"><i class="fas fa-lock"></i></span>'}
          </div>`;
        })
        .join('');
    }
    document.getElementById('chars-pageinfo').textContent = `Page ${charsPage} / ${charsPages}`;
    document.getElementById('chars-prev').disabled = charsPage <= 1;
    document.getElementById('chars-next').disabled = charsPage >= charsPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── ATELIER (craft) ──
let craftPage = 1, craftSearch = '', craftRarity = 'all', craftPages = 1, craftMissing = false;

function openCraft() {
  showView('craft');
  document.getElementById('craft-search').value = '';
  document.getElementById('craft-missing').checked = false;
  craftSearch = ''; craftRarity = 'all'; craftMissing = false;
  document.getElementById('craft-msg').textContent = '';
  loadCraft(1);
}

async function loadCraft(page) {
  if (page < 1) return;
  const grid = document.getElementById('craft-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = craftRarity !== 'all' ? `&rarity=${craftRarity}` : '';
    const ownedQ = craftMissing ? '&owned=0' : '';
    const r = await api(`/api/gacha/characters?page=${page}&search=${encodeURIComponent(craftSearch)}${rq}${ownedQ}`);
    craftPage = r.page; craftPages = r.pages || 1;
    if (typeof r.dust === 'number') { currentUser.dust = r.dust; renderHeaderUser(); }
    document.getElementById('craft-dust').textContent = currentUser.dust || 0;
    document.getElementById('craft-filters').innerHTML = rarityFilterChips(r.byRarity, craftRarity);
    if (!r.characters.length) {
      grid.innerHTML = '<p class="muted">Aucun personnage.</p>';
    } else {
      grid.innerHTML = r.characters.map((c) => craftCardHTML(c)).join('');
    }
    document.getElementById('craft-pageinfo').textContent = `Page ${craftPage} / ${craftPages}`;
    document.getElementById('craft-prev').disabled = craftPage <= 1;
    document.getElementById('craft-next').disabled = craftPage >= craftPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function craftCardHTML(c) {
  const owned = c.owned > 0;
  const sub = c.series && c.series !== '—' ? `<div class="gcard-series">${escapeHtml(c.series)}</div>` : '';
  const canAfford = (currentUser.dust || 0) >= c.craftCost;
  const badge = c.soldOut ? '<span class="badge soldout">ÉPUISÉ</span>'
    : owned ? `<span class="badge copies">×${c.owned}</span>` : '<span class="badge locked-badge"><i class="fas fa-lock"></i></span>';
  const btn = c.soldOut
    ? `<button class="btn-secondary craft-btn" disabled><i class="fas fa-ban"></i> Épuisé</button>`
    : `<button class="btn-primary craft-btn" data-cid="${c.id}" data-cost="${c.craftCost}" data-name="${escapeHtml(c.name)}" ${canAfford ? '' : 'disabled'}>
      <i class="fas fa-hammer"></i> ${c.craftCost} 🌟
    </button>`;
  return `<div class="gcard r-${c.rarity}${owned ? '' : ' locked'}">
    <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
      ${sub}
    </div>
    ${badge}
    ${btn}
  </div>`;
}

async function craftFromAtelier(btn) {
  const id = btn.dataset.cid;
  const cost = btn.dataset.cost;
  const name = btn.dataset.name;
  if (!confirm(`Fabriquer ${name} pour ${cost} 🌟 ?`)) return;
  btn.disabled = true;
  const msg = document.getElementById('craft-msg');
  try {
    const r = await api('/api/gacha/craft', { method: 'POST', body: JSON.stringify({ characterId: parseInt(id) }) });
    currentUser.dust = r.dust;
    renderHeaderUser();
    sfx.reveal && sfx.reveal('epic');
    msg.textContent = `✅ ${name} ${r.isNew ? 'ajouté à ta collection' : 'fabriqué (doublon)'} ! Reste ${r.dust} 🌟`;
    loadCraft(craftPage); // rafraîchit la possession + coûts abordables
  } catch (e) {
    msg.textContent = e.message;
    btn.disabled = false;
  }
}

// ── ADMIN : gestion des raretés ──
let adminPage = 1, adminSearch = '', adminRarity = 'all', adminPages = 1;

function openAdmin() {
  showView('admin');
  document.getElementById('admin-search').value = '';
  adminSearch = ''; adminRarity = 'all';
  document.getElementById('admin-backfill-status').textContent = '';
  loadAdminStats();
  loadAdminChars(1, '');
}

async function loadAdminStats() {
  const box = document.getElementById('admin-stats');
  if (!box) return;
  try {
    const d = await api('/api/admin/stats');
    const stat = (label, val) => `<div class="astat"><span>${val}</span><label>${label}</label></div>`;
    const daily = d.visits.daily || [];
    const max = Math.max(1, ...daily.map((v) => v.count));
    const bars = daily.map((v) =>
      `<span class="avis-bar" style="height:${Math.max(6, Math.round((v.count / max) * 100))}%" title="${v.day} : ${v.count} visiteur(s)"></span>`
    ).join('');
    box.innerHTML = `
      <div class="astat-grid">
        ${stat('Visiteurs aujourd\'hui', d.visits.today)}
        ${stat('Comptes', d.users.total)}
        ${stat('Nouveaux (7j)', d.users.new7d)}
        ${stat('Parties multi', d.activity.mpGames)}
        ${stat('Parties Château', d.activity.towerRuns)}
        ${stat('Tirages gacha', d.activity.pulls)}
        ${stat('Échanges conclus', d.activity.tradesOk)}
        ${stat('Cartes en circulation', d.activity.cardsInCirculation)}
      </div>
      <div class="avis-chart-wrap">
        <label class="hint">Visiteurs uniques / jour (14 derniers jours)</label>
        <div class="avis-chart">${bars || '<span class="hint">Pas encore de données.</span>'}</div>
      </div>`;
  } catch { box.innerHTML = ''; }
}

async function loadAdminChars(page, search) {
  if (page < 1) return;
  adminSearch = search;
  const tbody = document.getElementById('admin-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Chargement…</td></tr>';
  try {
    const rq = adminRarity !== 'all' ? `&rarity=${adminRarity}` : '';
    const r = await api(`/api/admin/characters?page=${page}&search=${encodeURIComponent(search)}${rq}`);
    adminPage = r.page; adminPages = r.pages || 1;
    document.getElementById('admin-filters').innerHTML = (() => {
      const chips = [`<button class="coll-chip${adminRarity === 'all' ? ' active' : ''}" data-filter="all">Tous</button>`];
      RARITY_ORDER.forEach((rr) =>
        chips.push(`<button class="coll-chip r-${rr}${adminRarity === rr ? ' active' : ''}" data-filter="${rr}">${RARITY_LABELS[rr]}</button>`)
      );
      return chips.join('');
    })();
    if (r.missingSeries != null) {
      document.getElementById('admin-backfill-status').textContent =
        r.missingSeries ? `${r.missingSeries} séries manquantes` : 'Toutes les séries sont remplies ✅';
    }
    if (!r.characters.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">Aucun personnage.</td></tr>';
    } else {
      tbody.innerHTML = r.characters
        .map((c) => {
          const opts = RARITY_ORDER.map((rr) => `<option value="${rr}"${rr === c.rarity ? ' selected' : ''}>${RARITY_LABELS[rr]}</option>`).join('');
          const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
          return `<tr>
            <td><span class="admin-thumb" ${img}></span></td>
            <td>${escapeHtml(c.name)}</td>
            <td class="muted">${escapeHtml(c.series && c.series !== '—' ? c.series : '—')}</td>
            <td class="nowrap">${(c.favourites || 0).toLocaleString('fr-FR')}</td>
            <td><select class="admin-rarity r-${c.rarity}" data-cid="${c.id}">${opts}</select></td>
            <td><button class="admin-feat${c.featured ? ' on' : ''}" data-feat data-cid="${c.id}" title="Vedette">${c.featured ? '⭐' : '☆'}</button></td>
          </tr>`;
        })
        .join('');
    }
    document.getElementById('admin-pageinfo').textContent = `Page ${adminPage} / ${adminPages}`;
    document.getElementById('admin-prev').disabled = adminPage <= 1;
    document.getElementById('admin-next').disabled = adminPage >= adminPages;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(e.message)}</td></tr>`;
  }
}

async function toggleFeatured(btn) {
  const id = btn.dataset.cid;
  const on = !btn.classList.contains('on');
  btn.disabled = true;
  try {
    const r = await api(`/api/admin/characters/${id}/featured`, { method: 'PATCH', body: JSON.stringify({ featured: on }) });
    btn.classList.toggle('on', r.featured);
    btn.textContent = r.featured ? '⭐' : '☆';
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; }
}

async function runImportCharacters() {
  const btn = document.getElementById('admin-import-btn');
  const status = document.getElementById('admin-import-status');
  btn.disabled = true;
  status.textContent = 'Import depuis AniList…';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let totalAdded = 0, lastTotal = 0, fails = 0, nextPage = null;
  try {
    for (let i = 0; i < 16; i++) { // ~800 personnages parcourus par clic
      let r;
      try {
        const body = nextPage == null ? {} : { page: nextPage };
        r = await api('/api/admin/import-characters', { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        if (++fails > 4) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/4`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      totalAdded += r.added;
      lastTotal = r.total;
      nextPage = (r.page || 1) + 1; // on avance page par page, même si la page était déjà connue
      status.textContent = `+${totalAdded} ajoutés · ${r.total} au total (page ${r.page})…`;
      if (!r.hasMore) {
        status.textContent = r.capped
          ? `✅ Plafond AniList atteint (${r.total} personnages). Pense à « Recalculer les raretés ».`
          : `✅ Terminé : ${r.total} personnages. Pense à « Recalculer les raretés ».`;
        loadAdminChars(1, adminSearch);
        return;
      }
      await sleep(1100); // throttle AniList
    }
    status.textContent = `✅ +${totalAdded} personnages · ${lastTotal} au total. Reclique, puis « Recalculer les raretés ».`;
    loadAdminChars(1, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetMe() {
  if (!confirm('Réinitialiser TON compte ? (stats, SRS, cartes gacha, tokens, Château, classé seront effacés. Profil et « Ma liste » conservés.)')) return;
  const btn = document.getElementById('admin-reset-btn');
  const status = document.getElementById('admin-reset-status');
  btn.disabled = true;
  status.textContent = 'Réinitialisation…';
  try {
    await api('/api/admin/reset-me', { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = 0;
    currentUser.towerBestFloor = 0;
    renderHeaderUser();
    status.textContent = '✅ Compte réinitialisé. Recharge la page.';
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetAll() {
  const ans = prompt('⚠️ RESET GLOBAL de TOUS les comptes (stats, gacha, tokens, classé, Château). Profils et listes conservés.\n\nTape RESET pour confirmer :');
  if (ans !== 'RESET') return;
  const btn = document.getElementById('admin-reset-all-btn');
  const status = document.getElementById('admin-reset-all-status');
  btn.disabled = true;
  status.textContent = 'Réinitialisation globale…';
  try {
    const r = await api('/api/admin/reset-all', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
    status.textContent = `✅ ${r.users} comptes réinitialisés. Recharge la page.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runRecomputeRarities() {
  const btn = document.getElementById('admin-recompute-btn');
  const status = document.getElementById('admin-recompute-status');
  btn.disabled = true;
  status.textContent = 'Recalcul en cours…';
  try {
    const r = await api('/api/admin/recompute-rarities', { method: 'POST', body: JSON.stringify({}) });
    const order = ['mythic', 'legendary', 'epic', 'rare', 'common'];
    const summary = order.filter((k) => r.counts[k]).map((k) => `${RARITY_LABELS[k]} ${r.counts[k]}`).join(' · ');
    status.textContent = `✅ ${r.total} personnages rééquilibrés — ${summary}`;
    loadAdminChars(adminPage, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function setCharacterRarity(id, rarity, sel) {
  sel.disabled = true;
  try {
    await api(`/api/admin/characters/${id}`, { method: 'PATCH', body: JSON.stringify({ rarity }) });
    sel.className = `admin-rarity r-${rarity}`;
  } catch (e) {
    alert(e.message);
  } finally {
    sel.disabled = false;
  }
}

async function runImportEndings() {
  const btn = document.getElementById('admin-endings-btn');
  const status = document.getElementById('admin-endings-status');
  btn.disabled = true;
  let total = 0, added = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/import-endings', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (animethemes saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed; added += r.added;
      status.textContent = `${total} animes scannés · ${added} endings ajoutés · ${r.remaining} restants…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1200);
    }
    status.textContent = `Terminé ✅ (${added} endings ajoutés)`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runBackfillSeries() {
  const btn = document.getElementById('admin-backfill-btn');
  const status = document.getElementById('admin-backfill-status');
  btn.disabled = true;
  let total = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/backfill-series', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        // Rate-limit / erreur réseau ponctuelle : on patiente et on réessaie
        if (++fails > 5) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed;
      status.textContent = `${total} traités · ${r.remaining} restants…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1500); // throttle pour rester sous la limite AniList
    }
    status.textContent = `Terminé ✅ (${total} personnages mis à jour)`;
    loadAdminChars(adminPage, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── PLAYLIST ──
function openPlaylist() {
  showView('playlist');
  loadPlaylist();
}

let playlistSongs = [];
let playlistRecommendations = [];
let playlistTrackId = null;

async function loadPlaylist() {
  const tbody = document.getElementById('playlist-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Chargement…</td></tr>';
  stopPlaylistAudio();
  playlistSongs = [];
  playlistRecommendations = [];
  playlistTrackId = null;
  updatePlaylistPlayer();
  try {
    const [{ songs }, recommendationData] = await Promise.all([
      api('/api/quiz/playlist'),
      api('/api/quiz/playlist/recommendations').catch(() => ({ recommendations: [], personalized: false })),
    ]);
    playlistSongs = songs;
    playlistRecommendations = recommendationData.recommendations || [];
    document.getElementById('playlist-total').textContent = `${songs.length} musique${songs.length > 1 ? 's' : ''}`;
    renderPlaylistRecommendations(recommendationData.personalized);
    if (!songs.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">Ta playlist est vide. Like des sons pendant le quiz ❤</td></tr>';
      updatePlaylistPlayer();
      return;
    }
    renderPlaylistRows();
    updatePlaylistPlayer();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(e.message)}</td></tr>`;
    renderPlaylistRecommendations(false);
    updatePlaylistPlayer();
  }
}

function renderPlaylistRows() {
  document.getElementById('playlist-tbody').innerHTML = playlistSongs
    .map((s) => {
      const playBtn = s.videoUrl
        ? '<button class="btn-play-row" data-play title="Écouter"><i class="fas fa-play"></i></button>'
        : '';
      return `<tr data-sid="${s.id}" class="${s.id === playlistTrackId ? 'playing' : ''}">
        <td class="cat-play-cell">${playBtn}</td>
        <td>${escapeHtml(s.animeTitle)}</td>
        <td class="nowrap">${s.type}${s.number}</td>
        <td>${escapeHtml(s.title)}</td>
        <td>${escapeHtml(s.artist || '—')}</td>
        <td class="cat-play-cell"><button class="btn-play-row pl-remove" data-remove title="Retirer"><i class="fas fa-heart-crack"></i></button></td>
      </tr>`;
    })
    .join('');
}

function renderPlaylistRecommendations(personalized = true) {
  const section = document.getElementById('playlist-recs');
  const grid = document.getElementById('playlist-recs-grid');
  section.classList.toggle('hidden', !playlistRecommendations.length);
  document.getElementById('playlist-recs-caption').textContent = personalized
    ? 'Selon les morceaux de ta playlist'
    : 'Une sélection populaire pour démarrer';
  grid.innerHTML = playlistRecommendations
    .map((song) => `<article class="playlist-rec-card" data-rec-id="${song.id}">
      <div class="playlist-rec-top">
        <span>${song.type}${song.number}</span>
        <button type="button" data-rec-play data-sid="${song.id}" aria-label="Écouter ${escapeHtml(song.title)}" title="Écouter"><i class="fas fa-play"></i></button>
      </div>
      <h4>${escapeHtml(song.title)}</h4>
      <p>${escapeHtml(song.animeTitle)}${song.artist ? ` · ${escapeHtml(song.artist)}` : ''}</p>
      <small><i class="fas fa-wand-magic-sparkles"></i> ${escapeHtml(song.reason)}</small>
      <button type="button" class="playlist-rec-add" data-rec-add data-sid="${song.id}"><i class="fas fa-plus"></i> Ajouter</button>
    </article>`)
    .join('');
}

// Lecteur audio playlist

function playlistTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function playablePlaylistIndex(direction) {
  if (!playlistSongs.length) return -1;
  const current = playlistSongs.findIndex((s) => s.id === playlistTrackId);
  let index = current < 0 ? (direction > 0 ? -1 : playlistSongs.length) : current;
  do {
    index += direction;
  } while (index >= 0 && index < playlistSongs.length && !playlistSongs[index].videoUrl);
  return index >= 0 && index < playlistSongs.length ? index : -1;
}

function setPlaylistPlaying(playing) {
  const playerIcon = document.querySelector('[data-player-toggle] i');
  if (playerIcon) playerIcon.className = playing ? 'fas fa-pause' : 'fas fa-play';
  document.querySelectorAll('#playlist-tbody [data-play] i, #playlist-recs-grid [data-rec-play] i').forEach((icon) => {
    const sid = parseInt(icon.closest('[data-sid]')?.dataset.sid || icon.closest('[data-rec-id]')?.dataset.recId);
    icon.className = playing && sid === playlistTrackId ? 'fas fa-pause' : 'fas fa-play';
  });
}

function updatePlaylistPlayer() {
  const player = document.getElementById('playlist-player');
  if (!player) return;
  const allAvailable = [...playlistSongs, ...playlistRecommendations];
  player.classList.toggle('hidden', !allAvailable.length);
  const song = allAvailable.find((s) => s.id === playlistTrackId);
  document.getElementById('playlist-player-title').textContent = song?.title || 'Choisis une musique';
  document.getElementById('playlist-player-meta').textContent = song
    ? `${song.animeTitle} · ${song.type}${song.number}${song.artist ? ` · ${song.artist}` : ''}`
    : '—';
  document.querySelector('[data-player-toggle]').disabled = !allAvailable.some((s) => s.videoUrl);
  const trackIsInPlaylist = playlistSongs.some((item) => item.id === playlistTrackId);
  document.querySelector('[data-player-prev]').disabled = !trackIsInPlaylist || playablePlaylistIndex(-1) < 0;
  document.querySelector('[data-player-next]').disabled = !trackIsInPlaylist || playablePlaylistIndex(1) < 0;
  document.querySelectorAll('#playlist-tbody tr[data-sid]').forEach((tr) => {
    tr.classList.toggle('playing', parseInt(tr.dataset.sid) === playlistTrackId);
  });
}

function stopPlaylistAudio() {
  const audio = document.getElementById('playlist-audio');
  if (!audio) return;
  audio.pause();
  setPlaylistPlaying(false);
}

function playPlaylistSong(songId) {
  const audio = document.getElementById('playlist-audio');
  const song = [...playlistSongs, ...playlistRecommendations].find((s) => s.id === songId && s.videoUrl);
  if (!song) return;
  if (playlistTrackId === song.id && audio.src) {
    if (audio.paused) audio.play().catch(() => setPlaylistPlaying(false));
    else audio.pause();
    return;
  }
  playlistTrackId = song.id;
  audio.src = song.videoUrl;
  audio.volume = getVolume();
  document.getElementById('playlist-player-seek').value = 0;
  document.getElementById('playlist-player-seek').max = 0;
  document.getElementById('playlist-player-current').textContent = '0:00';
  document.getElementById('playlist-player-duration').textContent = '0:00';
  updatePlaylistPlayer();
  audio.play().catch(() => setPlaylistPlaying(false));
}

function togglePlaylistAudio(btn) {
  playPlaylistSong(parseInt(btn.closest('tr').dataset.sid));
}

function changePlaylistTrack(direction) {
  const audio = document.getElementById('playlist-audio');
  if (direction < 0 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const index = playablePlaylistIndex(direction);
  if (index >= 0) playPlaylistSong(playlistSongs[index].id);
  else if (direction < 0) audio.currentTime = 0;
}

async function addPlaylistRecommendation(songId, btn) {
  const song = playlistRecommendations.find((item) => item.id === songId);
  if (!song) return;
  btn.disabled = true;
  try {
    await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId, liked: true }) });
    if (currentSong && currentSong.id === songId) { currentLiked = true; setLikeButton(); }
    playlistSongs.unshift(song);
    playlistRecommendations = playlistRecommendations.filter((item) => item.id !== songId);
    document.getElementById('playlist-total').textContent = `${playlistSongs.length} musique${playlistSongs.length > 1 ? 's' : ''}`;
    renderPlaylistRows();
    renderPlaylistRecommendations(true);
    updatePlaylistPlayer();
    setPlaylistPlaying(!document.getElementById('playlist-audio').paused);
  } catch (e) {
    btn.disabled = false;
    alert(e.message);
  }
}

async function removeFromPlaylist(tr) {
  const sid = parseInt(tr.dataset.sid);
  try {
    await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId: sid, liked: false }) });
    if (currentSong && currentSong.id === sid) { currentLiked = false; setLikeButton(); }
    if (playlistTrackId === sid) {
      stopPlaylistAudio();
      document.getElementById('playlist-audio').removeAttribute('src');
      document.getElementById('playlist-audio').load();
      playlistTrackId = null;
    }
    playlistSongs = playlistSongs.filter((s) => s.id !== sid);
    const left = playlistSongs.length;
    document.getElementById('playlist-total').textContent = `${left} musique${left > 1 ? 's' : ''}`;
    if (left) renderPlaylistRows();
    else document.getElementById('playlist-tbody').innerHTML = '<tr><td colspan="6" class="muted">Ta playlist est vide. Like des sons pendant le quiz ❤</td></tr>';
    updatePlaylistPlayer();
  } catch (e) { alert(e.message); }
}

document.addEventListener('DOMContentLoaded', () => {
  const audio = document.getElementById('playlist-audio');
  const seek = document.getElementById('playlist-player-seek');
  document.getElementById('playlist-tbody').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) return removeFromPlaylist(rm.closest('tr'));
    const play = e.target.closest('[data-play]');
    if (play) togglePlaylistAudio(play);
  });
  document.getElementById('playlist-recs-grid').addEventListener('click', (e) => {
    const add = e.target.closest('[data-rec-add]');
    if (add) return addPlaylistRecommendation(parseInt(add.dataset.sid), add);
    const play = e.target.closest('[data-rec-play]');
    if (play) playPlaylistSong(parseInt(play.dataset.sid));
  });
  document.querySelector('[data-player-toggle]').addEventListener('click', () => {
    if (playlistTrackId != null) playPlaylistSong(playlistTrackId);
    else {
      const first = [...playlistSongs, ...playlistRecommendations].find((s) => s.videoUrl);
      if (first) playPlaylistSong(first.id);
    }
  });
  document.querySelector('[data-player-prev]').addEventListener('click', () => changePlaylistTrack(-1));
  document.querySelector('[data-player-next]').addEventListener('click', () => changePlaylistTrack(1));
  seek.addEventListener('input', () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = parseFloat(seek.value);
  });
  audio.addEventListener('loadedmetadata', () => {
    seek.max = Number.isFinite(audio.duration) ? audio.duration : 0;
    document.getElementById('playlist-player-duration').textContent = playlistTime(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    seek.value = audio.currentTime || 0;
    document.getElementById('playlist-player-current').textContent = playlistTime(audio.currentTime);
  });
  audio.addEventListener('play', () => { setPlaylistPlaying(true); updatePlaylistPlayer(); });
  audio.addEventListener('pause', () => setPlaylistPlaying(false));
  audio.addEventListener('ended', () => {
    if (!playlistSongs.some((song) => song.id === playlistTrackId)) {
      audio.currentTime = 0;
      setPlaylistPlaying(false);
      return;
    }
    const next = playablePlaylistIndex(1);
    if (next >= 0) playPlaylistSong(playlistSongs[next].id);
    else {
      audio.currentTime = 0;
      setPlaylistPlaying(false);
    }
  });
});

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

// AMQTrainer — frontend (Phase 1 : auth + quiz solo)
const API = ''; // même origine que le serveur Express

// ── état ──
let currentUser = null;
let currentSong = null;
let currentRoundToken = null; // jeton de manche émis par le serveur au tirage
let currentLiked = false; // la musique en cours est-elle dans la playlist
let isTraining = false; // session du centre d'entraînement
let trainingSource = null; // review | missed | liked | due | series | mine | global
let trainingSeries = null; // série choisie quand trainingSource === 'series'
let currentLevel = 'cash'; // cash | carre | duo (Duo/Carré/Cash)
let roundReward = null; // { max, timed, grace, floorAt, floor } pour la jauge « tokens en jeu »
let rewardCap = null; // { used, max, resetAt } plafond anti-farm (fenêtre 6h)
let roundStartAt = 0; // réception du tirage : référence du bonus de vitesse (≈ sat serveur)
let gaugeTimer = null; // rafraîchit la jauge de tokens en jeu
let trainPlayed = 0, trainCorrect = 0, trainStreak = 0; // suivi de session d'entraînement
let trainingChrono = false; // mode chrono (auto-révélation)
let chronoTimer = null;
let answered = false;
let mode = localStorage.getItem('amq_mode') || 'mine';
let importRowForced = false; // « Changer de liste » : force l'affichage de l'import même si une liste est liée
let gameMode = 'ranked'; // « Jouer » = mode classique (tokens). L'entraînement passe par isTraining.
let quizType = localStorage.getItem('amq_quiz_type') || 'all'; // 'all' | 'OP' | 'ED'
let clipTimer = null; // coupe l'extrait après la durée choisie
let clipEndsAt = 0; // horodatage de coupure de l'extrait (pour geler/reprendre en alt-tab)
let clipRemainingMs = 0; // temps d'extrait restant mémorisé pendant l'arrière-plan
let clipResumeOnShow = false; // l'extrait jouait quand on a quitté l'onglet → reprendre au retour
let roundClipStart = null; // réécouter rejoue exactement le même passage
let appReadyPromise = null;
let appUiReady = false;
let currentView = null;
let suppressHistory = false;
// Deux lecteurs partagent le même emplacement (cf. index.html) : `activeVideoId`
// dit lequel est actuellement affiché/joué. video() le renvoie toujours ; l'autre
// sert à précharger la manche suivante en arrière-plan (cf. prefetchNextRound).
let activeVideoId = 'quiz-video';
const video = () => document.getElementById(activeVideoId);
const preloadVideoEl = () => document.getElementById(activeVideoId === 'quiz-video' ? 'quiz-video-b' : 'quiz-video');
let prefetchedRound = null; // { qs, song, roundToken, liked, reward, rewardCap } ou null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.dataset.lazySrc = src;
    script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Impossible de charger ${src}`)), { once: true });
    document.body.appendChild(script);
  });
}

function ensureAppReady() {
  if (appReadyPromise) return appReadyPromise;
  appReadyPromise = (async () => {
    await Promise.all([
      'tower.js', 'admin.js', 'playlist.js', 'playlists.js', 'albums.js', 'daily.js', 'gacha.js',
      'catalog.js', 'community.js', 'profile.js', 'anime-autocomplete.js',
    ].map(loadScript));
    await loadScript('/socket.io/socket.io.js');
    await loadScript('mp-client.js');
    if (typeof initPlaylistUI === 'function') initPlaylistUI();
    if (typeof initPlaylistsUI === 'function') initPlaylistsUI();
    if (typeof initAlbumsUI === 'function') initAlbumsUI();
    if (typeof initDailyUI === 'function') initDailyUI();
    if (typeof initAnimeAutocompleteUI === 'function') initAnimeAutocompleteUI();
    if (typeof initMpUI === 'function') initMpUI();
    if (!appUiReady) {
      setupAppUI();
      appUiReady = true;
    }
  })();
  return appReadyPromise;
}

async function enterApp(user) {
  await ensureAppReady();
  showApp(user);
}

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
  ['header-volume', 'volume', 'tower-volume', 'mp-volume', 'playlist-volume'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && +el.value !== v) el.value = v;
  });
}
// Applique le volume sauvegardé à TOUT média dès qu'il démarre, quel que soit le
// mode (solo, château, multi, daily) ou le moment de création de l'élément.
// `loadstart`/`play` ne bouillonnent pas → écoute en phase de capture sur le document.
['loadstart', 'play', 'volumechange'].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    const el = e.target;
    if (!el || (el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO')) return;
    const v = getVolume();
    if (Math.abs((el.volume ?? 1) - v) > 0.001) el.volume = v;
  }, true);
});

// Réglages quiz (persistés)
const settings = {
  randomStart: localStorage.getItem('amq_randomStart') !== 'false',
  clipSeconds: parseInt(localStorage.getItem('amq_clip') ?? '20'),
  autoNext: localStorage.getItem('amq_autonext') === 'true',
  count: parseInt(localStorage.getItem('amq_count') ?? '0'), // 0 = illimité
  titleLang: localStorage.getItem('amq_titleLang') || 'en', // 'en' = anglais d'abord, 'jp' = japonais d'abord
};
let autoNextTimer = null; // enchaînement automatique vers la manche suivante
// Session finie (solo classique) : compteur de sons et bonnes réponses
let quizCount = 0, quizCorrect = 0, quizSessionEnded = false;

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
  setupGlobalAccessibility();
  pingVisit();
  window.addEventListener('focus', () => { if (currentUser) syncTokenBalance(); });

  // Retour d'OAuth AniList
  const params = new URLSearchParams(location.search);
  if (params.get('reset')) {
    showAuth();
    showAuthPanel('reset');
    document.body.classList.remove('session-pending');
    return;
  }
  const sessionPromise = api('/api/auth/me');
  if (params.get('auth')) {
    history.replaceState({}, '', location.pathname);
    if (params.get('auth') === 'error') showAuthError("La connexion AniList a échoué.");
  }

  // Boutons OAuth visibles seulement si configurés côté serveur
  (async () => { try {
    const [anilist, google] = await Promise.all([
      api('/api/auth/anilist/status').catch(() => ({ configured: false })),
      api('/api/auth/google/status').catch(() => ({ configured: false })),
    ]);
    document.getElementById('anilist-login-btn').classList.toggle('hidden', !anilist.configured);
    document.getElementById('google-login-btn').classList.toggle('hidden', !google.configured);
    const any = anilist.configured || google.configured;
    document.getElementById('oauth-sep').classList.toggle('hidden', !any);
    document.getElementById('oauth-disabled').classList.toggle('hidden', any);
  } catch {} })();

  // Déjà connecté ?
  try {
    const { user } = await sessionPromise;
    await enterApp(user);
    // Lien de profil partagé (?u=<id>) → ouvre la fiche du joueur
    const shared = !user.isGuest && params.get('u');
    if (shared) {
      history.replaceState({}, '', location.pathname);
      openPlayer(shared);
    }
    // Raccourci de navigation (?nav=daily) — utilisé par les notifications push
    const nav = params.get('nav');
    if (nav) {
      history.replaceState({}, '', location.pathname);
      navTo(nav);
    }
  } catch {
    showAuth();
    if (params.get('register')) showAuthPanel('register');
  } finally {
    document.body.classList.remove('session-pending');
  }
});

// ── AUTH UI ──
function setupAuthUI() {
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      showAuthPanel(tab.dataset.tab);
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthBusy(e.currentTarget, true);
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        }),
      });
      await enterApp(user);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(e.currentTarget, false);
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthBusy(e.currentTarget, true);
    try {
      const { user } = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          displayName: document.getElementById('register-name').value,
          email: document.getElementById('register-email').value,
          password: document.getElementById('register-password').value,
        }),
      });
      await enterApp(user);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(e.currentTarget, false);
    }
  });

  document.getElementById('forgot-password-btn').addEventListener('click', () => {
    document.getElementById('forgot-email').value = document.getElementById('login-email').value;
    showAuthPanel('forgot');
  });
  document.querySelectorAll('.auth-back-login').forEach((button) =>
    button.addEventListener('click', () => showAuthPanel('login'))
  );

  document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthBusy(e.currentTarget, true);
    try {
      const result = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: document.getElementById('forgot-email').value }),
      });
      showAuthError(result.message);
      if (result.devResetUrl) console.info('Lien de réinitialisation local :', result.devResetUrl);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(e.currentTarget, false);
    }
  });

  document.getElementById('reset-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthBusy(e.currentTarget, true);
    try {
      const token = new URLSearchParams(location.search).get('reset');
      const result = await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password: document.getElementById('reset-password').value }),
      });
      history.replaceState({}, '', location.pathname);
      showAuthPanel('login');
      showAuthError(result.message);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      setAuthBusy(e.currentTarget, false);
    }
  });

  const startGuestSession = async () => {
    const guestButtons = ['guest-login-btn', 'auth-quick-guest']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    guestButtons.forEach((control) => {
      control.disabled = true;
      control.setAttribute('aria-busy', 'true');
    });
    showAuthError('');
    try {
      const { user } = await api('/api/auth/guest', { method: 'POST' });
      await enterApp(user);
    } catch (err) {
      showAuthError(err.message);
    } finally {
      guestButtons.forEach((control) => {
        control.disabled = false;
        control.removeAttribute('aria-busy');
      });
    }
  };
  ['guest-login-btn', 'auth-quick-guest'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', startGuestSession);
  });

  document.getElementById('anilist-login-btn').addEventListener('click', () => {
    location.href = '/api/auth/anilist';
  });
  document.getElementById('google-login-btn').addEventListener('click', () => {
    location.href = '/api/auth/google';
  });
}

function showAuthPanel(panel) {
  const forms = {
    login: 'login-form',
    register: 'register-form',
    forgot: 'forgot-password-form',
    reset: 'reset-password-form',
  };
  Object.entries(forms).forEach(([name, id]) =>
    document.getElementById(id).classList.toggle('hidden', name !== panel)
  );
  const regular = panel === 'login' || panel === 'register';
  document.querySelector('.auth-tabs').classList.toggle('hidden', !regular);
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    const active = tab.dataset.tab === panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.getElementById('oauth-sep').classList.toggle('auth-context-hidden', !regular);
  document.getElementById('google-login-btn').classList.toggle('auth-context-hidden', !regular);
  document.getElementById('anilist-login-btn').classList.toggle('auth-context-hidden', !regular);
  document.getElementById('oauth-disabled').classList.toggle('auth-context-hidden', !regular);
  document.getElementById('guest-login-btn').classList.toggle('auth-context-hidden', !regular);
  document.querySelector('.auth-guest-note').classList.toggle('auth-context-hidden', !regular);
  showAuthError('');
  requestAnimationFrame(() => document.querySelector(`#${forms[panel]} input`)?.focus());
}

function setAuthBusy(form, busy) {
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll('button, input').forEach((control) => { control.disabled = busy; });
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  if (busy) {
    submit.dataset.label = submit.innerHTML;
    submit.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Patiente…';
  } else if (submit.dataset.label) {
    submit.innerHTML = submit.dataset.label;
    delete submit.dataset.label;
  }
}

function showAuthError(msg) { document.getElementById('auth-error').textContent = msg || ''; }
function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function setupGlobalAccessibility() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (image?.tagName !== 'IMG' || !image.dataset.fallbackSymbol) return;
    image.replaceWith(document.createTextNode(image.dataset.fallbackSymbol));
  }, true);

  const aboutModal = document.getElementById('about-modal');
  let aboutTrigger = null;
  const openAbout = (trigger) => {
    aboutTrigger = trigger || document.activeElement;
    aboutModal.classList.remove('hidden');
    document.getElementById('about-close').focus();
  };
  const closeAbout = () => {
    aboutModal.classList.add('hidden');
    aboutTrigger?.focus?.();
    aboutTrigger = null;
  };

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-about]')) {
      event.preventDefault();
      openAbout(event.target.closest('[data-about]'));
    }
  });
  document.getElementById('about-close').addEventListener('click', closeAbout);
  aboutModal.addEventListener('click', (event) => {
    if (event.target.id === 'about-modal') closeAbout();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || aboutModal.classList.contains('hidden')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAbout();
  });

  const iconLabels = {
    'players-prev': 'Page précédente', 'players-next': 'Page suivante',
    'cat-prev': 'Page précédente', 'cat-next': 'Page suivante',
    'chars-prev': 'Page précédente', 'chars-next': 'Page suivante',
    'craft-prev': 'Page précédente', 'craft-next': 'Page suivante',
    'admin-prev': 'Page précédente', 'admin-next': 'Page suivante',
    'play-btn': 'Lire ou mettre en pause', 'replay-btn': 'Réécouter',
    'tower-play': 'Lire ou mettre en pause', 'tower-replay': 'Réécouter',
    'daily-play': 'Lire ou mettre en pause', 'daily-replay': 'Réécouter',
    'mp-chat-send': 'Envoyer le message',
  };
  Object.entries(iconLabels).forEach(([id, label]) => {
    const element = document.getElementById(id);
    if (element && !element.getAttribute('aria-label')) element.setAttribute('aria-label', label);
  });

  document.querySelectorAll('.lb-tabs, .shop-tabs, .mode-switch, .type-filter').forEach((list) => {
    list.setAttribute('role', 'tablist');
    const syncTabs = () => list.querySelectorAll('button').forEach((tab) => {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
    });
    syncTabs();
    new MutationObserver(syncTabs).observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });

  const previousFocus = new WeakMap();
  const modals = [...document.querySelectorAll('.modal-overlay')];
  const onModalChange = (modal) => {
    const open = !modal.classList.contains('hidden');
    if (open) {
      previousFocus.set(modal, document.activeElement);
      requestAnimationFrame(() => {
        const target = modal.querySelector('.modal-close, button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        target?.focus();
      });
    } else {
      const target = previousFocus.get(modal);
      if (target && document.contains(target)) target.focus();
    }
  };
  modals.forEach((modal) => {
    new MutationObserver(() => onModalChange(modal)).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('keydown', (event) => {
    const modal = modals.find((candidate) => !candidate.classList.contains('hidden'));
    if (!modal) return;
    if (event.key === 'Escape') {
      const close = modal.querySelector('.modal-close');
      if (close) {
        event.preventDefault();
        close.click();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.closest('.hidden'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  // Jouable 100% au clavier : 1-9 choisit une réponse en QCM (Carré/Duo), Échap
  // passe la manche (solo + multi), Maj+Échap vote pour passer (multi). Un Échap
  // ferme d'abord les suggestions d'autocomplétion si elles sont ouvertes, comme
  // avant — ce n'est que sans suggestions ouvertes qu'il déclenche « Passer ».
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;

    if (event.key === 'Escape') {
      const suggList = document.getElementById(currentView === 'mp' ? 'mp-suggestions' : 'answer-suggestions');
      if (suggList && !suggList.classList.contains('hidden')) return;
      if (currentView === 'quiz') {
        const btn = document.getElementById('skip-btn');
        if (btn && !btn.classList.contains('hidden') && !btn.disabled) { event.preventDefault(); btn.click(); }
      } else if (currentView === 'mp') {
        const game = document.getElementById('mp-game');
        if (!game || game.classList.contains('hidden')) return;
        const btn = document.getElementById(event.shiftKey ? 'mp-voteskip' : 'mp-skip');
        if (btn && !btn.disabled) { event.preventDefault(); btn.click(); }
      }
      return;
    }

    if (currentView !== 'quiz' || !/^[1-9]$/.test(event.key)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    const box = document.getElementById('choice-buttons');
    if (!box || box.classList.contains('hidden')) return;
    const btn = box.querySelectorAll('.choice-opt')[+event.key - 1];
    if (btn && !btn.disabled) { event.preventDefault(); btn.click(); }
  });

  window.addEventListener('popstate', (event) => {
    if (!currentUser) return;
    const target = event.state?.view || location.hash.replace(/^#/, '') || 'play';
    suppressHistory = true;
    try { navTo(target); } finally { suppressHistory = false; }
  });
}

function showView(name, options = {}) {
  if (name !== 'catalog' && typeof stopCatalogAudio === 'function') stopCatalogAudio();
  if (name !== 'tower' && typeof stopTowerMedia === 'function') stopTowerMedia();
  if (name !== 'daily' && typeof stopDailyMedia === 'function') stopDailyMedia();
  if (name !== 'mp' && typeof mpHandleLeaveView === 'function') mpHandleLeaveView(); // quitter la vue = quitter la salle
  if (name !== 'mp' && typeof stopMpMedia === 'function') stopMpMedia();
  if (name !== 'playlist' && typeof stopPlaylistAudio === 'function') stopPlaylistAudio();
  if (name !== 'playlist-detail' && typeof stopPlaylistDetailAudio === 'function') stopPlaylistDetailAudio();
  if (name !== 'quiz') {
    const qv = video();
    if (qv && !qv.paused) qv.pause();
    clearTimeout(clipTimer); clearTimeout(chronoTimer); clearTimeout(autoNextTimer);
    if (typeof stopRewardGauge === 'function') stopRewardGauge();
  }
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
  document.getElementById('view-economy').classList.toggle('hidden', name !== 'economy');
  document.getElementById('view-catalog').classList.toggle('hidden', name !== 'catalog');
  document.getElementById('view-tower').classList.toggle('hidden', name !== 'tower');
  document.getElementById('view-daily').classList.toggle('hidden', name !== 'daily');
  document.getElementById('view-leaderboard').classList.toggle('hidden', name !== 'leaderboard');
  document.getElementById('view-characters').classList.toggle('hidden', name !== 'characters');
  document.getElementById('view-craft').classList.toggle('hidden', name !== 'craft');
  document.getElementById('view-admin').classList.toggle('hidden', name !== 'admin');
  document.getElementById('view-profile').classList.toggle('hidden', name !== 'profile');
  document.getElementById('view-mp').classList.toggle('hidden', name !== 'mp');
  document.getElementById('view-playlist').classList.toggle('hidden', name !== 'playlist');
  document.getElementById('view-playlist-detail').classList.toggle('hidden', name !== 'playlist-detail');
  document.getElementById('view-album-detail').classList.toggle('hidden', name !== 'album-detail');
  document.getElementById('view-training').classList.toggle('hidden', name !== 'training');
  document.getElementById('view-friends').classList.toggle('hidden', name !== 'friends');
  // Les sous-vues gardent leur hub parent en surbrillance dans la navbar (les 4
  // onglets racine ont data-nav = nom de hub). Les raccourcis épinglés, eux, ont
  // data-nav = la vue précise (ex. "gacha") : on les compare aussi à `name` brut,
  // sinon ils ne s'allument jamais (leur data-nav ne matche que le hub parent).
  const navActive = NAV_GROUP[name] || name;
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.nav === navActive || b.dataset.nav === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  currentView = name;
  if (!suppressHistory) {
    const url = new URL(location.href);
    url.searchParams.delete('nav');
    url.searchParams.delete('auth');
    url.searchParams.delete('reset');
    url.searchParams.delete('register');
    url.hash = name;
    const method = options.replace ? 'replaceState' : 'pushState';
    history[method]({ view: name }, '', url);
  }
  if (name === 'home' && typeof loadQuests === 'function') loadQuests();
  if (name === 'home' && typeof loadRecentPulls === 'function') loadRecentPulls();
  if (name === 'home' && typeof loadChangelog === 'function') loadChangelog();
  if (name === 'home' && typeof loadHighlights === 'function') loadHighlights();
  if (name === 'home' && typeof loadPersonalStats === 'function') loadPersonalStats();
}

// Rattache chaque vue de mode à son onglet hub (pour la surbrillance navbar)
const NAV_GROUP = {
  quiz: 'play', training: 'play', tower: 'play', mp: 'play', daily: 'play',
  gacha: 'collection', shop: 'collection', catalog: 'collection', playlist: 'collection', characters: 'collection', craft: 'collection',
  'playlist-detail': 'collection', 'album-detail': 'collection',
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
  if (name === 'economy') return openEconomy();
  if (name === 'catalog') return openCatalog();
  if (name === 'tower') return openTower();
  if (name === 'daily') return openDaily();
  if (name === 'leaderboard') return openLeaderboard();
  if (name === 'admin') return openAdmin();
  if (name === 'profile') return openProfile();
  if (name === 'mp') return openMultiplayer();
  if (name === 'coop') return startCoop();
  if (name === 'playlist') return openPlaylist();
  if (name === 'quiz') return openQuiz();
  if (name === 'training') return openTraining();
  if (name === 'friends') return openFriends();
  showView(name); // home, quiz
}

function showApp(user) {
  currentUser = user;
  const guest = !!user.isGuest;
  const requestedHash = location.hash.replace(/^#/, '');
  const requested = requestedHash;
  const defaultView = guest ? 'quiz' : 'home'; // l'essai démarre directement sur le quiz
  document.body.classList.toggle('guest-mode', guest);
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('home-name').textContent = user.displayName;
  if (guest) {
    mode = 'global';
    gameMode = 'casual';
    document.querySelector('#logout-btn span').textContent = 'Quitter l’essai';
    document.querySelector('#view-play [data-nav="quiz"] p').textContent = 'Teste le catalogue global sans créer de compte';
  }
  if (guest) openQuiz();
  else showView(defaultView, { replace: true });
  applyGameModeUI();
  renderHeaderUser();
  if (typeof renderPinnedNav === 'function') renderPinnedNav();
  if (typeof refreshPinIcons === 'function') refreshPinIcons();
  const linked = user.anilistListName || user.anilistName;
  if (linked) document.getElementById('anilist-username').value = linked;
  (guest ? Promise.resolve() : chooseInitialMode()).then(() => {
    applyModeUI();
    refreshCatalogInfo();
  });
  if (!guest) {
    refreshStats();
    if (typeof connectMp === 'function') connectMp();
    if (typeof loadTradesBadge === 'function') loadTradesBadge();
    if (typeof loadFriendsOnlineCount === 'function') loadFriendsOnlineCount();
    loadQuestsBadge();
    if (typeof loadChangelogBadge === 'function') loadChangelogBadge();
    maybeOnboard();
  }
  if (requested && requested !== defaultView && (!guest || requested === 'quiz')) {
    suppressHistory = true;
    try { navTo(requested); } finally { suppressHistory = false; }
    const restoredUrl = new URL(location.href);
    restoredUrl.hash = requested;
    history.replaceState({ view: requested }, '', restoredUrl);
  }
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

// Système de grades (blasons SVG) — d'après le handoff design « Système de rang »
// (Direction 01 PRISME : gemme facettée néon). Palette par grade.
function tierSlug(name) {
  return { 'Bronze': 'bronze', 'Argent': 'silver', 'Or': 'gold', 'Platine': 'platine', 'Diamant': 'diamant', 'Maître': 'maitre' }[name] || 'bronze';
}
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
const TIER_PALETTE = {
  'Bronze': { color: '#C77B43', light: '#E6A572', dark: '#8A4F26', glow: '#E08A4A' },
  'Argent': { color: '#AEB9C6', light: '#DCE4EE', dark: '#7C8896', glow: '#C6D2E0' },
  'Or': { color: '#F2C14E', light: '#FFE08C', dark: '#C2901F', glow: '#FFD45C' },
  'Platine': { color: '#4FE0CB', light: '#A6F7EC', dark: '#1FA593', glow: '#4FE0CB' },
  'Diamant': { color: '#5CC8FF', light: '#A8E2FF', dark: '#2B8FD6', glow: '#5CC8FF' },
  'Maître': { color: '#B36BFF', light: '#DCB8FF', dark: '#7E36C8', glow: '#B36BFF' },
};
let _emblemSeq = 0;
// Blason PRISME (gemme facettée) coloré selon le grade. `size` = largeur px.
function tierEmblem(name, size = 24) {
  const p = TIER_PALETTE[name] || TIER_PALETTE.Bronze;
  const id = 'emb' + (++_emblemSeq);
  const SIL = 'M50 6 L90 22 L90 60 Q90 96 50 116 Q10 96 10 60 L10 22 Z';
  const facets = [
    ['50,6 90,22 50,56', p.light], ['90,22 90,60 50,56', p.color], ['90,60 50,116 50,56', p.dark],
    ['50,116 10,60 50,56', p.color], ['10,60 10,22 50,56', p.light], ['10,22 50,6 50,56', p.dark],
  ].map(([pts, c]) => `<polygon points="${pts}" fill="${c}"/>`).join('');
  return `<svg class="tier-emblem" viewBox="0 0 100 122" width="${size}" height="${Math.round(size * 1.22)}" style="filter:drop-shadow(0 0 5px ${p.glow});overflow:visible" aria-hidden="true">`
    + `<defs><clipPath id="${id}"><path d="${SIL}"/></clipPath></defs>`
    + `<g clip-path="url(#${id})">${facets}</g>`
    + `<path d="${SIL}" fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round"/>`
    + `<polygon points="50,45 58,56 50,67 42,56" fill="${p.light}"/></svg>`;
}
function tierBadge(tier, extra) {
  if (!tier || !tier.name) return '';
  const div = tier.division ? `<span class="tier-div">${ROMAN[tier.division] || tier.division}</span>` : '';
  const big = extra && extra.indexOf('big') >= 0;
  return `<span class="tier-badge t-${tierSlug(tier.name)}${extra ? ' ' + extra : ''}">`
    + `${tierEmblem(tier.name, big ? 40 : 22)}<span class="tier-name">${escapeHtml(tier.name)}</span>${div}</span>`;
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
  if (rk) {
    if (currentUser.rankTier) { rk.innerHTML = tierBadge(currentUser.rankTier); rk.classList.remove('hidden'); }
    else rk.classList.add('hidden');
  }
  document.getElementById('daily-btn').classList.toggle('hidden', !currentUser.dailyAvailable);
}

let tokenBalanceSync = null;
function syncTokenBalance() {
  if (!currentUser || currentUser.isGuest) return Promise.resolve(null);
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
// Ligne de jauge d'un plafond anti-farm (barre + reset) — partagée entre le
// popover d'en-tête et la page Économie.
function rewardCapRow(label, cap) {
  const pct = cap.max ? Math.min(100, Math.round((cap.used / cap.max) * 100)) : 0;
  const msLeft = Math.max(0, cap.resetAt - Date.now());
  const h = Math.floor(msLeft / 3600000);
  const m = Math.floor((msLeft % 3600000) / 60000);
  const resetTxt = h > 0 ? `reset dans ${h} h ${String(m).padStart(2, '0')}` : `reset dans ${m} min`;
  return `<div class="reward-cap-row">
      <div class="reward-cap-label"><span>${label}</span><span>${cap.used}/${cap.max} 🪙</span></div>
      <div class="reward-cap-bar"><div class="reward-cap-fill${pct >= 100 ? ' full' : ''}" style="width:${pct}%"></div></div>
      <div class="reward-cap-reset">${resetTxt}</div>
    </div>`;
}

// ── Page Économie : vue d'ensemble des gains/plafonds, en un coup d'œil ──
const ECONOMY_EARN_SOURCES = [
  { icon: '🎯', title: 'Quiz classique (solo)', desc: "10 🪙 à la 1ʳᵉ bonne réponse (+5/+2 si l'anime est peu connu), 2 🪙 en rejouant une musique déjà trouvée. Multiplié par le niveau d'aide (Cash ×1 · Carré ×0,5 · Duo ×0,3)." },
  { icon: '🎓', title: 'Entraînement', desc: 'Aucun token — sert à réviser sans enjeu (séries, répétition espacée).' },
  { icon: '🏰', title: 'Château de l\'Infini', desc: 'Entrée 40 🪙 (1 gratuite/jour). Gain de fin = étages × 5, +25 🪙 tous les 10 étages — rentable dès ~8 étages.' },
  { icon: '🎮', title: 'Multijoueur (classique / équipes / élim.)', desc: '+2 🪙 par bonne réponse + bonus de classement (+20/+10/+5 pour le podium), max 40 🪙/partie.' },
  { icon: '🤝', title: 'Tour en équipe (coop)', desc: '+1 🪙 par étage franchi, max 30 🪙/partie. Partage le même plafond que le multijoueur.' },
  { icon: '📅', title: 'Défi du jour', desc: '20 à 100 🪙 selon ta série de jours consécutifs — une tentative par jour.' },
  { icon: '🎁', title: 'Bonus quotidien, quêtes & niveaux', desc: '50 🪙 de connexion par jour, + récompenses de quêtes et de paliers d\'XP à réclamer.' },
  { icon: '♻️', title: 'Doublons gacha', desc: 'Chaque doublon obtenu au tirage rembourse des tokens selon la rareté de la carte.' },
];
const ECONOMY_SPEND_SOURCES = [
  { icon: '🎴', title: 'Tirages gacha', desc: 'Dépense tes tokens pour tirer des cartes de personnages (5 raretés, stock limité).' },
  { icon: '🔨', title: 'Atelier (craft)', desc: 'Fabrique une carte précise avec de la poussière 🌟 (doublons recyclés).' },
  { icon: '🛍️', title: 'Boutique', desc: 'Cosmétiques : dos de cartes, bordures, bannières, cadres d\'avatar.' },
];

async function openEconomy() {
  showView('economy');
  const box = document.getElementById('economy-body');
  box.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const caps = await api('/api/economy/reward-caps');
    const sourceCard = (s) => `<div class="economy-source"><div class="eco-src-icon">${s.icon}</div><div><div class="eco-src-title">${escapeHtml(s.title)}</div><div class="eco-src-desc">${escapeHtml(s.desc)}</div></div></div>`;
    box.innerHTML = `
      <div class="economy-balance">
        <div class="eco-balance-item"><span class="eco-balance-val">${currentUser.tokens}</span><span class="eco-balance-label">🪙 tokens</span></div>
        <div class="eco-balance-item"><span class="eco-balance-val">${currentUser.dust || 0}</span><span class="eco-balance-label">🌟 poussière</span></div>
      </div>
      <h3 class="economy-section-title"><i class="fas fa-gauge-high"></i> Plafonds anti-farm en cours</h3>
      ${rewardCapRow('🎯 Quiz solo (6h)', caps.quiz)}
      ${rewardCapRow('🎮 Multi / Coop (6h)', caps.multiplayer)}
      <h3 class="economy-section-title"><i class="fas fa-coins"></i> Comment gagner des tokens</h3>
      <div class="economy-sources">${ECONOMY_EARN_SOURCES.map(sourceCard).join('')}</div>
      <h3 class="economy-section-title"><i class="fas fa-cart-shopping"></i> À quoi servent les tokens</h3>
      <div class="economy-sources">${ECONOMY_SPEND_SOURCES.map(sourceCard).join('')}</div>
      <button class="btn-secondary" data-about><i class="fas fa-circle-info"></i> Voir toutes les règles</button>`;
  } catch (e) {
    box.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function setupAppUI() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  });
  document.getElementById('guest-create-account').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/?register=1';
  });
  const headerMenuButton = document.getElementById('header-menu-btn');
  const headerMenu = document.getElementById('header-more-menu');
  const setHeaderMenu = (open) => {
    headerMenu.classList.toggle('hidden', !open);
    headerMenuButton.setAttribute('aria-expanded', String(open));
    if (open) headerMenu.querySelector('input, button')?.focus();
  };
  headerMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    document.getElementById('reward-caps-popover')?.classList.add('hidden');
    setHeaderMenu(headerMenu.classList.contains('hidden'));
  });
  document.addEventListener('click', (event) => {
    if (!headerMenu.classList.contains('hidden') && !event.target.closest('.user-section')) setHeaderMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !headerMenu.classList.contains('hidden')) {
      setHeaderMenu(false);
      headerMenuButton.focus();
    }
  });

  // Plafonds anti-farm (quiz solo + multi/coop, tous deux en fenêtre glissante
  // de 6h) : popup au clic sur la monnaie, hors quiz — jusque-là seulement
  // visible pendant une manche.
  const rewardCapsBtn = document.getElementById('reward-caps-btn');
  const rewardCapsPopover = document.getElementById('reward-caps-popover');
  const setRewardCapsPopover = (open) => {
    rewardCapsPopover.classList.toggle('hidden', !open);
    rewardCapsBtn.setAttribute('aria-expanded', String(open));
  };
  rewardCapsBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!rewardCapsPopover.classList.contains('hidden')) return setRewardCapsPopover(false);
    setHeaderMenu(false);
    rewardCapsPopover.innerHTML = '<p class="hint">Chargement…</p>';
    setRewardCapsPopover(true);
    try {
      const data = await api('/api/economy/reward-caps');
      rewardCapsPopover.innerHTML = `<h4>Plafonds anti-farm</h4>${rewardCapRow('🎯 Quiz solo (6h)', data.quiz)}${rewardCapRow('🎮 Multi / Coop (6h)', data.multiplayer)}<button type="button" class="reward-caps-more" id="reward-caps-goto-economy">Voir toute l'économie →</button>`;
    } catch (e) {
      rewardCapsPopover.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
    }
  });
  rewardCapsPopover.addEventListener('click', (event) => {
    if (event.target.closest('#reward-caps-goto-economy')) { setRewardCapsPopover(false); navTo('economy'); }
  });
  document.addEventListener('click', (event) => {
    if (!rewardCapsPopover.classList.contains('hidden') && !event.target.closest('.user-section')) setRewardCapsPopover(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !rewardCapsPopover.classList.contains('hidden')) {
      setRewardCapsPopover(false);
      rewardCapsBtn.focus();
    }
  });

  // Quêtes du jour : petit panneau toujours accessible depuis l'en-tête (sans
  // quitter l'écran en cours) — avant ça, il fallait revenir sur l'Accueil.
  const questsBtn = document.getElementById('quests-popover-btn');
  const questsPopover = document.getElementById('quests-popover');
  const setQuestsPopover = (open) => {
    questsPopover.classList.toggle('hidden', !open);
    questsBtn.setAttribute('aria-expanded', String(open));
  };
  questsBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!questsPopover.classList.contains('hidden')) return setQuestsPopover(false);
    setHeaderMenu(false);
    setRewardCapsPopover(false);
    questsPopover.innerHTML = '<p class="hint">Chargement…</p>';
    setQuestsPopover(true);
    if (typeof renderQuestsPopover === 'function') renderQuestsPopover();
  });
  questsPopover.addEventListener('click', (event) => {
    const b = event.target.closest('.quest-claim');
    if (b) claimQuest(b.dataset.qid, b);
  });
  document.addEventListener('click', (event) => {
    if (!questsPopover.classList.contains('hidden') && !event.target.closest('.user-section')) setQuestsPopover(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !questsPopover.classList.contains('hidden')) {
      setQuestsPopover(false);
      questsBtn.focus();
    }
  });

  // Amis : petit panneau toujours accessible depuis l'en-tête (n'importe quel
  // écran, y compris en pleine partie) — jusqu'ici il fallait quitter ce
  // qu'on faisait pour aller sur Communauté → Amis.
  const friendsBtn = document.getElementById('friends-popover-btn');
  const friendsPopover = document.getElementById('friends-popover');
  const setFriendsPopover = (open) => {
    friendsPopover.classList.toggle('hidden', !open);
    friendsBtn.setAttribute('aria-expanded', String(open));
  };
  friendsBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!friendsPopover.classList.contains('hidden')) return setFriendsPopover(false);
    setHeaderMenu(false);
    setRewardCapsPopover(false);
    if (typeof setQuestsPopover === 'function') setQuestsPopover(false);
    friendsPopover.innerHTML = '<p class="hint">Chargement…</p>';
    setFriendsPopover(true);
    if (typeof renderFriendsPopover === 'function') renderFriendsPopover();
  });
  friendsPopover.addEventListener('click', (event) => {
    const goto = event.target.closest('#friends-popover-goto');
    if (goto) { setFriendsPopover(false); navTo('friends'); return; }
    const row = event.target.closest('[data-userid]');
    if (row && typeof openPlayerModal === 'function') openPlayerModal(row.dataset.userid);
  });
  document.addEventListener('click', (event) => {
    if (!friendsPopover.classList.contains('hidden') && !event.target.closest('.user-section')) setFriendsPopover(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !friendsPopover.classList.contains('hidden')) {
      setFriendsPopover(false);
      friendsBtn.focus();
    }
  });

  document.getElementById('dev-tokens-btn').addEventListener('click', devGrantTokens);
  const muteBtn = document.getElementById('mute-btn');
  const updateMuteIcon = () => {
    muteBtn.querySelector('i').className = sfx.isMuted() ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
    muteBtn.setAttribute('aria-pressed', String(sfx.isMuted()));
  };
  updateMuteIcon();
  muteBtn.addEventListener('click', () => { sfx.toggleMute(); updateMuteIcon(); });
  const headerVol = document.getElementById('header-volume');
  if (headerVol) headerVol.addEventListener('input', (e) => setVolume(+e.target.value));
  const mpVol = document.getElementById('mp-volume');
  if (mpVol) mpVol.addEventListener('input', (e) => setVolume(+e.target.value));
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
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      localStorage.setItem('amq_mode', mode);
      applyModeUI();
      refreshCatalogInfo();
    });
  });

  setupProfileUI();

  document.getElementById('back-home-economy').addEventListener('click', () => showView('home'));
  document.getElementById('back-home-shop').addEventListener('click', () => showView('collection'));
  document.getElementById('shop-tabs').addEventListener('click', onShopTabClick);
  document.getElementById('shop-cosmetics').addEventListener('click', onShopClick);
  document.getElementById('shop-licenses-panel').addEventListener('click', onShopClick);
  document.getElementById('shop-emotes').addEventListener('click', onShopClick);
  document.getElementById('shop-characters').addEventListener('click', onCharShopClick);
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
  const hubClick = (e) => {
    const pin = e.target.closest('.hub-pin');
    if (pin) { e.stopPropagation(); if (typeof togglePinNav === 'function') togglePinNav(pin.dataset.pin); return; }
    const b = e.target.closest('[data-nav]'); if (b) navTo(b.dataset.nav);
  };
  document.getElementById('view-play').addEventListener('click', hubClick);
  document.getElementById('view-collection').addEventListener('click', hubClick);
  document.getElementById('view-community').addEventListener('click', hubClick);
  document.getElementById('navbar-pinned').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]'); if (b) navTo(b.dataset.nav);
  });
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
    const del = e.target.closest('[data-del-userid]');
    if (del) { e.stopPropagation(); return deletePlayerAccount(del.dataset.delUserid, del.dataset.delName); }
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
  document.getElementById('gacha-tabs').addEventListener('click', onGachaTabClick);
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
  document.getElementById('back-home-admin').addEventListener('click', () => showView('play'));
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
  document.getElementById('admin-seasons-btn').addEventListener('click', runBackfillSeasons);
  document.getElementById('admin-r2-btn').addEventListener('click', runR2Migration);
  document.getElementById('admin-recompute-btn').addEventListener('click', runRecomputeRarities);
  document.getElementById('admin-suppress-banner-btn').addEventListener('click', runSuppressBanner);
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
  document.getElementById('series-filtered-grid').addEventListener('click', openCardFromEvent);
  // Par série : recherche, clic sur une série → filtre, bouton retour
  let seriesSearchTimer;
  document.getElementById('sprog-search').addEventListener('input', (e) => {
    clearTimeout(seriesSearchTimer);
    const v = e.target.value;
    seriesSearchTimer = setTimeout(() => { seriesSearch = v; renderSeriesProgressList(); }, 250);
  });
  document.getElementById('series-progress-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-series]');
    if (row) openSeriesFilter(row.dataset.series);
  });
  document.getElementById('series-spotlight').addEventListener('click', (e) => {
    const row = e.target.closest('[data-series]');
    if (row) openSeriesFilter(row.dataset.series);
  });
  document.getElementById('series-clear-filter').addEventListener('click', closeSeriesFilter);
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

  // Catalogue : lecteur audio (clic sur le bouton lecture d'une ligne) +
  // ouverture du profil de qui a ajouté le son (colonne « Ajouté par »)
  document.getElementById('catalog-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (btn) return toggleCatalogAudio(btn);
    const userBtn = e.target.closest('[data-userid]');
    if (userBtn && typeof openPlayer === 'function') openPlayer(userBtn.dataset.userid);
  });

  document.getElementById('import-btn').addEventListener('click', startImport);
  document.getElementById('import-resync').addEventListener('click', startImport);
  document.getElementById('import-change').addEventListener('click', () => {
    importRowForced = true;
    applyModeUI();
    document.getElementById('anilist-username').focus();
  });
  document.getElementById('next-btn').addEventListener('click', nextSong);
  document.getElementById('reveal-btn').addEventListener('click', guessAnswer);
  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('replay-btn').addEventListener('click', replayClip);
  document.getElementById('like-btn').addEventListener('click', toggleLike);
  document.getElementById('assist-carre').addEventListener('click', () => requestChoices('carre'));
  document.getElementById('assist-duo').addEventListener('click', () => requestChoices('duo'));
  document.getElementById('choice-buttons').addEventListener('click', (e) => {
    const b = e.target.closest('.choice-opt');
    if (b && !b.disabled) guessAnswer(b.dataset.answer);
  });
  document.getElementById('reveal-video-btn').addEventListener('click', toggleVideo);
  document.getElementById('show-answer-btn').addEventListener('click', showAnswerCasual);

  // Alt-tab : on gèle l'extrait (audio + minuteur de coupure + barre) quand on
  // quitte l'onglet, et on le REPREND au retour là où il s'était arrêté — au lieu
  // de couper le son jusqu'à la fin de l'extrait.
  document.addEventListener('visibilitychange', () => {
    const v = video();
    const quizActive = currentSong && !answered &&
      !document.getElementById('view-quiz').classList.contains('hidden');
    if (document.hidden) {
      const wasPlaying = v && !v.paused;
      if (wasPlaying) { v.pause(); setPlayIcon(); }
      clipResumeOnShow = wasPlaying && quizActive;
      if (clipResumeOnShow && clipTimer && clipEndsAt) {
        clearTimeout(clipTimer); clipTimer = null;
        clipRemainingMs = Math.max(0, clipEndsAt - Date.now());
        pauseQuizTimebar();
      }
    } else if (clipResumeOnShow && quizActive) {
      if (v) v.play().catch(() => {});
      setPlayIcon();
      if (clipRemainingMs > 0) { armClipCutoff(clipRemainingMs); resumeQuizTimebar(clipRemainingMs); }
      clipRemainingMs = 0;
      clipResumeOnShow = false;
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
  const optTitleLang = document.getElementById('opt-title-lang');
  if (optTitleLang) {
    optTitleLang.value = settings.titleLang;
    optTitleLang.addEventListener('change', () => {
      settings.titleLang = optTitleLang.value === 'jp' ? 'jp' : 'en';
      localStorage.setItem('amq_titleLang', settings.titleLang);
      if (typeof closeAnimeAutocomplete === 'function') { closeAnimeAutocomplete('answer-input'); closeAnimeAutocomplete('mp-input'); }
    });
  }
  const optAuto = document.getElementById('opt-autonext');
  if (optAuto) {
    optAuto.checked = settings.autoNext;
    optAuto.addEventListener('change', () => {
      settings.autoNext = optAuto.checked;
      localStorage.setItem('amq_autonext', optAuto.checked);
      if (!optAuto.checked) clearTimeout(autoNextTimer);
    });
  }
  const optCount = document.getElementById('opt-count');
  if (optCount) {
    optCount.value = String(settings.count);
    optCount.addEventListener('change', () => {
      settings.count = parseInt(optCount.value);
      localStorage.setItem('amq_count', optCount.value);
      quizSessionEnded = true; // la prochaine manche démarre une nouvelle session
    });
  }
  // « Passer » : abandonne la manche (révèle la réponse, sans tokens).
  document.getElementById('skip-btn').addEventListener('click', () => {
    if (!currentSong || answered) return;
    if (isTraining) showAnswerCasual(); else guessAnswer('');
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
  // L'import AniList ne concerne que « Ma liste ». Quand une liste est déjà liée
  // au compte, on masque le formulaire d'import (accessible via « Gérer ma liste »).
  const isGlobal = mode === 'global';
  const linkedName = currentUser && (currentUser.anilistListName || currentUser.anilistName);
  const showImport = !isGlobal && (!linkedName || importRowForced);
  document.getElementById('import-row').classList.toggle('hidden', !showImport);
  document.getElementById('import-hint').classList.toggle('hidden', !showImport);
  const linkedEl = document.getElementById('import-linked');
  if (linkedEl) {
    const showLinked = !isGlobal && !!linkedName && !importRowForced;
    linkedEl.classList.toggle('hidden', !showLinked);
    if (showLinked) {
      document.getElementById('import-linked-name').textContent = linkedName;
    }
  }
}

function applyGameModeUI() {
  const ranked = gameMode === 'ranked' && !isTraining; // l'entraînement est toujours casual
  const guest = !!currentUser?.isGuest;
  const tag = document.getElementById('gm-tag');
  if (tag) {
    tag.innerHTML = guest
      ? '<i class="fas fa-headphones"></i> Mode découverte'
      : '<i class="fas fa-trophy"></i> Mode classique';
  }
  document.getElementById('gm-hint').textContent = guest
    ? 'Essaie le catalogue librement — aucun score ni progrès sauvegardé.'
    : ranked
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
// Remet le quiz dans un état « prêt à démarrer » propre. Indispensable quand on
// revient sur la page après l'avoir quittée en pleine manche (sinon la manche
// reste figée et « Manche suivante » désactivé → impossible de relancer un son).
function resetQuizToStart() {
  clearTimeout(clipTimer);
  clearTimeout(chronoTimer);
  clearTimeout(autoNextTimer);
  stopRewardGauge();
  clipResumeOnShow = false; clipRemainingMs = 0; clipEndsAt = 0;
  roundClipStart = null;
  answered = false;
  currentSong = null;
  currentRoundToken = null;
  currentLevel = 'cash';
  roundReward = null;
  prefetchedRound = null; // une manche préchargée n'a plus de sens après un reset complet
  [video(), preloadVideoEl()].forEach((v) => {
    if (!v) return;
    try { v.pause(); } catch {}
    v.removeAttribute('src'); try { v.load(); } catch {}
    delete v.dataset.clipUrl;
  });
  // Repart toujours sur le lecteur d'origine visible (au cas où un échange aurait
  // eu lieu juste avant ce reset complet).
  document.getElementById('quiz-video-b')?.classList.add('hidden');
  document.getElementById('quiz-video')?.classList.remove('hidden');
  activeVideoId = 'quiz-video';
  resetQuizUI();
  document.getElementById('answer-input').disabled = true;
  document.getElementById('reveal-btn').disabled = true;
  const next = document.getElementById('next-btn');
  next.disabled = false;
  next.innerHTML = '<i class="fas fa-play"></i> Démarrer';
  setHint('Clique sur « Démarrer » pour lancer une manche.');
}

function openQuiz() {
  isTraining = false;
  trainingSource = null;
  document.getElementById('training-banner').classList.add('hidden');
  document.querySelector('.gamemode-switch').classList.remove('hidden');
  document.getElementById('quiz-mode-panel').classList.remove('hidden');
  applyGameModeUI();
  refreshCatalogInfo();
  resetQuizToStart(); // état propre (au cas où on a quitté en pleine manche)
  refreshQuizOptionsLock();
  quizSessionEnded = true; // la 1re manche démarre une session propre
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
      importRowForced = false; // liste liée → on remasque le formulaire d'import
      applyModeUI();
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

// Bouton ❤ générique, partagé par le Château et le Multi (et tout autre mode).
// `btn` suit son propre état via dataset.liked ; on ne connaît pas l'état initial
// (le serveur ne le renvoie pas), donc le cœur part vide puis reflète la vérité.
async function quickLike(btn, songId) {
  if (!btn || !songId) return;
  if (!currentUser || currentUser.isGuest) return;
  btn.disabled = true;
  const wantLiked = btn.dataset.liked !== '1';
  try {
    const r = await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId, liked: wantLiked }) });
    btn.dataset.liked = r.liked ? '1' : '0';
    btn.querySelector('i').className = r.liked ? 'fas fa-heart' : 'far fa-heart';
    btn.classList.toggle('liked', r.liked);
    if (r.liked && typeof sfx !== 'undefined') sfx.correct();
  } catch {} finally { btn.disabled = false; }
}
// Prépare un bouton ❤ pour une musique révélée (Château, Multi). Masqué pour les
// invités (le like nécessite un compte).
function setupQuickLike(btn, songId) {
  if (!btn) return;
  if (!songId || !currentUser || currentUser.isGuest) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.disabled = false;
  btn.dataset.liked = '0';
  btn.querySelector('i').className = 'far fa-heart';
  btn.classList.remove('liked');
  btn.onclick = () => quickLike(btn, songId);
}

// Partage du jeu : Web Share API (mobile) sinon copie du lien
async function shareGame() {
  const url = location.origin || 'https://amqtrainer.fr';
  const btn = document.getElementById('share-btn');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'AMQTrainer', text: "Devine l'anime à son opening — rejoins-moi !", url });
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

// Query string du tirage aléatoire, selon les réglages courants — utilisé aussi
// bien pour le tirage normal que pour le préchargement en arrière-plan (cf.
// prefetchNextRound), afin que les deux soient toujours strictement identiques.
function buildRandomQuery() {
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
  return qs;
}

// Précharge la manche suivante (tirage + début de buffering vidéo) pendant le
// temps mort naturel de la révélation, dans le lecteur caché — pour que « Manche
// suivante » démarre quasi instantanément au lieu de ré-attendre l'appel réseau
// ET le buffering de l'extrait depuis zéro. Best-effort : en cas d'échec ou de
// réglages changés entre-temps, nextSong() se rabat simplement sur un tirage normal.
async function prefetchNextRound() {
  if (quizSessionEnded) return; // la session est finie, une nouvelle partie redémarrera proprement
  const qs = buildRandomQuery();
  try {
    const { song, roundToken, liked, reward, rewardCap: capData } = await api(`/api/quiz/random?${qs}`);
    if (buildRandomQuery() !== qs) return; // réglages changés pendant l'attente → on jette
    const pv = preloadVideoEl();
    pv.dataset.clipUrl = `/api/quiz/clip/${song.id}?rt=${encodeURIComponent(roundToken)}`;
    pv.src = pv.dataset.clipUrl;
    pv.preload = 'auto';
    pv.load();
    prefetchedRound = { qs, song, roundToken, liked, reward, rewardCap: capData };
  } catch {
    prefetchedRound = null; // tant pis, nextSong() referra un tirage normal
  }
}

// Bascule le lecteur actif vers celui qui a été préchargé (déjà en cours de
// chargement) : video() renverra désormais cet élément. L'ancien est libéré.
function swapToPreloadedVideo() {
  const old = video();
  const next = preloadVideoEl();
  if (old) { try { old.pause(); } catch {} old.removeAttribute('src'); try { old.load(); } catch {} delete old.dataset.clipUrl; }
  old?.classList.add('hidden');
  next.classList.remove('hidden');
  activeVideoId = next.id;
}

async function nextSong() {
  clearTimeout(autoNextTimer);
  // Nouvelle session finie (solo classique) : remet les compteurs à zéro.
  if (quizSessionEnded) { quizCount = 0; quizCorrect = 0; quizSessionEnded = false; }
  resetQuizUI();
  const qs = buildRandomQuery();
  let song, roundToken, liked, reward;
  const usingPrefetch = !!(prefetchedRound && prefetchedRound.qs === qs);
  if (usingPrefetch) {
    ({ song, roundToken, liked, reward } = prefetchedRound);
    rewardCap = prefetchedRound.rewardCap || null;
    renderRewardCap(rewardCap);
  } else {
    prefetchedRound = null; // périmé (réglages différents) ou jamais abouti → on jette
    setHint('Chargement…');
    try {
      let capData;
      ({ song, roundToken, liked, reward, rewardCap: capData } = await api(`/api/quiz/random?${qs}`));
      rewardCap = capData || null; // null en entraînement/non classé
      renderRewardCap(rewardCap);
    } catch (err) {
      setHint(err.message + (!trainingSource && mode === 'mine' ? " — importe d'abord ta liste, ou passe en « Catalogue global »." : ''));
      return;
    }
  }
  prefetchedRound = null; // consommée (ou jamais eue) : plus valable pour la manche suivante
  currentSong = song;
  roundClipStart = null;
  currentRoundToken = roundToken;
  roundReward = reward || null;
  roundStartAt = Date.now(); // référence vitesse : aligne la jauge sur le `sat` serveur
  currentLiked = !!liked;
  currentLevel = 'cash';
  setLikeButton();
  resetAssist();
  answered = false;
  if (!isTraining && settings.count > 0) quizCount++; // session finie en cours
  if (usingPrefetch) swapToPreloadedVideo(); // le lecteur caché prend la place du visible
  const v = video();
  await closePictureInPictureFor(v);
  const clipUrl = `/api/quiz/clip/${song.id}?rt=${encodeURIComponent(roundToken)}`;
  if (!usingPrefetch) {
    v.dataset.clipUrl = clipUrl;
    v.src = clipUrl; // flux proxifié (anti-triche)
    v.preload = 'auto';
    v.load();
  } // sinon déjà chargée (ou en cours) par prefetchNextRound()
  v.volume = getVolume();
  showOverlay(true); // mode audio : on masque l'image, le son joue quand même

  document.getElementById('answer-input').disabled = false;
  document.getElementById('reveal-btn').disabled = false;
  document.getElementById('answer-input').focus();
  document.getElementById('skip-btn').classList.remove('hidden'); // « Passer » pendant la manche
  document.getElementById('next-btn').innerHTML = '<i class="fas fa-forward"></i> Manche suivante';
  document.getElementById('next-btn').disabled = true; // pas de saut sans répondre (fausserait les stats) → utiliser « Passer »
  updateVideoButtonVisibility(); // cache la vidéo en classé tant qu'on n'a pas répondu
  refreshQuizOptionsLock(); // manche en cours → fige les réglages
  startRewardGauge(); // jauge « tokens en jeu » (décroît avec la vitesse, classé seulement)

  await startClip(); // applique départ aléatoire + coupure, puis lance
}

// Positionne l'extrait (départ aléatoire) et le joue, en coupant après la durée choisie.
async function startClip() {
  const v = video();
  clearTimeout(clipTimer);
  const clipUrl = v.dataset.clipUrl || v.getAttribute('src');
  if (!clipUrl) return;

  const seek = () => {
    if (roundClipStart == null) {
      if (settings.randomStart && v.duration && isFinite(v.duration)) {
        const clip = settings.clipSeconds || 20;
        const max = Math.max(0, v.duration - clip);
        roundClipStart = Math.random() * max;
      } else {
        roundClipStart = 0;
      }
    }
    v.currentTime = Math.min(roundClipStart, Math.max(0, (v.duration || roundClipStart) - 0.1));
  };
  let playing = false;
  let lastPlayError = null;
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
      lastPlayError = error;
      if (error?.name === 'NotAllowedError') {
        setHint('▶ Lecture bloquée par le navigateur — clique sur le bouton lecture.');
        break;
      }
    }
  }
  if (!playing && !v.paused) playing = true;
  if (!playing) {
    const mediaReady = v.readyState >= 2 && !v.error;
    setHint(mediaReady
      ? '▶ Son prêt — appuie sur lecture pour démarrer.'
      : '⚠️ Le son ne charge pas. Clique sur réécouter pour relancer.');
    if (!mediaReady && lastPlayError) console.warn('Lecture du quiz impossible :', lastPlayError.name || lastPlayError.message);
    setPlayIcon();
    return;
  }
  const sessionTag = (!isTraining && settings.count > 0) ? ` · Son ${quizCount}/${settings.count}` : '';
  setHint("🎵 Devine l'anime à partir de l'extrait." + sessionTag);
  setPlayIcon();

  // Coupure après la durée choisie (sauf "Illimitée" ou si la vidéo est révélée)
  clipResumeOnShow = false; clipRemainingMs = 0;
  if (settings.clipSeconds > 0) {
    startQuizTimebar(settings.clipSeconds);
    armClipCutoff(settings.clipSeconds * 1000);
  } else {
    stopQuizTimebar(); // illimité : pas de barre
    clipEndsAt = 0;
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

// Programme (ou reprogramme) la coupure de l'extrait dans `ms` millisecondes.
function armClipCutoff(ms) {
  clearTimeout(clipTimer);
  clipEndsAt = Date.now() + ms;
  clipTimer = setTimeout(() => {
    const v = video();
    if (!answered && v) { v.pause(); setOverlayEnded(true); } // extrait fini → invite à répondre/passer
    setPlayIcon();
  }, ms);
}

async function replayClip() {
  if (!currentSong) return;
  const v = video();
  clearTimeout(clipTimer);
  if (v.readyState >= 2 && !v.error && roundClipStart != null) {
    try {
      v.currentTime = roundClipStart;
      await v.play();
      setHint("🎵 Devine l'anime à partir de l'extrait.");
      if (settings.clipSeconds > 0) {
        startQuizTimebar(settings.clipSeconds);
        armClipCutoff(settings.clipSeconds * 1000);
      }
      setPlayIcon();
      return;
    } catch {}
  }
  await startClip();
}

// Barre de temps de l'extrait (solo) : se vide sur la durée d'écoute.
function startQuizTimebar(seconds) {
  const bar = document.getElementById('quiz-timebar');
  const fill = document.getElementById('quiz-timefill');
  if (!bar || !fill) return;
  bar.classList.remove('hidden');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.classList.remove('low');
  void fill.offsetWidth; // reflow
  fill.style.transition = `width ${seconds}s linear`;
  fill.style.width = '0%';
  setTimeout(() => fill.classList.add('low'), Math.max(0, (seconds - 4) * 1000));
}
function stopQuizTimebar() {
  const bar = document.getElementById('quiz-timebar');
  const fill = document.getElementById('quiz-timefill');
  if (fill) { fill.style.transition = 'none'; }
  if (bar) bar.classList.add('hidden');
}
// Fige la barre à sa position actuelle (arrière-plan / alt-tab).
function pauseQuizTimebar() {
  const fill = document.getElementById('quiz-timefill');
  if (!fill || fill.parentElement.classList.contains('hidden')) return;
  const w = getComputedStyle(fill).width;
  fill.style.transition = 'none';
  fill.style.width = w; // gèle à la largeur courante
}
// Reprend la vidange de la barre sur le temps restant.
function resumeQuizTimebar(remainingMs) {
  const fill = document.getElementById('quiz-timefill');
  if (!fill || remainingMs <= 0) return;
  void fill.offsetWidth; // reflow
  fill.style.transition = `width ${remainingMs}ms linear`;
  fill.style.width = '0%';
}

// Multiplicateur de vitesse — DOIT rester aligné avec speedMultiplier() côté serveur
// (backend/src/quiz/quiz.routes.js). Les constantes (grace/floorAt/floor) viennent
// du serveur via roundReward, donc seule la forme de la courbe est dupliquée ici.
function speedMult(elapsedSec, c) {
  if (!(elapsedSec > c.grace)) return 1;
  if (elapsedSec >= c.floorAt) return c.floor;
  const t = (elapsedSec - c.grace) / (c.floorAt - c.grace);
  return 1 - t * (1 - c.floor);
}

// Jauge « tokens en jeu » : montre en temps réel ce que vaut une bonne réponse
// maintenant. Décroît avec la vitesse en mode classé ; reste figée sinon.
function startRewardGauge() {
  const el = document.getElementById('reward-stake');
  stopRewardGauge();
  if (!el) return;
  if (!roundReward || !roundReward.max) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const tick = () => {
    if (answered) return stopRewardGauge();
    let stake = roundReward.max, atFloor = false;
    if (roundReward.timed) {
      const elapsed = (Date.now() - roundStartAt) / 1000;
      const m = speedMult(elapsed, roundReward);
      stake = Math.max(1, Math.round(roundReward.max * m));
      atFloor = m <= roundReward.floor + 0.001;
    }
    el.innerHTML = `<i class="fas fa-bolt"></i> ${stake} 🪙 en jeu`;
    el.classList.toggle('low', atFloor);
  };
  tick();
  if (roundReward.timed) gaugeTimer = setInterval(tick, 250);
}
function stopRewardGauge() {
  clearInterval(gaugeTimer);
  gaugeTimer = null;
}

// Compteur du plafond anti-farm (fenêtre glissante de 6 h).
function renderRewardCap(cap) {
  const el = document.getElementById('reward-cap');
  if (!el) return;
  const full = cap && cap.max && cap.used >= cap.max;
  // On n'affiche le compteur que lorsqu'on APPROCHE du plafond (≥ 80 %) ou qu'il
  // est atteint — sinon l'indicateur paraît « actif » alors qu'on en est loin.
  if (!cap || !cap.max || (!full && cap.used < cap.max * 0.8)) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('full', full);
  el.innerHTML = full
    ? `🚫 Plafond atteint : ${cap.max} 🪙 / 6 h · reset ${capResetText(cap.resetAt)}`
    : `<i class="fas fa-shield-halved"></i> Plafond proche : <b>${cap.used}</b>/${cap.max} 🪙 <small>(6 h)</small>`;
}
function capResetText(ts) {
  const ms = (ts || 0) - Date.now();
  if (ms <= 0) return 'imminent';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `dans ${h} h ${String(m).padStart(2, '0')}` : `dans ${m} min`;
}

// Détail du calcul de récompense (transparence), affiché au verdict.
function rewardDetailText(b) {
  if (!b) return '';
  if (!b.firstCorrect) return 'Rejeu : gain réduit (anti-farm)';
  const parts = [`${b.base} de base`];
  if (b.speedMult < 0.999) parts.push(`vitesse ×${b.speedMult.toFixed(2)}`);
  if (b.levelMult < 0.999) parts.push(`${b.level} ×${b.levelMult}`);
  return parts.join(' · ');
}

// Overlay « extrait terminé » : invite à proposer une réponse ou à passer.
function setOverlayEnded(ended) {
  const ov = document.getElementById('audio-overlay');
  if (!ov) return;
  ov.classList.toggle('ended', ended);
  ov.innerHTML = ended
    ? '<div class="overlay-ended"><i class="fas fa-clock"></i><span>Extrait terminé</span><small>Propose une réponse ou passe</small></div>'
    : '<i class="fas fa-music"></i>';
}

function resetQuizUI() {
  document.getElementById('answer-result').classList.add('hidden');
  document.getElementById('answer-input').value = '';
  if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('answer-input');
  document.querySelectorAll('.feedback-buttons [data-fb]').forEach((b) => (b.disabled = false));
  const detail = document.getElementById('reward-detail');
  if (detail) detail.textContent = '';
  stopRewardGauge();
  const stake = document.getElementById('reward-stake');
  if (stake) stake.classList.add('hidden');
  stopQuizTimebar();
  setOverlayEnded(false);
  document.getElementById('skip-btn').classList.add('hidden');
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
    if (roundReward && r.reward) { roundReward.max = r.reward.max; startRewardGauge(); } // aide → enjeu réduit
    hideAssist();
    document.getElementById('answer-area').classList.add('hidden');
    const box = document.getElementById('choice-buttons');
    box.innerHTML = r.options.map((o, i) => {
      const answer = englishFirst() && o.englishTitle ? o.englishTitle : o.title;
      const seasonBadge = o.seasonNumber > 0 ? `<span class="choice-season">S${o.seasonNumber}</span>` : '';
      return `<button class="choice-opt" data-answer="${escapeHtml(answer)}"><span class="choice-num">${i + 1}</span><span class="choice-body">${seasonBadge}<span class="choice-title">${escapeHtml(answer)}</span></span></button>`;
    }).join('');
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
  stopRewardGauge(); // fige les tokens en jeu au moment de valider
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

  if (r.correct && !isTraining && settings.count > 0) quizCorrect++;
  const verdict = document.getElementById('answer-verdict');
  if (r.correct) {
    verdict.textContent = r.reward ? `✅ Bonne réponse !  +${r.reward} 🪙` : '✅ Bonne réponse !';
    sfx.correct();
  } else {
    verdict.textContent = '❌ Raté';
    sfx.wrong();
  }
  verdict.className = 'verdict ' + (r.correct ? 'ok' : 'ko');
  if (r.rewardCap) { rewardCap = r.rewardCap; renderRewardCap(rewardCap); }
  const detail = document.getElementById('reward-detail');
  if (detail) {
    detail.textContent = r.rewardCap && r.rewardCap.capped
      ? '🚫 Plafond anti-farm atteint (300 🪙 / 6 h)'
      : (r.reward ? rewardDetailText(r.breakdown) : '');
  }

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
  document.getElementById('answer-anime').textContent = formatAnimeLabel({ title: answer.animeTitle, englishTitle: answer.englishTitle, seasonNumber: answer.seasonNumber });
  document.getElementById('answer-title').textContent = answer.title;
  document.getElementById('answer-artist').textContent = answer.artist || 'Artiste inconnu';
  document.getElementById('answer-result').classList.remove('hidden');
  stopQuizTimebar();
  setOverlayEnded(false);
  document.getElementById('next-btn').disabled = false; // manche résolue → on peut passer à la suite
  document.getElementById('skip-btn').classList.add('hidden'); // manche résolue
  showOverlay(false); // révèle la vidéo
  updateVideoButtonVisibility();
  refreshQuizOptionsLock(); // manche résolue → réglages de nouveau modifiables

  // Fin d'une session finie (solo classique) : récap + nouvelle partie.
  const sessionDone = !isTraining && settings.count > 0 && quizCount >= settings.count;
  clearTimeout(autoNextTimer);
  if (sessionDone) {
    quizSessionEnded = true;
    setHint(`🏁 Partie terminée : ${quizCorrect}/${settings.count} bonne(s) réponse(s) !`);
    document.getElementById('next-btn').innerHTML = '<i class="fas fa-rotate-right"></i> Nouvelle partie';
  } else if (settings.autoNext) {
    // Enchaînement automatique vers la manche suivante (option)
    autoNextTimer = setTimeout(() => { if (answered) nextSong(); }, 4000);
  }
  // Profite du temps mort de la révélation (4 s d'auto-enchaînement, ou le temps
  // que le joueur clique sur « Manche suivante ») pour précharger la manche
  // d'après en arrière-plan — cf. prefetchNextRound().
  if (!sessionDone) prefetchNextRound();
}

// Mode entraînement : révèle la réponse sans scorer ni gagner de tokens
async function showAnswerCasual() {
  if (!currentSong || answered) return;
  answered = true;
  clearTimeout(clipTimer);
  clearTimeout(chronoTimer);
  stopRewardGauge();
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
async function togglePlay() {
  const v = video();
  if (!v.src) return;
  try {
    if (v.paused) await v.play();
    else v.pause();
  } catch {
    setHint('⚠️ Lecture impossible pour cet extrait. Essaie la manche suivante.');
  } finally {
    setPlayIcon();
  }
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
// Pastille « quêtes à réclamer » sur le bouton d'en-tête (visible sur tous les écrans).
function updateQuestsBadge(n) {
  const el = document.getElementById('quests-nav-badge');
  if (!el) return;
  el.textContent = n || '';
  el.classList.toggle('hidden', !n);
}
async function loadQuestsBadge() {
  try { const { quests } = await api('/api/quests'); updateQuestsBadge((quests || []).filter((q) => q.done && !q.claimed).length); } catch {}
}

// Fragment réutilisé par le widget Accueil et le panneau d'en-tête.
function questItemHtml(q) {
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
}
function questsBadgeHtml(quests) {
  const claimable = quests.filter((q) => q.done && !q.claimed).length;
  const claimedAll = quests.every((q) => q.claimed);
  return claimable
    ? `<span class="quests-badge ready">${claimable} à réclamer ✨</span>`
    : claimedAll
    ? '<span class="quests-badge done">Tout réclamé ✓</span>'
    : '<span class="quests-badge">+🪙 chaque jour</span>';
}

async function loadQuests() {
  const box = document.getElementById('home-quests');
  if (!box) return;
  try {
    const { quests } = await api('/api/quests');
    updateQuestsBadge((quests || []).filter((q) => q.done && !q.claimed).length);
    if (!quests || !quests.length) { box.innerHTML = ''; return; }
    const claimable = quests.filter((q) => q.done && !q.claimed).length;
    box.classList.toggle('has-claim', claimable > 0);
    box.innerHTML =
      `<h3 class="quests-title"><i class="fas fa-bullseye"></i> Quêtes du jour ${questsBadgeHtml(quests)}</h3><div class="quests-list">` +
      quests.map(questItemHtml).join('') + '</div>';
  } catch { box.innerHTML = ''; }
}

// Panneau compact (en-tête) : mêmes quêtes, toujours accessible sans quitter
// l'écran en cours (avant, il fallait revenir sur l'Accueil pour réclamer).
async function renderQuestsPopover() {
  const box = document.getElementById('quests-popover');
  try {
    const { quests } = await api('/api/quests');
    updateQuestsBadge((quests || []).filter((q) => q.done && !q.claimed).length);
    if (!quests || !quests.length) { box.innerHTML = '<p class="hint">Aucune quête aujourd\'hui.</p>'; return; }
    box.innerHTML = `<h4>Quêtes du jour ${questsBadgeHtml(quests)}</h4>
      <div class="quests-pop-list">${quests.map(questItemHtml).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
  }
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
    const popover = document.getElementById('quests-popover');
    if (popover && !popover.classList.contains('hidden')) renderQuestsPopover();
  } catch (e) { alert(e.message); btn.disabled = false; }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('home-quests').addEventListener('click', (e) => {
    const b = e.target.closest('.quest-claim');
    if (b) claimQuest(b.dataset.qid, b);
  });
});

// ── Nouveautés (changelog mis en avant sur l'accueil) ──
let changelogCache = null;
async function fetchChangelog() {
  if (changelogCache) return changelogCache;
  try { changelogCache = (await api('/api/changelog?limit=20')).entries; } catch { changelogCache = []; }
  return changelogCache;
}
function changelogSeenId() { return parseInt(localStorage.getItem('amq_changelog_seen') || '0', 10); }
function markChangelogSeen(id) {
  if (id > changelogSeenId()) localStorage.setItem('amq_changelog_seen', String(id));
  updateChangelogBadge();
}
function changelogTagMeta(tag) {
  if (tag === 'feature') return { icon: '✨', label: 'Nouveau', cls: 'feat' };
  if (tag === 'fix') return { icon: '🐛', label: 'Correction', cls: 'fix' };
  return { icon: '🔧', label: 'Amélioration', cls: 'imp' };
}
function changelogDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}
function updateChangelogBadge() {
  const badge = document.getElementById('changelog-nav-badge');
  if (!badge || !changelogCache) return;
  const unseen = changelogCache.filter((e) => e.id > changelogSeenId()).length;
  badge.textContent = unseen > 9 ? '9+' : String(unseen);
  badge.classList.toggle('hidden', unseen === 0);
}
async function loadChangelogBadge() {
  await fetchChangelog();
  updateChangelogBadge();
}
async function loadChangelog() {
  const box = document.getElementById('home-changelog');
  if (!box) return;
  const entries = await fetchChangelog();
  if (!entries.length) { box.innerHTML = ''; return; }
  const seen = changelogSeenId();
  const latest = entries.slice(0, 3);
  box.innerHTML = `
    <div class="changelog-head">
      <h3><i class="fas fa-bullhorn"></i> Nouveautés</h3>
      <button class="btn-link" id="changelog-see-all">Tout voir <i class="fas fa-arrow-right"></i></button>
    </div>
    <div class="changelog-cards">
      ${latest.map((e) => {
        const meta = changelogTagMeta(e.tag);
        const isNew = e.id > seen;
        return `<div class="changelog-card ${meta.cls}${isNew ? ' is-new' : ''}">
          ${isNew ? '<span class="changelog-new-dot" title="Nouveau depuis ta dernière visite"></span>' : ''}
          <span class="changelog-tag">${meta.icon} ${meta.label}</span>
          <h4>${escapeHtml(e.title)}</h4>
          <p>${escapeHtml(e.description)}</p>
          <span class="changelog-date">${changelogDate(e.date)}</span>
        </div>`;
      }).join('')}
    </div>`;
  markChangelogSeen(latest[0].id); // affiché en avant sur l'accueil = considéré comme vu
}
function renderChangelogModalBody(entries) {
  return entries.map((e) => {
    const meta = changelogTagMeta(e.tag);
    return `<div class="changelog-row ${meta.cls}">
      <span class="changelog-tag">${meta.icon} ${meta.label}</span>
      <div class="changelog-row-body">
        <h4>${escapeHtml(e.title)}</h4>
        <p>${escapeHtml(e.description)}</p>
      </div>
      <span class="changelog-date">${changelogDate(e.date)}</span>
    </div>`;
  }).join('');
}
async function openChangelogModal() {
  const modal = document.getElementById('changelog-modal');
  const body = document.getElementById('changelog-modal-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  const entries = await fetchChangelog();
  body.innerHTML = entries.length ? renderChangelogModalBody(entries) : '<p class="muted">Rien à afficher pour l’instant.</p>';
  if (entries.length) markChangelogSeen(entries[0].id);
}

// ── Hub d'accueil : derniers tirages Légendaire+ (tous joueurs) ──
function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'à l’instant';
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

async function loadRecentPulls() {
  const box = document.getElementById('home-recent-pulls');
  if (!box) return;
  try {
    const { pulls } = await api('/api/gacha/recent-pulls?limit=20');
    if (!pulls || !pulls.length) { box.innerHTML = ''; return; }
    box.innerHTML =
      `<h3 class="quests-title"><i class="fas fa-bolt"></i> Derniers tirages Légendaire+</h3>
      <div class="recent-pulls-strip">${pulls.map((p) => {
        const img = p.imageUrl ? `style="background-image:url('${p.imageUrl}')"` : '';
        return `<button class="recent-pull-card r-${p.rarity}" data-cid="${p.characterId}" title="${escapeHtml(p.name)}">
          <div class="rp-img" ${img}></div>
          <span class="rp-rarity r-${p.rarity}">${p.rarityLabel}</span>
          <span class="rp-name">${escapeHtml(p.name)}</span>
          ${p.series ? `<span class="rp-series">${escapeHtml(p.series)}</span>` : ''}
          <span class="rp-user">${p.user.avatarUrl ? `<img class="rp-avatar" src="${p.user.avatarUrl}" alt="">` : ''}${escapeHtml(p.user.displayName)}</span>
          <span class="rp-time">${timeAgo(p.obtainedAt)}</span>
        </button>`;
      }).join('')}</div>`;
  } catch { box.innerHTML = ''; }
}

// Accueil : tes propres stats (rien de personnel n'était visible sur cette
// page jusqu'ici — tout le reste, quêtes/tirages/catalogue, est global).
async function loadPersonalStats() {
  const box = document.getElementById('home-personal-stats');
  if (!box || !currentUser || currentUser.isGuest) { if (box) box.innerHTML = ''; return; }
  try {
    const s = await api('/api/quiz/stats');
    box.innerHTML = `
      <h3 class="quests-title"><i class="fas fa-user"></i> Tes stats</h3>
      <div class="profile-stats home-pstats">
        <div class="pstat"><span>${s.played}</span><label>Jouées</label></div>
        <div class="pstat"><span>${s.rate}%</span><label>Réussite</label></div>
        <div class="pstat"><span>${currentUser.dailyStreak || 0} 🔥</span><label>Série</label></div>
        <div class="pstat"><span>${currentUser.towerBestFloor || 0}</span><label>Meilleur étage</label></div>
      </div>`;
  } catch { box.innerHTML = ''; }
}

// Accueil : sons les plus/moins réussis et les plus joués (tous joueurs).
async function loadHighlights() {
  const box = document.getElementById('home-highlights');
  if (!box) return;
  try {
    const d = await api('/api/quiz/highlights');
    const col = (title, icon, list, valueFn) => `
      <div class="highlight-col">
        <h4><i class="fas ${icon}"></i> ${title}</h4>
        ${list.length
          ? list.slice(0, 5).map((s) => `
            <div class="highlight-row">
              <span class="highlight-anime">${escapeHtml(s.animeTitle)} <small>${s.type}${s.number}</small></span>
              <b>${valueFn(s)}</b>
            </div>`).join('')
          : '<p class="muted">Pas encore assez de données.</p>'}
      </div>`;
    if (!d || (!d.hardest.length && !d.easiest.length && !d.mostPlayed.length)) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <h3 class="quests-title"><i class="fas fa-chart-line"></i> Le catalogue en chiffres</h3>
      <div class="highlights-grid">
        ${col('Les plus difficiles', 'fa-skull', d.hardest, (s) => `${s.rate}%`)}
        ${col('Les plus faciles', 'fa-face-smile', d.easiest, (s) => `${s.rate}%`)}
        ${col('Les plus jouées', 'fa-fire', d.mostPlayed, (s) => `${s.plays}×`)}
      </div>`;
  } catch { box.innerHTML = ''; }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('home-recent-pulls').addEventListener('click', (e) => {
    const b = e.target.closest('.recent-pull-card');
    if (b && typeof openCharacter === 'function') openCharacter(b.dataset.cid);
  });
  document.getElementById('home-changelog').addEventListener('click', (e) => {
    if (e.target.closest('#changelog-see-all')) openChangelogModal();
  });
  document.getElementById('changelog-modal-close').addEventListener('click', () => {
    document.getElementById('changelog-modal').classList.add('hidden');
  });
  document.getElementById('changelog-modal').addEventListener('click', (e) => {
    if (e.target.id === 'changelog-modal') e.currentTarget.classList.add('hidden');
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

// Badge « X en ligne » sur le bouton d'en-tête, dès la connexion (sans
// attendre la première ouverture du panneau).
async function loadFriendsOnlineCount() {
  try {
    const d = await api('/api/friends');
    const el = document.getElementById('friends-online-count');
    if (el) el.textContent = d.friends.filter((u) => u.online).length;
  } catch {}
}

// Panneau compact (en-tête) : liste d'amis toujours accessible sans quitter
// l'écran/la partie en cours. Réutilise la même API que la page Amis
// complète (loadFriends), juste un rendu plus court + clic → profil en modale.
async function renderFriendsPopover() {
  const box = document.getElementById('friends-popover');
  try {
    const d = await api('/api/friends');
    const online = d.friends.filter((u) => u.online).length;
    document.getElementById('friends-online-count').textContent = online;
    const rows = d.friends.length
      ? d.friends.slice(0, 8).map((u) => `
          <button type="button" class="friend-pop-row" data-userid="${u.id}">
            ${friendAvatar(u)}
            <span class="friend-name">${escapeHtml(u.displayName)}</span>
            <span class="friend-dot ${u.online ? 'on' : 'off'}" title="${u.online ? 'En ligne' : 'Hors ligne'}"></span>
          </button>`).join('')
      : '<p class="hint">Aucun ami pour l\'instant.</p>';
    box.innerHTML = `<h4>Amis <span class="hint">· ${online} en ligne</span></h4>
      <div class="friends-pop-list">${rows}</div>
      <button type="button" class="reward-caps-more" id="friends-popover-goto">Voir tous mes amis →</button>`;
  } catch (e) {
    box.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
  }
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
  return api(`/api/friends/${path}`, { method: 'POST', body: JSON.stringify({ userId }) });
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

// ════════════════════════════════════════════
// MULTIJOUEUR (Socket.io) — salles, chat, emotes, manches synchronisées
// Utilise les globals de main.js (escapeHtml, showView, currentUser).
// ════════════════════════════════════════════
let mpSocket = null;
let mpTimer = null;
let mpLobbyCountdown = null;
let mpPreloadTimer = null;
let mpPreparedUrl = null;
let mpActiveRound = 0;
let mpPlaybackSequence = 0;
let mpRoom = null; // dernier snapshot de salon
let mpMode = 'classic'; // classic | teams | elim | coop
let mpTeamNames = ['Rouge', 'Bleu'];
let mpEliminated = false; // moi, en mode élimination
let mpCoop = false; // mode coop (Tour en équipe)
let mpTeamLives = 0; // vies partagées en coop
let mpSpectating = false; // je regarde une partie (lecture seule, pas joueur)
let mpVotedSkip = false; // ai-je voté pour passer l'extrait en cours ?
let mpVoteSkipVotes = 0;
let mpVoteSkipNeeded = 1;
let mpCoopFreeSkip = true; // coop : passe encore gratuit (1 par partie)
let mpRoundHistory = []; // manches révélées de la partie en cours (récap de fin)
let mpClockOffset = 0; // serverNow - clientNow (voir mpSyncClock)

// Le serveur envoie des timestamps ABSOLUS (startAt, countdownEndsAt) pour que
// l'extrait démarre en même temps chez tous les joueurs. Comparer ça au Date.now()
// LOCAL suppose une horloge système client bien synchronisée — faux en pratique
// (PC/mobiles mal réglés) : le compte à rebours local finit alors trop tôt ou trop
// tard par rapport au vrai `endRound` serveur, perçu comme un délai avant le reveal.
// mpNow() corrige avec l'écart mesuré par aller-retour (mpSyncClock).
function mpNow() { return Date.now() + mpClockOffset; }
function mpSyncClock() {
  if (!mpSocket) return;
  let best = null;
  let done = 0;
  const attempts = 3;
  const tick = () => {
    const t0 = Date.now();
    mpSocket.emit('mp:sync', t0, (res) => {
      const rtt = Date.now() - t0;
      const offset = res.serverTs + rtt / 2 - Date.now();
      if (best === null || rtt < best.rtt) best = { rtt, offset };
      done++;
      if (done >= attempts) mpClockOffset = best.offset;
      else setTimeout(tick, 120);
    });
  };
  tick();
}

// Affiche les vies partagées de l'équipe (coop) dans le HUD.
function updateCoopLives() {
  const el = document.getElementById('mp-coop-lives');
  if (!el) return;
  el.classList.toggle('hidden', !mpCoop);
  if (mpCoop) el.innerHTML = `<i class="fas fa-heart"></i> × ${Math.max(0, mpTeamLives)} <small>(équipe)</small>`;
}
let mpEngaged = false; // suis-je dans une salle/file (≠ simple consultation du menu) ?
let mpLeft = false; // ai-je quitté volontairement la vue ? (ignore les events en vol)
const MP_FREE_EMOTES = ['😂', '🔥', '👍', '😮', '😭', '🎉', '👏', '💀', '🤓'];
const mpFreeEmoteItems = () => MP_FREE_EMOTES.map((symbol) => ({ id: symbol, symbol }));
let mpEmotes = mpFreeEmoteItems();
const mpVideo = () => document.getElementById('mp-video');

// Quitter la salle quand on navigue HORS de la vue multi (back, navbar, etc.).
// Sans ça, on reste membre côté serveur : sons qui continuent + re-bascule forcée
// vers la vue multi au moindre broadcast (mp:room).
function mpHandleLeaveView() {
  if (!mpEngaged) return;
  mpEngaged = false;
  mpLeft = true;
  if (mpSocket) { if (mpSpectating) mpSocket.emit('mp:unspectate'); mpSocket.emit('mp:leave'); }
  mpSpectating = false;
  applySpectatorUI();
  mpRoom = null;
  mpEliminated = false;
  mpShow('menu');
  const mm = document.getElementById('mp-menu-msg');
  if (mm) mm.textContent = '';
  if (typeof stopMpMedia === 'function') stopMpMedia();
  clearInterval(mpLobbyCountdown);
  mpLobbyCountdown = null;
}

// Toast (notifications multi : invitations, infos)
function mpToast(html, actionLabel, onAction) {
  let layer = document.getElementById('mp-toasts');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'mp-toasts';
    layer.className = 'mp-toasts';
    document.body.appendChild(layer);
  }
  const t = document.createElement('div');
  t.className = 'mp-toast';
  t.innerHTML = `<span>${html}</span>`;
  if (actionLabel && onAction) {
    const b = document.createElement('button');
    b.className = 'btn-primary';
    b.textContent = actionLabel;
    b.addEventListener('click', () => { onAction(); t.remove(); });
    t.appendChild(b);
  }
  const close = document.createElement('button');
  close.className = 'mp-toast-x';
  close.innerHTML = '✕';
  close.addEventListener('click', () => t.remove());
  t.appendChild(close);
  layer.appendChild(t);
  setTimeout(() => t.remove(), 15000);
}

function mpShow(panel) {
  ['menu', 'coopmenu', 'room', 'game', 'over'].forEach((p) =>
    document.getElementById('mp-' + p).classList.toggle('hidden', p !== panel)
  );
  relocateMpChat(panel);
}

// ── Inviter des amis depuis le lobby (salle privée) ──
// Liste les amis EN LIGNE avec un bouton d'invitation direct — avant, il
// fallait quitter le salon, aller dans Amis, inviter, puis revenir.
async function toggleMpInviteList() {
  const box = document.getElementById('mp-invite-list');
  if (!box) return;
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const r = await api('/api/friends');
    const online = (r.friends || []).filter((f) => f.online);
    box.innerHTML = online.length
      ? online.map((f) => `<button type="button" class="btn-secondary mp-invite-row" data-invite-userid="${f.id}">
          ${otherAvatar(f, 'avatar-xs')} <span>${escapeHtml(f.displayName)}</span> <i class="fas fa-paper-plane"></i>
        </button>`).join('')
      : `<p class="muted">Aucun ami en ligne pour l'instant.${(r.friends || []).length ? '' : ' Ajoute des amis depuis Communauté → Amis.'}</p>`;
  } catch (e) {
    box.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── Rejoindre une salle via un lien partagé (amqtrainer.fr/?join=CODE) ──
// Appelé après l'entrée dans l'app (main.js) quand l'URL porte ?join=.
function mpJoinFromLink(code) {
  code = String(code || '').trim().toUpperCase().slice(0, 8);
  if (!code || (typeof currentUser === 'object' && currentUser?.isGuest)) return;
  mpLeft = false; mpEngaged = true;
  showView('mp');
  mpShow('menu');
  const msg = document.getElementById('mp-menu-msg');
  if (msg) msg.textContent = `Connexion à la salle ${code}…`;
  const sock = connectMp();
  if (!sock) return;
  const join = () => sock.emit('mp:join', code);
  if (sock.connected) join(); else sock.once('connect', join);
}

// Copie le lien d'invitation de la salle privée courante (ouvre le jeu
// directement dans la salle — partageable sur Discord, etc.).
async function copyMpRoomLink() {
  const code = mpRoom?.code;
  if (!code) return;
  const url = `${location.origin}/?join=${code}`;
  const btn = document.getElementById('mp-copy-link');
  try {
    if (navigator.share) { await navigator.share({ title: 'AMQTrainer — rejoins ma salle', url }); return; }
    await navigator.clipboard.writeText(url);
    if (btn) { const old = btn.innerHTML; btn.innerHTML = '<i class="fas fa-check"></i> Copié !'; setTimeout(() => (btn.innerHTML = old), 1800); }
  } catch { /* partage annulé */ }
}

// ── Partage du résultat (grille façon Wordle, comme le défi du jour) ──
let mpLastOver = null; // { coop, floor } ou { placement, players, ranked }
async function shareMpResult() {
  const total = mpRoundHistory.length;
  const grid = mpRoundHistory.map((h) => (h.correct === true ? '🟩' : h.correct === false ? '🟥' : '⬜')).join('');
  const correct = mpRoundHistory.filter((h) => h.correct === true).length;
  const head = mpLastOver?.coop
    ? `Tour en équipe · étage ${mpLastOver.floor}`
    : mpLastOver?.placement
      ? `${mpLastOver.placement}ᵉ/${mpLastOver.players}${mpLastOver.ranked ? ' (classé)' : ''}`
      : 'Partie multijoueur';
  const text = total
    ? `AMQTrainer multi — ${head}
${grid} ${correct}/${total}
Viens me défier !`
    : `AMQTrainer multi — ${head} · viens me défier !`;
  const url = location.origin;
  const btn = document.getElementById('mp-share');
  try {
    if (navigator.share) { await navigator.share({ title: 'AMQTrainer', text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    if (btn) { const old = btn.innerHTML; btn.innerHTML = '<i class="fas fa-check"></i> Copié !'; setTimeout(() => (btn.innerHTML = old), 1800); }
  } catch { /* annulé */ }
}

// ── Défier un joueur depuis son profil : crée une salle privée puis lui
// envoie l'invitation dès que le salon existe (snapshot mp:room reçu). ──
let mpPendingInvite = null;
function mpChallenge(userId) {
  mpLeft = false; mpEngaged = true;
  mpPendingInvite = userId;
  showView('mp');
  const sock = connectMp();
  if (!sock) return;
  const create = () => sock.emit('mp:create', mpSettingsPayload());
  if (sock.connected) create(); else sock.once('connect', create);
}

// Récap des manches sur l'écran de fin (mêmes lignes que l'historique de
// session solo — icône ✓/✗/⏭, titre au format habituel, like direct).
function renderMpHistory() {
  const box = document.getElementById('mp-history');
  const list = document.getElementById('mp-history-list');
  if (!box || !list) return;
  box.classList.toggle('hidden', !mpRoundHistory.length);
  const count = document.getElementById('mp-history-count');
  if (count) count.textContent = String(mpRoundHistory.length);
  list.innerHTML = mpRoundHistory.map((h, i) => {
    const mark = h.correct === true
      ? '<i class="fas fa-circle-check sh-ok" title="Trouvé"></i>'
      : h.correct === false
      ? '<i class="fas fa-circle-xmark sh-ko" title="Raté"></i>'
      : '<i class="fas fa-forward sh-reveal" title="Passé au vote / non joué"></i>';
    const like = h.songId && currentUser && !currentUser.isGuest
      ? `<button class="like-reveal sh-like" data-mp-like="${i}" title="Ajouter à ma playlist" aria-label="Ajouter à ma playlist"><i class="far fa-heart"></i></button>`
      : '';
    return `<li class="session-history-item">
      ${mark}
      <span class="sh-body"><b>${escapeHtml(h.label)}</b><small>${escapeHtml(h.theme)}${h.theme ? ' · ' : ''}${escapeHtml(h.song)}${h.artist ? ' — ' + escapeHtml(h.artist) : ''}</small></span>
      ${like}
    </li>`;
  }).join('');
  box.open = mpRoundHistory.length <= 12; // déplié d'office sur une partie courte
}

// Le chat de salle suit le joueur du lobby à la partie puis à l'écran de fin :
// on déplace le MÊME nœud DOM (#mp-chat-section) — l'historique et le champ de
// saisie sont conservés tels quels. Côté serveur, les messages envoyés pendant
// une manche sont retenus pour ceux qui n'ont pas encore répondu (anti-spoil).
function relocateMpChat(panel) {
  const section = document.getElementById('mp-chat-section');
  if (!section) return;
  const hostId = panel === 'game' ? 'mp-game-chat-host' : panel === 'over' ? 'mp-over-chat-host' : 'mp-room-chat-host';
  const host = document.getElementById(hostId);
  if (host && section.parentElement !== host) host.appendChild(section);
}

function openMultiplayer() {
  mpLeft = false; // entrée délibérée dans la vue
  mpSpectating = false;
  showView('mp');
  connectMp();
  if (!mpRoom) { mpShow('menu'); document.getElementById('mp-menu-msg').textContent = ''; loadMpRooms(); refreshGlobalChat(); }
  // Affiche mon rang classé dans le menu
  api(`/api/profile/${currentUser.id}`).then((d) => {
    const el = document.getElementById('mp-myrank');
    if (d.ranked && d.ranked.games) {
      el.innerHTML = `Ton rang : ${(typeof tierBadge === 'function' ? tierBadge(d.ranked.tier) : '')} <span class="mmr-value">${d.ranked.mmr}</span> <span class="mmr-unit">MMR</span>`;
      el.classList.remove('hidden');
    } else {
      el.innerHTML = 'Pas encore classé — joue une partie classée !';
      el.classList.remove('hidden');
    }
  }).catch(() => {});
}

// Entrée Coop (depuis la carte « Jouer ») : écran avec « Créer un salon » ou
// « Rejoindre » par code — pour que deux amis puissent se retrouver.
function startCoop() {
  mpLeft = false; mpEngaged = true;
  showView('mp');
  connectMp();
  mpShow('coopmenu');
  const msg = document.getElementById('mp-coop-msg'); if (msg) msg.textContent = '';
  const code = document.getElementById('mp-coop-code'); if (code) code.value = '';
}

// ── Liste des parties publiques en cours + mode spectateur ──
function loadMpRooms() {
  const list = document.getElementById('mp-rooms-list');
  if (!list) return;
  const sock = connectMp();
  if (!sock) return;
  list.innerHTML = '<p class="muted">Chargement…</p>';
  const render = () => sock.emit('mp:rooms', (res) => {
    const rooms = (res && res.rooms) || [];
    if (!rooms.length) { list.innerHTML = '<p class="muted">Aucune partie publique en cours.</p>'; return; }
    const label = (m, ranked) => ranked ? '🏅 Classé' : m === 'teams' ? 'Équipes' : m === 'elim' ? 'Élimination' : 'Classique';
    list.innerHTML = rooms.map((r) => {
      const playing = r.status === 'playing';
      const state = playing
        ? `<span class="mp-room-state playing">● En jeu${r.total ? ` · manche ${r.round}/${r.total}` : ''}</span>`
        : '<span class="mp-room-state lobby">○ En attente</span>';
      const action = playing
        ? `<button class="btn-secondary mp-spectate-btn" data-spectate="${r.id}"><i class="fas fa-eye"></i> Regarder</button>`
        : '';
      const spec = r.spectators ? ` · 👁 ${r.spectators}` : '';
      return `<div class="mp-room-item">
        <div class="mp-room-item-info">
          <div class="mp-room-item-top">${label(r.mode, r.ranked)} · <b>${r.players}</b> joueur${r.players > 1 ? 's' : ''}${spec}</div>
          <div class="mp-room-item-sub">${state} <span class="muted">${escapeHtml((r.names || []).join(', '))}</span></div>
        </div>
        ${action}
      </div>`;
    }).join('');
  });
  if (sock.connected) render(); else sock.once('connect', render);
}

function spectateRoom(roomId) {
  mpLeft = false; mpEngaged = true; mpSpectating = true;
  const sock = connectMp();
  if (!sock) return;
  const go = () => sock.emit('mp:spectate', roomId, (res) => {
    if (!res || !res.ok) {
      mpSpectating = false;
      document.getElementById('mp-menu-msg').textContent = 'Partie indisponible (peut-être terminée).';
      loadMpRooms();
    }
  });
  if (sock.connected) go(); else sock.once('connect', go);
}

// Quitte le mode spectateur et revient au menu.
function stopSpectate() {
  if (mpSpectating && mpSocket) mpSocket.emit('mp:unspectate');
  mpSpectating = false; mpRoom = null;
  applySpectatorUI();
  mpStopClip();
  mpShow('menu');
  loadMpRooms();
}

// Applique l'UI lecture seule du spectateur sur l'écran de partie.
function applySpectatorUI() {
  const game = document.getElementById('mp-game');
  if (game) game.classList.toggle('spectating', mpSpectating);
  const bar = document.getElementById('mp-spectator-bar');
  if (bar) bar.classList.toggle('hidden', !mpSpectating);
}

// Libelles AniList affiches apres la revelation.
function mpStatusLabel(status) {
  const labels = {
    CURRENT: 'Watching',
    COMPLETED: 'Completed',
    PAUSED: 'Paused',
    DROPPED: 'Dropped',
    PLANNING: 'Planning',
    REPEATING: 'Rewatching',
  };
  return labels[status] || status || 'Dans la liste';
}

function mpListMetaHtml(meta, compact = false) {
  if (!meta) return '';
  const bits = [`<span class="mp-list-status">${escapeHtml(mpStatusLabel(meta.status))}</span>`];
  if (meta.score != null) bits.push(`<span class="mp-list-score">AniList ${escapeHtml(String(meta.score))}</span>`);
  if (meta.rating != null) {
    const rating = Math.max(0, Math.min(5, Number(meta.rating) || 0));
    bits.push(`<span class="mp-list-rating" aria-label="Note perso ${rating}/5">${'&#9733;'.repeat(rating)}</span>`);
  }
  return `<span class="${compact ? 'mp-list-meta compact' : 'mp-list-meta'}">${bits.join('')}</span>`;
}

// hostId est l'userId de l'hôte (le serveur clé les joueurs par userId, pas par socket)
function mpIsHost() { return !!(mpRoom && currentUser && mpRoom.hostId === currentUser.id); }

function connectMp() {
  if (mpSocket) return mpSocket;
  if (typeof io === 'undefined') {
    document.getElementById('mp-menu-msg').textContent = 'Connexion temps réel indisponible.';
    return null;
  }
  // Une connexion WebSocket unique reste attachée au même serveur derrière
  // Railway, contrairement au long-polling qui peut changer de cible.
  mpSocket = io({ path: '/socket.io', transports: ['websocket'] });
  mpSocket.on('connect', () => {
    const msg = document.getElementById('mp-menu-msg');
    if (msg && msg.textContent.includes('Connexion au serveur')) msg.textContent = 'Connecté — entrée dans la file…';
    mpSyncClock(); // ré-estime l'écart d'horloge à chaque (re)connexion
  });
  mpSocket.on('connect_error', () => {
    document.getElementById('mp-menu-msg').textContent = 'Connexion impossible (reconnecte-toi ?).';
  });
  mpSocket.on('mp:error', (d) => {
    const m = d.msg || 'Erreur';
    const menu = document.getElementById('mp-menu-msg'); if (menu) menu.textContent = m;
    const coop = document.getElementById('mp-coop-msg'); if (coop) coop.textContent = m;
  });
  mpSocket.on('mp:info', (d) => mpToast(d.msg));
  // Reset gacha déclenché par l'admin : diffusé à tous les joueurs déjà
  // connectés (sans payload personnel) — chacun relit alors sa propre
  // compensation via GET /api/gacha/reset-notice, sans avoir à se reconnecter.
  mpSocket.on('gacha:reset-notice', () => {
    if (typeof checkGachaResetNotice === 'function') checkGachaResetNotice();
  });
  // Reconnexion sans partie côté serveur (ex. redéploiement pendant une manche) :
  // si on est resté sur un écran de salle/jeu, la partie n'existe plus → on sort
  // proprement au lieu de rester figé sur une manche fantôme (« Son indisponible »).
  mpSocket.on('mp:none', () => {
    if (mpLeft || !mpEngaged || mpSpectating) return;
    const inRoomOrGame = ['room', 'game', 'over'].some((p) => {
      const el = document.getElementById('mp-' + p);
      return el && !el.classList.contains('hidden');
    });
    if (!inRoomOrGame) return;
    mpStopClip();
    mpRoom = null;
    mpEngaged = false;
    mpShow('menu');
    const msg = document.getElementById('mp-menu-msg');
    if (msg) msg.textContent = '⚠️ La partie a été interrompue par une mise à jour du serveur — désolé ! Relance une partie.';
    if (typeof loadMpRooms === 'function') loadMpRooms();
  });
  mpSocket.on('mp:invited', (d) => {
    if (typeof sfx !== 'undefined' && sfx.correct) sfx.correct(); // signal sonore : facile à rater sinon
    mpToast(`🎮 <b>${escapeHtml(d.from)}</b> t'invite à jouer !`, 'Rejoindre', () => {
      openMultiplayer();
      mpSocket.emit('mp:join', d.code);
    });
  });

  mpSocket.on('mp:room', (d) => {
    if (mpLeft) return; // on a quitté la vue : ignore les broadcasts résiduels
    mpRoom = d;
    mpEngaged = true;
    if (d.status === 'lobby') { showView('mp'); mpShow('room'); renderRoom(d); }
    // Défi lancé depuis un profil : la salle privée vient d'être créée →
    // envoyer l'invitation au joueur défié (une seule fois).
    if (mpPendingInvite && d.code && d.status === 'lobby') {
      mpSocket.emit('mp:invite', mpPendingInvite);
      mpPendingInvite = null;
    }
  });

  mpSocket.on('mp:chat', (m) => appendChat(m));
  mpSocket.on('mp:gchat', (m) => appendGchat(m));

  mpSocket.on('mp:emote', (d) => floatEmote(d));

  // Notifs d'échange en temps réel
  mpSocket.on('trade:new', (d) => {
    mpToast(`🔄 <b>${escapeHtml(d.from)}</b> te propose un échange !`, 'Voir', () => { if (typeof openTrades === 'function') openTrades(); });
    if (typeof loadTradesBadge === 'function') loadTradesBadge();
  });
  mpSocket.on('trade:accepted', (d) => {
    mpToast(`✅ <b>${escapeHtml(d.by)}</b> a accepté ton échange !`);
    if (typeof loadTradesBadge === 'function') loadTradesBadge();
  });

  mpSocket.on('mp:game:start', (d) => {
    if (mpLeft) return;
    mpEngaged = true;
    if (!d.spectator) mpRoundHistory = []; // nouveau récap (reattach en cours de partie : repart des manches restantes)
    clearInterval(mpLobbyCountdown);
    mpLobbyCountdown = null;
    showView('mp');
    mpShow('game');
    if (d.spectator) mpSpectating = true;
    applySpectatorUI();
    mpMode = d.mode || 'classic';
    mpTeamNames = d.teamNames || ['Rouge', 'Bleu'];
    mpEliminated = false;
    mpVotedSkip = false;
    mpCoop = !!d.coop;
    mpTeamLives = d.teamLives || 0;
    const myTeam = (d.players.find((p) => p.name === currentUser.displayName) || {}).team;
    document.getElementById('mp-total').textContent = d.totalRounds;
    document.getElementById('mp-round').textContent = '—';
    document.getElementById('mp-round-word').textContent = mpCoop ? 'Étage' : 'Manche';
    document.getElementById('mp-total-sep').classList.toggle('hidden', mpCoop || d.totalRounds == null);
    updateCoopLives();
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-scores').innerHTML = '';
    document.getElementById('mp-progress').textContent = '';
    const modeTxt = mpCoop ? 'Coop · Tour en équipe' : mpMode === 'teams' ? `Équipes — tu es ${mpTeamNames[myTeam] || '?'}` : mpMode === 'elim' ? `Élimination — ${d.elimLives} vies` : '';
    document.getElementById('mp-feedback').textContent = (d.ranked ? '🏅 Classé — ' : '') + (modeTxt ? modeTxt + ' — ' : '') + `c'est parti ! ${d.players.length} joueur(s) 🎮`;
    refreshMpEmotes();
  });

  mpSocket.on('mp:round:start', (d) => {
    if (mpLeft) return;
    mpActiveRound = d.round;
    clearTimeout(mpPreloadTimer);
    document.getElementById('mp-round').textContent = d.round;
    if (d.total != null) document.getElementById('mp-total').textContent = d.total;
    if (d.coop) { mpCoop = true; if (typeof d.teamLives === 'number') mpTeamLives = d.teamLives; updateCoopLives(); }
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-progress').textContent = '';
    const input = document.getElementById('mp-input');
    const lock = !!d.alreadyAnswered || !!d.alreadyPassed || mpEliminated || mpSpectating;
    input.value = '';
    if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('mp-input');
    mpLockAnswer(lock);
    if (!lock) input.focus();
    document.getElementById('mp-feedback').textContent = mpSpectating ? '👁 Tu regardes la partie'
      : mpEliminated ? '💀 Éliminé — tu es spectateur'
      : d.alreadyAnswered ? '✅ Déjà répondu' : d.alreadyPassed ? '⏭️ Tu as passé' : (d.resumed ? '↩️ Reconnecté' : '');
    mpVotedSkip = !!d.alreadyVotedSkip; // false sur une manche neuve, restauré si reconnexion
    mpVoteSkipVotes = d.voteSkip?.votes ?? 0;
    mpVoteSkipNeeded = d.voteSkip?.needed ?? 1;
    mpCoopFreeSkip = d.coopFreeSkip !== false; // coop : le passe est-il encore gratuit ?
    renderMpVoteSkip();
    mpStartClip(d.clipUrl, d.startAt, d.duration);
  });

  mpSocket.on('mp:voteskip:update', (d) => {
    mpVoteSkipVotes = d.votes;
    mpVoteSkipNeeded = d.needed;
    renderMpVoteSkip();
  });

  mpSocket.on('mp:round:preload', (d) => {
    clearTimeout(mpPreloadTimer);
    mpPreloadTimer = setTimeout(() => {
      if (mpLeft || d.round <= mpActiveRound) return;
      // Préchauffe le prochain extrait dans un élément CACHÉ pour ne PAS interrompre
      // la vidéo/le son de la réponse en cours (révélés jusqu'à la manche suivante).
      let pre = document.getElementById('mp-video-preload');
      if (!pre) {
        pre = document.createElement('video');
        pre.id = 'mp-video-preload';
        pre.muted = true; pre.preload = 'auto'; pre.playsInline = true;
        pre.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
        document.body.appendChild(pre);
      }
      pre.src = d.clipUrl;
      pre.load();
      mpPreparedUrl = d.clipUrl; // le cache HTTP est réchauffé → chargement rapide à la manche suivante
    }, 900);
  });

  mpSocket.on('mp:guess:ack', (d) => {
    const fb = document.getElementById('mp-feedback');
    if (d.correct) {
      fb.textContent = '✅ Bonne réponse !';
      mpLockAnswer(true);
    } else {
      fb.textContent = '❌ Réponse enregistrée — en attente des autres joueurs…';
      mpLockAnswer(true);
    }
  });

  mpSocket.on('mp:skip:ack', () => {
    document.getElementById('mp-feedback').textContent = '⏭️ Tu as passé cette manche';
    mpLockAnswer(true);
  });

  mpSocket.on('mp:round:progress', (d) => {
    const passed = d.passed ? ` · ${d.passed} passé${d.passed > 1 ? 's' : ''}` : '';
    document.getElementById('mp-progress').textContent = `${d.answered + (d.passed || 0)}/${d.total} ont joué${passed}`;
  });

  mpSocket.on('mp:round:result', (d) => {
    clearTimeout(mpTimer);
    document.getElementById('mp-overlay').classList.add('hidden'); // révèle la vidéo
    const res = document.getElementById('mp-result');
    res.classList.remove('hidden');
    const titleDisplay = typeof formatAnimeDisplay === 'function'
      ? formatAnimeDisplay({ title: d.answer.animeTitle, englishTitle: d.answer.englishTitle, seasonNumber: d.answer.seasonNumber || 0 })
      : { primary: d.answer.englishTitle || d.answer.animeTitle, secondary: d.answer.englishTitle ? d.answer.animeTitle : null };
    const owners = d.answer.owners || [];
    const ownersHtml = owners.length
      ? `<div class="mp-answer-owners"><span class="mp-answer-owners-label">Dans la liste de</span>${owners.map((owner) => `<span class="mp-owner-chip">${escapeHtml(owner.name)}${mpListMetaHtml(owner, true)}</span>`).join('')}</div>`
      : '';
    const englishTitle = titleDisplay.secondary
      ? ` <span class="mp-answer-english">(${escapeHtml(titleDisplay.secondary)})</span>`
      : '';
    const skippedBanner = d.skipped ? '<div class="mp-coop-banner">⏭️ Extrait passé au vote</div>' : '';
    const addedBy = d.answer.addedBy
      ? ` <span class="hint">· Ajouté au catalogue par <button type="button" class="btn-link" data-userid="${d.answer.addedBy.id}">${escapeHtml(d.answer.addedBy.displayName)}</button></span>`
      : '';
    // Difficulté réelle : % de joueurs (tous modes) qui trouvent cette musique.
    const community = d.answer.community && d.answer.community.rate != null
      ? `<span class="hint mp-community" title="${d.answer.community.sample} réponses enregistrées">· 🎯 Trouvée par ${d.answer.community.rate}% des joueurs</span>`
      : '';
    res.innerHTML = `${skippedBanner}<div class="mp-answer">Réponse : <strong>${escapeHtml(d.answer.animeTitle)}</strong>${englishTitle}
      <button class="like-reveal hidden" id="mp-like" title="Ajouter à ma playlist" aria-label="Ajouter à ma playlist"><i class="far fa-heart"></i></button>
      <button class="like-reveal hidden" id="mp-report" title="Signaler ce son" aria-label="Signaler ce son"><i class="fas fa-flag"></i></button>
      <span class="hint">${escapeHtml(d.answer.title || '')}${d.answer.artist ? ' — ' + escapeHtml(d.answer.artist) : ''}</span>${addedBy}${community}</div>`;
    // ❤ : la réponse est révélée → on peut ajouter la musique à sa playlist (8 s d'affichage).
    const answerEl = res.querySelector('.mp-answer');
    const answerStrong = answerEl?.querySelector('strong');
    if (answerStrong) {
      const titleNode = document.createElement('span');
      titleNode.className = 'mp-answer-title';
      titleNode.innerHTML = `<strong>${escapeHtml(titleDisplay.primary)}</strong>${titleDisplay.secondary ? `<small>${escapeHtml(titleDisplay.secondary)}</small>` : ''}`;
      answerStrong.replaceWith(titleNode);
      answerEl?.querySelector('.mp-answer-english')?.remove();
      if (d.answer.anilistId) {
        titleNode.insertAdjacentHTML('beforeend',
          `<a class="mp-anilist-link" href="https://anilist.co/anime/${d.answer.anilistId}" target="_blank" rel="noopener" title="Voir sur AniList"><i class="fas fa-up-right-from-square"></i></a>`);
      }
    }
    if (ownersHtml && answerEl) answerEl.insertAdjacentHTML('beforeend', ownersHtml);
    if (typeof setupQuickLike === 'function') setupQuickLike(document.getElementById('mp-like'), d.answer.songId);
    if (typeof setupSongReport === 'function') setupSongReport(document.getElementById('mp-report'), d.answer.songId, 'mp');
    if (d.coop) {
      mpCoop = true;
      if (typeof d.teamLives === 'number') mpTeamLives = d.teamLives;
      updateCoopLives();
      const banner = d.floorCleared
        ? `<div class="mp-coop-banner ok">🏯 Étage ${d.round} franchi !</div>`
        : `<div class="mp-coop-banner ko">💥 Personne n'a trouvé — −1 vie (❤ × ${Math.max(0, mpTeamLives)})</div>`;
      res.insertAdjacentHTML('beforeend', banner);
      d.floorCleared ? sfx.correct() : sfx.wrong();
    }
    renderMpScores(d.results, true);
    if (d.teams) {
      document.getElementById('mp-result').insertAdjacentHTML('beforeend',
        `<div class="mp-teams">${d.teams.map((t, i) => `<span class="mp-team t${i}">${escapeHtml(mpTeamNames[i])} : <b>${t}</b></span>`).join('')}</div>`);
    }
    const me = d.results.find((p) => p.name === currentUser.displayName);
    // Récap de fin de partie : mêmes données que la révélation, rien à redemander.
    mpRoundHistory.push({
      songId: d.answer.songId || null,
      label: typeof formatAnimeLabel === 'function'
        ? formatAnimeLabel({ title: d.answer.animeTitle, englishTitle: d.answer.englishTitle, seasonNumber: d.answer.seasonNumber || 0 })
        : d.answer.animeTitle,
      song: d.answer.title || '',
      artist: d.answer.artist || '',
      theme: `${d.answer.type || ''}${d.answer.number || ''}`,
      correct: d.skipped ? null : (me ? !!me.correct : null),
    });
    if (me && !d.coop) { // en coop, le son est joué par la bannière d'étage
      mpEliminated = !!me.eliminated;
      me.correct ? sfx.correct() : sfx.wrong();
      if (mpEliminated) { sfx.lose(); document.getElementById('mp-feedback').textContent = '💀 Tu es éliminé !'; }
    }
    mpLockAnswer(true);
  });

  mpSocket.on('mp:game:over', (d) => {
    if (mpLeft) return;
    mpStopClip();
    showView('mp');
    mpShow('over');

    // ── Coop : Tour en équipe — étage atteint + contributions ──
    if (d.coop) {
      const floor = d.floor || 0;
      const iRecord = (d.ranking || []).some((p) => p.isRecord && (p.name === currentUser.displayName));
      if (floor > 0) { sfx.win(); burstConfetti(floor >= 10 ? 60 : 30); } else { sfx.lose(); }
      document.querySelector('#mp-over h3').textContent = `🏯 Tour en équipe — Étage ${floor}`;
      const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
      const cleared = d.cleared != null ? d.cleared : floor;
      const weeklyNote = d.weeklyEligible === false
        ? '<p class="hint">ⓘ Partie sur les listes des joueurs — ne compte pas pour le classement hebdo (catalogue global uniquement).</p>'
        : '';
      document.getElementById('mp-ranking').innerHTML =
        `<p class="mp-coop-recap">Votre équipe a atteint l'étage <b>${floor}</b> (${cleared} étage${cleared > 1 ? 's' : ''} franchi${cleared > 1 ? 's' : ''}) !${iRecord ? ' <span class="mp-record">Nouveau record perso</span>' : ''}</p>${weeklyNote}`
        + (d.ranking || []).map((p, i) => {
          const isMe = p.name === currentUser.displayName;
          const av = otherAvatar({ avatarUrl: p.avatarUrl, frame: p.frame, displayName: p.name }, 'avatar-xs');
          const rec = p.isRecord ? ' <span class="mp-record">record</span>' : '';
          const reward = p.tokenReward ? ` <span class="mp-reward">+${p.tokenReward} 🪙</span>` : '';
          return `<li class="lb-row${isMe ? ' me' : ''}">
            <span class="lb-rank">${medal(i + 1)}</span>${av}
            <span class="lb-name">${escapeHtml(p.name)}${rec}${reward}</span>
            <span class="lb-value">${p.correct || 0} bonne${(p.correct || 0) > 1 ? 's' : ''}</span>
          </li>`;
        }).join('');
      const mine = (d.ranking || []).find((p) => p.name === currentUser.displayName);
      if (mine && mine.tokenReward && typeof syncTokenBalance === 'function') syncTokenBalance();
      mpLastOver = { coop: true, floor: d.floor || 0 };
      renderMpHistory();
      return;
    }

    const iWon = d.ranking[0] && d.ranking[0].name === currentUser.displayName;
    if (!mpSpectating) { if (iWon) { sfx.win(); burstConfetti(40); } else { sfx.lose(); } }
    let title = d.ranked ? '🏅 Classement final (classé)' : '🏆 Classement final';
    let teamsHtml = '';
    if (d.mode === 'teams' && d.teams) {
      const win = d.teams[0].score === d.teams[1].score ? 'Égalité' : (d.teams[0].score > d.teams[1].score ? d.teams[0].name : d.teams[1].name);
      title = `🏆 Victoire : ${win}`;
      teamsHtml = `<div class="mp-teams big">${d.teams.map((t, i) => `<span class="mp-team t${i}">${escapeHtml(t.name)} : <b>${t.score}</b></span>`).join('')}</div>`;
    } else if (d.mode === 'elim') {
      const survivor = d.ranking.find((p) => !p.eliminated);
      title = survivor ? `🏆 Survivant : ${escapeHtml(survivor.name)}` : '🏁 Tous éliminés !';
    }
    document.querySelector('#mp-over h3').textContent = title;
    const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
    document.getElementById('mp-ranking').innerHTML = teamsHtml + d.ranking
      .map((p, i) => {
        const delta = p.mmrDelta != null
          ? ` <span class="mp-mmr ${p.mmrDelta >= 0 ? 'gain' : 'spend'}">${p.mmrDelta >= 0 ? '+' : ''}${p.mmrDelta} MMR</span>`
          : '';
        const reward = p.tokenReward ? ` <span class="mp-reward">+${p.tokenReward} 🪙</span>` : '';
        const team = p.team != null ? ` <span class="mp-teamdot t${p.team}"></span>` : '';
        const tag = d.mode === 'elim' ? (p.eliminated ? ' 💀' : ' ❤️') : '';
        const isMe = p.userId ? p.userId === currentUser.id : p.name === currentUser.displayName;
        const av = otherAvatar({ avatarUrl: p.avatarUrl, frame: p.frame, displayName: p.name }, 'avatar-xs');
        return `<li class="lb-row${isMe ? ' me' : ''}" data-final-index="${i}">
          <span class="lb-rank">${medal(i + 1)}</span>
          ${av}
          <span class="lb-name">${escapeHtml(p.name)}${team}${tag}${delta}${reward}</span>
          <span class="lb-value">${p.score} pts</span>
        </li>`;
      })
      .join('')
      + (d.rewardsPending ? '<p class="muted" id="mp-finalizing">Calcul des récompenses…</p>' : '');

    // Le serveur a déjà crédité le gain : relire le solde autoritaire évite
    // les doubles ajouts visuels et les corrections au prochain écran.
    const mine = d.ranking.find((p) => (p.userId ? p.userId === currentUser.id : p.name === currentUser.displayName));
    if (mine && mine.tokenReward && typeof syncTokenBalance === 'function') {
      syncTokenBalance();
    }
    const myIndex = d.ranking.findIndex((p) => (p.userId ? p.userId === currentUser.id : p.name === currentUser.displayName));
    mpLastOver = { placement: myIndex >= 0 ? myIndex + 1 : null, players: d.ranking.length, ranked: !!d.ranked };
    renderMpHistory();
  });

  // Le classement est déjà visible ; la BDD complète ensuite les gains et le MMR.
  mpSocket.on('mp:game:finalized', (d) => {
    document.getElementById('mp-finalizing')?.remove();
    (d.ranking || []).forEach((p, i) => {
      const name = document.querySelector(`#mp-ranking [data-final-index="${i}"] .lb-name`);
      if (!name) return;
      if (p.mmrDelta != null) {
        name.insertAdjacentHTML('beforeend',
          ` <span class="mp-mmr ${p.mmrDelta >= 0 ? 'gain' : 'spend'}">${p.mmrDelta >= 0 ? '+' : ''}${p.mmrDelta} MMR</span>`);
      }
      if (p.tokenReward) {
        name.insertAdjacentHTML('beforeend', ` <span class="mp-reward">+${p.tokenReward} 🪙</span>`);
      }
    });
    const mine = (d.ranking || []).find((p) => p.userId === currentUser.id);
    if (mine?.tokenReward && typeof syncTokenBalance === 'function') syncTokenBalance();
  });
  return mpSocket;
}

function joinMatchmaking(event, searchingText, payload) {
  mpLeft = false;
  mpEngaged = true;
  const msg = document.getElementById('mp-menu-msg');
  msg.textContent = searchingText;
  const socket = connectMp();
  if (!socket) return;

  const send = () => {
    const cb = (err, ack) => {
      if (err || !ack?.ok) {
        msg.textContent = 'La file ne répond pas. Réessaie dans quelques secondes.';
        mpEngaged = false;
        return;
      }
      msg.textContent = ack.players > 1
        ? `${ack.players} joueurs trouvés — préparation de la partie…`
        : 'File rejointe — en attente d’un autre joueur…';
    };
    // Avec payload (ex. nombre de manches) ou sans (classé = format figé).
    if (payload) socket.timeout(10000).emit(event, payload, cb);
    else socket.timeout(10000).emit(event, cb);
  };
  if (socket.connected) send();
  else {
    msg.textContent = 'Connexion au serveur…';
    socket.once('connect', send);
  }
}

// ── Salon (lobby) ──
function renderRoom(d) {
  const isHost = mpIsHost();
  const together = d.gamesPlayed ? ` · ${d.gamesPlayed} partie${d.gamesPlayed > 1 ? 's' : ''} jouée${d.gamesPlayed > 1 ? 's' : ''} ensemble` : '';
  document.getElementById('mp-room-code').innerHTML = (d.code
    ? `Salle privée · <b>${d.code}</b>`
    : '⚡ Partie rapide') + `<span class="hint">${together}</span>`;
  // Inviter des amis + lien partageable : seulement en salle privée.
  document.getElementById('mp-invite-friends')?.classList.toggle('hidden', !d.code);
  document.getElementById('mp-copy-link')?.classList.toggle('hidden', !d.code);
  if (!d.code) document.getElementById('mp-invite-list')?.classList.add('hidden');
  document.getElementById('mp-pcount').textContent = d.players.length;
  document.getElementById('mp-room-players').innerHTML = d.players
    .map((p) => {
      // Son propre chip n'ouvre rien (redondant avec le menu profil) — pas
      // de data-userid dessus, donc pas de curseur pointer ni de clic.
      const clickable = p.userId && p.userId !== currentUser?.id;
      return `<span class="mp-chip${p.isHost ? ' host' : ''}"${clickable ? ` data-userid="${p.userId}"` : ''}>${otherAvatar({ avatarUrl: p.avatarUrl, frame: p.frame, displayName: p.name }, 'avatar-xs')}${p.isHost ? '👑 ' : ''}${escapeHtml(p.name)}</span>`;
    })
    .join('');

  // Classé : réglages figés côté serveur → on masque le formulaire (sinon il
  // semble modifiable alors qu'il est ignoré) et on affiche le format fixe.
  const ranked = !!d.ranked;
  document.getElementById('mp-settings').classList.toggle('hidden', ranked);
  const note = document.getElementById('mp-ranked-note');
  note.classList.toggle('hidden', !ranked);
  if (ranked) {
    note.innerHTML = '🏅 <b>Partie classée</b> — format fixe : 10 manches · 25 s · Openings + Endings. '
      + 'Réglages non modifiables. Ton <b>MMR</b> évolue selon ton classement final.';
  }
  const isCoop = !ranked && (d.settings.mode || 'classic') === 'coop';
  if (!ranked) {
    document.getElementById('mp-set-rounds').value = String(d.settings.rounds);
    document.getElementById('mp-set-speed').value = String(d.settings.roundMs);
    document.getElementById('mp-set-mode').value = d.settings.mode || 'classic';
    document.getElementById('mp-set-theme').value = d.settings.themeType || 'all';
    document.getElementById('mp-set-source').value = d.settings.songSource || (d.isPublic ? 'lists' : 'global');
    document.getElementById('mp-set-difficulty').value = d.settings.difficulty || 'all';
    document.getElementById('mp-set-list-scope').value = d.settings.listScope || 'all';
    document.getElementById('mp-set-list-scope').disabled = !isHost;
    // La portée des listes n'a de sens que si le pool vient des listes.
    document.getElementById('mp-field-list-scope').classList.toggle('hidden', isCoop || (d.settings.songSource || (d.isPublic ? 'lists' : 'global')) !== 'lists');
    // Les selects d'années sont remplis à l'init (fillYearSelect, cf. main.js).
    document.getElementById('mp-set-year-min').value = String(d.settings.yearMin || 0);
    document.getElementById('mp-set-year-max').value = String(d.settings.yearMax || 0);
    // Chips de genres : état venu du serveur, cliquables seulement pour l'hôte.
    if (typeof renderGenreChips === 'function') {
      renderGenreChips('mp-set-genres', d.settings.genres || [], { disabled: !isHost });
    }
    document.getElementById('mp-set-mode').disabled = !isHost;
    document.getElementById('mp-set-theme').disabled = !isHost;
    document.getElementById('mp-set-source').disabled = !isHost;
    document.getElementById('mp-set-difficulty').disabled = !isHost;
    document.getElementById('mp-set-year-min').disabled = !isHost;
    document.getElementById('mp-set-year-max').disabled = !isHost;
    // Coop : mode figé (lancé via « Jouer ») + étages infinis / temps auto +
    // catalogue global et openings IMPOSÉS par le serveur → on masque tous les
    // champs de réglage (l'encart coop explique tout).
    document.getElementById('mp-field-mode').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-rounds').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-speed').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-theme').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-source').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-difficulty').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-years').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-genres')?.classList.toggle('hidden', isCoop);
  }
  // Presets : mêmes conditions que les réglages qu'ils remplissent (masqués en
  // classé/coop puisque figés, verrouillés pour les non-hôtes).
  document.getElementById('mp-presets')?.classList.toggle('hidden', ranked || isCoop);
  const mpPresetSelect = document.getElementById('mp-preset-select');
  if (mpPresetSelect) mpPresetSelect.disabled = !isHost;
  const mpPresetSave = document.getElementById('mp-preset-save');
  if (mpPresetSave) mpPresetSave.disabled = !isHost;
  const mpPresetDelete = document.getElementById('mp-preset-delete');
  if (mpPresetDelete) mpPresetDelete.disabled = !isHost;
  // Encart explicatif du mode Coop (Tour en équipe)
  const coopInfo = document.getElementById('mp-coop-info');
  coopInfo.classList.toggle('hidden', !isCoop);
  if (isCoop) {
    coopInfo.innerHTML = `
      <div class="mp-coop-info-head"><i class="fas fa-chess-rook"></i> Tour en équipe</div>
      <ul>
        <li><i class="fas fa-heart"></i> <b>3 vies partagées</b> pour toute l'équipe</li>
        <li><i class="fas fa-stairs"></i> Étages <b>infinis</b> — le temps se réduit en montant</li>
        <li><i class="fas fa-users"></i> Étage validé si <b>au moins un joueur</b> trouve, sinon −1 vie</li>
        <li><i class="fas fa-trophy"></i> Score = l'<b>étage atteint</b> ensemble (record perso au profil)</li>
        <li><i class="fas fa-globe"></i> <b>Catalogue global · Openings uniquement</b> — classement hebdo : 800/400 🪙 pour le top 2</li>
      </ul>`;
  }

  const startBtn = document.getElementById('mp-start');
  const status = document.getElementById('mp-room-status');
  clearInterval(mpLobbyCountdown);
  mpLobbyCountdown = null;
  if (d.isPublic) {
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = d.players.length < 2;
    if (d.countdownEndsAt) {
      const updateCountdown = () => {
        const sec = Math.max(0, Math.ceil((d.countdownEndsAt - mpNow()) / 1000));
        status.textContent = sec > 0 ? `Lancement automatique dans ${sec}s…` : 'Lancement de la partie…';
      };
      updateCountdown();
      mpLobbyCountdown = setInterval(updateCountdown, 250);
    } else {
      status.textContent = `En attente de joueurs (min 2)…`;
    }
  } else {
    startBtn.disabled = false;
    status.textContent = isHost ? 'Lance la partie quand tout le monde est prêt.' : "En attente que l'hôte lance la partie…";
    startBtn.classList.toggle('hidden', !isHost);
  }
  renderChat(d.chat || []);
}

function renderChat(list) {
  const box = document.getElementById('mp-chat');
  box.innerHTML = list.map(chatLine).join('');
  box.scrollTop = box.scrollHeight;
}
function chatLine(m) {
  if (m.system) return `<div class="mp-chat-sys">— ${escapeHtml(m.text)} —</div>`;
  return `<div class="mp-chat-msg"><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`;
}
function appendChat(m) {
  const box = document.getElementById('mp-chat');
  box.insertAdjacentHTML('beforeend', chatLine(m));
  box.scrollTop = box.scrollHeight;
}

// ── Chat global (menu multi) ──
function appendGchat(m) {
  const box = document.getElementById('mp-gchat');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', chatLine(m));
  box.scrollTop = box.scrollHeight;
}
// Recharge l'historique (50 derniers) + le compteur de connectés.
function refreshGlobalChat() {
  const sock = connectMp();
  if (!sock) return;
  const load = () => sock.timeout(5000).emit('mp:gchat:history', (err, d) => {
    if (err || !d) return;
    const box = document.getElementById('mp-gchat');
    if (box) { box.innerHTML = (d.messages || []).map(chatLine).join(''); box.scrollTop = box.scrollHeight; }
    const online = document.getElementById('mp-gchat-online');
    if (online) online.textContent = d.online ? `· ${d.online} en ligne` : '';
  });
  if (sock.connected) load(); else sock.once('connect', load);
}
function sendGlobalChat() {
  const input = document.getElementById('mp-gchat-text');
  const t = (input?.value || '').trim();
  if (!t || !mpSocket) return;
  mpSocket.emit('mp:gchat', t);
  input.value = '';
  input.focus();
}

// ── Emotes ──
function renderEmotesBar() {
  document.getElementById('mp-emotes').innerHTML = mpEmotes
    .map((e) => `<button class="mp-emote-btn" data-emote="${escapeHtml(e.id)}" title="${escapeHtml(e.name || '')}">
      ${e.imageUrl
        ? `<img src="${escapeHtml(e.imageUrl)}" alt="${escapeHtml(e.name || e.symbol)}" data-fallback-symbol="${escapeHtml(e.symbol)}">`
        : escapeHtml(e.symbol)}
    </button>`)
    .join('');
}

function refreshMpEmotes() {
  if (!mpSocket) {
    mpEmotes = mpFreeEmoteItems();
    renderEmotesBar();
    return;
  }
  mpSocket.timeout(5000).emit('mp:emotes:get', (err, data) => {
    mpEmotes = !err && Array.isArray(data?.emotes) ? data.emotes : mpFreeEmoteItems();
    renderEmotesBar();
  });
}
function floatEmote(data) {
  const layer = document.getElementById('mp-reactions');
  const el = document.createElement('div');
  el.className = 'mp-reaction';
  if (data.imageUrl) {
    const img = document.createElement('img');
    img.src = data.imageUrl;
    img.alt = data.label || data.emote;
    img.addEventListener('error', () => { el.textContent = data.emote; }, { once: true });
    el.appendChild(img);
  } else {
    el.textContent = data.emote;
  }
  el.style.left = (10 + Math.random() * 80) + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ── Scores ──
function renderMpScores(results, withPoints) {
  document.getElementById('mp-scores').innerHTML = results
    .map((p) => {
      const team = p.team != null ? ` <span class="mp-teamdot t${p.team}"></span>` : '';
      const lives = `<span class="mp-lives">${mpMode === 'elim' ? (p.eliminated ? '💀' : ('❤️'.repeat(Math.max(0, p.lives || 0)) || '—')) : ''}</span>`;
      const av = otherAvatar({ avatarUrl: p.avatarUrl, frame: p.frame, displayName: p.name }, 'avatar-xs');
      // Réponse saisie par le joueur (révélée à tous une fois la manche validée)
      let guess = '';
      if (withPoints) {
        if (p.guess) guess = `<span class="mp-guess ${p.correct ? 'ok' : 'ko'}"><i class="fas ${p.correct ? 'fa-check' : 'fa-xmark'}"></i> ${escapeHtml(p.guess)}</span>`;
        else if (p.passed) guess = '<span class="mp-guess skip">a passé</span>';
        else guess = '<span class="mp-guess none">pas de réponse</span>';
      }
      // 👁 : ce joueur a l'anime dans sa liste AniList (envoyé seulement à la révélation)
      const listMeta = p.seenAnime
        ? `<span class="mp-seen-detail">Liste${mpListMetaHtml(p.listMeta, true)}</span>`
        : '';
      const seen = p.seenAnime
        ? ' <span class="mp-seen" title="A cet anime dans sa liste AniList">👁</span>'
        : '';
      return `<div class="mp-score-row${p.correct ? ' ok' : ''}${p.eliminated ? ' elim' : ''}">
        <span class="mp-name"><span class="mp-name-top">${av}${escapeHtml(p.name)}${seen}${team}</span>${guess}${listMeta}</span>
        ${lives}
        ${withPoints && p.points ? `<span class="mp-pts">+${p.points}</span>` : '<span></span>'}
        <span class="mp-total">${p.score}</span>
      </div>`;
    })
    .join('');
}

// ── Clip synchronisé ──
function mpUrlWithRetry(url, attempt) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}retry=${attempt}`;
}

function mpWaitUntil(timestamp) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timestamp - mpNow())));
}

function mpWaitForCanPlay(media, timeoutMs = 9000) {
  if (media.readyState >= 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      media.removeEventListener('canplay', onReady);
      media.removeEventListener('error', onError);
    };
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('media')); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    media.addEventListener('canplay', onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
  });
}

async function mpStartClip(url, startAt, duration) {
  const v = mpVideo();
  const sequence = ++mpPlaybackSequence;
  v.disablePictureInPicture = true;
  // Une fenêtre PiP ouverte pendant le résultat ne doit jamais continuer sur
  // la manche suivante et dévoiler l'anime avant la réponse.
  if (document.pictureInPictureElement === v && document.exitPictureInPicture) {
    try { await document.exitPictureInPicture(); } catch {}
  }
  const alreadyPrepared = mpPreparedUrl === url && v.getAttribute('src') === url;
  if (!alreadyPrepared) {
    v.src = url;
    v.preload = 'auto';
    v.load();
  }
  mpPreparedUrl = null;
  v.volume = (typeof getVolume === 'function' ? getVolume() : 0.8);
  document.getElementById('mp-overlay').classList.remove('hidden'); // audio seul
  const feedback = document.getElementById('mp-feedback');
  if (!mpEliminated) feedback.textContent = 'Chargement du son…';

  for (let attempt = 0; attempt < 3 && sequence === mpPlaybackSequence; attempt++) {
    try {
      if (attempt > 0) {
        feedback.textContent = `Chargement du son… tentative ${attempt + 1}/3`;
        v.src = mpUrlWithRetry(url, attempt);
        v.load();
      }
      await Promise.all([mpWaitUntil(startAt), mpWaitForCanPlay(v)]);
      if (sequence !== mpPlaybackSequence) return;
      await v.play();
      if (sequence !== mpPlaybackSequence) return;
      const remaining = Math.max(1000, startAt + duration - mpNow());
      mpRunTimer(remaining);
      if (!mpEliminated && feedback.textContent.startsWith('Chargement du son')) feedback.textContent = '';
      return;
    } catch {}
  }
  if (sequence === mpPlaybackSequence) {
    feedback.textContent = '⚠️ Son indisponible — tu peux passer cette manche.';
  }
}
function mpRunTimer(duration) {
  const fill = document.getElementById('mp-timefill');
  fill.style.transition = 'none'; fill.style.width = '100%'; fill.classList.remove('low');
  void fill.offsetWidth;
  fill.style.transition = `width ${duration}ms linear`; fill.style.width = '0%';
  clearTimeout(mpTimer);
  mpTimer = setTimeout(() => fill.classList.add('low'), Math.max(0, duration - 5000));
}
function mpStopClip() {
  mpPlaybackSequence++;
  clearTimeout(mpTimer);
  clearTimeout(mpPreloadTimer);
  mpPreparedUrl = null;
  const v = mpVideo();
  if (v) v.pause();
}
function stopMpMedia() {
  mpStopClip();
  const v = mpVideo();
  if (v) { v.removeAttribute('src'); v.load(); }
}

// Verrouille/déverrouille la saisie de réponse (input + valider + passer)
function mpLockAnswer(locked) {
  document.getElementById('mp-input').disabled = locked;
  document.getElementById('mp-submit').disabled = locked;
  document.getElementById('mp-skip').disabled = locked;
  if (locked && typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('mp-input');
}

function mpSubmitGuess() {
  const input = document.getElementById('mp-input');
  const text = input.value.trim();
  if (!text || input.disabled || !mpSocket) return;
  if (typeof closeAnimeAutocomplete === 'function') closeAnimeAutocomplete('mp-input');
  mpSocket.emit('mp:guess', text);
}

function mpSkip() {
  if (document.getElementById('mp-skip').disabled || !mpSocket) return;
  mpSocket.emit('mp:skip');
}

// Vote pour passer l'extrait en cours (son cassé, mauvais rip…) — indépendant de
// « Passer » : reste disponible même après avoir déjà répondu/passé, tant que la
// manche est en cours. Bascule (toggle) : re-cliquer retire son vote.
function renderMpVoteSkip() {
  const btn = document.getElementById('mp-voteskip');
  if (!btn) return;
  btn.disabled = mpEliminated || mpSpectating;
  btn.classList.toggle('active', mpVotedSkip);
  const label = document.getElementById('mp-voteskip-label');
  if (label) {
    // Coop : un seul passe gratuit par partie, les suivants coûtent une vie
    // commune (cf. endRound serveur) — le bouton annonce la couleur.
    const coopCost = mpMode === 'coop' ? (mpCoopFreeSkip ? ' · gratuit ×1' : ' · −1 vie') : '';
    label.textContent = `Voter pour passer (${mpVoteSkipVotes}/${mpVoteSkipNeeded})${coopCost}`;
  }
}
function mpVoteSkip() {
  if (!mpSocket || mpEliminated || mpSpectating) return;
  mpVotedSkip = !mpVotedSkip; // optimiste : confirmé par le décompte mp:voteskip:update
  renderMpVoteSkip();
  mpSocket.emit('mp:voteskip');
}
function mpSettingsPayload() {
  return {
    rounds: parseInt(document.getElementById('mp-set-rounds').value),
    roundMs: parseInt(document.getElementById('mp-set-speed').value),
    mode: document.getElementById('mp-set-mode').value,
    themeType: document.getElementById('mp-set-theme').value,
    songSource: document.getElementById('mp-set-source').value,
    listScope: document.getElementById('mp-set-list-scope').value,
    difficulty: document.getElementById('mp-set-difficulty').value,
    yearMin: parseInt(document.getElementById('mp-set-year-min').value) || 0,
    yearMax: parseInt(document.getElementById('mp-set-year-max').value) || 0,
    genres: typeof readGenreChips === 'function' ? readGenreChips('mp-set-genres') : [],
  };
}

const MP_PRESET_KEY = 'amq_presets_mp';
function applyMpPreset(data) {
  const byId = (id) => document.getElementById(id);
  if (data.rounds != null && byId('mp-set-rounds')) byId('mp-set-rounds').value = String(data.rounds);
  if (data.roundMs != null && byId('mp-set-speed')) byId('mp-set-speed').value = String(data.roundMs);
  if (data.mode && byId('mp-set-mode')) byId('mp-set-mode').value = data.mode;
  if (data.themeType && byId('mp-set-theme')) byId('mp-set-theme').value = data.themeType;
  if (data.songSource && byId('mp-set-source')) byId('mp-set-source').value = data.songSource;
  if (data.listScope && byId('mp-set-list-scope')) byId('mp-set-list-scope').value = data.listScope;
  if (data.difficulty && byId('mp-set-difficulty')) byId('mp-set-difficulty').value = data.difficulty;
  if (data.yearMin != null && byId('mp-set-year-min')) byId('mp-set-year-min').value = String(data.yearMin);
  if (data.yearMax != null && byId('mp-set-year-max')) byId('mp-set-year-max').value = String(data.yearMax);
  if (typeof renderGenreChips === 'function') renderGenreChips('mp-set-genres', data.genres || []);
  mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload());
}
function initMpPresetsUI() {
  const sel = document.getElementById('mp-preset-select');
  if (!sel) return;
  renderPresetSelect('mp-preset-select', MP_PRESET_KEY);
  sel.addEventListener('change', () => {
    if (!sel.value || sel.disabled) return;
    const preset = loadPresets(MP_PRESET_KEY).find((p) => p.name === sel.value);
    if (preset) applyMpPreset(preset.data);
  });
  document.getElementById('mp-preset-save')?.addEventListener('click', () => {
    const name = (prompt('Nom du preset ?', sel.value || '') || '').trim().slice(0, 40);
    if (!name) return;
    upsertPreset(MP_PRESET_KEY, name, mpSettingsPayload());
    renderPresetSelect('mp-preset-select', MP_PRESET_KEY);
    sel.value = name;
  });
  document.getElementById('mp-preset-delete')?.addEventListener('click', () => {
    if (!sel.value) return;
    deletePreset(MP_PRESET_KEY, sel.value);
    renderPresetSelect('mp-preset-select', MP_PRESET_KEY);
  });
}

function initMpUI() {
  document.getElementById('mp-quick').addEventListener('click', () => {
    const sel = document.getElementById('mp-quick-rounds');
    const rounds = sel ? parseInt(sel.value, 10) : 10;
    joinMatchmaking('mp:quick', 'Recherche d’une partie rapide…', { rounds });
  });
  document.getElementById('mp-ranked').addEventListener('click', () => {
    joinMatchmaking('mp:ranked', 'Recherche d’une partie classée…');
  });
  document.getElementById('mp-create').addEventListener('click', () => {
    mpLeft = false; mpEngaged = true;
    connectMp(); mpSocket && mpSocket.emit('mp:create', mpSettingsPayload());
  });
  document.getElementById('mp-join').addEventListener('click', () => {
    const code = document.getElementById('mp-code-input').value.trim().toUpperCase();
    if (!code) return;
    mpLeft = false; mpEngaged = true;
    connectMp(); mpSocket && mpSocket.emit('mp:join', code);
  });
  document.getElementById('mp-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('mp-join').click();
  });
  // Entrée Coop : créer / rejoindre / retour
  document.getElementById('mp-coop-create').addEventListener('click', () => {
    mpLeft = false; mpEngaged = true;
    connectMp(); mpSocket && mpSocket.emit('mp:create', { ...mpSettingsPayload(), mode: 'coop' });
  });
  document.getElementById('mp-coop-join').addEventListener('click', () => {
    const code = document.getElementById('mp-coop-code').value.trim().toUpperCase();
    if (!code) { document.getElementById('mp-coop-msg').textContent = 'Entre le code de ton ami.'; return; }
    mpLeft = false; mpEngaged = true;
    document.getElementById('mp-coop-msg').textContent = 'Connexion au salon…';
    connectMp(); mpSocket && mpSocket.emit('mp:join', code);
  });
  document.getElementById('mp-coop-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('mp-coop-join').click();
  });
  document.getElementById('mp-coop-back').addEventListener('click', () => { mpLeft = true; showView('play'); });
  // Liste des parties en cours + spectateur
  document.getElementById('mp-rooms-refresh').addEventListener('click', loadMpRooms);
  document.getElementById('mp-rooms-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-spectate]');
    if (b) spectateRoom(b.dataset.spectate);
  });
  document.getElementById('mp-spectator-leave').addEventListener('click', stopSpectate);
  // Salon : clic sur un joueur (chip) → sa fiche profil, en modale (pas
  // openPlayer/showView : on ne veut pas donner l'impression de quitter le
  // salon/la partie en cours).
  document.getElementById('mp-room-players').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-userid]');
    if (chip && typeof openPlayerModal === 'function') openPlayerModal(chip.dataset.userid);
  });
  // Réponse : « Ajouté au catalogue par X » → sa fiche profil, même raison.
  document.getElementById('mp-result').addEventListener('click', (e) => {
    const b = e.target.closest('[data-userid]');
    if (b && typeof openPlayerModal === 'function') openPlayerModal(b.dataset.userid);
  });
  document.getElementById('mp-leave').addEventListener('click', () => {
    mpEngaged = false;
    mpSocket && mpSocket.emit('mp:leave'); mpRoom = null; mpShow('menu');
    document.getElementById('mp-menu-msg').textContent = '';
  });
  document.getElementById('mp-start').addEventListener('click', () => mpSocket && mpSocket.emit('mp:start'));
  document.getElementById('mp-set-rounds').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-speed').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-mode').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-theme').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-source').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  // Selects d'années remplis une fois (même helper que le quiz solo).
  if (typeof fillYearSelect === 'function') {
    fillYearSelect(document.getElementById('mp-set-year-min'), 0);
    fillYearSelect(document.getElementById('mp-set-year-max'), 0);
  }
  // Optionnel (?.) : un HTML servi en retard d'un déploiement sur ce script
  // (cache navigateur/CDN pendant un déploiement) ne doit pas faire planter
  // toute l'init de l'app — initMpUI tourne avant même setupAppUI/la connexion.
  document.getElementById('mp-set-difficulty')?.addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-year-min')?.addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-year-max')?.addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  initMpPresetsUI();
  // Chat global du menu
  document.getElementById('mp-gchat-send')?.addEventListener('click', sendGlobalChat);
  document.getElementById('mp-gchat-text')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendGlobalChat(); });
  // Lien d'invitation + partage du résultat
  document.getElementById('mp-copy-link')?.addEventListener('click', copyMpRoomLink);
  document.getElementById('mp-share')?.addEventListener('click', shareMpResult);
  // Inviter des amis (salle privée) + envoi d'une invitation
  document.getElementById('mp-invite-friends')?.addEventListener('click', toggleMpInviteList);
  document.getElementById('mp-invite-list')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-invite-userid]');
    if (!b || !mpSocket) return;
    mpSocket.emit('mp:invite', b.dataset.inviteUserid);
    b.disabled = true;
    b.querySelector('i').className = 'fas fa-check';
  });
  // Récap de fin de partie : like direct depuis une ligne
  document.getElementById('mp-history-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mp-like]');
    if (!btn) return;
    const h = mpRoundHistory[+btn.dataset.mpLike];
    if (h?.songId && typeof quickLike === 'function') quickLike(btn, h.songId);
  });
  // Chips de genres : clic = bascule (hôte seulement, chips désactivées sinon)
  document.getElementById('mp-set-genres')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-genre]');
    if (!chip || chip.disabled) return;
    chip.classList.toggle('active');
    mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload());
  });
  document.getElementById('mp-chat-send').addEventListener('click', mpSendChat);
  document.getElementById('mp-chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') mpSendChat(); });
  document.getElementById('mp-emotes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emote]');
    if (b && mpSocket) mpSocket.emit('mp:emote', b.dataset.emote);
  });
  document.getElementById('mp-submit').addEventListener('click', mpSubmitGuess);
  document.getElementById('mp-skip').addEventListener('click', mpSkip);
  document.getElementById('mp-voteskip').addEventListener('click', mpVoteSkip);
  document.getElementById('mp-again').addEventListener('click', () => {
    // retour au salon (privé) ou au menu (rapide)
    if (mpRoom && !mpRoom.isPublic) { mpShow('room'); renderRoom(mpRoom); }
    else {
      // Partie publique : quitter aussi côté serveur, sinon la salle terminée
      // (gardée ~30 s) nous retenait et un nouveau « Partie rapide » figeait.
      mpEngaged = false;
      if (mpSocket) mpSocket.emit('mp:leave');
      mpRoom = null; mpShow('menu');
      document.getElementById('mp-menu-msg').textContent = '';
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMpUI);

function mpSendChat() {
  const inp = document.getElementById('mp-chat-text');
  const t = inp.value.trim();
  if (!t || !mpSocket) return;
  mpSocket.emit('mp:chat', t);
  inp.value = '';
}

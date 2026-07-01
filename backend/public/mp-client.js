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

// Affiche les vies partagées de l'équipe (coop) dans le HUD.
function updateCoopLives() {
  const el = document.getElementById('mp-coop-lives');
  if (!el) return;
  el.classList.toggle('hidden', !mpCoop);
  if (mpCoop) el.innerHTML = `<i class="fas fa-heart"></i> × ${Math.max(0, mpTeamLives)} <small>(équipe)</small>`;
}
let mpEngaged = false; // suis-je dans une salle/file (≠ simple consultation du menu) ?
let mpLeft = false; // ai-je quitté volontairement la vue ? (ignore les events en vol)
const MP_FREE_EMOTES = ['😂', '🔥', '👍', '😮', '😭', '🎉', '👏', '💀'];
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
}

function openMultiplayer() {
  mpLeft = false; // entrée délibérée dans la vue
  mpSpectating = false;
  showView('mp');
  connectMp();
  if (!mpRoom) { mpShow('menu'); document.getElementById('mp-menu-msg').textContent = ''; loadMpRooms(); }
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
  mpSocket.on('mp:invited', (d) => {
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
  });

  mpSocket.on('mp:chat', (m) => appendChat(m));

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
    const englishTitle = d.answer.englishTitle && d.answer.englishTitle !== d.answer.animeTitle
      ? ` <span class="mp-answer-english">(${escapeHtml(d.answer.englishTitle)})</span>`
      : '';
    const skippedBanner = d.skipped ? '<div class="mp-coop-banner">⏭️ Extrait passé au vote</div>' : '';
    res.innerHTML = `${skippedBanner}<div class="mp-answer">Réponse : <strong>${escapeHtml(d.answer.animeTitle)}</strong>${englishTitle}
      <button class="like-reveal hidden" id="mp-like" title="Ajouter à ma playlist" aria-label="Ajouter à ma playlist"><i class="far fa-heart"></i></button>
      <span class="hint">${escapeHtml(d.answer.title || '')}${d.answer.artist ? ' — ' + escapeHtml(d.answer.artist) : ''}</span></div>`;
    // ❤ : la réponse est révélée → on peut ajouter la musique à sa playlist (8 s d'affichage).
    if (typeof setupQuickLike === 'function') setupQuickLike(document.getElementById('mp-like'), d.answer.songId);
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
      document.getElementById('mp-ranking').innerHTML =
        `<p class="mp-coop-recap">Votre équipe a franchi <b>${floor}</b> étage${floor > 1 ? 's' : ''} ensemble !${iRecord ? ' <span class="mp-record">🎉 Nouveau record perso</span>' : ''}</p>`
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
  document.getElementById('mp-room-code').innerHTML = d.code
    ? `Salle privée · <b>${d.code}</b>`
    : '⚡ Partie rapide';
  document.getElementById('mp-pcount').textContent = d.players.length;
  document.getElementById('mp-room-players').innerHTML = d.players
    .map((p) => `<span class="mp-chip${p.isHost ? ' host' : ''}">${otherAvatar({ avatarUrl: p.avatarUrl, frame: p.frame, displayName: p.name }, 'avatar-xs')}${p.isHost ? '👑 ' : ''}${escapeHtml(p.name)}</span>`)
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
    document.getElementById('mp-set-mode').disabled = !isHost;
    document.getElementById('mp-set-theme').disabled = !isHost;
    // Coop : mode figé (lancé via « Jouer ») + étages infinis / temps auto → on
    // masque les champs Mode, Manches et Temps (l'encart coop explique tout).
    document.getElementById('mp-field-mode').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-rounds').classList.toggle('hidden', isCoop);
    document.getElementById('mp-field-speed').classList.toggle('hidden', isCoop);
  }
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
        const sec = Math.max(0, Math.ceil((d.countdownEndsAt - Date.now()) / 1000));
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

// ── Emotes ──
function renderEmotesBar() {
  document.getElementById('mp-emotes').innerHTML = mpEmotes
    .map((e) => `<button class="mp-emote-btn" data-emote="${escapeHtml(e.id)}" title="${escapeHtml(e.name || '')}">
      ${e.imageUrl
        ? `<img src="${escapeHtml(e.imageUrl)}" alt="${escapeHtml(e.name || e.symbol)}" onerror="this.replaceWith(document.createTextNode('${escapeHtml(e.symbol)}'))">`
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
      return `<div class="mp-score-row${p.correct ? ' ok' : ''}${p.eliminated ? ' elim' : ''}">
        <span class="mp-name"><span class="mp-name-top">${av}${escapeHtml(p.name)}${team}</span>${guess}</span>
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
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, timestamp - Date.now())));
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
      const remaining = Math.max(1000, startAt + duration - Date.now());
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
  if (label) label.textContent = `Voter pour passer (${mpVoteSkipVotes}/${mpVoteSkipNeeded})`;
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
  };
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
  document.getElementById('mp-coop-back').addEventListener('click', () => { mpLeft = true; showView('play'); });
  // Liste des parties en cours + spectateur
  document.getElementById('mp-rooms-refresh').addEventListener('click', loadMpRooms);
  document.getElementById('mp-rooms-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-spectate]');
    if (b) spectateRoom(b.dataset.spectate);
  });
  document.getElementById('mp-spectator-leave').addEventListener('click', stopSpectate);
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
    else { mpRoom = null; mpShow('menu'); }
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

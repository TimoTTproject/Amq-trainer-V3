// ════════════════════════════════════════════
// MULTIJOUEUR (Socket.io) — salles, chat, emotes, manches synchronisées
// Utilise les globals de main.js (escapeHtml, showView, currentUser).
// ════════════════════════════════════════════
let mpSocket = null;
let mpTimer = null;
let mpRoom = null; // dernier snapshot de salon
const MP_EMOTES = ['😂', '🔥', '👍', '😮', '😭', '🎉', '👏', '💀'];
const mpVideo = () => document.getElementById('mp-video');

function mpShow(panel) {
  ['menu', 'room', 'game', 'over'].forEach((p) =>
    document.getElementById('mp-' + p).classList.toggle('hidden', p !== panel)
  );
}

function openMultiplayer() {
  showView('mp');
  connectMp();
  if (!mpRoom) { mpShow('menu'); document.getElementById('mp-menu-msg').textContent = ''; }
  // Affiche mon rang classé dans le menu
  api(`/api/profile/${currentUser.id}`).then((d) => {
    const el = document.getElementById('mp-myrank');
    if (d.ranked && d.ranked.games) {
      el.innerHTML = `Ton rang : <b>${d.ranked.tier.icon} ${escapeHtml(d.ranked.tier.name)}</b> · ${d.ranked.mmr} MMR`;
      el.classList.remove('hidden');
    } else {
      el.innerHTML = 'Pas encore classé — joue une partie classée !';
      el.classList.remove('hidden');
    }
  }).catch(() => {});
}

function mpIsHost() { return mpRoom && mpSocket && mpRoom.hostId === mpSocket.id; }

function connectMp() {
  if (mpSocket) return;
  if (typeof io === 'undefined') {
    document.getElementById('mp-menu-msg').textContent = 'Connexion temps réel indisponible.';
    return;
  }
  mpSocket = io({ path: '/socket.io' });
  mpSocket.on('connect_error', () => {
    document.getElementById('mp-menu-msg').textContent = 'Connexion impossible (reconnecte-toi ?).';
  });
  mpSocket.on('mp:error', (d) => { document.getElementById('mp-menu-msg').textContent = d.msg || 'Erreur'; });

  mpSocket.on('mp:room', (d) => {
    mpRoom = d;
    if (d.status === 'lobby') { showView('mp'); mpShow('room'); renderRoom(d); }
  });

  mpSocket.on('mp:chat', (m) => appendChat(m));

  mpSocket.on('mp:emote', (d) => floatEmote(d.emote, d.name));

  mpSocket.on('mp:game:start', (d) => {
    showView('mp');
    mpShow('game');
    document.getElementById('mp-total').textContent = d.totalRounds;
    document.getElementById('mp-round').textContent = '—';
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-scores').innerHTML = '';
    document.getElementById('mp-progress').textContent = '';
    document.getElementById('mp-feedback').textContent = (d.ranked ? '🏅 Partie classée — ' : '') + `c'est parti ! ${d.players.length} joueur(s) 🎮`;
    renderEmotesBar();
  });

  mpSocket.on('mp:round:start', (d) => {
    document.getElementById('mp-round').textContent = d.round;
    document.getElementById('mp-total').textContent = d.total;
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-progress').textContent = '';
    const input = document.getElementById('mp-input');
    const answered = !!d.alreadyAnswered;
    input.value = ''; input.disabled = answered;
    if (!answered) input.focus();
    document.getElementById('mp-submit').disabled = answered;
    document.getElementById('mp-feedback').textContent = answered ? '✅ Déjà répondu' : (d.resumed ? '↩️ Reconnecté' : '');
    mpStartClip(d.clipUrl, d.startAt, d.duration);
  });

  mpSocket.on('mp:guess:ack', (d) => {
    const fb = document.getElementById('mp-feedback');
    if (d.correct) {
      fb.textContent = '✅ Bonne réponse !';
      document.getElementById('mp-input').disabled = true;
      document.getElementById('mp-submit').disabled = true;
    } else {
      fb.textContent = '❌ Essaie encore…';
    }
  });

  mpSocket.on('mp:round:progress', (d) => {
    document.getElementById('mp-progress').textContent = `${d.answered}/${d.total} ont trouvé`;
  });

  mpSocket.on('mp:round:result', (d) => {
    clearTimeout(mpTimer);
    document.getElementById('mp-overlay').classList.add('hidden'); // révèle la vidéo
    const res = document.getElementById('mp-result');
    res.classList.remove('hidden');
    res.innerHTML = `<div class="mp-answer">Réponse : <strong>${escapeHtml(d.answer.animeTitle)}</strong>
      <span class="hint">${escapeHtml(d.answer.title || '')}${d.answer.artist ? ' — ' + escapeHtml(d.answer.artist) : ''}</span></div>`;
    renderMpScores(d.results, true);
    const me = d.results.find((p) => p.name === currentUser.displayName);
    if (me) (me.correct ? sfx.correct() : sfx.wrong());
    document.getElementById('mp-input').disabled = true;
    document.getElementById('mp-submit').disabled = true;
  });

  mpSocket.on('mp:game:over', (d) => {
    mpStopClip();
    showView('mp');
    mpShow('over');
    const iWon = d.ranking[0] && d.ranking[0].name === currentUser.displayName;
    if (iWon) { sfx.win(); burstConfetti(40); } else { sfx.lose(); }
    document.querySelector('#mp-over h3').textContent = d.ranked ? '🏅 Classement final (classé)' : '🏆 Classement final';
    const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
    document.getElementById('mp-ranking').innerHTML = d.ranking
      .map((p, i) => {
        const delta = p.mmrDelta != null
          ? ` <span class="mp-mmr ${p.mmrDelta >= 0 ? 'gain' : 'spend'}">${p.mmrDelta >= 0 ? '+' : ''}${p.mmrDelta} MMR</span>`
          : '';
        return `<li class="lb-row${p.name === currentUser.displayName ? ' me' : ''}">
          <span class="lb-rank">${medal(i + 1)}</span>
          <span class="lb-name">${escapeHtml(p.name)}${delta}</span>
          <span class="lb-value">${p.score} pts</span>
        </li>`;
      })
      .join('');
  });
}

// ── Salon (lobby) ──
function renderRoom(d) {
  const isHost = mpIsHost();
  document.getElementById('mp-room-code').innerHTML = d.code
    ? `Salle privée · <b>${d.code}</b>`
    : '⚡ Partie rapide';
  document.getElementById('mp-pcount').textContent = d.players.length;
  document.getElementById('mp-room-players').innerHTML = d.players
    .map((p) => `<span class="mp-chip${p.isHost ? ' host' : ''}">${p.isHost ? '👑 ' : ''}${escapeHtml(p.name)}</span>`)
    .join('');

  document.getElementById('mp-set-rounds').value = String(d.settings.rounds);
  document.getElementById('mp-set-speed').value = String(d.settings.roundMs);
  document.getElementById('mp-set-rounds').disabled = !isHost;
  document.getElementById('mp-set-speed').disabled = !isHost;

  const startBtn = document.getElementById('mp-start');
  const status = document.getElementById('mp-room-status');
  if (d.isPublic) {
    startBtn.classList.add('hidden');
    if (d.countdownEndsAt) {
      const sec = Math.max(0, Math.round((d.countdownEndsAt - Date.now()) / 1000));
      status.textContent = `Lancement automatique dans ${sec}s…`;
    } else {
      status.textContent = `En attente de joueurs (min 2)…`;
    }
  } else {
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
  document.getElementById('mp-emotes').innerHTML = MP_EMOTES
    .map((e) => `<button class="mp-emote-btn" data-emote="${e}">${e}</button>`)
    .join('');
}
function floatEmote(emote, name) {
  const layer = document.getElementById('mp-reactions');
  const el = document.createElement('div');
  el.className = 'mp-reaction';
  el.textContent = emote;
  el.style.left = (10 + Math.random() * 80) + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ── Scores ──
function renderMpScores(results, withPoints) {
  document.getElementById('mp-scores').innerHTML = results
    .map(
      (p) => `<div class="mp-score-row${p.correct ? ' ok' : ''}">
      <span class="mp-name">${escapeHtml(p.name)}</span>
      ${withPoints && p.points ? `<span class="mp-pts">+${p.points}</span>` : '<span></span>'}
      <span class="mp-total">${p.score}</span>
    </div>`
    )
    .join('');
}

// ── Clip synchronisé ──
function mpStartClip(url, startAt, duration) {
  const v = mpVideo();
  v.src = url; v.load(); v.volume = 0.8;
  document.getElementById('mp-overlay').classList.remove('hidden'); // audio seul
  const delay = Math.max(0, startAt - Date.now());
  setTimeout(() => { v.play().catch(() => {}); mpRunTimer(duration); }, delay);
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
  clearTimeout(mpTimer);
  const v = mpVideo();
  if (v) v.pause();
}
function stopMpMedia() {
  mpStopClip();
  const v = mpVideo();
  if (v) { v.removeAttribute('src'); v.load(); }
}

function mpSubmitGuess() {
  const input = document.getElementById('mp-input');
  const text = input.value.trim();
  if (!text || input.disabled || !mpSocket) return;
  mpSocket.emit('mp:guess', text);
}
function mpSettingsPayload() {
  return {
    rounds: parseInt(document.getElementById('mp-set-rounds').value),
    roundMs: parseInt(document.getElementById('mp-set-speed').value),
  };
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mp-quick').addEventListener('click', () => {
    connectMp(); document.getElementById('mp-menu-msg').textContent = 'Recherche…'; mpSocket && mpSocket.emit('mp:quick');
  });
  document.getElementById('mp-ranked').addEventListener('click', () => {
    connectMp(); document.getElementById('mp-menu-msg').textContent = 'Recherche d\'une partie classée…'; mpSocket && mpSocket.emit('mp:ranked');
  });
  document.getElementById('mp-create').addEventListener('click', () => {
    connectMp(); mpSocket && mpSocket.emit('mp:create', mpSettingsPayload());
  });
  document.getElementById('mp-join').addEventListener('click', () => {
    const code = document.getElementById('mp-code-input').value.trim().toUpperCase();
    if (!code) return;
    connectMp(); mpSocket && mpSocket.emit('mp:join', code);
  });
  document.getElementById('mp-leave').addEventListener('click', () => {
    mpSocket && mpSocket.emit('mp:leave'); mpRoom = null; mpShow('menu');
    document.getElementById('mp-menu-msg').textContent = '';
  });
  document.getElementById('mp-start').addEventListener('click', () => mpSocket && mpSocket.emit('mp:start'));
  document.getElementById('mp-set-rounds').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-set-speed').addEventListener('change', () => mpSocket && mpSocket.emit('mp:settings', mpSettingsPayload()));
  document.getElementById('mp-chat-send').addEventListener('click', mpSendChat);
  document.getElementById('mp-chat-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') mpSendChat(); });
  document.getElementById('mp-emotes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emote]');
    if (b && mpSocket) mpSocket.emit('mp:emote', b.dataset.emote);
  });
  document.getElementById('mp-submit').addEventListener('click', mpSubmitGuess);
  document.getElementById('mp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') mpSubmitGuess(); });
  document.getElementById('mp-again').addEventListener('click', () => {
    // retour au salon (privé) ou au menu (rapide)
    if (mpRoom && !mpRoom.isPublic) { mpShow('room'); renderRoom(mpRoom); }
    else { mpRoom = null; mpShow('menu'); }
  });
});

function mpSendChat() {
  const inp = document.getElementById('mp-chat-text');
  const t = inp.value.trim();
  if (!t || !mpSocket) return;
  mpSocket.emit('mp:chat', t);
  inp.value = '';
}

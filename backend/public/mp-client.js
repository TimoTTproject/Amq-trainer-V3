// ════════════════════════════════════════════
// MULTIJOUEUR (Socket.io) — utilise les globals de main.js
// ════════════════════════════════════════════
let mpSocket = null;
let mpTimer = null;
const mpVideo = () => document.getElementById('mp-video');

function mpShow(panel) {
  document.getElementById('mp-lobby').classList.toggle('hidden', panel !== 'lobby');
  document.getElementById('mp-game').classList.toggle('hidden', panel !== 'game');
  document.getElementById('mp-over').classList.toggle('hidden', panel !== 'over');
}

function openMultiplayer() {
  showView('mp');
  connectMp();
  mpShow('lobby');
  document.getElementById('mp-queue').classList.add('hidden');
  document.getElementById('mp-lobby-msg').textContent = '';
}

function connectMp() {
  if (mpSocket) return;
  if (typeof io === 'undefined') {
    document.getElementById('mp-lobby-msg').textContent = 'Connexion temps réel indisponible.';
    return;
  }
  mpSocket = io({ path: '/socket.io' });

  mpSocket.on('connect_error', () => {
    document.getElementById('mp-lobby-msg').textContent = 'Connexion impossible (reconnecte-toi ?).';
  });

  mpSocket.on('mp:queue:update', (d) => {
    const q = document.getElementById('mp-queue');
    q.classList.remove('hidden');
    let status = `${d.count} joueur(s) en attente…`;
    if (d.count < d.min) status += ` (min ${d.min})`;
    if (d.countdownEndsAt) {
      const sec = Math.max(0, Math.round((d.countdownEndsAt - Date.now()) / 1000));
      status = `Lancement dans ${sec}s — ${d.count} joueur(s)`;
    }
    document.getElementById('mp-queue-status').textContent = status;
    document.getElementById('mp-queue-players').innerHTML = (d.players || [])
      .map((p) => `<span class="mp-chip">${escapeHtml(p.name)}</span>`)
      .join('');
  });

  mpSocket.on('mp:game:start', (d) => {
    mpShow('game');
    document.getElementById('mp-total').textContent = d.totalRounds;
    document.getElementById('mp-round').textContent = '—';
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-scores').innerHTML = '';
    document.getElementById('mp-feedback').textContent = `C'est parti ! ${d.players.length} joueurs 🎮`;
  });

  mpSocket.on('mp:round:start', (d) => {
    document.getElementById('mp-round').textContent = d.round;
    document.getElementById('mp-total').textContent = d.total;
    document.getElementById('mp-result').classList.add('hidden');
    document.getElementById('mp-progress').textContent = '';
    const input = document.getElementById('mp-input');
    input.value = '';
    input.disabled = false;
    input.focus();
    document.getElementById('mp-submit').disabled = false;
    document.getElementById('mp-feedback').textContent = '';
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
    mpStopClip();
    const res = document.getElementById('mp-result');
    res.classList.remove('hidden');
    res.innerHTML = `<div class="mp-answer">Réponse : <strong>${escapeHtml(d.answer.animeTitle)}</strong>
      <span class="hint">${escapeHtml(d.answer.title || '')}${d.answer.artist ? ' — ' + escapeHtml(d.answer.artist) : ''}</span></div>`;
    renderMpScores(d.results, true);
    document.getElementById('mp-input').disabled = true;
    document.getElementById('mp-submit').disabled = true;
  });

  mpSocket.on('mp:player:left', (d) => {
    document.getElementById('mp-feedback').textContent = `${d.name || 'Un joueur'} a quitté la partie.`;
  });

  mpSocket.on('mp:game:over', (d) => {
    mpStopClip();
    mpShow('over');
    const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
    document.getElementById('mp-ranking').innerHTML = d.ranking
      .map(
        (p, i) => `<li class="lb-row${p.name === currentUser.displayName ? ' me' : ''}">
        <span class="lb-rank">${medal(i + 1)}</span>
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-value">${p.score} pts</span>
      </li>`
      )
      .join('');
  });
}

// Tableau des scores
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

// Lecture synchronisée du clip (proxifié)
function mpStartClip(url, startAt, duration) {
  const v = mpVideo();
  v.src = url;
  v.load();
  v.volume = 0.8;
  document.getElementById('mp-overlay').classList.remove('hidden');
  const delay = Math.max(0, startAt - Date.now());
  setTimeout(() => {
    v.play().catch(() => {});
    mpRunTimer(duration);
  }, delay);
}
function mpRunTimer(duration) {
  const fill = document.getElementById('mp-timefill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.classList.remove('low');
  void fill.offsetWidth;
  fill.style.transition = `width ${duration}ms linear`;
  fill.style.width = '0%';
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mp-find').addEventListener('click', () => {
    connectMp();
    document.getElementById('mp-queue').classList.remove('hidden');
    document.getElementById('mp-queue-status').textContent = 'Recherche…';
    mpSocket && mpSocket.emit('mp:queue:join');
  });
  document.getElementById('mp-cancel').addEventListener('click', () => {
    mpSocket && mpSocket.emit('mp:queue:leave');
    document.getElementById('mp-queue').classList.add('hidden');
  });
  document.getElementById('mp-again').addEventListener('click', openMultiplayer);
  document.getElementById('mp-submit').addEventListener('click', mpSubmitGuess);
  document.getElementById('mp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') mpSubmitGuess(); });
});

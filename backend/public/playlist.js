// Playlist — extrait de main.js (script classique, scope global partagé).
// Chargé APRÈS main.js dans index.html : réutilise ses globals (currentUser, api,
// settings, escapeHtml, otherAvatar, getVolume…). Ne pas charger comme module ES.

// ── PLAYLIST ──
function openPlaylist() {
  showView('playlist');
  loadPlaylist();
}

let playlistSongs = [];
let playlistRecommendations = []; // recos affichées
let playlistRecReserve = [];      // recos en réserve (pour remplacer celles ajoutées/retirées)
let playlistRecPersonalized = true;
let playlistTrackId = null;
const REC_DISPLAY = 8; // nombre de recos visibles

// Recherche-ajout : parcourir le catalogue pour ajouter des musiques
let playlistSearchResults = [];
let playlistSearchPage = 1;
let playlistSearchPages = 1;
let playlistSearchTotal = 0;
let playlistSearchQuery = '';
let playlistSearchTimer = null;

// Toutes les pistes connues du lecteur (playlist + recos + résultats de recherche)
function allPlaylistTracks() {
  return [...playlistSongs, ...playlistRecommendations, ...playlistSearchResults];
}

async function loadPlaylist() {
  const tbody = document.getElementById('playlist-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Chargement…</td></tr>';
  stopPlaylistAudio();
  playlistSongs = [];
  playlistRecommendations = [];
  playlistRecReserve = [];
  playlistSearchResults = [];
  playlistSearchPage = 1;
  playlistSearchQuery = '';
  const searchInput = document.getElementById('playlist-search-input');
  if (searchInput) searchInput.value = '';
  renderPlaylistSearch();
  playlistTrackId = null;
  updatePlaylistPlayer();
  try {
    const [{ songs }, recommendationData] = await Promise.all([
      api('/api/quiz/playlist'),
      api('/api/quiz/playlist/recommendations?limit=24').catch(() => ({ recommendations: [], personalized: false })),
    ]);
    playlistSongs = songs;
    const recs = recommendationData.recommendations || [];
    playlistRecPersonalized = !!recommendationData.personalized;
    playlistRecommendations = recs.slice(0, REC_DISPLAY); // affichées
    playlistRecReserve = recs.slice(REC_DISPLAY);         // réserve pour le remplacement
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
        <div class="playlist-rec-actions">
          <button type="button" data-rec-play data-sid="${song.id}" aria-label="Écouter ${escapeHtml(song.title)}" title="Écouter"><i class="fas fa-play"></i></button>
          <button type="button" class="playlist-rec-dismiss" data-rec-dismiss data-sid="${song.id}" aria-label="Pas intéressé" title="Pas intéressé · masquer"><i class="fas fa-xmark"></i></button>
        </div>
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
  document.querySelectorAll('#playlist-tbody [data-play] i, #playlist-recs-grid [data-rec-play] i, #playlist-search-results [data-search-play] i').forEach((icon) => {
    const sid = parseInt(icon.closest('[data-sid]')?.dataset.sid || icon.closest('[data-rec-id]')?.dataset.recId);
    icon.className = playing && sid === playlistTrackId ? 'fas fa-pause' : 'fas fa-play';
  });
}

function updatePlaylistPlayer() {
  const player = document.getElementById('playlist-player');
  if (!player) return;
  const allAvailable = allPlaylistTracks();
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
  const song = allPlaylistTracks().find((s) => s.id === songId && s.videoUrl);
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

// Va chercher de nouvelles recos en réserve (exclut celles déjà affichées / en playlist).
async function refillRecReserve() {
  try {
    const data = await api('/api/quiz/playlist/recommendations?limit=24');
    const shown = new Set(playlistRecommendations.map((s) => s.id));
    const inList = new Set(playlistSongs.map((s) => s.id));
    playlistRecReserve = (data.recommendations || []).filter((s) => !shown.has(s.id) && !inList.has(s.id));
  } catch { /* on garde la réserve en l'état */ }
}

// Remplace la reco à l'index idx par une de la réserve (ou la retire si vide).
async function replaceRec(idx) {
  if (!playlistRecReserve.length) await refillRecReserve();
  const replacement = playlistRecReserve.shift();
  if (replacement) playlistRecommendations.splice(idx, 1, replacement);
  else playlistRecommendations.splice(idx, 1);
}

function updatePlaylistTotal() {
  document.getElementById('playlist-total').textContent = `${playlistSongs.length} musique${playlistSongs.length > 1 ? 's' : ''}`;
}

async function addPlaylistRecommendation(songId, btn) {
  const idx = playlistRecommendations.findIndex((item) => item.id === songId);
  if (idx < 0) return;
  const song = playlistRecommendations[idx];
  btn.disabled = true;
  try {
    await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId, liked: true }) });
    if (currentSong && currentSong.id === songId) { currentLiked = true; setLikeButton(); }
    playlistSongs.unshift(song);
    // Remplace la reco ajoutée par une nouvelle (au même emplacement) → liste fournie.
    await replaceRec(idx);
    updatePlaylistTotal();
    renderPlaylistRows();
    renderPlaylistRecommendations(playlistRecPersonalized);
    updatePlaylistPlayer();
    setPlaylistPlaying(!document.getElementById('playlist-audio').paused);
  } catch (e) {
    btn.disabled = false;
    alert(e.message);
  }
}

// « Pas intéressé » : masque la reco (persisté) et la remplace par une autre.
async function dismissRecommendation(songId, btn) {
  const idx = playlistRecommendations.findIndex((item) => item.id === songId);
  if (idx < 0) return;
  btn.disabled = true;
  try {
    await api('/api/quiz/playlist/recommendations/dismiss', { method: 'POST', body: JSON.stringify({ songId }) });
    if (playlistTrackId === songId) stopPlaylistAudio();
    await replaceRec(idx);
    renderPlaylistRecommendations(playlistRecPersonalized);
    updatePlaylistPlayer();
  } catch (e) {
    btn.disabled = false;
    alert(e.message);
  }
}

// ── Recherche-ajout : parcourir le catalogue ──
async function loadPlaylistSearch(page = 1) {
  playlistSearchPage = Math.max(1, page);
  const results = document.getElementById('playlist-search-results');
  if (!results) return;
  if (!playlistSearchQuery) { playlistSearchResults = []; renderPlaylistSearch(); return; }
  results.innerHTML = '<p class="muted">Recherche…</p>';
  try {
    const qs = new URLSearchParams({ search: playlistSearchQuery, page: String(playlistSearchPage) });
    const data = await api('/api/catalog/list?' + qs.toString());
    playlistSearchResults = data.songs || [];
    playlistSearchTotal = data.total || 0;
    playlistSearchPages = data.pages || 1;
    renderPlaylistSearch();
  } catch (e) {
    results.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function renderPlaylistSearch() {
  const results = document.getElementById('playlist-search-results');
  const pager = document.getElementById('playlist-search-pager');
  if (!results) return;
  if (!playlistSearchQuery) { results.innerHTML = ''; if (pager) pager.innerHTML = ''; return; }
  const liked = new Set(playlistSongs.map((s) => s.id));
  results.innerHTML = playlistSearchResults.length
    ? playlistSearchResults.map((s) => {
        const playBtn = s.videoUrl
          ? `<button class="btn-play-row" data-search-play data-sid="${s.id}" title="Écouter"><i class="fas fa-play"></i></button>`
          : '<span class="btn-play-row placeholder"></span>';
        const added = liked.has(s.id);
        const addBtn = added
          ? '<span class="pl-search-added"><i class="fas fa-check"></i> Ajouté</span>'
          : `<button class="pl-search-add" data-search-add data-sid="${s.id}"><i class="fas fa-plus"></i> Ajouter</button>`;
        return `<div class="pl-search-row" data-sid="${s.id}">
          ${playBtn}
          <div class="pl-search-info"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.animeTitle)} · ${s.type}${s.number}${s.artist ? ` · ${escapeHtml(s.artist)}` : ''}</span></div>
          ${addBtn}
        </div>`;
      }).join('')
    : '<p class="muted">Aucun résultat.</p>';
  if (pager) {
    if (playlistSearchPages <= 1) pager.innerHTML = '';
    else {
      const p = playlistSearchPage;
      pager.innerHTML = `
        <button class="btn-secondary shop-page" data-search-page="${p - 1}"${p <= 1 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
        <span class="shop-page-info">Page ${p} / ${playlistSearchPages} · ${playlistSearchTotal} résultats</span>
        <button class="btn-secondary shop-page" data-search-page="${p + 1}"${p >= playlistSearchPages ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
    }
  }
}

// Ajout générique d'un son (depuis la recherche) à la playlist.
async function addSongToPlaylist(songId, btn) {
  const song = playlistSearchResults.find((s) => s.id === songId);
  if (!song || playlistSongs.some((s) => s.id === songId)) return;
  if (btn) btn.disabled = true;
  try {
    await api('/api/quiz/like', { method: 'POST', body: JSON.stringify({ songId, liked: true }) });
    if (currentSong && currentSong.id === songId) { currentLiked = true; setLikeButton(); }
    playlistSongs.unshift(song);
    updatePlaylistTotal();
    renderPlaylistRows();
    renderPlaylistSearch(); // rebascule le bouton sur « Ajouté »
    updatePlaylistPlayer();
  } catch (e) {
    if (btn) btn.disabled = false;
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
    const dismiss = e.target.closest('[data-rec-dismiss]');
    if (dismiss) return dismissRecommendation(parseInt(dismiss.dataset.sid), dismiss);
    const play = e.target.closest('[data-rec-play]');
    if (play) playPlaylistSong(parseInt(play.dataset.sid));
  });

  // Recherche-ajout
  const searchInput = document.getElementById('playlist-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(playlistSearchTimer);
      const v = e.target.value.trim();
      playlistSearchTimer = setTimeout(() => { playlistSearchQuery = v; loadPlaylistSearch(1); }, 300);
    });
  }
  const searchResults = document.getElementById('playlist-search-results');
  if (searchResults) {
    searchResults.addEventListener('click', (e) => {
      const add = e.target.closest('[data-search-add]');
      if (add) return addSongToPlaylist(parseInt(add.dataset.sid), add);
      const play = e.target.closest('[data-search-play]');
      if (play) return playPlaylistSong(parseInt(play.dataset.sid));
    });
  }
  const searchPager = document.getElementById('playlist-search-pager');
  if (searchPager) {
    searchPager.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-search-page]');
      if (pg && !pg.disabled) loadPlaylistSearch(parseInt(pg.dataset.searchPage, 10));
    });
  }
  document.querySelector('[data-player-toggle]').addEventListener('click', () => {
    if (playlistTrackId != null) playPlaylistSong(playlistTrackId);
    else {
      const first = allPlaylistTracks().find((s) => s.videoUrl);
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

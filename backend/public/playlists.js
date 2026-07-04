// Mes listes — playlists nommées, partageables entre joueurs (distinct de
// « Ma playlist » = favoris ❤, géré dans playlist.js). Script classique à scope
// global partagé, chargé après playlist.js (réutilise plCover/plTypeBadge/
// plFormatIcon) et après main.js (currentUser, api, escapeHtml, otherAvatar,
// getVolume, showView, navTo…). Ne pas charger comme module ES.

let plsTab = 'mine';
let plsDiscoverPage = 1, plsDiscoverPages = 1, plsDiscoverSearch = '';
let plsDiscoverSearchTimer = null;
let plsEditingId = null; // null = création

function openPlaylists() {
  showView('playlists');
  switchPlsTab('mine');
}

function switchPlsTab(tab) {
  plsTab = tab;
  document.querySelectorAll('#pls-tabs .shop-tab').forEach((b) => b.classList.toggle('active', b.dataset.pltab === tab));
  document.getElementById('pls-panel-mine').classList.toggle('hidden', tab !== 'mine');
  document.getElementById('pls-panel-discover').classList.toggle('hidden', tab !== 'discover');
  if (tab === 'mine') loadMyPlaylists();
  else loadDiscoverPlaylists(1);
}

function plsBadge(p) {
  return p.isPublic
    ? '<span class="pls-badge pub"><i class="fas fa-globe"></i> Publique</span>'
    : '<span class="pls-badge priv"><i class="fas fa-lock"></i> Privée</span>';
}

async function loadMyPlaylists() {
  const grid = document.getElementById('pls-mine-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { playlists } = await api('/api/playlists/mine');
    if (!playlists.length) {
      grid.innerHTML = '<p class="muted">Aucune liste pour l\'instant. Crée-en une pour commencer !</p>';
      return;
    }
    grid.innerHTML = playlists.map((p) => `
      <button type="button" class="pls-card" data-plid="${p.id}">
        <div class="pls-card-top"><h4>${escapeHtml(p.name)}</h4>${plsBadge(p)}</div>
        ${p.description ? `<p class="pls-card-desc">${escapeHtml(p.description)}</p>` : ''}
        <span class="pls-card-count"><i class="fas fa-music"></i> ${p.songCount} musique${p.songCount > 1 ? 's' : ''}</span>
      </button>`).join('');
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function loadDiscoverPlaylists(page) {
  if (page < 1) return;
  plsDiscoverPage = page;
  const grid = document.getElementById('pls-discover-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const qs = new URLSearchParams({ page: String(page), search: plsDiscoverSearch });
    const r = await api('/api/playlists/public?' + qs.toString());
    plsDiscoverPages = r.pages || 1;
    if (!r.playlists.length) {
      grid.innerHTML = '<p class="muted">Aucune liste publique trouvée.</p>';
    } else {
      grid.innerHTML = r.playlists.map((p) => `
        <button type="button" class="pls-card" data-plid="${p.id}">
          <div class="pls-card-top"><h4>${escapeHtml(p.name)}</h4></div>
          ${p.description ? `<p class="pls-card-desc">${escapeHtml(p.description)}</p>` : ''}
          <div class="pls-card-creator">${otherAvatar(p.creator, 'avatar-xs')}<span>${escapeHtml(p.creator.displayName)}</span></div>
          <span class="pls-card-count"><i class="fas fa-music"></i> ${p.songCount} musique${p.songCount > 1 ? 's' : ''}</span>
        </button>`).join('');
    }
    document.getElementById('pls-discover-pageinfo').textContent = `Page ${r.page} / ${plsDiscoverPages}`;
    document.getElementById('pls-discover-prev').disabled = r.page <= 1;
    document.getElementById('pls-discover-next').disabled = r.page >= plsDiscoverPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── Modale création / édition ──
function openPlsEditModal(playlist) {
  plsEditingId = playlist ? playlist.id : null;
  document.getElementById('pls-edit-title').innerHTML = playlist
    ? '<i class="fas fa-pen"></i> Modifier la liste'
    : '<i class="fas fa-list-ul"></i> Nouvelle liste';
  document.getElementById('pls-edit-name').value = playlist ? playlist.name : '';
  document.getElementById('pls-edit-desc').value = playlist ? (playlist.description || '') : '';
  document.getElementById('pls-edit-public').checked = playlist ? playlist.isPublic : true;
  document.getElementById('pls-edit-error').textContent = '';
  document.getElementById('pls-edit-modal').classList.remove('hidden');
  document.getElementById('pls-edit-name').focus();
}
function closePlsEditModal() {
  document.getElementById('pls-edit-modal').classList.add('hidden');
}

async function savePlsEdit() {
  const name = document.getElementById('pls-edit-name').value.trim();
  const description = document.getElementById('pls-edit-desc').value.trim();
  const isPublic = document.getElementById('pls-edit-public').checked;
  const errEl = document.getElementById('pls-edit-error');
  if (!name) { errEl.textContent = 'Un nom est requis.'; return; }
  const btn = document.getElementById('pls-edit-save');
  btn.disabled = true;
  try {
    if (plsEditingId) {
      await api(`/api/playlists/${plsEditingId}`, { method: 'PATCH', body: JSON.stringify({ name, description, isPublic }) });
      closePlsEditModal();
      await openPlaylistDetail(plsEditingId);
    } else {
      const { playlist } = await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name, description, isPublic }) });
      closePlsEditModal();
      await openPlaylistDetail(playlist.id);
    }
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Détail d'une liste ──
let pldCurrent = null; // { id, isOwner, songs, … }
let pldSearchResults = [];
let pldSearchPage = 1, pldSearchPages = 1, pldSearchQuery = '';
let pldSearchTimer = null;

async function openPlaylistDetail(id) {
  showView('playlist-detail');
  document.getElementById('pld-tbody').innerHTML = '<tr><td colspan="6" class="muted">Chargement…</td></tr>';
  document.getElementById('pld-name').innerHTML = '<i class="fas fa-list-ul"></i> —';
  document.getElementById('pld-creator').textContent = '';
  document.getElementById('pld-desc').classList.add('hidden');
  try {
    pldCurrent = await api(`/api/playlists/${id}`);
  } catch (e) {
    document.getElementById('pld-tbody').innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  document.getElementById('pld-name').innerHTML = `<i class="fas fa-list-ul"></i> ${escapeHtml(pldCurrent.name)}`;
  document.getElementById('pld-count').textContent = `${pldCurrent.songs.length} musique${pldCurrent.songs.length > 1 ? 's' : ''}`;
  document.getElementById('pld-creator').textContent = pldCurrent.isOwner
    ? (pldCurrent.isPublic ? 'Ta liste · publique' : 'Ta liste · privée')
    : `Par ${pldCurrent.creator.displayName}`;
  const descEl = document.getElementById('pld-desc');
  if (pldCurrent.description) { descEl.textContent = pldCurrent.description; descEl.classList.remove('hidden'); }
  document.getElementById('pld-owner-actions').classList.toggle('hidden', !pldCurrent.isOwner);
  document.getElementById('pld-clone-wrap').classList.toggle('hidden', pldCurrent.isOwner);
  document.getElementById('pld-search-section').classList.toggle('hidden', !pldCurrent.isOwner);
  pldSearchResults = []; pldSearchQuery = '';
  const searchInput = document.getElementById('pld-search-input');
  if (searchInput) searchInput.value = '';
  renderPldSearch();
  renderPldRows();
}

function renderPldRows() {
  const tbody = document.getElementById('pld-tbody');
  if (!pldCurrent.songs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${pldCurrent.isOwner ? 'Liste vide. Ajoute des musiques ci-dessus.' : 'Cette liste est vide.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = pldCurrent.songs.map((s) => {
    const playBtn = s.videoUrl
      ? `<button class="btn-play-row" data-pld-play data-sid="${s.id}" data-src="${escapeHtml(s.videoUrl)}" title="Écouter"><i class="fas fa-play"></i></button>`
      : '';
    const removeBtn = pldCurrent.isOwner
      ? `<button class="btn-play-row pl-remove" data-pld-remove data-sid="${s.id}" title="Retirer"><i class="fas fa-trash"></i></button>`
      : '';
    return `<tr data-sid="${s.id}">
      <td class="cat-play-cell">${playBtn}</td>
      <td><span class="pl-anime">${plCover(s)}<span>${escapeHtml(s.animeTitle)}${plFormatIcon(s.format)}</span></span></td>
      <td class="nowrap">${plTypeBadge(s)}</td>
      <td>${escapeHtml(s.title)}</td>
      <td>${escapeHtml(s.artist || '—')}</td>
      <td class="cat-play-cell">${removeBtn}</td>
    </tr>`;
  }).join('');
}

// Lecteur audio de la vue détail : un seul extrait à la fois (même pattern que catalog.js)
let pldPlayingBtn = null;
function stopPlaylistDetailAudio() {
  const audio = document.getElementById('pld-audio');
  if (!audio) return;
  audio.pause();
  if (pldPlayingBtn) { const i = pldPlayingBtn.querySelector('i'); if (i) i.className = 'fas fa-play'; pldPlayingBtn = null; }
}
function togglePldAudio(btn) {
  const audio = document.getElementById('pld-audio');
  if (pldPlayingBtn === btn) {
    if (audio.paused) { audio.play().catch(() => {}); btn.querySelector('i').className = 'fas fa-pause'; }
    else { audio.pause(); btn.querySelector('i').className = 'fas fa-play'; }
    return;
  }
  if (pldPlayingBtn) { const i = pldPlayingBtn.querySelector('i'); if (i) i.className = 'fas fa-play'; }
  pldPlayingBtn = btn;
  audio.src = btn.dataset.src;
  audio.volume = getVolume();
  audio.play().catch(() => {});
  btn.querySelector('i').className = 'fas fa-pause';
  audio.onended = () => stopPlaylistDetailAudio();
}

async function removeSongFromPlaylistDetail(songId) {
  try {
    await api(`/api/playlists/${pldCurrent.id}/songs/${songId}`, { method: 'DELETE' });
    pldCurrent.songs = pldCurrent.songs.filter((s) => s.id !== songId);
    document.getElementById('pld-count').textContent = `${pldCurrent.songs.length} musique${pldCurrent.songs.length > 1 ? 's' : ''}`;
    renderPldRows();
    renderPldSearch(); // rebascule les boutons « Ajouté » concernés
  } catch (e) {
    alert(e.message);
  }
}

async function deleteCurrentPlaylist() {
  if (!confirm(`Supprimer définitivement la liste « ${pldCurrent.name} » ?`)) return;
  try {
    await api(`/api/playlists/${pldCurrent.id}`, { method: 'DELETE' });
    openPlaylists();
  } catch (e) {
    alert(e.message);
  }
}

async function clonePlaylistToMine() {
  const btn = document.getElementById('pld-clone-btn');
  btn.disabled = true;
  try {
    const { playlist } = await api(`/api/playlists/${pldCurrent.id}/clone`, { method: 'POST' });
    await openPlaylistDetail(playlist.id);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
}

// ── Recherche-ajout dans la liste ouverte (même mécanique que playlist.js) ──
async function loadPldSearch(page = 1) {
  pldSearchPage = Math.max(1, page);
  const results = document.getElementById('pld-search-results');
  if (!results) return;
  if (!pldSearchQuery) { pldSearchResults = []; renderPldSearch(); return; }
  results.innerHTML = '<p class="muted">Recherche…</p>';
  try {
    const qs = new URLSearchParams({ search: pldSearchQuery, page: String(pldSearchPage) });
    const data = await api('/api/catalog/list?' + qs.toString());
    pldSearchResults = data.songs || [];
    pldSearchPages = data.pages || 1;
    renderPldSearch();
  } catch (e) {
    results.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function renderPldSearch() {
  const results = document.getElementById('pld-search-results');
  const pager = document.getElementById('pld-search-pager');
  if (!results) return;
  if (!pldSearchQuery) { results.innerHTML = ''; if (pager) pager.innerHTML = ''; return; }
  const inList = new Set((pldCurrent?.songs || []).map((s) => s.id));
  results.innerHTML = pldSearchResults.length
    ? pldSearchResults.map((s) => {
        const playBtn = s.videoUrl
          ? `<button class="btn-play-row" data-pld-search-play data-src="${escapeHtml(s.videoUrl)}" title="Écouter"><i class="fas fa-play"></i></button>`
          : '<span class="btn-play-row placeholder"></span>';
        const added = inList.has(s.id);
        const addBtn = added
          ? '<span class="pl-search-added"><i class="fas fa-check"></i> Ajouté</span>'
          : `<button class="pl-search-add" data-pld-search-add data-sid="${s.id}"><i class="fas fa-plus"></i> Ajouter</button>`;
        return `<div class="pl-search-row" data-sid="${s.id}">
          ${playBtn}
          ${plCover(s)}
          <div class="pl-search-info"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.animeTitle)} · ${plTypeBadge(s)}${s.artist ? ` · ${escapeHtml(s.artist)}` : ''}</span></div>
          ${addBtn}
        </div>`;
      }).join('')
    : '<p class="muted">Aucun résultat.</p>';
  if (pager) {
    if (pldSearchPages <= 1) pager.innerHTML = '';
    else {
      const p = pldSearchPage;
      pager.innerHTML = `
        <button class="btn-secondary shop-page" data-pld-search-page="${p - 1}"${p <= 1 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
        <span class="shop-page-info">Page ${p} / ${pldSearchPages}</span>
        <button class="btn-secondary shop-page" data-pld-search-page="${p + 1}"${p >= pldSearchPages ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
    }
  }
}

async function addSongToPlaylistDetail(songId) {
  try {
    const { song } = await api(`/api/playlists/${pldCurrent.id}/songs`, { method: 'POST', body: JSON.stringify({ songId }) });
    pldCurrent.songs.unshift(song);
    document.getElementById('pld-count').textContent = `${pldCurrent.songs.length} musique${pldCurrent.songs.length > 1 ? 's' : ''}`;
    renderPldRows();
    renderPldSearch();
  } catch (e) {
    alert(e.message);
  }
}

function initPlaylistsUI() {
  document.getElementById('pls-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pltab]');
    if (b) switchPlsTab(b.dataset.pltab);
  });
  document.getElementById('pls-create-btn').addEventListener('click', () => openPlsEditModal(null));
  document.getElementById('pls-edit-close').addEventListener('click', closePlsEditModal);
  document.getElementById('pls-edit-save').addEventListener('click', savePlsEdit);
  document.getElementById('pls-mine-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-plid]');
    if (card) openPlaylistDetail(parseInt(card.dataset.plid));
  });
  document.getElementById('pls-discover-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-plid]');
    if (card) openPlaylistDetail(parseInt(card.dataset.plid));
  });
  document.getElementById('pls-discover-search').addEventListener('input', (e) => {
    clearTimeout(plsDiscoverSearchTimer);
    const v = e.target.value.trim();
    plsDiscoverSearchTimer = setTimeout(() => { plsDiscoverSearch = v; loadDiscoverPlaylists(1); }, 300);
  });
  document.getElementById('pls-discover-prev').addEventListener('click', () => loadDiscoverPlaylists(plsDiscoverPage - 1));
  document.getElementById('pls-discover-next').addEventListener('click', () => loadDiscoverPlaylists(plsDiscoverPage + 1));

  document.getElementById('back-collection-playlists').addEventListener('click', () => showView('collection'));
  document.getElementById('back-playlists-detail').addEventListener('click', openPlaylists);
  document.getElementById('pld-edit-btn').addEventListener('click', () => openPlsEditModal(pldCurrent));
  document.getElementById('pld-delete-btn').addEventListener('click', deleteCurrentPlaylist);
  document.getElementById('pld-clone-btn').addEventListener('click', clonePlaylistToMine);

  document.getElementById('pld-tbody').addEventListener('click', (e) => {
    const play = e.target.closest('[data-pld-play]');
    if (play) return togglePldAudio(play);
    const rm = e.target.closest('[data-pld-remove]');
    if (rm) return removeSongFromPlaylistDetail(parseInt(rm.dataset.sid));
  });

  const pldSearchInput = document.getElementById('pld-search-input');
  if (pldSearchInput) {
    pldSearchInput.addEventListener('input', (e) => {
      clearTimeout(pldSearchTimer);
      const v = e.target.value.trim();
      pldSearchTimer = setTimeout(() => { pldSearchQuery = v; loadPldSearch(1); }, 300);
    });
  }
  const pldSearchResultsEl = document.getElementById('pld-search-results');
  if (pldSearchResultsEl) {
    pldSearchResultsEl.addEventListener('click', (e) => {
      const add = e.target.closest('[data-pld-search-add]');
      if (add) return addSongToPlaylistDetail(parseInt(add.dataset.sid));
      const play = e.target.closest('[data-pld-search-play]');
      if (play) return togglePldAudio(play);
    });
  }
  const pldSearchPager = document.getElementById('pld-search-pager');
  if (pldSearchPager) {
    pldSearchPager.addEventListener('click', (e) => {
      const pg = e.target.closest('[data-pld-search-page]');
      if (pg && !pg.disabled) loadPldSearch(parseInt(pg.dataset.pldSearchPage, 10));
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPlaylistsUI);

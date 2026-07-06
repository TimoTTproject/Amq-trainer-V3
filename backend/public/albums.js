// Mes albums — collections de cartes nommées, partageables entre joueurs.
// Vit dans l'onglet « Albums » du gacha (#gacha-panel-albums, cf. gacha.js pour
// les onglets Tirage/Vedettes/Collection/Par série). Script classique à scope
// global partagé, chargé après gacha.js (réutilise cardHTML/RARITY_LABELS) et
// après main.js (currentUser, api, escapeHtml, otherAvatar, showView…).
// Mêmes patterns que playlists.js, pour les cartes plutôt que les musiques.
// Ne pas charger comme module ES.

let albsTab = 'mine';
let albsDiscoverPage = 1, albsDiscoverPages = 1, albsDiscoverSearch = '';
let albsDiscoverSearchTimer = null;
let albsEditingId = null; // id de l'album en édition (mode 'edit')
let albsEditMode = 'create'; // 'create' | 'edit'
let albsEditOnCreated = null; // callback optionnel après création (picker de la fiche carte)
let albsMineData = []; // cache brut de « Mes albums » (pour filtrer/trier sans recharger)
let albsFilter = 'all'; // 'all' | 'public' | 'private'
let albsSort = 'recent'; // 'recent' | 'name' | 'count'
let albsSearch = '';

function switchAlbsTab(tab) {
  albsTab = tab;
  document.querySelectorAll('#albs-tabs .shop-tab').forEach((b) => b.classList.toggle('active', b.dataset.albtab === tab));
  document.getElementById('albs-panel-mine').classList.toggle('hidden', tab !== 'mine');
  document.getElementById('albs-panel-discover').classList.toggle('hidden', tab !== 'discover');
  if (tab === 'mine') loadMyAlbums();
  else loadDiscoverAlbums(1);
}

function albsBadge(a) {
  return a.isPublic
    ? '<span class="pls-badge pub"><i class="fas fa-globe"></i> Publique</span>'
    : '<span class="pls-badge priv"><i class="fas fa-lock"></i> Privée</span>';
}

async function loadMyAlbums() {
  const grid = document.getElementById('albs-mine-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { albums } = await api('/api/albums/mine');
    albsMineData = albums;
    renderMyAlbums();
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// Filtre (public/privé) et tri (récent/nom/nb de cartes), appliqués côté
// client sur le cache déjà chargé — même mécanique que le filtre de rareté
// de la Collection (pas besoin de retaper le serveur pour ça).
function renderMyAlbums() {
  const grid = document.getElementById('albs-mine-grid');
  if (!albsMineData.length) {
    grid.innerHTML = '<p class="muted">Aucun album pour l\'instant. Crée-en un pour commencer !</p>';
    return;
  }
  const q = albsSearch.trim().toLowerCase();
  let list = albsMineData.filter((a) => {
    if (albsFilter === 'public' && !a.isPublic) return false;
    if (albsFilter === 'private' && a.isPublic) return false;
    if (q && !a.name.toLowerCase().includes(q)) return false;
    return true;
  });
  if (albsSort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (albsSort === 'count') list = [...list].sort((a, b) => b.cardCount - a.cardCount);
  else list = [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  grid.innerHTML = list.length
    ? list.map((a) => `
      <button type="button" class="pls-card" data-albid="${a.id}">
        <div class="pls-card-top"><h4>${escapeHtml(a.name)}</h4>${albsBadge(a)}</div>
        ${a.description ? `<p class="pls-card-desc">${escapeHtml(a.description)}</p>` : ''}
        <span class="pls-card-count"><i class="fas fa-layer-group"></i> ${a.cardCount} carte${a.cardCount > 1 ? 's' : ''}</span>
      </button>`).join('')
    : '<p class="muted">Aucun album dans ce filtre.</p>';
}

async function loadDiscoverAlbums(page) {
  if (page < 1) return;
  albsDiscoverPage = page;
  const grid = document.getElementById('albs-discover-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const qs = new URLSearchParams({ page: String(page), search: albsDiscoverSearch });
    const r = await api('/api/albums/public?' + qs.toString());
    albsDiscoverPages = r.pages || 1;
    if (!r.albums.length) {
      grid.innerHTML = '<p class="muted">Aucun album public trouvé.</p>';
    } else {
      grid.innerHTML = r.albums.map((a) => `
        <button type="button" class="pls-card" data-albid="${a.id}">
          <div class="pls-card-top"><h4>${escapeHtml(a.name)}</h4></div>
          ${a.description ? `<p class="pls-card-desc">${escapeHtml(a.description)}</p>` : ''}
          <div class="pls-card-creator">${otherAvatar(a.creator, 'avatar-xs')}<span>${escapeHtml(a.creator.displayName)}</span></div>
          <span class="pls-card-count"><i class="fas fa-layer-group"></i> ${a.cardCount} carte${a.cardCount > 1 ? 's' : ''}</span>
        </button>`).join('');
    }
    document.getElementById('albs-discover-pageinfo').textContent = `Page ${r.page} / ${albsDiscoverPages}`;
    document.getElementById('albs-discover-prev').disabled = r.page <= 1;
    document.getElementById('albs-discover-next').disabled = r.page >= albsDiscoverPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── Modale création / édition ──
// opts.onCreated(album) : si fourni, appelé après création au lieu de naviguer
// vers le détail (utilisé par le picker « Ranger dans un album » de la fiche carte).
function openAlbsEditModal(album, opts = {}) {
  albsEditMode = album ? 'edit' : 'create';
  albsEditingId = album ? album.id : null;
  albsEditOnCreated = opts.onCreated || null;
  const titleEl = document.getElementById('albs-edit-title');
  titleEl.innerHTML = albsEditMode === 'edit' ? '<i class="fas fa-pen"></i> Modifier l\'album' : '<i class="fas fa-book"></i> Nouvel album';
  document.getElementById('albs-edit-name').value = album ? album.name : '';
  document.getElementById('albs-edit-desc').value = album ? (album.description || '') : '';
  document.getElementById('albs-edit-public').checked = album ? album.isPublic : true;
  document.getElementById('albs-edit-error').textContent = '';
  document.getElementById('albs-edit-modal').classList.remove('hidden');
  document.getElementById('albs-edit-name').focus();
}
function closeAlbsEditModal() {
  document.getElementById('albs-edit-modal').classList.add('hidden');
}

async function saveAlbsEdit() {
  const name = document.getElementById('albs-edit-name').value.trim();
  const description = document.getElementById('albs-edit-desc').value.trim();
  const isPublic = document.getElementById('albs-edit-public').checked;
  const errEl = document.getElementById('albs-edit-error');
  if (!name) { errEl.textContent = 'Un nom est requis.'; return; }
  const btn = document.getElementById('albs-edit-save');
  btn.disabled = true;
  try {
    if (albsEditMode === 'edit') {
      await api(`/api/albums/${albsEditingId}`, { method: 'PATCH', body: JSON.stringify({ name, description, isPublic }) });
      closeAlbsEditModal();
      await openAlbumDetail(albsEditingId);
    } else {
      const { album } = await api('/api/albums', { method: 'POST', body: JSON.stringify({ name, description, isPublic }) });
      closeAlbsEditModal();
      if (albsEditOnCreated) await albsEditOnCreated(album);
      else await openAlbumDetail(album.id);
    }
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Détail d'un album ──
let aldCurrent = null; // { id, isOwner, cards, … }
let aldOwnedCards = null; // cache des cartes possédées (pour la recherche-ajout)
let aldSearchQuery = ''; // recherche dans le picker « Ajouter des cartes »
let aldFilter = 'all'; // 'all' | rareté — filtre les cartes DÉJÀ dans l'album
let aldSort = 'rarity'; // 'rarity' | 'name' | 'recent'
let aldFilterSearch = ''; // recherche dans les cartes DÉJÀ dans l'album

function openAlbumsHub() {
  showView('gacha-albums');
  if (typeof setGachaTab === 'function') setGachaTab('albums');
}

async function openAlbumDetail(id) {
  showView('album-detail');
  document.getElementById('ald-grid').innerHTML = '<p class="muted">Chargement…</p>';
  document.getElementById('ald-name').innerHTML = '<i class="fas fa-book"></i> —';
  document.getElementById('ald-creator').textContent = '';
  document.getElementById('ald-desc').classList.add('hidden');
  try {
    aldCurrent = await api(`/api/albums/${id}`);
  } catch (e) {
    document.getElementById('ald-grid').innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
    return;
  }
  document.getElementById('ald-name').innerHTML = `<i class="fas fa-book"></i> ${escapeHtml(aldCurrent.name)}`;
  document.getElementById('ald-count').textContent = `${aldCurrent.cards.length} carte${aldCurrent.cards.length > 1 ? 's' : ''}`;
  document.getElementById('ald-creator').textContent = aldCurrent.isOwner
    ? (aldCurrent.isPublic ? 'Ton album · public' : 'Ton album · privé')
    : `Par ${aldCurrent.creator.displayName}`;
  const descEl = document.getElementById('ald-desc');
  if (aldCurrent.description) { descEl.textContent = aldCurrent.description; descEl.classList.remove('hidden'); }
  document.getElementById('ald-owner-actions').classList.toggle('hidden', !aldCurrent.isOwner);
  document.getElementById('ald-clone-wrap').classList.toggle('hidden', aldCurrent.isOwner);
  document.getElementById('ald-search-section').classList.toggle('hidden', !aldCurrent.isOwner);
  aldOwnedCards = null; aldSearchQuery = '';
  aldFilter = 'all'; aldSort = 'rarity'; aldFilterSearch = '';
  const searchInput = document.getElementById('ald-search-input');
  if (searchInput) searchInput.value = '';
  const filterSearchInput = document.getElementById('ald-filter-search');
  if (filterSearchInput) filterSearchInput.value = '';
  document.getElementById('ald-sort').value = 'rarity';
  if (aldCurrent.isOwner) renderAldSearch();
  renderAldFilters();
  renderAldGrid();
}

// Chips de filtre par rareté sur les cartes DÉJÀ dans l'album (effectifs locaux).
function renderAldFilters() {
  const byRarity = {};
  aldCurrent.cards.forEach((c) => (byRarity[c.rarity] = (byRarity[c.rarity] || 0) + 1));
  document.getElementById('ald-filters').innerHTML = typeof rarityFilterChips === 'function'
    ? rarityFilterChips(byRarity, aldFilter) : '';
}

function renderAldGrid() {
  const grid = document.getElementById('ald-grid');
  if (!aldCurrent.cards.length) {
    grid.innerHTML = `<p class="muted">${aldCurrent.isOwner ? 'Album vide. Ajoute des cartes ci-dessus.' : 'Cet album est vide.'}</p>`;
    return;
  }
  const q = aldFilterSearch.trim().toLowerCase();
  let list = aldCurrent.cards.filter((c) => (aldFilter === 'all' || c.rarity === aldFilter) && (!q || c.name.toLowerCase().includes(q)));
  if (aldSort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (aldSort === 'rarity') {
    const rank = (r) => RARITY_ORDER.indexOf(r);
    list = [...list].sort((a, b) => rank(a.rarity) - rank(b.rarity) || a.name.localeCompare(b.name));
  }
  // 'recent' : garde l'ordre reçu du serveur (déjà trié par addedAt desc).
  if (!list.length) { grid.innerHTML = '<p class="muted">Aucune carte ne correspond.</p>'; return; }
  grid.innerHTML = list.map((c) => {
    const removeBtn = aldCurrent.isOwner
      ? `<button class="alb-card-remove" data-ald-remove data-cid="${c.id}" title="Retirer de l'album"><i class="fas fa-trash"></i></button>`
      : '';
    return `<div class="alb-card-wrap">${cardHTML(c)}${removeBtn}</div>`;
  }).join('');
}

async function removeCardFromAlbumDetail(characterId) {
  try {
    await api(`/api/albums/${aldCurrent.id}/cards/${characterId}`, { method: 'DELETE' });
    aldCurrent.cards = aldCurrent.cards.filter((c) => c.id !== characterId);
    document.getElementById('ald-count').textContent = `${aldCurrent.cards.length} carte${aldCurrent.cards.length > 1 ? 's' : ''}`;
    renderAldGrid();
    renderAldSearch();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteCurrentAlbum() {
  if (!confirm(`Supprimer définitivement l'album « ${aldCurrent.name} » ?`)) return;
  try {
    await api(`/api/albums/${aldCurrent.id}`, { method: 'DELETE' });
    openAlbumsHub();
  } catch (e) {
    alert(e.message);
  }
}

async function cloneAlbumToMine() {
  const btn = document.getElementById('ald-clone-btn');
  btn.disabled = true;
  try {
    const { album } = await api(`/api/albums/${aldCurrent.id}/clone`, { method: 'POST' });
    await openAlbumDetail(album.id);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
}

// ── Recherche-ajout dans l'album ouvert : parmi les cartes qu'on possède ──
async function loadAldOwnedCards() {
  if (aldOwnedCards) return aldOwnedCards;
  const { cards } = await api('/api/gacha/collection');
  aldOwnedCards = cards;
  return cards;
}

async function renderAldSearch() {
  const results = document.getElementById('ald-search-results');
  if (!results) return;
  results.innerHTML = '<p class="muted">Chargement…</p>';
  let owned;
  try {
    owned = await loadAldOwnedCards();
  } catch (e) {
    results.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!owned.length) { results.innerHTML = '<p class="muted">Tu ne possèdes encore aucune carte — direction le tirage !</p>'; return; }
  const q = aldSearchQuery.trim().toLowerCase();
  const matches = q ? owned.filter((c) => c.name.toLowerCase().includes(q) || (c.series || '').toLowerCase().includes(q)) : owned;
  if (!matches.length) { results.innerHTML = '<p class="muted">Aucune carte possédée ne correspond.</p>'; return; }
  const inAlbum = new Set((aldCurrent?.cards || []).map((c) => c.id));
  results.innerHTML = matches.map((c) => {
    const added = inAlbum.has(c.id);
    const wrap = `<div class="alb-card-wrap" data-cid="${c.id}">${cardHTML(c)}
      ${added
        ? '<span class="alb-search-added"><i class="fas fa-check"></i> Ajouté</span>'
        : `<button class="alb-search-add" data-ald-search-add data-cid="${c.id}"><i class="fas fa-plus"></i> Ajouter</button>`}
    </div>`;
    return wrap;
  }).join('');
}

async function addCardToAlbumDetail(characterId) {
  try {
    const { card } = await api(`/api/albums/${aldCurrent.id}/cards`, { method: 'POST', body: JSON.stringify({ characterId }) });
    aldCurrent.cards.unshift(card);
    document.getElementById('ald-count').textContent = `${aldCurrent.cards.length} carte${aldCurrent.cards.length > 1 ? 's' : ''}`;
    renderAldGrid();
    renderAldSearch();
  } catch (e) {
    alert(e.message);
  }
}

function initAlbumsUI() {
  document.getElementById('albs-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-albtab]');
    if (b) switchAlbsTab(b.dataset.albtab);
  });
  document.getElementById('albs-create-btn').addEventListener('click', () => openAlbsEditModal(null));
  document.getElementById('albs-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-albfilter]');
    if (!btn) return;
    albsFilter = btn.dataset.albfilter;
    document.querySelectorAll('#albs-filters .coll-chip').forEach((c) => c.classList.toggle('active', c.dataset.albfilter === albsFilter));
    renderMyAlbums();
  });
  document.getElementById('albs-sort').addEventListener('change', (e) => {
    albsSort = e.target.value;
    renderMyAlbums();
  });
  let albsSearchTimer;
  document.getElementById('albs-search').addEventListener('input', (e) => {
    clearTimeout(albsSearchTimer);
    albsSearchTimer = setTimeout(() => { albsSearch = e.target.value; renderMyAlbums(); }, 200);
  });
  document.getElementById('albs-edit-close').addEventListener('click', closeAlbsEditModal);
  document.getElementById('albs-edit-save').addEventListener('click', saveAlbsEdit);
  document.getElementById('albs-mine-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-albid]');
    if (card) openAlbumDetail(parseInt(card.dataset.albid));
  });
  document.getElementById('albs-discover-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-albid]');
    if (card) openAlbumDetail(parseInt(card.dataset.albid));
  });
  document.getElementById('albs-discover-search').addEventListener('input', (e) => {
    clearTimeout(albsDiscoverSearchTimer);
    const v = e.target.value.trim();
    albsDiscoverSearchTimer = setTimeout(() => { albsDiscoverSearch = v; loadDiscoverAlbums(1); }, 300);
  });
  document.getElementById('albs-discover-prev').addEventListener('click', () => loadDiscoverAlbums(albsDiscoverPage - 1));
  document.getElementById('albs-discover-next').addEventListener('click', () => loadDiscoverAlbums(albsDiscoverPage + 1));

  document.getElementById('back-albums-detail').addEventListener('click', openAlbumsHub);
  document.getElementById('ald-edit-btn').addEventListener('click', () => openAlbsEditModal(aldCurrent));
  document.getElementById('ald-delete-btn').addEventListener('click', deleteCurrentAlbum);
  document.getElementById('ald-clone-btn').addEventListener('click', cloneAlbumToMine);

  document.getElementById('ald-grid').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-ald-remove]');
    if (rm) return removeCardFromAlbumDetail(parseInt(rm.dataset.cid));
    const card = e.target.closest('.gcard[data-cid]');
    if (card && !e.target.closest('[data-ald-remove]')) openCharacter(card.dataset.cid);
  });

  document.getElementById('ald-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    aldFilter = btn.dataset.filter;
    renderAldFilters();
    renderAldGrid();
  });
  document.getElementById('ald-sort').addEventListener('change', (e) => {
    aldSort = e.target.value;
    renderAldGrid();
  });
  let aldFilterSearchTimer;
  document.getElementById('ald-filter-search').addEventListener('input', (e) => {
    clearTimeout(aldFilterSearchTimer);
    aldFilterSearchTimer = setTimeout(() => { aldFilterSearch = e.target.value; renderAldGrid(); }, 200);
  });

  const aldSearchInput = document.getElementById('ald-search-input');
  if (aldSearchInput) {
    let aldSearchTimer = null;
    aldSearchInput.addEventListener('input', (e) => {
      clearTimeout(aldSearchTimer);
      const v = e.target.value.trim();
      aldSearchTimer = setTimeout(() => { aldSearchQuery = v; renderAldSearch(); }, 300);
    });
  }
  document.getElementById('ald-search-results').addEventListener('click', (e) => {
    const add = e.target.closest('[data-ald-search-add]');
    if (add) return addCardToAlbumDetail(parseInt(add.dataset.cid));
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAlbumsUI);

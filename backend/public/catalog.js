// Catalogue — extrait de main.js (script classique, scope global partagé).
// Chargé AVANT main.js dans index.html. Réutilise des globals définis ailleurs
// (currentUser, api, escapeHtml, settings…) ; gacha.js définit RARITY_LABELS/ORDER
// utilisés ici et dans le profil. Ne pas charger comme module ES.

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

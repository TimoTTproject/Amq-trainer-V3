// Gacha, boutique, stats de tirage, fiche personnage — extrait de main.js (script classique, scope global partagé).
// Chargé AVANT main.js dans index.html. Réutilise des globals définis ailleurs
// (currentUser, api, escapeHtml, settings…) ; gacha.js définit RARITY_LABELS/ORDER
// utilisés ici et dans le profil. Ne pas charger comme module ES.

// ── GACHA ──
const RARITY_LABELS = { common: 'Commun', rare: 'Rare', epic: 'Épique', legendary: 'Légendaire', mythic: 'Mythique' };
const RARITY_ORDER = ['mythic', 'legendary', 'epic', 'rare', 'common'];
const FUSE_COUNT = 3; // doit rester égal à FUSE_COUNT dans src/gacha/rarity.js (fusion Atelier)

function setGachaTokens() {
  document.getElementById('gacha-tokens').textContent = currentUser.tokens;
}

// Onglets du gacha : Tirage / Vedettes & vote / Collection
function setGachaTab(name) {
  document.querySelectorAll('#gacha-tabs .shop-tab').forEach((b) => b.classList.toggle('active', b.dataset.gtab === name));
  document.getElementById('gacha-panel-pull').classList.toggle('hidden', name !== 'pull');
  document.getElementById('gacha-panel-events').classList.toggle('hidden', name !== 'events');
  document.getElementById('gacha-panel-collection').classList.toggle('hidden', name !== 'collection');
  document.getElementById('gacha-panel-series').classList.toggle('hidden', name !== 'series');
  document.getElementById('gacha-panel-albums').classList.toggle('hidden', name !== 'albums');
  // Recharge à chaque clic d'onglet (pas seulement à l'entrée dans Gacha) :
  // sinon une donnée changée pendant que la vue Gacha était déjà ouverte
  // (ex. rareté recalculée par un admin) reste figée jusqu'à sortie/re-entrée.
  if (name === 'collection') loadCollection();
  if (name === 'series') loadSeriesProgress();
  if (name === 'albums' && typeof loadMyAlbums === 'function') loadMyAlbums();
}
function onGachaTabClick(e) {
  const b = e.target.closest('.shop-tab');
  if (b) setGachaTab(b.dataset.gtab);
}

async function openGacha() {
  showView('gacha');
  setGachaTab('pull');
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
  loadVotePanel();
  loadCollection();
}

// Panneau de vote : un vote par rareté (mythique/légendaire/épique), un petit
// cadre par catégorie — chaque joueur choisit un candidat dans chacun.
const VOTE_RARITY_ORDER = ['mythic', 'legendary', 'epic'];
async function loadVotePanel() {
  const el = document.getElementById('gacha-vote');
  if (!el) return;
  let d;
  try { d = await api('/api/gacha/vote'); } catch { el.innerHTML = ''; return; }
  const left = Math.max(0, (d.closesAt || 0) - Date.now());
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const countdown = days > 0 ? `${days}j ${hours}h` : `${hours}h`;

  const frames = VOTE_RARITY_ORDER.map((rarity) => {
    const group = (d.byRarity && d.byRarity[rarity]) || { candidates: [], myVote: null };
    const cards = group.candidates.length
      ? group.candidates.map((c) => `
          <button class="vote-cand${c.id === group.myVote ? ' mine' : ''}" data-vote-id="${c.id}">
            <span class="avatar avatar-sm" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></span>
            <span class="vote-cand-name">${escapeHtml(c.name)}</span>
            <span class="vote-count">${c.votes} ✋</span>
          </button>`).join('')
      : '<p class="muted">Candidats indisponibles pour l\'instant.</p>';
    const mine = group.myVote
      ? `Ton vote : <b>${escapeHtml((group.candidates.find((c) => c.id === group.myVote) || {}).name || 'enregistré')}</b>`
      : 'Choisis un candidat pour voter.';
    // Vote de TOUS les joueurs : chacun a des candidats tirés au sort différents,
    // donc sans ça on ne voit jamais ce que les autres joueurs ont sous les yeux.
    const globalList = (d.globalByRarity && d.globalByRarity[rarity]) || [];
    const globalRows = globalList.length
      ? globalList.map((c) => `
          <div class="vote-global-row">
            <span class="avatar avatar-xs" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></span>
            <span class="vote-global-name">${escapeHtml(c.name)}</span>
            <span class="vote-count">${c.votes} ✋</span>
          </div>`).join('')
      : '<p class="hint">Personne n\'a encore voté.</p>';
    return `
      <div class="vote-frame">
        <div class="vote-frame-head r-${rarity}">${RARITY_LABELS[rarity] || rarity}</div>
        <div class="vote-list">${cards}</div>
        <p class="vote-mine">${mine}</p>
        <div class="vote-global">
          <h5>Vote de tous les joueurs</h5>
          <div class="vote-global-list">${globalRows}</div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="vote-head">
      <span><i class="fas fa-check-to-slot"></i> Vote : vedettes de la semaine prochaine</span>
      <span class="weekly-timer"><i class="fas fa-clock"></i> ${countdown}</span>
    </div>
    <div class="vote-frames">${frames}</div>`;
  el.querySelectorAll('[data-vote-id]').forEach((b) =>
    b.addEventListener('click', () => castVote(parseInt(b.dataset.voteId)))
  );
}

async function castVote(characterId) {
  try {
    await api('/api/gacha/vote', { method: 'POST', body: JSON.stringify({ characterId }) });
    if (typeof sfx !== 'undefined' && sfx.correct) sfx.correct();
    loadVotePanel();
  } catch (e) { alert(e.message); }
}

// Bannière « vedettes de la semaine » + compte à rebours
function renderWeeklyBanner(info) {
  // Affichée à la fois dans l'onglet Tirage (pour la voir avant de dépenser
  // ses tokens) et dans Vedettes & vote — deux éléments `.gacha-weekly`, donc
  // pas d'id unique pour le contenu généré (querySelector scopé à chaque élément).
  const els = document.querySelectorAll('.gacha-weekly');
  if (!els.length) return;
  const chars = info.weeklyFeatured || [];
  let html = '';
  if (chars.length) {
    const left = Math.max(0, (info.weeklyResetAt || 0) - Date.now());
    const days = Math.floor(left / 86400000);
    const hours = Math.floor((left % 86400000) / 3600000);
    const countdown = days > 0 ? `${days}j ${hours}h` : `${hours}h`;
    const boostOn = currentUser.bannerBoostEnabled !== false;
    html = `
      <div class="weekly-head">
        <span><i class="fas fa-star"></i> Vedettes de la semaine <span class="weekly-boost">+${info.weeklyBoost || 60}% de chance</span></span>
        <span class="weekly-timer"><i class="fas fa-clock"></i> ${countdown}</span>
      </div>
      <div class="featured-row">${chars.map((c) => cardHTML(c)).join('')}</div>
      <label class="weekly-boost-toggle">
        <input type="checkbox" class="weekly-boost-input" ${boostOn ? 'checked' : ''}>
        Utiliser le rate-up de cette bannière sur mes tirages
      </label>`;
  }
  els.forEach((el) => {
    el.innerHTML = html;
    el.querySelector('.weekly-boost-input')?.addEventListener('change', (e) => toggleBannerBoost(e.target.checked));
  });
}

async function toggleBannerBoost(enabled) {
  try {
    await api('/api/gacha/banner-boost', { method: 'POST', body: JSON.stringify({ enabled }) });
    currentUser.bannerBoostEnabled = enabled;
  } catch (e) { alert(e.message); }
}

function renderGachaMeta(pityLimit = 60) {
  const pity = currentUser.pity || 0;
  const pct = Math.min(100, Math.round((pity / pityLimit) * 100));
  document.getElementById('gacha-meta').innerHTML = `
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
  const stars = c.stars > 1 ? `<div class="gcard-stars">${'★'.repeat(Math.min(5, c.stars))}</div>` : '';
  return `<div class="${cls}"${styleAttr}${cid}>
    <div class="gcard-img" ${img}>${stars}</div>
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
  const backIcon = cb && cb.image ? '' : ((cb && cb.icon) || 'fa-music');
  return `<div class="flip-card r-${c.rarity}" data-cid="${c.id}" style="animation-delay:${(i * 0.08).toFixed(2)}s">
    <div class="flip-inner">
      <div class="flip-face flip-back${cosmClass(cb)}" style="${cosmStyle(cb)}"><div class="flip-back-inner">${backIcon ? `<i class="fas ${backIcon}"></i>` : ''}</div></div>
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
    if (typeof r.pity === 'number') currentUser.pity = r.pity;
    renderHeaderUser();
    setGachaTokens();
    renderGachaMeta(r.pityLimit);
    pullRefundMsg = r.refundTotal ? ` · ${r.refundTotal} 🪙` : '';
    pullCost = r.cost;
    const result = document.getElementById('pull-result');
    result.innerHTML = r.cards.map((c, i) => flipCardHTML(c, i)).join('');
    result.classList.remove('hidden');
    if (r.cards.length > 1) document.getElementById('reveal-all-btn').classList.remove('hidden');
    // Rareté tirée mais plus aucun personnage dispo dedans (pool en cours de
    // rééquilibrage) : jamais rétrogradé en silence, remboursé à la place.
    const unavailNote = r.unavailableCount
      ? ` — ${r.unavailableCount} tirage(s) sans personnage disponible dans leur rareté, remboursé(s) (+${r.unavailableRefund} 🪙)`
      : '';
    document.getElementById('gacha-msg').textContent = `−${r.cost} 🪙 — clique sur les cartes pour les retourner ! 🎴${unavailNote}`;
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
    grid.innerHTML = `<div class="empty-state">
      <p class="muted">Aucune carte pour l'instant.</p>
      <button class="btn-primary" id="collection-empty-pull"><i class="fas fa-ticket"></i> Faire mon premier tirage</button>
    </div>`;
    const btn = document.getElementById('collection-empty-pull');
    if (btn) btn.addEventListener('click', () => setGachaTab('pull'));
    return;
  }
  let list = collectionCards.filter((c) => collFilter === 'all' || c.rarity === collFilter);
  const rank = (r) => RARITY_ORDER.indexOf(r); // 0 = mythic … (du plus rare au plus commun)
  const st = (c) => c.stars || 1;
  if (collSort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  else if (collSort === 'copies') list = [...list].sort((a, b) => b.copies - a.copies || rank(a.rarity) - rank(b.rarity));
  else if (collSort === 'stars') list = [...list].sort((a, b) => st(b) - st(a) || rank(a.rarity) - rank(b.rarity) || a.name.localeCompare(b.name));
  // Par défaut (rareté) : à rareté égale, les cartes ascensionnées (★) remontent.
  else list = [...list].sort((a, b) => rank(a.rarity) - rank(b.rarity) || st(b) - st(a) || a.name.localeCompare(b.name));
  grid.innerHTML = list.length
    ? list.map((c) => cardHTML(c)).join('')
    : '<p class="muted">Aucune carte dans ce filtre.</p>';
}

// ── Onglet « Par série » : progression de complétion, anime par anime ──
let seriesProgressData = [];
let seriesSearch = '';

async function loadSeriesProgress() {
  const list = document.getElementById('series-progress-list');
  list.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { series } = await api('/api/gacha/collection/series');
    seriesProgressData = series;
    renderSeriesSpotlight();
    renderSeriesProgressList();
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// Met en avant la série la plus « remplie » (le plus de cartes possédées EN
// VALEUR ABSOLUE, pas en % — une 8/20 passe avant une 2/2) — motive à
// continuer celle-ci en premier.
function renderSeriesSpotlight() {
  const box = document.getElementById('series-spotlight');
  const owned = seriesProgressData.filter((s) => s.owned > 0);
  if (!owned.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const best = [...owned].sort((a, b) => b.owned - a.owned || b.total - a.total)[0];
  const pct = Math.round((best.owned / best.total) * 100);
  const complete = best.owned >= best.total;
  const img = best.cover ? `style="background-image:url('${best.cover}')"` : '';
  box.classList.remove('hidden');
  box.innerHTML = `
    <span class="series-spotlight-kicker">${complete ? '<i class="fas fa-trophy"></i> Série complétée' : '<i class="fas fa-fire"></i> Ta série la plus avancée'}</span>
    <button type="button" class="series-spotlight-row" data-series="${escapeHtml(best.series)}">
      <div class="series-spotlight-cover" ${img}></div>
      <div class="series-row-body">
        <div class="series-row-top"><span class="series-row-name">${escapeHtml(best.series)}</span><span class="series-row-count">${best.owned}/${best.total} · ${pct}%</span></div>
        <div class="series-row-bar"><span style="width:${pct}%"></span></div>
      </div>
    </button>`;
}

function renderSeriesProgressList() {
  const list = document.getElementById('series-progress-list');
  const q = seriesSearch.trim().toLowerCase();
  const rows = q ? seriesProgressData.filter((s) => s.series.toLowerCase().includes(q)) : seriesProgressData;
  if (!rows.length) { list.innerHTML = '<p class="muted">Aucune série ne correspond.</p>'; return; }
  list.innerHTML = rows.map((s) => {
    const pct = s.total ? Math.round((s.owned / s.total) * 100) : 0;
    const complete = s.owned >= s.total && s.total > 0;
    const img = s.cover ? `style="background-image:url('${s.cover}')"` : '';
    return `<button type="button" class="series-row${complete ? ' complete' : ''}" data-series="${escapeHtml(s.series)}">
      <div class="series-row-cover" ${img}></div>
      <div class="series-row-body">
        <div class="series-row-top"><span class="series-row-name">${escapeHtml(s.series)}</span><span class="series-row-count">${s.owned}/${s.total}${complete ? ' <i class="fas fa-check-circle"></i>' : ''}</span></div>
        <div class="series-row-bar"><span style="width:${pct}%"></span></div>
      </div>
    </button>`;
  }).join('');
}

function openSeriesFilter(series) {
  const grid = document.getElementById('series-filtered-grid');
  const list = collectionCards.filter((c) => (c.series || 'Autre') === series);
  document.getElementById('series-progress-list').classList.add('hidden');
  document.getElementById('series-spotlight').classList.add('hidden');
  document.getElementById('series-clear-filter').classList.remove('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = list.length
    ? list.map((c) => cardHTML(c)).join('')
    : '<p class="muted">Aucune carte possédée de cette série pour l\'instant.</p>';
}

function closeSeriesFilter() {
  document.getElementById('series-progress-list').classList.remove('hidden');
  if (document.getElementById('series-spotlight').innerHTML) document.getElementById('series-spotlight').classList.remove('hidden');
  document.getElementById('series-clear-filter').classList.add('hidden');
  const grid = document.getElementById('series-filtered-grid');
  grid.classList.add('hidden');
  grid.innerHTML = '';
}

// ── Boutique de cosmétiques ─────────────────────────────────
let shopData = null;
// État de la section « Personnages » (catalogue paginé, filtrable)
let charShop = { series: '', q: '', page: 1, total: 0, pageSize: 24, items: [], seriesList: [] };
let charShellRendered = false;
let charLoaded = false; // chargé à la 1re ouverture de l'onglet Personnages
let charSearchTimer = null;

async function openShop() {
  showView('shop');
  document.getElementById('shop-tokens').textContent = currentUser.tokens;
  document.getElementById('shop-msg').textContent = '';
  setShopTab('cosmetics');
  charShellRendered = false;
  charLoaded = false;
  charShop = { series: '', q: '', page: 1, total: 0, pageSize: 24, items: [], seriesList: [] };
  document.getElementById('shop-characters').innerHTML = '';
  document.getElementById('shop-cosmetics').innerHTML = '<p class="muted">Chargement…</p>';
  try {
    shopData = await api('/api/shop');
    renderShop();
  } catch (e) {
    document.getElementById('shop-cosmetics').innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

// Onglets de la boutique : un seul panneau visible. L'onglet Personnages charge
// son catalogue paginé à la première ouverture (évite une requête inutile).
function setShopTab(name) {
  document.querySelectorAll('#shop-tabs .shop-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('shop-cosmetics').classList.toggle('hidden', name !== 'cosmetics');
  document.getElementById('shop-licenses-panel').classList.toggle('hidden', name !== 'licenses');
  document.getElementById('shop-emotes').classList.toggle('hidden', name !== 'emotes');
  document.getElementById('shop-characters').classList.toggle('hidden', name !== 'characters');
  if (name === 'characters' && !charLoaded) { charLoaded = true; loadCharShop(1); }
}
function onShopTabClick(e) {
  const b = e.target.closest('.shop-tab');
  if (b) setShopTab(b.dataset.tab);
}

// Aperçu visuel d'un item selon son slot
function shopPreview(slot, item) {
  const cls = item.className ? ' ' + item.className : '';
  const style = item.css || '';
  if (slot === 'cardBack') {
    // Dos « image » (licence) : pas d'icône par-dessus l'artwork.
    const inner = item.image ? '' : `<i class="fas ${item.icon || 'fa-music'}"></i>`;
    return `<span class="shop-prev shop-prev-back${cls}" style="${style}">${inner}</span>`;
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

// Étiquette courte du type d'un item (pour les sections « Licences » où le
// titre est la franchise, pas le slot).
const SLOT_SHORT = { cardBack: 'Dos de carte', cardBorder: 'Bordure', profileBanner: 'Bannière', avatarFrame: "Cadre d'avatar" };

// Rendu d'un item de boutique. `nameOverride` remplace le nom (sections licence
// où l'on affiche le type plutôt que « Franchise — Dos de carte »).
function shopItemHtml(item, nameOverride) {
  const equipped = item.equipped;
  let action;
  if (equipped) action = '<span class="shop-tag equipped">Équipé</span>';
  else if (item.owned) action = `<button class="btn-secondary shop-btn" data-act="equip" data-id="${item.id}">Équiper</button>`;
  else if (item.locked) action = `<span class="shop-tag locked"><i class="fas fa-lock"></i> Palier ${escapeHtml(item.tierReqName || '')}</span>`;
  else action = `<button class="btn-primary shop-btn" data-act="buy" data-id="${item.id}"><b>${item.price}</b> 🪙</button>`;
  const label = nameOverride != null ? nameOverride : item.name;
  return `<div class="shop-item${equipped ? ' is-equipped' : ''}${item.locked ? ' is-locked' : ''}">
    ${shopPreview(item.slot, item)}
    <div class="shop-name">${escapeHtml(label)}${item.exclusive ? ' <i class="fas fa-star shop-excl" title="Exclusif de palier"></i>' : ''}</div>
    ${action}
  </div>`;
}

function shopEmoteHtml(item) {
  const action = item.owned
    ? '<span class="shop-tag equipped"><i class="fas fa-check"></i> Débloqué</span>'
    : `<button class="btn-primary shop-btn" data-act="buy" data-id="${item.id}"><b>${item.price}</b> 🪙</button>`;
  return `<div class="shop-item shop-emote-item${item.owned ? ' is-equipped' : ''}">
    <span class="shop-emote-preview">
      <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" loading="lazy"
        data-fallback-symbol="${escapeHtml(item.symbol)}">
    </span>
    <div class="shop-name">${escapeHtml(item.name)}</div>
    ${action}
  </div>`;
}

function renderShop() {
  document.getElementById('shop-tokens').textContent = shopData.tokens;
  // Onglet Cosmétiques : les 4 slots.
  document.getElementById('shop-cosmetics').innerHTML = shopData.groups.map((g) => `
    <div class="shop-group">
      <h3>${g.label}</h3>
      <div class="shop-grid">${g.items.map((item) => shopItemHtml(item)).join('')}</div>
    </div>
  `).join('');

  // Onglet Licences : un bloc par franchise (artwork officiel AniList).
  const licenses = shopData.licenses || [];
  document.getElementById('shop-licenses-panel').innerHTML = licenses.length ? `
    <p class="muted shop-panel-intro">Dos de carte et bannières aux couleurs de tes séries préférées.</p>
    ${licenses.map((g) => `
      <div class="shop-group shop-group-license" style="${g.color ? `--lic-color:${g.color}` : ''}">
        <h3>${escapeHtml(g.license)}</h3>
        <div class="shop-grid">${g.items.map((item) => shopItemHtml(item, SLOT_SHORT[item.slot] || item.name)).join('')}</div>
      </div>
    `).join('')}
  ` : '<p class="muted">Aucune licence disponible.</p>';

  const emotes = shopData.emotes || [];
  document.getElementById('shop-emotes').innerHTML = `
    <p class="muted shop-panel-intro">Débloque des symboles emblématiques à utiliser comme réactions en multijoueur.</p>
    <div class="shop-grid">${emotes.map(shopEmoteHtml).join('')}</div>`;
}

function onShopClick(e) {
  const btn = e.target.closest('.shop-btn');
  if (!btn) return;
  if (btn.dataset.act === 'buy') buyCosmetic(btn.dataset.id);
  else equipCosmetic(btn.dataset.id);
}

async function buyCosmetic(id) {
  const msg = document.getElementById('shop-msg');
  const item = findShopItem(id);
  try {
    const r = await api('/api/shop/buy', { method: 'POST', body: JSON.stringify({ cosmeticId: id }) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    sfx.correct && sfx.correct();
    msg.textContent = item?.unlockOnly
      ? 'Emoji débloqué ! Il est maintenant disponible en multijoueur.'
      : 'Acheté ! Clique sur « Équiper » pour l\'utiliser.';
    // Marque l'item possédé localement puis re-rend
    markOwned(id);
    shopData.tokens = r.tokens;
    renderShop();
    if (item?.unlockOnly && typeof refreshMpEmotes === 'function') refreshMpEmotes();
    if (charShop.items.length) renderCharGrid();
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
        ? { id: item.id, slot: r.slot, name: item.name, css: item.css || '', className: item.className || '', icon: item.icon || null, image: !!item.image }
        : defaultCosmetic(r.slot);
    }
    setEquipped(r.slot, r.equipped);
    renderShop();
    if (charShop.items.length) renderCharGrid();
    renderHeaderUser();
    msg.textContent = 'Équipé ✓';
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ── Section « Personnages » (catalogue paginé) ──────────────
async function loadCharShop(page) {
  charShop.page = page || charShop.page || 1;
  try {
    const qs = new URLSearchParams({ series: charShop.series || '', q: charShop.q || '', page: String(charShop.page) });
    const r = await api('/api/shop/characters?' + qs.toString());
    charShop.items = r.items;
    charShop.total = r.total;
    charShop.pageSize = r.pageSize;
    charShop.page = r.page;
    if (!charShellRendered) { charShop.seriesList = r.series || []; renderCharShell(); charShellRendered = true; }
    renderCharGrid();
    renderCharPager();
  } catch (e) {
    const grid = document.getElementById('char-grid');
    if (grid) grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// Construit une fois l'en-tête + les contrôles (recherche / filtre série).
function renderCharShell() {
  const opts = ['<option value="">Toutes les séries</option>']
    .concat((charShop.seriesList || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`))
    .join('');
  document.getElementById('shop-characters').innerHTML = `
    <p class="muted shop-panel-intro">Mets ton perso préféré en dos de carte ou en bannière de profil.</p>
    <div class="shop-char-controls">
      <input id="char-search" type="search" placeholder="Rechercher un personnage…" autocomplete="off">
      <select id="char-series">${opts}</select>
    </div>
    <div id="char-grid" class="shop-grid"></div>
    <div id="char-pager" class="shop-pager"></div>`;
  document.getElementById('char-search').addEventListener('input', (e) => {
    clearTimeout(charSearchTimer);
    const v = e.target.value;
    charSearchTimer = setTimeout(() => { charShop.q = v.trim(); loadCharShop(1); }, 300);
  });
  document.getElementById('char-series').addEventListener('change', (e) => {
    charShop.series = e.target.value;
    loadCharShop(1);
  });
}

function renderCharGrid() {
  const grid = document.getElementById('char-grid');
  if (!grid) return;
  if (!charShop.items.length) { grid.innerHTML = '<p class="muted">Aucun personnage pour ce filtre.</p>'; return; }
  grid.innerHTML = charShop.items
    .map((item) => shopItemHtml(item, `${item.character ? item.character.name : item.name} · ${SLOT_SHORT[item.slot] || ''}`))
    .join('');
}

function renderCharPager() {
  const el = document.getElementById('char-pager');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(charShop.total / charShop.pageSize));
  if (pages <= 1) { el.innerHTML = ''; return; }
  const p = charShop.page;
  el.innerHTML = `
    <button class="btn-secondary shop-page" data-page="${p - 1}"${p <= 1 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
    <span class="shop-page-info">Page ${p} / ${pages} · ${charShop.total} items</span>
    <button class="btn-secondary shop-page" data-page="${p + 1}"${p >= pages ? ' disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
}

function onCharShopClick(e) {
  const pg = e.target.closest('.shop-page');
  if (pg) { if (!pg.disabled) loadCharShop(parseInt(pg.dataset.page, 10)); return; }
  const btn = e.target.closest('.shop-btn');
  if (!btn) return;
  if (btn.dataset.act === 'buy') buyCosmetic(btn.dataset.id);
  else equipCosmetic(btn.dataset.id);
}

// Tous les groupes porteurs d'items (slots + licences + personnages chargés)
function allShopGroups() {
  return [...(shopData.groups || []), ...(shopData.licenses || []), { items: shopData.emotes || [] }, { items: charShop.items }];
}
// Le slot revient au défaut : on garde l'item gratuit (price 0) du slot
function defaultCosmetic(slot) {
  const g = shopData.groups.find((x) => x.slot === slot);
  const def = g && g.items.find((i) => i.price === 0);
  return def ? { id: def.id, slot, name: def.name, css: def.css || '', className: def.className || '', icon: def.icon || null } : null;
}
function findShopItem(id) {
  for (const g of allShopGroups()) { const it = g.items.find((i) => i.id === id); if (it) return it; }
  return null;
}
function markOwned(id) {
  for (const g of allShopGroups()) { const it = g.items.find((i) => i.id === id); if (it) it.owned = true; }
}
// Met à jour les drapeaux « équipé » de TOUS les items du slot (slots + licences).
function setEquipped(slot, equippedId) {
  for (const g of allShopGroups()) {
    g.items.forEach((i) => {
      if (i.slot !== slot) return;
      i.equipped = equippedId ? i.id === equippedId : i.price === 0;
    });
  }
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

// ── Modale « le gacha a été réinitialisé » (une fois par joueur) ──
// Compare l'horodatage serveur du dernier reset gacha à un horodatage gardé
// en localStorage — évite un champ dédié sur User ou une notif individuelle.
async function checkGachaResetNotice() {
  let d;
  try { d = await api('/api/gacha/reset-notice'); } catch { return; }
  if (!d.resetAt) return;
  const seen = parseInt(localStorage.getItem('amq_gacha_reset_seen') || '0', 10);
  if (d.resetAt <= seen) return;
  const modal = document.getElementById('gacha-reset-modal');
  const body = document.getElementById('gacha-reset-body');
  if (!modal || !body) return;
  const compLine = d.compensation > 0
    ? `<p>Tu as dépensé <b>${d.compensation} 🪙</b> en tirages depuis toujours — cette somme t'a été <b>intégralement rendue</b>, en plus de tes tokens actuels, pour retirer sur ce pool renouvelé.</p>`
    : `<p>Tu n'avais encore jamais tiré de carte, donc rien à te rembourser — tes tokens actuels n'ont pas changé.</p>`;
  body.innerHTML = `
    <p>Le pool de personnages a été réorganisé : <b>150 Mythiques</b> et <b>550 Légendaires</b> fixes, un stock resserré par personnage pour plus d'exclusivité.</p>
    <p>Pour repartir sur une base saine avec cette nouvelle répartition, <b>ta collection a été réinitialisée</b> (cartes, exemplaires numérotés, échanges en cours). Tes statistiques de quiz, Château, multijoueur, défi du jour et niveaux ne sont <b>pas</b> concernées.</p>
    ${compLine}`;
  modal.classList.remove('hidden');
  localStorage.setItem('amq_gacha_reset_seen', String(d.resetAt));
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
      <div class="char-rarity r-${c.rarity}">${d.rarityLabel}${d.soldOut ? ' <span class="soldout-badge">ÉPUISÉ</span>' : ''} <span class="char-edition" title="Une future Édition 2 réutilisera les mêmes personnages avec de nouvelles raretés et un nouveau visuel">Édition ${c.edition || 1}</span></div>
      <button class="btn-secondary char-promote${d.votedByMe ? ' on' : ''}" id="char-promote-btn" data-cid="${c.id}">
        <i class="fas fa-arrow-trend-up"></i> ${d.votedByMe ? 'Voté pour l’Édition 2 ↑' : 'Voter pour l’Édition 2'} <span class="char-promote-count">(${d.promotionVoteCount})</span>
      </button>
      ${d.owned ? `<div class="char-stars-line" title="Niveau d'ascension">${'★'.repeat(d.stars)}<span class="muted">${'☆'.repeat(Math.max(0, (d.maxStars || 5) - d.stars))}</span></div>` : ''}
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
      <button class="btn-secondary char-wish${d.wished ? ' on' : ''}" id="char-wish-btn">
        <i class="fa-heart ${d.wished ? 'fas' : 'far'}"></i> ${d.wished ? 'Dans ta wishlist ♥' : 'Ajouter à la wishlist'}
      </button>
      ${d.owned && d.stars < (d.maxStars || 5) ? `<button class="btn-secondary char-ascend" id="char-ascend-btn" ${(d.owned - 1) < d.ascendCost ? 'disabled' : ''}>
        <i class="fas fa-star"></i> Ascensionner ★${d.stars + 1} · ${d.ascendCost} doublon(s)${(d.owned - 1) < d.ascendCost ? ` (tu en as ${d.owned - 1})` : ''}
      </button>` : ''}
      ${d.owned > 1 ? `<button class="btn-secondary char-goto-fuse" id="char-goto-fuse-btn">
        <i class="fas fa-wand-magic-sparkles"></i> Fusionner tes doublons à l'Atelier →
      </button>` : ''}
      ${d.owned ? `<button class="btn-secondary char-album-toggle" id="char-album-btn" data-cid="${c.id}">
        <i class="fas fa-book"></i> Ranger dans un album
      </button>
      <div class="char-album-picker hidden" id="char-album-picker"></div>` : ''}
      <a class="btn-secondary char-link" href="${d.anilistUrl}" target="_blank" rel="noopener">
        <i class="fas fa-external-link-alt"></i> Voir sur AniList
      </a>`;
    const gotoFuseBtn = document.getElementById('char-goto-fuse-btn');
    if (gotoFuseBtn) {
      gotoFuseBtn.addEventListener('click', () => {
        closeCharacter();
        if (typeof navTo === 'function') navTo('craft');
      });
    }
    const promoteBtn = document.getElementById('char-promote-btn');
    if (promoteBtn) {
      let voted = d.votedByMe;
      let voteCount = d.promotionVoteCount;
      promoteBtn.addEventListener('click', async () => {
        promoteBtn.disabled = true;
        try {
          if (voted) {
            const r = await api(`/api/promotion/vote/${c.id}`, { method: 'DELETE' });
            voted = false;
            voteCount = Math.max(0, voteCount - 1);
            if (typeof updatePromotionRemaining === 'function') updatePromotionRemaining(r.remaining);
          } else {
            const r = await api('/api/promotion/vote', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
            voted = true;
            voteCount += 1;
            if (typeof updatePromotionRemaining === 'function') updatePromotionRemaining(r.remaining);
            if (typeof sfx !== 'undefined' && sfx.correct) sfx.correct();
          }
          promoteBtn.classList.toggle('on', voted);
          promoteBtn.innerHTML = `<i class="fas fa-arrow-trend-up"></i> ${voted ? 'Voté pour l’Édition 2 ↑' : 'Voter pour l’Édition 2'} <span class="char-promote-count">(${voteCount})</span>`;
        } catch (e) { alert(e.message); } finally { promoteBtn.disabled = false; }
      });
    }
    const wishBtn = document.getElementById('char-wish-btn');
    if (wishBtn) {
      let wished = d.wished;
      wishBtn.addEventListener('click', async () => {
        wishBtn.disabled = true;
        try {
          const r = await api('/api/gacha/wishlist', { method: 'POST', body: JSON.stringify({ characterId: c.id, wish: !wished }) });
          wished = r.wished;
          wishBtn.classList.toggle('on', wished);
          wishBtn.innerHTML = `<i class="fa-heart ${wished ? 'fas' : 'far'}"></i> ${wished ? 'Dans ta wishlist ♥' : 'Ajouter à la wishlist'}`;
          if (wished && typeof sfx !== 'undefined' && sfx.correct) sfx.correct();
        } catch (e) { alert(e.message); } finally { wishBtn.disabled = false; }
      });
    }
    const ascendBtn = document.getElementById('char-ascend-btn');
    if (ascendBtn) {
      ascendBtn.addEventListener('click', async () => {
        if (!confirm(`Ascensionner ${c.name} en ★${d.stars + 1} ? Cela consomme ${d.ascendCost} doublon(s).`)) return;
        ascendBtn.disabled = true;
        try {
          await api('/api/gacha/ascend', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
          if (typeof sfx !== 'undefined' && sfx.reveal) sfx.reveal(c.rarity);
          if (typeof burstConfetti === 'function') burstConfetti();
          openCharacter(c.id); // recharge la fiche (★ + copies à jour)
          loadCollection();
        } catch (e) { alert(e.message); ascendBtn.disabled = false; }
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
    const albumBtn = document.getElementById('char-album-btn');
    if (albumBtn) {
      albumBtn.addEventListener('click', () => toggleCharAlbumPicker(c.id));
    }
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}
function closeCharacter() { document.getElementById('character-modal').classList.add('hidden'); }

// ── Vote « Édition 2 » (promotion Mythique/Légendaire) ──
function updatePromotionRemaining(remaining) {
  const badge = document.getElementById('promotion-remaining-badge');
  if (!badge) return;
  if (remaining == null) { badge.classList.add('hidden'); return; }
  badge.textContent = `${remaining}/10 voix`;
  badge.classList.remove('hidden');
}
async function loadPromotionRemainingBadge() {
  try {
    const d = await api('/api/promotion/status');
    updatePromotionRemaining(d.remaining);
  } catch { updatePromotionRemaining(null); }
}
async function openPromotionModal() {
  const modal = document.getElementById('promotion-modal');
  const body = document.getElementById('promotion-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  try {
    const [status, board] = await Promise.all([
      api('/api/promotion/status'),
      api('/api/promotion/leaderboard?limit=20'),
    ]);
    updatePromotionRemaining(status.remaining);
    const mine = status.votes.length
      ? `<div class="promotion-mine">${status.votes.map((c) => `
          <button class="promotion-chip" data-cid="${c.id}" title="Retirer ce vote">
            ${escapeHtml(c.name)} <i class="fas fa-times"></i>
          </button>`).join('')}</div>`
      : '<p class="muted">Tu n\'as encore voté pour personne.</p>';
    const rows = board.entries.length
      ? board.entries.map((c, i) => `
          <li class="lb-row">
            <span class="lb-rank">#${i + 1}</span>
            <span class="lb-name">${escapeHtml(c.name)}${c.series ? ` <span class="muted">(${escapeHtml(c.series)})</span>` : ''}</span>
            <span class="lb-value">${c.votes} vote${c.votes > 1 ? 's' : ''}</span>
          </li>`).join('')
      : '<li class="muted">Aucun vote pour l\'instant — sois le premier !</li>';
    body.innerHTML = `
      <h4>Mes votes (${status.used}/${status.max})</h4>
      ${mine}
      <h4><i class="fas fa-trophy"></i> Classement des votes</h4>
      <ol class="lb-list">${rows}</ol>`;
    body.querySelectorAll('.promotion-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        chip.disabled = true;
        try {
          await api(`/api/promotion/vote/${chip.dataset.cid}`, { method: 'DELETE' });
          openPromotionModal(); // recharge (voix restantes + classement)
        } catch (e) { alert(e.message); chip.disabled = false; }
      });
    });
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// Picker « Ranger dans un album » : liste des albums du joueur, chacun
// cochable/décochable indépendamment (une carte peut vivre dans plusieurs albums).
function toggleCharAlbumPicker(characterId) {
  const picker = document.getElementById('char-album-picker');
  if (!picker.classList.contains('hidden')) { picker.classList.add('hidden'); return; }
  picker.classList.remove('hidden');
  loadCharAlbumPicker(characterId);
}
async function loadCharAlbumPicker(characterId) {
  const picker = document.getElementById('char-album-picker');
  picker.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { albums } = await api(`/api/albums/mine?characterId=${characterId}`);
    const rows = albums.map((a) => `
      <label class="char-album-row">
        <input type="checkbox" data-albid="${a.id}" ${a.has ? 'checked' : ''} />
        ${escapeHtml(a.name)} <span class="muted">(${a.cardCount})</span>
      </label>`).join('');
    picker.innerHTML = `${rows || '<p class="muted">Aucun album pour l\'instant.</p>'}
      <button class="btn-secondary char-album-create" id="char-album-create-inline"><i class="fas fa-plus"></i> Nouvel album</button>`;
    picker.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const albId = parseInt(cb.dataset.albid);
        cb.disabled = true;
        try {
          if (cb.checked) await api(`/api/albums/${albId}/cards`, { method: 'POST', body: JSON.stringify({ characterId }) });
          else await api(`/api/albums/${albId}/cards/${characterId}`, { method: 'DELETE' });
        } catch (e) { alert(e.message); cb.checked = !cb.checked; }
        finally { cb.disabled = false; }
      });
    });
    document.getElementById('char-album-create-inline').addEventListener('click', () => {
      openAlbsEditModal(null, {
        onCreated: async (album) => {
          await api(`/api/albums/${album.id}/cards`, { method: 'POST', body: JSON.stringify({ characterId }) });
          loadCharAlbumPicker(characterId);
        },
      });
    });
  } catch (e) {
    picker.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

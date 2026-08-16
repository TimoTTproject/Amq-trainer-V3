// Marché entre joueurs : vente/achat d'exemplaires précis contre des tokens.
// Chargé AVANT main.js (comme community.js/gacha.js) — scope global partagé,
// réutilise cardHTML-like markup (.gcard), RARITY_LABELS/ORDER, rarityFilterChips,
// escapeHtml, api, showView, currentUser, sfx. Ne pas charger comme module ES.

let marketPage = 1, marketPages = 1, marketSearch = '', marketRarity = 'all', marketSort = 'price_asc';
let marketTab = 'browse';

function openMarket() {
  showView('market');
  marketTab = 'browse';
  document.getElementById('market-browse').classList.remove('hidden');
  document.getElementById('market-mine').classList.add('hidden');
  document.querySelectorAll('.market-tab').forEach((t) => t.classList.toggle('active', t.dataset.marketTab === 'browse'));
  document.getElementById('market-search').value = '';
  marketSearch = ''; marketRarity = 'all'; marketSort = 'price_asc';
  document.getElementById('market-sort').value = 'price_asc';
  renderMarketFilterChips();
  loadMarket(1);
}

// Chips de rareté statiques (pas de compteur par rareté sur un marché global).
function renderMarketFilterChips() {
  const chips = ['<button type="button" class="coll-chip active" data-filter="all">Toutes</button>']
    .concat(RARITY_ORDER.map((r) => `<button type="button" class="coll-chip r-${r}" data-filter="${r}">${RARITY_LABELS[r] || r}</button>`));
  document.getElementById('market-filters').innerHTML = chips.join('');
}

function setMarketTab(tab) {
  marketTab = tab;
  document.querySelectorAll('.market-tab').forEach((t) => t.classList.toggle('active', t.dataset.marketTab === tab));
  ['browse', 'sell', 'mine'].forEach((p) =>
    document.getElementById('market-' + p).classList.toggle('hidden', p !== tab)
  );
  if (tab === 'mine') loadMarketMine();
  if (tab === 'sell') loadMarketSell();
}

function marketListingHTML(l) {
  const rar = l.character.rarity;
  const edition = cardEdition(l.character);
  const img = l.character.imageUrl ? `style="background-image:url('${l.character.imageUrl}')"` : '';
  return `<div class="gcard r-${rar}${edition.className} market-card">
    ${edition.ribbon}
    <div class="gcard-img" ${img}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(l.character.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[rar] || rar} · #${l.serial}</div>
      <div class="market-seller hint">${l.mine
        ? 'Ton annonce'
        : `Vendu par <button type="button" class="btn-link" data-userid="${l.seller.id}">${escapeHtml(l.seller.displayName)}</button>`}</div>
    </div>
    <span class="badge market-price">${l.price} 🪙</span>
    ${l.mine
      ? `<button type="button" class="btn-secondary market-cancel-btn" data-id="${l.id}">Annuler la vente</button>`
      : `<button type="button" class="btn-primary market-buy-btn" data-id="${l.id}">Acheter</button>`}
  </div>`;
}

async function loadMarket(page) {
  if (page < 1) return;
  const grid = document.getElementById('market-list');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = marketRarity !== 'all' ? `&rarity=${marketRarity}` : '';
    const r = await api(`/api/market?page=${page}&search=${encodeURIComponent(marketSearch)}&sort=${marketSort}${rq}`);
    marketPage = r.page; marketPages = r.pages || 1;
    if (!r.listings.length) {
      grid.innerHTML = '<div class="empty-state"><p class="muted">Aucune annonce ne correspond.</p></div>';
    } else {
      grid.innerHTML = r.listings.map(marketListingHTML).join('');
    }
    document.getElementById('market-pageinfo').textContent = `Page ${marketPage} / ${marketPages}`;
    document.getElementById('market-prev').disabled = marketPage <= 1;
    document.getElementById('market-next').disabled = marketPage >= marketPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function loadMarketMine() {
  const activeBox = document.getElementById('market-mine-active');
  const histBox = document.getElementById('market-mine-history');
  activeBox.innerHTML = '<p class="muted">Chargement…</p>';
  histBox.innerHTML = '';
  try {
    const r = await api('/api/market/mine');
    activeBox.innerHTML = r.active.length
      ? r.active.map((l) => marketListingHTML({ ...l, mine: true })).join('')
      : '<p class="muted">Aucune annonce en cours.</p>';
    if (!r.history.length) {
      histBox.innerHTML = '<p class="muted">Aucune vente/achat passé.</p>';
    } else {
      const STATUS = { sold: '✅ Vendu', cancelled: '↩️ Annulé' };
      histBox.innerHTML = r.history.map((h) => {
        const date = h.resolvedAt ? new Date(h.resolvedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
        const label = h.status === 'cancelled' ? STATUS.cancelled : (h.direction === 'sold' ? '✅ Vendu' : '🛒 Acheté');
        const other = h.other ? (h.direction === 'sold' ? ` à ${escapeHtml(h.other)}` : ` de ${escapeHtml(h.other)}`) : '';
        return `<div class="trade-hist-row">
          <span class="th-status">${label}</span>
          <span class="th-other">${escapeHtml(h.characterName)} · #${h.serial}${other}</span>
          <span class="th-detail hint">${h.price} 🪙</span>
          <span class="th-date hint">${date}</span>
        </div>`;
      }).join('');
    }
  } catch (e) {
    activeBox.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── Onglet Vendre : mes exemplaires vendables (non gelés), mise en vente
// directe. Source : /api/trade/instances/:userId (déjà groupé par personnage,
// exclut les exemplaires déjà en vente) — même périmètre que le builder d'échange.
let marketSellCharacters = [];
let marketSellSearch = '';

function marketSellCardHTML(c, idx) {
  const edition = cardEdition(c);
  const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
  const picker = c.serials.length > 1
    ? `<select class="market-sell-serial" aria-label="Choisir l'exemplaire">${c.serials.map((s) => `<option value="${s.id}">#${s.serial}</option>`).join('')}</select>`
    : `<input type="hidden" class="market-sell-serial" value="${c.serials[0].id}" />`;
  return `<div class="gcard r-${c.rarity}${edition.className} market-card market-sell-card" data-sell-idx="${idx}">
    ${edition.ribbon}
    <div class="gcard-img" ${img}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity} · ${c.serials.length > 1 ? `${c.serials.length} ex. · #${c.serials.map((s) => s.serial).join(', #')}` : `#${c.serials[0].serial}`}</div>
    </div>
    <div class="market-sell-form">
      ${picker}
      <input type="number" class="market-sell-price" min="1" max="999999" inputmode="numeric" placeholder="Prix 🪙" aria-label="Prix en tokens" />
      <button type="button" class="btn-primary market-sell-submit">Vendre</button>
    </div>
  </div>`;
}

function renderMarketSell() {
  const grid = document.getElementById('market-sell-list');
  if (!grid) return;
  const q = marketSellSearch.toLowerCase();
  const filtered = marketSellCharacters.filter((c) => !q || c.name.toLowerCase().includes(q));
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><p class="muted">${marketSellCharacters.length
      ? 'Aucun personnage ne correspond à la recherche.'
      : 'Aucun exemplaire vendable — toutes tes cartes sont déjà en vente, ou ta collection est vide.'}</p></div>`;
    return;
  }
  // Raretés hautes d'abord (ce qu'on vend le plus souvent), puis alphabétique.
  filtered.sort((a, b) =>
    RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity) || a.name.localeCompare(b.name));
  grid.innerHTML = filtered.map((c) => marketSellCardHTML(c, marketSellCharacters.indexOf(c))).join('');
}

async function loadMarketSell() {
  const grid = document.getElementById('market-sell-list');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const r = await api(`/api/trade/instances/${currentUser.id}`);
    marketSellCharacters = r.characters || [];
    renderMarketSell();
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function submitMarketSell(cardEl) {
  const c = marketSellCharacters[parseInt(cardEl.dataset.sellIdx)];
  const priceEl = cardEl.querySelector('.market-sell-price');
  const cardInstanceId = parseInt(cardEl.querySelector('.market-sell-serial').value);
  const price = parseInt(priceEl.value);
  if (!c || !cardInstanceId) return;
  if (!(price > 0)) { priceEl.focus(); priceEl.reportValidity?.(); return; }
  const btn = cardEl.querySelector('.market-sell-submit');
  btn.disabled = true;
  try {
    await api('/api/market/list', { method: 'POST', body: JSON.stringify({ cardInstanceId, price }) });
    if (typeof sfx !== 'undefined' && sfx.correct) sfx.correct();
    // Retire l'exemplaire vendu du stock local (plus vendable tant que l'annonce est active).
    c.serials = c.serials.filter((s) => s.id !== cardInstanceId);
    if (!c.serials.length) marketSellCharacters = marketSellCharacters.filter((x) => x !== c);
    renderMarketSell();
  } catch (e) {
    btn.disabled = false;
    alert(e.message);
  }
}

async function buyMarketListing(id) {
  if (!confirm('Confirmer l’achat de cet exemplaire ?')) return;
  try {
    await api(`/api/market/${id}/buy`, { method: 'POST' });
    if (typeof currentUser === 'object' && currentUser) {
      try { const me = await api('/api/auth/me'); if (me && me.user) { currentUser = me.user; renderHeaderUser(); } } catch {}
    }
    if (typeof sfx !== 'undefined' && sfx.correct) sfx.correct();
    loadMarket(marketPage);
  } catch (e) {
    alert(e.message);
  }
}

async function cancelMarketListing(id) {
  if (!confirm('Annuler cette annonce et récupérer la carte ?')) return;
  try {
    await api(`/api/market/${id}/cancel`, { method: 'POST' });
    loadMarketMine();
  } catch (e) {
    alert(e.message);
  }
}

// Accueil : vitrine des annonces les moins chères (raccourci vers le marché).
async function loadMarketTeaser() {
  const box = document.getElementById('home-market-teaser');
  if (!box) return;
  try {
    const r = await api('/api/market?sort=price_asc&page=1');
    if (!r.listings.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <h3 class="quests-title"><i class="fas fa-store"></i> Marché · meilleures affaires</h3>
      <div class="recent-pulls-strip">${r.listings.slice(0, 8).map((l) => `
        <button class="recent-pull-card r-${l.character.rarity}" data-market-id="${l.id}" title="${escapeHtml(l.character.name)}">
          <div class="rp-img" ${l.character.imageUrl ? `style="background-image:url('${l.character.imageUrl}')"` : ''}></div>
          <span class="rp-rarity r-${l.character.rarity}">${RARITY_LABELS[l.character.rarity] || l.character.rarity}</span>
          <span class="rp-name">${escapeHtml(l.character.name)}</span>
          <span class="rp-user">${l.price} 🪙</span>
        </button>`).join('')}</div>
      <button class="btn-link home-market-see-all" id="home-market-see-all">Voir tout le marché →</button>`;
  } catch { box.innerHTML = ''; }
}

function setMarketRarity(rarity) {
  marketRarity = rarity;
  document.querySelectorAll('#market-filters [data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === rarity));
  loadMarket(1);
}

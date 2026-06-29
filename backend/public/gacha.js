// Gacha, boutique, stats de tirage, fiche personnage — extrait de main.js (script classique, scope global partagé).
// Chargé AVANT main.js dans index.html. Réutilise des globals définis ailleurs
// (currentUser, api, escapeHtml, settings…) ; gacha.js définit RARITY_LABELS/ORDER
// utilisés ici et dans le profil. Ne pas charger comme module ES.

// ── GACHA ──
const RARITY_LABELS = { common: 'Commun', rare: 'Rare', epic: 'Épique', legendary: 'Légendaire', mythic: 'Mythique' };
const RARITY_ORDER = ['mythic', 'legendary', 'epic', 'rare', 'common'];

function setGachaTokens() {
  document.getElementById('gacha-tokens').textContent = currentUser.tokens;
}

async function openGacha() {
  showView('gacha');
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
  loadCollection();
}

// Bannière « vedettes de la semaine » + compte à rebours
function renderWeeklyBanner(info) {
  const el = document.getElementById('gacha-weekly');
  if (!el) return;
  const chars = info.weeklyFeatured || [];
  if (!chars.length) { el.innerHTML = ''; return; }
  const left = Math.max(0, (info.weeklyResetAt || 0) - Date.now());
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const countdown = days > 0 ? `${days}j ${hours}h` : `${hours}h`;
  el.innerHTML = `
    <div class="weekly-head">
      <span><i class="fas fa-star"></i> Vedettes de la semaine <span class="weekly-boost">+${info.weeklyBoost || 60}% de chance</span></span>
      <span class="weekly-timer"><i class="fas fa-clock"></i> ${countdown}</span>
    </div>
    <div class="featured-row">${chars.map((c) => cardHTML(c)).join('')}</div>`;
}

function renderGachaMeta(pityLimit = 60) {
  const pity = currentUser.pity || 0;
  const pct = Math.min(100, Math.round((pity / pityLimit) * 100));
  document.getElementById('gacha-meta').innerHTML = `
    <span class="gacha-dust">🌟 <b>${currentUser.dust || 0}</b> poussière</span>
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
  const backIcon = (cb && cb.icon) || 'fa-music';
  return `<div class="flip-card r-${c.rarity}" data-cid="${c.id}" style="animation-delay:${(i * 0.08).toFixed(2)}s">
    <div class="flip-inner">
      <div class="flip-face flip-back${cosmClass(cb)}" style="${cosmStyle(cb)}"><div class="flip-back-inner"><i class="fas ${backIcon}"></i></div></div>
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
    if (typeof r.dust === 'number') currentUser.dust = r.dust;
    if (typeof r.pity === 'number') currentUser.pity = r.pity;
    renderHeaderUser();
    setGachaTokens();
    renderGachaMeta(r.pityLimit);
    pullRefundMsg = (r.refundTotal ? ` · ${r.refundTotal} 🪙` : '') + (r.dustTotal ? ` · +${r.dustTotal} 🌟` : '');
    pullCost = r.cost;
    const result = document.getElementById('pull-result');
    result.innerHTML = r.cards.map((c, i) => flipCardHTML(c, i)).join('');
    result.classList.remove('hidden');
    if (r.cards.length > 1) document.getElementById('reveal-all-btn').classList.remove('hidden');
    document.getElementById('gacha-msg').textContent = `−${r.cost} 🪙 — clique sur les cartes pour les retourner ! 🎴`;
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

// Recycle tous les doublons de la collection en poussière
async function recycleAllDupes() {
  const dupes = collectionCards.filter((c) => c.copies > 1).reduce((s, c) => s + (c.copies - 1), 0);
  if (!dupes) { alert('Aucun doublon à recycler.'); return; }
  if (!confirm(`Recycler ${dupes} doublon(s) en poussière ? (tu gardes 1 exemplaire de chaque carte)`)) return;
  const btn = document.getElementById('recycle-all-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/gacha/recycle-all', { method: 'POST' });
    currentUser.dust = r.dust;
    renderHeaderUser();
    sfx.correct && sfx.correct();
    document.getElementById('gacha-msg').textContent = `♻️ ${r.recycled} doublon(s) recyclé(s) · +${r.gain} 🌟 (total ${r.dust})`;
    loadCollection();
  } catch (e) {
    document.getElementById('gacha-msg').textContent = e.message;
  } finally {
    btn.disabled = false;
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
    grid.innerHTML = '<p class="muted">Aucune carte pour l\'instant. Tire ton premier personnage !</p>';
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

// ── Boutique de cosmétiques ─────────────────────────────────
let shopData = null;

async function openShop() {
  showView('shop');
  document.getElementById('shop-tokens').textContent = currentUser.tokens;
  document.getElementById('shop-msg').textContent = '';
  const wrap = document.getElementById('shop-groups');
  wrap.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    shopData = await api('/api/shop');
    renderShop();
  } catch (e) {
    wrap.innerHTML = `<p class="muted">${e.message}</p>`;
  }
}

// Aperçu visuel d'un item selon son slot
function shopPreview(slot, item) {
  const cls = item.className ? ' ' + item.className : '';
  const style = item.css || '';
  if (slot === 'cardBack') {
    const icon = item.icon || 'fa-music';
    return `<span class="shop-prev shop-prev-back${cls}" style="${style}"><i class="fas ${icon}"></i></span>`;
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

function renderShop() {
  document.getElementById('shop-tokens').textContent = shopData.tokens;
  const wrap = document.getElementById('shop-groups');
  wrap.innerHTML = shopData.groups.map((g) => `
    <div class="shop-group">
      <h3>${g.label}</h3>
      <div class="shop-grid">
        ${g.items.map((item) => {
          const owned = item.owned;
          const equipped = item.equipped;
          let action;
          if (equipped) action = '<span class="shop-tag equipped">Équipé</span>';
          else if (owned) action = `<button class="btn-secondary shop-btn" data-act="equip" data-id="${item.id}">Équiper</button>`;
          else if (item.locked) action = `<span class="shop-tag locked"><i class="fas fa-lock"></i> Palier ${escapeHtml(item.tierReqName || '')}</span>`;
          else action = `<button class="btn-primary shop-btn" data-act="buy" data-id="${item.id}"><b>${item.price}</b> 🪙</button>`;
          return `<div class="shop-item${equipped ? ' is-equipped' : ''}${item.locked ? ' is-locked' : ''}">
            ${shopPreview(g.slot, item)}
            <div class="shop-name">${escapeHtml(item.name)}${item.exclusive ? ' <i class="fas fa-star shop-excl" title="Exclusif de palier"></i>' : ''}</div>
            ${action}
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

function onShopClick(e) {
  const btn = e.target.closest('.shop-btn');
  if (!btn) return;
  if (btn.dataset.act === 'buy') buyCosmetic(btn.dataset.id);
  else equipCosmetic(btn.dataset.id);
}

async function buyCosmetic(id) {
  const msg = document.getElementById('shop-msg');
  try {
    const r = await api('/api/shop/buy', { method: 'POST', body: JSON.stringify({ cosmeticId: id }) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    sfx.correct && sfx.correct();
    msg.textContent = 'Acheté ! Clique sur « Équiper » pour l\'utiliser.';
    // Marque l'item possédé localement puis re-rend
    markOwned(id);
    shopData.tokens = r.tokens;
    renderShop();
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
        ? { id: item.id, slot: r.slot, name: item.name, css: item.css || '', className: item.className || '', icon: item.icon || null }
        : defaultCosmetic(r.slot);
    }
    setEquipped(r.slot, r.equipped);
    renderShop();
    renderHeaderUser();
    msg.textContent = 'Équipé ✓';
  } catch (err) {
    msg.textContent = err.message;
  }
}

// Le slot revient au défaut : on garde l'item gratuit (price 0) du slot
function defaultCosmetic(slot) {
  const g = shopData.groups.find((x) => x.slot === slot);
  const def = g && g.items.find((i) => i.price === 0);
  return def ? { id: def.id, slot, name: def.name, css: def.css || '', className: def.className || '', icon: def.icon || null } : null;
}
function findShopItem(id) {
  for (const g of shopData.groups) { const it = g.items.find((i) => i.id === id); if (it) return it; }
  return null;
}
function markOwned(id) {
  for (const g of shopData.groups) { const it = g.items.find((i) => i.id === id); if (it) it.owned = true; }
}
function setEquipped(slot, equippedId) {
  const g = shopData.groups.find((x) => x.slot === slot);
  if (!g) return;
  g.equipped = equippedId;
  g.items.forEach((i) => { i.equipped = equippedId ? i.id === equippedId : i.price === 0; });
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
      <div class="char-rarity r-${c.rarity}">${d.rarityLabel}${d.soldOut ? ' <span class="soldout-badge">ÉPUISÉ</span>' : ''}</div>
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
      ${d.soldOut
        ? `<button class="btn-secondary char-craft" disabled><i class="fas fa-ban"></i> Épuisé — échange seulement</button>`
        : `<button class="btn-secondary char-craft" id="char-craft-btn" data-cid="${c.id}" ${(currentUser.dust || 0) < d.craftCost ? 'disabled' : ''}>
        <i class="fas fa-hammer"></i> Fabriquer · ${d.craftCost} 🌟 ${(currentUser.dust || 0) < d.craftCost ? `(tu as ${currentUser.dust || 0})` : ''}
      </button>`}
      ${d.owned && d.stars < (d.maxStars || 5) ? `<button class="btn-secondary char-ascend" id="char-ascend-btn" ${(d.owned - 1) < d.ascendCost ? 'disabled' : ''}>
        <i class="fas fa-star"></i> Ascensionner ★${d.stars + 1} · ${d.ascendCost} doublon(s)${(d.owned - 1) < d.ascendCost ? ` (tu en as ${d.owned - 1})` : ''}
      </button>` : ''}
      ${d.owned > 1 ? `<button class="btn-secondary char-recycle" id="char-recycle-btn">
        <i class="fas fa-recycle"></i> Recycler ${d.owned - 1} doublon(s) · +${(d.owned - 1) * d.dustGain} 🌟
      </button>` : ''}
      <a class="btn-secondary char-link" href="${d.anilistUrl}" target="_blank" rel="noopener">
        <i class="fas fa-external-link-alt"></i> Voir sur AniList
      </a>`;
    const craftBtn = document.getElementById('char-craft-btn');
    if (craftBtn) {
      craftBtn.addEventListener('click', async () => {
        if (!confirm(`Fabriquer ${c.name} pour ${d.craftCost} 🌟 ?`)) return;
        craftBtn.disabled = true;
        try {
          const r = await api('/api/gacha/craft', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
          currentUser.dust = r.dust;
          if (typeof sfx !== 'undefined') sfx.reveal(c.rarity);
          if (typeof burstConfetti === 'function') burstConfetti();
          openCharacter(c.id); // recharge la fiche (possession + poussière à jour)
          loadCollection();
        } catch (e) { alert(e.message); craftBtn.disabled = false; }
      });
    }
    const recycleBtn = document.getElementById('char-recycle-btn');
    if (recycleBtn) {
      recycleBtn.addEventListener('click', async () => {
        if (!confirm(`Recycler ${d.owned - 1} doublon(s) de ${c.name} en poussière ?`)) return;
        recycleBtn.disabled = true;
        try {
          const r = await api('/api/gacha/recycle', { method: 'POST', body: JSON.stringify({ characterId: c.id }) });
          currentUser.dust = r.dust;
          sfx.correct && sfx.correct();
          openCharacter(c.id); // recharge la fiche (copies + poussière à jour)
          loadCollection();
        } catch (e) { alert(e.message); recycleBtn.disabled = false; }
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
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}
function closeCharacter() { document.getElementById('character-modal').classList.add('hidden'); }

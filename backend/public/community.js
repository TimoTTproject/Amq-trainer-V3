// Communauté : classement, annuaire, échanges, fiche joueur, pokédex, atelier — extrait de main.js (script classique, scope global partagé).
// Chargé AVANT main.js dans index.html. Réutilise des globals définis ailleurs
// (currentUser, api, escapeHtml, settings…) ; gacha.js définit RARITY_LABELS/ORDER
// utilisés ici et dans le profil. Ne pas charger comme module ES.

// ── ÉPINGLAGE DU MENU LATÉRAL ──
// Icône/label de chaque raccourci épinglable (clés data-nav des hub-cards de
// Jouer/Collection/Communauté) — reprend exactement ce qui est déjà écrit en
// dur dans index.html, pour que le rendu en sidebar soit identique.
const NAV_META = {
  quiz: { icon: 'fa-trophy', label: 'Quiz classique' },
  coop: { icon: 'fa-people-group', label: 'Coop' },
  training: { icon: 'fa-graduation-cap', label: 'Entraînement' },
  tower: { icon: 'fa-chess-rook', label: "Château de l'Infini" },
  mp: { icon: 'fa-users', label: 'Multijoueur' },
  daily: { icon: 'fa-calendar-day', label: 'Défi du jour' },
  gacha: { icon: 'fa-layer-group', label: 'Gacha' },
  shop: { icon: 'fa-store', label: 'Boutique' },
  craft: { icon: 'fa-hammer', label: 'Atelier' },
  catalog: { icon: 'fa-list', label: 'Catalogue' },
  playlist: { icon: 'fa-heart', label: 'Playlist' },
  friends: { icon: 'fa-user-group', label: 'Amis' },
  leaderboard: { icon: 'fa-trophy', label: 'Classement' },
  players: { icon: 'fa-users', label: 'Joueurs' },
  trades: { icon: 'fa-right-left', label: 'Échanges' },
};

// Bascule un raccourci épinglé/désépinglé, met à jour currentUser + l'affichage.
async function togglePinNav(nav) {
  try {
    const r = await api('/api/profile/pin-nav', { method: 'POST', body: JSON.stringify({ nav }) });
    currentUser.pinnedNav = r.pinnedNav;
    renderPinnedNav();
    refreshPinIcons();
  } catch (e) { alert(e.message); }
}

// Remet à jour l'état visuel (.pinned) de toutes les icônes punaise visibles
// (hubs Jouer/Collection/Communauté) selon currentUser.pinnedNav.
function refreshPinIcons() {
  const pinned = new Set(currentUser?.pinnedNav || []);
  document.querySelectorAll('.hub-pin').forEach((el) => {
    el.classList.toggle('pinned', pinned.has(el.dataset.pin));
  });
}

// Peuple #navbar-pinned à partir de currentUser.pinnedNav — appelée après
// connexion et après chaque bascule d'épingle.
function renderPinnedNav() {
  const box = document.getElementById('navbar-pinned');
  const sep = document.getElementById('navbar-pinned-sep');
  if (!box || !sep) return;
  const pins = (currentUser?.pinnedNav || []).filter((nav) => NAV_META[nav]);
  sep.classList.toggle('hidden', !pins.length);
  box.innerHTML = pins.map((nav) => {
    const meta = NAV_META[nav];
    return `<button class="nav-item" data-nav="${nav}"><i class="fas ${meta.icon}"></i><span>${escapeHtml(meta.label)}</span></button>`;
  }).join('');
}

// ── CLASSEMENT ──
const LB_UNITS = {
  tower: (v) => `Étage ${v}`,
  coop: (v) => `Étage ${v}`,
  tokens: (v) => `${v} 🪙`,
  collection: (v) => `${v} cartes`,
  ranked: (v) => `${v} MMR`,
  solo: (v) => `${v} MMR`,
};

function openLeaderboard() {
  showView('leaderboard');
  document.querySelectorAll('.lb-tab').forEach((t) => t.classList.toggle('active', t.dataset.lb === 'ranked'));
  loadLeaderboard('ranked');
  loadSeasonBanner();
}

// Bannière de récompense de saison (mensuelle, sans reset du MMR).
async function loadSeasonBanner() {
  const el = document.getElementById('season-banner');
  if (!el) return;
  let d;
  try { d = await api('/api/season/status'); } catch { el.classList.add('hidden'); return; }
  renderSeasonBanner(d);
}
function renderSeasonBanner(d) {
  const el = document.getElementById('season-banner');
  const tierTxt = d.tier ? tierBadge(d.tier) : 'Non classé';
  let action;
  if (d.claimed) action = '<span class="season-done"><i class="fas fa-circle-check"></i> Récompense réclamée</span>';
  else if (d.claimable) action = `<button class="btn-primary" id="season-claim-btn">Réclamer ${d.reward.tokens} 🪙${d.reward.dust ? ` + ${d.reward.dust} 🌟` : ''}</button>`;
  else if (!d.active) action = '<span class="season-hint">Joue une partie classée ou un défi pour débloquer</span>';
  else action = '<span class="season-hint">Pas encore classé</span>';
  el.innerHTML = `
    <div class="season-info">
      <span class="season-name"><i class="fas fa-medal"></i> Saison ${escapeHtml(d.label)}</span>
      <span class="season-tier">Ton palier : <b>${tierTxt}</b></span>
    </div>
    <div class="season-action">${action}</div>`;
  el.classList.remove('hidden');
  const btn = document.getElementById('season-claim-btn');
  if (btn) btn.addEventListener('click', claimSeason);
}
async function claimSeason() {
  const btn = document.getElementById('season-claim-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/season/claim', { method: 'POST', body: JSON.stringify({}) });
    if (typeof currentUser === 'object' && currentUser) {
      currentUser.tokens = (currentUser.tokens || 0) + (r.tokens || 0);
      if (r.dust) currentUser.dust = (currentUser.dust || 0) + r.dust;
      if (typeof renderHeaderUser === 'function') renderHeaderUser();
    }
    if (typeof burstConfetti === 'function') burstConfetti(25);
    loadSeasonBanner();
  } catch (e) {
    if (btn) btn.disabled = false;
    alert(e.message);
  }
}

// Petit avatar (image ou initiale colorée) en HTML
function lbAvatar(entry) { return otherAvatar(entry, 'avatar-sm'); }

// Avatar d'un AUTRE joueur en HTML, avec son cadre cosmétique (entry.frame) éventuel
function otherAvatar(entry, sizeClass = 'avatar-sm') {
  const fr = entry.frame;
  const cls = fr && fr.className ? ' ' + fr.className : '';
  const frameStyle = fr && fr.css ? fr.css + ';' : '';
  const bg = entry.avatarUrl ? `background-image:url('${entry.avatarUrl}');` : '';
  const inner = entry.avatarUrl ? '' : escapeHtml((entry.displayName || '?').charAt(0).toUpperCase());
  return `<span class="avatar ${sizeClass}${cls}" style="${bg}${frameStyle}">${inner}</span>`;
}

async function loadLeaderboard(type) {
  const list = document.getElementById('lb-list');
  const meBox = document.getElementById('lb-me');
  list.innerHTML = '<li class="muted">Chargement…</li>';
  meBox.innerHTML = '';
  const unit = LB_UNITS[type] || ((v) => v);
  try {
    const { top, me, rewards } = await api(`/api/leaderboard?type=${type}`);
    const note = document.getElementById('lb-note');
    if (note) {
      note.classList.toggle('hidden', !rewards);
      if (rewards) note.innerHTML = `🏆 <b>Récompense hebdo</b> — 1<sup>er</sup> : <b>${rewards[0]} 🪙</b> · 2<sup>e</sup> : <b>${rewards[1]} 🪙</b>. Classement remis à zéro chaque lundi.`;
    }
    if (me) {
      meBox.innerHTML = `<span class="lb-rank">#${me.rank}</span>
        <span class="lb-me-label">Ton rang</span>
        <span class="lb-value">${unit(me.value)}</span>`;
    } else {
      meBox.innerHTML = '<span class="muted">Pas encore classé sur ce tableau.</span>';
    }
    if (!top.length) {
      list.innerHTML = '<li class="muted">Personne n\'est encore classé.</li>';
      return;
    }
    const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);
    list.innerHTML = top
      .map(
        (e) => `<li class="lb-row${e.isMe ? ' me' : ''}" data-userid="${e.userId}">
          <span class="lb-rank">${medal(e.rank)}</span>
          ${lbAvatar(e)}
          <span class="lb-name">${escapeHtml(e.displayName)}${e.tier ? ' ' + tierBadge(e.tier) : ''}</span>
          <span class="lb-value">${unit(e.value)}</span>
        </li>`
      )
      .join('');
  } catch (e) {
    list.innerHTML = `<li class="muted">${escapeHtml(e.message)}</li>`;
  }
}

// ── ANNUAIRE DES JOUEURS (vue Communauté) ──
let playersPage = 1, playersSearch = '', playersPages = 1;

function openPlayers() {
  showView('players');
  document.getElementById('players-search').value = '';
  playersSearch = '';
  loadPlayers(1);
}

async function loadPlayers(page) {
  if (page < 1) return;
  const list = document.getElementById('players-list');
  list.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const r = await api(`/api/profile/players/list?page=${page}&search=${encodeURIComponent(playersSearch)}`);
    playersPage = r.page; playersPages = r.pages || 1;
    document.getElementById('players-total').textContent = `${r.total} joueur(s)`;
    if (!r.players.length) {
      list.innerHTML = '<p class="muted">Aucun joueur trouvé.</p>';
    } else {
      const isAdmin = currentUser && currentUser.isAdmin;
      list.innerHTML = r.players.map((p) => {
        const tier = p.tier ? tierBadge(p.tier) : '';
        const floor = p.towerBestFloor ? `<span class="pl-floor"><i class="fas fa-chess-rook"></i> ${p.towerBestFloor}</span>` : '';
        // Suppression de compte (admin only, ex. comptes de test/diagnostic) — jamais sur soi.
        const del = isAdmin && !p.isMe
          ? `<button type="button" class="pl-delete" data-del-userid="${p.userId}" data-del-name="${escapeHtml(p.displayName)}" title="Supprimer ce compte"><i class="fas fa-trash"></i></button>`
          : '';
        return `<div class="pl-row${p.isMe ? ' me' : ''}" data-userid="${p.userId}">
          ${otherAvatar(p, 'avatar-sm')}
          <span class="pl-name">${escapeHtml(p.displayName)}${p.isMe ? ' <span class="hint">(toi)</span>' : ''}</span>
          ${tier}${floor}
          ${del}
          <i class="fas fa-chevron-right pl-go"></i>
        </div>`;
      }).join('');
    }
    document.getElementById('players-pageinfo').textContent = `Page ${playersPage} / ${playersPages}`;
    document.getElementById('players-prev').disabled = playersPage <= 1;
    document.getElementById('players-next').disabled = playersPage >= playersPages;
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// Suppression de compte (admin) : ex. comptes de test/diagnostic créés en prod
// pendant le développement. Cascade totale côté serveur (relations Prisma).
async function deletePlayerAccount(userId, name) {
  if (!confirm(`Supprimer définitivement le compte « ${name} » ?\n\nTous ses tokens, cartes, historiques et échanges seront perdus. Action irréversible.`)) return;
  try {
    await api(`/api/admin/user/${userId}`, { method: 'DELETE' });
    loadPlayers(playersPage);
  } catch (e) {
    alert(e.message);
  }
}

// ── ÉCHANGE : builder ──
let tradeTarget = null; // { id, name }
const tradeGiveSel = new Set(); // instance ids que je donne
const tradeWantSel = new Set(); // instance ids que je veux

async function openTradeBuilder(userId, displayName) {
  tradeTarget = { id: userId, name: displayName };
  tradeGiveSel.clear(); tradeWantSel.clear();
  showView('trade');
  document.getElementById('trade-with').textContent = displayName;
  document.getElementById('trade-msg').textContent = '';
  ['trade-give-tokens', 'trade-give-dust', 'trade-want-tokens', 'trade-want-dust'].forEach((id) => { document.getElementById(id).value = 0; });
  document.getElementById('trade-give').innerHTML = '<p class="muted">Chargement…</p>';
  document.getElementById('trade-want').innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const [mine, theirs] = await Promise.all([
      api(`/api/trade/instances/${currentUser.id}`),
      api(`/api/trade/instances/${userId}`),
    ]);
    renderTradePool('trade-give', mine.characters, tradeGiveSel);
    renderTradePool('trade-want', theirs.characters, tradeWantSel);
  } catch (e) {
    document.getElementById('trade-msg').textContent = e.message;
  }
}

function renderTradePool(containerId, characters, selSet) {
  const el = document.getElementById(containerId);
  if (!characters.length) { el.innerHTML = '<p class="muted">Aucune carte.</p>'; return; }
  el.innerHTML = characters.map((c) => `
    <div class="trade-char">
      <span class="rb-pill r-${c.rarity}">${escapeHtml(c.name)}</span>
      <div class="trade-serials">
        ${c.serials.map((s) => `<button class="serial-chip${selSet.has(s.id) ? ' on' : ''}" data-iid="${s.id}">#${s.serial}</button>`).join('')}
      </div>
    </div>`).join('');
}

function toggleTradeChip(containerId, selSet, btn) {
  const iid = parseInt(btn.dataset.iid);
  if (selSet.has(iid)) { selSet.delete(iid); btn.classList.remove('on'); }
  else { selSet.add(iid); btn.classList.add('on'); }
}

async function sendTrade() {
  if (!tradeTarget) return;
  const body = {
    toUserId: tradeTarget.id,
    offeredIds: [...tradeGiveSel],
    requestedIds: [...tradeWantSel],
    offeredTokens: +document.getElementById('trade-give-tokens').value || 0,
    requestedTokens: +document.getElementById('trade-want-tokens').value || 0,
    offeredDust: +document.getElementById('trade-give-dust').value || 0,
    requestedDust: +document.getElementById('trade-want-dust').value || 0,
  };
  const msg = document.getElementById('trade-msg');
  const btn = document.getElementById('trade-send');
  btn.disabled = true;
  try {
    await api('/api/trade', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = '✅ Proposition envoyée !';
    sfx.correct && sfx.correct();
    setTimeout(() => openTrades(), 700);
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── ÉCHANGE : offres reçues / envoyées ──
function tradeItemsHTML(items, tokens, dust) {
  const chips = items.map((i) => `<span class="trade-mini r-${i.rarity}">${escapeHtml(i.name)} <b>#${i.serial}</b></span>`);
  if (tokens) chips.push(`<span class="trade-mini cur">${tokens} 🪙</span>`);
  if (dust) chips.push(`<span class="trade-mini cur">${dust} 🌟</span>`);
  return chips.length ? chips.join('') : '<span class="muted">rien</span>';
}

async function openTrades() {
  showView('trades');
  const list = document.getElementById('trades-list');
  list.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const { trades } = await api('/api/trade/list');
    updateTradesBadge(trades.filter((t) => t.direction === 'incoming').length);
    if (!trades.length) { list.innerHTML = '<p class="muted">Aucun échange en attente.</p>'; return; }
    list.innerHTML = trades.map((t) => {
      const other = t.direction === 'incoming' ? t.from : t.to;
      const head = t.direction === 'incoming'
        ? `<b>${escapeHtml(other.displayName)}</b> te propose`
        : `Proposition à <b>${escapeHtml(other.displayName)}</b>`;
      const actions = t.direction === 'incoming'
        ? `<button class="btn-primary trade-act" data-act="accept" data-id="${t.id}">Accepter</button>
           <button class="btn-secondary trade-act" data-act="decline" data-id="${t.id}">Refuser</button>`
        : `<button class="btn-secondary trade-act" data-act="decline" data-id="${t.id}">Annuler</button>`;
      return `<div class="trade-offer">
        <div class="trade-offer-head">${head}</div>
        <div class="trade-offer-body">
          <div class="trade-side"><label>${t.direction === 'incoming' ? 'Tu reçois' : 'Tu donnes'}</label>${tradeItemsHTML(t.offered, t.offeredTokens, t.offeredDust)}</div>
          <i class="fas fa-right-left trade-arrow"></i>
          <div class="trade-side"><label>${t.direction === 'incoming' ? 'Tu donnes' : 'Tu reçois'}</label>${tradeItemsHTML(t.requested, t.requestedTokens, t.requestedDust)}</div>
        </div>
        <div class="trade-offer-actions">${actions}</div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
  loadTradeHistory();
}

async function loadTradeHistory() {
  const box = document.getElementById('trades-history');
  if (!box) return;
  try {
    const { trades } = await api('/api/trade/history');
    if (!trades.length) { box.innerHTML = '<p class="muted">Aucun échange passé.</p>'; return; }
    const STATUS = { accepted: '✅ Accepté', declined: '✖️ Refusé', cancelled: '↩️ Annulé' };
    box.innerHTML = trades.map((t) => {
      const give = `${t.offeredCount} carte(s)${t.offeredTokens ? ` +${t.offeredTokens}🪙` : ''}${t.offeredDust ? ` +${t.offeredDust}🌟` : ''}`;
      const want = `${t.requestedCount} carte(s)${t.requestedTokens ? ` +${t.requestedTokens}🪙` : ''}${t.requestedDust ? ` +${t.requestedDust}🌟` : ''}`;
      const date = t.resolvedAt ? new Date(t.resolvedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
      return `<div class="trade-hist-row">
        <span class="th-status">${STATUS[t.status] || t.status}</span>
        <span class="th-other">${t.direction === 'incoming' ? 'de' : 'à'} <b>${escapeHtml(t.other)}</b></span>
        <span class="th-detail hint">${give} ⇄ ${want}</span>
        <span class="th-date hint">${date}</span>
      </div>`;
    }).join('');
  } catch { box.innerHTML = ''; }
}

async function resolveTrade(id, act) {
  try {
    if (act === 'accept') {
      await api(`/api/trade/${id}/accept`, { method: 'POST' });
      // solde tokens/poussière peut avoir changé → recharge le profil minimal
      try { const me = await api('/api/auth/me'); if (me && me.user) { currentUser = me.user; renderHeaderUser(); } } catch {}
      sfx.win && sfx.win();
    } else {
      await api(`/api/trade/${id}/decline`, { method: 'POST' });
    }
    openTrades();
    loadTradesBadge();
  } catch (e) {
    alert(e.message);
  }
}

// Badge « échanges reçus » (navbar + hub)
function updateTradesBadge(n) {
  ['trades-nav-badge', 'trades-hub-badge'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = n || '';
    el.classList.toggle('hidden', !n);
  });
}
async function loadTradesBadge() {
  try { const { incoming } = await api('/api/trade/list'); updateTradesBadge(incoming); } catch {}
}

// ── PROFIL JOUEUR (public, depuis le classement) ──
async function openPlayer(userId) {
  // Affiche la fiche joueur via la vue profil complète (plus jolie que la modale).
  if (typeof openPublicProfile === 'function') return openPublicProfile(userId);
  return openPlayerModal(userId);
}

// Variante modale (overlay, ne change pas de vue) : utilisée pendant une
// partie multijoueur pour consulter un profil SANS quitter le salon/la
// partie en cours (openPlayer/openPublicProfile changerait de vue et
// masquerait #view-mp, donnant l'impression d'avoir quitté la partie).
async function openPlayerModal(userId) {
  const modal = document.getElementById('player-modal');
  const body = document.getElementById('player-body');
  body.innerHTML = '<p class="muted">Chargement…</p>';
  modal.classList.remove('hidden');
  try {
    const d = await api(`/api/profile/${userId}`);
    const u = d.user;
    const af = d.cosmetics && d.cosmetics.avatarFrame;
    const frameCls = af && af.className ? ' ' + af.className : '';
    const frameStyle = af && af.css ? af.css : '';
    const avatar = u.avatarUrl
      ? `<span class="avatar avatar-lg${frameCls}" style="background-image:url('${u.avatarUrl}');${frameStyle}"></span>`
      : `<span class="avatar avatar-lg${frameCls}" style="${frameStyle}">${escapeHtml((u.displayName || '?').charAt(0).toUpperCase())}</span>`;
    const since = u.createdAt
      ? new Date(u.createdAt).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' })
      : '—';
    const best = d.bestCard
      ? `<div class="player-best">${cardHTML({ ...d.bestCard, copies: 1 }, { noBorder: true })}<p class="hint">Meilleure carte</p></div>`
      : '';
    const lv = d.level || { level: 1 };
    const series = (d.topSeries || []).slice(0, 4);
    const seriesHtml = series.length
      ? `<div class="player-series"><p class="hint">Séries les plus jouées</p>${series
          .map((s) => `<span class="rb-pill">${escapeHtml(s.title)} <b>${s.plays}</b></span>`)
          .join('')}</div>`
      : '';
    body.innerHTML = `
      <div class="player-head">${avatar}<h2>${escapeHtml(u.displayName)}</h2>
        <span class="level-badge">Niv. ${lv.level}</span></div>
      ${u.bio ? `<p class="player-bio">${escapeHtml(u.bio)}</p>` : ''}
      <div class="char-stats">
        <div class="cstat"><span>${d.stats.played}</span><label>Jouées</label></div>
        <div class="cstat"><span>${d.stats.rate}%</span><label>Réussite</label></div>
        <div class="cstat"><span>${u.towerBestFloor || 0}</span><label>Étage max</label></div>
        <div class="cstat"><span>${d.cardsCount}</span><label>Cartes</label></div>
      </div>
      ${best}
      ${seriesHtml}
      <p class="hint">Membre depuis ${since}</p>
      ${userId !== currentUser.id ? `<button class="btn-primary" id="player-trade-btn"><i class="fas fa-right-left"></i> Proposer un échange</button>` : ''}`;
    const tradeBtn = document.getElementById('player-trade-btn');
    if (tradeBtn) tradeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      openTradeBuilder(userId, u.displayName);
    });
  } catch (e) {
    body.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── POKÉDEX PERSONNAGES (côté joueur) ──
let charsPage = 1, charsSearch = '', charsRarity = 'all', charsPages = 1;

function openCharacters() {
  showView('characters');
  document.getElementById('chars-search').value = '';
  charsSearch = ''; charsRarity = 'all';
  loadCharacters(1, '');
  if (typeof loadPromotionRemainingBadge === 'function') loadPromotionRemainingBadge();
}

function rarityFilterChips(byRarity, current) {
  const total = Object.values(byRarity).reduce((s, n) => s + n, 0);
  const chips = [`<button class="coll-chip${current === 'all' ? ' active' : ''}" data-filter="all">Tous (${total})</button>`];
  RARITY_ORDER.forEach((r) => {
    if (!byRarity[r]) return;
    chips.push(`<button class="coll-chip r-${r}${current === r ? ' active' : ''}" data-filter="${r}">${RARITY_LABELS[r]} (${byRarity[r]})</button>`);
  });
  return chips.join('');
}

async function loadCharacters(page, search) {
  if (page < 1) return;
  charsSearch = search;
  const grid = document.getElementById('chars-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = charsRarity !== 'all' ? `&rarity=${charsRarity}` : '';
    const r = await api(`/api/gacha/characters?page=${page}&search=${encodeURIComponent(search)}${rq}`);
    charsPage = r.page; charsPages = r.pages || 1;
    document.getElementById('chars-total').textContent = `${r.total} personnages`;
    document.getElementById('chars-filters').innerHTML = rarityFilterChips(r.byRarity, charsRarity);
    if (!r.characters.length) {
      grid.innerHTML = '<p class="muted">Aucun personnage.</p>';
    } else {
      grid.innerHTML = r.characters
        .map((c) => {
          const owned = c.owned > 0;
          const sub = c.series && c.series !== '—' ? `<div class="gcard-series">${escapeHtml(c.series)}</div>` : '';
          return `<div class="gcard r-${c.rarity}${owned ? '' : ' locked'}" data-cid="${c.id}">
            <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
            <div class="gcard-info">
              <div class="gcard-name">${escapeHtml(c.name)}</div>
              <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
              ${sub}
            </div>
            ${owned ? `<span class="badge copies">×${c.owned}</span>` : '<span class="badge locked-badge"><i class="fas fa-lock"></i></span>'}
          </div>`;
        })
        .join('');
    }
    document.getElementById('chars-pageinfo').textContent = `Page ${charsPage} / ${charsPages}`;
    document.getElementById('chars-prev').disabled = charsPage <= 1;
    document.getElementById('chars-next').disabled = charsPage >= charsPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

// ── ATELIER (craft) ──
let craftPage = 1, craftSearch = '', craftRarity = 'all', craftPages = 1, craftMissing = false;

function openCraft() {
  showView('craft');
  document.getElementById('craft-search').value = '';
  document.getElementById('craft-missing').checked = false;
  craftSearch = ''; craftRarity = 'all'; craftMissing = false;
  document.getElementById('craft-msg').textContent = '';
  loadCraft(1);
}

async function loadCraft(page) {
  if (page < 1) return;
  const grid = document.getElementById('craft-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = craftRarity !== 'all' ? `&rarity=${craftRarity}` : '';
    const ownedQ = craftMissing ? '&owned=0' : '';
    const r = await api(`/api/gacha/characters?page=${page}&search=${encodeURIComponent(craftSearch)}${rq}${ownedQ}`);
    craftPage = r.page; craftPages = r.pages || 1;
    if (typeof r.dust === 'number') { currentUser.dust = r.dust; renderHeaderUser(); }
    document.getElementById('craft-dust').textContent = currentUser.dust || 0;
    document.getElementById('craft-filters').innerHTML = rarityFilterChips(r.byRarity, craftRarity);
    if (!r.characters.length) {
      grid.innerHTML = '<p class="muted">Aucun personnage.</p>';
    } else {
      grid.innerHTML = r.characters.map((c) => craftCardHTML(c)).join('');
    }
    document.getElementById('craft-pageinfo').textContent = `Page ${craftPage} / ${craftPages}`;
    document.getElementById('craft-prev').disabled = craftPage <= 1;
    document.getElementById('craft-next').disabled = craftPage >= craftPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function craftCardHTML(c) {
  const owned = c.owned > 0;
  const sub = c.series && c.series !== '—' ? `<div class="gcard-series">${escapeHtml(c.series)}</div>` : '';
  const canAfford = (currentUser.dust || 0) >= c.craftCost;
  const badge = c.soldOut ? '<span class="badge soldout">ÉPUISÉ</span>'
    : owned ? `<span class="badge copies">×${c.owned}</span>` : '<span class="badge locked-badge"><i class="fas fa-lock"></i></span>';
  const btn = c.soldOut
    ? `<button class="btn-secondary craft-btn" disabled><i class="fas fa-ban"></i> Épuisé</button>`
    : `<button class="btn-primary craft-btn" data-cid="${c.id}" data-cost="${c.craftCost}" data-name="${escapeHtml(c.name)}" ${canAfford ? '' : 'disabled'}>
      <i class="fas fa-hammer"></i> ${c.craftCost} 🌟
    </button>`;
  return `<div class="gcard r-${c.rarity}${owned ? '' : ' locked'}">
    <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
      ${sub}
    </div>
    ${badge}
    ${btn}
  </div>`;
}

async function craftFromAtelier(btn) {
  const id = btn.dataset.cid;
  const cost = btn.dataset.cost;
  const name = btn.dataset.name;
  if (!confirm(`Fabriquer ${name} pour ${cost} 🌟 ?`)) return;
  btn.disabled = true;
  const msg = document.getElementById('craft-msg');
  try {
    const r = await api('/api/gacha/craft', { method: 'POST', body: JSON.stringify({ characterId: parseInt(id) }) });
    currentUser.dust = r.dust;
    renderHeaderUser();
    sfx.reveal && sfx.reveal('epic');
    msg.textContent = `✅ ${name} ${r.isNew ? 'ajouté à ta collection' : 'fabriqué (doublon)'} ! Reste ${r.dust} 🌟`;
    loadCraft(craftPage); // rafraîchit la possession + coûts abordables
  } catch (e) {
    msg.textContent = e.message;
    btn.disabled = false;
  }
}

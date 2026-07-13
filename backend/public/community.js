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
  'gacha-pull': { icon: 'fa-ticket', label: 'Tirage' },
  'gacha-collection': { icon: 'fa-images', label: 'Ma collection' },
  'gacha-events': { icon: 'fa-star', label: 'Vedettes & vote' },
  'gacha-series': { icon: 'fa-clapperboard', label: 'Par série' },
  'gacha-albums': { icon: 'fa-book', label: 'Albums' },
  shop: { icon: 'fa-store', label: 'Boutique' },
  craft: { icon: 'fa-hammer', label: 'Atelier' },
  catalog: { icon: 'fa-list', label: 'Catalogue' },
  playlist: { icon: 'fa-heart', label: 'Playlist' },
  friends: { icon: 'fa-user-group', label: 'Amis' },
  leaderboard: { icon: 'fa-trophy', label: 'Classement' },
  players: { icon: 'fa-users', label: 'Joueurs' },
  trades: { icon: 'fa-right-left', label: 'Échanges' },
  market: { icon: 'fa-store', label: 'Marché' },
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
  luck: (v) => (typeof formatLuckIndex === 'function'
    ? formatLuckIndex(v)
    : `×${Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`),
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
    const { top, me, rewards, minPulls } = await api(`/api/leaderboard?type=${type}`);
    const note = document.getElementById('lb-note');
    if (note) {
      const luckNote = type === 'luck';
      note.classList.toggle('hidden', !rewards && !luckNote);
      if (luckNote) note.innerHTML = `🍀 <b>Indice de chance</b> — minimum ${minPulls || 50} tirages. ×1 = proche des taux de base ; ce n'est pas une probabilité.`;
      if (rewards) note.innerHTML = `🏆 <b>Récompense hebdo</b> — 1<sup>er</sup> : <b>${rewards[0]} 🪙</b> · 2<sup>e</sup> : <b>${rewards[1]} 🪙</b>. Classement remis à zéro chaque lundi.`;
    }
    if (me) {
      meBox.innerHTML = `<span class="lb-rank">#${me.rank}</span>
        <span class="lb-me-label">Ton rang</span>
        <span class="lb-value">${unit(me.value)}${type === 'luck' && me.pullCount ? ` · ${me.pullCount} tirages` : ''}</span>`;
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
          <span class="lb-name">${escapeHtml(e.displayName)}${e.tier ? ' ' + tierBadge(e.tier) : ''}${type === 'luck' && e.pullCount ? ` <small>${e.pullCount} tirages</small>` : ''}</span>
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
        const floor = p.towerBestFloor ? `<span class="pl-floor"><i class="fas fa-chess-rook"></i> Étage ${p.towerBestFloor}</span>` : '';
        // Statut : en ligne (point vert) ou « vu il y a X » via timeAgo (helper global).
        const status = p.online
          ? '<span class="pl-status online"><span class="pl-dot"></span> En ligne</span>'
          : (p.lastSeenAt ? `<span class="pl-status"><i class="far fa-clock"></i> vu ${timeAgo(p.lastSeenAt)}</span>` : '<span class="pl-status muted">Jamais connecté</span>');
        // Modération + suppression (admin only) — jamais sur soi.
        const del = isAdmin && !p.isMe
          ? `<button type="button" class="pl-delete pl-mod" data-beta-userid="${p.userId}" data-beta-enabled="${p.idleBetaTester}" data-mod-name="${escapeHtml(p.displayName)}" title="${p.idleBetaTester ? 'Retirer le rôle bêta Anime Ascension' : 'Donner le rôle bêta Anime Ascension'}"><i class="fas fa-flask"></i></button>
             <button type="button" class="pl-delete pl-mod" data-mute-userid="${p.userId}" data-mod-name="${escapeHtml(p.displayName)}" title="Sourdine du chat (durée au choix, 0 = lever)"><i class="fas fa-comment-slash"></i></button>
             <button type="button" class="pl-delete pl-mod" data-ban-userid="${p.userId}" data-mod-name="${escapeHtml(p.displayName)}" title="Bannir / débannir ce compte"><i class="fas fa-gavel"></i></button>
             <button type="button" class="pl-delete" data-del-userid="${p.userId}" data-del-name="${escapeHtml(p.displayName)}" title="Supprimer ce compte"><i class="fas fa-trash"></i></button>`
          : '';
        return `<div class="pl-row${p.isMe ? ' me' : ''}${p.online ? ' online' : ''}" data-userid="${p.userId}">
          <span class="pl-av-wrap">${otherAvatar(p, 'avatar-md')}${p.online ? '<span class="pl-online-dot"></span>' : ''}</span>
          <div class="pl-main">
            <div class="pl-name-line"><span class="pl-name">${escapeHtml(p.displayName)}${p.isMe ? ' <span class="hint">(toi)</span>' : ''}</span>${tier}</div>
            <div class="pl-sub">${status}${floor}</div>
          </div>
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

// Modération (admin) : sourdine du chat / bannissement — réversibles,
// contrairement à la suppression de compte.
async function mutePlayer(userId, name) {
  const raw = prompt(`Sourdine du chat pour « ${name} » — durée en minutes (0 pour lever la sourdine) :`, '60');
  if (raw === null) return;
  const minutes = Math.max(0, parseInt(raw) || 0);
  try {
    const r = await api(`/api/admin/user/${userId}/mute`, { method: 'POST', body: JSON.stringify({ minutes }) });
    alert(r.minutes > 0 ? `« ${name} » est en sourdine pour ${r.minutes} min.` : `Sourdine levée pour « ${name} ».`);
  } catch (e) { alert(e.message); }
}
async function banPlayer(userId, name) {
  const ban = confirm(`Bannir « ${name} » ?\n\nConnexion refusée (site + multi) tant que le ban est actif. Compte et données conservés — re-cliquer permet de débannir.\n\nOK = bannir · Annuler = débannir (si déjà banni, sinon rien)`);
  try {
    const r = await api(`/api/admin/user/${userId}/ban`, { method: 'POST', body: JSON.stringify({ banned: ban }) });
    alert(r.banned ? `« ${name} » est banni.` : `« ${name} » est débanni.`);
  } catch (e) { alert(e.message); }
}

async function setIdleBetaTester(userId, name, enabled) {
  const action = enabled ? 'donner' : 'retirer';
  if (!confirm(`${action[0].toUpperCase()}${action.slice(1)} le rôle bêta Anime Ascension à « ${name} » ?`)) return;
  try {
    await api(`/api/admin/user/${userId}/roles/idle-beta`, { method: 'POST', body: JSON.stringify({ enabled }) });
    await loadPlayers(playersPage);
  } catch (e) { alert(e.message); }
}

// ── ÉCHANGE : builder ──
// Sélection par PERSONNAGE (pas par n° de série, invisible et sans intérêt
// pour l'utilisateur) : cliquer une carte ajoute 1 exemplaire à l'offre
// (jusqu'aux copies possédées et jusqu'à TRADE_MAX_ITEMS), reclique pour
// en retirer un. Le n° de série exact est choisi automatiquement en interne.
const TRADE_MAX_ITEMS = 12; // même plafond que côté serveur (src/trade/trade.routes.js)
let tradeTarget = null; // { id, name }
let tradeGiveChars = []; // liste complète possédée par moi (pour filtrer sans refetch)
let tradeWantChars = []; // liste complète possédée par l'autre joueur
let tradeGiveSearch = '';
let tradeWantSearch = '';
let tradeGiveRarity = 'all';
let tradeWantRarity = 'all';
const tradeGiveSel = new Map(); // characterId -> { count, serialIds }
const tradeWantSel = new Map();

async function openTradeBuilder(userId, displayName) {
  tradeTarget = { id: userId, name: displayName };
  tradeGiveSel.clear(); tradeWantSel.clear();
  tradeGiveSearch = ''; tradeWantSearch = '';
  tradeGiveRarity = 'all'; tradeWantRarity = 'all';
  showView('trade');
  document.getElementById('trade-with').textContent = displayName;
  document.getElementById('trade-msg').textContent = '';
  ['trade-give-tokens', 'trade-want-tokens'].forEach((id) => { document.getElementById(id).value = 0; });
  document.getElementById('trade-give-search').value = '';
  document.getElementById('trade-want-search').value = '';
  document.getElementById('trade-give').innerHTML = '<p class="muted">Chargement…</p>';
  document.getElementById('trade-want').innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const [mine, theirs] = await Promise.all([
      api(`/api/trade/instances/${currentUser.id}`),
      api(`/api/trade/instances/${userId}`),
    ]);
    tradeGiveChars = mine.characters;
    tradeWantChars = theirs.characters;
    document.getElementById('trade-give-filters').innerHTML = rarityFilterChips(tradeByRarity(tradeGiveChars), tradeGiveRarity);
    document.getElementById('trade-want-filters').innerHTML = rarityFilterChips(tradeByRarity(tradeWantChars), tradeWantRarity);
    renderTradePool('trade-give', tradeGiveChars, tradeGiveSel, tradeGiveSearch, tradeGiveRarity);
    renderTradePool('trade-want', tradeWantChars, tradeWantSel, tradeWantSearch, tradeWantRarity);
    updateTradeCounts();
  } catch (e) {
    document.getElementById('trade-msg').textContent = e.message;
  }
}

// Effectif par rareté (persos DISTINCTS possédés), pour les chips de filtre.
function tradeByRarity(characters) {
  const byRarity = {};
  characters.forEach((c) => (byRarity[c.rarity] = (byRarity[c.rarity] || 0) + 1));
  return byRarity;
}

function tradeSelectedTotal(selSet) {
  let t = 0;
  selSet.forEach((v) => (t += v.count));
  return t;
}

function updateTradeCounts() {
  document.getElementById('trade-give-count').textContent = `${tradeSelectedTotal(tradeGiveSel)}/${TRADE_MAX_ITEMS}`;
  document.getElementById('trade-want-count').textContent = `${tradeSelectedTotal(tradeWantSel)}/${TRADE_MAX_ITEMS}`;
}

function renderTradePool(containerId, characters, selSet, search, rarity) {
  const el = document.getElementById(containerId);
  if (!characters.length) { el.innerHTML = '<p class="muted">Aucune carte possédée.</p>'; return; }
  const q = (search || '').trim().toLowerCase();
  let list = rarity && rarity !== 'all' ? characters.filter((c) => c.rarity === rarity) : characters;
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
  if (!list.length) { el.innerHTML = '<p class="muted">Aucun personnage ne correspond.</p>'; return; }
  el.innerHTML = list.map((c) => {
    const sel = selSet.get(c.characterId);
    const selCount = sel ? sel.count : 0;
    const owned = c.serials.length;
    const badge = selCount > 0 ? `<span class="badge fuse-selected">✓ ×${selCount}</span>` : `<span class="badge copies">×${owned}</span>`;
    return `<button type="button" class="gcard r-${c.rarity}${selCount > 0 ? ' fuse-picked' : ''}" data-cid="${c.characterId}">
      <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
      <div class="gcard-info">
        <div class="gcard-name">${escapeHtml(c.name)}</div>
        <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
      </div>
      ${badge}
    </button>`;
  }).join('');
}

function toggleTradeCard(containerId, characters, selSet, characterId) {
  const c = characters.find((x) => x.characterId === characterId);
  if (!c) return;
  const owned = c.serials.length;
  const total = tradeSelectedTotal(selSet);
  const cur = selSet.get(characterId) || { count: 0, serialIds: [] };
  if (cur.count < owned && total < TRADE_MAX_ITEMS) {
    const next = c.serials.find((s) => !cur.serialIds.includes(s.id));
    if (next) { cur.count++; cur.serialIds.push(next.id); selSet.set(characterId, cur); }
  } else if (cur.count > 0) {
    cur.serialIds.pop();
    cur.count--;
    if (cur.count === 0) selSet.delete(characterId); else selSet.set(characterId, cur);
  }
  updateTradeCounts();
  const search = containerId === 'trade-give' ? tradeGiveSearch : tradeWantSearch;
  const rarity = containerId === 'trade-give' ? tradeGiveRarity : tradeWantRarity;
  renderTradePool(containerId, characters, selSet, search, rarity);
}

function setTradeRarity(side, rarity) {
  if (side === 'give') tradeGiveRarity = rarity; else tradeWantRarity = rarity;
  const characters = side === 'give' ? tradeGiveChars : tradeWantChars;
  const selSet = side === 'give' ? tradeGiveSel : tradeWantSel;
  const search = side === 'give' ? tradeGiveSearch : tradeWantSearch;
  document.getElementById(`trade-${side}-filters`).innerHTML = rarityFilterChips(tradeByRarity(characters), rarity);
  renderTradePool(`trade-${side}`, characters, selSet, search, rarity);
}

async function sendTrade() {
  if (!tradeTarget) return;
  const offeredIds = [...tradeGiveSel.values()].flatMap((v) => v.serialIds);
  const requestedIds = [...tradeWantSel.values()].flatMap((v) => v.serialIds);
  const body = {
    toUserId: tradeTarget.id,
    offeredIds,
    requestedIds,
    offeredTokens: +document.getElementById('trade-give-tokens').value || 0,
    requestedTokens: +document.getElementById('trade-want-tokens').value || 0,
  };
  const msg = document.getElementById('trade-msg');
  const btn = document.getElementById('trade-send');
  btn.disabled = true;
  try {
    await api('/api/trade', { method: 'POST', body: JSON.stringify(body) });
    msg.textContent = 'Proposition envoyée !';
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
let craftPage = 1, craftSearch = '', craftRarity = 'all', craftPages = 1;

// Fusion : sélection en cours { characterId -> { count, rarity, name } }.
// Verrouillée sur une seule rareté à la fois (fuseRarity), vidée par
// clearFuseSelection ou après une fusion réussie.
let fuseSelection = new Map();
let fuseRarity = null;

function openCraft() {
  showView('craft');
  document.getElementById('craft-search').value = '';
  craftSearch = ''; craftRarity = 'all';
  document.getElementById('craft-msg').textContent = '';
  clearFuseSelection();
  loadCraft(1);
}

async function loadCraft(page) {
  if (page < 1) return;
  const grid = document.getElementById('craft-grid');
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    const rq = craftRarity !== 'all' ? `&rarity=${craftRarity}` : '';
    const r = await api(`/api/gacha/characters?page=${page}&search=${encodeURIComponent(craftSearch)}${rq}&owned=1`);
    craftPage = r.page; craftPages = r.pages || 1;
    document.getElementById('craft-filters').innerHTML = rarityFilterChips(r.byRarity, craftRarity);
    if (!r.characters.length) {
      grid.innerHTML = '<div class="empty-state"><p class="muted">Aucune carte possédée dans ce filtre.</p></div>';
    } else {
      grid.innerHTML = r.characters.map((c) => fuseCardHTML(c)).join('');
    }
    document.getElementById('craft-pageinfo').textContent = `Page ${craftPage} / ${craftPages}`;
    document.getElementById('craft-prev').disabled = craftPage <= 1;
    document.getElementById('craft-next').disabled = craftPage >= craftPages;
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function fuseSelectedTotal() {
  let t = 0;
  fuseSelection.forEach((v) => (t += v.count));
  return t;
}

function updateFuseBar() {
  const total = fuseSelectedTotal();
  document.getElementById('fuse-counter-badge').textContent = `${total}/${FUSE_COUNT} sélectionné(s)`;
  document.getElementById('fuse-btn').disabled = total !== FUSE_COUNT;
}

function fuseCardHTML(c) {
  const sub = c.series && c.series !== '—' ? `<div class="gcard-series">${escapeHtml(c.series)}</div>` : '';
  const sel = fuseSelection.get(c.id);
  const selCount = sel ? sel.count : 0;
  const badge = selCount > 0 ? `<span class="badge fuse-selected">✓ ×${selCount}</span>` : `<span class="badge copies">×${c.owned}</span>`;
  return `<button type="button" class="gcard r-${c.rarity}${selCount > 0 ? ' fuse-picked' : ''}" data-cid="${c.id}" data-rarity="${c.rarity}" data-owned="${c.owned}" data-name="${escapeHtml(c.name)}">
    <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
    <div class="gcard-info">
      <div class="gcard-name">${escapeHtml(c.name)}</div>
      <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity}</div>
      ${sub}
    </div>
    ${badge}
  </button>`;
}

// Clique une carte possédée : ajoute 1 à la sélection (jusqu'à ses copies et
// jusqu'à FUSE_COUNT au total), ou en retire 1 si elle est déjà au maximum.
// Toutes les cartes sélectionnées doivent être de la même rareté.
function toggleFuseCard(cid, rarity, owned, name) {
  const msg = document.getElementById('craft-msg');
  const total = fuseSelectedTotal();
  if (fuseRarity && rarity !== fuseRarity && total > 0) {
    msg.textContent = `Choisis des exemplaires de la même rareté (${RARITY_LABELS[fuseRarity] || fuseRarity}) — vide la sélection pour changer.`;
    return;
  }
  const cur = fuseSelection.get(cid) || { count: 0, rarity, name };
  if (cur.count < owned && total < FUSE_COUNT) {
    cur.count++;
    fuseSelection.set(cid, cur);
  } else if (cur.count > 0) {
    cur.count--;
    if (cur.count === 0) fuseSelection.delete(cid); else fuseSelection.set(cid, cur);
  }
  fuseRarity = fuseSelectedTotal() > 0 ? rarity : null;
  msg.textContent = '';
  updateFuseBar();
  renderFuseCardBadges();
}

// Ne recharge pas toute la grille depuis l'API (juste les badges/états de sélection).
function renderFuseCardBadges() {
  document.querySelectorAll('#craft-grid .gcard').forEach((el) => {
    const cid = parseInt(el.dataset.cid);
    const owned = parseInt(el.dataset.owned);
    const sel = fuseSelection.get(cid);
    const selCount = sel ? sel.count : 0;
    el.classList.toggle('fuse-picked', selCount > 0);
    const badge = el.querySelector('.badge');
    if (badge) {
      badge.className = selCount > 0 ? 'badge fuse-selected' : 'badge copies';
      badge.innerHTML = selCount > 0 ? `✓ ×${selCount}` : `×${owned}`;
    }
  });
}

function clearFuseSelection() {
  fuseSelection = new Map();
  fuseRarity = null;
  const msg = document.getElementById('craft-msg');
  if (msg) msg.textContent = '';
  updateFuseBar();
  renderFuseCardBadges();
}

async function runFusion() {
  const btn = document.getElementById('fuse-btn');
  const msg = document.getElementById('craft-msg');
  const items = [...fuseSelection.entries()].map(([characterId, v]) => ({ characterId, count: v.count }));
  if (!confirm(`Fusionner ces ${FUSE_COUNT} exemplaires en 1 carte aléatoire ${RARITY_LABELS[fuseRarity] || ''} ?`)) return;
  btn.disabled = true;
  try {
    const r = await api('/api/gacha/fuse', { method: 'POST', body: JSON.stringify({ items }) });
    const c = r.card;
    if (typeof sfx !== 'undefined' && sfx.reveal) sfx.reveal(c.rarity);
    if (['legendary', 'mythic'].includes(c.rarity) && typeof burstConfetti === 'function') burstConfetti(c.rarity === 'mythic' ? 40 : 26);
    // Résultat en MODALE : reste affiché jusqu'à fermeture par le joueur
    // (l'ancien encart sous la grille partait hors écran au rechargement).
    document.getElementById('fuse-reveal-card').innerHTML = `<div class="gcard r-${c.rarity}">
      <div class="gcard-img" ${c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : ''}></div>
      <div class="gcard-info">
        <div class="gcard-name">${escapeHtml(c.name)}</div>
        <div class="gcard-rarity">${RARITY_LABELS[c.rarity] || c.rarity} · #${c.serial}</div>
      </div>
      ${c.isNew ? '<span class="badge new">NOUVEAU</span>' : '<span class="badge copies">Doublon</span>'}
    </div>`;
    document.getElementById('fuse-reveal-caption').textContent =
      `${c.name} (${RARITY_LABELS[c.rarity] || c.rarity})${c.isNew ? ' — nouveau personnage !' : ' — doublon'}`;
    document.getElementById('fuse-reveal-modal').classList.remove('hidden');
    msg.textContent = `Fusion réussie : ${escapeHtml(c.name)} (${RARITY_LABELS[c.rarity] || c.rarity})${c.isNew ? ' — nouveau !' : ' (doublon)'}`;
    clearFuseSelection();
    loadCraft(craftPage); // rafraîchit la possession
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

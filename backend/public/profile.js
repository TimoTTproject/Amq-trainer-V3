// Profil (perso + fiche publique) — extrait de main.js (script classique, scope
// global partagé). Chargé par ensureAppReady() AVANT setupAppUI. Réutilise des
// globals définis ailleurs (currentUser, api, escapeHtml, renderAvatar,
// applyBackgroundCosmetic, tierBadge, navTo, showView, renderHeaderUser, sfx,
// burstConfetti ; cardHTML/RARITY_* de gacha.js ; openCharacter/openTradeBuilder
// de community.js, appelés via typeof). Ne pas charger comme module ES.

let pendingAvatar; // undefined = inchangé, null = retiré, string = nouvelle data URL

function setupProfileUI() {
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  document.getElementById('profile-share').addEventListener('click', shareProfile);
  document.getElementById('profile-edit-name-shortcut')?.addEventListener('click', focusProfileNameEditor);
  // Section Compte (pseudo / email / mot de passe / suppression)
  document.getElementById('account-name-btn')?.addEventListener('click', accountChangeName);
  document.getElementById('account-email-btn')?.addEventListener('click', accountChangeEmail);
  document.getElementById('account-pass-btn')?.addEventListener('click', accountChangePassword);
  document.getElementById('account-delete-btn')?.addEventListener('click', accountDelete);
  document.getElementById('profile-back').addEventListener('click', () => navTo('community'));
  document.getElementById('profile-claim').addEventListener('click', claimLevels);
  document.getElementById('avatar-upload-btn').addEventListener('click', () =>
    document.getElementById('avatar-input').click()
  );
  document.getElementById('avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingAvatar = await fileToResizedDataURL(file);
      renderProfileAvatar();
    } catch {
      setProfileError("Impossible de lire cette image.");
    }
    e.target.value = '';
  });
  document.getElementById('avatar-remove-btn').addEventListener('click', () => {
    pendingAvatar = null;
    renderProfileAvatar();
  });
  document.getElementById('profile-save').addEventListener('click', saveProfile);
  document.getElementById('profile-showcase').addEventListener('click', (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  });
  document.getElementById('player-collection-close').addEventListener('click', () =>
    document.getElementById('player-collection-modal').classList.add('hidden')
  );
  document.getElementById('player-collection-grid').addEventListener('click', (e) => {
    const card = e.target.closest('.gcard[data-cid]');
    if (card) openCharacter(card.dataset.cid);
  });
  document.getElementById('player-collection-search').addEventListener('input', (e) =>
    renderPlayerCollectionGrid(e.target.value)
  );
}

function setProfileError(msg) { document.getElementById('profile-error').textContent = msg || ''; }

function focusProfileNameEditor() {
  const editor = document.getElementById('profile-edit');
  if (editor) editor.open = true;
  document.getElementById('profile-name')?.focus({ preventScroll: true });
  editor?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function effectiveAvatar() {
  return pendingAvatar !== undefined ? pendingAvatar : currentUser.avatarUrl;
}
function renderProfileAvatar() {
  renderAvatar(document.getElementById('profile-avatar'), {
    avatarUrl: effectiveAvatar(),
    displayName: document.getElementById('profile-name').value || currentUser.displayName,
  });
}

let profileData = null; // réponse riche de /api/profile/:id

// Profil public d'un autre joueur : même vue complète que la nôtre (plus jolie
// que l'ancienne modale), en lecture seule + bouton d'échange.
async function openPublicProfile(userId) {
  if (!userId || (currentUser && userId === currentUser.id)) return openProfile();
  showView('profile');
  let d;
  try { d = await api(`/api/profile/${userId}`); } catch { return; }
  profileData = d;
  document.getElementById('profile-tokens').textContent = d.user.tokens;
  renderProfile(d, false);
}

async function openProfile() {
  showView('profile');
  document.body.classList.remove('profile-public'); // mode perso (édition visible)
  document.getElementById('profile-back').classList.add('hidden');
  document.getElementById('profile-trade-btn').classList.add('hidden');
  pendingAvatar = undefined;
  setProfileError('');
  document.getElementById('profile-name').value = currentUser.displayName;
  document.getElementById('profile-bio').value = currentUser.bio || '';
  document.getElementById('profile-hero-name').textContent = currentUser.displayName;
  document.getElementById('profile-tokens').textContent = currentUser.tokens;
  renderProfileAvatar();
  loadTokenHistory();

  try {
    profileData = await api(`/api/profile/${currentUser.id}`);
  } catch {
    profileData = null;
    return;
  }
  renderProfile(profileData);
}

// Bouton ami d'une fiche publique : libellé/état selon la relation, et action
// au clic (demande, ou acceptation directe si une demande est déjà reçue).
function renderFriendButton(btn, status, userId) {
  btn.disabled = false;
  btn.onclick = null;
  if (status === 'accepted') {
    btn.innerHTML = '<i class="fas fa-check"></i> Ami';
    btn.disabled = true;
  } else if (status === 'pending_out') {
    btn.innerHTML = '<i class="fas fa-clock"></i> Demande envoyée';
    btn.disabled = true;
  } else if (status === 'pending_in') {
    btn.innerHTML = '<i class="fas fa-user-check"></i> Accepter la demande';
    btn.onclick = async () => {
      btn.disabled = true;
      try { await friendAction('accept', userId); renderFriendButton(btn, 'accepted', userId); }
      catch { btn.disabled = false; }
    };
  } else {
    btn.innerHTML = '<i class="fas fa-user-plus"></i> Ajouter en ami';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await friendAction('request', userId);
        renderFriendButton(btn, r?.status === 'accepted' ? 'accepted' : 'pending_out', userId);
      } catch { btn.disabled = false; }
    };
  }
}

// Rendu commun (profil perso ET fiche publique d'un autre joueur).
function renderProfile(d, isSelf = true) {
  document.body.classList.toggle('profile-public', !isSelf);
  document.getElementById('profile-back').classList.toggle('hidden', isSelf);
  document.getElementById('profile-hero-name').textContent = d.user.displayName;
  document.getElementById('profile-edit-name-shortcut')?.classList.toggle('hidden', !isSelf);
  // Avatar : en public, depuis les données du joueur consulté (avec cadre).
  if (!isSelf) {
    const av = document.getElementById('profile-avatar');
    const fr = d.cosmetics && d.cosmetics.avatarFrame;
    av.className = 'avatar avatar-xl' + (fr && fr.className ? ' ' + fr.className : '');
    av.style.cssText = (d.user.avatarUrl ? `background-image:url('${d.user.avatarUrl}');` : '') + (fr && fr.css ? fr.css : '');
    av.textContent = d.user.avatarUrl ? '' : (d.user.displayName || '?').charAt(0).toUpperCase();
    // Bouton « Proposer un échange » vers ce joueur
    const tb = document.getElementById('profile-trade-btn');
    tb.classList.remove('hidden');
    tb.onclick = () => { if (typeof openTradeBuilder === 'function') openTradeBuilder(d.user.id, d.user.displayName); };
    // Bouton ami : découvrable directement depuis la fiche (avant, il fallait
    // savoir aller dans Communauté → Amis → recherche pour en ajouter un).
    const fb = document.getElementById('profile-friend-btn');
    fb.classList.remove('hidden');
    renderFriendButton(fb, d.friendStatus, d.user.id);
    // « Défier en duel » : crée une salle privée et envoie l'invitation à ce
    // joueur (s'il est hors ligne, le serveur répond par un message clair).
    const cb = document.getElementById('profile-challenge-btn');
    if (cb) {
      cb.classList.remove('hidden');
      cb.onclick = () => { if (typeof mpChallenge === 'function') mpChallenge(d.user.id); };
    }
  } else {
    document.getElementById('profile-trade-btn').classList.add('hidden');
    document.getElementById('profile-friend-btn').classList.add('hidden');
    document.getElementById('profile-challenge-btn')?.classList.add('hidden');
  }
  applyBackgroundCosmetic(
    document.querySelector('#view-profile .profile-banner'),
    d.cosmetics && d.cosmetics.profileBanner
  );
  const s = d.stats || { played: 0, correct: 0, rate: 0 };
  document.getElementById('profile-played').textContent = s.played;
  document.getElementById('profile-correct').textContent = s.correct;
  document.getElementById('profile-rate').textContent = s.rate + '%';
  document.getElementById('profile-tower').textContent = d.user.towerBestFloor || 0;
  document.getElementById('profile-coop').textContent = d.user.coopBestFloor || 0;
  document.getElementById('profile-cards-count').textContent = d.cardsCount || 0;
  document.getElementById('profile-tokens').textContent = d.user.tokens;
  const since = d.user.createdAt
    ? new Date(d.user.createdAt).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : '—';
  document.getElementById('profile-since').textContent = 'Membre depuis ' + since;

  // Niveau / XP
  const lv = d.level || { level: 1, intoLevel: 0, forNext: 1, progress: 0 };
  document.getElementById('profile-level').textContent = 'Niv. ' + lv.level;
  document.getElementById('profile-level-fill').style.width = Math.round(lv.progress * 100) + '%';
  document.getElementById('profile-level-xp').textContent = `${lv.intoLevel} / ${lv.forNext} XP`;

  // Paliers de récompense
  const lr = d.levelReward || { pending: 0, nextLevel: lv.level + 1, nextReward: 0 };
  const claimBtn = document.getElementById('profile-claim');
  const nextEl = document.getElementById('profile-next-reward');
  if (lr.pending > 0) {
    claimBtn.innerHTML = `<i class="fas fa-gift"></i> Réclamer ${lr.pending} 🪙`;
    claimBtn.disabled = false;
    claimBtn.classList.remove('hidden');
  } else {
    claimBtn.classList.add('hidden');
  }
  nextEl.textContent = `🎁 Niveau ${lr.nextLevel} = +${lr.nextReward} 🪙`;

  // Répartition + vitrine
  const owned = d.ownedByRarity || {};
  const pool = d.poolByRarity || {};
  document.getElementById('profile-rarity-breakdown').innerHTML = RARITY_ORDER.map((r) =>
    `<span class="rb-pill r-${r}">${RARITY_LABELS[r]} <b>${owned[r] || 0}</b><i>/${pool[r] || 0}</i></span>`
  ).join('');
  const show = document.getElementById('profile-showcase');
  const cards = d.showcase || [];
  if (cards.length) {
    show.innerHTML = cards.map((c) => cardHTML(c)).join('');
    document.getElementById('profile-best-label').textContent =
      `Meilleure carte : ${cards[0].name} (${RARITY_LABELS[cards[0].rarity] || cards[0].rarity})`;
  } else {
    show.innerHTML = '';
    document.getElementById('profile-best-label').textContent = 'Aucune carte pour l\'instant.';
  }
  const seeCollBtn = document.getElementById('profile-see-collection');
  if (seeCollBtn) {
    seeCollBtn.classList.toggle('hidden', !d.cardsCount);
    seeCollBtn.innerHTML = `Voir toute la collection (${d.cardsCount}) <i class="fas fa-arrow-right"></i>`;
    seeCollBtn.onclick = () => openPlayerCollection(d.user.id, d.user.displayName);
  }

  loadProfileWishlist(d.user.id, isSelf);
  renderProgression(d.progression || []);
  renderProfileRanked(d.ranked, d.mpRecent || [], d.solo);
  renderTowerHistory(d.towerHistory || []);
  renderTopSeries(d.topSeries || []);
  renderGenreStats(d.genreStats || []);
  renderProfileBadges(d);
  renderAccountSection(isSelf);
}

// Section « Compte » (son propre profil uniquement) : email, mot de passe,
// suppression. Les routes exigent le mot de passe quand le compte en a un.
function renderAccountSection(isSelf) {
  const box = document.getElementById('profile-account');
  if (!box) return;
  const show = isSelf && currentUser && !currentUser.isGuest;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  document.getElementById('account-name-new').value = currentUser.displayName || '';
  document.getElementById('account-email-current').textContent = currentUser.email || '— (compte OAuth sans email)';
  document.getElementById('account-msg').textContent = '';
}
function accountMsg(text, ok) {
  const el = document.getElementById('account-msg');
  if (el) { el.textContent = text; el.style.color = ok ? 'var(--green)' : 'var(--red)'; }
}
async function accountChangeName() {
  const input = document.getElementById('account-name-new');
  const displayName = input.value.trim();
  if (displayName.length < 2 || displayName.length > 30) {
    return accountMsg('Le pseudo doit faire entre 2 et 30 caractères.', false);
  }
  const btn = document.getElementById('account-name-btn');
  btn.disabled = true;
  try {
    const { user } = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ displayName }) });
    currentUser = { ...currentUser, ...user };
    document.getElementById('profile-name').value = currentUser.displayName;
    document.getElementById('profile-hero-name').textContent = currentUser.displayName;
    renderHeaderUser();
    renderProfileAvatar();
    accountMsg('Pseudo mis à jour ✓', true);
  } catch (e) {
    accountMsg(e.message, false);
  } finally {
    btn.disabled = false;
  }
}
async function accountChangeEmail() {
  const email = document.getElementById('account-email-new').value.trim();
  const password = document.getElementById('account-email-pass').value;
  if (!email) return accountMsg('Renseigne la nouvelle adresse.', false);
  try {
    const r = await api('/api/auth/change-email', { method: 'POST', body: JSON.stringify({ email, password }) });
    currentUser.email = r.email;
    document.getElementById('account-email-current').textContent = r.email;
    document.getElementById('account-email-new').value = '';
    document.getElementById('account-email-pass').value = '';
    accountMsg('Adresse email mise à jour ✓', true);
  } catch (e) { accountMsg(e.message, false); }
}
async function accountChangePassword() {
  const currentPassword = document.getElementById('account-pass-current').value;
  const newPassword = document.getElementById('account-pass-new').value;
  if (!newPassword) return accountMsg('Renseigne le nouveau mot de passe.', false);
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    document.getElementById('account-pass-current').value = '';
    document.getElementById('account-pass-new').value = '';
    accountMsg('Mot de passe mis à jour ✓', true);
  } catch (e) { accountMsg(e.message, false); }
}
async function accountDelete() {
  if (!confirm('Supprimer DÉFINITIVEMENT ton compte ?\n\nStats, collection, tokens, échanges : tout est effacé, sans récupération possible.')) return;
  // Le serveur exige le mot de passe si le compte en a un, sinon « SUPPRIMER ».
  const hasPassword = !!currentUser.email; // heuristique d'affichage ; le serveur tranche
  const raw = prompt(hasPassword
    ? 'Confirme avec ton mot de passe (comptes OAuth sans mot de passe : tape SUPPRIMER) :'
    : 'Tape SUPPRIMER pour confirmer :');
  if (raw === null) return;
  const body = raw === 'SUPPRIMER' ? { confirm: 'SUPPRIMER' } : { password: raw, confirm: raw === 'SUPPRIMER' ? raw : '' };
  try {
    await api('/api/auth/account', { method: 'DELETE', body: JSON.stringify(body) });
    alert('Compte supprimé. À bientôt peut-être !');
    location.href = '/';
  } catch (e) { accountMsg(e.message, false); }
}

// Collection complète d'un joueur (lecture seule) — la vitrine du profil ne
// montre que 6 cartes max, ce bouton ouvre tout le reste dans une modale.
let playerCollectionCards = [];
async function openPlayerCollection(userId, displayName) {
  const modal = document.getElementById('player-collection-modal');
  const grid = document.getElementById('player-collection-grid');
  const search = document.getElementById('player-collection-search');
  document.getElementById('player-collection-title').innerHTML =
    `<i class="fas fa-images"></i> Collection de ${escapeHtml(displayName)}`;
  search.value = '';
  grid.innerHTML = '<p class="muted">Chargement…</p>';
  document.getElementById('player-collection-breakdown').innerHTML = '';
  modal.classList.remove('hidden');
  try {
    const { cards, poolByRarity, ownedByRarity } = await api(`/api/gacha/collection?userId=${encodeURIComponent(userId)}`);
    playerCollectionCards = cards;
    document.getElementById('player-collection-breakdown').innerHTML = RARITY_ORDER.map((r) =>
      `<span class="rb-pill r-${r}">${RARITY_LABELS[r]} <b>${ownedByRarity[r] || 0}</b><i>/${poolByRarity[r] || 0}</i></span>`
    ).join('');
    renderPlayerCollectionGrid('');
  } catch (e) {
    grid.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

function renderPlayerCollectionGrid(query) {
  const grid = document.getElementById('player-collection-grid');
  const q = query.trim().toLowerCase();
  const list = q ? playerCollectionCards.filter((c) => c.name.toLowerCase().includes(q)) : playerCollectionCards;
  grid.innerHTML = list.length
    ? list.map((c) => cardHTML(c)).join('')
    : `<p class="muted">${playerCollectionCards.length ? 'Aucune carte dans ce filtre.' : 'Aucune carte pour l\'instant.'}</p>`;
}

// Liste de souhaits affichée sur le profil (la sienne ou celle d'un autre joueur).
async function loadProfileWishlist(userId, isSelf) {
  const box = document.getElementById('profile-wishlist');
  if (!box) return;
  box.innerHTML = '<p class="muted">…</p>';
  let items = [];
  try { ({ items } = await api(`/api/gacha/wishlist?userId=${encodeURIComponent(userId)}`)); } catch { box.innerHTML = ''; return; }
  if (!items.length) {
    box.innerHTML = `<p class="muted">${isSelf ? 'Ajoute des persos à ta wishlist depuis leur fiche ♥' : 'Aucun souhait pour l\'instant.'}</p>`;
    return;
  }
  box.innerHTML = items.map((c) => `<div class="wish-card${c.owned ? ' owned' : ''}" data-cid="${c.id}">${cardHTML(c, { noBorder: true })}${c.owned ? '<span class="wish-owned">obtenu ✓</span>' : ''}</div>`).join('');
  box.querySelectorAll('[data-cid]').forEach((el) =>
    el.addEventListener('click', () => { const id = parseInt(el.dataset.cid); if (typeof openCharacter === 'function') openCharacter(id); })
  );
}

// Graphe SVG de la réussite par jour (14 derniers jours)
function renderProgression(data) {
  const box = document.getElementById('profile-progression');
  if (!box) return;
  if (data.length < 2) { box.innerHTML = '<p class="muted">Joue sur plusieurs jours pour voir ta courbe de progression.</p>'; return; }
  const W = 300, H = 90, pad = 6;
  const n = data.length;
  const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1);
  const y = (v) => H - pad - (v / 100) * (H - 2 * pad);
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.rate).toFixed(1)}`).join(' ');
  const dots = data.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.rate).toFixed(1)}" r="2.5" fill="#6c8cff"><title>${d.day} : ${d.rate}% (${d.played} jouées)</title></circle>`).join('');
  box.innerHTML = `<svg class="prog-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${y(50)}" x2="${W - pad}" y2="${y(50)}" stroke="var(--border)" stroke-dasharray="3 3"/>
      <polyline points="${pts}" fill="none" stroke="url(#pg)" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6c8cff"/><stop offset="1" stop-color="#8a6cff"/></linearGradient></defs>
    </svg>
    <div class="prog-legend"><span>${data[0].day.slice(5)}</span><span>Réussite % · ${data.length} j</span><span>${data[n - 1].day.slice(5)}</span></div>`;
}

function renderProfileRanked(r, recent, solo) {
  const box = document.getElementById('profile-ranked');
  const multiCard = (!r || !r.games)
    ? '<p class="muted">Aucune partie classée. Lance une « Partie classée » dans le multi !</p>'
    : `<div class="ranked-card">
        <span class="ranked-label">🏅 Multi</span>
        ${tierBadge(r.tier, 'big')}
        <span class="ranked-mmr">${r.mmr} MMR</span>
        <span class="hint">${r.wins} victoire(s) · ${r.games} partie(s) · ${r.winrate}% WR</span>
      </div>`;
  const soloCard = (!solo || !solo.games)
    ? ''
    : `<div class="ranked-card">
        <span class="ranked-label">🗓️ Solo</span>
        ${tierBadge(solo.tier, 'big')}
        <span class="ranked-mmr">${solo.mmr} MMR</span>
        <span class="hint">${solo.games} défi(s) · meilleur score ${solo.bestScore}</span>
      </div>`;
  box.innerHTML = multiCard + soloCard;
  const hist = document.getElementById('profile-mp-history');
  hist.innerHTML = (recent || []).length
    ? recent.map((m) => {
        const d = new Date(m.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        const delta = m.ranked && m.mmrAfter != null ? m.mmrAfter - m.mmrBefore : null;
        const deltaTxt = delta != null ? ` <span class="${delta >= 0 ? 'gain' : 'spend'}">${delta >= 0 ? '+' : ''}${delta}</span>` : '';
        return `<li><span class="th-floor">${m.ranked ? '🏅' : '🎮'} ${m.placement}ᵉ/${m.players}${deltaTxt}</span><span class="date">${d}</span></li>`;
      }).join('')
    : '';
}

function renderTowerHistory(runs) {
  const el = document.getElementById('profile-tower-history');
  if (!runs.length) { el.innerHTML = '<li class="muted">Aucune partie pour l\'instant.</li>'; return; }
  el.innerHTML = runs.map((r) => {
    const d = r.finishedAt ? new Date(r.finishedAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : '';
    return `<li><span class="th-floor">🏰 Étage ${r.floor}</span><span class="date">${d}</span></li>`;
  }).join('');
}

function renderTopSeries(series) {
  const el = document.getElementById('profile-top-series');
  if (!series.length) { el.innerHTML = '<li class="muted">Joue des musiques pour remplir ce classement.</li>'; return; }
  const max = series[0].plays || 1;
  el.innerHTML = series.map((s) => `
    <li class="ts-row">
      <span class="ts-name">${escapeHtml(s.title)}</span>
      <span class="ts-bar"><span class="ts-fill" style="width:${Math.round((s.plays / max) * 100)}%"></span></span>
      <span class="ts-plays">${s.plays}</span>
    </li>`).join('');
}

// Réussite par genre (« fort en shonen, faible en romance ») : barre = taux de
// réussite, triée par volume joué. Seuil de manches côté serveur (≥ 10) pour
// éviter les 0 %/100 % calculés sur deux extraits.
function renderGenreStats(stats) {
  const el = document.getElementById('profile-genres');
  if (!el) return;
  if (!stats.length) {
    el.innerHTML = '<p class="muted">Joue des musiques pour voir tes points forts par genre.</p>';
    return;
  }
  const best = Math.max(...stats.map((g) => g.rate));
  const worst = Math.min(...stats.map((g) => g.rate));
  el.innerHTML = stats.map((g) => {
    const label = (typeof genreLabel === 'function') ? genreLabel(g.genre) : g.genre;
    const tag = stats.length >= 3 && g.rate === best ? ' 💪' : stats.length >= 3 && g.rate === worst ? ' 🎯' : '';
    return `<li class="ts-row" title="${g.plays} manche(s) jouée(s)">
      <span class="ts-name">${escapeHtml(label)}${tag}</span>
      <span class="ts-bar"><span class="ts-fill" style="width:${g.rate}%"></span></span>
      <span class="ts-plays">${g.rate}%</span>
    </li>`;
  }).join('');
  el.innerHTML = `<ul class="top-series-list">${el.innerHTML}</ul><p class="hint" style="margin-top:6px">💪 point fort · 🎯 à travailler — barre = taux de réussite, tri par volume joué.</p>`;
}

// Réclame les récompenses de niveau
async function claimLevels() {
  const btn = document.getElementById('profile-claim');
  btn.disabled = true;
  try {
    const r = await api('/api/profile/claim-levels', { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = r.tokens;
    renderHeaderUser();
    if (r.granted > 0) { sfx.levelup(); burstConfetti(); }
    btn.innerHTML = `<i class="fas fa-check"></i> +${r.granted} 🪙 !`;
    profileData = await api(`/api/profile/${currentUser.id}`);
    setTimeout(() => renderProfile(profileData), 1200);
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
  }
}

// Lien de profil partageable
function shareProfile() {
  const url = `${location.origin}/?u=${currentUser.id}`;
  const btn = document.getElementById('profile-share');
  navigator.clipboard?.writeText(url).then(
    () => { btn.innerHTML = '<i class="fas fa-check"></i> Lien copié !'; setTimeout(() => (btn.innerHTML = '<i class="fas fa-share-nodes"></i> Partager mon profil'), 2000); },
    () => prompt('Copie ce lien :', url)
  );
}

// Hauts faits : badges débloqués selon la progression
function renderProfileBadges(d) {
  const played = d?.stats?.played || 0;
  const rate = d?.stats?.rate || 0;
  const tower = d?.user?.towerBestFloor || 0;
  const cards = d?.cardsCount || 0;
  const owned = d?.ownedByRarity || {};
  const tokens = d?.user?.tokens || 0;
  const rankedGames = d?.user?.rankedGames || 0;
  const rankedWins = d?.user?.rankedWins || 0;
  const soloGames = d?.user?.soloGames || 0;
  const streak = d?.user?.dailyStreakBest || 0;
  const maxStars = d?.maxStars || 0;
  // value = progression actuelle, target = objectif. La barre = value/target.
  const defs = [
    { ic: '🌟', nm: 'Premier pas', desc: 'Jouer 1 musique', value: played, target: 1, unit: '' },
    { ic: '🎵', nm: 'Mélomane', desc: '100 musiques jouées', value: played, target: 100 },
    { ic: '🎯', nm: 'Oreille affûtée', desc: '80% de réussite (20+ parties)', value: played >= 20 ? rate : 0, target: 80, unit: '%' },
    { ic: '🏰', nm: 'Grimpeur', desc: 'Étage 10 au Château', value: tower, target: 10 },
    { ic: '👑', nm: 'Maître du Château', desc: 'Étage 25 au Château', value: tower, target: 25 },
    { ic: '🎴', nm: 'Collectionneur', desc: 'Posséder 50 cartes', value: cards, target: 50 },
    { ic: '✨', nm: 'Chasseur de légendes', desc: 'Obtenir un Légendaire', value: owned.legendary || 0, target: 1 },
    { ic: '💖', nm: 'Mythique !', desc: 'Obtenir un Mythique', value: owned.mythic || 0, target: 1 },
    { ic: '💰', nm: 'Fortune', desc: 'Avoir 1000 tokens', value: tokens, target: 1000 },
    // Nouveaux : classé, défi du jour, ascension
    { ic: '⚔️', nm: 'Compétiteur', desc: '5 parties classées (multi)', value: rankedGames, target: 5 },
    { ic: '🏅', nm: 'Champion', desc: '10 victoires en classé', value: rankedWins, target: 10 },
    { ic: '🗓️', nm: 'Quotidien', desc: 'Terminer un défi du jour', value: soloGames, target: 1 },
    { ic: '🔥', nm: 'Assidu', desc: 'Série de 7 jours au défi', value: streak, target: 7 },
    { ic: '⭐', nm: 'Ascension', desc: 'Monter une carte en ★5', value: maxStars, target: 5 },
  ].map((b) => ({ ...b, got: b.value >= b.target }));

  const earned = defs.filter((b) => b.got).length;
  // Débloqués d'abord, puis par progression décroissante (les plus proches en tête).
  defs.sort((a, b) => (b.got - a.got) || (b.value / b.target - a.value / a.target));

  document.getElementById('profile-badges').innerHTML =
    `<div class="badges-count">${earned}/${defs.length} débloqués</div>` +
    defs
      .map((b) => {
        const pct = Math.min(100, Math.round((b.value / b.target) * 100));
        const cur = Math.min(b.value, b.target);
        const prog = b.got ? '' : `<span class="badge-prog">${cur}/${b.target}${b.unit || ''}</span>`;
        return `<div class="badge-item${b.got ? ' got' : ''}">
          <span class="badge-ic">${b.ic}</span>
          <span class="badge-txt">
            <span class="badge-nm">${escapeHtml(b.nm)}</span>
            <span class="badge-desc">${escapeHtml(b.desc)}</span>
            ${b.got ? '' : `<span class="badge-bar"><span class="badge-fill" style="width:${pct}%"></span></span>`}
          </span>
          ${b.got ? '<span class="badge-check"><i class="fas fa-circle-check"></i></span>' : prog}
        </div>`;
      })
      .join('');
}

async function loadTokenHistory() {
  const list = document.getElementById('token-history-list');
  try {
    const { transactions } = await api('/api/economy/transactions');
    if (!transactions.length) {
      list.innerHTML = '<li class="muted">Aucune transaction pour l\'instant.</li>';
      return;
    }
    list.innerHTML = transactions
      .map((t) => {
        const d = new Date(t.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
        const sign = t.amount >= 0 ? '+' : '';
        const cls = t.amount >= 0 ? 'gain' : 'spend';
        return `<li><span>${t.reason}</span><span class="amt ${cls}">${sign}${t.amount} 🪙</span><span class="date">${d}</span></li>`;
      })
      .join('');
  } catch {
    list.innerHTML = '<li class="muted">—</li>';
  }
}

async function saveProfile() {
  setProfileError('');
  const payload = {
    displayName: document.getElementById('profile-name').value,
    bio: document.getElementById('profile-bio').value,
  };
  if (pendingAvatar !== undefined) payload.avatar = pendingAvatar;
  const btn = document.getElementById('profile-save');
  const original = btn.innerHTML;
  try {
    const { user } = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(payload) });
    currentUser = { ...currentUser, ...user };
    pendingAvatar = undefined;
    renderHeaderUser();
    document.getElementById('profile-hero-name').textContent = currentUser.displayName;
    renderProfileAvatar();
    btn.innerHTML = '<i class="fas fa-check"></i> Enregistré !';
    setTimeout(() => (btn.innerHTML = original), 1800);
  } catch (err) {
    setProfileError(err.message);
  }
}

// Recadre une image en carré et la compresse en data URL JPEG
function fileToResizedDataURL(file, size = 256, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('img'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

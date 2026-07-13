// Admin — extrait de main.js (script classique, scope global partagé).
// Chargé APRÈS main.js dans index.html : réutilise ses globals (currentUser, api,
// settings, escapeHtml, otherAvatar, getVolume…). Ne pas charger comme module ES.

// ── ADMIN : gestion des raretés ──
let adminPage = 1, adminSearch = '', adminRarity = 'all', adminPages = 1;

function openAdmin() {
  showView('admin');
  document.getElementById('admin-search').value = '';
  adminSearch = ''; adminRarity = 'all';
  document.getElementById('admin-backfill-status').textContent = '';
  // Repart sur l'onglet Catalogue (les panneaux gardent sinon le dernier état).
  document.querySelectorAll('#admin-tabs .admin-tab').forEach((t) => t.classList.toggle('active', t.dataset.adminTab === 'catalog'));
  ['catalog', 'gacha', 'reports', 'danger'].forEach((p) =>
    document.getElementById('admin-panel-' + p)?.classList.toggle('hidden', p !== 'catalog')
  );
  loadAdminStats();
  loadR2Status();
  loadAdminChars(1, '');
}

async function loadR2Status() {
  clearTimeout(loadR2Status.timer);
  const btn = document.getElementById('admin-r2-btn');
  const status = document.getElementById('admin-r2-status');
  try {
    const r = await api('/api/admin/r2-status');
    const running = !!r.migration?.running;
    btn.dataset.running = String(running);
    btn.disabled = !r.connected;
    btn.innerHTML = running
      ? '<i class="fas fa-stop"></i> Arrêter la migration R2'
      : '<i class="fas fa-cloud-arrow-up"></i> Lancer la migration R2';
    status.textContent = r.connected
      ? `${r.uploaded}/${r.total} sons sur le CDN · ${r.remaining} restants`
        + (running ? ` · migration active (+${r.migration.uploaded}, ${r.migration.failed} échec(s))` : '')
        + (running && r.migration?.retryWaves ? ` · ${r.migration.retryWaves} vague(s) de retry` : '')
        + (r.migration?.permanentFailures ? ` · ${r.migration.permanentFailures} en échec définitif` : '')
        + (!running && r.migration?.lastError ? ` · dernier problème : ${r.migration.lastError}` : '')
      : r.configured
        ? `R2 configuré mais inaccessible : ${r.error || 'vérifie les identifiants'}`
        : 'R2 non configuré sur Railway';
    if (running) loadR2Status.timer = setTimeout(loadR2Status, 2500);
  } catch (error) {
    status.textContent = 'R2 : ' + error.message;
  }
}

async function runR2Migration() {
  const btn = document.getElementById('admin-r2-btn');
  const status = document.getElementById('admin-r2-status');
  btn.disabled = true;
  try {
    const running = btn.dataset.running === 'true';
    status.textContent = running ? 'Arrêt après le fichier en cours…' : 'Démarrage de la migration continue…';
    await api(`/api/admin/r2-migration/${running ? 'stop' : 'start'}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await loadR2Status();
  } catch (error) {
    status.textContent = 'Erreur R2 : ' + error.message;
  } finally {
    if (btn.dataset.running !== 'true') btn.disabled = false;
  }
}

async function loadAdminStats() {
  const box = document.getElementById('admin-stats');
  if (!box) return;
  try {
    const d = await api('/api/admin/stats');
    const stat = (label, val) => `<div class="astat"><span>${val}</span><label>${label}</label></div>`;
    const daily = d.visits.daily || [];
    const max = Math.max(1, ...daily.map((v) => v.count));
    const bars = daily.map((v) =>
      `<span class="avis-bar" style="height:${Math.max(6, Math.round((v.count / max) * 100))}%" title="${v.day} : ${v.count} visiteur(s)"></span>`
    ).join('');
    box.innerHTML = `
      <div class="astat-grid">
        ${stat('Visiteurs aujourd\'hui', d.visits.today)}
        ${stat('Comptes', d.users.total)}
        ${stat('Nouveaux (7j)', d.users.new7d)}
        ${stat('Parties multi', d.activity.mpGames)}
        ${stat('Parties Château', d.activity.towerRuns)}
        ${stat('Tirages gacha', d.activity.pulls)}
        ${stat('Échanges conclus', d.activity.tradesOk)}
        ${stat('Cartes en circulation', d.activity.cardsInCirculation)}
      </div>
      <div class="avis-chart-wrap">
        <label class="hint">Visiteurs uniques / jour (14 derniers jours)</label>
        <div class="avis-chart">${bars || '<span class="hint">Pas encore de données.</span>'}</div>
      </div>`;
  } catch { box.innerHTML = ''; }
}

// Répartition globale du pool par rareté, toujours visible (indépendante du
// filtre/recherche en cours) — utile pour suivre le rééquilibrage manuel
// avant un reset global.
function renderAdminRaritySummary(byRarity, grandTotal) {
  const box = document.getElementById('admin-rarity-summary');
  if (!box) return;
  const rows = RARITY_ORDER.map((r) => {
    const n = byRarity[r] || 0;
    const pct = grandTotal ? ((n / grandTotal) * 100).toFixed(1) : '0.0';
    return `<div class="astat r-${r}"><span>${n.toLocaleString('fr-FR')}</span><label>${RARITY_LABELS[r]} · ${pct}%</label></div>`;
  }).join('');
  box.innerHTML = `
    <h3><i class="fas fa-layer-group"></i> ${(grandTotal || 0).toLocaleString('fr-FR')} personnages au total</h3>
    <div class="astat-grid">${rows}</div>`;
}

async function loadAdminChars(page, search) {
  if (page < 1) return;
  adminSearch = search;
  const tbody = document.getElementById('admin-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Chargement…</td></tr>';
  try {
    const rq = adminRarity !== 'all' ? `&rarity=${adminRarity}` : '';
    const r = await api(`/api/admin/characters?page=${page}&search=${encodeURIComponent(search)}${rq}`);
    adminPage = r.page; adminPages = r.pages || 1;
    document.getElementById('admin-filters').innerHTML = (() => {
      const byRarity = r.byRarity || {};
      const chips = [`<button class="coll-chip${adminRarity === 'all' ? ' active' : ''}" data-filter="all">Tous (${r.grandTotal ?? ''})</button>`];
      RARITY_ORDER.forEach((rr) =>
        chips.push(`<button class="coll-chip r-${rr}${adminRarity === rr ? ' active' : ''}" data-filter="${rr}">${RARITY_LABELS[rr]} (${byRarity[rr] || 0})</button>`)
      );
      return chips.join('');
    })();
    if (r.byRarity) renderAdminRaritySummary(r.byRarity, r.grandTotal);
    if (r.missingSeries != null) {
      document.getElementById('admin-backfill-status').textContent =
        r.missingSeries ? `${r.missingSeries} séries manquantes` : 'Toutes les séries sont remplies ✅';
    }
    if (!r.characters.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Aucun personnage.</td></tr>';
    } else {
      tbody.innerHTML = r.characters
        .map((c) => {
          const opts = RARITY_ORDER.map((rr) => `<option value="${rr}"${rr === c.rarity ? ' selected' : ''}>${RARITY_LABELS[rr]}</option>`).join('');
          const img = c.imageUrl ? `style="background-image:url('${c.imageUrl}')"` : '';
          return `<tr>
            <td><span class="admin-thumb" ${img}></span></td>
            <td>${escapeHtml(c.name)}</td>
            <td class="muted">${escapeHtml(c.series && c.series !== '—' ? c.series : '—')}</td>
            <td class="nowrap">${(c.favourites || 0).toLocaleString('fr-FR')}</td>
            <td><select class="admin-rarity r-${c.rarity}" data-cid="${c.id}">${opts}</select></td>
            <td><button class="admin-feat${c.featured ? ' on' : ''}" data-feat data-cid="${c.id}" title="Vedette">${c.featured ? '⭐' : '☆'}</button></td>
            <td><button class="btn-secondary" data-instances data-cid="${c.id}" title="Voir qui possède quel exemplaire"><i class="fas fa-hashtag"></i></button></td>
          </tr>`;
        })
        .join('');
    }
    document.getElementById('admin-pageinfo').textContent = `Page ${adminPage} / ${adminPages}`;
    document.getElementById('admin-prev').disabled = adminPage <= 1;
    document.getElementById('admin-next').disabled = adminPage >= adminPages;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(e.message)}</td></tr>`;
  }
}

// ── ADMIN : exemplaires d'un personnage (qui possède quel n° de série) ──
let adminInstances = [];

async function openAdminInstances(characterId) {
  const modal = document.getElementById('admin-instances-modal');
  const tbody = document.getElementById('admin-instances-tbody');
  document.getElementById('admin-instances-search').value = '';
  modal.classList.remove('hidden');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">Chargement…</td></tr>';
  try {
    const r = await api(`/api/admin/characters/${characterId}/instances`);
    adminInstances = r.instances;
    document.getElementById('admin-instances-title').innerHTML =
      `<i class="fas fa-hashtag"></i> Exemplaires de ${escapeHtml(r.character.name)} (${r.character.minted}/${r.character.maxSupply})`;
    renderAdminInstances();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderAdminInstances() {
  const tbody = document.getElementById('admin-instances-tbody');
  const q = document.getElementById('admin-instances-search').value.trim().toLowerCase();
  const filtered = q
    ? adminInstances.filter((i) => i.user.displayName.toLowerCase().includes(q) || String(i.serial).includes(q))
    : adminInstances;
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Aucun exemplaire.</td></tr>';
    return;
  }
  tbody.innerHTML = filtered
    .map((i) => `<tr>
      <td>#${i.serial}</td>
      <td>${escapeHtml(i.user.displayName)}</td>
      <td class="muted">${i.source === 'craft' ? 'Fabriqué' : 'Tirage'}</td>
      <td>${i.listed ? '🏷️' : ''}</td>
      <td class="muted">${new Date(i.obtainedAt).toLocaleDateString('fr-FR')}</td>
    </tr>`)
    .join('');
}

async function toggleFeatured(btn) {
  const id = btn.dataset.cid;
  const on = !btn.classList.contains('on');
  btn.disabled = true;
  try {
    const r = await api(`/api/admin/characters/${id}/featured`, { method: 'PATCH', body: JSON.stringify({ featured: on }) });
    btn.classList.toggle('on', r.featured);
    btn.textContent = r.featured ? '⭐' : '☆';
  } catch (e) { alert(e.message); }
  finally { btn.disabled = false; }
}

async function runImportCharacters() {
  const btn = document.getElementById('admin-import-btn');
  const status = document.getElementById('admin-import-status');
  btn.disabled = true;
  status.textContent = 'Import depuis AniList…';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let totalAdded = 0, lastTotal = 0, fails = 0, nextPage = null;
  try {
    for (let i = 0; i < 16; i++) { // ~800 personnages parcourus par clic
      let r;
      try {
        const body = nextPage == null ? {} : { page: nextPage };
        r = await api('/api/admin/import-characters', { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        if (++fails > 4) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/4`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      totalAdded += r.added;
      lastTotal = r.total;
      nextPage = (r.page || 1) + 1; // on avance page par page, même si la page était déjà connue
      status.textContent = `+${totalAdded} ajoutés · ${r.total} au total (page ${r.page})…`;
      if (!r.hasMore) {
        status.textContent = r.capped
          ? `✅ Plafond AniList atteint (${r.total} personnages). Pense à « Recalculer les raretés ».`
          : `✅ Terminé : ${r.total} personnages. Pense à « Recalculer les raretés ».`;
        loadAdminChars(1, adminSearch);
        return;
      }
      await sleep(1100); // throttle AniList
    }
    status.textContent = `✅ +${totalAdded} personnages · ${lastTotal} au total. Reclique, puis « Recalculer les raretés ».`;
    loadAdminChars(1, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Pareil que runImportCharacters, mais via /import-characters-anime : contourne
// le plafond AniList de 5000 (qui touche aussi bien la recherche globale de
// personnages que le browse global d'animes) en parcourant les animes ANNÉE
// PAR ANNÉE et en récupérant leurs personnages principaux/secondaires
// (dédupliqués). Le curseur { year, page } est géré par le serveur — on le
// repasse tel quel, sans logique d'année côté client.
async function runImportCharactersFromAnime() {
  const btn = document.getElementById('admin-import-anime-btn');
  const status = document.getElementById('admin-import-anime-status');
  btn.disabled = true;
  status.textContent = 'Import via les animes AniList…';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let totalAdded = 0, lastTotal = 0, fails = 0, cursor = {};
  try {
    for (let i = 0; i < 16; i++) { // ~800 animes parcourus par clic (50/requête)
      let r;
      try {
        r = await api('/api/admin/import-characters-anime', { method: 'POST', body: JSON.stringify(cursor) });
      } catch (e) {
        if (++fails > 4) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/4`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      totalAdded += r.added;
      lastTotal = r.total;
      cursor = { year: r.year, page: r.page };
      status.textContent = `+${totalAdded} ajoutés · ${r.total} au total (${r.processedYear || r.year}, page ${r.page})…`;
      if (!r.hasMore) {
        status.textContent = r.done
          ? `✅ Historique AniList épuisé (${r.total} personnages). Pense à « Recalculer les raretés ».`
          : `✅ Terminé : ${r.total} personnages. Pense à « Recalculer les raretés ».`;
        loadAdminChars(1, adminSearch);
        return;
      }
      await sleep(1100); // throttle AniList
    }
    status.textContent = `✅ +${totalAdded} personnages · ${lastTotal} au total (arrêté à ${cursor.year}). Reclique pour continuer, puis « Recalculer les raretés ».`;
    loadAdminChars(1, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetMe() {
  if (!confirm('Réinitialiser TON compte ? (stats, SRS, cartes gacha, tokens, Château, classé seront effacés. Profil et « Ma liste » conservés.)')) return;
  const btn = document.getElementById('admin-reset-btn');
  const status = document.getElementById('admin-reset-status');
  btn.disabled = true;
  status.textContent = 'Réinitialisation…';
  try {
    await api('/api/admin/reset-me', { method: 'POST', body: JSON.stringify({}) });
    currentUser.tokens = 0;
    currentUser.towerBestFloor = 0;
    renderHeaderUser();
    status.textContent = '✅ Compte réinitialisé. Recharge la page.';
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetAll() {
  const ans = prompt('⚠️ RESET GLOBAL de TOUS les comptes (stats, gacha, tokens, classé, Château). Profils et listes conservés.\n\nTape RESET pour confirmer :');
  if (ans !== 'RESET') return;
  const btn = document.getElementById('admin-reset-all-btn');
  const status = document.getElementById('admin-reset-all-status');
  btn.disabled = true;
  status.textContent = 'Réinitialisation globale…';
  try {
    const r = await api('/api/admin/reset-all', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
    status.textContent = `✅ ${r.users} comptes réinitialisés. Recharge la page.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetGacha() {
  const status = document.getElementById('admin-reset-gacha-status');
  const ans = prompt("⚠️ RESET GACHA de TOUS les comptes : collection, exemplaires numérotés, échanges et albums supprimés ; stock mondial remis à zéro. AUCUN remboursement — les tokens ne sont pas touchés. Les stats de quiz/Château/multijoueur/défi du jour/niveaux ne sont PAS touchées non plus.\n\nTape RESET_GACHA (exactement, en majuscules) pour confirmer :");
  // Sans ce message, un clic "Annuler" ou une confirmation mal tapée ne
  // laissait AUCUNE trace à l'écran — perçu comme "rien ne s'est passé".
  if (ans === null) { status.textContent = 'Annulé.'; return; }
  if (ans !== 'RESET_GACHA') { status.textContent = `❌ Confirmation incorrecte ("${ans}" ≠ "RESET_GACHA") — rien n'a été fait, réessaie.`; return; }
  const btn = document.getElementById('admin-reset-gacha-btn');
  btn.disabled = true;
  status.textContent = 'Réinitialisation du gacha…';
  try {
    const r = await api('/api/admin/reset-gacha', { method: 'POST', body: JSON.stringify({ confirm: 'RESET_GACHA' }) });
    status.textContent = `✅ ${r.users} comptes réinitialisés (aucun remboursement). Les joueurs verront une explication à leur prochaine connexion.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runRecomputeRarities() {
  const btn = document.getElementById('admin-recompute-btn');
  const status = document.getElementById('admin-recompute-status');
  btn.disabled = true;
  status.textContent = 'Recalcul en cours…';
  try {
    const r = await api('/api/admin/recompute-rarities', { method: 'POST', body: JSON.stringify({}) });
    const order = ['mythic', 'legendary', 'epic', 'rare', 'common'];
    const summary = order.filter((k) => r.counts[k]).map((k) => `${RARITY_LABELS[k]} ${r.counts[k]}`).join(' · ');
    status.textContent = `✅ ${r.total} personnages rééquilibrés — ${summary}`;
    loadAdminChars(adminPage, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Diagnostic des raretés (lecture seule) : montre la chance effective de tirer
// un perso par palier, et liste les raretés modifiées à la main (écart entre
// la rareté stockée et celle attendue par rang).
async function runRarityCheck() {
  const btn = document.getElementById('admin-rarity-check-btn');
  const status = document.getElementById('admin-rarity-check-status');
  btn.disabled = true;
  status.textContent = 'Analyse…';
  try {
    const r = await api('/api/admin/rarity-check');
    const rows = r.rarities.map((x) => `<tr>
      <td>${x.label}</td>
      <td>${x.count}${x.soldOut ? ` <span class="muted">(${x.soldOut} épuisés)</span>` : ''}</td>
      <td>${x.tierRatePct}%</td>
      <td>${x.perCharChancePct ? x.perCharChancePct.toFixed(4) + '%' : '—'}</td>
      <td>${x.oneInN ? '1 sur ' + x.oneInN.toLocaleString('fr-FR') : '—'}</td>
    </tr>`).join('');
    const ovr = r.overrides.sample.slice(0, 40).map((o) =>
      `<tr><td>${escapeHtml(o.name)}</td><td>#${o.rank}</td><td>${RARITY_LABELS[o.stored] || o.stored}</td><td>${RARITY_LABELS[o.byRank] || o.byRank}</td></tr>`
    ).join('');
    const mismatchLine = r.supplyMismatches.total
      ? `<p style="color:var(--red)">⚠️ ${r.supplyMismatches.total} perso(s) avec un stock (maxSupply) incohérent avec leur rareté — clique « Corriger les stocks » ci-dessous.</p>`
      : '<p>✅ Stocks (maxSupply) cohérents avec les raretés.</p>';
    status.innerHTML = `
      <p><b>${r.total}</b> personnages. Chance effective de tirer un perso PRÉCIS par palier (= taux du palier ÷ nb de persos tirables) :</p>
      <table class="catalog-table"><thead><tr><th>Rareté</th><th>Nb</th><th>Taux palier</th><th>Par perso</th><th>≈</th></tr></thead><tbody>${rows}</tbody></table>
      ${mismatchLine}
      <p style="margin-top:8px"><b>${r.overrides.total}</b> rareté(s) modifiée(s) à la main (différentes de la répartition par rang) :</p>
      ${r.overrides.total
        ? `<table class="catalog-table"><thead><tr><th>Perso</th><th>Rang</th><th>Rareté manuelle</th><th>Rareté par rang</th></tr></thead><tbody>${ovr}</tbody></table>${r.overrides.total > 40 ? `<p class="muted">… et ${r.overrides.total - 40} autre(s).</p>` : ''}`
        : '<p class="muted">Aucune — toutes les raretés suivent le rang de popularité.</p>'}
      <p class="hint" style="margin-top:6px">✅ Ces raretés manuelles sont bien prises en compte dans les tirages : un perso passé Mythique se tire au taux Mythique. Ne clique PAS « Recalculer les raretés » si tu veux les garder.</p>`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runFixSupply() {
  const btn = document.getElementById('admin-fix-supply-btn');
  const status = document.getElementById('admin-fix-supply-status');
  btn.disabled = true;
  status.textContent = 'Correction des stocks…';
  try {
    const r = await api('/api/admin/fix-supply-mismatch', { method: 'POST', body: JSON.stringify({}) });
    status.textContent = r.fixed ? `✅ ${r.fixed} stock(s) corrigé(s).` : '✅ Aucun stock à corriger.';
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runSuppressBanner() {
  const btn = document.getElementById('admin-suppress-banner-btn');
  const status = document.getElementById('admin-suppress-banner-status');
  btn.disabled = true;
  status.textContent = 'Suppression…';
  try {
    const r = await api('/api/gacha/banner-suppress', { method: 'POST' });
    status.textContent = `✅ Bannière supprimée pour la semaine ${r.week} — retour à la normale au reset de lundi.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runRefreshFeatured() {
  const btn = document.getElementById('admin-refresh-featured-btn');
  const status = document.getElementById('admin-refresh-featured-status');
  btn.disabled = true;
  status.textContent = 'Relance en cours…';
  try {
    const r = await api('/api/gacha/refresh-featured', { method: 'POST' });
    const names = (r.winners || []).map((w) => `${w.name} (${w.rarity})`).join(', ');
    const supp = r.unsuppressed ? ' (bannière supprimée réactivée)' : '';
    status.textContent = `Vedette relancée selon les votes${supp} : ${names || r.applied.join(', ')}. Rouvre la page Gacha pour la voir.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runResetWeeklyVotes() {
  const btn = document.getElementById('admin-reset-weekly-votes-btn');
  const status = document.getElementById('admin-reset-weekly-votes-status');
  if (!confirm("Supprimer tous les votes de vedette en cours (bannière actuelle + semaine prochaine) et forcer un recalcul complet ? Irréversible.")) return;
  btn.disabled = true;
  status.textContent = 'Réinitialisation…';
  try {
    const r = await api('/api/gacha/reset-weekly-votes', { method: 'POST' });
    status.textContent = `✅ ${r.deletedVotes} vote(s) supprimé(s) — bannière recalculée sur la nouvelle répartition (semaine ${r.week}).`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function setCharacterRarity(id, rarity, sel) {
  sel.disabled = true;
  try {
    await api(`/api/admin/characters/${id}`, { method: 'PATCH', body: JSON.stringify({ rarity }) });
    sel.className = `admin-rarity r-${rarity}`;
  } catch (e) {
    alert(e.message);
  } finally {
    sel.disabled = false;
  }
}

async function runImportEndings() {
  const btn = document.getElementById('admin-endings-btn');
  const status = document.getElementById('admin-endings-status');
  btn.disabled = true;
  let total = 0, added = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/import-endings', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (animethemes saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed; added += r.added;
      status.textContent = `${total} animes scannés · ${added} endings ajoutés · ${r.remaining} restants…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1200);
    }
    status.textContent = `Terminé ✅ (${added} endings ajoutés)`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runBackfillFormat() {
  const btn = document.getElementById('admin-format-btn');
  const status = document.getElementById('admin-format-status');
  btn.disabled = true;
  let total = 0, updated = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/backfill-format', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed; updated += r.updated;
      status.textContent = `${total} animes traités · ${updated} musiques taguées · ${r.remaining} restantes…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1500); // throttle AniList
    }
    status.textContent = `Terminé ✅ (${updated} musiques taguées)`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function runBackfillSeasons() {
  const btn = document.getElementById('admin-seasons-btn');
  const status = document.getElementById('admin-seasons-status');
  btn.disabled = true;
  let total = 0, updated = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/backfill-seasons', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed; updated += r.updated;
      status.textContent = `${total} animes traités · ${updated} musiques taguées · ${r.remaining} restantes…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1500); // throttle AniList
    }
    status.textContent = `Terminé ✅ (${updated} musiques taguées)`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// Audit des numéros de saison : recalcule chaque numéro depuis AniList et
// compare au stocké (le backfill ne repasse jamais sur une valeur posée, elle
// peut se périmer quand une chaîne se complète après coup). fix=true corrige.
async function runSeasonCheck(fix) {
  const checkBtn = document.getElementById('admin-season-check-btn');
  const fixBtn = document.getElementById('admin-season-fix-btn');
  const status = document.getElementById('admin-season-check-status');
  checkBtn.disabled = true;
  fixBtn.disabled = true;
  let cursor = 0, total = 0, fixed = 0, fails = 0;
  const mismatches = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const renderMismatches = () => mismatches.length
    ? `<table class="catalog-table"><thead><tr><th>Anime</th><th>Stocké</th><th>Recalculé</th></tr></thead><tbody>${
      mismatches.slice(0, 60).map((m) =>
        `<tr><td>${escapeHtml(m.title)}</td><td>${m.stored ? 'S' + m.stored : '—'}</td><td>${m.computed ? 'S' + m.computed : '—'}</td></tr>`
      ).join('')}</tbody></table>${mismatches.length > 60 ? `<p class="muted">… et ${mismatches.length - 60} autre(s).</p>` : ''}`
    : '';
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/season-check', { method: 'POST', body: JSON.stringify({ cursor, fix: !!fix }) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed;
      fixed += r.fixed;
      mismatches.push(...r.mismatches);
      status.innerHTML = `${total} animes vérifiés · ${mismatches.length} écart(s)${fix ? ` · ${fixed} musiques corrigées` : ''}…${renderMismatches()}`;
      if (r.done || !r.nextCursor) break;
      cursor = r.nextCursor;
      await sleep(1500); // throttle AniList
    }
    status.innerHTML = mismatches.length
      ? `${fix ? '✅ Corrigé' : '⚠️ Vérification terminée'} : ${mismatches.length} écart(s) sur ${total} animes${fix ? ` (${fixed} musiques mises à jour)` : ' — clique « Corriger les écarts » pour appliquer les numéros recalculés'}.${renderMismatches()}`
      : `✅ Vérification terminée : ${total} animes, aucun écart.`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    checkBtn.disabled = false;
    fixBtn.disabled = false;
  }
}

// Vérifie/répare les thèmes croisés entre animes (musique importée sous le
// mauvais anilistId par l'ancienne recherche floue — ex. OP de MHA S1 sous la
// saison 6). Boucle par curseur sur /api/admin/theme-check ; le réseau
// animethemes est throttlé côté serveur → lots courts, patience affichée.
async function runThemeCheck(fix) {
  const checkBtn = document.getElementById('admin-theme-check-btn');
  const fixBtn = document.getElementById('admin-theme-fix-btn');
  const status = document.getElementById('admin-theme-check-status');
  checkBtn.disabled = true;
  fixBtn.disabled = true;
  let cursor = 0, total = 0, fixed = 0, deleted = 0, unverifiable = 0, fails = 0;
  const mismatches = [];
  const unverifiables = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Animes sans fiche animethemes exploitable : rien d'automatique possible —
  // liste remontée à l'admin pour inspection via « Anime précis » (recherche
  // + réinitialisation de l'anilistId).
  const renderUnverifiables = () => unverifiables.length
    ? `<p class="muted" style="margin-top:6px">Invérifiables (pas de fiche animethemes — à inspecter via « Anime précis ») : ${
      unverifiables.slice(0, 25).map((u) => `${escapeHtml(u.anime)} <span class="muted">#${u.anilistId}</span>`).join(' · ')
    }${unverifiables.length > 25 ? ` · … et ${unverifiables.length - 25} autre(s)` : ''}</p>`
    : '';
  const renderMismatches = () => mismatches.length
    ? `<table class="catalog-table"><thead><tr><th>Anime</th><th>Stocké</th><th>Fiche animethemes</th><th>Action</th></tr></thead><tbody>${
      mismatches.slice(0, 60).map((m) =>
        `<tr><td>${escapeHtml(m.anime)} <span class="muted">#${m.anilistId}</span></td><td>${escapeHtml(m.stored)}</td><td>${m.real ? escapeHtml(m.real) : '—'}</td><td>${m.action === 'update' ? 'remplacer' : 'supprimer'}</td></tr>`
      ).join('')}</tbody></table>${mismatches.length > 60 ? `<p class="muted">… et ${mismatches.length - 60} autre(s).</p>` : ''}`
    : '';
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/theme-check', { method: 'POST', body: JSON.stringify({ cursor, fix: !!fix }) });
      } catch (e) {
        if (++fails > 5) throw e;
        status.textContent = `Pause (animethemes saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed;
      fixed += r.fixed;
      deleted += r.deleted;
      unverifiable += r.unverifiable;
      unverifiables.push(...(r.unverifiableList || []));
      mismatches.push(...r.mismatches);
      status.innerHTML = `${total} animes vérifiés · ${mismatches.length} anomalie(s)` +
        `${fix ? ` · ${fixed} remplacée(s), ${deleted} supprimée(s)` : ''}` +
        `${unverifiable ? ` · ${unverifiable} invérifiable(s)` : ''}…${renderMismatches()}`;
      if (r.done || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    status.innerHTML = mismatches.length
      ? `${fix ? '✅ Réparé' : '⚠️ Vérification terminée'} : ${mismatches.length} anomalie(s) sur ${total} animes` +
        `${fix ? ` (${fixed} remplacées, ${deleted} supprimées)` : ' — clique « Réparer » pour appliquer'}` +
        `${unverifiable ? ` · ${unverifiable} invérifiable(s)` : ''}.${renderMismatches()}${renderUnverifiables()}`
      : `✅ Vérification terminée : ${total} animes, aucune anomalie${unverifiable ? ` (${unverifiable} invérifiables)` : ''}.${renderUnverifiables()}`;
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    checkBtn.disabled = false;
    fixBtn.disabled = false;
  }
}

// Recherche d'un anime mal rattaché (mauvais opening/ending) ou d'un surnom de
// franchise manquant sur certaines saisons (cherche aussi dans les synonymes,
// ex. « Tensura » présent sur une seule saison de Tensei Slime). Affiche
// chaque anilistId trouvé avec ses synonymes + un échantillon de musiques, et
// un bouton pour le réinitialiser.
async function runSongsSearch() {
  const input = document.getElementById('admin-songs-search');
  const box = document.getElementById('admin-songs-search-results');
  const q = input.value.trim();
  if (q.length < 2) { box.innerHTML = '<p class="hint">Tape au moins 2 caractères.</p>'; return; }
  box.innerHTML = '<p class="muted">Recherche…</p>';
  try {
    const r = await api(`/api/admin/songs-search?q=${encodeURIComponent(q)}`);
    if (!r.animes.length) { box.innerHTML = '<p class="muted">Aucun anime trouvé.</p>'; return; }
    box.innerHTML = r.animes.map((a) => `
      <div class="admin-anime-group">
        <div class="admin-anime-head">
          <b>${escapeHtml(a.animeTitle)}</b>
          <span class="hint">anilistId ${a.anilistId} · ${a.format || 'format inconnu'} · saison ${a.seasonNumber ?? '?'} · ${a.songs.length} musique(s)</span>
          <button type="button" class="btn-secondary admin-reset-anime-btn" data-anilist="${a.anilistId}">Réinitialiser</button>
        </div>
        <p class="hint admin-anime-alts">Synonymes : ${a.altTitles.length ? a.altTitles.map(escapeHtml).join(' · ') : '<i>aucun</i>'}</p>
        <ul class="admin-anime-songs">
          ${a.songs.map((s) => `<li>${escapeHtml(s.type)}${s.number} — ${escapeHtml(s.title)}${s.artist ? ' — ' + escapeHtml(s.artist) : ''}
            ${s.videoUrl ? `<a href="${escapeHtml(s.videoUrl)}" target="_blank" rel="noopener" class="btn-link">vidéo</a>` : ''}</li>`).join('')}
        </ul>
      </div>`).join('');
    box.querySelectorAll('.admin-reset-anime-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer toutes les musiques de cet anime (anilistId ' + btn.dataset.anilist + ') ? Il sera re-cherché depuis zéro au prochain import.')) return;
        btn.disabled = true;
        try {
          const res = await api('/api/admin/reset-anime', { method: 'POST', body: JSON.stringify({ anilistId: parseInt(btn.dataset.anilist) }) });
          btn.closest('.admin-anime-group').outerHTML = `<p class="hint">✅ ${res.deletedSongs} musique(s) supprimée(s) pour anilistId ${btn.dataset.anilist}.</p>`;
        } catch (e) {
          alert(e.message);
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    box.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`;
  }
}

async function runBackfillSeries() {
  const btn = document.getElementById('admin-backfill-btn');
  const status = document.getElementById('admin-backfill-status');
  btn.disabled = true;
  let total = 0, fails = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    while (true) {
      let r;
      try {
        r = await api('/api/admin/backfill-series', { method: 'POST', body: JSON.stringify({}) });
      } catch (e) {
        // Rate-limit / erreur réseau ponctuelle : on patiente et on réessaie
        if (++fails > 5) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/5`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      total += r.processed;
      status.textContent = `${total} traités · ${r.remaining} restants…`;
      if (r.remaining === 0 || r.processed === 0) break;
      await sleep(1500); // throttle pour rester sous la limite AniList
    }
    status.textContent = `Terminé ✅ (${total} personnages mis à jour)`;
    loadAdminChars(adminPage, adminSearch);
  } catch (e) {
    status.textContent = 'Erreur : ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Onglet Signalements : sons buggés (SongReport) + retours joueurs (Feedback) ──
let adminFeedbackStatus = '';

async function loadAdminReports() {
  loadAdminSongReports();
  loadAdminFeedback();
}

async function loadAdminSongReports() {
  const box = document.getElementById('admin-song-reports');
  try {
    const { reports } = await api('/api/admin/song-reports');
    box.innerHTML = reports.length ? reports.map((r) => `
      <div class="admin-report-row">
        <div class="admin-report-main">
          <b>${escapeHtml(r.song.animeTitle || '?')}</b>
          <small>${escapeHtml(r.song.title || '')}${r.song.artist ? ' — ' + escapeHtml(r.song.artist) : ''} · ${escapeHtml(r.song.type || '')}${r.song.number || ''}</small>
        </div>
        <div class="admin-report-meta">
          <span>${escapeHtml(r.user.displayName)} · ${escapeHtml(r.context)}</span>
          <span class="hint">${new Date(r.createdAt).toLocaleString()}</span>
        </div>
        ${r.note ? `<p class="hint">« ${escapeHtml(r.note)} »</p>` : ''}
      </div>`).join('') : '<p class="hint">Aucun signalement.</p>';
  } catch (e) {
    box.innerHTML = `<p class="hint">Erreur : ${escapeHtml(e.message)}</p>`;
  }
}

async function loadAdminFeedback() {
  const box = document.getElementById('admin-feedback-list');
  try {
    const qs = adminFeedbackStatus ? `?status=${adminFeedbackStatus}` : '';
    const { items } = await api('/api/admin/feedback' + qs);
    box.innerHTML = items.length ? items.map((f) => `
      <div class="admin-report-row" data-fid="${f.id}">
        <div class="admin-report-main">
          <b>${f.type === 'bug' ? '🐛 Bug' : '💡 Suggestion'}</b>
          <small>${escapeHtml(f.message)}</small>
        </div>
        <div class="admin-report-meta">
          <span>${escapeHtml(f.user.displayName)}${f.page ? ' · ' + escapeHtml(f.page) : ''}</span>
          <span class="hint">${new Date(f.createdAt).toLocaleString()}</span>
        </div>
        <button class="btn-secondary admin-feedback-resolve" data-fid="${f.id}" data-resolved="${f.status !== 'resolved'}">
          ${f.status === 'resolved' ? '<i class="fas fa-rotate-left"></i> Rouvrir' : '<i class="fas fa-check"></i> Résolu'}
        </button>
      </div>`).join('') : '<p class="hint">Aucun retour.</p>';
  } catch (e) {
    box.innerHTML = `<p class="hint">Erreur : ${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById('admin-panel-reports')?.addEventListener('click', async (e) => {
  const filterBtn = e.target.closest('.admin-feedback-filter');
  if (filterBtn) {
    document.querySelectorAll('.admin-feedback-filter').forEach((b) => b.classList.toggle('active', b === filterBtn));
    adminFeedbackStatus = filterBtn.dataset.status;
    loadAdminFeedback();
    return;
  }
  const resolveBtn = e.target.closest('.admin-feedback-resolve');
  if (resolveBtn) {
    resolveBtn.disabled = true;
    try {
      await api(`/api/admin/feedback/${resolveBtn.dataset.fid}/resolve`, {
        method: 'PATCH', body: JSON.stringify({ resolved: resolveBtn.dataset.resolved === 'true' }),
      });
      loadAdminFeedback();
    } catch { resolveBtn.disabled = false; }
  }
});

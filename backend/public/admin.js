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

async function loadAdminChars(page, search) {
  if (page < 1) return;
  adminSearch = search;
  const tbody = document.getElementById('admin-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Chargement…</td></tr>';
  try {
    const rq = adminRarity !== 'all' ? `&rarity=${adminRarity}` : '';
    const r = await api(`/api/admin/characters?page=${page}&search=${encodeURIComponent(search)}${rq}`);
    adminPage = r.page; adminPages = r.pages || 1;
    document.getElementById('admin-filters').innerHTML = (() => {
      const chips = [`<button class="coll-chip${adminRarity === 'all' ? ' active' : ''}" data-filter="all">Tous</button>`];
      RARITY_ORDER.forEach((rr) =>
        chips.push(`<button class="coll-chip r-${rr}${adminRarity === rr ? ' active' : ''}" data-filter="${rr}">${RARITY_LABELS[rr]}</button>`)
      );
      return chips.join('');
    })();
    if (r.missingSeries != null) {
      document.getElementById('admin-backfill-status').textContent =
        r.missingSeries ? `${r.missingSeries} séries manquantes` : 'Toutes les séries sont remplies ✅';
    }
    if (!r.characters.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">Aucun personnage.</td></tr>';
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
          </tr>`;
        })
        .join('');
    }
    document.getElementById('admin-pageinfo').textContent = `Page ${adminPage} / ${adminPages}`;
    document.getElementById('admin-prev').disabled = adminPage <= 1;
    document.getElementById('admin-next').disabled = adminPage >= adminPages;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(e.message)}</td></tr>`;
  }
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
// le plafond AniList de 5000 sur la recherche globale de personnages en
// parcourant les ANIMES populaires et leurs personnages principaux/secondaires
// (dédupliqués). Ici `page` avance sur les ANIMES, pas les personnages —
// beaucoup plus de doublons attendus au fil des clics (persos déjà connus via
// le premier import), donc plus lent à faire progresser le total.
async function runImportCharactersFromAnime() {
  const btn = document.getElementById('admin-import-anime-btn');
  const status = document.getElementById('admin-import-anime-status');
  btn.disabled = true;
  status.textContent = 'Import via les animes AniList…';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let totalAdded = 0, lastTotal = 0, fails = 0, nextPage = null;
  try {
    for (let i = 0; i < 16; i++) { // ~320 animes parcourus par clic
      let r;
      try {
        const body = nextPage == null ? {} : { page: nextPage };
        r = await api('/api/admin/import-characters-anime', { method: 'POST', body: JSON.stringify(body) });
      } catch (e) {
        if (++fails > 4) throw e;
        status.textContent = `Pause (AniList saturé)… réessai ${fails}/4`;
        await sleep(8000);
        continue;
      }
      fails = 0;
      totalAdded += r.added;
      lastTotal = r.total;
      nextPage = (r.page || 1) + 1;
      status.textContent = `+${totalAdded} ajoutés · ${r.total} au total (page anime ${r.page})…`;
      if (!r.hasMore) {
        status.textContent = r.capped
          ? `✅ Plafond AniList atteint (${r.total} personnages). Pense à « Recalculer les raretés ».`
          : `✅ Terminé : ${r.total} personnages. Pense à « Recalculer les raretés ».`;
        loadAdminChars(1, adminSearch);
        return;
      }
      await sleep(1100); // throttle AniList
    }
    status.textContent = `✅ +${totalAdded} personnages · ${lastTotal} au total. Reclique pour continuer, puis « Recalculer les raretés ».`;
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

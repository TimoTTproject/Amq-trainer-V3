// Dojo (idle/clicker) — extrait autonome (scope global partagé). Réservé aux
// admins en phase de test (nav caché + 403 serveur pour tout autre compte).
// Réutilise les globals de main.js (api, showView, currentUser, escapeHtml) et
// cardHTML() de gacha.js pour l'affichage des cartes assignées/sélectionnables.
let idleState = null; // dernier état reçu du serveur
let idleFetchedAt = 0; // Date.now() de ce dernier état (base du ticker en direct)
let idleTicker = null;
let idlePickerSlot = null; // emplacement en cours de sélection dans la modale

function idleFormatNumber(n) {
  n = Math.floor(n || 0);
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n < 1000) return sign + n;
  if (n < 1e6) return sign + (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return sign + (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return sign + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}

const IDLE_DECOR_ICONS = { wood: 'fa-tree', garden: 'fa-leaf', temple: 'fa-landmark', gold: 'fa-crown', celestial: 'fa-star' };

async function openIdle() {
  showView('idle');
  document.body.classList.add('idle-fullscreen'); // espace dédié : le chrome du site (header/nav) s'efface
  idleStopTicker();
  idleTicker = setInterval(idleTick, 400);
  await refreshIdleState();
}

function closeIdle() {
  idleStopTicker();
  document.body.classList.remove('idle-fullscreen');
  showView('play');
}

function idleStopTicker() {
  clearInterval(idleTicker);
  idleTicker = null;
}

function idleTick() {
  if (!idleState) return;
  const elapsed = (Date.now() - idleFetchedAt) / 1000;
  const display = idleState.essence + idleState.pendingEssence + elapsed * idleState.totalRate;
  const el = document.getElementById('idle-essence-val');
  if (el) el.textContent = idleFormatNumber(display);
}

async function refreshIdleState() {
  let state;
  try {
    state = await api('/api/idle/state');
  } catch (e) {
    document.getElementById('idle-slots').innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
    document.getElementById('idle-upgrades').innerHTML = '';
    return;
  }
  renderIdleState(state);
}

function renderIdleState(state) {
  idleState = state;
  idleFetchedAt = Date.now();
  document.getElementById('idle-essence-val').textContent = idleFormatNumber(state.essence + state.pendingEssence);
  document.getElementById('idle-rate-val').textContent = idleFormatNumber(state.totalRate);
  document.getElementById('idle-pending-val').textContent = state.pendingEssence > 0 ? `(+${idleFormatNumber(state.pendingEssence)})` : '';
  document.getElementById('idle-click-yield').textContent = `+${state.click.yield}`;
  document.getElementById('idle-slots').innerHTML = state.slots.map(idleSlotHTML).join('');
  document.getElementById('idle-upgrades').innerHTML = renderIdleUpgrades(state);
  renderIdleDecor(state.dojo);
}

function renderIdleDecor(dojo) {
  const view = document.getElementById('view-idle');
  if (view) view.dataset.decor = dojo.decor.theme;
  const ico = document.getElementById('idle-decor-ico');
  if (ico) ico.innerHTML = `<i class="fas ${IDLE_DECOR_ICONS[dojo.decor.theme] || 'fa-fire'}"></i>`;
  document.getElementById('idle-decor-name').textContent = dojo.decor.name;
  document.getElementById('idle-dojo-level').textContent = `Niveau ${idleFormatNumber(dojo.level)} · ×${dojo.multiplier.toFixed(2)}`;
  const pct = Math.round((dojo.progress || 0) * 100);
  const fill = document.getElementById('idle-xp-fill');
  if (fill) fill.style.width = `${pct}%`;
  const next = document.getElementById('idle-decor-next');
  if (next) {
    next.textContent = dojo.nextDecor
      ? `${idleFormatNumber(dojo.xpIntoLevel)}/${idleFormatNumber(dojo.xpForNextLevel)} XP · ${dojo.nextDecor.name} dans ${dojo.nextDecor.levelsRemaining} niveau(x)`
      : `${idleFormatNumber(dojo.xpIntoLevel)}/${idleFormatNumber(dojo.xpForNextLevel)} XP`;
  }
}

function idleSlotHTML(slot) {
  if (slot.locked) {
    return `<div class="idle-slot idle-slot-locked">
      <i class="fas fa-lock"></i>
      <button class="btn-secondary idle-unlock-btn" data-slot="${slot.index}">${idleFormatNumber(slot.unlockCost)} <i class="fas fa-mortar-pestle"></i></button>
    </div>`;
  }
  if (!slot.character) {
    return `<button class="idle-slot idle-slot-empty" data-slot="${slot.index}" data-action="pick">
      <i class="fas fa-plus"></i><span>Assigner</span>
    </button>`;
  }
  const c = slot.character;
  return `<div class="idle-slot idle-slot-filled">
    ${cardHTML(c, { noBorder: false })}
    <span class="idle-slot-lvl">Nv. ${idleFormatNumber(c.level)}</span>
    <div class="idle-slot-rate">+${idleFormatNumber(c.rate)}/s</div>
    <button class="idle-slot-remove" data-slot="${slot.index}" data-action="unassign" title="Retirer"><i class="fas fa-xmark"></i></button>
    <button class="idle-slot-levelup" data-slot="${slot.index}" data-action="levelup"${idleState && idleState.essence < c.levelUpCost ? ' disabled' : ''}>
      <i class="fas fa-arrow-up"></i> ${idleFormatNumber(c.levelUpCost)}
    </button>
  </div>`;
}

function renderIdleUpgrades(state) {
  const nextSlotCost = state.slots.find((s) => s.locked)?.unlockCost ?? null;
  const items = [
    {
      type: 'prod', icon: 'fa-brain', title: 'Discipline', level: state.prod.level, maxed: state.prod.maxed, cost: state.prod.nextCost,
      desc: `Production totale ×${state.prod.multiplier.toFixed(2)}`,
    },
    {
      type: 'click', icon: 'fa-hand-fist', title: 'Concentration', level: state.click.level, maxed: state.click.maxed, cost: state.click.nextCost,
      desc: `Clic manuel : +${state.click.yield} essence`,
    },
    {
      type: 'slot', icon: 'fa-square-plus', title: 'Nouvel emplacement', level: state.slotsUnlocked, maxed: state.slotsUnlocked >= state.maxSlots, cost: nextSlotCost,
      desc: `${state.slotsUnlocked}/${state.maxSlots} emplacements débloqués`,
    },
  ];
  return items.map((it) => `
    <div class="idle-upgrade-card">
      <div class="idle-upgrade-ico"><i class="fas ${it.icon}"></i></div>
      <div class="idle-upgrade-info">
        <h4>${it.title} <span class="idle-upgrade-lvl">Nv. ${it.level}</span></h4>
        <p>${it.desc}</p>
      </div>
      ${it.maxed
        ? '<span class="idle-upgrade-maxed">MAX</span>'
        : `<button class="btn-secondary idle-upgrade-btn" data-upgrade="${it.type}"${state.essence < it.cost ? ' disabled' : ''}>${idleFormatNumber(it.cost)} <i class="fas fa-mortar-pestle"></i></button>`}
    </div>`).join('');
}

async function collectIdle() {
  try {
    await api('/api/idle/collect', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    alert(e.message);
    return;
  }
  refreshIdleState();
}

async function clickIdle() {
  let r;
  try {
    r = await api('/api/idle/click', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    return; // 429 (anti-spam) ou réseau : on ignore silencieusement, pas de quoi bloquer le joueur
  }
  if (idleState) idleState.essence = r.essence;
  idleClickFeedback(r.gained);
}

function idleClickFeedback(gained) {
  const btn = document.getElementById('idle-click-btn');
  if (!btn) return;
  const fx = document.createElement('span');
  fx.className = 'idle-click-fx';
  fx.textContent = `+${gained}`;
  btn.appendChild(fx);
  setTimeout(() => fx.remove(), 700);
}

async function levelUpIdleSlot(slotIndex) {
  try {
    await api('/api/idle/slot-level', { method: 'POST', body: JSON.stringify({ slotIndex }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  refreshIdleState();
}

async function buyIdleUpgrade(type) {
  try {
    await api('/api/idle/upgrade', { method: 'POST', body: JSON.stringify({ type }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  refreshIdleState();
}

async function unassignIdleSlot(slotIndex) {
  try {
    await api('/api/idle/unassign', { method: 'POST', body: JSON.stringify({ slotIndex }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  refreshIdleState();
}

async function openIdlePicker(slotIndex) {
  idlePickerSlot = slotIndex;
  document.getElementById('idle-picker-hint').textContent = 'Chargement…';
  document.getElementById('idle-picker-list').innerHTML = '';
  document.getElementById('idle-picker').classList.remove('hidden');
  let data;
  try {
    data = await api('/api/gacha/collection');
  } catch (e) {
    document.getElementById('idle-picker-hint').textContent = e.message;
    return;
  }
  const assignedIds = new Set((idleState?.slots || []).filter((s) => s.character && s.index !== slotIndex).map((s) => s.character.id));
  const available = (data.cards || []).filter((c) => !assignedIds.has(c.id));
  document.getElementById('idle-picker-hint').textContent = available.length
    ? `${available.length} personnage(s) disponible(s)`
    : 'Aucun personnage disponible (déjà tous assignés, ou aucune carte possédée).';
  document.getElementById('idle-picker-list').innerHTML = available.map((c, i) => cardHTML(c, { index: i })).join('');
}

function closeIdlePicker() {
  document.getElementById('idle-picker').classList.add('hidden');
  idlePickerSlot = null;
}

async function pickIdleCharacter(characterId) {
  if (idlePickerSlot == null) return;
  const slotIndex = idlePickerSlot;
  try {
    await api('/api/idle/assign', { method: 'POST', body: JSON.stringify({ slotIndex, characterId }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  closeIdlePicker();
  refreshIdleState();
}

function initIdleUI() {
  document.getElementById('idle-collect-btn')?.addEventListener('click', collectIdle);
  document.getElementById('idle-click-btn')?.addEventListener('click', clickIdle);
  document.getElementById('idle-picker-close')?.addEventListener('click', closeIdlePicker);
  document.getElementById('idle-picker')?.addEventListener('click', (e) => { if (e.target.id === 'idle-picker') closeIdlePicker(); });
  document.getElementById('idle-slots')?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-action="unassign"]');
    if (removeBtn) return unassignIdleSlot(Number(removeBtn.dataset.slot));
    const levelBtn = e.target.closest('[data-action="levelup"]');
    if (levelBtn) return levelUpIdleSlot(Number(levelBtn.dataset.slot));
    const unlockBtn = e.target.closest('.idle-unlock-btn');
    if (unlockBtn) return buyIdleUpgrade('slot');
    const pickBtn = e.target.closest('[data-action="pick"]');
    if (pickBtn) return openIdlePicker(Number(pickBtn.dataset.slot));
  });
  document.getElementById('idle-upgrades')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.idle-upgrade-btn');
    if (btn) buyIdleUpgrade(btn.dataset.upgrade);
  });
  document.getElementById('idle-picker-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-cid]');
    if (card) pickIdleCharacter(Number(card.dataset.cid));
  });
}

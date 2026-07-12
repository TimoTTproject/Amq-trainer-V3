// Dojo (idle/clicker) — extrait autonome (scope global partagé). Réservé aux
// admins en phase de test (nav caché + 403 serveur pour tout autre compte).
// Réutilise les globals de main.js (api, showView, currentUser, escapeHtml) et
// cardHTML() de gacha.js pour le sélecteur de personnage (modale) — le roster
// assigné a sa propre ligne de héros compacte, voir idleSlotHTML.
let idleState = null; // dernier état reçu du serveur
let idleFetchedAt = 0; // Date.now() de ce dernier état (base du ticker en direct)
let idleTicker = null;
let idleSyncTicker = null; // resynchronisation périodique légère (cf. openIdle) — sans ça, un joueur qui ne clique jamais ne verrait aucun kill se produire réellement côté serveur
let idlePickerSlot = null; // emplacement en cours de sélection dans la modale
let idleParticleTheme = null; // dernier thème pour lequel les particules ambiantes ont été générées
let idleWelcomeChecked = false; // l'écran « pendant ton absence » ne se déclenche qu'une fois par ouverture
let idleActivePanel = 'home'; // onglet courant de la barre du bas (home | team | upgrades)
let idleTickCount = 0; // compteur du ticker — cadence les gains flottants passifs de la scène
let idleLastRecruit = null; // personnage affiché dans la révélation de recrutement
let idleBurstReadyAt = 0;
let idleTeamSkillReadyAt = 0;

function idleFormatNumber(n) {
  n = Math.floor(n || 0);
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n < 1000) return sign + n;
  if (n < 1e6) return sign + (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return sign + (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  return sign + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
}

// Temps restant avant le prochain niveau de Dojo, lisible (« 1m 30s », « 2h 5m »).
// null si le taux de production est nul (rien à estimer, plutôt que « ∞ »).
function idleFormatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const totalMin = Math.floor(seconds / 60);
  if (totalMin < 60) {
    const s = Math.ceil(seconds - totalMin * 60);
    return s > 0 && totalMin < 10 ? `${totalMin}m ${s}s` : `${totalMin}m`;
  }
  const totalH = Math.floor(totalMin / 60);
  const m = totalMin - totalH * 60;
  if (totalH < 24) return `${totalH}h ${m}m`;
  return `${Math.floor(totalH / 24)}j+`;
}

async function openIdle() {
  showView('idle');
  document.body.classList.add('idle-fullscreen'); // espace dédié : le chrome du site (header/nav) s'efface
  idleShowPanel('home');
  idleStopTicker();
  idleWelcomeChecked = false;
  idleTicker = setInterval(idleTick, 400);
  // Sync serveur périodique (6 s) : GET /state ne fait que LIRE l'état (il ne
  // solde jamais la production en attente en base) — sans ce collecte
  // périodique, essenceEarnedTotal ne bougerait jamais entre deux clics et le
  // stage resterait figé indéfiniment, même avec la barre qui semble baisser
  // (illusion purement visuelle côté client, cf. idleTickInterpolateBattle).
  idleSyncTicker = setInterval(() => {
    if (idleActivePanel === 'home' && !document.hidden) idleBackgroundSync();
  }, 6000);
  await refreshIdleState();
  maybeShowIdleWelcome();
}

// Collecte silencieuse (pas de son/animation, contrairement à collectIdle) :
// crédite la production en attente en base à intervalle régulier pour que le
// combat progresse réellement même quand le joueur ne clique sur rien.
async function idleBackgroundSync() {
  try {
    await api('/api/idle/collect', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    return; // pas grave : la prochaine synchro (6 s plus tard) rattrapera
  }
  refreshIdleState();
}

// Onglets de la barre du bas (façon appli mobile) : home = scène, team =
// emplacements, upgrades = améliorations + prestige.
function idleShowPanel(name) {
  idleActivePanel = name;
  for (const p of ['home', 'team', 'upgrades']) {
    document.getElementById('idle-panel-' + p)?.classList.toggle('hidden', p !== name);
  }
  document.querySelectorAll('#idle-tabs .idle-tab').forEach((t) => t.classList.toggle('active', t.dataset.idleTab === name));
}

// Nombre flottant dans la scène (+essence, façon dégâts/gains d'un jeu mobile).
function idleSpawnFloat(text, cls) {
  const box = document.getElementById('idle-floats');
  if (!box) return;
  const f = document.createElement('span');
  f.className = 'idle-float' + (cls ? ' ' + cls : '');
  f.textContent = text;
  f.style.left = `${Math.round(12 + Math.random() * 60)}%`;
  f.style.top = `${Math.round(35 + Math.random() * 30)}%`;
  box.appendChild(f);
  setTimeout(() => f.remove(), 1400);
}

// Palier de taille/couleur d'un gain flottant, RELATIF à la production
// actuelle (pas de seuil absolu — un gain de 50 est énorme en tout début de
// partie, dérisoire bien plus tard). Vide = taille normale.
function idleFloatTier(amount) {
  const rate = idleState?.totalRate || 0;
  if (rate <= 0) return '';
  if (amount > rate * 30) return 'huge';
  if (amount > rate * 5) return 'big';
  return '';
}

// « Pendant ton absence » : ne s'affiche qu'à l'ouverture (pas à chaque
// rafraîchissement suivant un clic/achat) et seulement si ça vaut le coup —
// on n'embête pas le joueur pour 3 essence après 10 secondes d'absence.
const IDLE_WELCOME_MIN_AWAY_MS = 3 * 60 * 1000;
function maybeShowIdleWelcome() {
  if (idleWelcomeChecked || !idleState) return;
  idleWelcomeChecked = true;
  const awayMs = Date.now() - new Date(idleState.lastCollectAt).getTime();
  if (idleState.pendingEssence <= 0 || awayMs < IDLE_WELCOME_MIN_AWAY_MS) return;
  const mins = Math.round(awayMs / 60000);
  const away = mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} h`;
  document.getElementById('idle-welcome-msg').textContent =
    `Tes personnages ont continué à s'entraîner sans toi pendant ${away} : ${idleFormatNumber(idleState.pendingEssence)} essence t'attendent.`;
  document.getElementById('idle-welcome').classList.remove('hidden');
}

function closeIdle() {
  idleStopTicker();
  document.body.classList.remove('idle-fullscreen');
  showView('play');
}

function idleStopTicker() {
  clearInterval(idleTicker);
  idleTicker = null;
  clearInterval(idleSyncTicker);
  idleSyncTicker = null;
}

function idleTick() {
  if (!idleState) return;
  const elapsed = (Date.now() - idleFetchedAt) / 1000;
  const display = idleState.essence + idleState.pendingEssence + elapsed * idleState.totalRate;
  const el = document.getElementById('idle-essence-val');
  if (el) el.textContent = idleFormatNumber(display);
  idleTickInterpolateBattle(elapsed);
  idleRenderSkillCooldown();
  // Gain flottant passif dans la scène toutes les ~3,2 s (8 ticks de 400 ms) —
  // purement cosmétique, ça montre la production "vivre" comme dans un vrai
  // idle game. Seulement si la scène est visible et produit au moins 1.
  idleTickCount++;
  const passiveGain = idleState.totalRate * 3.2;
  if (idleTickCount % 8 === 0 && passiveGain >= 1 && idleActivePanel === 'home') {
    idleSpawnFloat(`+${idleFormatNumber(passiveGain)}`, 'xp');
    idleCombatMotion('team');
  }
}

// Fait baisser la barre de PV du gardien en continu entre deux synchros
// serveur (~6 s, cf. openIdle), exactement comme l'essence affichée
// ci-dessus : même taux (essenceEarnedTotal progresse au même rythme que
// l'essence), simple extrapolation visuelle. Le vrai kill (nouveau stage,
// nouvelle vague) n'arrive qu'à la prochaine synchro — la barre se contente
// de tendre vers 0 en l'attendant, jamais de fausse transition côté client.
function idleTickInterpolateBattle(elapsed) {
  if (!idleState?.battle || idleActivePanel !== 'home') return;
  const gained = elapsed * (idleState.totalRate || 0);
  const total = Math.max(1, idleState.battle.xpForNextStage || 1);
  const xpIntoStage = Math.min(total, (idleState.battle.xpIntoStage || 0) + gained);
  const remaining = Math.max(0, total - xpIntoStage);
  const hpPct = Math.max(0, Math.min(100, (remaining / total) * 100));
  const hpEl = document.getElementById('idle-enemy-hp-text');
  const fill = document.getElementById('idle-xp-fill');
  if (hpEl) hpEl.textContent = `${idleFormatNumber(remaining)} / ${idleFormatNumber(total)} PV${idleEtaSuffix(remaining)}`;
  if (fill) fill.style.width = `${hpPct}%`;
}

async function refreshIdleState() {
  let state;
  try {
    state = await api('/api/idle/state');
  } catch (e) {
    document.getElementById('idle-slots').innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`;
    document.getElementById('idle-upgrades').innerHTML = '';
    const ancientsBox = document.getElementById('idle-ancients');
    if (ancientsBox) ancientsBox.innerHTML = '';
    return;
  }
  renderIdleState(state);
}

function renderIdleState(state) {
  const prev = idleState;
  idleState = state;
  idleFetchedAt = Date.now();
  const essenceEl = document.getElementById('idle-essence-val');
  essenceEl.textContent = idleFormatNumber(state.essence + state.pendingEssence);
  if (prev && state.essence > prev.essence) idleBump(essenceEl);
  document.getElementById('idle-rate-val').textContent = idleFormatNumber(state.totalRate);
  document.getElementById('idle-pending-val').textContent = state.pendingEssence > 0 ? `+${idleFormatNumber(state.pendingEssence)}` : '0';
  const collectHelp = document.getElementById('idle-collect-help');
  if (collectHelp) collectHelp.innerHTML = state.pendingEssence > 0 ? `<i class="fas fa-coins"></i> <b>${idleFormatNumber(state.pendingEssence)} Essence en attente.</b> Encaisse-la maintenant dans ton solde.` : '<i class="fas fa-check"></i> Tous les gains automatiques sont encaissés. Ton équipe continue à produire.';
  document.getElementById('idle-click-yield').textContent = `+${state.click.yield}`;
  document.getElementById('idle-slots').innerHTML = state.slots.map(idleSlotHTML).join('');
  document.getElementById('idle-upgrades').innerHTML = renderIdleUpgrades(state);
  renderIdleMissions(state.missions || []);
  const hudLevel = document.getElementById('idle-hud-level');
  if (hudLevel) hudLevel.textContent = `Nv. ${idleFormatNumber(state.dojo.level)}`;
  const xpTotal = document.getElementById('idle-xptotal-val');
  if (xpTotal) xpTotal.textContent = idleFormatNumber(state.dojo.xpTotal);
  const wisdomVal = document.getElementById('idle-wisdom-val');
  if (wisdomVal) wisdomVal.textContent = idleFormatNumber(state.ancients.points);
  // Multiplicateur TOTAL affiché sur la scène : Discipline (Ancients inclus) × niveau du Dojo.
  const mult = document.getElementById('idle-mult-val');
  if (mult) mult.textContent = `×${(state.prod.multiplier * state.dojo.multiplier).toFixed(2)}`;
  // Ligne de stats de combat façon PokéClicker — aucune nouvelle donnée,
  // juste rendues visibles en permanence (auparavant seulement dans la
  // rangée d'actions/le bouton de clic).
  const killsEl = document.getElementById('idle-kills-val');
  if (killsEl) killsEl.textContent = idleFormatNumber(state.battle.kills);
  const combatClick = document.getElementById('idle-combat-click');
  if (combatClick) combatClick.textContent = `+${idleFormatNumber(state.click.yield)}`;
  const combatTeam = document.getElementById('idle-combat-team');
  if (combatTeam) combatTeam.textContent = `${idleFormatNumber(state.totalRate)}/s`;
  renderIdleDecor(state.dojo, prev?.dojo);
  renderIdleBattle(state.battle, state.dojo, prev?.battle);
  renderIdleRoadmap(state.dojo);
  renderIdleMainHero(state);
  renderIdleTeamStrategy(state);
  renderIdleMilestone(state.dojo);
  renderIdlePrestige(state.dojo);
  renderIdleAncients(state.ancients);
  renderIdleRecruit(state.recruit, state.essence);
}

const IDLE_ROLES = [
  { name: 'Attaquant', icon: 'fa-burst', color: '#ff704d' },
  { name: 'Support', icon: 'fa-wand-magic-sparkles', color: '#b06cff' },
  { name: 'Tank', icon: 'fa-shield-halved', color: '#4db8ff' },
  { name: 'Assassin', icon: 'fa-bolt', color: '#ffd54a' },
  { name: 'Producteur', icon: 'fa-gears', color: '#3ec98a' },
];
function idleRoleFor(character) { return IDLE_ROLES[Math.abs(Number(character?.id) || 0) % IDLE_ROLES.length]; }
function renderIdleTeamStrategy(state) {
  const active = (state.slots || []).filter((s) => s.character).map((s) => s.character);
  const stage = document.getElementById('idle-stage-team');
  if (stage) stage.innerHTML = active.slice(0, 4).map((c) => {
    const role = idleRoleFor(c); const img = c.imageUrl ? `style="background-image:url('${escapeHtml(c.imageUrl)}')"` : '';
    return `<span class="idle-stage-ally" ${img} title="${escapeHtml(c.name)} · ${role.name}"><i class="fas ${role.icon}" style="--role:${role.color}"></i><b>${escapeHtml(c.name.split(' ')[0])}</b></span>`;
  }).join('');
  const counts = new Map(); active.forEach((c) => { const key=c.series||'Crossover'; counts.set(key,(counts.get(key)||0)+1); });
  const best = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0];
  const bonus = best?.[1] >= 3 ? 25 : best?.[1] >= 2 ? 10 : active.length >= 3 ? 5 : 0;
  const bar = document.getElementById('idle-synergy-bar');
  if (bar) bar.innerHTML = bonus ? `<i class="fas fa-link"></i><div><b>${best[1]>=2?escapeHtml(best[0]):'Crossover'} · Synergie +${bonus}%</b><span>${best[1]>=2?`${best[1]} combattants de la même licence`:'Trois univers différents réunis'}</span></div>` : '<i class="fas fa-link"></i><div><b>Aucune synergie active</b><span>Aligne 2 héros d’une même licence ou 3 univers différents.</span></div>';
}

// Frise des paliers de décor (Progression) — équivalent simplifié d'une
// carte du monde : notre progression est une séquence linéaire de paliers
// (dojo.tiers, liste statique envoyée par le serveur), pas un graphe de
// zones à embranchements.
function renderIdleRoadmap(dojo) {
  const box = document.getElementById('idle-roadmap');
  if (!box || !Array.isArray(dojo.tiers)) return;
  const currentIndex = dojo.tiers.findIndex((t) => t.theme === dojo.decor.theme);
  box.innerHTML = dojo.tiers.map((tier, i) => {
    const isCurrent = i === currentIndex;
    const isDone = currentIndex >= 0 && i < currentIndex;
    const cls = isCurrent ? 'current' : (isDone ? 'done' : '');
    const dotContent = isCurrent ? '<i class="fas fa-fire"></i>' : (isDone ? '<i class="fas fa-check"></i>' : idleFormatNumber(tier.level));
    return `<div class="idle-roadmap-step ${cls}">
      <span class="idle-roadmap-dot">${dotContent}</span>
      <span class="idle-roadmap-name">${escapeHtml(tier.name.split(' · ')[0])}</span>
      <span class="idle-roadmap-level">Nv. ${idleFormatNumber(tier.level)}</span>
    </div>`;
  }).join('');
  // Centre la frise sur le palier courant plutôt que de la laisser au début.
  const current = box.querySelector('.idle-roadmap-step.current');
  if (current) current.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Le joueur est le héros actif : son apparence vient du profil (avatar + cadre),
// sa puissance vient de Concentration. Les recrues restent une équipe passive.
function renderIdleMainHero(state) {
  const avatar = document.getElementById('idle-main-hero-avatar');
  if (avatar && currentUser) renderAvatar(avatar, currentUser);
  const name = document.getElementById('idle-main-hero-name');
  if (name) name.textContent = currentUser?.displayName || 'Héros AMQ';
  const power = document.getElementById('idle-main-hero-power');
  if (power) power.textContent = `${idleFormatNumber(state.click.yield)} puissance active`;
}

// Temps restant avant le prochain niveau de Dojo, formaté (« · 1m 30s ») ou
// chaîne vide si rien ne produit (aucun coéquipier assigné) — pas de fausse
// promesse d'un niveau qui n'arrivera jamais.
function idleEtaSuffix(remainingXp) {
  const rate = idleState?.totalRate || 0;
  const label = rate > 0 ? idleFormatDuration(remainingXp / rate) : null;
  return label ? ` · ${label}` : '';
}

// La boucle de combat utilise le STAGE (cf. src/idle/idle.js), volontairement
// découplé du niveau du Dojo : le Dojo reste lent (décor/paliers), le stage
// s'incrémente en quelques secondes pour que le combat se sente vivant en
// continu, façon Clicker Heroes. Chaque stage est un ennemi, chaque dixième
// un boss, et les « PV » sont l'XP de stage restant avant le suivant. Le
// gardien affiché (portrait) reste lui lié au DÉCOR (dojo), cohérent : le
// visuel change par grand palier, le rythme de combat lui est indépendant.
function renderIdleBattle(battle, dojo, prevBattle) {
  const stage = Math.max(1, battle?.stage || 1);
  const wave = ((stage - 1) % 10) + 1;
  const zone = Math.floor((stage - 1) / 10) + 1;
  const boss = wave === 10;
  const mechanics = [['Bouclier','résiste aux dégâts passifs'],['Rage','se renforce sous 30% PV'],['Régénération','récupère entre les assauts'],['Contre','résiste aux clics ordinaires']];
  const mechanic = mechanics[(zone - 1) % mechanics.length];
  const mechanicEl = document.getElementById('idle-boss-mechanic');
  if (mechanicEl) { mechanicEl.classList.toggle('hidden', !boss); mechanicEl.innerHTML = boss ? `<i class="fas fa-shield-halved"></i> <b>${mechanic[0]}</b> · ${mechanic[1]}` : ''; }
  const remaining = Math.max(0, (battle?.xpForNextStage || 0) - (battle?.xpIntoStage || 0));
  const total = Math.max(1, battle?.xpForNextStage || 1);
  const hpPct = Math.max(0, Math.min(100, remaining / total * 100));
  const guardianName = dojo?.decor?.boss?.name || (boss ? 'Maître du palier' : "Disciple de l'Idle");
  const zoneEl = document.getElementById('idle-battle-zone');
  const tagEl = document.getElementById('idle-battle-tag');
  const titleEl = document.getElementById('idle-enemy-title');
  const hpEl = document.getElementById('idle-enemy-hp-text');
  const fill = document.getElementById('idle-xp-fill');
  if (zoneEl) zoneEl.textContent = `ZONE ${zone} · ${boss ? 'BOSS' : `VAGUE ${wave}/10`}`;
  if (tagEl) { tagEl.textContent = boss ? 'BOSS' : 'GARDIEN'; tagEl.classList.toggle('boss', boss); }
  if (titleEl) titleEl.textContent = guardianName;
  if (hpEl) hpEl.textContent = `${idleFormatNumber(remaining)} / ${idleFormatNumber(total)} PV${idleEtaSuffix(remaining)}`;
  if (fill) fill.style.width = `${hpPct}%`;
  // Le stage a avancé depuis le dernier rendu (au moins un kill) : retour
  // léger et fréquent, distinct de la célébration (confettis) réservée aux
  // vrais niveaux de Dojo.
  if (prevBattle && stage > Math.max(1, prevBattle.stage || 1)) {
    idleKillBurst(stage - Math.max(1, prevBattle.stage || 1));
  }
}

function idleRenderSkillCooldown() {
  const btn = document.getElementById('idle-skill-burst');
  const label = document.getElementById('idle-skill-status');
  if (!btn || !label) return;
  const left = Math.max(0, idleBurstReadyAt - Date.now());
  btn.disabled = left > 0;
  const teamBtn = document.getElementById('idle-skill-team'); const teamLabel = document.getElementById('idle-team-skill-status');
  if (teamBtn && teamLabel) { const teamLeft = Math.max(0, idleTeamSkillReadyAt - Date.now()); const count = idleState?.slots?.filter((s) => s.character).length || 0; teamBtn.disabled = teamLeft > 0 || count < 2; teamLabel.textContent = count < 2 ? '2 héros requis' : (teamLeft > 0 ? `Recharge · ${Math.ceil(teamLeft / 1000)}s` : 'Prêt · rôles variés = bonus'); }
  label.textContent = left > 0 ? `Recharge · ${Math.ceil(left / 1000)}s` : 'Prêt · ×25';
}

async function idleUseBurst(event) {
  event?.stopPropagation();
  if (Date.now() < idleBurstReadyAt) return;
  try {
    const result = await api('/api/idle/skill/burst', { method: 'POST', body: JSON.stringify({}) });
    idleBurstReadyAt = Date.now() + result.cooldownMs;
    const scene = document.getElementById('idle-scene');
    scene?.classList.add('skill-burst'); setTimeout(() => scene?.classList.remove('skill-burst'), 600);
    idleSpawnFloat(`ULTIME +${idleFormatNumber(result.gained)}`, 'crit');
    idleCombatMotion('hero');
    await refreshIdleState();
  } catch (e) { if (!String(e.message).includes('Trop')) alert(e.message); }
  idleRenderSkillCooldown();
}

async function idleUseTeamSkill(event) {
  event?.stopPropagation(); if (Date.now() < idleTeamSkillReadyAt) return;
  try { const r = await api('/api/idle/skill/team', { method: 'POST', body: JSON.stringify({}) }); idleTeamSkillReadyAt = Date.now() + r.cooldownMs; idleSpawnFloat(`COMBO ${r.uniqueRoles} RÔLES +${idleFormatNumber(r.gained)}`, 'crit'); idleCombatMotion('team'); await refreshIdleState(); }
  catch (e) { if (!String(e.message).includes('Trop')) alert(e.message); }
  idleRenderSkillCooldown();
}

function renderIdleRecruit(recruit, essence) {
  const costLabel = `(${idleFormatNumber(recruit.nextCost)})`;
  const affordable = essence >= recruit.nextCost;
  for (const id of ['idle-top-recruit-cost', 'idle-recruit-cost']) {
    const el = document.getElementById(id);
    if (el) el.textContent = costLabel;
  }
  for (const id of ['idle-top-recruit-btn', 'idle-recruit-btn']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !affordable;
  }
}

function renderIdleMissions(missions) {
  const box = document.getElementById('idle-missions'); if (!box) return;
  box.innerHTML = missions.map((m) => `<div class="idle-mission ${m.completed ? 'done' : ''}"><span class="idle-mission-icon"><i class="fas ${m.cadence === 'Quotidienne' ? 'fa-sun' : 'fa-calendar-week'}"></i></span><div><small>${m.cadence}</small><b>${escapeHtml(m.title)}</b><span>${idleFormatNumber(m.progress)} / ${idleFormatNumber(m.target)}</span><em style="--progress:${Math.min(100, m.progress / m.target * 100)}%"></em></div><button class="btn-secondary" data-idle-mission="${m.key}" ${!m.completed || m.claimed ? 'disabled' : ''}>${m.claimed ? 'Réclamée' : `+${idleFormatNumber(m.reward)}`}</button></div>`).join('');
}

async function claimIdleMission(key) {
  try { const r = await api('/api/idle/mission/claim', { method: 'POST', body: JSON.stringify({ key }) }); idleSpawnFloat(`MISSION +${idleFormatNumber(r.reward)}`, 'xp'); await refreshIdleState(); }
  catch (e) { alert(e.message); }
}

function idleBump(el) {
  el.classList.remove('token-bump');
  void el.offsetWidth;
  el.classList.add('token-bump');
}

// Variante douce de idleBump pour les CARTES (emplacement, amélioration) :
// token-bump grossit de 25%, pensé pour un petit chiffre — sur une carte
// entière bordée dans une grille, ce zoom débordait sur ses voisines. Un
// simple halo + très léger scale suffit à confirmer l'achat sans ce défaut.
function idleCardBump(el) {
  if (!el) return;
  el.classList.remove('idle-card-pulse');
  void el.offsetWidth;
  el.classList.add('idle-card-pulse');
}

function renderIdleDecor(dojo, prevDojo) {
  const view = document.getElementById('view-idle');
  if (view) view.dataset.decor = dojo.decor.theme; // pilote le thème CSS, sans condition (idempotent)
  // idleParticleTheme (pas l'attribut DOM, déjà présent par défaut dans le HTML
  // statique pour "wood") sert de source de vérité pour savoir si les effets
  // ambiants de CE thème ont déjà été générés une fois.
  if (idleParticleTheme !== dojo.decor.theme) {
    idleSpawnParticles(dojo.decor.theme);
    idleSetScenery(dojo.decor.theme);
  }
  document.getElementById('idle-decor-name').textContent = dojo.decor.name;
  document.getElementById('idle-dojo-level').textContent = `Niveau ${idleFormatNumber(dojo.level)}`;
  document.getElementById('idle-decor-flavor').textContent = dojo.decor.flavor || '';
  idleRenderBackdrop(dojo.decor.backgroundUrl);
  idleRenderBoss(dojo.decor.boss, dojo.decor.theme);
  // La barre #idle-xp-fill est la barre de PV du combat (cf. renderIdleBattle,
  // pilotée par le stage) — ici on ne fait QUE le texte de progression du Dojo.
  const next = document.getElementById('idle-decor-next');
  if (next) {
    const remaining = Math.max(0, (dojo.xpForNextLevel || 0) - (dojo.xpIntoLevel || 0));
    const base = `Idle ${idleFormatNumber(dojo.xpIntoLevel)}/${idleFormatNumber(dojo.xpForNextLevel)} XP${idleEtaSuffix(remaining)}`;
    const text = dojo.nextDecor
      ? `${base} · ${dojo.nextDecor.name} dans ${dojo.nextDecor.levelsRemaining} niveau(x)`
      : base;
    // Icône dédiée : la barre de PV juste au-dessus est le combat (stage),
    // cette ligne est une mesure différente (niveau de Dojo/décor) — sans ce
    // repère visuel les deux se lisaient comme une seule et même barre.
    next.innerHTML = `<i class="fas fa-torii-gate idle-decor-next-ico"></i>${escapeHtml(text)}`;
  }
  // Le niveau du Dojo a grimpé depuis le dernier rendu : petite célébration
  // (pas au tout premier rendu de la session, sinon ça se déclenche à chaque ouverture).
  if (prevDojo && dojo.level > prevDojo.level) idleCelebrate();
}

function idleCelebrate() {
  if (typeof burstConfetti === 'function') burstConfetti(36);
  if (typeof sfx !== 'undefined' && sfx.levelup) sfx.levelup();
}

// Impact de kill (stage franchi) : flash + micro-secousse sur la scène, plus
// léger que idleCelebrate (confettis) — les kills sont désormais fréquents
// (cf. renderIdleBattle), une célébration à chaque fois serait fatigante.
// `count` = nombre de stages franchis d'un coup (rattrapage après une pause
// ou grosse récolte) : un seul impact, pas une rafale qui spammerait l'écran.
function idleKillBurst(count) {
  const scene = document.getElementById('idle-scene');
  if (scene) {
    scene.classList.remove('idle-kill-flash');
    void scene.offsetWidth;
    scene.classList.add('idle-kill-flash');
  }
  idleSpawnFloat(count > 1 ? `×${count} vaincus !` : 'Vaincu !', 'kill');
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
}

// Particules ambiantes (feuilles/braises/étoiles selon le thème) — cosmétique
// pur en CSS, régénérées seulement quand le décor change (pas à chaque poll).
const IDLE_PARTICLE_GLYPH = { wood: '🍃', garden: '✨', temple: '❄️', gold: '🏮', celestial: '🪶', hueco: '🌙', ua: '🎉', shibuya: '⚡', aincrad: '✦', void: '💫' };
function idleSpawnParticles(theme) {
  if (idleParticleTheme === theme) return;
  idleParticleTheme = theme;
  const box = document.getElementById('idle-particles');
  if (!box) return;
  const glyph = IDLE_PARTICLE_GLYPH[theme] || '✨';
  const count = 14;
  let html = '';
  for (let i = 0; i < count; i++) {
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 12).toFixed(2);
    const duration = (14 + Math.random() * 10).toFixed(2);
    const size = (0.7 + Math.random() * 0.9).toFixed(2);
    html += `<span class="idle-particle" style="left:${left}%;animation-delay:${delay}s;animation-duration:${duration}s;font-size:${size}rem">${glyph}</span>`;
  }
  box.innerHTML = html;
}

// Scène décorative en SVG inline (silhouettes) par thème — pas d'asset externe
// à héberger/générer, juste des formes plates dans la couleur du décor.
// Régénérée seulement au changement de thème (comme les particules).
// Scènes « peintes » en SVG plat, une par palier — le décor visuel principal
// (la jaquette d'anime, trop petite pour servir de fond, est affichée à part
// en kakémono net, cf. idleRenderBackdrop). Composition : collines en couches,
// bâtiment à droite du centre (le gardien occupe le centre), bandeau de sol
// sombre en bas pour asseoir la barre d'XP. L'essentiel vit dans y∈[180,400] :
// avec preserveAspectRatio "slice", le haut est rogné sur écran large.
const IDLE_SCENERY_SVG = {
  wood: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice">
    <path d="M0,290 C180,240 360,270 540,245 C760,215 980,265 1200,235 L1200,400 0,400 Z" fill="#52381c" opacity=".4"/>
    <path d="M0,330 C240,295 480,320 720,300 C900,285 1080,315 1200,300 L1200,400 0,400 Z" fill="#241407" opacity=".8"/>
    <rect x="690" y="330" width="220" height="14" fill="#170c05"/>
    <rect x="710" y="270" width="180" height="60" fill="#2e1b0c"/>
    <rect x="785" y="290" width="30" height="40" fill="#0f0803"/>
    <rect x="740" y="284" width="18" height="24" fill="#ffb648" opacity=".8"/>
    <rect x="842" y="284" width="18" height="24" fill="#ffb648" opacity=".8"/>
    <path d="M680,270 L920,270 888,240 712,240 Z" fill="#1a0e06"/>
    <path d="M702,240 L898,240 872,214 728,214 Z" fill="#26130a"/>
    <rect x="654" y="302" width="6" height="30" fill="#0f0803"/>
    <circle cx="657" cy="296" r="7" fill="#ffb648" opacity=".85"/>
    <rect x="940" y="302" width="6" height="30" fill="#0f0803"/>
    <circle cx="943" cy="296" r="7" fill="#ffb648" opacity=".85"/>
    <ellipse cx="240" cy="352" rx="60" ry="14" fill="#1d1207"/>
    <ellipse cx="1050" cy="356" rx="80" ry="16" fill="#1d1207"/>
    <rect x="0" y="346" width="1200" height="54" fill="#120a04" opacity=".95"/>
  </svg>`,
  garden: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice">
    <path d="M0,285 C220,245 440,275 660,250 C880,225 1060,265 1200,245 L1200,400 0,400 Z" fill="#2c5e38" opacity=".45"/>
    <path d="M0,330 C260,300 520,325 780,305 C960,292 1100,315 1200,305 L1200,400 0,400 Z" fill="#1b3b25" opacity=".85"/>
    <ellipse cx="420" cy="356" rx="150" ry="16" fill="#7ec8ff" opacity=".22"/>
    <path d="M836,346 L846,346 850,300 864,278 855,275 843,296 Z" fill="#3a2415"/>
    <circle cx="826" cy="250" r="34" fill="#f2a3c6" opacity=".95"/>
    <circle cx="862" cy="236" r="40" fill="#ee8fb9" opacity=".95"/>
    <circle cx="898" cy="258" r="30" fill="#f6b7d3" opacity=".95"/>
    <circle cx="844" cy="272" r="26" fill="#e97fb0" opacity=".95"/>
    <circle cx="886" cy="284" r="21" fill="#f2a3c6" opacity=".95"/>
    <rect x="700" y="302" width="16" height="44" fill="#333a33"/>
    <path d="M690,302 L726,302 708,286 Z" fill="#2a302a"/>
    <circle cx="708" cy="308" r="5" fill="#ffe08c" opacity=".9"/>
    <circle cx="780" cy="358" r="4" fill="#f2a3c6" opacity=".8"/>
    <circle cx="920" cy="362" r="3" fill="#f2a3c6" opacity=".8"/>
    <circle cx="860" cy="368" r="3.5" fill="#ee8fb9" opacity=".8"/>
    <rect x="0" y="350" width="1200" height="50" fill="#14210f" opacity=".95"/>
  </svg>`,
  temple: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice">
    <path d="M0,280 L220,225 430,270 640,230 860,275 1060,235 1200,265 L1200,400 0,400 Z" fill="#3a1017" opacity=".5"/>
    <path d="M0,325 C260,300 520,320 780,305 1000,293 1120,312 1200,304 L1200,400 0,400 Z" fill="#200a0e" opacity=".85"/>
    <rect x="730" y="336" width="180" height="12" fill="#14060a"/>
    <rect x="760" y="300" width="120" height="36" fill="#401017"/>
    <path d="M740,300 L900,300 870,276 770,276 Z" fill="#6b1b28"/>
    <rect x="778" y="246" width="84" height="30" fill="#401017"/>
    <path d="M760,246 L880,246 856,224 784,224 Z" fill="#7a2230"/>
    <rect x="794" y="200" width="52" height="24" fill="#401017"/>
    <path d="M780,200 L860,200 840,180 800,180 Z" fill="#8a2838"/>
    <rect x="818" y="166" width="4" height="14" fill="#d4a94e"/>
    <rect x="806" y="308" width="12" height="16" fill="#ffb648" opacity=".85"/>
    <rect x="826" y="308" width="12" height="16" fill="#ffb648" opacity=".85"/>
    <rect x="280" y="290" width="10" height="60" fill="#5a1622"/>
    <rect x="352" y="290" width="10" height="60" fill="#5a1622"/>
    <rect x="264" y="282" width="114" height="10" fill="#7a2230"/>
    <rect x="276" y="304" width="90" height="7" fill="#7a2230"/>
    <circle cx="480" cy="330" r="6" fill="#ff9d5c" opacity=".85"/>
    <circle cx="560" cy="336" r="6" fill="#ff9d5c" opacity=".85"/>
    <circle cx="640" cy="330" r="6" fill="#ff9d5c" opacity=".85"/>
    <rect x="0" y="348" width="1200" height="52" fill="#12050a" opacity=".95"/>
  </svg>`,
  gold: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice">
    <path d="M0,285 C220,250 460,275 700,255 C920,237 1080,265 1200,250 L1200,400 0,400 Z" fill="#4a3408" opacity=".5"/>
    <path d="M0,330 C280,305 560,325 840,308 1040,297 1140,312 1200,306 L1200,400 0,400 Z" fill="#2a1d05" opacity=".85"/>
    <rect x="700" y="340" width="240" height="12" fill="#1a1204"/>
    <rect x="724" y="330" width="192" height="10" fill="#241804"/>
    <rect x="740" y="296" width="160" height="34" fill="#6b4a10"/>
    <rect x="756" y="300" width="10" height="30" fill="#8a6318"/>
    <rect x="810" y="300" width="10" height="30" fill="#8a6318"/>
    <rect x="864" y="300" width="10" height="30" fill="#8a6318"/>
    <path d="M715,296 L925,296 888,264 752,264 Z" fill="#e0a838"/>
    <path d="M746,264 L894,264 864,240 776,240 Z" fill="#c68a28"/>
    <circle cx="820" cy="232" r="8" fill="#ffe08c"/>
    <circle cx="540" cy="250" r="4" fill="#ffe08c" opacity=".9"/>
    <circle cx="980" cy="270" r="3" fill="#ffe08c" opacity=".8"/>
    <circle cx="620" cy="300" r="3" fill="#ffe08c" opacity=".7"/>
    <circle cx="1050" cy="235" r="4" fill="#ffe08c" opacity=".85"/>
    <ellipse cx="330" cy="352" rx="46" ry="10" fill="#e0a838" opacity=".5"/>
    <ellipse cx="330" cy="346" rx="30" ry="8" fill="#ffd34d" opacity=".5"/>
    <rect x="0" y="350" width="1200" height="50" fill="#171004" opacity=".95"/>
  </svg>`,
  celestial: `<svg viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice">
    <circle cx="960" cy="230" r="46" fill="#dce4ff" opacity=".9"/>
    <circle cx="946" cy="220" r="9" fill="#b9c4ea" opacity=".9"/>
    <circle cx="972" cy="244" r="6" fill="#b9c4ea" opacity=".9"/>
    <circle cx="962" cy="208" r="4" fill="#b9c4ea" opacity=".8"/>
    <circle cx="240" cy="210" r="2.5" fill="#fff" opacity=".8"/>
    <circle cx="380" cy="250" r="2" fill="#fff" opacity=".6"/>
    <circle cx="520" cy="200" r="2.5" fill="#fff" opacity=".7"/>
    <circle cx="660" cy="240" r="2" fill="#fff" opacity=".6"/>
    <circle cx="1100" cy="300" r="2.5" fill="#fff" opacity=".7"/>
    <circle cx="150" cy="300" r="2" fill="#fff" opacity=".6"/>
    <ellipse cx="300" cy="270" rx="90" ry="14" fill="#8fa3ff" opacity=".14"/>
    <ellipse cx="1050" cy="330" rx="110" ry="16" fill="#8fa3ff" opacity=".12"/>
    <path d="M716,322 C736,292 904,292 924,322 L900,346 740,346 Z" fill="#2a2158"/>
    <path d="M760,346 L798,382 822,346 Z" fill="#1a1240"/>
    <path d="M842,346 L868,372 886,346 Z" fill="#1a1240"/>
    <rect x="798" y="284" width="44" height="24" fill="#3a2d78"/>
    <path d="M786,284 L854,284 838,264 802,264 Z" fill="#6a5ac8"/>
    <rect x="818" y="254" width="4" height="10" fill="#b9c4ea"/>
    <rect x="806" y="290" width="8" height="12" fill="#8fa3ff" opacity=".9"/>
    <rect x="0" y="356" width="1200" height="44" fill="#0a081c" opacity=".9"/>
  </svg>`,
};
function idleSetScenery(theme) {
  const box = document.getElementById('idle-scenery');
  if (!box) return;
  // Fonds peints originaux, optimisés en WebP. Le SVG reste derrière comme
  // repli immédiat si l'asset est indisponible ou encore en cache ancien.
  const art = {
    wood: '/assets/idle/dojo-wood.webp',
    garden: '/assets/idle/dojo-garden.webp',
    temple: '/assets/idle/dojo-temple.webp',
    gold: '/assets/idle/dojo-gold.webp',
    celestial: '/assets/idle/dojo-celestial.webp',
    hueco: '/assets/idle/dojo-hueco.webp',
    ua: '/assets/idle/dojo-ua.webp',
    shibuya: '/assets/idle/dojo-shibuya.webp',
    aincrad: '/assets/idle/dojo-aincrad.webp',
    void: '/assets/idle/dojo-void.webp',
  };
  box.innerHTML = IDLE_SCENERY_SVG[theme] || IDLE_SCENERY_SVG.wood;
  box.style.backgroundImage = `url('${art[theme] || art.wood}')`;
}

// Jaquette de l'anime du gardien (AniList, déjà en base) : affichée NETTE dans
// un petit cadre façon kakémono accroché dans la scène — jamais étirée en fond
// (la vignette ~100-230 px devenait une bouillie floue en pleine largeur, cf.
// retour utilisateur). Le décor lui-même reste la scène stylisée en SVG.
function idleRenderBackdrop(url) {
  const poster = document.getElementById('idle-scene-poster');
  if (!poster) return;
  poster.classList.toggle('hidden', !url);
  poster.style.backgroundImage = url ? `url('${url}')` : 'none';
}

// Le « gardien » mythique du palier trône au centre de la scène — vrai
// personnage AniList, pas une illustration générique.
function idleRenderBoss(boss, theme) {
  const el = document.getElementById('idle-decor-boss');
  if (!el) return;
  if (!boss && !['wood', 'garden', 'temple', 'gold', 'celestial', 'hueco', 'ua', 'shibuya', 'aincrad', 'void'].includes(theme)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  const fighters = {
    wood: { name: 'Naruto Uzumaki', image: '/assets/idle/fighters/naruto.webp' },
    garden: { name: 'Son Goku', image: '/assets/idle/fighters/goku.webp' },
    temple: { name: 'Monkey D. Luffy', image: '/assets/idle/fighters/luffy.webp' },
    gold: { name: 'Tanjiro Kamado', image: '/assets/idle/fighters/tanjiro.webp' },
    celestial: { name: 'Eren Yeager', image: '/assets/idle/fighters/eren.webp' },
    hueco: { name: 'Ichigo Kurosaki', image: '/assets/idle/fighters/ichigo.webp' },
    ua: { name: 'Izuku Midoriya', image: '/assets/idle/fighters/deku.webp' },
    shibuya: { name: 'Satoru Gojo', image: '/assets/idle/fighters/gojo.webp' },
    aincrad: { name: 'Kirito', image: '/assets/idle/fighters/kirito.webp' },
    void: { name: 'Jiren', image: '/assets/idle/fighters/jiren.webp' },
  };
  const fighter = fighters[theme];
  if (fighter) {
    el.classList.add('idle-scene-fighter');
    el.innerHTML = `<img class="idle-fighter-sprite" src="${fighter.image}" alt="${escapeHtml(fighter.name)}">
      <span class="idle-boss-name">${escapeHtml(fighter.name)}<small>Gardien du lieu</small></span>`;
    return;
  }
  el.classList.remove('idle-scene-fighter');
  // Portrait IA généré via la route admin (voir POST /api/admin/dojo/generate-boss-art)
  // si disponible, sinon repli sur le portrait AniList existant (comportement historique).
  const url = boss.generatedImageUrl || boss.imageUrl;
  const img = url ? ` style="background-image:url('${url}')"` : '';
  el.innerHTML = `<span class="idle-boss-portrait"${img}></span>
    <span class="idle-boss-name">${escapeHtml(boss.name)}<small>Gardien du lieu</small></span>`;
}

function renderIdleMilestone(dojo) {
  const btn = document.getElementById('idle-milestone-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', !dojo.milestone.available);
  if (dojo.milestone.available) {
    document.getElementById('idle-milestone-reward').textContent = `+${idleFormatNumber(dojo.milestone.reward)}`;
  }
}

function renderIdlePrestige(dojo) {
  document.getElementById('idle-prestige-lvl').textContent = `Nv. ${dojo.prestige.level}`;
  const btn = document.getElementById('idle-prestige-btn');
  const hint = document.getElementById('idle-prestige-hint');
  if (btn) btn.disabled = !dojo.prestige.eligible;
  if (hint) {
    hint.textContent = dojo.prestige.eligible
      ? ''
      : `Débloqué au niveau ${dojo.prestige.minLevel} de l'Idle (actuellement ${dojo.level}).`;
  }
}

// Description lisible d'un Ancient selon son `kind` (cf. ANCIENTS côté serveur,
// src/idle/idle.js) — même logique de mise en forme que renderIdleUpgrades,
// juste une monnaie différente (Sagesse, jamais l'essence).
const IDLE_ANCIENT_DESC = {
  prodMult: (v) => `+${(v * 100).toFixed(0)}% production totale / niveau`,
  clickMult: (v) => `+${(v * 100).toFixed(0)}% puissance de clic / niveau`,
  offlineCapMs: (v) => `+${Math.round(v / 60000)} min de plafond hors-ligne / niveau`,
  recruitLuck: (v) => `+${(v * 100).toFixed(1)}% chance de recrue rareté sup. / niveau`,
  recruitDiscount: (v) => `−${(v * 100).toFixed(1)}% coût de recrutement / niveau`,
};
// Ancients : arbre de Prestige PERMANENT (jamais reset), payé en Sagesse —
// pas en essence. Mêmes cartes visuelles que renderIdleUpgrades (idle-upgrade-card),
// bouton distinct (data-ancient) pour router vers /api/idle/ancient.
function renderIdleAncients(ancients) {
  const box = document.getElementById('idle-ancients');
  const points = document.getElementById('idle-wisdom-points');
  if (points) points.textContent = idleFormatNumber(ancients.points);
  if (!box) return;
  box.innerHTML = ancients.items.map((it) => {
    const desc = (IDLE_ANCIENT_DESC[it.kind] || (() => ''))(it.effectPerLevel);
    return `
    <div class="idle-upgrade-card">
      <div class="idle-upgrade-ico"><i class="fas ${it.icon}"></i></div>
      <div class="idle-upgrade-info">
        <h4>${escapeHtml(it.name)} <span class="idle-upgrade-lvl">Nv. ${it.level}</span></h4>
        <p>${desc}</p>
      </div>
      <button class="btn-secondary idle-ancient-btn" data-ancient="${it.key}"${ancients.points < it.cost ? ' disabled' : ''}>${idleFormatNumber(it.cost)} <i class="fas fa-brain"></i></button>
    </div>`;
  }).join('');
}

// Ligne de héros compacte façon Clicker Heroes — volontairement PAS cardHTML()
// (carte gacha pleine taille) : jusqu'à 10 emplacements doivent tenir sans
// scroll excessif, ici on n'a besoin que du portrait + niveau + production.
function idleSlotHTML(slot) {
  if (slot.locked) {
    return `<div class="idle-hero idle-hero-locked">
      <i class="fas fa-lock"></i>
      <button class="btn-secondary idle-unlock-btn" data-slot="${slot.index}">${idleFormatNumber(slot.unlockCost)} <i class="fas fa-mortar-pestle"></i></button>
    </div>`;
  }
  if (!slot.character) {
    return `<button class="idle-hero idle-hero-empty" data-slot="${slot.index}" data-action="pick">
      <i class="fas fa-plus"></i><span>Assigner</span>
    </button>`;
  }
  const c = slot.character;
  const img = c.imageUrl ? ` style="background-image:url('${c.imageUrl}')"` : '';
  // data-action="pick" sur le conteneur : cliquer la carte propose de la
  // remplacer (un seul geste, au lieu de retirer puis réassigner). Les
  // boutons ×/niveau matchent leur propre data-action en premier dans la
  // délégation d'événements (cf. initIdleUI), donc pas de conflit.
  return `<div class="idle-hero r-${c.rarity}" data-slot="${slot.index}" data-action="pick" title="${escapeHtml(c.name)} — cliquer pour remplacer">
    <div class="idle-hero-portrait"${img}></div>
    <button class="idle-hero-remove" data-slot="${slot.index}" data-action="unassign" title="Retirer"><i class="fas fa-xmark"></i></button>
    <div class="idle-hero-name">${escapeHtml(c.name)}</div>
    <div class="idle-hero-meta">
      <span class="idle-hero-lvl">Nv. ${idleFormatNumber(c.level)}</span>
      <span class="idle-hero-rate">+${idleFormatNumber(c.rate)}/s</span>
    </div>
    <div class="idle-hero-stats"><span>Base <b>${idleFormatNumber(c.baseRate)}/s</b></span><span>Scaling <b>+${Math.round(c.scaling * 100)}%/niv.</b></span></div>
    <div class="idle-hero-passive"><i class="fas fa-wand-sparkles"></i> ${escapeHtml(c.passive)}</div>
    <div class="idle-level-buys">${[1,5,10,100].map((n) => `<button class="idle-hero-levelup" data-slot="${slot.index}" data-amount="${n}" data-action="levelup" title="Monter de ${n} niveaux · coût ${idleFormatNumber(c.levelCosts[n])}"${idleState && idleState.essence < c.levelCosts[n] ? ' disabled' : ''}><b>×${n}</b><small>${idleFormatNumber(c.levelCosts[n])}</small></button>`).join('')}</div>
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
  const pending = idleState?.pendingEssence || 0;
  try {
    await api('/api/idle/collect', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    alert(e.message);
    return;
  }
  // Le nombre affiché inclut déjà le pending (cf. idleTick) : sans ce petit
  // retour, cliquer « Récolter » ne « faisait » visiblement rien.
  if (pending > 0) idleSpawnFloat(`+${idleFormatNumber(pending)}`, ['xp', idleFloatTier(pending)].filter(Boolean).join(' '));
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  const essenceEl = document.getElementById('idle-essence-val');
  if (essenceEl) idleBump(essenceEl);
  refreshIdleState();
}

async function clickIdle() {
  // Retour immédiat : l'animation part au pointer-down, sans attendre le
  // réseau. Le serveur reste autoritaire pour le solde et l'anti-spam.
  const predicted = idleState?.click?.yield || 1;
  idleClickFeedback(predicted);
  idleSpawnFloat(`+${predicted}`, idleFloatTier(predicted));
  let r;
  try {
    r = await api('/api/idle/click', { method: 'POST', body: JSON.stringify({}) });
  } catch {
    return; // 429 (anti-spam) ou réseau : on ignore silencieusement, pas de quoi bloquer le joueur
  }
  if (idleState) idleState.essence = r.essence;
  // Recharge l'état autoritaire pour animer les PV et détecter immédiatement
  // le passage à la vague/zone suivante après le coup.
  refreshIdleState();
}

function idleClickFeedback(gained) {
  const btn = document.getElementById('idle-click-btn');
  if (!btn) return;
  const fx = document.createElement('span');
  fx.className = 'idle-click-fx';
  fx.textContent = `+${gained}`;
  btn.appendChild(fx);
  setTimeout(() => fx.remove(), 700);
  // Deux petites pièces qui s'envolent, angles légèrement aléatoires — pur sucre visuel.
  for (let i = 0; i < 2; i++) {
    const coin = document.createElement('span');
    coin.className = 'idle-click-coin';
    coin.textContent = '🪙';
    coin.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 60)}px`);
    btn.appendChild(coin);
    setTimeout(() => coin.remove(), 650);
  }
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  idleCombatMotion('hero');
}

// Donne du poids au combat sans inventer de dégâts côté client : le clic fait
// avancer le héros, la production passive déclenche une salve de l'équipe, et
// le gardien accuse chaque impact. Ces animations ne touchent jamais l'état.
function idleCombatMotion(source) {
  if (idleActivePanel !== 'home') return;
  const hero = document.getElementById('idle-main-hero');
  const boss = document.getElementById('idle-decor-boss');
  const scene = document.getElementById('idle-scene');
  const restart = (el, cls) => {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 420);
  };
  if (source === 'hero') restart(hero, 'idle-hero-attacking');
  if (source === 'team') document.querySelectorAll('.idle-stage-ally').forEach((ally, i) => setTimeout(() => restart(ally, 'idle-ally-attacking'), i * 45));
  restart(boss, source === 'hero' ? 'idle-fighter-hit' : 'idle-fighter-team-hit');
  if (!scene) return;
  const impact = document.createElement('span');
  impact.className = `idle-combat-impact ${source}`;
  impact.innerHTML = source === 'hero' ? '<i class="fas fa-burst"></i>' : '<i class="fas fa-bolt"></i>';
  scene.appendChild(impact);
  setTimeout(() => impact.remove(), 520);
}

async function levelUpIdleSlot(slotIndex, slotEl, amount = 1) {
  try {
    await api('/api/idle/slot-level', { method: 'POST', body: JSON.stringify({ slotIndex, amount }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  // Action la plus répétée du jeu (niveauter son équipe) : sans retour, chaque
  // achat passait totalement inaperçu — seul le chiffre changeait en silence.
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  if (slotEl) idleCardBump(slotEl);
  refreshIdleState();
}

async function buyIdleUpgrade(type, cardEl) {
  try {
    await api('/api/idle/upgrade', { method: 'POST', body: JSON.stringify({ type }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  if (cardEl) idleCardBump(cardEl);
  refreshIdleState();
}

// Achète (ou monte) un Ancient — payé en Sagesse (wisdomPoints), jamais en
// essence, cf. POST /api/idle/ancient.
async function buyIdleAncient(key, cardEl) {
  try {
    await api('/api/idle/ancient', { method: 'POST', body: JSON.stringify({ key }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  if (cardEl) idleCardBump(cardEl);
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
  document.getElementById('idle-picker').classList.remove('hidden');
  await refreshIdlePickerList();
}

// Roster du Dojo (/api/idle/roster) — PAS la collection gacha : le Dojo est
// un jeu à part, ses personnages viennent du recrutement (voir recruitIdle).
async function refreshIdlePickerList() {
  if (idlePickerSlot == null) return;
  document.getElementById('idle-picker-hint').textContent = 'Chargement…';
  document.getElementById('idle-picker-list').innerHTML = '';
  let data;
  try {
    data = await api('/api/idle/roster');
  } catch (e) {
    document.getElementById('idle-picker-hint').textContent = e.message;
    return;
  }
  const assignedIds = new Set((idleState?.slots || []).filter((s) => s.character && s.index !== idlePickerSlot).map((s) => s.character.id));
  const available = (data.recruits || []).filter((c) => !assignedIds.has(c.id));
  document.getElementById('idle-picker-hint').textContent = available.length
    ? `${available.length} personnage(s) recruté(s) disponible(s)`
    : 'Aucun personnage disponible — recrute-en un ci-dessus.';
  document.getElementById('idle-picker-list').innerHTML = available.map((c, i) => cardHTML(c, { index: i })).join('');
}

async function recruitIdle() {
  let r;
  try {
    r = await api('/api/idle/recruit', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof sfx !== 'undefined' && sfx.reveal) sfx.reveal(r.recruited.rarity);
  if (['epic', 'legendary', 'mythic'].includes(r.recruited.rarity) && typeof burstConfetti === 'function') {
    burstConfetti(r.recruited.rarity === 'mythic' ? 50 : 30);
  }
  renderIdleState(r);
  showIdleRecruitReveal(r.recruited);
  await refreshIdlePickerList(); // no-op si la modale n'est pas ouverte
}

function showIdleRecruitReveal(character) {
  idleLastRecruit = character;
  const modal = document.getElementById('idle-recruit-reveal');
  const body = document.getElementById('idle-recruit-reveal-body');
  if (!modal || !body) return;
  const rarity = (typeof RARITY_LABELS !== 'undefined' && RARITY_LABELS[character.rarity]) || character.rarity;
  const img = character.imageUrl ? `style="background-image:url('${escapeHtml(character.imageUrl)}')"` : '';
  body.innerHTML = `<div class="idle-recruit-reveal-art r-${character.rarity}">
      <div class="idle-recruit-reveal-img" ${img}></div>
      <div class="idle-recruit-reveal-glow"></div>
    </div>
    <strong class="idle-recruit-reveal-name">${escapeHtml(character.name)}</strong>
    <span class="idle-recruit-reveal-series">${escapeHtml(character.series || 'Univers inconnu')}</span>
    <span class="idle-recruit-reveal-rarity r-${character.rarity}">${escapeHtml(rarity)}</span>`;
  const freeSlot = idleState?.slots?.find((s) => !s.locked && !s.character);
  const assign = document.getElementById('idle-recruit-assign');
  if (assign) assign.innerHTML = freeSlot
    ? '<i class="fas fa-user-plus"></i> Ajouter à l’équipe'
    : '<i class="fas fa-users"></i> Voir mon équipe';
  modal.classList.remove('hidden');
}

function closeIdleRecruitReveal() {
  document.getElementById('idle-recruit-reveal')?.classList.add('hidden');
}

async function assignIdleLastRecruit() {
  if (!idleLastRecruit || !idleState) return;
  const freeSlot = idleState.slots.find((s) => !s.locked && !s.character);
  closeIdleRecruitReveal();
  if (!freeSlot) return idleShowPanel('team');
  idlePickerSlot = freeSlot.index;
  await pickIdleCharacter(idleLastRecruit.id);
  idleShowPanel('team');
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

async function claimIdleMilestone() {
  try {
    await api('/api/idle/claim-milestone', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof burstConfetti === 'function') burstConfetti(40);
  if (typeof sfx !== 'undefined' && sfx.win) sfx.win();
  refreshIdleState();
}

async function prestigeIdle() {
  if (!idleState || !idleState.dojo.prestige.eligible) return;
  const ok = confirm(
    "Prestiger remet à zéro l'essence, les emplacements et les améliorations de cette run (le niveau de l'Idle et les coffres réclamés sont conservés) contre de la Sagesse, à dépenser dans les Ancients. Confirmer ?"
  );
  if (!ok) return;
  try {
    await api('/api/idle/prestige', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof burstConfetti === 'function') burstConfetti(50);
  if (typeof sfx !== 'undefined' && sfx.win) sfx.win();
  refreshIdleState();
}

function initIdleUI() {
  document.getElementById('idle-collect-btn')?.addEventListener('click', collectIdle);
  document.getElementById('idle-click-btn')?.addEventListener('click', clickIdle);
  document.getElementById('idle-skill-burst')?.addEventListener('click', idleUseBurst);
  document.getElementById('idle-skill-team')?.addEventListener('click', idleUseTeamSkill);
  document.getElementById('idle-missions')?.addEventListener('click', (e) => { const b = e.target.closest('[data-idle-mission]'); if (b && !b.disabled) claimIdleMission(b.dataset.idleMission); });
  // Taper la scène = entraîner (comme frapper le monstre dans un idle game).
  // L'anti-spam serveur (900 ms) borne le rythme, l'échec 429 est silencieux.
  document.getElementById('idle-scene')?.addEventListener('pointerdown', clickIdle);
  document.getElementById('idle-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-idle-tab]');
    if (tab) idleShowPanel(tab.dataset.idleTab);
  });
  document.getElementById('idle-picker-close')?.addEventListener('click', closeIdlePicker);
  document.getElementById('idle-picker')?.addEventListener('click', (e) => { if (e.target.id === 'idle-picker') closeIdlePicker(); });
  document.getElementById('idle-slots')?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-action="unassign"]');
    if (removeBtn) return unassignIdleSlot(Number(removeBtn.dataset.slot));
    const levelBtn = e.target.closest('[data-action="levelup"]');
    if (levelBtn) return levelUpIdleSlot(Number(levelBtn.dataset.slot), levelBtn.closest('.idle-hero'), Number(levelBtn.dataset.amount || 1));
    const unlockBtn = e.target.closest('.idle-unlock-btn');
    if (unlockBtn) return buyIdleUpgrade('slot', unlockBtn.closest('.idle-hero'));
    const pickBtn = e.target.closest('[data-action="pick"]');
    if (pickBtn) return openIdlePicker(Number(pickBtn.dataset.slot));
  });
  document.getElementById('idle-upgrades')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.idle-upgrade-btn');
    if (btn) buyIdleUpgrade(btn.dataset.upgrade, btn.closest('.idle-upgrade-card'));
  });
  document.getElementById('idle-ancients')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.idle-ancient-btn');
    if (btn) buyIdleAncient(btn.dataset.ancient, btn.closest('.idle-upgrade-card'));
  });
  document.getElementById('idle-picker-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-cid]');
    if (card) pickIdleCharacter(Number(card.dataset.cid));
  });
  document.getElementById('idle-top-recruit-btn')?.addEventListener('click', recruitIdle);
  document.getElementById('idle-recruit-btn')?.addEventListener('click', recruitIdle);
  document.getElementById('idle-recruit-reveal-close')?.addEventListener('click', closeIdleRecruitReveal);
  document.getElementById('idle-recruit-reveal')?.addEventListener('click', (e) => { if (e.target.id === 'idle-recruit-reveal') closeIdleRecruitReveal(); });
  document.getElementById('idle-recruit-again')?.addEventListener('click', () => { closeIdleRecruitReveal(); recruitIdle(); });
  document.getElementById('idle-recruit-assign')?.addEventListener('click', assignIdleLastRecruit);
  document.getElementById('idle-milestone-btn')?.addEventListener('click', claimIdleMilestone);
  document.getElementById('idle-prestige-btn')?.addEventListener('click', prestigeIdle);
  document.getElementById('idle-customize-hero')?.addEventListener('click', (e) => {
    e.stopPropagation();
    idleStopTicker();
    document.body.classList.remove('idle-fullscreen');
    openProfile();
  });
  document.getElementById('idle-welcome-close')?.addEventListener('click', () => document.getElementById('idle-welcome').classList.add('hidden'));
  document.getElementById('idle-welcome-collect')?.addEventListener('click', () => {
    document.getElementById('idle-welcome').classList.add('hidden');
    collectIdle();
  });
}

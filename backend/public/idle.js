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
let idleActivePanel = 'home'; // page courante de l'Idle
let idleTickCount = 0; // compteur du ticker — cadence les gains flottants passifs de la scène
let idleLastRecruit = null; // personnage affiché dans la révélation de recrutement
let idleLastRecruitCurrency = 'seals';
let idleBurstReadyAt = 0;
let idleTeamSkillReadyAt = 0;
let idleNextClickAt = 0;
let idleClickPending = 0;
let idleClickFlushTimer = null;
let idleClickSending = false;
let idleClickRetryBatch = null;
let idleSyncInFlight = false;
let idleOnboardingClass = 'warrior';
let idleOnboardingCharacterId = null;
let idleOnboardingSubmitting = false;
let idleCombatEntries = [];
let idleItemFilter = 'all';
let idleItemSort = 'power';

function idleAddCombatLog(message,icon='fa-bolt'){
  idleCombatEntries.unshift({message,icon,at:new Date()});idleCombatEntries=idleCombatEntries.slice(0,4);
  const box=document.getElementById('idle-combat-log');if(!box)return;
  box.innerHTML=idleCombatEntries.map((entry)=>`<span><i class="fas ${entry.icon}"></i>${escapeHtml(entry.message)}<small>${entry.at.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</small></span>`).join('');
}

function idleFormatNumber(n) {
  n = Number(n || 0);
  if (!Number.isFinite(n)) return '∞';
  n = Math.floor(n);
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n < 1000) return sign + n;
  if (n < 1e6) return sign + (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return sign + (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n < 1e12) return sign + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n < 1e15) return sign + (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  return sign + n.toExponential(2).replace('+', '');
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
  if (idleSyncInFlight) return;
  idleSyncInFlight = true;
  try {
    const state=await api('/api/idle/collect',{method:'POST',body:JSON.stringify({})});
    renderIdleState(state);
  } catch {
    return; // pas grave : la prochaine synchro (6 s plus tard) rattrapera
  } finally {
    idleSyncInFlight = false;
  }
}

// Navigation latérale sur ordinateur et barre compacte sur mobile.
function idleShowPanel(name) {
  idleActivePanel = name;
  for (const p of ['home', 'progression', 'team', 'equipment', 'upgrades', 'activities']) {
    document.getElementById('idle-panel-' + p)?.classList.toggle('hidden', p !== name);
  }
  document.querySelectorAll('#idle-tabs .idle-tab').forEach((t) => {
    const active = t.dataset.idleTab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

// Nombre flottant dans la scène (+essence, façon dégâts/gains d'un jeu mobile).
function idleSpawnFloat(text, cls) {
  const box = document.getElementById('idle-floats');
  if (!box) return;
  const f = document.createElement('span');
  f.className = 'idle-float' + (cls ? ' ' + cls : '');
  f.textContent = text;
  const floatClasses = String(cls || '').split(' ');
  const isDamage = floatClasses.includes('damage') || floatClasses.includes('kill');
  // Les dégâts apparaissent sur l'ennemi, pas aléatoirement dans tout le décor.
  f.style.left = isDamage ? `${Math.round(66 + Math.random() * 12)}%` : `${Math.round(12 + Math.random() * 60)}%`;
  f.style.top = isDamage ? `${Math.round(36 + Math.random() * 18)}%` : `${Math.round(35 + Math.random() * 30)}%`;
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
  const display = idleState.essence + idleState.pendingEssence;
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
    idleSpawnFloat(`−${idleFormatNumber(passiveGain)}`, 'damage passive');
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
  const total = Math.max(1, idleState.battle.maxHp || idleState.battle.xpForNextStage || 1);
  const remaining = Math.max(0, (idleState.battle.hp ?? total) - gained);
  const hpEl = document.getElementById('idle-enemy-hp-text');
  if (hpEl) hpEl.textContent = `${idleFormatNumber(remaining)} / ${idleFormatNumber(total)} PV${idleEtaSuffix(remaining)}`;
}

// Anime réellement la barre entre deux états serveur. Le serveur reste la
// source de vérité (stage, kill, boss), mais la largeur ne paraît plus figée
// jusqu'au prochain clic ou à la synchronisation des 6 secondes.
function idleAnimateEnemyHp(fill,remaining,total,stage) {
  if (!fill) return;
  const hpPct=Math.max(0,Math.min(100,remaining/Math.max(1,total)*100));
  const dps=Math.max(0,idleState?.totalRate||0);
  fill.style.transition='none';
  fill.style.width=`${hpPct}%`;
  void fill.offsetWidth;
  if(dps<=0||remaining<=0)return;
  const duration=Math.max(.2,remaining/dps);
  requestAnimationFrame(()=>{
    if(idleState?.battle?.stage!==stage)return;
    fill.style.transition=`width ${duration}s linear`;
    fill.style.width='0%';
  });
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
  renderIdleOnboarding(state.onboarding);
  const essenceEl = document.getElementById('idle-essence-val');
  essenceEl.textContent = idleFormatNumber(state.essence + state.pendingEssence);
  if (prev && state.essence > prev.essence) idleBump(essenceEl);
  document.getElementById('idle-rate-val').textContent = idleFormatNumber(state.totalRate);
  document.getElementById('idle-pending-val').textContent = state.pendingEssence > 0 ? `+${idleFormatNumber(state.pendingEssence)}` : '0';
  const collectHelp = document.getElementById('idle-collect-help');
  if (collectHelp) collectHelp.innerHTML = state.pendingEssence > 0 ? `<i class="fas fa-rotate"></i> <b>${idleFormatNumber(state.pendingEssence)} Essence en synchronisation.</b> Elle sera créditée automatiquement.` : '<i class="fas fa-check"></i> Les gains sont crédités automatiquement. Ton équipe continue à produire hors ligne.';
  document.getElementById('idle-click-yield').textContent = `${idleFormatNumber(state.click.damage ?? state.click.yield)} dégâts`;
  document.getElementById('idle-slots').innerHTML = renderIdleSlots(state.slots);
  document.getElementById('idle-upgrades').innerHTML = renderIdleUpgrades(state);
  renderIdleRank(state.rank);
  renderIdleMissions(state.missions || [],state.rank);
  renderIdleChallenges(state.challenges||[]);
  renderIdleEvent(state.event);
  renderIdleAchievements(state.achievements || []);
  renderIdleGuide(state.guide);
  renderIdleSeason(state.season);
  const hudLevel = document.getElementById('idle-hud-level');
  if (hudLevel) hudLevel.textContent = `Nv. ${idleFormatNumber(state.dojo.level)}`;
  const xpTotal = document.getElementById('idle-xptotal-val');
  if (xpTotal) xpTotal.textContent = idleFormatNumber(state.dojo.xpTotal);
  const wisdomVal = document.getElementById('idle-wisdom-val');
  if (wisdomVal) wisdomVal.textContent = idleFormatNumber(state.ancients.points);
  const sealsVal = document.getElementById('idle-seals-val');
  if (sealsVal) sealsVal.textContent = idleFormatNumber(state.economy?.seals);
  // Multiplicateur TOTAL affiché sur la scène : Discipline (Ancients inclus) × niveau du Dojo.
  const mult = document.getElementById('idle-mult-val');
  if (mult) mult.textContent = `×${(state.prod.multiplier * state.dojo.multiplier).toFixed(2)}`;
  // Ligne de stats de combat façon PokéClicker — aucune nouvelle donnée,
  // juste rendues visibles en permanence (auparavant seulement dans la
  // rangée d'actions/le bouton de clic).
  const killsEl = document.getElementById('idle-kills-val');
  if (killsEl) killsEl.textContent = idleFormatNumber(state.battle.kills);
  const combatClick = document.getElementById('idle-combat-click');
  if (combatClick) combatClick.textContent = `+${idleFormatNumber(state.click.damage ?? state.click.yield)}`;
  const combatTeam = document.getElementById('idle-combat-team');
  if (combatTeam) combatTeam.textContent = `${idleFormatNumber(state.totalRate)}/s`;
  renderIdleDecor(state.dojo, prev?.dojo, state.battle, prev?.battle);
  renderIdleBattle(state.battle, state.dojo, prev?.battle);
  renderIdleBattleSpeed(state.battle?.speed);
  renderIdleBattleMode(state.battle?.mode);
  renderIdleAutoSkills(state.battle?.autoSkills);
  idleBurstReadyAt=state.battle?.skills?.burstReadyAt?new Date(state.battle.skills.burstReadyAt).getTime():0;
  idleTeamSkillReadyAt=state.battle?.skills?.teamReadyAt?new Date(state.battle.skills.teamReadyAt).getTime():0;
  idleRenderSkillCooldown();
  renderIdleBossChest(state.battle?.bossChest);
  renderIdleRoadmap(state.codex,state.battle);
  renderIdleMainHero(state);
  renderIdleTeamStrategy(state);
  renderIdleInventory(state);
  renderIdleMasteries(state.codex);
  renderIdleMilestone(state.dojo);
  renderIdlePrestige(state.dojo);
  renderIdleAncients(state.ancients);
  renderIdleRecruit(state.recruit);
  renderIdleRecruitHistory(state.recruitHistory || []);
}

function renderIdleOnboarding(onboarding) {
  const modal=document.getElementById('idle-onboarding');
  if(!modal)return;
  if(idleOnboardingSubmitting&&!onboarding?.required)return;
  modal.classList.toggle('hidden',!onboarding?.required);
  if(!onboarding?.required)return;
  modal.classList.remove('is-completing','is-leaving');
  document.getElementById('idle-onboarding-selection')?.classList.remove('hidden');
  document.getElementById('idle-onboarding-transition')?.classList.add('hidden');
  const classes=onboarding.classes||[];
  if(!classes.some((item)=>item.key===idleOnboardingClass))idleOnboardingClass=classes[0]?.key||'warrior';
  const starters=onboarding.starters||[];
  if(!starters.some((item)=>item.id===idleOnboardingCharacterId))idleOnboardingCharacterId=null;
  document.getElementById('idle-onboarding-classes').innerHTML=classes.map((item)=>`<button type="button" data-onboarding-class="${item.key}" class="${item.key===idleOnboardingClass?'selected':''}"><i class="fas ${item.icon}"></i><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)}</small></button>`).join('');
  document.getElementById('idle-onboarding-starters').innerHTML=starters.map((item)=>`<button type="button" data-onboarding-character="${item.id}" class="${item.id===idleOnboardingCharacterId?'selected':''}"><img src="${escapeHtml(item.imageUrl)}" alt=""><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.series||'Univers inconnu')}</small><em>${escapeHtml(item.talent?.name||'Talent unique')}</em></span></button>`).join('')||'<p class="hint">Aucun personnage Rare disponible. Contacte un administrateur.</p>';
  document.getElementById('idle-onboarding-start').disabled=!idleOnboardingCharacterId||idleOnboardingSubmitting;
}

function idleOnboardingDelay(ms) {
  return new Promise((resolve)=>setTimeout(resolve,ms));
}

async function playIdleOnboardingTransition(state,starter,heroClass) {
  const modal=document.getElementById('idle-onboarding');
  const transition=document.getElementById('idle-onboarding-transition');
  const view=document.getElementById('view-idle');
  const reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  document.getElementById('idle-onboarding-transition-image').src=starter.imageUrl||'';
  document.getElementById('idle-onboarding-transition-image').alt=starter.name||'';
  document.getElementById('idle-onboarding-transition-name').textContent=starter.name||'Ton personnage';
  document.getElementById('idle-onboarding-transition-class').textContent=heroClass.name||'Héros';
  document.getElementById('idle-onboarding-transition-icon').className=`fas ${heroClass.icon||'fa-shield-halved'}`;
  transition.classList.remove('hidden');
  modal.classList.add('is-completing');
  renderIdleState(state);
  await idleOnboardingDelay(reducedMotion?40:1350);
  view?.classList.add('idle-entering');
  modal.classList.add('is-leaving');
  await idleOnboardingDelay(reducedMotion?40:420);
  modal.classList.add('hidden');
  modal.classList.remove('is-completing','is-leaving');
  transition.classList.add('hidden');
  idleOnboardingSubmitting=false;
  window.setTimeout(()=>view?.classList.remove('idle-entering'),reducedMotion?20:650);
  window.setTimeout(()=>{
    idleCombatMotion('team');
    idleSpawnFloat(`${starter.name} rejoint l’équipe !`,'crit');
  },reducedMotion?30:220);
}

async function completeIdleOnboarding() {
  if(!idleOnboardingCharacterId||idleOnboardingSubmitting)return;
  const button=document.getElementById('idle-onboarding-start');
  const error=document.getElementById('idle-onboarding-error');
  const onboarding=idleState?.onboarding;
  const starter=onboarding?.starters?.find((item)=>item.id===idleOnboardingCharacterId);
  const heroClass=onboarding?.classes?.find((item)=>item.key===idleOnboardingClass);
  if(!starter||!heroClass)return;
  idleOnboardingSubmitting=true;
  button.disabled=true;
  button.innerHTML='<i class="fas fa-spinner fa-spin"></i> Création de l’équipe…';
  error.textContent='Sauvegarde de tes choix…';
  try{
    const state=await api('/api/idle/onboarding',{method:'POST',body:JSON.stringify({classKey:idleOnboardingClass,characterId:idleOnboardingCharacterId})});
    error.textContent='';
    await playIdleOnboardingTransition(state,starter,heroClass);
  }catch(e){
    idleOnboardingSubmitting=false;
    error.textContent=e.message;
    button.disabled=false;
    button.innerHTML='<i class="fas fa-play"></i> Réessayer';
  }
}

const IDLE_ROLES = {
  attaquant:{ name: 'Attaquant', icon: 'fa-burst', color: '#ff704d' },
  support:{ name: 'Support', icon: 'fa-wand-magic-sparkles', color: '#b06cff' },
  tank:{ name: 'Tank', icon: 'fa-shield-halved', color: '#4db8ff' },
  assassin:{ name: 'Assassin', icon: 'fa-bolt', color: '#ffd54a' },
  producteur:{ name: 'Producteur', icon: 'fa-gears', color: '#3ec98a' },
};
function idleRoleFor(character) { return IDLE_ROLES[character?.role]||IDLE_ROLES.attaquant; }
function renderIdleTeamStrategy(state) {
  const active = (state.slots || []).filter((s) => s.character).map((s) => s.character);
  const stage = document.getElementById('idle-stage-team');
  // Le premier personnage est le chef affiché en grand dans la scène.
  if (stage) stage.innerHTML = active.slice(1, 5).map((c) => {
    const role = idleRoleFor(c); const img = c.imageUrl ? `style="background-image:url('${escapeHtml(c.imageUrl)}')"` : '';
    return `<span class="idle-stage-ally" ${img} title="Membre de l'équipe · ${role.name}"><i class="fas ${role.icon}" style="--role:${role.color}"></i></span>`;
  }).join('');
  const counts = new Map(); active.forEach((c) => { const key=c.series||'Crossover'; counts.set(key,(counts.get(key)||0)+1); });
  const best = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0];
  const bonus = best?.[1] >= 3 ? 25 : best?.[1] >= 2 ? 10 : active.length >= 3 ? 5 : 0;
  const bar = document.getElementById('idle-synergy-bar');
  if (bar) { const reserve=Math.round((state.strategy?.reserveBonus||0)*100);bar.innerHTML = bonus ? `<i class="fas fa-link"></i><div><b>${best[1]>=2?escapeHtml(best[0]):'Crossover'} · Synergie +${bonus}%</b><span>${best[1]>=2?`${best[1]} combattants de la même licence`:'Trois univers différents réunis'}${reserve?` · Réserve +${reserve}%`:''}</span></div>` : `<i class="fas fa-link"></i><div><b>${reserve?`Réserve +${reserve}%`:'Aucune synergie active'}</b><span>Chaque recrue en réserve donne +1% DPS, jusqu’à +20%.</span></div>`; }
  const formations=document.getElementById('idle-formations');if(formations)formations.innerHTML=(state.strategy?.formations||[]).map((f)=>`<button data-idle-formation="${f.key}" class="${f.active?'active':''}"><b>${escapeHtml(f.name)}</b><small>${escapeHtml(f.description)}${f.multiplier>1?` · ×${f.multiplier.toFixed(2)}`:''}</small></button>`).join('');
  const presets=document.getElementById('idle-presets');if(presets)presets.innerHTML=`<div class="idle-preset-save"><input id="idle-preset-name" maxlength="24" placeholder="Nom du preset"><button data-preset-save><i class="fas fa-floppy-disk"></i></button></div>${(state.strategy?.presets||[]).map((p)=>`<button data-preset-load="${escapeHtml(p.name)}"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.formation)}</small><i class="fas fa-play"></i></button>`).join('')}`;
}

const IDLE_ITEM_META={weapon:{label:'Arme',icon:'fa-khanda'},relic:{label:'Relique',icon:'fa-gem'},accessory:{label:'Accessoire',icon:'fa-ring'}};
const IDLE_RARITY_ORDER={rare:1,epic:2,legendary:3,mythic:4};
const IDLE_WORLD_SKINS=[
  ['konoha','#e34b35','#f4b942'],['namek','#29a66f','#d7ea54'],['marineford','#2676c7','#e8eef7'],['château','#7d3fc0','#e85178'],['shiganshina','#9a643a','#d7bd84'],
  ['hueco','#d9e1ea','#5c77a8'],['u.a.','#1685d8','#f1c932'],['shibuya','#d81f50','#8642c7'],['aincrad','#3d91c8','#d2efff'],['néant','#7041aa','#e44478'],['dojo','#b52a35','#e6b34c']
];
function idleItemPalette(item){const world=String(item?.sourceWorld||'dojo').toLowerCase();const skin=IDLE_WORLD_SKINS.find(([key])=>world.includes(key))||IDLE_WORLD_SKINS.at(-1);return {primary:skin[1],accent:skin[2]};}
function idleItemArt(item,size='card'){
  const {primary,accent}=idleItemPalette(item);const rare={rare:'#69a8df',epic:'#b269ef',legendary:'#f2b632',mythic:'#ef526c'}[item?.rarity]||'#69a8df';
  const base=`<circle cx="32" cy="32" r="29" fill="#111722" stroke="${rare}" stroke-width="2"/><path d="M10 44 32 8l22 36-22 12z" fill="${primary}" opacity=".28"/><circle cx="49" cy="15" r="3" fill="${accent}"/>`;
  const shapes={
    weapon:`<path d="m17 47 6-1 24-27-3-3-27 24z" fill="${accent}" stroke="#f4f7fb" stroke-width="1.6"/><path d="m17 47-5 5 5-1 4-4z" fill="${primary}"/><path d="m19 39 7 7" stroke="${rare}" stroke-width="4" stroke-linecap="round"/>`,
    relic:`<path d="m32 12 13 10-5 25-8 7-9-7-5-25z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m32 12 2 31-11 4 9 7 8-7 5-25z" fill="${accent}" opacity=".72"/><path d="m18 22 14 7 13-7" fill="none" stroke="#f4f7fb" stroke-width="1.3"/>`,
    accessory:`<circle cx="32" cy="31" r="14" fill="none" stroke="${accent}" stroke-width="6"/><circle cx="32" cy="31" r="6" fill="${primary}" stroke="#f4f7fb" stroke-width="1.5"/><path d="m27 46-4 9m14-9 4 9" stroke="${rare}" stroke-width="3" stroke-linecap="round"/>`
  };
  return `<span class="idle-item-art ${size} r-${escapeHtml(item?.rarity||'rare')}" aria-hidden="true"><svg viewBox="0 0 64 64" role="img">${base}${shapes[item?.kind]||shapes.weapon}</svg></span>`;
}
function idleItemEffect(item){if(item.effectKey==='salvage')return `+${Math.round(item.effectValue*100)}% d’Essence au recyclage`;return `+${Math.round(item.effectValue*100)}% DPS supplémentaire`;}
function idleEquippedFor(slotIndex,kind){return idleState?.inventory?.items?.find((x)=>x.equippedSlotIndex===slotIndex&&x.kind===kind)||null;}
function idleItemComparison(item,slotIndex){const current=idleEquippedFor(slotIndex,item.kind);const before=current?.effectiveBonus||0;const after=item.effectiveBonus||item.bonus;const diff=after-before;return `<span class="idle-item-comparison ${diff>=0?'better':'worse'}"><small>${current?escapeHtml(current.name):'Emplacement vide'}</small><b>${Math.round(before*100)}% <i class="fas fa-arrow-right"></i> ${Math.round(after*100)}%</b><em>${diff>=0?'+':''}${Math.round(diff*100)}% DPS</em></span>`;}
function renderIdleInventory(state){
  const inventory=state.inventory;const grid=document.getElementById('idle-inventory-grid');if(!inventory||!grid)return;
  const capacity=document.getElementById('idle-inventory-capacity');if(capacity)capacity.textContent=`${inventory.count} / ${inventory.capacity}`;
  const summary=document.getElementById('idle-item-collection-stats');if(summary){const s=inventory.summary||{};summary.innerHTML=`<span><i class="fas fa-earth-europe"></i><b>${s.worlds||0}</b><small>Mondes pillés</small></span><span><i class="fas fa-wand-sparkles"></i><b>${s.effects||0}</b><small>Effets trouvés</small></span><span><i class="fas fa-layer-group"></i><b>${s.completeFamilies||0}</b><small>Panoplies réunies</small></span><span><i class="fas fa-user-shield"></i><b>${s.equipped||0}</b><small>Pièces équipées</small></span>`;}
  const families=document.getElementById('idle-item-families');if(families)families.innerHTML=(inventory.families||[]).map((family)=>`<span class="${family.complete?'complete':''}"><b>${escapeHtml(family.world)}</b><em>${['weapon','relic','accessory'].map((kind)=>`<i class="fas ${IDLE_ITEM_META[kind].icon} ${family.kinds.includes(kind)?'found':''}"></i>`).join('')}</em>${family.complete?'<small>+10%</small>':''}</span>`).join('');
  const active=(state.slots||[]).filter((s)=>s.character);
  const loadouts=document.getElementById('idle-loadouts');if(loadouts)loadouts.innerHTML=active.length?active.map((slot)=>{const equipped=inventory.items.filter((x)=>x.equippedSlotIndex===slot.index);const complete=new Set(equipped.map((x)=>x.kind)).size===3&&new Set(equipped.map((x)=>x.sourceWorld)).size===1;return `<article class="idle-loadout ${complete?'complete':''}"><img src="${escapeHtml(slot.character.imageUrl||'')}" alt=""><div><b>${escapeHtml(slot.character.name)}</b><small>Emplacement ${slot.index+1}${complete?` · Panoplie ${escapeHtml(equipped[0].sourceWorld)} +10%`:''}</small></div><span>${['weapon','relic','accessory'].map((kind)=>{const item=equipped.find((x)=>x.kind===kind);return item?`<span title="${escapeHtml(item.name)}">${idleItemArt(item,'mini')}</span>`:`<i class="fas ${IDLE_ITEM_META[kind].icon} empty" title="Vide"></i>`;}).join('')}</span></article>`;}).join(''):'<p class="hint">Assigne un personnage à ton équipe pour pouvoir l’équiper.</p>';
  let items=inventory.items.filter((x)=>idleItemFilter==='all'||x.kind===idleItemFilter);
  items=[...items].sort((a,b)=>idleItemSort==='recent'?new Date(b.obtainedAt)-new Date(a.obtainedAt):idleItemSort==='rarity'?(IDLE_RARITY_ORDER[b.rarity]-IDLE_RARITY_ORDER[a.rarity]):((b.effectiveBonus||b.bonus)-(a.effectiveBonus||a.bonus)));
  grid.innerHTML=items.length?items.map((item)=>{const meta=IDLE_ITEM_META[item.kind]||IDLE_ITEM_META.weapon;const equipped=item.equippedSlotIndex!==null;const defaultSlot=equipped?item.equippedSlotIndex:active[0]?.index;return `<article class="idle-item-card r-${item.rarity} ${equipped?'equipped':''}" data-item-id="${item.id}"><header>${idleItemArt(item)}<div><small>${escapeHtml(item.rarity)} · ${meta.label} · ${escapeHtml(item.sourceWorld)}</small><b>${escapeHtml(item.name)}</b></div><button data-item-lock="${item.id}" title="${item.locked?'Déverrouiller':'Verrouiller'}"><i class="fas ${item.locked?'fa-lock':'fa-lock-open'}"></i></button></header><div class="idle-item-stats"><span><small>PUISSANCE</small><b>+${Math.round(item.bonus*100)}%</b></span><span><small>${escapeHtml(item.effectLabel)}</small><b>${escapeHtml(idleItemEffect(item))}</b><em>${escapeHtml(item.effectDescription||'')}</em></span></div>${equipped?`<p class="idle-item-equipped"><i class="fas fa-user-shield"></i> Équipé sur <b>${escapeHtml(item.equippedCharacter||`héros ${item.equippedSlotIndex+1}`)}</b></p>`:active.length?`<label class="idle-item-target">Comparer avec <select data-item-target>${active.map((slot)=>`<option value="${slot.index}" ${slot.index===defaultSlot?'selected':''}>${escapeHtml(slot.character.name)}</option>`).join('')}</select></label><div data-item-comparison>${idleItemComparison(item,defaultSlot)}</div>`:'<p class="idle-item-equipped">Aucun héros actif</p>'}<footer>${equipped?`<button class="btn-secondary" data-item-unequip="${item.id}"><i class="fas fa-arrow-right-from-bracket"></i> Retirer</button>`:active.length?`<button class="btn-primary" data-item-equip="${item.id}"><i class="fas fa-shield-halved"></i> Équiper</button>`:''}<button class="btn-secondary danger" data-item-salvage="${item.id}" ${item.locked||equipped?'disabled':''}><i class="fas fa-recycle"></i> ${idleFormatNumber(item.salvageValue)}</button></footer></article>`;}).join(''):'<div class="idle-inventory-empty"><i class="fas fa-box-open"></i><b>Aucun objet dans cette catégorie</b><span>Vaincs un gardien puis ouvre son coffre pour obtenir une pièce.</span></div>';
}
async function equipIdleItem(itemId,slotIndex){try{renderIdleState(await api('/api/idle/equipment/equip',{method:'POST',body:JSON.stringify({itemId,slotIndex})}));idleSpawnFloat('ÉQUIPEMENT MODIFIÉ','xp');}catch(e){alert(e.message);}}
async function unequipIdleItem(itemId){try{renderIdleState(await api('/api/idle/equipment/unequip',{method:'POST',body:JSON.stringify({itemId})}));}catch(e){alert(e.message);}}
async function lockIdleItem(itemId,locked){try{await api('/api/idle/equipment/lock',{method:'POST',body:JSON.stringify({itemId,locked})});const item=idleState.inventory.items.find((x)=>x.id===itemId);if(item)item.locked=locked;renderIdleInventory(idleState);}catch(e){alert(e.message);}}
async function salvageIdleItem(itemId){const item=idleState?.inventory?.items?.find((x)=>x.id===itemId);if(!item||!confirm(`Recycler ${item.name} contre ${idleFormatNumber(item.salvageValue)} Essence ?`))return;try{const r=await api('/api/idle/equipment/salvage',{method:'POST',body:JSON.stringify({itemId})});renderIdleState(r.state);idleSpawnFloat(`RECYCLAGE +${idleFormatNumber(r.gained)}`,'xp');}catch(e){alert(e.message);}}

function renderIdleChallenges(items){const box=document.getElementById('idle-challenges');if(!box)return;box.innerHTML=items.map((c)=>`<article class="idle-challenge ${c.completed?'done':''}"><header><i class="fas ${c.icon}"></i><div><span>${escapeHtml(c.cadence)} · ${escapeHtml(c.difficulty)}</span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.description)}</small></div><strong>${c.progress}%</strong></header><div class="idle-challenge-requirements">${(c.requirements||[]).map((r)=>`<span class="${r.progress>=r.target?'done':''}"><i class="fas ${r.progress>=r.target?'fa-check':'fa-circle'}"></i><b>${escapeHtml(r.label)}</b><em>${idleFormatNumber(Math.min(r.progress,r.target))}/${idleFormatNumber(r.target)}</em></span>`).join('')}</div><div class="idle-challenge-footer"><em style="--progress:${Math.min(100,c.progress)}%"></em><button data-challenge-claim="${c.key}" ${!c.completed||c.claimed?'disabled':''}>${c.claimed?'<i class="fas fa-check"></i> Réclamé':`Réclamer +${c.reward} <i class="fas fa-ticket"></i>`}</button></div></article>`).join('');}

function renderIdleMasteries(codex) {
  const masteries = document.getElementById('idle-masteries');
  if (masteries) masteries.innerHTML = (codex?.masteries || []).length ? codex.masteries.map((m) => `<div class="idle-mastery"><i class="fas fa-star"></i><div><b>${escapeHtml(m.series)}</b><span>${m.recruits} recrue(s) · ${idleFormatNumber(m.levels)} niveaux cumulés</span><em style="--progress:${m.next ? Math.min(100,m.levels/m.next*100) : 100}%"></em></div><strong>+${Math.round(m.bonus*100)}%</strong><small>${m.next ? `Prochain bonus niv. ${m.next}` : 'MAÎTRISE MAX'}</small></div>`).join('') : '<p class="hint">Recrute puis entraîne des héros pour découvrir leurs licences.</p>';
}

// Frise des paliers de décor (Progression) — équivalent simplifié d'une
// carte du monde : notre progression est une séquence linéaire de paliers
// (dojo.tiers, liste statique envoyée par le serveur), pas un graphe de
// zones à embranchements.
function renderIdleRoadmap(codex,battle) {
  const box = document.getElementById('idle-roadmap');
  if (!box || !Array.isArray(codex?.worlds)) return;
  const currentIndex=Math.max(0,(battle?.world?.index||1)-1);
  box.innerHTML = codex.worlds.map((tier, i) => {
    const isCurrent = i === currentIndex;
    const isDone = currentIndex >= 0 && i < currentIndex;
    const cls = isCurrent ? 'current' : (isDone ? 'done' : '');
    const dotContent = isCurrent ? '<i class="fas fa-fire"></i>' : (isDone ? '<i class="fas fa-check"></i>' : idleFormatNumber(tier.level));
    return `<div class="idle-roadmap-step ${cls}">
      <span class="idle-roadmap-dot">${dotContent}</span>
      <span class="idle-roadmap-name">${escapeHtml(tier.name.split(' · ')[0])}</span>
      <span class="idle-roadmap-level">Vague ${idleFormatNumber(tier.level)}</span>
    </div>`;
  }).join('');
  // Centre uniquement le défilement HORIZONTAL de la frise. scrollIntoView()
  // déplaçait aussi la page entière vers le bas après chaque achat/rendu.
  const current = box.querySelector('.idle-roadmap-step.current');
  if (current && box.dataset.centeredWorld !== String(currentIndex)) {
    box.scrollLeft = Math.max(0, current.offsetLeft - (box.clientWidth - current.clientWidth) / 2);
    box.dataset.centeredWorld = String(currentIndex);
  }
}

// Le joueur est le héros actif : son apparence vient du profil (avatar + cadre),
// sa puissance vient de Concentration. Les recrues restent une équipe passive.
function renderIdleMainHero(state) {
  const hero = document.getElementById('idle-main-hero');
  if (hero) { hero.className = `idle-main-hero aura-${state.heroStyle?.aura || 'none'} stance-${state.heroStyle?.stance || 'balanced'} hair-${state.heroStyle?.hair || 'short'} outfit-${state.heroStyle?.outfit || 'dojo'} energy-${state.heroStyle?.color || 'red'}`; }
  const avatar = document.getElementById('idle-main-hero-avatar');
  const leader = (state.slots || []).find((slot)=>slot.character)?.character;
  if (avatar) {
    avatar.className='idle-main-hero-avatar';
    avatar.innerHTML=leader?.imageUrl?'':`<i class="fas ${state.heroClass?.icon || 'fa-shield-halved'}"></i>`;
    avatar.style.backgroundImage=leader?.imageUrl?`url('${leader.imageUrl}')`:'none';
  }
  const name = document.getElementById('idle-main-hero-name');
  if (name) name.textContent = leader?.name || currentUser?.displayName || 'Héros AMQ';
  const power = document.getElementById('idle-main-hero-power');
  const titleChoice = state.heroStyle?.choices?.titles?.find((x)=>x.selected);
  if (power) power.innerHTML = `<i class="fas ${state.heroClass?.icon || 'fa-shield-halved'}"></i> ${escapeHtml(titleChoice?.name || 'Novice d’Ascension')} · ${escapeHtml(state.heroClass?.name || 'Guerrier')} · ${idleFormatNumber(state.click.damage ?? state.click.yield)} puissance`;
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
// continu, façon Clicker Heroes. Chaque vague contient plusieurs ennemis,
// chaque dixième est un boss, et les PV appartiennent à l'ennemi actuel. Le
// gardien affiché (portrait) reste lui lié au DÉCOR (dojo), cohérent : le
// visuel change par grand palier, le rythme de combat lui est indépendant.
function renderIdleBattle(battle, dojo, prevBattle) {
  const stage = Math.max(1, battle?.stage || 1);
  const wave = ((stage - 1) % 10) + 1;
  const zone = Math.floor((stage - 1) / 10) + 1;
  const boss = wave === 10;
  const enemiesRequired = Math.max(1, battle?.enemiesRequired || 1);
  const enemiesRemaining = Math.max(1, battle?.enemiesRemaining || enemiesRequired);
  const enemyNumber = Math.max(1, Math.min(enemiesRequired, battle?.enemyNumber || 1));
  const mechanicEl = document.getElementById('idle-boss-mechanic');
  if (mechanicEl) { const mechanic=battle?.mechanic;mechanicEl.classList.toggle('hidden', !boss); mechanicEl.innerHTML = boss&&mechanic ? `<i class="fas fa-shield-halved"></i> <b>${escapeHtml(mechanic.name)}</b> · ${escapeHtml(mechanic.description)}${mechanic.required?` <strong>${Math.min(mechanic.progress,mechanic.required)}/${mechanic.required}</strong>`:''}` : ''; }
  const remaining = Math.max(0, (battle?.xpForNextStage || 0) - (battle?.xpIntoStage || 0));
  const total = Math.max(1, battle?.xpForNextStage || 1);
  const guardianName = battle?.world?.enemyName || (boss ? `Boss de la zone ${zone}` : 'Gardien ennemi');
  const zoneEl = document.getElementById('idle-battle-zone');
  const tagEl = document.getElementById('idle-battle-tag');
  const titleEl = document.getElementById('idle-enemy-title');
  const hpEl = document.getElementById('idle-enemy-hp-text');
  const fill = document.getElementById('idle-xp-fill');
  const modifierEl=document.getElementById('idle-world-modifier');
  if(modifierEl){const modifier=battle?.world?.modifier;modifierEl.innerHTML=modifier?`<i class="fas fa-diamond"></i> <b>${escapeHtml(modifier.name)}</b>`:'';modifierEl.title=modifier?.description||'Règle spéciale appliquée dans ce monde';}
  const objective=document.getElementById('idle-next-objective');
  if(objective){objective.innerHTML=`<i class="fas ${boss?'fa-crown':'fa-forward-step'}"></i><span><b>${boss?'Vague 10/10 · Boss final':`Vague ${wave}/10 · ${enemiesRemaining} ennemi${enemiesRemaining>1?'s':''} restant${enemiesRemaining>1?'s':''}`}</b><small>${boss?'Vaincs-le pour passer au monde suivant':`Ennemi ${enemyNumber}/${enemiesRequired} · +${idleFormatNumber(battle?.reward||0)} Essence par victoire`}</small></span><strong>${boss?'Monde suivant':`Puis vague ${wave+1}`}</strong>`;}
  if (zoneEl) zoneEl.textContent = `ACTE ${battle?.world?.act||1} · MONDE ${battle?.world?.index||zone}/10 · ${boss ? `VAGUE 10/10 · BOSS · PHASE ${battle.phase||1}/2${battle.enraged?' · ENRAGÉ':''}` : `VAGUE ${wave}/10 · ENNEMI ${enemyNumber}/${enemiesRequired}`}`;
  if (tagEl) { tagEl.textContent = battle?.bossFailed ? 'MUR · FARM AUTO' : boss ? 'BOSS' : battle?.isElite?'ÉLITE':'ENNEMI'; tagEl.classList.toggle('boss', boss); }
  if (titleEl) titleEl.textContent = guardianName;
  if (hpEl) hpEl.textContent = `${idleFormatNumber(remaining)} / ${idleFormatNumber(total)} PV${idleEtaSuffix(remaining)}`;
  idleAnimateEnemyHp(fill,remaining,total,stage);
  // Le stage a avancé depuis le dernier rendu (au moins un kill) : retour
  // léger et fréquent, distinct de la célébration (confettis) réservée aux
  // vrais niveaux de Dojo.
  if (prevBattle && (battle?.kills || 0) > (prevBattle?.kills || 0)) {
    idleKillBurst((battle?.kills || 0) - (prevBattle?.kills || 0));
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
    idleBurstReadyAt = result.readyAt ? new Date(result.readyAt).getTime() : Date.now() + result.cooldownMs;
    const scene = document.getElementById('idle-scene');
    scene?.classList.add('skill-burst'); setTimeout(() => scene?.classList.remove('skill-burst'), 600);
    idleSpawnFloat(`ULTIME −${idleFormatNumber(result.gained)}`, 'damage crit huge');
    idleCombatMotion('hero');
    await refreshIdleState();
  } catch (e) { if (!String(e.message).includes('Trop')) alert(e.message); }
  idleRenderSkillCooldown();
}

async function idleUseTeamSkill(event) {
  event?.stopPropagation(); if (Date.now() < idleTeamSkillReadyAt) return;
  try { const r = await api('/api/idle/skill/team', { method: 'POST', body: JSON.stringify({}) }); idleTeamSkillReadyAt = r.readyAt ? new Date(r.readyAt).getTime() : Date.now() + r.cooldownMs; idleSpawnFloat(`COMBO −${idleFormatNumber(r.gained)}`, 'damage crit huge'); idleCombatMotion('team'); await refreshIdleState(); }
  catch (e) { if (!String(e.message).includes('Trop')) alert(e.message); }
  idleRenderSkillCooldown();
}

function renderIdleBossChest(chest) {
  const btn = document.getElementById('idle-boss-chest'); if (!btn) return;
  btn.classList.toggle('hidden', !chest?.available);
  const label = document.getElementById('idle-boss-chest-label');
  if (label && chest) label.textContent = `Coffre ${chest.tier} · objet ${chest.lootRarity||'rare'} · +${idleFormatNumber(chest.reward+(chest.bonusEssence||0))} Essence · +${chest.sealReward||1} Sceau`;
}
function renderIdleBattleSpeed(speed){const box=document.getElementById('idle-speed-buttons');const view=document.getElementById('view-idle');if(!box||!speed)return;view?.style.setProperty('--battle-speed',speed.current);box.innerHTML=speed.choices.map((x)=>`<button data-battle-speed="${x.value}" class="${x.value===speed.current?'active':''}" ${x.unlocked?'':'disabled'}>×${x.value}${x.unlocked?'':` · niv.${x.level}`}</button>`).join('');}
function renderIdleBattleMode(mode){document.querySelectorAll('[data-battle-mode]').forEach((b)=>b.classList.toggle('active',b.dataset.battleMode===mode));}
function renderIdleAutoSkills(auto){const btn=document.getElementById('idle-auto-skills');const label=document.getElementById('idle-auto-skills-label');if(!btn||!auto)return;btn.disabled=!auto.unlocked;btn.classList.toggle('active',auto.enabled);btn.dataset.enabled=auto.enabled?'1':'0';btn.querySelector(':scope > i:last-child').className=`fas ${auto.enabled?'fa-toggle-on':'fa-toggle-off'}`;label.textContent=!auto.unlocked?`Débloquées au niveau ${auto.level}`:auto.enabled?`Simulation active · rendement moyen +${Math.round(auto.bonus*100)}%`:'Simulation inactive · cliquer pour activer';}
async function toggleIdleAutoSkills(){const btn=document.getElementById('idle-auto-skills');if(btn?.disabled)return;try{const state=await api('/api/idle/auto-skills',{method:'POST',body:JSON.stringify({enabled:btn.dataset.enabled!=='1'})});renderIdleState(state);}catch(e){alert(e.message);}}
async function chooseIdleBattleMode(mode){try{const state=await api('/api/idle/battle-mode',{method:'POST',body:JSON.stringify({mode})});renderIdleState(state);}catch(e){alert(e.message);}}
async function chooseIdleBattleSpeed(speed){try{const state=await api('/api/idle/battle-speed',{method:'POST',body:JSON.stringify({speed})});renderIdleState(state);}catch(e){alert(e.message);}}
async function chooseIdleFormation(formation){try{renderIdleState(await api('/api/idle/formation',{method:'POST',body:JSON.stringify({formation})}));}catch(e){alert(e.message);}}
async function saveIdlePreset(){const name=document.getElementById('idle-preset-name')?.value.trim();if(!name)return;try{renderIdleState(await api('/api/idle/team-preset/save',{method:'POST',body:JSON.stringify({name})}));idleAddCombatLog(`Preset ${name} sauvegardé`,'fa-floppy-disk');}catch(e){alert(e.message);}}
async function loadIdlePreset(name){try{renderIdleState(await api('/api/idle/team-preset/load',{method:'POST',body:JSON.stringify({name})}));idleAddCombatLog(`Preset ${name} chargé`,'fa-users-gear');}catch(e){alert(e.message);}}
async function chooseIdlePrestigePath(path){try{renderIdleState(await api('/api/idle/prestige-path',{method:'POST',body:JSON.stringify({path})}));}catch(e){alert(e.message);}}
async function claimIdleChallenge(key){try{const r=await api('/api/idle/challenge/claim',{method:'POST',body:JSON.stringify({key})});idleSpawnFloat(`DÉFI +${r.reward} SCEAUX`,'crit');renderIdleState(r.state);}catch(e){alert(e.message);}}
async function loadIdleTelemetry(){const box=document.getElementById('idle-telemetry-summary');if(!box)return;box.innerHTML='<p class="hint">Chargement…</p>';try{const data=await api('/api/idle/telemetry/beta');box.innerHTML=`<div class="idle-telemetry-head"><b>${data.betaPlayers} testeurs</b><small>${data.windowDays} derniers jours</small></div>${data.events.map((e)=>`<span><b>${escapeHtml(e.event)}</b><strong>${e.count}</strong><small>${e.averageStage?`Stage moyen ${Math.round(e.averageStage)}`:''}</small></span>`).join('')}`;}catch(e){box.innerHTML=`<p class="hint">${escapeHtml(e.message)}</p>`;}}
async function sendIdleFeedback(event){event.preventDefault();const input=document.getElementById('idle-feedback-text');const status=document.getElementById('idle-feedback-status');const message=input?.value.trim()||'';if(message.length<10)return;const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;status.textContent='Envoi…';try{await api('/api/idle/feedback',{method:'POST',body:JSON.stringify({message,context:JSON.stringify({stage:idleState?.battle?.stage||null,world:idleState?.dojo?.decor?.theme||null,version:'v33'})})});input.value='';status.textContent='Merci, ton retour a bien été transmis.';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}}

function openIdleClassPicker() {
  const box = document.getElementById('idle-class-grid'); if (!box || !idleState?.heroClass) return;
  const classWait=Math.max(0,new Date(idleState.heroClass.changeReadyAt||0)-Date.now());
  box.innerHTML = idleState.heroClass.choices.map((c) => `<button class="idle-class-choice ${c.key === idleState.heroClass.key ? 'active' : ''}" data-hero-class="${c.key}" ${classWait&&c.key!==idleState.heroClass.key?'disabled':''}><i class="fas ${c.icon}"></i><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.description)}</span>${c.key === idleState.heroClass.key ? '<small>CLASSE ACTIVE</small>' : classWait?`<small>Disponible dans ${Math.ceil(classWait/60000)} min</small>`:''}</button>`).join('');
  const specBox=document.getElementById('idle-spec-grid'); if(specBox) specBox.innerHTML=idleState.heroSpecialization.choices.map((s)=>`<button class="idle-style-choice ${s.selected?'active':''}" data-hero-spec="${s.key}" ${idleState.heroSpecialization.unlocked?'':'disabled'}><i class="fas ${idleState.heroSpecialization.unlocked?'fa-code-branch':'fa-lock'}"></i><b>${escapeHtml(s.name)}</b><small>${idleState.heroSpecialization.unlocked?escapeHtml(s.description):'Niveau 25 requis'}</small></button>`).join('');
  renderIdleStyleChoices('hairs','idle-hair-grid','fa-scissors'); renderIdleStyleChoices('outfits','idle-outfit-grid','fa-shirt'); renderIdleStyleChoices('colors','idle-color-grid','fa-palette'); renderIdleStyleChoices('auras','idle-aura-grid','fa-fire'); renderIdleStyleChoices('stances','idle-stance-grid','fa-person-running'); renderIdleStyleChoices('titles','idle-title-grid','fa-crown');
  document.getElementById('idle-class-picker').classList.remove('hidden');
}
function renderIdleStyleChoices(type, id, icon) { const box=document.getElementById(id); if(!box)return; box.innerHTML=(idleState.heroStyle?.choices?.[type]||[]).map((x)=>`<button class="idle-style-choice ${x.selected?'active':''}" data-style-type="${type}" data-style-key="${x.key}" ${x.unlocked?'':'disabled'}><i class="fas ${x.unlocked?icon:'fa-lock'}"></i><b>${escapeHtml(x.name)}</b><small>${x.unlocked?(x.selected?'ÉQUIPÉ':'Disponible'):`Niveau ${x.level}`}</small></button>`).join(''); }
async function chooseIdleHeroClass(key) {
  try { const state = await api('/api/idle/hero-class', { method: 'POST', body: JSON.stringify({ key }) }); document.getElementById('idle-class-picker').classList.add('hidden'); renderIdleState(state); }
  catch (e) { alert(e.message); }
}
async function chooseIdleHeroStyle(type,key) { try { const state=await api('/api/idle/hero-style',{method:'POST',body:JSON.stringify({type,key})}); idleState=state; openIdleClassPicker(); renderIdleState(state); } catch(e){alert(e.message);} }
async function chooseIdleHeroSpec(key) { try { const state=await api('/api/idle/hero-specialization',{method:'POST',body:JSON.stringify({key})}); idleState=state; openIdleClassPicker(); renderIdleState(state); } catch(e){alert(e.message);} }

async function claimIdleBossChest() {
  try { const r = await api('/api/idle/boss-chest', { method: 'POST', body: JSON.stringify({}) }); idleSpawnFloat(`COFFRE +${idleFormatNumber(r.reward)}`, 'crit'); showIdleBossReward(r); if (typeof burstConfetti === 'function') burstConfetti(55); await refreshIdleState(); }
  catch (e) { alert(e.message); }
}

function showIdleBossReward(reward) {
  const modal=document.getElementById('idle-boss-reveal');const body=document.getElementById('idle-boss-reveal-body');if(!modal||!body)return;
  const names = { weapon: 'Arme', relic: 'Relique', accessory: 'Accessoire' };
  const loot=reward.loot;
  body.innerHTML=`<div class="idle-boss-reward-main"><i class="fas fa-trophy"></i><span><small>COFFRE ${reward.tier}</small><b>Butin du gardien</b></span></div><div class="idle-boss-reward-grid"><span><i class="fas fa-bolt"></i><b>+${idleFormatNumber(reward.reward)}</b><small>Essence</small></span><span><i class="fas fa-ticket"></i><b>+${reward.seals}</b><small>Sceau${reward.seals>1?'x':''}</small></span></div>${loot?`<div class="idle-boss-loot ${escapeHtml(loot.rarity)}">${idleItemArt(loot,'reveal')}<div><small>${escapeHtml(loot.rarity.toUpperCase())}</small><b>${escapeHtml(loot.name||names[loot.kind])}</b><span>${loot.stored?`Ajouté à l’inventaire · +${Math.round(loot.bonus*100)}%`:`Inventaire plein · converti en +${idleFormatNumber(loot.salvage||0)} Essence`}</span></div><em>${loot.stored?'NOUVEAU':'RECYCLÉ'}</em></div>${loot.stored?'<button class="btn-secondary idle-boss-open-items" data-open-equipment><i class="fas fa-shield-halved"></i> Voir et équiper l’objet</button>':''}`:''}`;
  modal.classList.remove('hidden');
}

function renderIdleRecruit(recruit) {
  const sealCostLabel = `${idleFormatNumber(recruit.nextCost)} Sceau${recruit.nextCost > 1 ? 'x' : ''} · ${idleFormatNumber(recruit.balance)} dispo.`;
  const essenceCostLabel = `${idleFormatNumber(recruit.essenceCost)} Essence · ${idleFormatNumber(recruit.essenceBalance)} dispo.`;
  const sealAffordable = recruit.balance >= recruit.nextCost;
  const essenceAffordable = recruit.essenceBalance >= recruit.essenceCost;
  for (const id of ['idle-top-recruit-cost', 'idle-recruit-cost']) {
    const el = document.getElementById(id);
    if (el) el.textContent = sealCostLabel;
  }
  for (const id of ['idle-top-recruit-btn', 'idle-recruit-btn']) {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = !sealAffordable; btn.title = `Invoquer avec des Sceaux · Épique garanti dans ${recruit.guaranteedEpicIn||10} invocation(s)`; }
  }
  for (const id of ['idle-top-recruit-essence-cost', 'idle-recruit-essence-cost']) {
    const el = document.getElementById(id);
    if (el) el.textContent = essenceCostLabel;
  }
  for (const id of ['idle-top-recruit-essence-btn', 'idle-recruit-essence-btn']) {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = !essenceAffordable; btn.title = `Invoquer avec de l’Essence · prochain coût ${idleFormatNumber(recruit.essenceCostAfter)} Essence`; }
  }
  const economy=document.getElementById('idle-recruit-economy');if(economy)economy.innerHTML=`<i class="fas fa-ticket"></i> <b>1 Sceau = 1 invocation</b> · <i class="fas fa-bolt"></i> <b>${idleFormatNumber(recruit.essenceBalance)} Essence</b> · Épique garanti dans ${recruit.guaranteedEpicIn||10}`;
}

function idleRewardLabel(item){return `+${idleFormatNumber(item.reward)} ${item.rewardCurrency==='seals'?'<i class="fas fa-ticket"></i>':'<i class="fas fa-mortar-pestle"></i>'}`;}
function renderIdleMissions(missions,rank) {
  const box = document.getElementById('idle-missions'); if (!box) return;
  box.innerHTML = missions.map((m) => `<div class="idle-mission ${m.completed ? 'done' : ''}"><span class="idle-mission-icon"><i class="fas ${m.cadence === 'Quotidienne' ? 'fa-sun' : 'fa-calendar-week'}"></i></span><div><small>${m.cadence}</small><b>${escapeHtml(m.title)}</b><span>${escapeHtml(m.description)} · ${idleFormatNumber(m.progress)} / ${idleFormatNumber(m.target)}</span><em style="--progress:${Math.min(100, m.progress / m.target * 100)}%"></em></div><button class="btn-secondary" data-idle-mission="${m.key}" ${!m.completed || m.claimed ? 'disabled' : ''}>${m.claimed ? 'Réclamée' : idleRewardLabel(m)}</button></div>`).join('');
  renderIdleCombatQuests(missions,rank);
}

function renderIdleCombatQuests(missions,rank) {
  const box = document.getElementById('idle-combat-quests'); if (!box) return;
  const active = missions.filter((m) => !m.claimed).sort((a, b) => Number(b.completed) - Number(a.completed)).slice(0, 2);
  const missionCards = active.map((m) => {
    const progress = Math.min(100, m.progress / Math.max(1, m.target) * 100);
    return `<article class="idle-combat-quest ${m.completed ? 'ready' : ''}"><i class="fas ${m.completed ? 'fa-gift' : m.cadence === 'Quotidienne' ? 'fa-sun' : 'fa-calendar-week'}"></i><div><b>${escapeHtml(m.title)}</b><span>${idleFormatNumber(m.progress)}/${idleFormatNumber(m.target)}</span><em style="--progress:${progress}%"></em></div>${m.completed ? `<button data-idle-mini-mission="${m.key}">Réclamer</button>` : ''}</article>`;
  }).join('');
  const nextObjective=rank?.quests?.find((quest)=>!quest.completed)||rank?.quests?.at(-1);
  const objectiveProgress=nextObjective?Math.min(100,nextObjective.progress/Math.max(1,nextObjective.target)*100):100;
  const levelCard=rank?`<article class="idle-combat-quest ${rank.ready?'ready':''}"><i class="fas ${rank.ready?'fa-arrow-up':'fa-bullseye'}"></i><div><b>${rank.ready?`Niveau ${idleFormatNumber(rank.nextLevel)} prêt`:escapeHtml(nextObjective?.name||'Objectifs du niveau')}</b><span>${rank.ready?`+${Math.round((rank.powerReward||.01)*100)}% DPS permanent · +${idleFormatNumber(rank.sealReward)} Sceau${rank.sealReward>1?'x':''}`:`${idleFormatNumber(nextObjective?.progress||0)}/${idleFormatNumber(nextObjective?.target||0)} · niveau ${idleFormatNumber(rank.nextLevel)}`}</span><em style="--progress:${rank.ready?100:objectiveProgress}%"></em></div><button ${rank.ready?'data-idle-rank-advance':'data-idle-open-levels'}>${rank.ready?'Valider':'Voir'}</button></article>`:'';
  const cards=levelCard+missionCards||'<p><i class="fas fa-circle-check"></i> Tous les objectifs disponibles sont terminés.</p>';
  box.innerHTML = `<header><span><i class="fas fa-list-check"></i><b>Niveau et quêtes</b></span><button data-idle-open-levels>Niveau ${idleFormatNumber(rank?.level||1)} <i class="fas fa-arrow-right"></i></button></header><div>${cards}</div>`;
}

function renderIdleEvent(event) {
  const box = document.getElementById('idle-event-banner'); if (!box || !event) return;
  const w = event.weekly;
  box.innerHTML = `<div class="idle-event-today"><i class="fas ${event.icon}"></i><div><small>ÉVÉNEMENT DU JOUR</small><b>${escapeHtml(event.name)}</b><span>${escapeHtml(event.description)}</span></div><time data-event-end="${event.endsAt}"></time></div><div class="idle-weekly"><i class="fas fa-trophy"></i><div><small>DÉFI HEBDOMADAIRE · OBJECTIF COMPOSÉ</small><b>${escapeHtml(w.title)}</b><span>${escapeHtml(w.description)}</span><div class="idle-weekly-requirements">${(w.requirements||[]).map((r)=>`<span class="${r.progress>=r.target?'done':''}"><i class="fas ${r.progress>=r.target?'fa-check':'fa-circle'}"></i>${escapeHtml(r.label)} <b>${idleFormatNumber(Math.min(r.progress,r.target))}/${idleFormatNumber(r.target)}</b></span>`).join('')}</div><em style="--progress:${w.progress/w.target*100}%"></em></div><button class="btn-secondary" id="idle-event-claim" ${!w.completed || w.claimed ? 'disabled' : ''}>${w.claimed ? 'Réclamé' : `+${w.reward} Sceaux${w.essence?` + ${idleFormatNumber(w.essence)} Essence`:''}`}</button></div>`;
  const time = box.querySelector('[data-event-end]'); if (time) { const left = Math.max(0, new Date(event.endsAt) - Date.now()); time.textContent = `${Math.floor(left/3600000)}h ${Math.floor(left%3600000/60000)}m`; }
  box.querySelector('#idle-event-claim')?.addEventListener('click', claimIdleEvent);
}
function renderIdleAchievements(items) {
  const box = document.getElementById('idle-achievements'); if (!box) return;
  box.innerHTML = items.map((a) => `<div class="idle-achievement ${a.completed ? 'completed' : ''}"><i class="fas ${a.icon}"></i><div><b>${escapeHtml(a.title)}</b><span>${escapeHtml(a.description)} · ${idleFormatNumber(a.progress)}/${idleFormatNumber(a.target)}</span><em style="--progress:${a.progress/a.target*100}%"></em></div><button class="btn-secondary" data-achievement="${a.key}" ${!a.completed || a.claimed ? 'disabled' : ''}>${a.claimed ? '<i class="fas fa-check"></i>' : idleRewardLabel(a)}</button></div>`).join('');
}
function renderIdleGuide(guide){if(!guide)return;const count=document.getElementById('idle-guide-count');if(count)count.textContent=`${guide.completed}/${guide.total}`;const text=document.getElementById('idle-guide-progress-text');if(text)text.textContent=`${guide.completed}/${guide.total} étapes`;const bar=document.getElementById('idle-guide-progress-bar');if(bar)bar.style.setProperty('--progress',`${guide.completed/guide.total*100}%`);const list=document.getElementById('idle-guide-list');if(list)list.innerHTML=guide.items.map((x,i)=>`<div class="idle-guide-step ${x.done?'done':x===guide.next?'current':''}"><span>${x.done?'<i class="fas fa-check"></i>':i+1}</span><div><b>${escapeHtml(x.title)}</b><small>${escapeHtml(x.description)}</small></div>${x.done?'':`<button class="btn-secondary" data-guide-tab="${x.tab}">Voir</button>`}</div>`).join('');}
function renderIdleSeason(season){const box=document.getElementById('idle-season-card');if(!box)return;box.classList.toggle('hidden',!season?.enabled);if(!season?.enabled)return;const left=Math.max(0,new Date(season.endsAt)-Date.now());const next=season.tiers.find((t)=>!t.completed);box.innerHTML=`<div class="idle-season-head"><i class="fas fa-crown"></i><div><small>PARCOURS MENSUEL · SAISON ${season.period}</small><b>${escapeHtml(season.name)}</b><span>Joue de plusieurs façons pour gagner de l’activité. Chaque source est plafonnée : aucune action ne suffit seule.</span><strong>${idleFormatNumber(season.level)}${next?` / ${idleFormatNumber(next.level)}`:''} activité · ${Math.ceil(left/86400000)} jour(s) restants</strong></div></div><div class="idle-season-breakdown">${(season.breakdown||[]).map((x)=>`<span><small>${escapeHtml(x.label)}</small><b>+${idleFormatNumber(x.score)}</b><em>${idleFormatNumber(x.value)}/${idleFormatNumber(x.cap)}</em></span>`).join('')}</div><div class="idle-season-track">${season.tiers.map((t)=>`<div class="idle-season-tier ${t.completed?'completed':''} ${t.claimed?'claimed':''}"><span>PALIER ${t.tier}<b>${idleFormatNumber(t.level)}</b></span><i class="fas ${t.claimed?'fa-check':t.completed?'fa-gift':'fa-lock'}"></i><button data-season-tier="${t.tier}" ${!t.completed||t.claimed?'disabled':''}>${t.claimed?'Réclamé':`+${idleFormatNumber(t.reward)} Sceau${t.reward>1?'x':''}${t.essence?` · ${idleFormatNumber(t.essence)} Essence`:''}`}</button></div>`).join('')}</div>`;}
async function claimIdleSeason(tier){try{const r=await api('/api/idle/season/claim',{method:'POST',body:JSON.stringify({tier})});idleSpawnFloat(`SAISON +${idleFormatNumber(r.reward)}`,'crit');await refreshIdleState();}catch(e){alert(e.message);}}
function openIdleGuide(){document.getElementById('idle-guide-modal')?.classList.remove('hidden');}
async function openIdleRanking(){const modal=document.getElementById('idle-ranking-modal');const list=document.getElementById('idle-ranking-list');modal?.classList.remove('hidden');if(list)list.innerHTML='<p class="hint">Chargement…</p>';try{const data=await api('/api/idle/leaderboard');if(list)list.innerHTML=data.players.map((p)=>`<div class="idle-ranking-row ${p.isMe?'me':''}"><strong>${p.rank<=3?['🥇','🥈','🥉'][p.rank-1]:p.rank}</strong><span class="idle-ranking-player"><span class="avatar" ${p.avatarUrl?`style="background-image:url('${escapeHtml(p.avatarUrl)}')"`:''}></span><span><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.className)}</small></span></span><b>${idleFormatNumber(p.stage)}</b><b>${idleFormatNumber(p.level)}</b><b>${p.prestige}</b></div>`).join('')||'<p class="hint">Aucun joueur classé.</p>';}catch(e){if(list)list.innerHTML=`<p class="hint">${escapeHtml(e.message)}</p>`;}}
async function claimIdleAchievement(key) { try { const r = await api('/api/idle/achievement/claim', { method: 'POST', body: JSON.stringify({ key }) }); idleSpawnFloat(`SUCCÈS +${idleFormatNumber(r.reward)}`, 'crit'); if (typeof burstConfetti === 'function') burstConfetti(25); await refreshIdleState(); } catch (e) { alert(e.message); } }
async function claimIdleEvent() { try { const r = await api('/api/idle/event/claim', { method: 'POST', body: JSON.stringify({}) }); idleSpawnFloat(`CONVERGENCE +${idleFormatNumber(r.reward)}`, 'crit'); await refreshIdleState(); } catch (e) { alert(e.message); } }

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

function renderIdleDecor(dojo, prevDojo,battle,prevBattle) {
  const world=battle?.world||dojo.decor;
  const view = document.getElementById('view-idle');
  if (view) view.dataset.decor = world.theme;
  // idleParticleTheme (pas l'attribut DOM, déjà présent par défaut dans le HTML
  // statique pour "wood") sert de source de vérité pour savoir si les effets
  // ambiants de CE thème ont déjà été générés une fois.
  if (idleParticleTheme !== world.theme) idleSpawnParticles(world.theme);
  // Le décor suit toujours le monde de combat, jamais l'ancien palier du Dojo.
  idleSetScenery(world.theme);
  document.getElementById('idle-decor-name').textContent = `${world.name} · Acte ${world.act||1}`;
  document.getElementById('idle-dojo-level').textContent = `Niveau ${idleFormatNumber(dojo.level)}`;
  document.getElementById('idle-decor-flavor').textContent = world.flavor || dojo.decor.flavor || '';
  idleRenderBackdrop(world.backgroundUrl||dojo.decor.backgroundUrl);
  idleRenderBoss(world.boss||dojo.decor.boss, world.theme, battle?.world?.wave||1, battle?.isBoss?'boss':battle?.isElite?'elite':'normal',battle?.world?.enemyName);
  // La barre #idle-xp-fill est la barre de PV du combat (cf. renderIdleBattle,
  // pilotée par le stage) — ici on ne fait QUE le texte de progression du Dojo.
  const next = document.getElementById('idle-decor-next');
  if (next) {
    const base = dojo.xpIntoLevel >= dojo.xpForNextLevel
      ? 'objectifs terminés · validation disponible dans Niveaux'
      : `${idleFormatNumber(dojo.xpIntoLevel)}/${idleFormatNumber(dojo.xpForNextLevel)} objectifs terminés · indépendant des vagues`;
    const text = dojo.nextDecor
      ? `NIVEAU JOUEUR ${idleFormatNumber(dojo.level)} · ${base} · décor suivant dans ${dojo.nextDecor.levelsRemaining} niv.`
      : `NIVEAU JOUEUR ${idleFormatNumber(dojo.level)} · ${base}`;
    // Icône dédiée : la barre de PV juste au-dessus est le combat (stage),
    // cette ligne est une mesure différente (niveau de Dojo/décor) — sans ce
    // repère visuel les deux se lisaient comme une seule et même barre.
    next.innerHTML = `<i class="fas fa-torii-gate idle-decor-next-ico"></i>${escapeHtml(text)}`;
  }
  // Le niveau du Dojo a grimpé depuis le dernier rendu : petite célébration
  // (pas au tout premier rendu de la session, sinon ça se déclenche à chaque ouverture).
  if (prevDojo && dojo.level > prevDojo.level) idleCelebrate();
  if(prevBattle?.world&&(prevBattle.world.index!==world.index||prevBattle.world.act!==world.act)){
    const scene=document.getElementById('idle-scene');scene?.classList.add('idle-world-arrival');setTimeout(()=>scene?.classList.remove('idle-world-arrival'),900);idleSpawnFloat(`NOUVEAU MONDE · ${world.name.split(' · ')[0]}`,'crit');
  }
}

function idleCelebrate() {
  if (typeof burstConfetti === 'function') burstConfetti(36);
  if (typeof sfx !== 'undefined' && sfx.levelup) sfx.levelup();
}

function renderIdleRank(rank) {
  const box = document.getElementById('idle-rank-quests');
  if (!box || !rank) return;
  document.getElementById('idle-rank-current').textContent = `Niv. ${idleFormatNumber(rank.level)}`;
  document.getElementById('idle-rank-next').textContent = `Niv. ${idleFormatNumber(rank.nextLevel)}`;
  const summary = document.getElementById('idle-rank-summary');
  if (summary) summary.textContent = rank.ready
    ? `Tout est terminé : valide le niveau ${idleFormatNumber(rank.nextLevel)}.`
    : `${rank.completed}/${rank.total} objectifs terminés`;
  box.innerHTML = (rank.quests || []).map((quest) => {
    const progress = Math.min(100, Math.round((quest.progress / Math.max(1, quest.target)) * 100));
    return `<article class="idle-rank-quest ${quest.completed ? 'done' : ''}">
      <span class="idle-rank-quest-icon"><i class="fas ${escapeHtml(quest.icon)}"></i></span>
      <div><small>${quest.completed ? 'TERMINÉE' : 'EN COURS'}</small><b>${escapeHtml(quest.name)}</b><span>${escapeHtml(quest.description)}</span><em style="--progress:${progress}%"></em></div>
      <strong>${idleFormatNumber(quest.progress)}/${idleFormatNumber(quest.target)}${quest.completed ? ' <i class="fas fa-check"></i>' : ''}</strong>
    </article>`;
  }).join('');
  const reward = document.getElementById('idle-rank-reward');
  if (reward) reward.innerHTML = `<i class="fas fa-ticket"></i> Récompense : +${idleFormatNumber(rank.sealReward)} Sceau${rank.sealReward > 1 ? 'x' : ''} · +${Math.round((rank.powerReward||.01)*100)}% DPS permanent`;
  const button = document.getElementById('idle-rank-advance');
  if (button) {
    button.disabled = !rank.ready;
    button.classList.toggle('ready', rank.ready);
    button.innerHTML = rank.ready
      ? `<i class="fas fa-arrow-up"></i> Passer niveau ${idleFormatNumber(rank.nextLevel)}`
      : '<i class="fas fa-lock"></i> Objectifs incomplets';
  }
}

async function advanceIdleRank() {
  const button = document.getElementById('idle-rank-advance');
  if (!idleState?.rank?.ready || button?.disabled) return;
  button.disabled = true;
  try {
    const result = await api('/api/idle/rank/advance', { method:'POST', body:JSON.stringify({}) });
    idleState = null;
    renderIdleState(result.state);
    idleCelebrate();
    idleSpawnFloat(`NIVEAU ${result.level} · +${result.seals} SCEAU${result.seals > 1 ? 'X' : ''}`, 'crit');
  } catch (e) {
    alert(e.message);
    await refreshIdleState();
  }
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
  idleSpawnFloat(count > 1 ? `×${count} ENNEMIS VAINCUS` : 'ENNEMI VAINCU !', 'kill');
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
  if(box.dataset.theme===theme)return;
  box.dataset.theme=theme;
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
function idleRenderBoss(boss, theme, wave=1, kind='normal', enemyName='Adversaire') {
  const el = document.getElementById('idle-decor-boss');
  if (!el) return;
  if (!boss && !['wood', 'garden', 'temple', 'gold', 'celestial', 'hueco', 'ua', 'shibuya', 'aincrad', 'void'].includes(theme)) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.dataset.variant=String((Math.max(1,wave)-1)%4);
  el.classList.toggle('is-elite',kind==='elite');
  el.classList.toggle('is-boss',kind==='boss');
  const enemyAtlases = Object.fromEntries(['wood','garden','temple','gold','celestial','hueco','ua','shibuya','aincrad','void'].map((key)=>[key,`/assets/idle/enemies/world-${key}-v1.webp`]));
  const atlas = enemyAtlases[theme];
  if (atlas) {
    const spriteIndex = kind === 'boss' ? 5 : kind === 'elite' ? 4 : (Math.max(1,wave)-1)%4;
    const x = [0,50,100,0,50,100][spriteIndex];
    const y = spriteIndex < 3 ? 0 : 100;
    el.classList.add('idle-scene-fighter');
    el.innerHTML = `<span class="idle-fighter-sprite idle-enemy-sprite" role="img" aria-label="${escapeHtml(enemyName)}" style="background-image:url('${atlas}');background-position:${x}% ${y}%"></span>
      <span class="idle-boss-name"><small>${kind==='boss'?'BOSS':kind==='elite'?'ÉLITE':'ENNEMI'}</small><b>${escapeHtml(enemyName)}</b></span>`;
    return;
  }
  el.classList.remove('idle-scene-fighter');
  // Portrait IA généré via la route admin (voir POST /api/admin/dojo/generate-boss-art)
  // si disponible, sinon repli sur le portrait AniList existant (comportement historique).
  const url = boss.generatedImageUrl || boss.imageUrl;
  const img = url ? ` style="background-image:url('${url}')"` : '';
  el.innerHTML = `<span class="idle-boss-portrait"${img}></span>
    <span class="idle-boss-name"><small>Gardien du lieu</small></span>`;
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
      ? `Prestige disponible : +${idleFormatNumber(dojo.prestige.reward)} Sagesse.`
      : `Atteins le stage ${dojo.prestige.minStage} pendant cette run (record : ${dojo.prestige.runBestStage}).`;
  }
  const paths=document.getElementById('idle-prestige-paths');if(paths)paths.innerHTML=(dojo.prestige.paths||[]).map((p)=>`<button data-prestige-path="${p.key}" class="${p.selected?'active':''}" ${dojo.prestige.level<1?'disabled':''}><i class="fas ${p.key==='fist'?'fa-hand-fist':p.key==='army'?'fa-users':p.key==='time'?'fa-clock':'fa-scale-balanced'}"></i><b>${escapeHtml(p.name)}</b><small>Équipe ×${p.prod.toFixed(2)} · Clic ×${p.click.toFixed(2)}</small></button>`).join('');
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
      <div class="idle-slot-state"><i class="fas fa-lock"></i><span><b>Emplacement ${slot.index + 1}</b><small>Débloque une place dans ton équipe</small></span></div>
      <button class="btn-secondary idle-unlock-btn" data-slot="${slot.index}"><span>Débloquer</span><strong>${idleFormatNumber(slot.unlockCost)} <i class="fas fa-mortar-pestle"></i></strong></button>
    </div>`;
  }
  if (!slot.character) {
    return `<button class="idle-hero idle-hero-empty" data-slot="${slot.index}" data-action="pick">
      <div class="idle-slot-state"><i class="fas fa-plus"></i><span><b>Emplacement ${slot.index + 1}</b><small>Aucun personnage assigné</small></span></div><strong>Choisir un personnage <i class="fas fa-chevron-right"></i></strong>
    </button>`;
  }
  const c = slot.character;
  const role=idleRoleFor(c);
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
      <span class="idle-hero-rate"><i class="fas ${role.icon}" style="color:${role.color}"></i> ${role.name} · +${idleFormatNumber(c.rate)}/s</span>
      ${c.ascension ? `<span class="idle-ascension-rank"><i class="fas fa-sun"></i> A${c.ascension} · ×${c.ascensionMultiplier}</span>` : ''}
    </div>
    <div class="idle-hero-stats"><span><small>Production de base</small><b>${idleFormatNumber(c.baseRate)}/s</b></span><span><small>Gain par niveau</small><b>+${Math.round(c.scaling * 100)}%</b></span></div>
    <div class="idle-hero-passive ${c.passiveUnlocked ? 'unlocked' : 'locked'}"><i class="fas ${c.passiveUnlocked ? 'fa-wand-sparkles' : 'fa-lock'}"></i><span><b>Passif</b><small>${escapeHtml(c.passive)}</small></span><em>${c.passiveUnlocked ? 'Actif' : 'Niv. 10'}</em></div>
    <div class="idle-character-talent"><i class="fas fa-fingerprint"></i><span><b>${escapeHtml(c.talent.name)}</b><small>${escapeHtml(c.talent.description)}</small></span></div>
    <div class="idle-character-talent combat"><i class="fas fa-bolt"></i><span><b>${escapeHtml(c.combatSkill?.name||'Technique')}</b><small>${escapeHtml(c.combatSkill?.description||'Compétence de combat')}</small></span></div>
    <div class="idle-hero-milestones">${c.milestones.map((m) => `<span class="${m.reached ? 'reached' : ''}" title="Palier niveau ${m.target}">${m.reached ? '<i class="fas fa-check"></i>' : ''}${m.target}</span>`).join('')}</div>
    <div class="idle-equipment">${c.equipments.map((e) => e.empty?`<span class="empty" title="Emplacement vide"><i class="fas ${e.kind==='weapon'?'fa-khanda':e.kind==='relic'?'fa-gem':'fa-ring'}"></i><small>Vide</small></span>`:`<button class="r-${e.rarity}" data-action="enhance-equipment" data-slot="${slot.index}" data-kind="${e.kind}" title="Améliorer · coût ${idleFormatNumber(e.enhanceCost)}"><i class="fas ${e.kind==='weapon'?'fa-khanda':e.kind==='relic'?'fa-gem':'fa-ring'}"></i><span><b>+${Math.round(e.bonus*100)}%</b><small>Niv. ${e.powerLevel} · ${idleFormatNumber(e.enhanceCost)}</small></span></button>`).join('')}</div>
    <div class="idle-level-buys">${[1,5,10,100,'max'].map((n) => {const cost=n==='max'?c.levelUpCost:c.levelCosts[n];return `<button class="idle-hero-levelup" data-slot="${slot.index}" data-amount="${n}" data-action="levelup" title="${n==='max'?'Acheter le maximum abordable':`Monter de ${n} niveaux · coût ${idleFormatNumber(cost)}`}"${idleState && idleState.essence < cost ? ' disabled' : ''}><b>${n==='max'?'MAX':`×${n}`}</b><small>${n==='max'?'budget':idleFormatNumber(cost)}</small></button>`;}).join('')}</div>
    ${c.canAscend ? `<button class="idle-ascend-btn" data-slot="${slot.index}" data-action="ascend" ${idleState && idleState.essence < c.ascensionCost ? 'disabled' : ''}><i class="fas fa-sun"></i> ASCENSION · ${idleFormatNumber(c.ascensionCost)}</button>` : c.ascension >= 5 ? '<span class="idle-ascend-max">ASCENSION MAXIMALE · ×32</span>' : `<span class="idle-ascend-hint"><i class="fas fa-lock"></i> Ascension au niveau 500 · prochain multiplicateur ×${c.ascensionMultiplier * 2}</span>`}
  </div>`;
}

function renderIdleSlots(slots) {
  const heroes=slots.filter((slot)=>!slot.locked&&slot.character);
  const compact=slots.filter((slot)=>slot.locked||!slot.character);
  return `${heroes.length?`<div class="idle-slot-grid idle-slot-heroes">${heroes.map(idleSlotHTML).join('')}</div>`:''}
    ${compact.length?`<section class="idle-slot-management"><h4><i class="fas fa-table-cells-large"></i> Gestion des emplacements <span>${slots.length-compact.filter((slot)=>slot.locked).length}/${slots.length} débloqués</span></h4><div class="idle-slot-grid idle-slot-compact">${compact.map(idleSlotHTML).join('')}</div></section>`:''}`;
}

function renderIdleUpgrades(state) {
  const nextSlotCost = state.slots.find((s) => s.locked)?.unlockCost ?? null;
  const items = [
    {
      type: 'prod', icon: 'fa-brain', title: 'Discipline', level: state.prod.level, maxed: state.prod.maxed, cost: state.prod.nextCost,
      desc: `Production totale ×${state.prod.multiplier.toFixed(2)} → ×${(state.prod.nextMultiplier??state.prod.multiplier).toFixed(2)}`,
    },
    {
      type: 'click', icon: 'fa-hand-fist', title: 'Concentration', level: state.click.level, maxed: state.click.maxed, cost: state.click.nextCost,
      desc: `Dégâts par clic : ${state.click.damage ?? state.click.yield} → ${state.click.nextDamage ?? state.click.damage ?? state.click.yield}`,
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
  if (idleSyncInFlight) return;
  idleSyncInFlight = true;
  const pending = idleState?.pendingEssence || 0;
  try {
    const state=await api('/api/idle/collect',{method:'POST',body:JSON.stringify({})});
    renderIdleState(state);
  } catch (e) {
    alert(e.message);
    return;
  } finally {
    idleSyncInFlight = false;
  }
  // Le nombre affiché inclut déjà le pending (cf. idleTick) : sans ce petit
  // retour, cliquer « Récolter » ne « faisait » visiblement rien.
  if (pending > 0) idleSpawnFloat(`+${idleFormatNumber(pending)}`, ['xp', idleFloatTier(pending)].filter(Boolean).join(' '));
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  const essenceEl = document.getElementById('idle-essence-val');
  if (essenceEl) idleBump(essenceEl);
}

async function clickIdle() {
  const now=Date.now();if(now<idleNextClickAt)return;idleNextClickAt=now+45;
  const predicted=idleState?.click?.damage||idleState?.click?.yield||1;
  idleClickFeedback(predicted);idleSpawnFloat(`−${idleFormatNumber(predicted)}`,['damage',idleFloatTier(predicted)].filter(Boolean).join(' '));
  idleClickPending=Math.min(10,idleClickPending+1);
  if(!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,160);
}

async function flushIdleClicks(){
  idleClickFlushTimer=null;if(idleClickSending||(!idleClickPending&&!idleClickRetryBatch))return;
  const batch=idleClickRetryBatch||{count:idleClickPending,requestId:(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9_-]/g,'')};if(!idleClickRetryBatch)idleClickPending=0;idleClickSending=true;let r;
  try{r=await api('/api/idle/click',{method:'POST',body:JSON.stringify(batch)});idleClickRetryBatch=null;}
  catch{idleClickRetryBatch=batch;}
  finally{idleClickSending=false;}
  if(!r){if((idleClickPending||idleClickRetryBatch)&&!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,250);return;}
  if(r.duplicate){await refreshIdleState();if(idleClickPending&&!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,80);return;}
  const count=r.count||batch.count;
  if(idleState)idleState.essence=r.essence;
  if(r.criticals){idleSpawnFloat(`${r.criticals>1?`${r.criticals}× `:''}CRITIQUE −${idleFormatNumber(r.damage||r.gained)}`,'damage crit huge');idleCombatMotion('hero');}
  idleAddCombatLog(`${count} frappe${count>1?'s':''} · ${idleFormatNumber(r.damage||0)} dégâts${r.kills?` · ${r.kills} victoire${r.kills>1?'s':''}`:''}`,r.kills?'fa-skull':'fa-hand-fist');
  await refreshIdleState();
  if(idleClickPending&&!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,80);
}

function idleClickFeedback(gained) {
  const btn = document.getElementById('idle-click-btn');
  if (!btn) return;
  const fx = document.createElement('span');
  fx.className = 'idle-click-fx';
  fx.textContent = `−${idleFormatNumber(gained)} PV`;
  btn.appendChild(fx);
  setTimeout(() => fx.remove(), 700);
  // Deux petites pièces qui s'envolent, angles légèrement aléatoires — pur sucre visuel.
  for (let i = 0; i < 2; i++) {
    const coin = document.createElement('span');
    coin.className = 'idle-click-coin';
    coin.textContent = '✦';
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
  restart(document.getElementById('idle-xp-fill'), 'idle-hp-hit');
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
async function ascendIdleSlot(slotIndex) {
  if (!confirm('Le héros revient au niveau 1, mais sa production est doublée définitivement sur cet emplacement. Continuer ?')) return;
  try { const state = await api('/api/idle/slot-ascend', { method: 'POST', body: JSON.stringify({ slotIndex }) }); if (typeof burstConfetti === 'function') burstConfetti(60); idleSpawnFloat('ASCENSION · PUISSANCE DOUBLÉE', 'crit'); renderIdleState(state); }
  catch (e) { alert(e.message); }
}
async function optimizeIdleTeam(){const btn=document.getElementById('idle-optimize-team');if(btn)btn.disabled=true;try{const state=await api('/api/idle/optimize-team',{method:'POST',body:JSON.stringify({})});idleSpawnFloat(`${state.optimization.bought} NIVEAUX · -${idleFormatNumber(state.optimization.spent)}`,'crit');idleAddCombatLog(`Optimisation : ${state.optimization.bought} niveaux achetés`,'fa-wand-magic-sparkles');if(typeof sfx!=='undefined'&&sfx.win)sfx.win();renderIdleState(state);}catch(e){alert(e.message);}finally{if(btn)btn.disabled=false;}}
async function enhanceIdleEquipment(slotIndex,kind){try{const state=await api('/api/idle/equipment/enhance',{method:'POST',body:JSON.stringify({slotIndex,kind})});idleSpawnFloat('ÉQUIPEMENT +1%','xp');renderIdleState(state);}catch(e){alert(e.message);}}

async function buyIdleUpgrade(type, cardEl) {
  try {
    await api('/api/idle/upgrade', { method: 'POST', body: JSON.stringify({ type }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof sfx !== 'undefined' && sfx.tick) sfx.tick();
  idleAddCombatLog(`${type==='click'?'Concentration':type==='prod'?'Discipline':'Emplacement'} amélioré`,'fa-arrow-trend-up');
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

async function recruitIdle(currency = 'seals') {
  let r;
  try {
    r = await api('/api/idle/recruit', { method: 'POST', body: JSON.stringify({ currency }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  idleLastRecruitCurrency = r.payment?.currency || currency;
  if (typeof sfx !== 'undefined' && sfx.reveal) sfx.reveal(r.recruited.rarity);
  if (['epic', 'legendary', 'mythic'].includes(r.recruited.rarity) && typeof burstConfetti === 'function') {
    burstConfetti(r.recruited.rarity === 'mythic' ? 50 : 30);
  }
  renderIdleState(r);
  idleAddCombatLog(`${r.recruited.name} rejoint le Dojo`,'fa-user-plus');
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
    <span class="idle-recruit-reveal-rarity r-${character.rarity}">${escapeHtml(rarity)}</span>
    ${character.talent ? `<div class="idle-reveal-talent"><i class="fas fa-fingerprint"></i><div><b>Talent · ${escapeHtml(character.talent.name)}</b><span>${escapeHtml(character.talent.description)}</span></div></div>` : ''}`;
  const rates=(idleState?.slots||[]).filter((s)=>s.character).map((s)=>s.character.rate); const weakest=rates.length?Math.min(...rates):0;
  body.insertAdjacentHTML('beforeend',`<div class="idle-recruit-comparison"><span><small>PRODUCTION DE BASE</small><b>+${idleFormatNumber(character.baseRate||0)}/s</b></span><span><small>COMPARAISON ÉQUIPE</small><b class="${(character.baseRate||0)>weakest?'better':''}">${!rates.length?'Premier héros':(character.baseRate||0)>weakest?'Plus forte que le plus faible':'À entraîner'}</b></span></div>`);
  const freeSlot = idleState?.slots?.find((s) => !s.locked && !s.character);
  const assign = document.getElementById('idle-recruit-assign');
  if (assign) assign.innerHTML = freeSlot
    ? '<i class="fas fa-user-plus"></i> Ajouter à l’équipe'
    : '<i class="fas fa-users"></i> Voir mon équipe';
  modal.classList.remove('hidden');
}

function renderIdleRecruitHistory(items){const box=document.getElementById('idle-recruit-history');if(!box)return;box.innerHTML=items.length?items.map((c)=>`<div class="idle-history-row"><i class="fas fa-user-plus"></i><div><b>${escapeHtml(c.name||'Personnage')}</b><span>${escapeHtml(c.series||'Univers inconnu')} · ${escapeHtml(c.talent?.name||'')}</span></div><small>${c.recruitedAt?new Date(c.recruitedAt).toLocaleDateString('fr-FR'):''}</small></div>`).join(''):'<p class="hint">Aucun recrutement pour le moment.</p>';}

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
  document.getElementById('view-idle')?.addEventListener('click', (e) => {
    const title = e.target.closest('[data-idle-collapse]'); if (!title) return;
    const section = title.closest('.idle-collapsible'); section?.classList.toggle('collapsed');
  });
  document.getElementById('idle-collect-btn')?.addEventListener('click', collectIdle);
  document.getElementById('idle-click-btn')?.addEventListener('click', clickIdle);
  document.getElementById('idle-skill-burst')?.addEventListener('click', idleUseBurst);
  document.getElementById('idle-skill-team')?.addEventListener('click', idleUseTeamSkill);
  document.getElementById('idle-missions')?.addEventListener('click', (e) => { const b = e.target.closest('[data-idle-mission]'); if (b && !b.disabled) claimIdleMission(b.dataset.idleMission); });
  document.getElementById('idle-combat-quests')?.addEventListener('click', (e) => {
    const claim = e.target.closest('[data-idle-mini-mission]');
    if (claim) return claimIdleMission(claim.dataset.idleMiniMission);
    if (e.target.closest('[data-idle-rank-advance]')) return advanceIdleRank();
    if (e.target.closest('[data-idle-open-levels]')) return idleShowPanel('progression');
    if (e.target.closest('[data-idle-open-activities]')) idleShowPanel('activities');
  });
  document.getElementById('idle-rank-advance')?.addEventListener('click', advanceIdleRank);
  document.getElementById('idle-achievements')?.addEventListener('click', (e) => { const b = e.target.closest('[data-achievement]'); if (b && !b.disabled) claimIdleAchievement(b.dataset.achievement); });
  document.getElementById('idle-optimize-team')?.addEventListener('click', optimizeIdleTeam);
  document.getElementById('idle-speed-buttons')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-battle-speed]');if(b&&!b.disabled)chooseIdleBattleSpeed(Number(b.dataset.battleSpeed));});
  document.getElementById('idle-mode-control')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-battle-mode]');if(b)chooseIdleBattleMode(b.dataset.battleMode);});
  document.getElementById('idle-auto-skills')?.addEventListener('click',toggleIdleAutoSkills);
  document.getElementById('idle-formations')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-idle-formation]');if(b)chooseIdleFormation(b.dataset.idleFormation);});
  document.getElementById('idle-presets')?.addEventListener('click',(e)=>{const save=e.target.closest('[data-preset-save]');if(save)return saveIdlePreset();const load=e.target.closest('[data-preset-load]');if(load)return loadIdlePreset(load.dataset.presetLoad);});
  document.getElementById('idle-prestige-paths')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-prestige-path]');if(b&&!b.disabled)chooseIdlePrestigePath(b.dataset.prestigePath);});
  document.getElementById('idle-challenges')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-challenge-claim]');if(b&&!b.disabled)claimIdleChallenge(b.dataset.challengeClaim);});
  document.getElementById('idle-telemetry-load')?.addEventListener('click',loadIdleTelemetry);
  document.getElementById('idle-feedback-form')?.addEventListener('submit',sendIdleFeedback);
  document.getElementById('idle-guide-btn')?.addEventListener('click',openIdleGuide);document.getElementById('idle-guide-close')?.addEventListener('click',()=>document.getElementById('idle-guide-modal')?.classList.add('hidden'));document.getElementById('idle-guide-modal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-guide-modal')e.currentTarget.classList.add('hidden');const b=e.target.closest('[data-guide-tab]');if(b){e.currentTarget.classList.add('hidden');idleShowPanel(b.dataset.guideTab);}});
  document.getElementById('idle-ranking-btn')?.addEventListener('click',openIdleRanking);document.getElementById('idle-ranking-close')?.addEventListener('click',()=>document.getElementById('idle-ranking-modal')?.classList.add('hidden'));document.getElementById('idle-ranking-modal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-ranking-modal')e.currentTarget.classList.add('hidden');});
  document.getElementById('idle-season-card')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-season-tier]');if(b&&!b.disabled)claimIdleSeason(Number(b.dataset.seasonTier));});
  document.getElementById('idle-boss-chest')?.addEventListener('click', claimIdleBossChest);
  const closeBossReward=()=>document.getElementById('idle-boss-reveal')?.classList.add('hidden');
  document.getElementById('idle-boss-reveal-close')?.addEventListener('click',closeBossReward);
  document.getElementById('idle-boss-reveal-continue')?.addEventListener('click',closeBossReward);
  document.getElementById('idle-boss-reveal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-boss-reveal')closeBossReward();});
  document.getElementById('idle-boss-reveal')?.addEventListener('click',(e)=>{if(e.target.closest('[data-open-equipment]')){closeBossReward();idleShowPanel('equipment');}});
  document.getElementById('idle-item-filters')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-item-filter]');if(!b)return;idleItemFilter=b.dataset.itemFilter;document.querySelectorAll('[data-item-filter]').forEach((x)=>x.classList.toggle('active',x===b));renderIdleInventory(idleState);});
  document.getElementById('idle-item-sort')?.addEventListener('change',(e)=>{idleItemSort=e.target.value;renderIdleInventory(idleState);});
  document.getElementById('idle-inventory-grid')?.addEventListener('change',(e)=>{const select=e.target.closest('[data-item-target]');if(!select)return;const card=select.closest('[data-item-id]');const item=idleState?.inventory?.items?.find((x)=>x.id===card?.dataset.itemId);const comparison=card?.querySelector('[data-item-comparison]');if(item&&comparison)comparison.innerHTML=idleItemComparison(item,Number(select.value));});
  document.getElementById('idle-inventory-grid')?.addEventListener('click',(e)=>{const card=e.target.closest('[data-item-id]');if(!card)return;const itemId=card.dataset.itemId;const lock=e.target.closest('[data-item-lock]');if(lock){const item=idleState.inventory.items.find((x)=>x.id===itemId);return lockIdleItem(itemId,!item.locked);}if(e.target.closest('[data-item-equip]'))return equipIdleItem(itemId,Number(card.querySelector('[data-item-target]')?.value));if(e.target.closest('[data-item-unequip]'))return unequipIdleItem(itemId);if(e.target.closest('[data-item-salvage]'))return salvageIdleItem(itemId);});
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
    if (levelBtn) return levelUpIdleSlot(Number(levelBtn.dataset.slot), levelBtn.closest('.idle-hero'), levelBtn.dataset.amount==='max'?'max':Number(levelBtn.dataset.amount || 1));
    const ascendBtn = e.target.closest('[data-action="ascend"]');
    if (ascendBtn) return ascendIdleSlot(Number(ascendBtn.dataset.slot));
    const equipmentBtn=e.target.closest('[data-action="enhance-equipment"]');if(equipmentBtn)return enhanceIdleEquipment(Number(equipmentBtn.dataset.slot),equipmentBtn.dataset.kind);
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
  document.getElementById('idle-onboarding')?.addEventListener('click',(e)=>{
    if(idleOnboardingSubmitting)return;
    const classButton=e.target.closest('[data-onboarding-class]');
    if(classButton){idleOnboardingClass=classButton.dataset.onboardingClass;return renderIdleOnboarding(idleState?.onboarding);}
    const characterButton=e.target.closest('[data-onboarding-character]');
    if(characterButton){idleOnboardingCharacterId=Number(characterButton.dataset.onboardingCharacter);return renderIdleOnboarding(idleState?.onboarding);}
    if(e.target.closest('#idle-onboarding-start'))completeIdleOnboarding();
  });
  document.getElementById('idle-top-recruit-btn')?.addEventListener('click', () => recruitIdle('seals'));
  document.getElementById('idle-recruit-btn')?.addEventListener('click', () => recruitIdle('seals'));
  document.getElementById('idle-top-recruit-essence-btn')?.addEventListener('click', () => recruitIdle('essence'));
  document.getElementById('idle-recruit-essence-btn')?.addEventListener('click', () => recruitIdle('essence'));
  document.getElementById('idle-recruit-reveal-close')?.addEventListener('click', closeIdleRecruitReveal);
  document.getElementById('idle-recruit-reveal')?.addEventListener('click', (e) => { if (e.target.id === 'idle-recruit-reveal') closeIdleRecruitReveal(); });
  document.getElementById('idle-recruit-again')?.addEventListener('click', () => { closeIdleRecruitReveal(); recruitIdle(idleLastRecruitCurrency); });
  document.getElementById('idle-recruit-assign')?.addEventListener('click', assignIdleLastRecruit);
  document.getElementById('idle-milestone-btn')?.addEventListener('click', claimIdleMilestone);
  document.getElementById('idle-prestige-btn')?.addEventListener('click', prestigeIdle);
  document.getElementById('idle-customize-hero')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openIdleClassPicker();
  });
  document.getElementById('idle-class-close')?.addEventListener('click', () => document.getElementById('idle-class-picker').classList.add('hidden'));
  document.getElementById('idle-class-picker')?.addEventListener('click', (e) => { if (e.target.id === 'idle-class-picker') e.currentTarget.classList.add('hidden'); const b = e.target.closest('[data-hero-class]'); if (b) chooseIdleHeroClass(b.dataset.heroClass); });
  document.getElementById('idle-class-picker')?.addEventListener('click', (e) => { const b=e.target.closest('[data-style-key]'); if(b&&!b.disabled) chooseIdleHeroStyle(b.dataset.styleType,b.dataset.styleKey); });
  document.getElementById('idle-class-picker')?.addEventListener('click', (e) => { const b=e.target.closest('[data-hero-spec]'); if(b&&!b.disabled) chooseIdleHeroSpec(b.dataset.heroSpec); });
  document.getElementById('idle-welcome-close')?.addEventListener('click', () => document.getElementById('idle-welcome').classList.add('hidden'));
  document.getElementById('idle-welcome-collect')?.addEventListener('click', () => {
    document.getElementById('idle-welcome').classList.add('hidden');
    collectIdle();
  });
}

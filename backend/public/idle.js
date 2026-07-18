// Dojo (idle/clicker) — extrait autonome (scope global partagé). Réservé aux
// admins en phase de test (nav caché + 403 serveur pour tout autre compte).
// Réutilise les globals de main.js (api, showView, currentUser, escapeHtml) et
// cardHTML() de gacha.js pour le sélecteur de personnage (modale) — le roster
// assigné a sa propre ligne de héros compacte, voir idleSlotHTML.
const IDLE_BOSS_MECHANIC_ICONS = { shield:'fa-shield-halved', rage:'fa-fire', regen:'fa-heart-pulse', counter:'fa-people-arrows', ward:'fa-link-slash', focus:'fa-crosshairs' };
let idleState = null; // dernier état reçu du serveur
let idleTicker = null;
let idleSyncTicker = null; // resynchronisation périodique légère (cf. openIdle) — sans ça, un joueur qui ne clique jamais ne verrait aucun kill se produire réellement côté serveur
let idlePickerSlot = null; // emplacement en cours de sélection dans la modale
let idleParticleTheme = null; // dernier thème pour lequel les particules ambiantes ont été générées
let idleWelcomeChecked = false; // l'écran « pendant ton absence » ne se déclenche qu'une fois par ouverture
const IDLE_PANEL_NAMES = ['home', 'team', 'upgrades', 'progression', 'equipment', 'farm', 'activities'];
let idleActivePanel = 'home'; // page courante de l'Idle
const idlePanelScrolls = new Map(); // conserve la position de lecture entre deux onglets
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
const idleInventoryPrefs = (()=>{try{return JSON.parse(localStorage.getItem('idle-inventory-prefs')||'{}')}catch{return {}}})();
let idleItemFilter = ['all','rune1','rune2','rune3','rune4','rune5','rune6'].includes(idleInventoryPrefs.filter)?idleInventoryPrefs.filter:'all';
let idleItemSort = ['recent','power','rarity'].includes(idleInventoryPrefs.sort)?idleInventoryPrefs.sort:'recent';
let idleItemRarity = ['all','rare','epic','legendary','mythic'].includes(idleInventoryPrefs.rarity)?idleInventoryPrefs.rarity:'all';
let idleItemSet = typeof idleInventoryPrefs.set==='string'?idleInventoryPrefs.set:'all';
let idleItemStatus = ['all','free','equipped','resting','locked'].includes(idleInventoryPrefs.status)?idleInventoryPrefs.status:'all';
let idleItemSearch = typeof idleInventoryPrefs.search==='string'?idleInventoryPrefs.search:'';
let idleItemRecommendedOnly = idleInventoryPrefs.recommendedOnly===true;
let idleEquipmentTargetSlot = idleInventoryPrefs.targetSlot!=null&&Number.isInteger(Number(idleInventoryPrefs.targetSlot))?Number(idleInventoryPrefs.targetSlot):null;
let idleEquipmentPickerSlot = null;
let idleEquipmentPickerKind = null;
let idleSelectedItems = new Set();
// Détail replié par défaut sur chaque ligne d'objet (le joueur peut vite en
// accumuler des dizaines) : mémorisé par id, sinon chaque synchro d'état
// (re-render innerHTML) refermerait la ligne en cours de consultation.
let idleExpandedItems = new Set();
// Petit menu déroulant ×1/×5/×10/×100/MAX ouvert directement sur une carte
// héros (retour joueur : le sélecteur global en tête de panneau se voyait
// mal, la quantité semblait bloquée sur ×1). Un seul ouvert à la fois.
let idleLevelupMenuSlot = null;
function toggleIdleItemExpand(itemId){if(idleExpandedItems.has(itemId))idleExpandedItems.delete(itemId);else idleExpandedItems.add(itemId);renderIdleInventory(idleState);}
let idleSalvageRules = (()=>{try{return {...{rarity:'rare',enhancement:0,keepSets:true},...JSON.parse(localStorage.getItem('idle-salvage-rules')||'{}')}}catch{return {rarity:'rare',enhancement:0,keepSets:true}}})();
// Sections dépliables (<details>) des cartes héros/objets : l'état ouvert est
// mémorisé par clé, sinon chaque synchro d'état (re-render innerHTML) les
// refermerait sous la souris du joueur.
const idleOpenDetails = new Set();
// Un seul listener global (capture) : mémorise l'état de TOUS les dépliants
// marqués data-more-key, où qu'ils soient rendus (cartes héros, méta-guide,
// cartes d'objets). Le toggle natif s'applique après le clic : on mémorise
// donc l'état inverse.
document.addEventListener('click', (e) => {
  const summary = e.target.closest('summary');
  const details = summary?.closest('details[data-more-key]');
  if (!details) return;
  const key = details.dataset.moreKey;
  if (details.open) idleOpenDetails.delete(key); else idleOpenDetails.add(key);
}, true);
let idleRosterCharacters = new Map();
let idleRosterAvailable = [];
let idleRosterSort = 'meta';
let idleRosterRole = 'all';
let idleRosterRarity = 'all';
let idleRosterSearch = '';
let idleLastAnnouncement = '';
let idleWaveTransitionTimers = [];
let idleVisualHp = null;
let idleVisualMaxHp = null;
let idleVisualStage = null;
let idleVisualEnemyNumber = null;
let idleVisualRespawnTimer = null;
let idleCoachAction = null;
let idleForceHpSync = false;
let idleMissionDayKey = null;
let idleMissionWeekKey = null;
// Quantité d'achat GLOBALE (×1/×5/×10/×100/MAX) façon Clicker Heroes —
// partagée entre le dock d'achats rapides du Combat et l'onglet Équipe.
let idleBuyAmount = localStorage.getItem('idle-buy-amount') || '1';
// Tri de la collection par licence (retour joueur : « trier par nombre de
// persos recrutés par licence, ça serait plus clair »).
const IDLE_COLLECTION_SORTS = [['percent', 'Complétion'], ['owned', 'Recrutés'], ['name', 'A–Z']];
let idleCollectionSort = localStorage.getItem('idle-collection-sort') || 'percent';
let idleAncientsAutoOpened = false; // la section Ancients ne s'auto-déplie qu'une fois par session
let idleOrbTimer = null; // prochain orbe bonus programmé
let idleOrbCooldownUntil = 0; // empêche un coffre de combat d'apparaître pendant l'anti-rejeu serveur
let idleComboCount = 0; // frénésie de clic (purement visuelle)
let idleComboExpireAt = 0;
let idleChatSocket = null;
let idleChatBound = false;
let idleChatUnread = 0;
let idleChatDrawerOpened = false;
let idleRankingType = 'stage';
let idleInspectedPlayer = null;
let idleRefreshPromise = null;
let idleSyncFailures = 0;
let idleConnectionHideTimer = null;
let idleModalObserver = null;
let idleModalFocusOrigins = new WeakMap();
let idleSessionStats = null;
let idleCommunityBossPromise = null;

function resetIdleSessionStats(render=true){idleSessionStats={startedAt:Date.now(),clicks:0,damage:0,activeKills:0,passiveKills:0,bestCombo:0,xpStart:null,stageStart:null,xpNow:null,stageNow:null};if(render&&idleState){idleTrackSessionState(idleState);renderIdleSessionReport(idleState);}}
function idleTrackSessionState(state){if(!state)return;if(!idleSessionStats)resetIdleSessionStats(false);const xp=Number(state.dojo?.xpTotal||0)+Number(state.pendingEssence||0);const stage=Number(state.battle?.stage||1);if(idleSessionStats.xpStart===null){idleSessionStats.xpStart=xp;idleSessionStats.stageStart=stage;}idleSessionStats.xpNow=Math.max(idleSessionStats.xpNow??xp,xp);idleSessionStats.stageNow=Math.max(idleSessionStats.stageNow??stage,stage);}

function idleNotify(message,type='info'){
  const box=document.getElementById('idle-toasts');if(!box)return;
  const toast=document.createElement('div');toast.className=`idle-toast ${type}`;toast.setAttribute('role',type==='error'?'alert':'status');
  toast.innerHTML=`<i class="fas ${type==='error'?'fa-triangle-exclamation':type==='success'?'fa-circle-check':'fa-circle-info'}"></i><span>${escapeHtml(String(message||''))}</span><button type="button" aria-label="Fermer"><i class="fas fa-times"></i></button>`;
  toast.querySelector('button').addEventListener('click',()=>toast.remove());box.appendChild(toast);setTimeout(()=>toast.remove(),4200);
}
function idleAnnounce(message){if(!message||message===idleLastAnnouncement)return;idleLastAnnouncement=message;const live=document.getElementById('idle-live-status');if(live)live.textContent=message;}
// Confirmation intégrée au jeu : window.confirm() est silencieusement ignoré
// dans certaines WebViews mobiles (PWA installée, navigateur intégré Discord) —
// le clic semblait alors « ne rien faire » (retour joueur : impossible de
// changer de monde). Même approche que le bilan de Prestige, en générique.
function idleConfirm(message,{title='Confirmer ?',confirmLabel='Continuer',cancelLabel='Annuler'}={}){
  return new Promise((resolve)=>{
    document.getElementById('idle-confirm-modal')?.remove();
    const overlay=document.createElement('div');
    overlay.id='idle-confirm-modal';overlay.className='modal-overlay';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-labelledby','idle-confirm-title');
    overlay.innerHTML=`<div class="modal-card idle-confirm-card"><h3 id="idle-confirm-title"><i class="fas fa-circle-question"></i> ${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p><div class="modal-actions"><button type="button" class="btn-secondary" data-confirm="no">${escapeHtml(cancelLabel)}</button><button type="button" class="btn-primary" data-confirm="yes">${escapeHtml(confirmLabel)}</button></div></div>`;
    const done=(value)=>{overlay.remove();resolve(value);};
    overlay.addEventListener('click',(e)=>{const button=e.target.closest('[data-confirm]');if(button)return done(button.dataset.confirm==='yes');if(e.target===overlay)done(false);});
    document.body.appendChild(overlay);
    overlay.querySelector('[data-confirm="yes"]')?.focus();
  });
}
function idleStoredSetting(key){return localStorage.getItem(`idle-${key}`)==='1';}
function persistIdleInventoryPrefs(){localStorage.setItem('idle-inventory-prefs',JSON.stringify({filter:idleItemFilter,sort:idleItemSort,rarity:idleItemRarity,set:idleItemSet,status:idleItemStatus,search:idleItemSearch,recommendedOnly:idleItemRecommendedOnly,targetSlot:idleEquipmentTargetSlot}));}
function mountIdleShortcutHelp(){const card=document.querySelector('#idle-settings-modal .idle-settings-card');if(!card||card.querySelector('.idle-shortcuts'))return;card.insertAdjacentHTML('beforeend','<section class="idle-shortcuts" aria-label="Raccourcis clavier"><span><b>Raccourcis clavier</b><small>Disponibles hors des champs de saisie</small></span><div><kbd>1</kbd> Combat <kbd>2</kbd> Équipe <kbd>3</kbd> Améliorer <kbd>4</kbd> Niveaux <kbd>5</kbd> Objets <kbd>6</kbd> Farm <kbd>7</kbd> Activités <kbd>Espace</kbd> Frapper</div></section>');}
function applyIdleComfortSettings(){const view=document.getElementById('view-idle');const reduced=typeof sfx!=='undefined'&&sfx.isIdleEffectsReduced?.();view?.classList.toggle('idle-effects-reduced',!!reduced);view?.classList.toggle('idle-effects-full',!reduced);view?.classList.toggle('idle-large-text',idleStoredSetting('large-text'));view?.classList.toggle('idle-high-contrast',idleStoredSetting('high-contrast'));view?.classList.toggle('idle-data-saver',idleStoredSetting('data-saver'));const range=document.getElementById('idle-volume');if(range&&typeof sfx!=='undefined')range.value=String(sfx.getIdleVolume?.()??.65);const toggles={"idle-effects-reduced":!reduced,"idle-large-text":idleStoredSetting('large-text'),"idle-high-contrast":idleStoredSetting('high-contrast'),"idle-data-saver":idleStoredSetting('data-saver')};Object.entries(toggles).forEach(([id,checked])=>{const input=document.getElementById(id);if(input)input.checked=checked;});}
function idleSetConnectionState(mode,message){
  const box=document.getElementById('idle-connection-status');const label=document.getElementById('idle-connection-label');if(!box||!label)return;
  clearTimeout(idleConnectionHideTimer);box.className=`idle-connection-status ${mode}`;box.querySelector('i').className=`fas ${mode==='offline'?'fa-wifi-slash':mode==='retrying'?'fa-rotate fa-spin':'fa-circle-check'}`;label.textContent=message||(mode==='offline'?'Hors ligne · ta progression locale reste affichée':mode==='retrying'?'Reconnexion en cours…':'Progression synchronisée');box.querySelector('button')?.classList.toggle('hidden',mode==='online');
  if(mode==='online')idleConnectionHideTimer=setTimeout(()=>box.classList.add('hidden'),2200);
}
// La synchro tournait uniquement sur l'onglet Combat : sur l'onglet Niveaux
// (aventure roguelike), la production continuait côté serveur mais plus rien
// ne redescendait tant qu'on ne revenait pas sur Combat — le nouveau choix de
// pouvoir semblait n'arriver "qu'en changeant d'onglet", au hasard. La sync
// doit tourner sur tous les onglets tant que l'écran est visible.
function idleStartSyncTicker(){clearInterval(idleSyncTicker);idleSyncTicker=setInterval(()=>{if(!document.hidden)idleBackgroundSync();},idleStoredSetting('data-saver')?30000:15000);}

function idleAddCombatLog(message,icon='fa-bolt'){
  idleCombatEntries.unshift({message,icon,at:new Date()});idleCombatEntries=idleCombatEntries.slice(0,4);
  idleRenderCombatLog();
}

function idleRenderCombatLog(){
  const box=document.getElementById('idle-combat-log');if(!box)return;
  box.innerHTML=idleCombatEntries.map((entry)=>`<span><i class="fas ${entry.icon}"></i>${escapeHtml(entry.message)}<small>${entry.at.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</small></span>`).join('');
}

// Les clics partent au serveur par petits lots techniques de 160 ms. Le joueur
// n'a pas besoin de voir ces lots : on les regroupe par seconde pour afficher
// une vraie mesure de cadence et de DPS.
function idleRecordStrikeBatch(count, damage, kills = 0, passiveKills = 0) {
  if(!idleSessionStats)resetIdleSessionStats(false);idleSessionStats.clicks+=count||0;idleSessionStats.damage+=damage||0;idleSessionStats.activeKills+=kills||0;idleSessionStats.passiveKills+=passiveKills||0;
  const bucket = Math.floor(Date.now() / 1000);
  let entry = idleCombatEntries.find((item) => item.type === 'strikes' && item.bucket === bucket);
  if (!entry) {
    entry = { type:'strikes', bucket, count:0, damage:0, kills:0, passiveKills:0, icon:'fa-hand-fist', at:new Date() };
    idleCombatEntries.unshift(entry);
  }
  entry.count += count || 0;
  entry.damage += damage || 0;
  entry.kills += kills || 0;
  entry.passiveKills += passiveKills || 0;
  entry.message = `${entry.count} frappe${entry.count>1?'s':''}/s · ${idleFormatNumber(entry.damage)} dégâts${entry.kills?` · ${entry.kills} élimination${entry.kills>1?'s':''}`:''}${entry.passiveKills?` · équipe : ${entry.passiveKills}`:''}`;
  idleCombatEntries = idleCombatEntries.slice(0, 4);
  idleRenderCombatLog();
}

// Suffixes façon Clicker Heroes au-delà du billion : la notation scientifique
// (1.23e18) cassait la lecture rapide des coûts — q/Q/s/S… restent comparables
// d'un coup d'œil. Au-delà du dernier suffixe, retour à l'exponentielle.
const IDLE_NUMBER_SUFFIXES = ['K', 'M', 'B', 'T', 'q', 'Q', 's', 'S', 'o', 'n', 'd'];
function idleFormatNumber(n) {
  n = Number(n || 0);
  if (!Number.isFinite(n)) return '∞';
  n = Math.floor(n);
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n < 1000) return sign + n;
  if (n < 1e6) return sign + (n / 1e3).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (n < 1e9) return sign + (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, '') + 'M';
  let tier = 2; // 1e9 = B, indice 2 de la liste
  let value = n / 1e9;
  while (value >= 1000 && tier < IDLE_NUMBER_SUFFIXES.length - 1) { value /= 1000; tier++; }
  if (value >= 1000) return sign + n.toExponential(2).replace('+', '');
  const text = value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return sign + text + IDLE_NUMBER_SUFFIXES[tier];
}

// État vide générique pour les listes du Dojo (missions, défis, succès…) : un
// panneau sans contenu doit toujours expliquer POURQUOI il est vide plutôt
// que de rester une simple zone noire — ce silence est ce qui a fait croire à
// une panne la dernière fois que /state a échoué (rien à l'écran, aucune
// explication). `icon` en fa-xxx, `hint` optionnel.
function idleEmptyState(icon, title, hint) {
  return `<div class="idle-empty-panel"><i class="fas ${icon}"></i><b>${escapeHtml(title)}</b>${hint ? `<span>${escapeHtml(hint)}</span>` : ''}</div>`;
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

function renderIdleSessionReport(state){
  const box=document.getElementById('idle-session-summary');if(!box||!state)return;idleTrackSessionState(state);
  const elapsed=Math.max(1,(Date.now()-idleSessionStats.startedAt)/1000);const minutes=elapsed/60;const essence=Math.max(0,idleSessionStats.xpNow-idleSessionStats.xpStart);const stages=Math.max(0,idleSessionStats.stageNow-idleSessionStats.stageStart);const kills=idleSessionStats.activeKills+idleSessionStats.passiveKills;const clicksPerMin=idleSessionStats.clicks/minutes;const essencePerHour=essence/(elapsed/3600);
  const style=clicksPerMin>=30?'Actif':idleSessionStats.passiveKills>idleSessionStats.activeKills?'Automatique':'Hybride';
  box.innerHTML=`<div class="idle-session-kpis"><span><small>DURÉE</small><b>${idleFormatDuration(elapsed)||'< 1 min'}</b></span><span><small>ESSENCE GAGNÉE</small><b>+${idleFormatNumber(essence)}</b><em>${idleFormatNumber(essencePerHour)}/h</em></span><span><small>VAGUES FRANCHIES</small><b>+${idleFormatNumber(stages)}</b></span><span><small>ÉLIMINATIONS</small><b>${idleFormatNumber(kills)}</b><em>${idleSessionStats.activeKills} actives · ${idleSessionStats.passiveKills} auto</em></span><span><small>FRAPPES</small><b>${idleFormatNumber(idleSessionStats.clicks)}</b><em>${Math.round(clicksPerMin)}/min</em></span><span><small>MEILLEUR COMBO</small><b>×${idleFormatNumber(idleSessionStats.bestCombo)}</b></span></div><div class="idle-session-diagnosis"><i class="fas ${style==='Actif'?'fa-hand-fist':style==='Automatique'?'fa-gears':'fa-shuffle'}"></i><span><small>STYLE DE SESSION · ${style.toUpperCase()}</small><b>${escapeHtml(state.advisor?.title||'Poursuis ta progression')}</b><em>${idleFormatNumber(idleSessionStats.damage/elapsed)} dégâts actifs/s mesurés sur cette session</em></span></div>`;
}

async function openIdle() {
  const rememberedPanel=localStorage.getItem('idle-last-panel')||'home';
  showView('idle');
  document.body.classList.add('idle-fullscreen'); // espace dédié : le chrome du site (header/nav) s'efface
  applyIdleComfortSettings();
  idlePanelScrolls.clear();idleActivePanel='home';idleShowPanel('home',{remember:false,restoreScroll:false});window.scrollTo({top:0,behavior:'auto'});
  idleStopTicker();
  idleWelcomeChecked = false;
  resetIdleSessionStats(false);
  idleTicker = setInterval(idleTick, 400);
  idleScheduleOrb(true);
  // Sync serveur périodique : sans elle, essenceEarnedTotal ne bougerait
  // jamais entre deux clics et le stage resterait figé indéfiniment, même
  // avec la barre qui semble baisser (illusion purement visuelle côté
  // client, cf. idleTickInterpolateBattle). Relevé de 6 s à 15 s : la
  // production réelle n'a pas besoin d'un aller-retour serveur aussi
  // fréquent pour rester crédible à l'écran, et ça réduit d'un facteur 2,5
  // la charge sur le serveur générée par chaque joueur actif.
  idleStartSyncTicker();
  idleConnectChat();
  idleMountChatDrawer();
  // Ouvert par défaut UNIQUEMENT si le joueur l'a déjà ouvert lui-même une
  // fois (préférence persistante, opt-in) — le tiroir est un panneau flottant
  // qui recouvre ~380px de la scène/des cartes, pas une colonne qui pousse le
  // contenu : l'ouvrir d'office à chaque nouvelle session cachait des cartes
  // de héros/améliorations entières sur les résolutions courantes (≥1050px).
  if(window.innerWidth>=1050&&localStorage.getItem('idle-chat-open')==='1')idleSetChatOpen(true);
  await refreshIdleState();
  if(IDLE_PANEL_NAMES.includes(rememberedPanel)&&rememberedPanel!=='home'&&!idleTabLockReason(rememberedPanel,idleState))idleShowPanel(rememberedPanel,{remember:false});
  maybeShowIdleWelcome();
}

const IDLE_CHAT_REACTIONS=['👏','🔥','💪'];
function idleMountChatDrawer(){const view=document.getElementById('view-idle');const chat=document.getElementById('idle-community-chat');if(view&&chat&&chat.parentElement!==view)view.appendChild(chat);}
function idleRenderChatUnread(){const badge=document.getElementById('idle-chat-unread');if(!badge)return;badge.textContent=idleChatUnread>99?'99+':String(idleChatUnread);badge.classList.toggle('hidden',!idleChatUnread);}
function idleSetChatOpen(open){idleMountChatDrawer();idleChatDrawerOpened=!!open;const chat=document.getElementById('idle-community-chat');const toggle=document.getElementById('idle-chat-toggle');chat?.classList.toggle('is-open',idleChatDrawerOpened);toggle?.classList.toggle('is-open',idleChatDrawerOpened);toggle?.setAttribute('aria-expanded',String(idleChatDrawerOpened));if(idleChatDrawerOpened){idleChatUnread=0;idleRenderChatUnread();requestAnimationFrame(()=>{const feed=document.getElementById('idle-chat-feed');if(feed)feed.scrollTop=feed.scrollHeight;document.getElementById('idle-chat-text')?.focus({preventScroll:true});});}}
function idleToggleChat(){idleSetChatOpen(!idleChatDrawerOpened);if(idleChatDrawerOpened)localStorage.setItem('idle-chat-open','1');else localStorage.removeItem('idle-chat-open');}
function idleChatReactionBar(message){
  const m=message||{};if(!m.id)return '';
  return `<div class="idle-chat-reactions" aria-label="Réagir au message">${IDLE_CHAT_REACTIONS.map((emoji)=>`<button type="button" data-chat-react="${emoji}" data-message-id="${escapeHtml(m.id)}" title="Réagir avec ${emoji}">${emoji}<span>${Number(m.reactions?.[emoji])||''}</span></button>`).join('')}</div>`;
}
function idleChatLine(message){
  const m=message||{};const time=m.ts?new Date(m.ts).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):'';
  if(m.type==='recruit'&&['legendary','mythic'].includes(m.rarity)){
    // Pas de barre de réactions ici (contrairement aux messages de joueur) :
    // dans le panneau de chat étroit (~380px), les 6 boutons emoji forçaient
    // un retour à la ligne sous l'icône/texte/heure, cassant la carte en un
    // pavé "empilé" (retour utilisateur). Ces annonces sont des diffusions
    // façon système (comme .idle-chat-system, qui n'en a jamais eu), pas des
    // messages à commenter.
    return `<div class="idle-chat-drop r-${m.rarity}" data-chat-id="${escapeHtml(m.id||'')}"><i class="fas ${m.rarity==='mythic'?'fa-star':'fa-crown'}"></i><span><small>INVOCATION ${m.rarity==='mythic'?'MYTHIQUE':'LÉGENDAIRE'}</small><b>${escapeHtml(m.player||'Un joueur')}</b> a recruté <strong>${escapeHtml(m.character||'un héros')}</strong></span><time>${time}</time></div>`;
  }
  if(m.type==='prestige')return `<div class="idle-chat-drop r-prestige" data-chat-id="${escapeHtml(m.id||'')}"><i class="fas fa-brain"></i><span><small>NOUVEAU PRESTIGE</small><b>${escapeHtml(m.player||'Un joueur')}</b> atteint le <strong>Prestige ${idleFormatNumber(m.prestigeLevel||1)}</strong><em>Stage ${idleFormatNumber(m.stage||1)} · +${idleFormatNumber(m.reward||0)} Sagesse</em></span><time>${time}</time></div>`;
  if(m.system)return `<div class="idle-chat-system"><i class="fas fa-bullhorn"></i>${escapeHtml(m.text||'')}<time>${time}</time></div>`;
  return `<div class="idle-chat-message" data-chat-id="${escapeHtml(m.id||'')}"><span><b>${escapeHtml(m.name||'Joueur')}</b>${escapeHtml(m.text||'')}</span><time>${time}</time>${idleChatReactionBar(m)}</div>`;
}

function idleAppendChat(message){
  const feed=document.getElementById('idle-chat-feed');if(!feed)return;
  // Ne recoller en bas QUE si le joueur y était déjà : sans cette garde, tout
  // nouveau message (fréquents sur un chat vivant — recrues, Prestige…)
  // renvoyait de force en bas quiconque avait remonté pour lire l'historique
  // (retour joueur : « le chat fait des trucs bizarres pour le défilement »).
  // Idem pour la purge au-delà de 60 messages : retirer le premier enfant
  // pendant que le joueur lit plus bas décale sa position sans qu'il ait
  // scrollé — on ne purge donc que si on est déjà en bas.
  const wasAtBottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<40;
  feed.insertAdjacentHTML('beforeend',idleChatLine(message));
  if(wasAtBottom){
    while(feed.children.length>60)feed.firstElementChild?.remove();
    feed.scrollTop=feed.scrollHeight;
  }
  if(!idleChatDrawerOpened){idleChatUnread++;idleRenderChatUnread();}
}

function idleLoadChatHistory(){
  if(!idleChatSocket)return;
  idleChatSocket.timeout(5000).emit('mp:gchat:history',(error,data)=>{
    if(error||!data)return;
    const feed=document.getElementById('idle-chat-feed');if(feed){feed.innerHTML=(data.messages||[]).map(idleChatLine).join('');feed.scrollTop=feed.scrollHeight;}
    const onlineText=`${idleFormatNumber(data.online||0)} en ligne`;const online=document.getElementById('idle-chat-online');if(online)online.textContent=onlineText;const launcher=document.getElementById('idle-chat-launcher-status');if(launcher)launcher.textContent=onlineText;
  });
}

function idleConnectChat(){
  if(typeof connectMp!=='function')return;
  const socket=connectMp();if(!socket)return;
  idleChatSocket=socket;
  if(!idleChatBound){
    idleChatBound=true;
    socket.on('mp:gchat',idleAppendChat);
    socket.on('mp:gchat:reaction',(update)=>{
      const row=Array.from(document.querySelectorAll('#idle-chat-feed [data-chat-id]')).find((item)=>item.dataset.chatId===String(update?.id||''));
      const bar=row?.querySelector('.idle-chat-reactions');if(bar)bar.outerHTML=idleChatReactionBar(update);
    });
    socket.on('connect',idleLoadChatHistory);
  }
  if(socket.connected)idleLoadChatHistory();
}

function idleSendChat(event){
  event?.preventDefault();const input=document.getElementById('idle-chat-text');const text=(input?.value||'').trim();
  if(!text)return;
  if(!idleChatSocket?.connected){idleNotify('Chat en cours de reconnexion…','error');idleConnectChat();return;}
  idleChatSocket.emit('mp:gchat',text);input.value='';input.focus();
}

function idleChatCommunityClick(event){
  const reaction=event.target.closest('[data-chat-react]');
  if(reaction){if(idleChatSocket?.connected)idleChatSocket.emit('mp:gchat:react',{id:reaction.dataset.messageId,emoji:reaction.dataset.chatReact});else idleNotify('Chat en cours de reconnexion…','error');return;}
  const quick=event.target.closest('[data-chat-quick]');
  if(quick){const input=document.getElementById('idle-chat-text');if(input){input.value=quick.dataset.chatQuick;input.focus();}return;}
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
    if(idleSyncFailures){idleSetConnectionState('online','Connexion rétablie · progression synchronisée');idleAnnounce('Connexion rétablie. Progression synchronisée.');}
    idleSyncFailures=0;
  } catch {
    idleSyncFailures++;
    if(!navigator.onLine)idleSetConnectionState('offline');
    else if(idleSyncFailures>=2)idleSetConnectionState('retrying');
    return; // pas grave : la prochaine synchro rattrapera la progression
  } finally {
    idleSyncInFlight = false;
  }
}

// Onglet verrouillé tant que son contenu n'a aucun sens pour le joueur :
// « Objets » sans le moindre objet n'est qu'un écran vide plein de filtres.
// Le clic explique comment débloquer au lieu de changer d'écran.
function idleTabLockReason(name, state) {
  if (!state) return null;
  if (name === 'equipment' && !((state.inventory?.count || 0) > 0)) {
    return 'Objets : obtiens ton premier objet via les coffres de boss (Combat) ou le Donjon des Objets (Farm).';
  }
  return null;
}

// Navigation latérale sur ordinateur et barre compacte sur mobile.
function idleShowPanel(name,{remember=true,restoreScroll=true}={}) {
  if(!IDLE_PANEL_NAMES.includes(name))name='home';
  const lockReason = idleTabLockReason(name, idleState);
  if (lockReason) { idleNotify(lockReason, 'info'); return false; }
  const changed=idleActivePanel!==name;
  if(changed)idlePanelScrolls.set(idleActivePanel,window.scrollY);
  idleActivePanel = name;
  if(remember)localStorage.setItem('idle-last-panel',name);
  for (const p of IDLE_PANEL_NAMES) {
    const panel=document.getElementById('idle-panel-' + p);panel?.classList.toggle('hidden', p !== name);panel?.setAttribute('aria-hidden',p===name?'false':'true');
  }
  document.querySelectorAll('#idle-tabs .idle-tab').forEach((t) => {
    const active = t.dataset.idleTab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-current', active ? 'page' : 'false');
    t.setAttribute('aria-selected',active?'true':'false');
    t.tabIndex=active?0:-1;
  });
  // renderIdleState ne reconstruit que les blocs de l'onglet actif (cf. plus
  // bas) — un changement d'onglet doit donc forcer un rendu complet avec le
  // dernier état connu, sinon l'onglet qu'on vient d'ouvrir affiche des
  // données périmées depuis la dernière fois qu'il était actif.
  if (idleState) renderIdleState(idleState);
  if(name==='activities')loadIdleCommunityBoss();
  // Ouvrir l'onglet Niveaux (aventure roguelike) synchronise tout de suite —
  // sinon le choix de pouvoir en attente peut sembler figé jusqu'à 15-30s.
  if(name==='progression')idleBackgroundSync();
  if(changed&&restoreScroll)requestAnimationFrame(()=>window.scrollTo({top:idlePanelScrolls.get(name)||0,behavior:'auto'}));
  return true;
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
  const summary=idleState.offlineSummary||{};const details=[];
  if(summary.kills)details.push(`${idleFormatNumber(summary.kills)} ennemis vaincus`);
  if(summary.waves)details.push(`${idleFormatNumber(summary.waves)} vague${summary.waves>1?'s':''} franchie${summary.waves>1?'s':''}`);
  if(summary.bossBlocked)details.push('progression arrêtée sur un boss');
  if(summary.capped)details.push('plafond hors-ligne atteint');
  document.getElementById('idle-welcome-msg').textContent = `Absence : ${away}. Butin : ${idleFormatNumber(idleState.pendingEssence)} Essence${details.length?` · ${details.join(' · ')}`:''}.`;
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
  clearTimeout(idleOrbTimer);
  idleOrbTimer = null;
  document.querySelectorAll('.idle-bonus-orb').forEach((orb) => orb.remove());
}

// ── Orbes bonus (équivalent « golden cookie ») : un orbe traverse la scène
// toutes les 2 à 5 minutes ; le cliquer paie ~45 s de production d'un coup
// (le serveur borne la fréquence, cf. POST /api/idle/bonus-orb). Récompense
// la présence active sans jamais la rendre obligatoire.
function idleScheduleOrb(firstOfSession = false) {
  clearTimeout(idleOrbTimer);
  const delay = firstOfSession ? 45000 + Math.random() * 45000 : 120000 + Math.random() * 180000;
  idleOrbTimer = setTimeout(idleSpawnOrb, delay);
}
function idleSpawnOrb(kind = 'orb') {
  if (kind === 'orb') idleScheduleOrb();
  const scene = document.getElementById('idle-scene');
  if (!scene || idleActivePanel !== 'home' || document.hidden) return; // l'orbe raté reviendra
  if (Date.now() < idleOrbCooldownUntil) return; // ne montre jamais une récompense encore refusée par le serveur
  if (scene.querySelector('.idle-bonus-orb')) return; // jamais deux à la fois
  const orb = document.createElement('button');
  orb.type = 'button';
  orb.className = `idle-bonus-orb ${kind === 'chest' ? 'is-chest' : ''}`;
  orb.title = kind === 'chest' ? 'Butin d’élite ! Attrape-le avant qu’il disparaisse' : 'Orbe d’essence ! Attrape-le avant qu’il disparaisse';
  orb.innerHTML = `<i class="fas ${kind === 'chest' ? 'fa-box-open' : 'fa-circle-notch'}"></i>`;
  orb.style.setProperty('--orb-top', `${Math.round(18 + Math.random() * 45)}%`);
  orb.style.setProperty('--orb-duration', `${(11 + Math.random() * 4).toFixed(1)}s`);
  const expire = setTimeout(() => orb.remove(), 16000);
  let claiming = false;
  const claim = async (event) => {
    event.preventDefault();
    event.stopPropagation(); // ne compte pas comme une frappe sur la scène
    if (claiming) return;
    claiming = true;
    clearTimeout(expire);
    orb.disabled = true;
    orb.classList.add('is-claiming');
    try {
      const r = await api('/api/idle/bonus-orb', { method: 'POST', body: JSON.stringify({}) });
      idleOrbCooldownUntil = Date.now() + (Number(r.cooldownSeconds) || 90) * 1000;
      orb.remove();
      // Le nom seul ("PRÉCISION DIVINE") ne dit rien du bonus qu'il faut aller
      // vérifier ailleurs — le texte flottant, le plus visible des trois
      // retours (avec le bandeau et le toast), doit porter l'effet lui-même.
      // Classe dédiée 'buff' (pas 'crit huge', trop large pour ce texte plus
      // long — largeur fixe + retour à la ligne au lieu d'un débordement
      // rogné par .idle-floats{overflow:hidden}).
      idleSpawnFloat(r.buff ? `${r.buff.label.toUpperCase()} · ${r.buff.description.toUpperCase()}` : r.jackpot ? `JACKPOT +${idleFormatNumber(r.reward)}` : `ORBE +${idleFormatNumber(r.reward)}`, r.buff ? 'buff' : 'crit huge');
      if (r.seal) idleSpawnFloat('+1 SCEAU', 'crit');
      idleAddCombatLog(r.buff ? `${r.buff.label} — ${r.buff.description} pendant ${r.buff.seconds}s` : `${r.jackpot ? 'JACKPOT — orbe bonus' : 'Orbe bonus attrapé'} : +${idleFormatNumber(r.reward)} Essence${r.seal ? ' · +1 Sceau' : ''}`, r.buff ? 'fa-fire-flame-curved' : r.jackpot ? 'fa-burst' : 'fa-circle-notch');
      if (typeof burstConfetti === 'function') burstConfetti(r.jackpot || r.buff ? 60 : 20);
      if (typeof sfx !== 'undefined' && sfx.idleChest) sfx.idleChest();
      if (r.jackpot) idleNotify(`JACKPOT ! Cet orbe a payé ×4 : +${idleFormatNumber(r.reward)} Essence.`, 'success');
      if (r.buff) idleNotify(`${r.buff.label} ! ${r.buff.description} pendant ${r.buff.seconds} secondes.`, 'success');
      await refreshIdleState();
    } catch (e) {
      orb.remove();
      idleNotify(e.message || 'La bulle n’a pas pu être récupérée.', 'error');
    }
  };
  // Pointerdown valide immédiatement la prise : sur mobile, l'animation ne
  // peut plus déplacer la bulle entre l'appui et le relâchement du doigt.
  orb.addEventListener('pointerdown', claim);
  orb.addEventListener('click', claim); // accessibilité clavier
  scene.appendChild(orb);
}

function idleTick() {
  if (!idleState) return;
  const display = idleState.essence + idleState.pendingEssence;
  const el = document.getElementById('idle-essence-val');
  if (el) el.textContent = idleFormatNumber(display);
  idleUpdateBossTimer();
  idleRenderSkillCooldown();
  idleUpdateMissionCountdowns();
  if (idleComboCount && Date.now() >= idleComboExpireAt) { idleComboCount = 0; idleRenderCombo(); }
  // Gain flottant passif dans la scène toutes les ~3,2 s (8 ticks de 400 ms) —
  // purement cosmétique, ça montre la production "vivre" comme dans un vrai
  // idle game. Seulement si la scène est visible et produit au moins 1.
  idleTickCount++;
  // La production automatique frappe par impulsions visibles. La barre de PV
  // descend donc à chaque proc, au lieu de lancer une transition continue vers
  // 0 qui la laissait vide presque tout le temps sur les équipes puissantes.
  // Un Boss verrouillé (needsBossEngage, cf. 049eb5e) n'encaisse RIEN tant que
  // le joueur n'a pas cliqué « Affronter le Boss » côté serveur — mais cette
  // simulation visuelle locale l'ignorait totalement : sa barre de vie
  // descendait quand même à chaque tick, avec dégâts flottants et animation
  // de combat, donnant l'impression que le combat avait déjà commencé.
  const bossLocked = !!idleState.battle?.needsBossEngage;
  if (idleActivePanel === 'home' && idleState.totalRate > 0 && !bossLocked) {
    idleApplyVisualDamage(idleState.totalRate * .4);
  }
  const passiveGain = idleState.totalRate * 3.2;
  if (idleTickCount % 8 === 0 && passiveGain >= 1 && idleActivePanel === 'home' && !bossLocked) {
    idleSpawnFloat(`−${idleFormatNumber(passiveGain)}`, 'damage passive');
    idleCombatMotion('team');
  }
}

function idleCountdownLabel(milliseconds){
  const seconds=Math.max(0,Math.ceil(milliseconds/1000));const days=Math.floor(seconds/86400);const hours=Math.floor(seconds%86400/3600);const minutes=Math.floor(seconds%3600/60);const secs=seconds%60;
  return days?`${days}j ${hours}h ${minutes}m`:`${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;
}
function idleUpdateMissionCountdowns(){
  const now=new Date();const nextDay=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1);const day=(new Date()).toISOString().slice(0,10);
  const utcDay=now.getUTCDay();const daysUntilMonday=utcDay===0?1:8-utcDay;const nextWeek=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+daysUntilMonday);const weekDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-((utcDay+6)%7))).toISOString().slice(0,10);
  const daily=document.getElementById('idle-daily-reset');const weekly=document.getElementById('idle-weekly-reset');if(daily)daily.textContent=`dans ${idleCountdownLabel(nextDay-now.getTime())}`;if(weekly)weekly.textContent=`dans ${idleCountdownLabel(nextWeek-now.getTime())}`;
  if(idleMissionDayKey&&idleMissionDayKey!==day&&idleActivePanel==='activities')refreshIdleState();else if(idleMissionWeekKey&&idleMissionWeekKey!==weekDate&&idleActivePanel==='activities')refreshIdleState();idleMissionDayKey=day;idleMissionWeekKey=weekDate;
}

function idleUpdateBossTimer(){
  const box=document.getElementById('idle-boss-timer');const fill=document.getElementById('idle-boss-timer-fill');const label=document.getElementById('idle-boss-timer-label');
  const ring=document.getElementById('idle-boss-ring');
  if(!box||!fill||!label||box.classList.contains('hidden')){ring?.classList.add('hidden');return;}
  const total=Math.max(1,Number(box.dataset.total)||30000);const deadline=Number(box.dataset.deadline)||Date.now();const remaining=Math.max(0,deadline-Date.now());
  const percent=Math.max(0,Math.min(100,remaining/total*100));
  fill.style.width=`${percent}%`;const enraged=remaining<=0;box.classList.toggle('enraged',enraged);
  label.textContent=enraged?'ENRAGÉ · clics affaiblis':`${Math.ceil(remaining/1000)}s avant enrage`;
  // Anneau autour du gardien : même minuteur que la barre du bas, mais lu d'un
  // coup d'œil directement sur la cible plutôt que dans le pied de la scène.
  if(ring){ring.classList.remove('hidden');ring.style.setProperty('--progress',`${percent}%`);ring.classList.toggle('enraged',enraged);}
}

function idlePaintVisualHp(remaining, total, animate = true) {
  const hpEl = document.getElementById('idle-enemy-hp-text');
  if (hpEl) hpEl.textContent = `${idleFormatNumber(remaining)} / ${idleFormatNumber(total)} PV${idleEtaSuffix(remaining)}`;
  const fill = document.getElementById('idle-xp-fill');
  if (!fill) return;
  const hpPct=Math.max(0,Math.min(100,remaining/Math.max(1,total)*100));
  fill.style.transition=animate?'width .18s ease-out':'none';
  fill.style.width=`${hpPct}%`;
}

function idleResetVisualHp(battle) {
  clearTimeout(idleVisualRespawnTimer);
  idleVisualRespawnTimer = null;
  idleVisualStage = Math.max(1, battle?.stage || 1);
  idleVisualEnemyNumber = Math.max(1, battle?.enemyNumber || 1);
  idleVisualMaxHp = Math.max(1, battle?.maxHp || battle?.xpForNextStage || 1);
  idleVisualHp = Math.max(0, Math.min(idleVisualMaxHp, battle?.hp ?? idleVisualMaxHp));
  idlePaintVisualHp(idleVisualHp, idleVisualMaxHp, false);
}

// Retour instantané sur tous les dégâts : clics, compétence et DPS automatique.
// Ce compteur est uniquement visuel ; la synchronisation serveur reste la
// source de vérité pour les éliminations et les changements de vague.
function idleApplyVisualDamage(amount) {
  const battle = idleState?.battle;
  if (!battle || idleActivePanel !== 'home' || amount <= 0 || idleVisualRespawnTimer) return;
  const stage = Math.max(1, battle.stage || 1);
  const enemyNumber = Math.max(1, battle.enemyNumber || 1);
  if (idleVisualHp === null || idleVisualStage !== stage || idleVisualEnemyNumber !== enemyNumber) {
    idleResetVisualHp(battle);
  }
  idleVisualHp = Math.max(0, idleVisualHp - amount);
  idlePaintVisualHp(idleVisualHp, idleVisualMaxHp, true);
  if (idleVisualHp > 0 || battle.isBoss) return;
  // Entre deux synchronisations, un ennemi normal vaincu laisse brièvement la
  // barre à zéro puis fait apparaître la prochaine cible avec une barre pleine.
  idleVisualRespawnTimer = setTimeout(() => {
    idleVisualRespawnTimer = null;
    if (!idleState?.battle || idleState.battle.isBoss) return;
    idleVisualHp = idleVisualMaxHp;
    idlePaintVisualHp(idleVisualHp, idleVisualMaxHp, false);
  }, 170);
}

async function refreshIdleState() {
  // Plusieurs achats/actions se terminent parfois dans la même frame. Une
  // seule lecture d'état suffit : les appelants partagent la même promesse,
  // ce qui évite les rafales réseau et les rendus dans le désordre.
  if(idleRefreshPromise)return idleRefreshPromise;
  const view=document.getElementById('view-idle');view?.setAttribute('aria-busy','true');
  idleRefreshPromise=(async()=>{
    try {
      const state=await api('/api/idle/state');renderIdleState(state);
      if(idleSyncFailures)idleSetConnectionState('online','Connexion rétablie · progression synchronisée');idleSyncFailures=0;
      return state;
    } catch (e) {
      idleSyncFailures++;idleSetConnectionState(navigator.onLine?'retrying':'offline');
      // Conserver le dernier état valide : une coupure transitoire ne doit pas
      // vider l'équipe et les améliorations sous les yeux du joueur.
      if(!idleState){const slots=document.getElementById('idle-slots');if(slots)slots.innerHTML=idleEmptyState('fa-wifi','Connexion indisponible',e.message||'Réessaie dans un instant.');}
      return null;
    } finally {idleRefreshPromise=null;view?.removeAttribute('aria-busy');}
  })();
  return idleRefreshPromise;
}

// Certains blocs sont coûteux à reconstruire (listes de dizaines d'objets,
// grilles d'inventaire) et invisibles hors de leur onglet — les limiter à
// l'onglet actif évite de les reconstruire à chaque synchro (idleBackgroundSync
// tourne uniquement pendant que l'onglet Combat est affiché, cf. openIdle).
// idleShowPanel force un rendu complet à l'entrée sur un onglet : aucune
// donnée ne peut donc rester périmée, seule la fréquence de reconstruction
// hors de l'onglet actif diminue.
// Bandeau du buff d'orbe actif (« Frénésie »/« Précision divine ») : injecté
// dans la scène de combat, avec compte à rebours local — le serveur reste
// autoritaire (le buff est relu à chaque synchronisation d'état).
let idleBuffCountdown = null;
function renderIdleBuffBanner(buff) {
  const scene = document.getElementById('idle-scene');
  let banner = document.getElementById('idle-buff-banner');
  if (idleBuffCountdown) { clearInterval(idleBuffCountdown); idleBuffCountdown = null; }
  if (!buff || !scene) { banner?.remove(); return; }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'idle-buff-banner';
    banner.className = 'idle-buff-banner';
    scene.appendChild(banner);
  }
  const until = new Date(buff.until).getTime();
  const update = () => {
    const remaining = Math.max(0, Math.round((until - Date.now()) / 1000));
    if (!remaining) { banner.remove(); if (idleBuffCountdown) { clearInterval(idleBuffCountdown); idleBuffCountdown = null; } return; }
    banner.innerHTML = `<i class="fas ${buff.key === 'precision' ? 'fa-crosshairs' : 'fa-fire-flame-curved'}"></i><b>${escapeHtml(buff.label)}</b><span>${escapeHtml(buff.description)}</span><strong>${remaining}s</strong>`;
  };
  update();
  idleBuffCountdown = setInterval(update, 1000);
}

function renderIdleState(state) {
  const prev = idleState;
  idleState = state;
  idleTrackSessionState(state);
  renderIdleOnboarding(state.onboarding);
  const essenceEl = document.getElementById('idle-essence-val');
  essenceEl.textContent = idleFormatNumber(state.essence + state.pendingEssence);
  if (prev && state.essence > prev.essence) idleBump(essenceEl);
  const rateVal = document.getElementById('idle-rate-val');
  if (rateVal) rateVal.textContent = idleFormatNumber(state.totalRate);
  document.getElementById('idle-pending-val').textContent = state.pendingEssence > 0 ? `+${idleFormatNumber(state.pendingEssence)}` : '0';
  const collectHelp = document.getElementById('idle-collect-help');
  if (collectHelp) collectHelp.innerHTML = state.pendingEssence > 0 ? `<i class="fas fa-rotate"></i> <b>${idleFormatNumber(state.pendingEssence)} Essence en synchronisation.</b> Elle sera créditée automatiquement.` : '<i class="fas fa-check"></i> Les gains sont crédités automatiquement. Ton équipe continue à produire hors ligne.';
  document.getElementById('idle-click-yield').textContent = `${idleFormatNumber(state.click.damage ?? state.click.yield)} dégâts`;
  if (idleActivePanel === 'team') { document.getElementById('idle-slots').innerHTML = renderIdleSlots(state.slots); renderIdleBuyAmountControl('idle-team-buy-amount'); }
  if (idleActivePanel === 'upgrades') document.getElementById('idle-upgrades').innerHTML = renderIdleUpgrades(state);
  if (idleActivePanel === 'progression') { renderIdleRank(state.rank); renderIdleRoadmap(state.codex,state.battle); }
  if (idleActivePanel === 'activities') {
    renderIdleMissions(state.missions || [],state.rank);
    renderIdleChallenges(state.challenges||[]);
    renderIdleEvent(state.event);
    renderIdleSeason(state.season);
    renderIdleSessionReport(state);
  }
  if (idleActivePanel === 'farm') { renderIdleRift(state.rift); renderIdleWeeklyRogue(state.run?.weeklyEvent); renderIdleExpeditions(state.expeditions); renderIdleRuneDungeon(state); }
  if (idleActivePanel === 'upgrades') renderIdleAchievements(state.achievements || [], state.achievementsBonus);
  if (idleActivePanel === 'home') renderIdleQuickBuy(state);
  renderIdleTabBadges(state);
  renderIdleAdvisor(state.advisor,state.advisorRoadmap);
  if (idleActivePanel === 'progression') renderIdleCollection(state.codex);
  renderIdleGuide(state.guide);
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
  renderIdleBuffBanner(state.buff);
  // Ligne de stats de combat façon PokéClicker — aucune nouvelle donnée,
  // juste rendues visibles en permanence (auparavant seulement dans la
  // rangée d'actions/le bouton de clic).
  const killsEl = document.getElementById('idle-kills-val');
  if (killsEl) killsEl.textContent = idleFormatNumber(state.battle.kills);
  const combatClick = document.getElementById('idle-combat-click');
  if (combatClick) combatClick.textContent = `+${idleFormatNumber(state.click.damage ?? state.click.yield)}`;
  const combatTeam = document.getElementById('idle-combat-team');
  if (combatTeam) combatTeam.textContent = `${idleFormatNumber(state.totalRate)}/s`;
  renderIdleCombatAnalysis(state.combat?.analysis);
  const primaryDps = document.getElementById('idle-primary-dps');
  if (primaryDps) primaryDps.textContent = idleFormatNumber(state.totalRate);
  idleBurstReadyAt=state.battle?.skills?.burstReadyAt?new Date(state.battle.skills.burstReadyAt).getTime():0;
  idleTeamSkillReadyAt=state.battle?.skills?.teamReadyAt?new Date(state.battle.skills.teamReadyAt).getTime():0;
  if (idleActivePanel === 'home') {
    renderIdleHowto(state);
    renderIdleDecor(state.dojo, prev?.dojo, state.battle, prev?.battle);
    renderIdleBattle(state.battle, state.dojo, prev?.battle);
    renderIdleBattleSpeed(state.battle?.speed);
    renderIdleBattleMode(state.battle?.mode, state.battle?.farmMode);
    renderIdleAutoSkills(state.battle?.autoSkills);
    renderIdleAutomationProfiles(state);
    idleRenderSkillCooldown();
    renderIdleBossChest(state.battle?.bossChest);
    renderIdleWorldJump(state.codex,state.battle);
    renderIdleMainHero(state);
    // La ligne d'alliés (#idle-stage-team) vit dans la scène de combat, pas
    // dans l'onglet Équipe : sans cet appel ici, elle restait figée sur son
    // dernier état tant qu'on ne visitait pas l'onglet Équipe (alliés
    // obsolètes qui se chevauchaient avec la vague en cours à l'écran).
    renderIdleTeamStrategy(state);
  }
  if (idleActivePanel === 'team') {
    renderIdleTeamStrategy(state);
    renderIdleMasteries(state.codex);
    renderIdleRecruitHistory(state.recruitHistory || []);
  }
  // L'aventure roguelike touche deux panneaux à la fois (raccourci sur Combat,
  // section complète sur Niveaux) et son DOM est minuscule : rendu à chaque
  // synchro, sinon les choix de bénédiction, le reroll et la sélection ne se
  // reflétaient qu'après un F5 (la fonction ne tournait que depuis l'onglet
  // Équipe, où la section ne vit plus — retour joueurs).
  renderIdleRunJourney(state);
  if (idleActivePanel === 'equipment') renderIdleInventory(state);
  if (idleActivePanel === 'upgrades') {
    renderIdleMilestone(state.dojo);
    renderIdlePrestige(state.dojo);
    renderIdleAncients(state.ancients);
  }
  renderIdleRecruit(state.recruit);
}

function renderIdleAdvisor(advisor,roadmap=[]) {
  const box=document.getElementById('idle-advisor');if(!box)return;
  if(!advisor){box.classList.add('hidden');box.innerHTML='';return;}
  box.className=`idle-advisor priority-${escapeHtml(advisor.priority||'normal')}`;
  const steps=(roadmap||[]).slice(0,3);
  box.innerHTML=`<i class="fas ${escapeHtml(advisor.icon||'fa-compass')}"></i><span><small>CONSEILLER DE PROGRESSION</small><b>${escapeHtml(advisor.title)}</b><p>${escapeHtml(advisor.description)}</p>${steps.length>1?`<ol>${steps.map((step,index)=>`<li class="${index?'':'active'}"><button type="button" data-advisor-tab="${escapeHtml(step.tab||'home')}" data-advisor-command="${escapeHtml(step.command||'')}"><em>${index+1}</em><span><b>${escapeHtml(step.title)}</b><small>${escapeHtml(step.action||'Voir')}</small></span></button></li>`).join('')}</ol>`:''}</span><button type="button" data-advisor-tab="${escapeHtml(advisor.tab||'home')}" data-advisor-command="${escapeHtml(advisor.command||'')}">${escapeHtml(advisor.action||'Voir')} <i class="fas fa-arrow-right"></i></button>`;
}

function renderIdleCombatAnalysis(analysis){
  const box=document.getElementById('idle-combat-analysis');if(!box)return;
  if(!analysis){box.innerHTML='';box.classList.add('hidden');return;}
  box.className=`idle-combat-analysis status-${escapeHtml(analysis.status||'progress')}`;
  const gap=analysis.gap==null?'':analysis.gap>=0?`Marge +${idleFormatNumber(analysis.gap)} DPS`:`Déficit ${idleFormatNumber(Math.abs(analysis.gap))} DPS`;
  box.innerHTML=`<i class="fas ${analysis.status==='blocked'?'fa-triangle-exclamation':analysis.status==='ready'?'fa-circle-check':'fa-chart-line'}"></i><span><b>${escapeHtml(analysis.title)}</b><small>${analysis.requiredDps?`Requis ${idleFormatNumber(analysis.requiredDps)} DPS · ${gap}`:'Le DPS, la synergie et le build sont recalculés en temps réel.'}</small></span><div>${(analysis.factors||[]).map((factor)=>`<em><small>${escapeHtml(factor.label)}</small><b>${escapeHtml(factor.value)}</b></em>`).join('')}</div>`;
}

// ── Dock d'achats rapides (écran Combat) : la boucle « tuer → encaisser →
// monter un héros » ne doit jamais coûter un changement d'onglet, façon
// Clicker Heroes. Une ligne compacte par héros actif : portrait, niveau,
// prochain palier ×2 et bouton d'achat à la quantité globale sélectionnée.
const IDLE_BUY_AMOUNTS = ['1', '5', '10', '100', 'max'];
function idleQuickBuyCost(character, amount) {
  if (amount === 'max') return null; // budget entier, pas de coût fixe affichable
  return character.levelCosts?.[amount] ?? character.levelUpCost;
}
function renderIdleBuyAmountControl(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = IDLE_BUY_AMOUNTS.map((amount) => `<button type="button" data-buy-amount="${amount}" class="${amount === idleBuyAmount ? 'active' : ''}" title="${amount === 'max' ? 'Acheter le maximum abordable' : `Acheter ${amount} niveau${amount === '1' ? '' : 'x'} à la fois`}">${amount === 'max' ? 'MAX' : `×${amount}`}</button>`).join('');
}
function chooseIdleBuyAmount(amount) {
  if (!IDLE_BUY_AMOUNTS.includes(amount)) return;
  idleBuyAmount = amount;
  localStorage.setItem('idle-buy-amount', amount);
  if (idleState) {
    renderIdleQuickBuy(idleState);
    const upgrades=document.getElementById('idle-upgrades');if(upgrades)upgrades.innerHTML=renderIdleUpgrades(idleState);
    // MàJ le coût/quantité affiché sur les cartes héros du panneau Équipe.
    if (idleActivePanel==='team') { const slots=document.getElementById('idle-slots');if(slots)slots.innerHTML=renderIdleSlots(idleState.slots||[]); }
  }
  renderIdleBuyAmountControl('idle-buy-amount');
  renderIdleBuyAmountControl('idle-upgrade-buy-amount');
  renderIdleBuyAmountControl('idle-team-buy-amount');
}
function renderIdleQuickBuy(state) {
  const box = document.getElementById('idle-quick-buy');
  if (!box) return;
  renderIdleBuyAmountControl('idle-buy-amount');
  const active = (state.slots || []).filter((slot) => slot.character);
  if (!active.length) {
    box.innerHTML = '<p class="hint"><i class="fas fa-user-plus"></i> Invoque puis assigne un héros pour l’améliorer directement ici.</p>';
    return;
  }
  const essence = Math.max(0, state.essence || 0);
  box.innerHTML = active.map((slot) => {
    const c = slot.character;
    const cost = idleQuickBuyCost(c, idleBuyAmount);
    const affordable = idleBuyAmount === 'max' ? essence >= (c.levelUpCost || 1) : essence >= cost;
    const milestone = c.nextMilestone ? `×2 à Nv. ${idleFormatNumber(c.nextMilestone)} · encore ${idleFormatNumber(Math.max(0, c.nextMilestone - c.level))}` : 'Tous les paliers atteints';
    const milestoneProgress = c.nextMilestone ? Math.min(100, Math.round(c.level / c.nextMilestone * 100)) : 100;
    return `<article class="idle-quick-hero r-${escapeHtml(c.rarity)} ${c.awakened ? 'is-awakened' : ''}">
      <span class="idle-quick-portrait" ${c.imageUrl ? `style="background-image:url('${escapeHtml(c.imageUrl)}')"` : ''}>${c.awakened ? '<i class="fas fa-sparkles">✦</i>' : ''}</span>
      <span class="idle-quick-info"><b>${escapeHtml(c.name)}</b><small>Nv. ${idleFormatNumber(c.level)} · DPS réel ${idleFormatNumber(c.rate)}/s</small><em class="idle-quick-milestone" title="Chaque palier double la production de ce héros"><i style="--progress:${milestoneProgress}%"></i><span><i class="fas fa-flag-checkered"></i> ${milestone}</span></em></span>
      <button type="button" class="idle-quick-level ${affordable ? 'idle-affordable' : ''}" data-slot="${slot.index}" data-action="quick-levelup" ${affordable ? '' : 'disabled'} title="Monter ${escapeHtml(c.name)} de ${idleBuyAmount === 'max' ? 'tous les niveaux abordables' : `${idleBuyAmount} niveau${idleBuyAmount === '1' ? '' : 'x'}`}">
        <b>${idleBuyAmount === 'max' ? 'MAX' : `+${idleBuyAmount}`}</b><small>${idleBuyAmount === 'max' ? 'budget' : idleFormatNumber(cost)}</small>
      </button>
    </article>`;
  }).join('') + `<button type="button" class="idle-quick-more" data-quick-team><i class="fas fa-users"></i><span>Gérer l’équipe<small>Paliers, équipement, chef</small></span><i class="fas fa-arrow-right"></i></button>`;
}

// ── Pastilles d'onglets : « il y a quelque chose d'achetable / à réclamer
// ici » sans avoir à visiter l'onglet — le réflexe fondamental d'un idle.
function idleTabBadgeCounts(state) {
  const essence = Math.max(0, state.essence || 0);
  const team = (state.slots || []).filter((slot) => slot.character && essence >= (slot.character.levelUpCost || Infinity)).length
    + (state.slots || []).filter((slot) => slot.locked && Number.isFinite(slot.unlockCost) && essence >= slot.unlockCost).length;
  let upgrades = 0;
  if (!state.prod?.maxed && essence >= (state.prod?.nextCost ?? Infinity)) upgrades++;
  if (!state.click?.maxed && essence >= (state.click?.nextCost ?? Infinity)) upgrades++;
  const wisdom = state.ancients?.points || 0;
  upgrades += (state.ancients?.items || []).filter((a) => wisdom >= a.cost).length;
  if (state.dojo?.prestige?.eligible) upgrades++;
  const claimable = (list, done = (x) => x.completed && !x.claimed) => (list || []).filter(done).length;
  upgrades += claimable(state.achievements); // les succès vivent dans l'onglet Améliorer
  const activities = claimable(state.missions)
    + claimable(state.challenges)
    + claimable(state.season?.tiers)
    + ((state.event?.weekly?.completed && !state.event?.weekly?.claimed) ? 1 : 0);
  const progression = state.rank?.ready ? 1 : 0;
  // Coffres en attente (boss + jalon) : signalés sur l'onglet Combat, où ils s'ouvrent.
  const home = (state.battle?.bossChest?.available ? 1 : 0) + (state.dojo?.milestone?.available ? 1 : 0);
  // Farm : record de Faille battable ou tentative gratuite du Donjon des Objets disponible.
  const farm = ((state.rift?.unlocked && state.rift?.projectedFloor > state.rift?.bestFloor) ? 1 : 0)
    + ((state.runeDungeon?.freeRemaining > 0) ? 1 : 0);
  return { team, upgrades, activities, progression, home, farm, equipment: 0 };
}
function renderIdleTabBadges(state) {
  const counts = idleTabBadgeCounts(state);
  document.querySelectorAll('#idle-tabs [data-idle-tab]').forEach((tab) => {
    const locked = !!idleTabLockReason(tab.dataset.idleTab, state);
    tab.classList.toggle('locked', locked);
    tab.setAttribute('aria-disabled', locked ? 'true' : 'false');
    const count = locked ? 0 : counts[tab.dataset.idleTab] || 0;
    let badge = tab.querySelector('.idle-tab-badge');
    if (!count) { badge?.remove(); }
    else {
      if (!badge) { badge = document.createElement('b'); badge.className = 'idle-tab-badge'; tab.appendChild(badge); }
      badge.textContent = count > 9 ? '9+' : String(count);
    }
    let lockIcon = tab.querySelector('.idle-tab-lock');
    if (!locked) { lockIcon?.remove(); return; }
    if (!lockIcon) { lockIcon = document.createElement('i'); lockIcon.className = 'fas fa-lock idle-tab-lock'; tab.appendChild(lockIcon); }
  });
}

// Carte « Comment jouer » de l'onglet Combat : visible uniquement pour les
// nouveaux joueurs (niveau ≤ 3) tant qu'ils ne l'ont pas fermée eux-mêmes.
function renderIdleHowto(state) {
  const box = document.getElementById('idle-howto');
  if (!box) return;
  const dismissed = localStorage.getItem('idle-howto-dismissed') === '1';
  const isNew = (state.rank?.level || 1) <= 3;
  box.classList.toggle('hidden', dismissed || !isNew);
}

// ── Collection par licence (façon Pokédex) : % de complétion par série, et
// une modale de détail avec les personnages manquants en silhouettes.
function renderIdleCollection(codex) {
  const box = document.getElementById('idle-collection');
  const summary = document.getElementById('idle-collection-summary');
  if (!box) return;
  const sortBox=document.getElementById('idle-collection-sort');
  if(sortBox)sortBox.innerHTML=IDLE_COLLECTION_SORTS.map(([key,label])=>`<button type="button" data-collection-sort="${key}" class="${key===idleCollectionSort?'active':''}">${label}</button>`).join('');
  // Le serveur envoie la liste triée par complétion : les autres tris sont
  // purement visuels, appliqués sur une copie.
  const collection = (codex?.collection || []).slice().sort((a,b)=>idleCollectionSort==='owned'?b.owned-a.owned||b.percent-a.percent:idleCollectionSort==='name'?a.series.localeCompare(b.series,'fr'):0);
  const completion=codex?.completion;
  if (summary) summary.innerHTML = `<span><i class="fas fa-user-check"></i><b>${idleFormatNumber(codex?.discovered || 0)}</b><small>héros recrutés</small></span><span><i class="fas fa-book-open"></i><b>${idleFormatNumber(codex?.catalogTotal || 0)}</b><small>personnages au total</small></span><span><i class="fas fa-layer-group"></i><b>${collection.filter((s) => s.complete).length}</b><small>licences complètes</small></span>${completion?`<span title="+${Math.round((completion.perSeriesBonus||.02)*100)}% de production permanente et +${completion.sealsPerSeries||3} Sceaux par licence complétée"><i class="fas fa-crown"></i><b>×${Number(completion.multiplier||1).toFixed(2)}</b><small>bonus de collection</small></span>`:''}`;
  box.innerHTML = collection.length ? collection.map((entry) => `<button type="button" class="idle-collection-series ${entry.complete ? 'complete' : ''}" data-collection-series="${escapeHtml(entry.series)}">
      <span class="idle-collection-name"><b>${escapeHtml(entry.series)}</b><small>${entry.owned}/${entry.total} recruté${entry.owned > 1 ? 's' : ''}${entry.awakened ? ` · ${entry.awakened} ✦ éveillé${entry.awakened > 1 ? 's' : ''}` : ''}</small></span>
      <em style="--progress:${entry.percent}%"></em>
      <strong>${entry.complete ? '<i class="fas fa-crown"></i> 100%' : `${entry.percent}%`}</strong>
    </button>`).join('') : '<p class="hint">Invoque ton premier héros pour commencer ta collection.</p>';
}
async function openIdleCollectionSeries(series) {
  const modal = document.getElementById('idle-collection-modal');
  const grid = document.getElementById('idle-collection-grid');
  const title = document.getElementById('idle-collection-title');
  const hint = document.getElementById('idle-collection-hint');
  if (!modal || !grid) return;
  if (title) title.innerHTML = `<i class="fas fa-book-open"></i> ${escapeHtml(series)}`;
  if (hint) hint.textContent = 'Chargement…';
  grid.innerHTML = '';
  modal.classList.remove('hidden');
  let data;
  try { data = await api(`/api/idle/collection?series=${encodeURIComponent(series)}`); }
  catch (e) { if (hint) hint.textContent = e.message; return; }
  if (hint) hint.textContent = `${data.owned}/${data.total} personnage${data.total > 1 ? 's' : ''} recruté${data.owned > 1 ? 's' : ''} — les silhouettes se révèlent à l’invocation.`;
  grid.innerHTML = data.characters.map((c) => `<figure class="idle-collection-char ${c.owned ? `owned r-${escapeHtml(c.rarity)}` : 'missing'} ${c.awakened ? 'is-awakened' : ''}" title="${c.owned ? escapeHtml(c.name) : 'Personnage non recruté'}">
      <span ${c.imageUrl ? `style="background-image:url('${escapeHtml(c.imageUrl)}')"` : ''}></span>
      <figcaption>${c.owned ? `${c.awakened ? '✦ ' : ''}${escapeHtml(c.name)}` : '???'}</figcaption>
    </figure>`).join('');
}

function renderIdleRunJourney(state){
  const build=state.run?.build||{};const roles=state.strategy?.roles||[];const counts=roles.reduce((map,role)=>(map[role]=(map[role]||0)+1,map),{});
  const archetype=roles.length<2?'Équipe novice':new Set(roles).size>=4?'Compagnie légendaire':(counts.attaquant||0)+(counts.assassin||0)>=3?'Avant-garde offensive':(counts.support||0)>=2?'Ordre mystique':(counts.tank||0)>=2?'Bastion du Dojo':(counts.producteur||0)>=2?'Guilde marchande':'Groupe polyvalent';
  const act=document.getElementById('idle-run-act');if(act)act.textContent=`ACTE ${idleFormatNumber(state.run?.act||1)} · STAGE ${idleFormatNumber(state.run?.stage||1)}`;
  const archetypeEl=document.getElementById('idle-run-archetype');if(archetypeEl)archetypeEl.textContent=(build.blessings||[]).length?`${build.archetype||'Hybride'} · ${archetype}`:archetype;
  const power=document.getElementById('idle-run-power');if(power)power.textContent=idleFormatNumber(Math.round((state.totalRate||0)+(state.click?.damage||0)));
  const next=document.getElementById('idle-run-next');if(next)next.textContent=build.pending?'CHOIX DISPONIBLE':build.nextStage?`Stage ${idleFormatNumber(build.nextStage)}`:'Build complet';
  const shortcut=document.getElementById('idle-run-shortcut');const shortcutLabel=document.getElementById('idle-run-shortcut-label');if(shortcut){shortcut.classList.toggle('pending',!!build.pending);if(shortcutLabel)shortcutLabel.textContent=build.pending?'Choix de bénédiction disponible':(build.blessings||[]).length?`${build.blessings.length} pouvoir${build.blessings.length>1?'s':''} actif${build.blessings.length>1?'s':''} · prochain stage ${build.nextStage||'—'}`:`Premier choix au stage ${build.nextStage||21}`;}
  const combos=document.getElementById('idle-run-combos');if(combos)combos.innerHTML=(build.combos||[]).length?(build.combos||[]).map((combo)=>`<span><i class="fas ${escapeHtml(combo.icon)}"></i><b>${escapeHtml(combo.name)} activé</b><small>${escapeHtml(combo.description)}</small></span>`).join(''):'<p><i class="fas fa-link"></i> Associe 2 pouvoirs de la même affinité pour activer un bonus de build.</p>';
  const list=document.getElementById('idle-run-blessings');if(list)list.innerHTML=(build.blessings||[]).length?(build.blessings||[]).map((item,index)=>`<article class="r-${escapeHtml(item.rarity)} affinity-${escapeHtml(item.affinity||'hybrid')}"><i class="fas ${escapeHtml(item.icon)}"></i><span><small>POUVOIR ${index+1} · ${escapeHtml((item.affinity||'hybride').toUpperCase())}</small><b>${escapeHtml(item.name)}</b><em>${escapeHtml(item.upside)} · <strong>${escapeHtml(item.downside)}</strong></em></span></article>`).join(''):`<p><i class="fas fa-route"></i><span><b>Ton build de run commence au stage 21</b><small>Tous les 20 stages, choisis parmi 3 pouvoirs et adapte ton équipe aux bonus obtenus.</small></span></p>`;
  const choice=document.getElementById('idle-run-choice');choice?.classList.toggle('hidden',!build.pending);
  const choices=document.getElementById('idle-run-choices');if(choices)choices.innerHTML=(build.choices||[]).map((item)=>`<button type="button" data-run-blessing="${escapeHtml(item.key)}" class="r-${escapeHtml(item.rarity)} affinity-${escapeHtml(item.affinity||'hybrid')}"><i class="fas ${escapeHtml(item.icon)}"></i><span><small>${escapeHtml(item.rarity).toUpperCase()} · ${escapeHtml((item.affinity||'hybride').toUpperCase())}</small><b>${escapeHtml(item.name)}</b><em>${escapeHtml(item.upside)}</em><strong>${escapeHtml(item.downside)}</strong></span><i class="fas fa-chevron-right"></i></button>`).join('');
  const rerollBtn=document.getElementById('idle-run-reroll');const rerollCostEl=document.getElementById('idle-run-reroll-cost');
  if(rerollCostEl)rerollCostEl.textContent=build.rerollCost!=null?idleFormatNumber(build.rerollCost):'–';
  if(rerollBtn)rerollBtn.disabled=build.rerollCost==null||(state.essence||0)<build.rerollCost;
}

async function chooseIdleRunBlessing(key){
  const choice=document.getElementById('idle-run-choice');choice?.classList.add('choosing');
  try{const state=await api('/api/idle/run-blessing',{method:'POST',body:JSON.stringify({key})});renderIdleState(state);idleSpawnFloat('BÉNÉDICTION ACQUISE','crit');idleNotify('Ton build de run évolue. Cette bénédiction sera retirée au Prestige.','success');}
  catch(e){idleNotify(e.message,'error');}finally{choice?.classList.remove('choosing');}
}

async function rerollIdleRunBlessing(){
  const button=document.getElementById('idle-run-reroll');if(button)button.disabled=true;
  try{const state=await api('/api/idle/run-blessing/reroll',{method:'POST',body:JSON.stringify({})});renderIdleState(state);idleSpawnFloat('NOUVEAUX POUVOIRS','xp');}
  catch(e){idleNotify(e.message,'error');if(idleState)renderIdleRunJourney(idleState);}
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
  // Grands portraits façon « choisis ton partenaire » — la vitrine ne montre
  // désormais que les 6 personnages Rares les plus populaires (cf. serveur),
  // ce premier contact avec le jeu mérite mieux qu'une liste de miniatures.
  document.getElementById('idle-onboarding-starters').innerHTML=starters.map((item)=>{const role=idleRoleFor(item);return `<button type="button" data-onboarding-character="${item.id}" class="${item.id===idleOnboardingCharacterId?'selected':''}"><span class="idle-onboarding-starter-portrait"><img src="${escapeHtml(item.imageUrl)}" alt=""></span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.series||'Univers inconnu')}</small><span class="idle-onboarding-starter-role" style="--role:${role.color}"><i class="fas ${role.icon}"></i> ${escapeHtml(role.name)}</span><em>${escapeHtml(item.talent?.name||'Talent unique')}</em></button>`;}).join('')||'<p class="hint">Aucun personnage Rare disponible. Contacte un administrateur.</p>';
  document.getElementById('idle-onboarding-start').disabled=!idleOnboardingCharacterId||idleOnboardingSubmitting;
}

function idleOnboardingDelay(ms) {
  return new Promise((resolve)=>setTimeout(resolve,ms));
}

async function playIdleOnboardingTransition(state,starter,heroClass) {
  const modal=document.getElementById('idle-onboarding');
  const transition=document.getElementById('idle-onboarding-transition');
  const view=document.getElementById('view-idle');
  const reducedMotion=typeof sfx!=='undefined'&&sfx.isIdleEffectsReduced?.();
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
  attaquant:{ name: 'Attaquant', icon: 'fa-burst', color: '#ff704d', description:'+9% DPS d’équipe (décroissant par doublon)' },
  support:{ name: 'Support', icon: 'fa-wand-magic-sparkles', color: '#b06cff', description:'−10% recharge Ultime + Combo, cap global −70%' },
  tank:{ name: 'Tank', icon: 'fa-shield-halved', color: '#4db8ff', description:'Réduit les pénalités des boss' },
  assassin:{ name: 'Assassin', icon: 'fa-bolt', color: '#ffd54a', description:'+3% DPS (décroissant) · exécute sous 20% PV' },
  producteur:{ name: 'Producteur', icon: 'fa-gears', color: '#3ec98a', description:'+4% DPS d’équipe (décroissant par doublon)' },
};
function idleRoleFor(character) { return IDLE_ROLES[character?.role]||IDLE_ROLES.attaquant; }
function idleRarityLabel(rarity){return (typeof RARITY_LABELS!=='undefined'&&RARITY_LABELS[rarity])||({rare:'Rare',epic:'Épique',legendary:'Légendaire',mythic:'Mythique'}[rarity]||rarity);}
function openIdleCharacterSheet(character){
  if(!character)return;
  const activeSlot=(idleState?.slots||[]).find((slot)=>slot.character?.id===character.id);
  const c=activeSlot?.character||character;
  const role=idleRoleFor(c);
  const modal=document.getElementById('idle-character-sheet');const body=document.getElementById('idle-character-sheet-body');if(!modal||!body)return;
  modal.dataset.characterId=String(c.id);
  const equipment=(c.equipments||[]).map((item)=>{const meta=IDLE_ITEM_META[item.kind]||IDLE_ITEM_META.rune1;const action=activeSlot?` data-sheet-gear="${escapeHtml(item.kind)}" title="Choisir la ${escapeHtml(meta.label)} pour ${escapeHtml(c.name)}"`:'';return item.empty?`<button type="button" class="empty"${action}><i class="fas ${meta.icon}"></i><small>${meta.label}</small><b>Équiper</b></button>`:`<button type="button" class="r-${escapeHtml(item.rarity)}"${action}>${idleItemArt(item,'mini')}<small>${meta.label} · ${escapeHtml(item.setName||'Énergie')}</small><b>+${item.enhancementLevel||0} · ${escapeHtml(item.name)}</b><em>${escapeHtml(idleItemEffect(item))} · Modifier</em></button>`;}).join('');
  // Le passif varie par personnage : la description vient du serveur.
  const passive=c.passive||'Bonus débloqué au niveau 10';
  const rate=c.rate||c.baseRate||0;const personalRate=c.personalRate||rate;const teamMultiplier=c.teamMultiplier||1;const teamRate=idleState?.totalRate||0;const share=activeSlot&&teamRate?Math.min(100,Math.round(rate/teamRate*100)):0;
  const formation=(idleState?.strategy?.formations||[]).find((item)=>item.active);const synergy=idleState?.strategy?.name||'Aucune synergie';const isLeader=idleState?.strategy?.leaderCharacterId===c.id;
  body.innerHTML=`<header class="idle-character-sheet-head r-${escapeHtml(c.rarity)}"><span class="idle-character-sheet-portrait" ${c.imageUrl?`style="background-image:url('${escapeHtml(c.imageUrl)}')"`:''}></span><div class="idle-character-sheet-identity"><span class="idle-character-sheet-kicker">${escapeHtml(idleRarityLabel(c.rarity))} · ${escapeHtml(c.series||'Univers inconnu')}</span><h2 id="idle-character-sheet-title">${escapeHtml(c.name)}</h2><span class="idle-character-sheet-status">${activeSlot?`<i class="fas fa-circle-check"></i> Équipe active · emplacement ${activeSlot.index+1}${isLeader?' · Chef':''}`:'<i class="fas fa-box-archive"></i> Réserve'}</span><span class="idle-character-sheet-role" style="--role:${role.color}"><i class="fas ${role.icon}"></i><span><b>${role.name}</b><small>${escapeHtml(role.description)}</small></span></span></div><div class="idle-character-sheet-power"><small>DPS RÉEL</small><b>${idleFormatNumber(rate)}<em>/s</em></b><span>${activeSlot?`${share}% du DPS total · ${idleFormatNumber(personalRate)} × ${Number(teamMultiplier).toFixed(2)}`:'Assigne-le pour produire'}</span></div></header><div class="idle-character-sheet-summary"><span><i class="fas fa-arrow-up"></i><small>NIVEAU</small><b>${idleFormatNumber(c.level||1)}</b></span><span><i class="fas fa-seedling"></i><small>DPS PERSONNEL</small><b>${idleFormatNumber(personalRate)}/s</b></span><span><i class="fas fa-users"></i><small>BONUS ÉQUIPE</small><b>×${Number(teamMultiplier).toFixed(2)}</b></span><span><i class="fas ${c.passiveUnlocked?'fa-wand-sparkles':'fa-lock'}"></i><small>PASSIF</small><b>${c.passiveUnlocked?'Actif':'Niv. 10'}</b></span></div><div class="idle-character-sheet-fit"><div><small>PLACE DANS L’ÉQUIPE</small><b><i class="fas ${role.icon}"></i> ${role.name}</b><p>${escapeHtml(role.description)}. ${activeSlot?`Formation ${escapeHtml(formation?.name||'Équilibrée')} · ${escapeHtml(synergy)}.`:'Compare-le avec tes héros actifs avant de l’assigner.'}</p></div><div><small>PASSIF DE RARETÉ</small><b><i class="fas ${c.passiveUnlocked?'fa-circle-check':'fa-lock'}"></i> ${c.passiveUnlocked?'Débloqué':'Encore verrouillé'}</b><p>${escapeHtml(passive)}</p></div></div><div class="idle-character-sheet-skills"><article><i class="fas fa-fingerprint"></i><span><small>TALENT PERMANENT</small><b>${escapeHtml(c.talent?.name||'Talent inconnu')}</b><p>${escapeHtml(c.talent?.description||'Aucun effet détaillé.')}</p></span></article><article><i class="fas fa-bolt"></i><span><small>TECHNIQUE DE COMBAT</small><b>${escapeHtml(c.combatSkill?.name||'Technique')}</b><p>${escapeHtml(c.combatSkill?.description||'Compétence utilisée pendant les combats.')}</p></span></article></div><section class="idle-character-sheet-gear"><header><span><small>ARSENAL</small><h3><i class="fas fa-shield-halved"></i> Équipement</h3></span><em>${activeSlot?`Emplacement ${activeSlot.index+1}`:'Personnage non assigné'}</em></header><div class="idle-character-sheet-equipment">${equipment||'<p class="hint">Assigne ce personnage à l’équipe pour lui équiper des objets.</p>'}</div></section><div class="idle-character-sheet-actions">${activeSlot?'<button class="btn-secondary" data-sheet-team><i class="fas fa-users"></i> Voir dans l’équipe</button><button class="btn-primary" data-sheet-equipment><i class="fas fa-shield-halved"></i> Gérer son équipement</button>':'<button class="btn-primary" data-sheet-team><i class="fas fa-user-plus"></i> Ajouter à mon équipe</button>'}</div>`;
  const leaderSkill=c.leaderSkill||{name:'Lead Skill',description:'Désigne ce héros comme chef pour activer son bonus d’équipe.'};
  body.querySelector('.idle-character-sheet-summary')?.insertAdjacentHTML('afterend',`<section class="idle-character-sheet-lead ${isLeader?'active':''}"><i class="fas fa-crown"></i><span><small>LEAD SKILL ${isLeader?'· ACTIF':'· INACTIF'}</small><b>${escapeHtml(leaderSkill.name)}</b><p>${escapeHtml(leaderSkill.description)}</p></span>${activeSlot&&!isLeader?`<button class="btn-secondary" data-sheet-leader="${c.id}">Définir comme chef</button>`:isLeader?'<strong>BONUS APPLIQUÉ</strong>':'<em>Place ce héros dans l’équipe pour l’activer.</em>'}</section>${idleHeroMilestonesHTML(c,true)}`);
  modal.classList.remove('hidden');
  modal.querySelector('.modal-close')?.focus();
}
function renderIdleTeamStrategy(state) {
  const activeSlots = (state.slots || []).filter((s) => s.character);
  const leaderSlot = activeSlots.find((s)=>s.character.id===state.strategy?.leaderCharacterId) || activeSlots[0];
  const active = leaderSlot ? [leaderSlot.character,...activeSlots.filter((s)=>s!==leaderSlot).map((s)=>s.character)] : [];
  const activeCount=document.getElementById('idle-team-active-count');if(activeCount)activeCount.textContent=`${active.length}/${state.slotsUnlocked||state.slots?.length||active.length}`;
  const production=document.getElementById('idle-team-production');if(production)production.textContent=`${idleFormatNumber(state.totalRate||0)}/s`;
  const stage = document.getElementById('idle-stage-team');
  // Le premier personnage est le chef affiché en grand dans la scène.
  if (stage) stage.innerHTML = active.slice(1, 5).map((c) => {
    const role = idleRoleFor(c); const img = c.imageUrl ? `style="background-image:url('${escapeHtml(c.imageUrl)}')"` : '';
    return `<span class="idle-stage-ally" ${img} title="Membre de l'équipe · ${role.name}"><i class="fas ${role.icon}" style="--role:${role.color}"></i></span>`;
  }).join('');
  const bar = document.getElementById('idle-synergy-bar');
  if (bar) {
    const synergy=state.strategy||{};const bonus=Math.round((synergy.bonus||0)*100);const reserve=Math.round((synergy.reserveBonus||0)*100);
    const rules=(synergy.rules||[]).map((rule)=>`<span class="${rule.met?'met':''}"><i class="fas ${rule.met?'fa-circle-check':'fa-circle'}"></i><span><small>${escapeHtml(rule.label)}</small><b>${escapeHtml(rule.condition)}</b></span><strong>+${Math.round((rule.bonus||0)*100)}%</strong></span>`).join('');
    bar.classList.toggle('active',bonus>0);
    bar.innerHTML=`<header><i class="fas fa-link"></i><span><small>SYNERGIE D’ÉQUIPE</small><b>${bonus?`${escapeHtml(synergy.name)} · bonus actif +${bonus}%`:'Aucun bonus de synergie actif'}</b></span><strong>×${Number(synergy.multiplier||1).toFixed(2)}</strong></header><div class="idle-synergy-status"><span><small>CONDITION ACTUELLE</small><b>${escapeHtml(synergy.condition||'Aucun héros actif')}</b></span><span><small>PROCHAIN PALIER</small><b>${escapeHtml(synergy.next||'Compose ton équipe')}</b></span><span><small>BONUS DE RÉSERVE</small><b>+${reserve}% DPS</b><em>+1% par héros non assigné · maximum +20%</em></span></div><div class="idle-synergy-rules">${rules}</div>`;
  }
  const meta=state.strategy?.meta;const guide=document.getElementById('idle-meta-guide');
  if(guide&&meta){
    // Lisibilité : l'essentiel d'abord (multiplicateur total, Lead Skill,
    // conseil actionnable), tout le détail chiffré — multiplicateurs, rôles,
    // talents — dans UNE section dépliable mémorisée. L'ancienne version
    // empilait deux bandeaux de formule et trois articles redondants avec le
    // contenu du dépliant.
    guide.innerHTML=`<header><div><small>MÉTA TRANSPARENTE</small><h3><i class="fas fa-chart-simple"></i> Pourquoi ton équipe produit ce DPS</h3></div><strong>×${Number(meta.visibleMultiplier||1).toFixed(2)} <small>bonus d’équipe visibles</small></strong></header>
      <div class="idle-meta-focus">
        <article class="leader-active"><i class="fas fa-crown"></i><div><b>Lead Skill · ${escapeHtml(meta.leaderSkill?.name||'Chef')}</b><span>${escapeHtml(meta.leaderExplanation)}</span></div><strong>×${Number(meta.leaderSkill?.prod||1).toFixed(2)}</strong></article>
      </div>
      <p class="idle-meta-recommendation"><i class="fas fa-lightbulb"></i><span><b>Conseil actuel</b>${escapeHtml(meta.recommendation)}</span></p>
      <details data-more-key="meta-guide" ${idleOpenDetails.has('meta-guide')?'open':''}><summary><span><i class="fas fa-calculator"></i> Voir le détail : multiplicateurs, rôles et talents</span><i class="fas fa-chevron-down"></i></summary><div class="idle-meta-details"><section><h4>Multiplicateurs actuels</h4>${(meta.multipliers||[]).map((item)=>`<span class="${item.multiplier>1?'active':''}"><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail)}</small><strong>×${Number(item.multiplier).toFixed(2)}</strong></span>`).join('')}</section><section><h4>Effet exact de chaque rôle</h4>${(meta.roleDetails||[]).map((role)=>`<span class="${role.count?'active':''}"><b>${escapeHtml(role.name)} · ${role.count}</b><small>${escapeHtml(role.effect)}${role.situational?' · situationnel':''}</small></span>`).join('')}</section><section><h4>Talents des héros actifs</h4>${(meta.talents||[]).map((talent)=>`<span class="active"><b>${escapeHtml(talent.character)} · ${escapeHtml(talent.name)}</b><small>${escapeHtml(talent.description)}</small></span>`).join('')||'<span><small>Aucun héros actif.</small></span>'}</section></div></details>`;
  }
  const formations=document.getElementById('idle-formations');if(formations){const list=state.strategy?.formations||[];const current=list.find((f)=>f.active);const formationSummary=document.getElementById('idle-team-formation-summary');if(formationSummary)formationSummary.textContent=current?.conditionMet?(current.bonusPercent?`${current.name} +${current.bonusPercent}%`:current?.name||'Équilibrée'):`${current?.name||'Équilibrée'} inactive`;formations.innerHTML=`<p class="idle-formation-help"><i class="fas fa-circle-info"></i><span><b>Une seule formation est active à la fois.</b> Son bonus multiplie tout le DPS de l’équipe uniquement si les rôles demandés sont présents.</span></p>${list.map((f)=>{const requirements=(f.requirements||[]).map((r)=>`<em class="${r.met?'met':'missing'}"><i class="fas ${r.met?'fa-check':'fa-xmark'}"></i>${escapeHtml(r.label)} <b>${r.current}/${r.required}</b></em>`).join('')||'<em class="met"><i class="fas fa-check"></i>Toujours active</em>';const status=f.active?(f.conditionMet?'ACTIVE ET APPLIQUÉE':'ACTIVE SANS BONUS'):f.conditionMet?'PRÊTE À ACTIVER':'CONDITION MANQUANTE';return `<button data-idle-formation="${f.key}" class="${f.active?'active':''} ${f.conditionMet?'ready':'not-ready'}"><i class="fas ${f.active?'fa-circle-check':'fa-circle'}"></i><span><span class="idle-formation-name"><b>${escapeHtml(f.name)}</b><strong>${f.bonusPercent?`+${f.bonusPercent}% DPS`:'Neutre'}</strong></span><small>${escapeHtml(f.description)}</small><span class="idle-formation-requirements">${requirements}</span></span><strong>${status}</strong></button>`;}).join('')}`;}
  const presets=document.getElementById('idle-presets');if(presets){const squads=state.strategy?.squads?.slots||[];presets.innerHTML=squads.length?`<p class="idle-formation-help"><i class="fas fa-circle-info"></i><span><b>Ces compositions sont des sauvegardes d’équipe.</b> Charger une composition remplace l’équipe active ; ce ne sont pas encore des équipes parallèles qui farm en même temps.</span></p>${squads.map((squad)=>`<article class="idle-squad-slot ${squad.unlocked?'unlocked':'locked'} ${squad.saved?'saved':''}"><header><i class="fas ${escapeHtml(squad.icon||'fa-users')}"></i><span><small>${squad.unlocked?'COMPOSITION DISPONIBLE':`BLOQUÉ · ${escapeHtml(squad.unlock?.label||'objectif requis')}`}</small><b>${escapeHtml(squad.name)}</b><em>${escapeHtml(squad.purpose||'Composition sauvegardée')}</em></span></header><p>${escapeHtml(squad.bonus||'')}</p><footer><button class="btn-secondary" data-preset-save-slot="${squad.index}" ${squad.unlocked?'':'disabled'}><i class="fas fa-floppy-disk"></i> Sauver ici</button><button class="btn-primary" data-preset-load="${escapeHtml(squad.name)}" ${squad.saved&&squad.unlocked?'':'disabled'} title="Remplace l’équipe active par cette composition sauvegardée"><i class="fas fa-play"></i> Charger${squad.saved?` · ${squad.size}/10`:''}</button></footer></article>`).join('')}`:`<p class="hint">Aucune composition disponible.</p>`;}
}

// Une icône distincte par nature d'objet (au lieu du même losange pour les
// six) — cohérente avec sa stat principale : rune5/fa-crosshairs reprend
// volontairement l'icône de la mécanique de Boss "Faille ciblée".
const IDLE_ITEM_META={
  rune1:{label:'Catalyseur',icon:'fa-fire'},rune2:{label:'Insigne',icon:'fa-bullseye'},rune3:{label:'Noyau',icon:'fa-wave-square'},
  rune4:{label:'Relique',icon:'fa-bolt'},rune5:{label:'Viseur',icon:'fa-crosshairs'},rune6:{label:'Halo',icon:'fa-sun'}
};
const IDLE_RUNE_KINDS=Object.keys(IDLE_ITEM_META);
const IDLE_STAT_LABELS={dps:'DPS',click:'Clic',burst:'Ultime',team:'Combo',boss:'Boss',salvage:'Recyclage'};
const IDLE_SET_MODE_META={dps:{label:'Production',icon:'fa-chart-line'},click:{label:'Clic',icon:'fa-hand-fist'},burst:{label:'Ultime',icon:'fa-bolt'},team:{label:'Combo',icon:'fa-users-rays'},boss:{label:'Boss',icon:'fa-skull'},salvage:{label:'Recyclage',icon:'fa-recycle'}};
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
    rune1:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m32 10 4 30-14 7 10 8 10-8 5-27z" fill="${accent}" opacity=".7"/>`,
    rune2:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><circle cx="32" cy="31" r="8" fill="${accent}"/>`,
    rune3:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m24 38 8-16 8 16z" fill="${accent}"/>`,
    rune4:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m27 20 10 11-10 12" fill="none" stroke="${accent}" stroke-width="4"/>`,
    rune5:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m22 31h20m-10-10v20" stroke="${accent}" stroke-width="4"/>`,
    rune6:`<path d="m32 10 15 10-5 27-10 8-10-8-5-27z" fill="${primary}" stroke="${rare}" stroke-width="2"/><circle cx="32" cy="31" r="10" fill="none" stroke="${accent}" stroke-width="4"/>`,
    weapon:`<path d="m17 47 6-1 24-27-3-3-27 24z" fill="${accent}" stroke="#f4f7fb" stroke-width="1.6"/><path d="m17 47-5 5 5-1 4-4z" fill="${primary}"/><path d="m19 39 7 7" stroke="${rare}" stroke-width="4" stroke-linecap="round"/>`,
    relic:`<path d="m32 12 13 10-5 25-8 7-9-7-5-25z" fill="${primary}" stroke="${rare}" stroke-width="2"/><path d="m32 12 2 31-11 4 9 7 8-7 5-25z" fill="${accent}" opacity=".72"/><path d="m18 22 14 7 13-7" fill="none" stroke="#f4f7fb" stroke-width="1.3"/>`,
    accessory:`<circle cx="32" cy="31" r="14" fill="none" stroke="${accent}" stroke-width="6"/><circle cx="32" cy="31" r="6" fill="${primary}" stroke="#f4f7fb" stroke-width="1.5"/><path d="m27 46-4 9m14-9 4 9" stroke="${rare}" stroke-width="3" stroke-linecap="round"/>`
  };
  return `<span class="idle-item-art ${size} r-${escapeHtml(item?.rarity||'rare')}" aria-hidden="true"><svg viewBox="0 0 64 64" role="img">${base}${shapes[item?.kind]||shapes.weapon}</svg></span>`;
}
function idleItemEffect(item){const main=IDLE_STAT_LABELS[item.mainStat]||'DPS';return `${main} +${Math.round((item.bonus||0)*100)}%`;}
function idleRuneSubStats(item){const entries=Object.entries(item.subStats||{});return entries.length?entries.map(([key,value])=>`${IDLE_STAT_LABELS[key]||key} +${Math.round(Number(value)*100)}%`).join(' · '):'Aucune sous-statistique';}
// Liste TOUS les sets (RUNE_SETS côté serveur), y compris ceux dont le
// joueur ne possède encore aucune pièce — retour joueur : « il faut afficher
// l'effet des sets même qui ne sont pas en notre possession ». Avant, un set
// jamais commencé (count=0) était filtré, donc invisible : impossible de
// savoir quels sets existent ni ce qu'ils font sans en avoir déjà trouvé une
// pièce. Les 6 sets sont peu nombreux, les montrer tous sert de catalogue de
// référence directement sur la carte du héros.
function idleItemSetStatuses(items){const sets=idleState?.inventory?.sets||[];return sets.map((set)=>{const count=items.filter((item)=>(item.setKey||'energy')===set.key).length;const stacks=Math.floor(count/set.required);const remainder=count%set.required;return {...set,count,stacks,missing:remainder?set.required-remainder:set.required};});}
function idleItemSetProjection(item,slotIndex){if(slotIndex===null||slotIndex===undefined)return null;const equipped=(idleState?.inventory?.items||[]).filter((entry)=>entry.equippedSlotIndex===slotIndex);const replaced=equipped.find((entry)=>entry.kind===item.kind&&entry.id!==item.id);const after=[...equipped.filter((entry)=>entry.id!==replaced?.id&&entry.id!==item.id),item];const required=item.setRequired||2;const count=after.filter((entry)=>(entry.setKey||'energy')===(item.setKey||'energy')).length;const stacks=Math.floor(count/required);const remainder=count%required;return {count,required,stacks,missing:remainder?required-remainder:required};}
function idleEquippedFor(slotIndex,kind){return idleState?.inventory?.items?.find((x)=>x.equippedSlotIndex===slotIndex&&x.kind===kind)||null;}
function idleItemComparison(item,slotIndex){const current=idleEquippedFor(slotIndex,item.kind);const before=current?.effectiveBonus||0;const after=item.effectiveBonus||item.bonus||0;const diff=after-before;const impact=idlePickerSetImpact(item,slotIndex);return `<span class="idle-item-comparison ${diff>=0?'better':'worse'}"><small>${current?`À la place de ${escapeHtml(current.name)}`:'Emplacement actuellement vide'}</small><b><span>${Math.round(before*100)}%</span><i class="fas fa-arrow-right"></i><span>${Math.round(after*100)}%</span></b><em>${diff>=0?'+':''}${Math.round(diff*100)}% de puissance d’objet</em>${impact.completes?'<strong><i class="fas fa-layer-group"></i> Active un bonus de set</strong>':''}</span>`;}
function idlePickerSetImpact(item,slotIndex){
  const equipped=(idleState?.inventory?.items||[]).filter((entry)=>entry.equippedSlotIndex===slotIndex);
  const required=item.setRequired||2;const key=item.setKey||'energy';const current=equipped.find((entry)=>entry.kind===item.kind);
  const originalCount=equipped.filter((entry)=>(entry.setKey||'energy')===key).length;
  const withoutReplaced=equipped.filter((entry)=>entry.id!==current?.id&&entry.id!==item.id);const afterCount=withoutReplaced.filter((entry)=>(entry.setKey||'energy')===key).length+1;
  const beforeStacks=Math.floor(originalCount/required);const afterStacks=Math.floor(afterCount/required);
  return {beforeCount:originalCount,afterCount,required,completes:afterStacks>beforeStacks,stacks:afterStacks,missing:afterCount%required?required-afterCount%required:0};
}
function idleRecommendedItems(slotIndex){
  const recommendations=new Map();if(slotIndex===null||slotIndex===undefined)return recommendations;
  for(const kind of IDLE_RUNE_KINDS){
    const current=idleEquippedFor(slotIndex,kind);const before=current?.effectiveBonus||current?.bonus||0;
    const candidates=(idleState?.inventory?.items||[]).filter((item)=>item.kind===kind&&!item.equipped).map((item)=>({item,impact:idlePickerSetImpact(item,slotIndex)})).sort((a,b)=>Number(b.impact.completes)-Number(a.impact.completes)||(b.item.effectiveBonus||b.item.bonus||0)-(a.item.effectiveBonus||a.item.bonus||0));
    const best=candidates[0];if(!best)continue;const after=best.item.effectiveBonus||best.item.bonus||0;const diff=after-before;
    if(!current||best.impact.completes||diff>0)recommendations.set(best.item.id,{diff,completes:best.impact.completes,reason:best.impact.completes?'Complète un set':!current?'Emplacement vide':`${diff>=0?'+':''}${Math.round(diff*100)}% de puissance`});
  }
  return recommendations;
}
function idleNormalizeSearch(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();}
function idleItemSearchHaystack(item){return idleNormalizeSearch([item.name,item.kind,item.setName,item.setDescription,item.mainStat,IDLE_STAT_LABELS[item.mainStat],idleItemEffect(item),...(item.affixesDetailed||[]).map((affix)=>affix.label),...Object.keys(item.subStats||{}).map((key)=>IDLE_STAT_LABELS[key]||key)].join(' '));}
function renderIdleEquipmentPicker(){
  const modal=document.getElementById('idle-equipment-picker');const body=document.getElementById('idle-equipment-picker-body');if(!modal||!body||!idleState?.inventory)return;
  const slot=(idleState.slots||[]).find((entry)=>entry.index===idleEquipmentPickerSlot&&entry.character);const kind=idleEquipmentPickerKind;const meta=IDLE_ITEM_META[kind]||IDLE_ITEM_META.rune1;
  modal.dataset.itemKind=kind||'';
  if(!slot||!kind){modal.classList.add('hidden');return;}
  const equipped=idleState.inventory.items.filter((item)=>item.equippedSlotIndex===slot.index);const current=equipped.find((item)=>item.kind===kind)||null;
  const activeSets=idleItemSetStatuses(equipped);const setOverview=activeSets.length?activeSets.map((set)=>{const mode=IDLE_SET_MODE_META[set.mode]||IDLE_SET_MODE_META.dps;return `<span class="${set.stacks?'active':'progress'} mode-${escapeHtml(set.mode||'dps')}"><i class="fas ${mode.icon}"></i><b>${escapeHtml(set.name)}</b><small>${set.count}/${set.required} · ${set.stacks?`${set.stacks} bonus actif${set.stacks>1?'s':''}`:`encore ${set.missing}`}</small></span>`;}).join(''):'<span class="empty"><i class="fas fa-layer-group"></i><b>Aucun set commencé</b><small>Choisis deux objets du même set pour activer le premier bonus.</small></span>';
  const candidates=idleState.inventory.items.filter((item)=>item.kind===kind&&(!item.equipped||item.equippedSlotIndex===slot.index)).map((item)=>({item,impact:idlePickerSetImpact(item,slot.index)})).sort((a,b)=>Number(b.impact.completes)-Number(a.impact.completes)||b.impact.afterCount-a.impact.afterCount||(b.item.effectiveBonus||b.item.bonus||0)-(a.item.effectiveBonus||a.item.bonus||0));
  const recommendedId=candidates.find(({item})=>item.id!==current?.id)?.item.id;
  const cards=candidates.map(({item,impact})=>{const isCurrent=item.id===current?.id;const setMode=IDLE_SET_MODE_META[item.setMode]||IDLE_SET_MODE_META.dps;const recommended=item.id===recommendedId;const setLabel=impact.completes?'ACTIVE UN BONUS DE SET':impact.stacks?`${impact.stacks} BONUS ACTIF${impact.stacks>1?'S':''}`:`MANQUE ${impact.missing||impact.required}`;return `<article class="idle-picker-item r-${escapeHtml(item.rarity)} ${impact.completes?'set-complete':''} ${recommended?'recommended':''}">${recommended?'<strong class="idle-picker-recommended"><i class="fas fa-star"></i> CONSEILLÉ</strong>':''}<header>${idleItemArt(item)}<span><small>${escapeHtml(idleRarityLabel(item.rarity))} · ${escapeHtml(meta.label)}</small><b>${escapeHtml(item.name)}</b><em>${escapeHtml(idleItemEffect(item))} · +${item.enhancementLevel||0}/15</em></span></header><div class="idle-picker-set mode-${escapeHtml(item.setMode||'dps')}"><i class="fas ${setMode.icon}"></i><span><small>SET ${escapeHtml(item.setName||'Énergie').toUpperCase()}</small><b>${escapeHtml(item.setDescription||'Bonus de set')}</b><strong class="${impact.completes?'complete':''}">${setLabel}</strong></span></div>${idleItemComparison(item,slot.index)}<button type="button" class="${impact.completes?'btn-primary':'btn-secondary'}" data-picker-equip="${escapeHtml(item.id)}" ${isCurrent?'disabled':''}><i class="fas ${isCurrent?'fa-circle-check':'fa-shield-halved'}"></i> ${isCurrent?'Actuellement équipé':impact.completes?'Équiper et activer le set':'Équiper cet objet'}</button></article>`;}).join('');
  body.innerHTML=`<header class="idle-picker-head"><span class="idle-picker-portrait" ${slot.character.imageUrl?`style="background-image:url('${escapeHtml(slot.character.imageUrl)}')"`:''}></span><div><small>ÉQUIPEMENT RAPIDE · ${escapeHtml(meta.label).toUpperCase()}</small><h2 id="idle-equipment-picker-title">${escapeHtml(slot.character.name)}</h2><p>Les objets qui complètent un set passent en premier. Le remplacement est appliqué en un clic.</p></div></header><section class="idle-picker-sets"><header><small>SETS · ${escapeHtml(slot.character.name).toUpperCase()}</small><button type="button" data-picker-full><i class="fas fa-boxes-stacked"></i> Inventaire complet</button></header><div>${setOverview}</div></section><div class="idle-picker-grid">${cards||`<div class="idle-picker-empty"><i class="fas ${meta.icon}"></i><b>Aucun ${escapeHtml(meta.label).toLowerCase()} disponible</b><span>Ouvre des coffres de gardiens pour obtenir un objet de cet emplacement.</span><button type="button" class="btn-secondary" data-picker-full>Voir tout l’inventaire</button></div>`}</div>`;
}
function openIdleEquipmentPicker(slotIndex,kind){idleEquipmentPickerSlot=Number(slotIndex);idleEquipmentPickerKind=kind;idleEquipmentTargetSlot=Number(slotIndex);idleItemFilter=kind;persistIdleInventoryPrefs();document.getElementById('idle-character-sheet')?.classList.add('hidden');renderIdleEquipmentPicker();document.getElementById('idle-equipment-picker')?.classList.remove('hidden');}
function idleRuneDetailChips(item){
  const affixes=(item.affixesDetailed||[]).slice(1).map((affix)=>`<span><small>${escapeHtml(affix.label)}</small><b>+${Math.round(affix.value*100)}%</b></span>`);
  const subStats=Object.entries(item.subStats||{}).map(([key,value])=>`<span><small>${escapeHtml(IDLE_STAT_LABELS[key]||key)}</small><b>+${Math.round(Number(value)*100)}%</b></span>`);
  return [...affixes,...subStats].join('')||'<em>Aucune sous-statistique débloquée</em>';
}
// Donjon des Objets : un bouton par emplacement (rune1..6), l'objet obtenu va
// toujours dans le slot choisi — façon donjon Caiross de Summoners War.
let idleRuneDungeonBusy=false;
let idleRuneDungeonActiveKind=null;
const IDLE_RUNE_DUNGEON_EXPLORE_MS=2600;
const IDLE_RUNE_DUNGEON_FLOOR_MS=800; // étages sans récompense : fouille brève
function renderIdleRuneDungeon(state){
  const dungeon=state.runeDungeon;const grid=document.getElementById('idle-rune-dungeon-grid');const status=document.getElementById('idle-rune-dungeon-status');const progress=document.getElementById('idle-rune-dungeon-progress');
  if(!dungeon||!grid)return;
  const floors=dungeon.floors||10;const floor=dungeon.floor||0;const inRun=floor>0;
  if(status)status.innerHTML=idleRuneDungeonBusy
    ?`<i class="fas fa-spinner fa-spin"></i> Exploration en cours…`
    :inRun
    ?`<i class="fas fa-stairs"></i> Étage ${floor}/${floors} · l’équipement attend à l’étage ${floors}`
    :dungeon.freeRemaining>0
    ?`<i class="fas fa-bolt"></i> ${dungeon.freeRemaining}/${dungeon.freeAttempts} descente${dungeon.freeRemaining>1?'s':''} gratuite${dungeon.freeRemaining>1?'s':''} aujourd’hui`
    :`<i class="fas fa-coins"></i> Descentes gratuites épuisées · prochaine : ${idleFormatNumber(dungeon.nextCost)} Essence`;
  // Frise des étages : seul le dernier porte le coffre, les autres ne donnent
  // rien — la frise rend cette règle lisible d'un coup d'œil.
  if(progress)progress.innerHTML=Array.from({length:floors},(_,i)=>{const step=i+1;const done=step<=floor;const last=step===floors;return `<span class="${done?'done':''} ${last?'chest':''}" title="Étage ${step}${last?' · équipement':''}">${last?'<i class="fas fa-gift"></i>':done?'<i class="fas fa-check"></i>':step}</span>`;}).join('');
  // Le coût ne s'applique qu'au premier étage : une descente entamée ne
  // repaie jamais, on ne grise donc les boutons que hors descente.
  grid.innerHTML=(dungeon.kinds||[]).map((k)=>{const exploring=idleRuneDungeonBusy&&idleRuneDungeonActiveKind===k.kind;return `<button type="button" class="idle-rune-dungeon-btn${exploring?' exploring':''}" data-rune-dungeon="${escapeHtml(k.kind)}" ${idleRuneDungeonBusy||(!inRun&&dungeon.freeRemaining<=0&&idleState&&idleState.essence<dungeon.nextCost)?'disabled':''}><i class="fas ${exploring?'fa-spinner fa-spin':escapeHtml(k.icon)}"></i><b>${exploring?'Exploration…':escapeHtml(k.label)}</b><small>${exploring?'':inRun?`Étage ${Math.min(floors,floor+1)}`:'Étage 1'}</small></button>`;}).join('');
}
async function runIdleRuneDungeon(kind){
  if(idleRuneDungeonBusy)return;idleRuneDungeonBusy=true;idleRuneDungeonActiveKind=kind;renderIdleRuneDungeon(idleState);
  try{
    // Le donjon répond instantanément côté serveur : on impose un délai
    // d'exploration côté client pour que la fouille se ressente dans le jeu.
    // Les étages intermédiaires (sans récompense) restent courts pour que la
    // descente complète ne devienne pas une corvée ; seul l'étage du coffre
    // garde la fouille longue.
    const expectedFloor=(idleState?.runeDungeon?.floor||0)+1;
    const finalFloor=expectedFloor>=(idleState?.runeDungeon?.floors||10);
    const [result]=await Promise.all([
      api('/api/idle/rune-dungeon/attempt',{method:'POST',body:JSON.stringify({kind})}),
      new Promise((resolve)=>setTimeout(resolve,finalFloor?IDLE_RUNE_DUNGEON_EXPLORE_MS:IDLE_RUNE_DUNGEON_FLOOR_MS))
    ]);
    idleState=result.state;renderIdleState(result.state);
    if(result.cleared){
      showIdleRuneDungeonReward(result);
      if(typeof sfx!=='undefined'&&sfx.idleChest)sfx.idleChest();
    }else{
      idleSpawnFloat(`ÉTAGE ${result.floor}/${result.floors}`,'xp');
      if(typeof sfx!=='undefined'&&sfx.idleHit)sfx.idleHit(false);
    }
  }catch(e){idleNotify(e.message,'error');}
  finally{idleRuneDungeonBusy=false;idleRuneDungeonActiveKind=null;renderIdleRuneDungeon(idleState);}
}
function renderIdleInventory(state){
  const inventory=state.inventory;const grid=document.getElementById('idle-inventory-grid');if(!inventory||!grid)return;
  document.querySelectorAll('#idle-item-filters [data-item-filter]').forEach((button)=>{button.classList.toggle('active',button.dataset.itemFilter===idleItemFilter);button.dataset.count=button.dataset.itemFilter==='all'?inventory.items.length:inventory.items.filter((item)=>item.kind===button.dataset.itemFilter).length;});
  for(const [id,value] of [['idle-item-sort',idleItemSort],['idle-item-rarity',idleItemRarity],['idle-item-status',idleItemStatus]]){const select=document.getElementById(id);if(select)select.value=value;}
  const searchInput=document.getElementById('idle-item-search');if(searchInput&&searchInput.value!==idleItemSearch)searchInput.value=idleItemSearch;
  const recommendedToggle=document.getElementById('idle-item-recommended-only');
  const capacity=document.getElementById('idle-inventory-capacity');if(capacity)capacity.textContent=`${inventory.count} / ${inventory.capacity}`;
  const bulk=inventory.bulkEnhance||{};const equippedCount=inventory.summary?.equipped||0;const bulkSummary=document.getElementById('idle-equipment-bulk-summary');if(bulkSummary)bulkSummary.textContent=equippedCount?`${equippedCount} objet${equippedCount>1?'s':''} porté${equippedCount>1?'s':''} · Tous +1 : ${idleFormatNumber(bulk.one||0)} Essence · Tous +5 : ${idleFormatNumber(bulk.five||0)} Essence`:'Aucun objet porté, y compris sur les héros au repos.';
  const unequipAll=document.getElementById('idle-unequip-all');if(unequipAll)unequipAll.disabled=!equippedCount;const enhanceOne=document.getElementById('idle-enhance-all-one');if(enhanceOne)enhanceOne.disabled=!bulk.eligible||state.essence<=0;const enhanceFive=document.getElementById('idle-enhance-all-five');if(enhanceFive)enhanceFive.disabled=!bulk.eligible||state.essence<=0;
  const summary=document.getElementById('idle-item-collection-stats');if(summary){const s=inventory.summary||{};summary.innerHTML=`<span><i class="fas fa-layer-group"></i><b>${s.worlds||0}</b><small>Sets découverts</small></span><span><i class="fas fa-wand-sparkles"></i><b>${s.effects||0}</b><small>Stats différentes</small></span><span><i class="fas fa-circle-check"></i><b>${s.completeFamilies||0}</b><small>Sets assemblables</small></span><span><i class="fas fa-user-shield"></i><b>${s.equipped||0}</b><small>Objets équipés</small></span>`;}
  const setCodex=document.getElementById('idle-set-codex');if(setCodex)setCodex.innerHTML=(inventory.sets||[]).map((set)=>{const count=inventory.items.filter((item)=>item.setKey===set.key).length;const ready=Math.floor(count/(set.required||2));const mode=IDLE_SET_MODE_META[set.mode]||IDLE_SET_MODE_META.dps;return `<button type="button" class="mode-${escapeHtml(set.mode||'dps')} ${idleItemSet===set.key?'active':''} ${ready?'ready':''}" data-codex-set="${escapeHtml(set.key)}" aria-pressed="${idleItemSet===set.key}"><i class="fas ${mode.icon}"></i><span><small>${escapeHtml(mode.label).toUpperCase()} · ${set.required||2} OBJETS</small><b>${escapeHtml(set.name)}</b><em>${escapeHtml(set.description||'Bonus de panoplie')}</em></span><strong>${count}<small>pièce${count>1?'s':''}</small>${ready?`<i class="fas fa-circle-check" title="${ready} bonus assemblable${ready>1?'s':''}"></i>`:''}</strong></button>`;}).join('');
  const setSelect=document.getElementById('idle-item-set');if(setSelect){const current=idleItemSet;setSelect.innerHTML='<option value="all">Tous les sets</option>'+(inventory.sets||[]).map((set)=>`<option value="${escapeHtml(set.key)}">${escapeHtml(set.name)}</option>`).join('');setSelect.value=(inventory.sets||[]).some((set)=>set.key===current)?current:'all';idleItemSet=setSelect.value;}
  const active=(state.slots||[]).filter((s)=>s.character);
  if(!active.some((slot)=>slot.index===idleEquipmentTargetSlot)){idleEquipmentTargetSlot=active[0]?.index??null;persistIdleInventoryPrefs();}
  const target=active.find((slot)=>slot.index===idleEquipmentTargetSlot)||null;
  const targetSelect=document.getElementById('idle-equipment-target');if(targetSelect)targetSelect.innerHTML=active.length?active.map((slot)=>`<option value="${slot.index}" ${slot.index===idleEquipmentTargetSlot?'selected':''}>${escapeHtml(slot.character.name)} · ${escapeHtml(idleRoleFor(slot.character).name)}</option>`).join(''):'<option>Aucun héros actif</option>';
  if(targetSelect)targetSelect.disabled=!active.length;
  const targetName=document.getElementById('idle-equipment-target-name');if(targetName)targetName.textContent=target?.character?.name||'Aucun héros actif';
  const targetHint=document.getElementById('idle-equipment-target-hint');if(targetHint)targetHint.textContent=target?`${idleRoleFor(target.character).name} · les comparaisons ci-dessous concernent ce héros.`:'Ajoute d’abord un personnage dans l’équipe.';
  const recommendedItems=idleRecommendedItems(idleEquipmentTargetSlot);if(!active.length&&idleItemRecommendedOnly){idleItemRecommendedOnly=false;persistIdleInventoryPrefs();}if(recommendedToggle){recommendedToggle.disabled=!active.length;recommendedToggle.classList.toggle('active',idleItemRecommendedOnly);recommendedToggle.setAttribute('aria-pressed',String(idleItemRecommendedOnly));}
  const loadouts=document.getElementById('idle-loadouts');
  if(loadouts)loadouts.innerHTML=active.length?active.map((slot)=>{
    const equipped=inventory.items.filter((x)=>x.equippedSlotIndex===slot.index);
    const total=equipped.reduce((sum,item)=>sum+(item.effectiveBonus||item.bonus||0),0);
    const setStatuses=idleItemSetStatuses(equipped);const activeSets=setStatuses.filter((set)=>set.stacks>0);
    const selected=slot.index===idleEquipmentTargetSlot;
    const setDetails=setStatuses.length?setStatuses.map((set)=>{const mode=IDLE_SET_MODE_META[set.mode]||IDLE_SET_MODE_META.dps;return `<span class="${set.stacks?'active':'incomplete'} mode-${escapeHtml(set.mode||'dps')}"><i class="fas ${mode.icon}"></i><span><small>SET ${escapeHtml(set.name).toUpperCase()} · EFFET ${mode.label.toUpperCase()} · ${set.count} OBJET${set.count>1?'S':''}</small><b>${escapeHtml(set.description)}</b><em>${set.stacks?`${set.stacks} bonus actif${set.stacks>1?'s':''}${set.count%set.required?` · encore ${set.missing} pour le suivant`:''}`:`Encore ${set.missing} objet${set.missing>1?'s':''} requis`}</em></span></span>`;}).join(''):'<span class="empty"><i class="fas fa-circle-info"></i><span><small>AUCUN SET COMMENCÉ</small><b>Équipe plusieurs objets du même set pour obtenir un bonus.</b></span></span>';
    return `<article class="idle-loadout ${activeSets.length?'complete':''} ${selected?'selected':''}"><header><span class="idle-loadout-portrait" role="img" aria-label="Portrait de ${escapeHtml(slot.character.name)}" ${slot.character.imageUrl?`style="background-image:url('${escapeHtml(slot.character.imageUrl)}')"`:''}></span><span><small>${escapeHtml(idleRoleFor(slot.character).name)} · ${equipped.length}/6 objets</small><b>${escapeHtml(slot.character.name)}</b><em><i class="fas fa-layer-group"></i> ${activeSets.length?`${activeSets.length} bonus de set actif${activeSets.length>1?'s':''}`:'Aucun bonus de set actif'}</em></span><strong title="Puissance cumulée des objets">+${Math.round(total*100)}%</strong><span class="idle-loadout-actions"><button type="button" class="idle-loadout-select" data-loadout-target="${slot.index}"><i class="fas ${selected?'fa-circle-check':'fa-crosshairs'}"></i> ${selected?'Héros sélectionné':'Équiper ce héros'}</button>${(!selected&&target&&equipped.length)?`<button type="button" class="idle-loadout-transfer" data-loadout-transfer="${slot.index}" title="Retire les ${equipped.length} objets équipés ici et les équipe directement sur ${escapeHtml(target.character.name)}"><i class="fas fa-right-left"></i> Transférer vers ${escapeHtml(target.character.name)}</button>`:''}</span></header><div class="idle-loadout-set-status">${setDetails}</div><div class="idle-loadout-items">${IDLE_RUNE_KINDS.map((kind)=>{const meta=IDLE_ITEM_META[kind];const item=equipped.find((x)=>x.kind===kind);return item?`<button type="button" data-loadout-empty="${kind}" data-loadout-slot="${slot.index}" class="r-${item.rarity}" title="Remplacer ${escapeHtml(item.name)}">${idleItemArt(item,'mini')}<span><small>${meta.label} · Set ${escapeHtml(item.setName||'Énergie')}</small><b>+${item.enhancementLevel||0} · ${escapeHtml(item.name)}</b><em>${escapeHtml(idleItemEffect(item))} · cliquer pour remplacer</em></span><strong>${Math.round((item.effectiveBonus||item.bonus||0)*100)}%</strong><i class="fas fa-repeat"></i></button>`:`<button type="button" class="idle-loadout-empty" data-loadout-empty="${kind}" data-loadout-slot="${slot.index}" title="Choisir un objet pour ${escapeHtml(slot.character.name)}"><i class="fas ${meta.icon}"></i><span><small>${meta.label}</small><b><i class="fas fa-plus"></i> Équiper rapidement</b></span><i class="fas fa-chevron-right"></i></button>`;}).join('')}</div></article>`;
  }).join(''):'<p class="hint">Assigne un personnage à ton équipe pour pouvoir l’équiper.</p>';
  const normalizedSearch=idleNormalizeSearch(idleItemSearch);
  let items=inventory.items.filter((x)=>(idleItemFilter==='all'||x.kind===idleItemFilter)
    &&(idleItemRarity==='all'||x.rarity===idleItemRarity)
    &&(idleItemSet==='all'||x.setKey===idleItemSet)
    &&(idleItemStatus==='all'||(idleItemStatus==='free'&&!x.equipped&&!x.locked)||(idleItemStatus==='equipped'&&x.equipped)||(idleItemStatus==='resting'&&x.equippedResting)||(idleItemStatus==='locked'&&x.locked))
    &&(!normalizedSearch||idleItemSearchHaystack(x).includes(normalizedSearch))
    &&(!idleItemRecommendedOnly||recommendedItems.has(x.id)));
  items=[...items].sort((a,b)=>idleItemSort==='recent'?new Date(b.obtainedAt)-new Date(a.obtainedAt):idleItemSort==='rarity'?(IDLE_RARITY_ORDER[b.rarity]-IDLE_RARITY_ORDER[a.rarity]):((b.effectiveBonus||b.bonus)-(a.effectiveBonus||a.bonus)));
  const results=document.getElementById('idle-inventory-results');if(results){const filters=[idleItemFilter!=='all'?'emplacement':null,idleItemRarity!=='all'?'rareté':null,idleItemSet!=='all'?'set':null,idleItemStatus!=='all'?'état':null,normalizedSearch?'recherche':null,idleItemRecommendedOnly?'conseillés':null].filter(Boolean);results.innerHTML=`<span><i class="fas fa-boxes-stacked"></i><b>${items.length}</b> objet${items.length>1?'s':''} affiché${items.length>1?'s':''} sur ${inventory.items.length}</span>${target?`<span><i class="fas fa-wand-magic-sparkles"></i><b>${recommendedItems.size}</b> choix conseillé${recommendedItems.size>1?'s':''} pour ${escapeHtml(target.character.name)}</span>`:''}${filters.length?`<em>${filters.length} filtre${filters.length>1?'s':''} actif${filters.length>1?'s':''}</em>`:''}`;}
  const salvageableIds=new Set(inventory.items.filter((item)=>!item.locked&&!item.equipped).map((item)=>item.id));idleSelectedItems=new Set([...idleSelectedItems].filter((id)=>salvageableIds.has(id)));
  grid.innerHTML=items.length?items.map((item)=>{
    const meta=IDLE_ITEM_META[item.kind]||IDLE_ITEM_META.rune1;const equipped=item.equipped;const selectable=!item.locked&&!equipped;const selected=idleSelectedItems.has(item.id);const defaultSlot=equipped&&item.equippedSlotIndex!==null?item.equippedSlotIndex:idleEquipmentTargetSlot;const maxed=(item.enhancementLevel||0)>=15;const setProjection=idleItemSetProjection(item,defaultSlot);
    const recommendation=recommendedItems.get(item.id);
    const expanded=idleExpandedItems.has(item.id);
    const [primaryAffix]=item.affixesDetailed||[];
    // Un objet équipé sur un héros laissé au repos (pas dans l'équipe active)
    // reste « équipé » — il ne se fait plus hériter par qui prend sa place —
    // mais on le précise pour éviter de croire qu'il produit en ce moment.
    const setState=setProjection?`<strong class="${setProjection.stacks?'active':'incomplete'}">${setProjection.stacks?`BONUS ACTIF${setProjection.stacks>1?` ×${setProjection.stacks}`:''}`:`MANQUE ${setProjection.missing}`}</strong><em>${setProjection.count} objet${setProjection.count>1?'s':''} de ce set après équipement · ${setProjection.required} requis par bonus${setProjection.stacks&&setProjection.count%setProjection.required?` · encore ${setProjection.missing} pour le bonus suivant`:''}</em>`:'<strong class="incomplete">ÉTAT NON CALCULÉ</strong><em>Réactive ce héros pour voir la progression exacte du set.</em>';
    const setMode=IDLE_SET_MODE_META[item.setMode]||IDLE_SET_MODE_META.dps;
    const body=`<div class="idle-item-set ${setProjection?.stacks?'active':'incomplete'} mode-${escapeHtml(item.setMode||'dps')}"><i class="fas ${setMode.icon}"></i><span><small>SET ${escapeHtml(item.setName||'Énergie').toUpperCase()} · EFFET ${setMode.label.toUpperCase()}</small><b>${escapeHtml(item.setDescription||'Bonus de set')}</b>${setState}</span></div><div class="idle-item-substats"><small>${primaryAffix?`EFFET UNIQUE : ${escapeHtml(primaryAffix.label)} +${Math.round(primaryAffix.value*100)}%`:'SOUS-STATS'}</small><div>${idleRuneDetailChips(item)}</div></div>${equipped?`<p class="idle-item-equipped"><i class="fas fa-user-shield"></i><span>Équipé sur <b>${escapeHtml(item.equippedCharacter||'un héros')}</b>${item.equippedResting?'<em>Hors de l’équipe active : ses bonus ne produisent pas actuellement.</em>':''}</span></p>${(target&&item.equippedSlotIndex!==idleEquipmentTargetSlot)?`<div class="idle-item-target-summary"><small>COMPARÉ AU HÉROS SÉLECTIONNÉ</small><b>${escapeHtml(target.character.name)}</b></div><div data-item-comparison>${idleItemComparison(item,idleEquipmentTargetSlot)}</div>`:''}`:active.length?`<div class="idle-item-target-summary"><small>COMPARAISON POUR</small><b>${escapeHtml(target?.character?.name||'le héros sélectionné')}</b></div><div data-item-comparison>${idleItemComparison(item,defaultSlot)}</div>`:'<p class="idle-item-equipped">Aucun héros actif</p>'}<footer>${equipped?`<button class="btn-secondary" data-item-enhance="${item.id}" data-item-enhance-amount="1" ${maxed||idleState.essence<item.enhanceCost?'disabled':''}><i class="fas fa-plus"></i> ${maxed?'Niveau maximum':`+1 · ${idleFormatNumber(item.enhanceCost)} Essence`}</button><button class="btn-primary" data-item-enhance="${item.id}" data-item-enhance-amount="max" ${maxed||idleState.essence<item.enhanceCost?'disabled':''}><i class="fas fa-angles-up"></i> Jusqu’à +15</button>${(active.length&&target&&item.equippedSlotIndex!==idleEquipmentTargetSlot)?`<button class="btn-secondary" data-item-equip="${item.id}" title="Retire l’objet du héros actuel et l’équipe directement sur ${escapeHtml(target.character.name)}"><i class="fas fa-right-left"></i> Transférer vers ${escapeHtml(target.character.name)}</button>`:''}<button class="btn-secondary" data-item-unequip="${item.id}"><i class="fas fa-arrow-right-from-bracket"></i> Retirer</button>`:active.length?`<button class="btn-primary" data-item-equip="${item.id}"><i class="fas fa-shield-halved"></i> Équiper sur ${escapeHtml(target?.character?.name||'ce héros')}</button>`:''}<button class="btn-secondary" data-item-reroll="${item.id}" ${idleState.essence<(item.rerollCost||0)?'disabled':''} title="Meulage : re-tire la puissance de l’effet unique et des affixes aux valeurs de ton stage actuel. Le résultat peut être meilleur ou moins bon."><i class="fas fa-dice"></i> Meuler · ${idleFormatNumber(item.rerollCost||0)}</button>${equipped?'':`<button class="btn-secondary danger" data-item-salvage="${item.id}" ${selectable?'':'disabled'}><i class="fas fa-recycle"></i> Recycler · ${idleFormatNumber(item.salvageValue)}</button>`}</footer>`;
    const safeBody=body.replace('Le résultat peut être meilleur ou moins bon.','Le meilleur jet est conservé automatiquement.').replace('> Meuler ·','> Meuler sans risque ·');
    return `<article class="idle-item-card r-${item.rarity} ${equipped?'equipped':''} ${selected?'selected':''} ${expanded?'expanded':''} ${recommendation?'recommended':''}" data-item-id="${item.id}">${recommendation?`<span class="idle-item-recommendation"><i class="fas ${recommendation.completes?'fa-layer-group':'fa-wand-magic-sparkles'}"></i> ${escapeHtml(recommendation.reason)}</span>`:''}<div class="idle-item-row" data-item-expand="${item.id}">${idleItemArt(item,'mini')}<span class="idle-item-row-info"><b>${escapeHtml(item.name)}</b><small>${meta.label} · ${escapeHtml(idleRarityLabel(item.rarity))} · Set ${escapeHtml(item.setName||'Énergie')}</small></span><span class="idle-item-row-stat"><b>${escapeHtml(idleItemEffect(item))}</b><em>+${item.enhancementLevel||0}/15</em></span><strong class="idle-item-status ${equipped?'equipped':'available'}">${equipped?'<i class="fas fa-user-shield"></i>':'<i class="fas fa-circle"></i>'}</strong><span class="idle-item-card-actions"><button type="button" data-item-select="${item.id}" title="${selectable?(selected?'Retirer de la sélection':'Sélectionner pour recycler'):'Verrouillé ou équipé'}" ${selectable?'':'disabled'}><i class="fas ${selected?'fa-square-check':'fa-square'}"></i></button><button type="button" data-item-lock="${item.id}" title="${item.locked?'Déverrouiller':'Protéger cet objet'}"><i class="fas ${item.locked?'fa-lock':'fa-lock-open'}"></i></button><button type="button" class="idle-item-expand-btn" data-item-expand="${item.id}" aria-expanded="${expanded}" title="${expanded?'Réduire':'Voir le détail'}"><i class="fas fa-chevron-down"></i></button></span></div>${expanded?`<div class="idle-item-body">${safeBody}</div>`:''}</article>`;
  }).join(''):'<div class="idle-inventory-empty"><i class="fas fa-box-open"></i><b>Aucun objet dans cette catégorie</b><span>Un filtre peut masquer tes objets équipés ou précieux.</span><button type="button" class="btn-secondary" data-item-reset-filters><i class="fas fa-filter-circle-xmark"></i> Afficher tous les objets</button></div>';
  grid.querySelectorAll('[data-item-id]').forEach((card)=>{const item=inventory.items.find((entry)=>String(entry.id)===card.dataset.itemId);if(item)card.classList.add(`kind-${item.kind}`);});
  renderIdleBulkSelection();
}
async function equipIdleItem(itemId,slotIndex){try{renderIdleState(await api('/api/idle/equipment/equip',{method:'POST',body:JSON.stringify({itemId,slotIndex})}));idleSpawnFloat('ÉQUIPEMENT MODIFIÉ','xp');return true;}catch(e){idleNotify(e.message,'error');return false;}}
async function unequipIdleItem(itemId){try{renderIdleState(await api('/api/idle/equipment/unequip',{method:'POST',body:JSON.stringify({itemId})}));}catch(e){idleNotify(e.message,'error');}}
async function transferIdleEquipment(fromSlotIndex,toSlotIndex){
  if(!Number.isInteger(fromSlotIndex)||!Number.isInteger(toSlotIndex)||fromSlotIndex===toSlotIndex)return;
  try{renderIdleState(await api('/api/idle/equipment/transfer',{method:'POST',body:JSON.stringify({fromSlotIndex,toSlotIndex})}));idleSpawnFloat('ÉQUIPEMENT TRANSFÉRÉ','crit');idleNotify('Tout l’équipement a été transféré vers ce héros.','success');}catch(e){idleNotify(e.message,'error');}
}
async function autoEquipIdleItems(){const button=document.getElementById('idle-auto-equip');if(button){button.disabled=true;button.innerHTML='<i class="fas fa-spinner fa-spin"></i> Remplissage…';}try{const result=await api('/api/idle/equipment/auto-equip',{method:'POST',body:JSON.stringify({})});renderIdleState(result.state);const o=result.optimization||{};if(o.equipped){idleSpawnFloat(`${o.equipped} EMPLACEMENT${o.equipped>1?'S':''} COMBLÉ${o.equipped>1?'S':''}`,'crit');idleNotify(`${o.equipped} pièce${o.equipped>1?'s':''} libre${o.equipped>1?'s':''} équipée${o.equipped>1?'s':''} sur les emplacements vides. Les panoplies restent à construire à la main.`,'success');}else idleNotify('Aucun emplacement de rune vide à combler (ou aucun objet libre du bon type).','success');}catch(e){idleNotify(e.message,'error');}finally{if(button){button.disabled=false;button.innerHTML='<i class="fas fa-shield-halved"></i> Combler les emplacements';}}}
function resetIdleInventoryFilters(){
  idleItemFilter='all';idleItemRarity='all';idleItemSet='all';idleItemStatus='all';idleItemSearch='';idleItemRecommendedOnly=false;
  persistIdleInventoryPrefs();
  document.querySelectorAll('#idle-item-filters [data-item-filter]').forEach((button)=>button.classList.toggle('active',button.dataset.itemFilter==='all'));
  for(const id of ['idle-item-rarity','idle-item-set','idle-item-status']){const select=document.getElementById(id);if(select)select.value='all';}
  const search=document.getElementById('idle-item-search');if(search)search.value='';
}
function focusIdleInventoryItem(itemId){resetIdleInventoryFilters();idleExpandedItems.add(String(itemId));renderIdleInventory(idleState);requestAnimationFrame(()=>{const card=Array.from(document.querySelectorAll('#idle-inventory-grid [data-item-id]')).find((item)=>item.dataset.itemId===String(itemId));card?.scrollIntoView({behavior:'smooth',block:'center'});card?.classList.add('idle-item-focus');setTimeout(()=>card?.classList.remove('idle-item-focus'),1400);});}
async function lockIdleItem(itemId,locked){try{await api('/api/idle/equipment/lock',{method:'POST',body:JSON.stringify({itemId,locked})});const item=idleState.inventory.items.find((x)=>x.id===itemId);if(item)item.locked=locked;renderIdleInventory(idleState);}catch(e){idleNotify(e.message,'error');}}
async function autoLockIdleEquipment(){const button=document.getElementById('idle-equipment-auto-lock');if(button)button.disabled=true;try{const result=await api('/api/idle/equipment/auto-lock',{method:'POST',body:JSON.stringify({})});renderIdleState(result.state);idleNotify(`${result.locked} objets de référence sont maintenant protégés.`,'success');}catch(e){idleNotify(e.message,'error');}finally{if(button)button.disabled=false;}}
async function unequipAllIdleEquipment(){const count=idleState?.inventory?.summary?.equipped||0;if(!count)return;if(!await idleConfirm(`Retirer les ${count} objets portés par tous tes personnages, y compris ceux qui ne sont pas dans l’équipe ?`,{title:'Tout déséquiper ?',confirmLabel:'Tout retirer'}))return;const button=document.getElementById('idle-unequip-all');if(button)button.disabled=true;try{const result=await api('/api/idle/equipment/unequip-all',{method:'POST',body:JSON.stringify({})});renderIdleState(result.state);idleNotify(`${result.removed} objet${result.removed>1?'s':''} retiré${result.removed>1?'s':''}. Tout est maintenant visible dans l’inventaire.`,'success');}catch(e){idleNotify(e.message,'error');}finally{if(button)button.disabled=false;}}
async function enhanceAllIdleEquipment(levels){const preview=levels===5?idleState?.inventory?.bulkEnhance?.five:idleState?.inventory?.bulkEnhance?.one;if(!await idleConfirm(`Améliorer chaque objet équipé jusqu’à ${levels===1?'un niveau':'cinq niveaux'} ? Coût maximum estimé : ${idleFormatNumber(preview||0)} Essence. Si ton solde est insuffisant, le serveur améliore équitablement ce qu’il peut.`,{title:'Amélioration groupée ?',confirmLabel:'Améliorer'}))return;const buttons=['idle-enhance-all-one','idle-enhance-all-five'].map((id)=>document.getElementById(id));buttons.forEach((button)=>{if(button)button.disabled=true;});try{const result=await api('/api/idle/equipment/enhance-all',{method:'POST',body:JSON.stringify({levels})});renderIdleState(result.state);idleSpawnFloat(`${result.bought} ${result.bought>1?'NIVEAUX':'NIVEAU'} D’OBJET`,'xp');idleNotify(`${result.items} objet${result.items>1?'s':''} amélioré${result.items>1?'s':''} · ${idleFormatNumber(result.spent)} Essence dépensée.`,'success');}catch(e){idleNotify(e.message,'error');}finally{buttons.forEach((button)=>{if(button)button.disabled=false;});}}
function renderIdleBulkSelection(){const items=(idleState?.inventory?.items||[]).filter((item)=>idleSelectedItems.has(item.id));const summary=document.getElementById('idle-selected-summary');const button=document.getElementById('idle-salvage-selected');const value=items.reduce((sum,item)=>sum+(item.salvageValue||0),0);if(summary)summary.textContent=items.length?`${items.length} objet${items.length>1?'s':''} · ${idleFormatNumber(value)} Essence estimée`:'Aucun objet sélectionné';if(button)button.disabled=!items.length;}
function toggleIdleItemSelection(itemId){if(idleSelectedItems.has(itemId))idleSelectedItems.delete(itemId);else idleSelectedItems.add(itemId);renderIdleInventory(idleState);}
function selectIdleItemsBySalvageRules(){
  const inventory=idleState?.inventory;if(!inventory)return;
  const rarityLimit=IDLE_RARITY_ORDER[idleSalvageRules.rarity]||IDLE_RARITY_ORDER.rare;
  const protectedSets=new Set(idleSalvageRules.keepSets?(inventory.families||[]).filter((family)=>family.complete).map((family)=>family.key):[]);
  const candidates=(inventory.items||[]).filter((item)=>!item.locked&&!item.equipped
    &&(IDLE_RARITY_ORDER[item.rarity]||0)<=rarityLimit
    &&(item.enhancementLevel||0)<=Number(idleSalvageRules.enhancement||0)
    &&!protectedSets.has(item.setKey));
  idleSelectedItems=new Set(candidates.map((item)=>item.id));
  renderIdleInventory(idleState);
  idleNotify(candidates.length?`${candidates.length} objet${candidates.length>1?'s':''} sélectionné${candidates.length>1?'s':''} selon tes règles. Vérifie puis confirme le recyclage.`:'Aucun objet ne correspond aux règles de recyclage.','success');
}
async function salvageIdleItems(ids){const items=(idleState?.inventory?.items||[]).filter((item)=>ids.includes(item.id));if(!items.length)return;const total=items.reduce((sum,item)=>sum+(item.salvageValue||0),0);const precious=items.some((item)=>['legendary','mythic'].includes(item.rarity));if(!await idleConfirm(`Recycler ${items.length} objet${items.length>1?'s':''} contre environ ${idleFormatNumber(total)} Essence ?${precious?' ATTENTION : la sélection contient un objet légendaire ou mythique.':''}`,{title:'Recycler la sélection ?',confirmLabel:'Recycler'}))return;let preciousConfirmation=false;if(precious){preciousConfirmation=prompt('Protection objet précieux : écris RECYCLER pour confirmer définitivement.')==='RECYCLER';if(!preciousConfirmation){idleNotify('Objet précieux conservé : confirmation annulée.','success');return;}}try{const r=await api('/api/idle/equipment/salvage',{method:'POST',body:JSON.stringify({ids,confirmHighRarity:preciousConfirmation?'RECYCLER':false})});idleSelectedItems.clear();renderIdleState(r.state);idleSpawnFloat(`RECYCLAGE +${idleFormatNumber(r.gained)}`,'xp');}catch(e){idleNotify(e.message,'error');}}
async function salvageIdleItem(itemId){return salvageIdleItems([itemId]);}
async function rerollIdleItem(itemId){
  const item=(idleState?.inventory?.items||[]).find((x)=>x.id===itemId);
  if(!item)return;
  if(!await idleConfirm(`Meulage sécurisé de ${item.name} pour ${idleFormatNumber(item.rerollCost||0)} Essence : si le nouveau total d’affixes est moins bon, l’objet actuel est conservé.`,{title:'Meuler cet objet ?',confirmLabel:'Meuler'}))return;
  try{
    const state=await api('/api/idle/equipment/reroll',{method:'POST',body:JSON.stringify({itemId,keepBest:true})});
    const before=state.reroll?.before?.effectValue||0;const after=state.reroll?.after?.effectValue||0;
    idleSpawnFloat(state.reroll?.kept?'ANCIEN JET CONSERVÉ':'MEULAGE RÉUSSI','xp');
    idleNotify(state.reroll?.kept?'Nouveau jet inférieur : les valeurs précédentes ont été conservées.':`Meulage : effet unique ${Math.round(before*1000)/10}% → ${Math.round(after*1000)/10}%.`,'success');
    renderIdleState(state);
  }catch(e){idleNotify(e.message,'error');}
}

function renderIdleChallenges(items){const box=document.getElementById('idle-challenges');if(!box)return;if(!items.length){box.innerHTML=idleEmptyState('fa-tower-observation','Aucun défi disponible','Les défis combinent plusieurs actions (combat, frappes, améliorations) — ils se renouvellent chaque jour et chaque semaine.');return;}box.innerHTML=items.map((c)=>`<article class="idle-challenge ${c.completed?'done':''}"><header><i class="fas ${c.icon}"></i><div><span>${escapeHtml(c.cadence)} · ${escapeHtml(c.difficulty)}</span><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.description)}</small></div><strong>${c.progress}%</strong></header><div class="idle-challenge-requirements">${(c.requirements||[]).map((r)=>`<span class="${r.progress>=r.target?'done':''}"><i class="fas ${r.progress>=r.target?'fa-check':'fa-circle'}"></i><b>${escapeHtml(r.label)}</b><em>${idleFormatNumber(Math.min(r.progress,r.target))}/${idleFormatNumber(r.target)}</em></span>`).join('')}</div><div class="idle-challenge-footer"><em style="--progress:${Math.min(100,c.progress)}%"></em><button data-challenge-claim="${c.key}" ${!c.completed||c.claimed?'disabled':''}>${c.claimed?'<i class="fas fa-check"></i> Réclamé':`Réclamer +${c.reward} <i class="fas fa-ticket"></i>`}</button></div></article>`).join('');}

function renderIdleMasteries(codex) {
  const masteries = document.getElementById('idle-masteries');
  if (masteries) masteries.innerHTML = (codex?.masteries || []).length ? codex.masteries.map((m) => `<div class="idle-mastery"><i class="fas fa-star"></i><div><b>${escapeHtml(m.series)}</b><span>${m.recruits} recrue(s), saisons réunies · ${idleFormatNumber(m.levels)} niveaux cumulés</span><em style="--progress:${m.next ? Math.min(100,m.levels/m.next*100) : 100}%"></em></div><strong>Palier ${m.tier}/${m.maxTier} · +${Math.round(m.bonus*100)}%</strong><small>${m.next ? `Prochain bonus niv. ${m.next}` : 'MAÎTRISE MAX'}</small></div>`).join('') : '<p class="hint">Recrute puis entraîne des héros pour découvrir leurs licences.</p>';
}

// Frise des paliers de décor (Progression) — équivalent simplifié d'une
// carte du monde : notre progression est une séquence linéaire de paliers
// (dojo.tiers, liste statique envoyée par le serveur), pas un graphe de
// zones à embranchements.
function renderIdleRoadmap(codex,battle) {
  const box = document.getElementById('idle-roadmap');
  if (!box || !Array.isArray(codex?.worlds)) return;
  const currentIndex=Math.max(0,Math.floor(((battle?.world?.startStage||battle?.stage||1)-1)/10));
  box.innerHTML = codex.worlds.map((tier, i) => {
    const isCurrent = i === currentIndex;
    const isDone = currentIndex >= 0 && i < currentIndex;
    const cls = isCurrent ? 'current' : (isDone ? 'done' : '');
    const dotContent = isCurrent ? '<i class="fas fa-fire"></i>' : (isDone ? '<i class="fas fa-check"></i>' : idleFormatNumber(tier.level));
    return `<div class="idle-roadmap-step ${cls}">
      <span class="idle-roadmap-dot">${dotContent}</span>
      <span class="idle-roadmap-name">${escapeHtml(tier.name.split(' · ')[0])}</span>
      <span class="idle-roadmap-level">Acte ${tier.act||1} · Niveau ${idleFormatNumber(tier.level)}</span>
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

function renderIdleWorldJump(codex,battle){
  const list=document.getElementById('idle-world-jump-list');if(!list||!Array.isArray(codex?.worlds))return;
  const currentIndex=Math.max(0,Math.floor(((battle?.world?.startStage||battle?.stage||1)-1)/10));const bestStage=Math.max(1,battle?.runBestStage||battle?.bestStage||battle?.stage||1);
  // Un monde découvert lors d'une run précédente mais pas encore atteint dans
  // CETTE run reste verrouillé (le voyage ne saute jamais de progression) —
  // mais afficher « Pas encore découvert » laissait croire à un bug (retour
  // joueur : « je peux pas changer de monde ») : on explique la vraie raison.
  list.innerHTML=codex.worlds.map((world,index)=>{const unlocked=world.discovered&&world.level<=bestStage;const current=index===currentIndex;return `<button type="button" class="${current?'current':''}" data-world-stage="${world.level}" ${!unlocked?'disabled':''}><span class="idle-world-number">${unlocked?index+1:'<i class="fas fa-lock"></i>'}</span><span><small>ACTE ${world.act||1} · NIVEAUX ${world.level}–${world.level+9}</small><b>${escapeHtml(world.name.split(' · ')[0])}</b><em>${current?'Monde actuel':unlocked?`${escapeHtml(world.difficulty||'Normal')} · voyager au niveau ${world.level}`:world.discovered?`Atteins le niveau ${world.level} dans cette run pour y voyager`:'Pas encore découvert'}</em></span>${current?'<i class="fas fa-location-dot"></i>':'<i class="fas fa-arrow-right"></i>'}</button>`;}).join('');
}

// Le joueur est le héros actif : son apparence vient du profil (avatar + cadre),
// sa puissance vient de Concentration. Les recrues restent une équipe passive.
function renderIdleMainHero(state) {
  const hero = document.getElementById('idle-main-hero');
  const avatar = document.getElementById('idle-main-hero-avatar');
  const active=(state.slots||[]).filter((slot)=>slot.character);
  const leader=(active.find((slot)=>slot.character.id===state.strategy?.leaderCharacterId)||active[0])?.character;
  const baseHeroes={warrior:'/assets/idle/fighters/goku.webp',mage:'/assets/idle/fighters/gojo.webp',ninja:'/assets/idle/fighters/naruto.webp',swordsman:'/assets/idle/fighters/ichigo.webp',summoner:'/assets/idle/fighters/tanjiro.webp'};
  const portrait=leader?.imageUrl||baseHeroes[state.heroClass?.key]||baseHeroes.warrior;
  if (hero) { hero.className = `idle-main-hero aura-${state.heroStyle?.aura || 'none'} stance-${state.heroStyle?.stance || 'balanced'} hair-${state.heroStyle?.hair || 'short'} outfit-${state.heroStyle?.outfit || 'dojo'} energy-${state.heroStyle?.color || 'red'} ${leader?'':'no-team'}`;hero.setAttribute('aria-label',leader?'Personnaliser le personnage principal':'Choisir un héros pour l’équipe'); }
  if (avatar) {
    avatar.className='idle-main-hero-avatar';
    avatar.innerHTML='';
    avatar.style.backgroundImage=`url('${portrait}')`;
  }
  const name = document.getElementById('idle-main-hero-name');
  if (name) name.textContent = leader?.name || `${state.heroClass?.name||'Guerrier'} de base`;
  const power = document.getElementById('idle-main-hero-power');
  const titleChoice = state.heroStyle?.choices?.titles?.find((x)=>x.selected);
  const canRestore=!leader&&Number(state.collection?.recruits||0)>0;
  if (power) power.innerHTML = leader?`<i class="fas ${state.heroClass?.icon || 'fa-shield-halved'}"></i> ${escapeHtml(titleChoice?.name || 'Novice d’Ascension')} · ${escapeHtml(state.heroClass?.name || 'Guerrier')} · ${idleFormatNumber(state.click.damage ?? state.click.yield)} puissance${state.heroClass?.passiveStatus?`<strong class="idle-class-passive-status ${state.heroClass.passiveActive?'active':''}">${escapeHtml(state.heroClass.passiveStatus)}</strong>`:''}`:canRestore?'Tes héros sont encore recrutés · restaure ta formation':'Ouvre l’onglet Équipe pour commencer';
  // Une fois un chef actif, le bouton de personnalisation disparaît de la
  // scène : posé sur le héros au centre du combat, il se faisait déclencher
  // par erreur en tapant pour attaquer les mobs/orbes (retour testeur).
  // L'accès reste dans l'onglet Équipe (#idle-open-hero-style) ; ici, le
  // bouton ne sert plus qu'aux deux états d'onboarding (pas encore de chef).
  const action=document.getElementById('idle-customize-hero');if(action){action.classList.toggle('hidden',!!leader);action.title=canRestore?'Restaurer automatiquement mon équipe':'Choisir un héros';action.innerHTML=canRestore?'<i class="fas fa-users-gear"></i><span>Restaurer l’équipe</span>':'<i class="fas fa-user-plus"></i><span>Choisir un héros</span>';}
}

function openIdleMainHeroAction(){if(!document.getElementById('idle-main-hero')?.classList.contains('no-team'))return;if(Number(idleState?.collection?.recruits||0)>0)return optimizeIdleTeam();idleShowPanel('team');}

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
  const bestStage = Math.max(stage, battle?.runBestStage || battle?.bestStage || stage);
  const wave = ((stage - 1) % 10) + 1;
  const zone = Math.floor((stage - 1) / 10) + 1;
  const boss = wave === 10;
  const farming = battle?.mode === 'farm';
  const stageCurrent=document.getElementById('idle-stage-current');if(stageCurrent)stageCurrent.textContent=idleFormatNumber(stage);
  const stageLocation=document.getElementById('idle-stage-location');if(stageLocation)stageLocation.textContent=`Monde ${zone} · Vague ${wave}/10${farming?' · FARM':''}`;
  const stageBestValue=document.getElementById('idle-stage-best-value');if(stageBestValue)stageBestValue.textContent=idleFormatNumber(bestStage);
  const stagePrev=document.getElementById('idle-stage-prev');if(stagePrev){stagePrev.disabled=stage<=1;stagePrev.dataset.stage=String(stage-1);}
  const stageNext=document.getElementById('idle-stage-next');if(stageNext){stageNext.disabled=stage>=bestStage;stageNext.dataset.stage=String(stage+1);}
  const stageBest=document.getElementById('idle-stage-best');if(stageBest){stageBest.disabled=stage>=bestStage;stageBest.dataset.stage=String(bestStage);}
  const enemiesRequired = Math.max(1, battle?.enemiesRequired || 1);
  const enemiesRemaining = Math.max(1, battle?.enemiesRemaining || enemiesRequired);
  const enemyNumber = Math.max(1, Math.min(enemiesRequired, battle?.enemyNumber || 1));
  const mechanicEl = document.getElementById('idle-boss-mechanic');
  if (mechanicEl) {
    const mechanic=battle?.mechanic;
    mechanicEl.classList.toggle('hidden', !boss||!mechanic);
    mechanicEl.classList.toggle('idle-boss-mechanic-warning',mechanic?.key==='rage'||mechanic?.key==='counter');
    mechanicEl.innerHTML = boss&&mechanic ? `<i class="fas ${IDLE_BOSS_MECHANIC_ICONS[mechanic.key]||'fa-shield-halved'}"></i><span><b>${escapeHtml(mechanic.name)}</b><small>${escapeHtml(mechanic.description)}</small></span>${mechanic.required?`<strong>${Math.min(mechanic.progress,mechanic.required)}/${mechanic.required}</strong>`:''}` : '';
    // Le joueur doit voir tout de suite QUEL bouton presser pour cette mécanique
    // (retour joueur : la phase de Boss n'indiquait pas clairement l'action à
    // faire) : on fait briller le bouton concerné plutôt que de compter sur la
    // seule description texte.
    const wantsAttack=boss&&mechanic&&['shield','focus'].includes(mechanic.key)&&mechanic.progress<(mechanic.required||1);
    const wantsUltimate=boss&&mechanic&&(mechanic.key==='regen'||(mechanic.key==='focus'&&mechanic.progress>=(mechanic.required||1)));
    const wantsCombo=boss&&mechanic&&mechanic.key==='ward'&&mechanic.progress<1;
    document.getElementById('idle-click-btn')?.classList.toggle('idle-mechanic-target',!!wantsAttack);
    document.getElementById('idle-skill-burst')?.classList.toggle('idle-mechanic-target',!!wantsUltimate);
    document.getElementById('idle-skill-team')?.classList.toggle('idle-mechanic-target',!!wantsCombo);
  }
  const remaining = Math.max(0, battle?.hp ?? ((battle?.xpForNextStage || 0) - (battle?.xpIntoStage || 0)));
  const total = Math.max(1, battle?.maxHp || battle?.xpForNextStage || 1);
  const guardianName = battle?.world?.enemyName || (boss ? `Boss de la zone ${zone}` : 'Gardien ennemi');
  const zoneEl = document.getElementById('idle-battle-zone');
  const tagEl = document.getElementById('idle-battle-tag');
  const titleEl = document.getElementById('idle-enemy-title');
  const waveTrack = document.getElementById('idle-wave-track');
  const bossTimer=document.getElementById('idle-boss-timer');
  const modifierEl=document.getElementById('idle-world-modifier');
  if(modifierEl){const modifier=battle?.world?.modifier;modifierEl.innerHTML=modifier?`<i class="fas fa-diamond"></i> <b>${escapeHtml(modifier.name)}</b>`:'';modifierEl.title=modifier?.description||'Règle spéciale appliquée dans ce monde';}
  const objective=document.getElementById('idle-next-objective');
  if(objective){objective.classList.toggle('is-farming',farming);objective.innerHTML=`<i class="fas ${farming?'fa-coins':boss?'fa-crown':'fa-forward-step'}"></i><span><b>${farming?`MODE FARM · la vague ${wave} recommence après le dernier ennemi`:boss?'Vague 10/10 · Boss final':`Vague ${wave}/10 · ${enemiesRemaining} ennemi${enemiesRemaining>1?'s':''} restant${enemiesRemaining>1?'s':''}`}</b><small>${farming?'Choisis Progression pour passer à la vague suivante':boss?'Vaincs-le pour passer au monde suivant':`${escapeHtml(battle?.enemy?.name||'Standard')} · ${escapeHtml(battle?.enemy?.description||'')} · +${idleFormatNumber(battle?.reward||0)} Essence`}</small></span><strong>${farming?'Répète':boss?'Monde suivant':`Puis vague ${wave+1}`}</strong>`;}
  if (waveTrack) {
    waveTrack.classList.toggle('is-boss', boss);
    waveTrack.setAttribute('aria-label', boss ? 'Boss final de la vague' : `${battle?.enemiesDefeated||0} ennemis vaincus sur ${enemiesRequired}`);
    waveTrack.innerHTML = boss
      ? `<span class="idle-wave-boss"><i class="fas fa-crown"></i> BOSS FINAL</span>`
      : Array.from({length:enemiesRequired},(_,index)=>`<span class="${index<(battle?.enemiesDefeated||0)?'done':index===enemyNumber-1?'current':''}"><i class="fas ${index<(battle?.enemiesDefeated||0)?'fa-check':'fa-skull'}"></i><b>${index+1}</b></span>`).join('');
  }
  if(bossTimer){const total=Math.max(1,(battle?.timerSeconds||30)*1000);const remaining=Math.max(0,battle?.timerRemainingMs??total);bossTimer.classList.toggle('hidden',!boss);bossTimer.dataset.total=String(total);bossTimer.dataset.deadline=String(Date.now()+remaining);if(boss)idleUpdateBossTimer();else document.getElementById('idle-boss-ring')?.classList.add('hidden');}
  if (zoneEl) zoneEl.textContent = `ACTE ${battle?.world?.act||1} · ${battle?.world?.difficulty?.name?.toUpperCase()||'NORMAL'} · MONDE ${battle?.world?.index||zone}/10 · ${boss ? `VAGUE 10/10 · BOSS · PHASE ${battle.phase||1}/2${battle.enraged?' · ENRAGÉ':''}` : `VAGUE ${wave}/10 · ENNEMI ${enemyNumber}/${enemiesRequired}`}`;
  if (tagEl) { tagEl.textContent = battle?.needsBossEngage ? 'BOSS · VERROUILLÉ' : battle?.bossFailed ? 'MUR · FARM AUTO' : boss ? 'BOSS' : battle?.enemy?.name?.toUpperCase()||(battle?.isElite?'ÉLITE':'ENNEMI'); tagEl.className=`idle-battle-tag ${boss?'boss':`enemy-${battle?.enemy?.key||'standard'}`}`; }
  if (titleEl) titleEl.textContent = guardianName;
  const engageBtn = document.getElementById('idle-boss-engage-btn');
  if (engageBtn) engageBtn.classList.toggle('hidden', !battle?.needsBossEngage);
  const sameVisualEnemy = idleVisualStage === stage && idleVisualEnemyNumber === enemyNumber && idleVisualHp !== null;
  if (!sameVisualEnemy || idleForceHpSync) {
    idleResetVisualHp({ ...battle, hp: remaining, maxHp: total });
    idleForceHpSync = false;
  }
  else {
    idleVisualMaxHp = total;
    idleVisualHp = Math.min(idleVisualHp, remaining);
    idlePaintVisualHp(idleVisualHp, idleVisualMaxHp, true);
  }
  // Le stage a avancé depuis le dernier rendu (au moins un kill) : retour
  // léger et fréquent, distinct de la célébration (confettis) réservée aux
  // vrais niveaux de Dojo.
  if (prevBattle && (battle?.kills || 0) > (prevBattle?.kills || 0)) {
    const previousStage=Math.max(1,prevBattle.stage||1);const skippedStages=stage>previousStage+1;
    if(skippedStages)idleShowWaveSequence(previousStage,stage);
    idleKillBurst((battle?.kills || 0) - (prevBattle?.kills || 0), stage > previousStage);
    // Un capitaine ou une élite vaincu(e) lâche parfois un butin cliquable —
    // même mécanique (et même garde-fou serveur) que l'orbe bonus.
    const specialKilled=prevBattle?.enemy?.key==='captain'||prevBattle?.isElite;
    if(specialKilled&&Math.random()<.3)idleSpawnOrb('chest');
    const farmRestart=farming&&stage===previousStage&&(battle?.enemiesDefeated||0)<(prevBattle?.enemiesDefeated||0);
    if(!skippedStages)idleAnnounce(farmRestart?`Mode Farm. La vague ${wave} recommence.`:stage>previousStage?`Vague terminée. Vague ${wave} commencée.`:`Ennemi vaincu. ${enemiesRemaining} restant${enemiesRemaining>1?'s':''}.`);
  }
}

function idleRenderSkillCooldown() {
  const btn = document.getElementById('idle-skill-burst');
  const label = document.getElementById('idle-skill-status');
  if (!btn || !label) return;
  const left = Math.max(0, idleBurstReadyAt - Date.now());
  // idleTick() rappelle cette fonction toutes les 400ms avec les timestamps
  // de recharge encore périmés (mis à jour seulement à la réponse serveur) :
  // sans le flag "pending", ce tick réactivait le bouton une fraction de
  // seconde après le clic, avant même que la requête n'ait abouti — effet
  // visuel de "rollback" (retour joueur : le bouton grise puis reprend sa
  // couleur sans que le sort ne parte).
  btn.disabled = idleBurstPending || left > 0;
  const teamBtn = document.getElementById('idle-skill-team'); const teamLabel = document.getElementById('idle-team-skill-status');
  const skills=idleState?.battle?.skills||{};
  const ultimateExplanation=document.getElementById('idle-ultimate-explanation');if(ultimateExplanation)ultimateExplanation.textContent=`${idleFormatNumber(skills.burstDamage||0)} dégâts · compte comme 75 clics · recharge ${skills.burstCooldownSeconds||90}s`;
  const comboExplanation=document.getElementById('idle-combo-explanation');if(comboExplanation)comboExplanation.textContent=`${idleFormatNumber(skills.teamDamage||0)} dégâts · ${skills.uniqueRoles||1} rôle${(skills.uniqueRoles||1)>1?'s':''} unique${(skills.uniqueRoles||1)>1?'s':''} · recharge ${skills.teamCooldownSeconds||150}s`;
  if (teamBtn && teamLabel) { const teamLeft = Math.max(0, idleTeamSkillReadyAt - Date.now()); const count = idleState?.slots?.filter((s) => s.character).length || 0; teamBtn.disabled = idleTeamSkillPending || teamLeft > 0 || count < 2; teamLabel.textContent = count < 2 ? '2 héros requis' : (teamLeft > 0 ? `Recharge · ${Math.ceil(teamLeft / 1000)}s` : `Prêt · ${idleFormatNumber(skills.teamDamage)} dégâts · recharge ${skills.teamCooldownSeconds||150}s`); }
  label.textContent = left > 0 ? `Recharge · ${Math.ceil(left / 1000)}s` : `Prêt · ${idleFormatNumber(skills.burstDamage||((idleState?.click?.damage||1)*25))} dégâts · recharge ${skills.burstCooldownSeconds||90}s`;
}

function idleShowSkillImpact(kind, damage, killed) {
  const scene=document.getElementById('idle-scene');if(!scene)return;
  const old=scene.querySelector('.idle-skill-impact');old?.remove();
  const impact=document.createElement('div');impact.className=`idle-skill-impact ${kind}`;
  impact.innerHTML=`<i class="fas ${kind==='ultimate'?'fa-burst':'fa-people-group'}"></i><span><small>${kind==='ultimate'?'ULTIME DÉCHAÎNÉ':'COMBO D’ÉQUIPE'}</small><b>−${idleFormatNumber(damage)} PV</b><em>${killed?'ENNEMI VAINCU':kind==='ultimate'?'Frappe majeure':'Bonus de rôles appliqué'}</em></span>`;
  scene.appendChild(impact);setTimeout(()=>impact.remove(),1350);
}

let idleBurstPending = false;
async function idleUseBurst(event) {
  event?.stopPropagation();
  if (Date.now() < idleBurstReadyAt || idleBurstPending) return;
  idleBurstPending = true;
  const btn = document.getElementById('idle-skill-burst'); if (btn) btn.disabled = true;
  try {
    const result = await api('/api/idle/skill/burst', { method: 'POST', body: JSON.stringify({}) });
    idleBurstReadyAt = result.readyAt ? new Date(result.readyAt).getTime() : Date.now() + result.cooldownMs;
    const scene = document.getElementById('idle-scene');
    scene?.classList.add('skill-burst'); setTimeout(() => scene?.classList.remove('skill-burst'), 1100);
    idleSpawnFloat(`ULTIME −${idleFormatNumber(result.gained)}`, 'damage crit huge');
    idleApplyVisualDamage(result.damage ?? result.gained);
    idleShowSkillImpact('ultimate',result.damage??result.gained,result.killed);
    sfx?.idleUltimate?.();
    idleCombatMotion('hero');
    await refreshIdleState();
  } catch (e) { if (!String(e.message).includes('Trop')) idleNotify(e.message,'error'); }
  idleBurstPending = false;
  idleRenderSkillCooldown();
}

let idleTeamSkillPending = false;
async function idleUseTeamSkill(event) {
  event?.stopPropagation(); if (Date.now() < idleTeamSkillReadyAt || idleTeamSkillPending) return;
  idleTeamSkillPending = true;
  const teamBtn = document.getElementById('idle-skill-team'); if (teamBtn) teamBtn.disabled = true;
  try { const r = await api('/api/idle/skill/team', { method: 'POST', body: JSON.stringify({}) }); idleTeamSkillReadyAt = r.readyAt ? new Date(r.readyAt).getTime() : Date.now() + r.cooldownMs; idleSpawnFloat(`COMBO −${idleFormatNumber(r.gained)}`, 'damage crit huge'); idleApplyVisualDamage(r.damage ?? r.gained); idleShowSkillImpact('combo',r.damage??r.gained,r.killed);sfx?.idleCombo?.();document.getElementById('idle-scene')?.classList.add('skill-team');setTimeout(()=>document.getElementById('idle-scene')?.classList.remove('skill-team'),850);idleCombatMotion('team'); await refreshIdleState(); }
  catch (e) { if (!String(e.message).includes('Trop')) idleNotify(e.message,'error'); }
  idleTeamSkillPending = false;
  idleRenderSkillCooldown();
}

let idleBossEngagePending = false;
async function engageIdleBoss() {
  if (idleBossEngagePending) return;
  idleBossEngagePending = true;
  const btn = document.getElementById('idle-boss-engage-btn'); if (btn) btn.disabled = true;
  try {
    const state = await api('/api/idle/boss/engage', { method: 'POST', body: JSON.stringify({}) });
    renderIdleState(state);
    idleAnnounce('Le combat contre le Boss commence !');
  } catch (e) { idleNotify(e.message, 'error'); }
  idleBossEngagePending = false;
  const btnAfter = document.getElementById('idle-boss-engage-btn'); if (btnAfter) btnAfter.disabled = false;
}
function renderIdleBossChest(chest) {
  const btn = document.getElementById('idle-boss-chest'); if (!btn) return;
  btn.classList.toggle('hidden', !chest?.available);
  const label = document.getElementById('idle-boss-chest-label');
  if (label && chest) label.textContent = `Coffre ${chest.tier} · objet ${chest.lootRarity||'rare'} · +${idleFormatNumber(chest.reward+(chest.bonusEssence||0))} Essence · +${chest.sealReward||1} Sceau`;
}
function renderIdleBattleSpeed(speed){const box=document.getElementById('idle-speed-buttons');const view=document.getElementById('view-idle');if(!box||!speed)return;view?.style.setProperty('--battle-speed',speed.current);box.innerHTML=speed.choices.map((x)=>`<button data-battle-speed="${x.value}" class="${x.value===speed.current?'active':''}" ${x.unlocked?'':'disabled'} title="${x.unlocked?'Vitesse disponible':`Débloquée au Rang ${x.level}`}">×${x.value}${x.unlocked?'':` · rang ${x.level}`}</button>`).join('');}
function renderIdleBattleMode(mode,farmMode){document.querySelectorAll('[data-battle-mode]').forEach((b)=>{const active=b.dataset.battleMode===mode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',active?'true':'false');
  // Le mode Farm se débloque à un Rang minimum (retour joueur : les nouveaux
  // arrivants s'y retrouvaient piégés sans comprendre pourquoi la
  // progression s'était arrêtée). Bouton grisé + explication tant que non
  // débloqué, même traitement que les Auto-compétences.
  if(b.dataset.battleMode==='farm'&&farmMode){b.disabled=!farmMode.unlocked;const small=b.querySelector('small');if(small)small.textContent=farmMode.unlocked?'Bloque volontairement la progression':`Débloqué au Rang ${farmMode.level}`;}
});}
function renderIdleAutoSkills(auto){const btn=document.getElementById('idle-auto-skills');const label=document.getElementById('idle-auto-skills-label');if(!btn||!auto)return;btn.disabled=!auto.unlocked;btn.classList.toggle('active',auto.enabled);btn.dataset.enabled=auto.enabled?'1':'0';btn.querySelector(':scope > i:last-child').className=`fas ${auto.enabled?'fa-toggle-on':'fa-toggle-off'}`;label.textContent=!auto.unlocked?`Débloquées au Rang ${auto.level}`:auto.enabled?`Simulation active · rendement moyen +${Math.round(auto.bonus*100)}%`:'Simulation inactive · cliquer pour activer';}
function renderIdleAutomationProfiles(state){const box=document.getElementById('idle-automation-profiles');if(!box)return;const mode=state.battle?.mode;const auto=state.battle?.autoSkills;box.querySelectorAll('[data-automation-profile]').forEach((button)=>{const profile=button.dataset.automationProfile;button.disabled=profile==='farm'&&!state.battle?.farmMode?.unlocked;const active=(profile==='push'&&mode==='progress'&&auto?.enabled)||(profile==='farm'&&mode==='farm'&&auto?.enabled)||(profile==='boss'&&mode==='progress'&&!auto?.enabled);button.classList.toggle('active',!!active);});}
async function applyIdleAutomationProfile(profile){
  const battle=idleState?.battle;if(!battle)return;const button=document.querySelector(`[data-automation-profile="${profile}"]`);if(button?.disabled)return;
  const maxSpeed=Math.max(...(battle.speed?.choices||[]).filter((item)=>item.unlocked).map((item)=>item.value),1);
  const wanted={push:{mode:'progress',speed:maxSpeed,auto:true},farm:{mode:'farm',speed:maxSpeed,auto:true},boss:{mode:'progress',speed:1,auto:false}}[profile];if(!wanted)return;
  document.getElementById('idle-automation-profiles')?.classList.add('applying');
  try{
    let state=idleState;
    if(state.battle?.mode!==wanted.mode)state=await api('/api/idle/battle-mode',{method:'POST',body:JSON.stringify({mode:wanted.mode,confirmed:wanted.mode==='farm'})});
    if(state.battle?.speed?.current!==wanted.speed)state=await api('/api/idle/battle-speed',{method:'POST',body:JSON.stringify({speed:wanted.speed})});
    if(state.battle?.autoSkills?.unlocked&&state.battle.autoSkills.enabled!==wanted.auto)state=await api('/api/idle/auto-skills',{method:'POST',body:JSON.stringify({enabled:wanted.auto})});
    renderIdleState(state);idleNotify(`Profil ${profile==='push'?'Progression':profile==='farm'?'Farm':'Boss manuel'} appliqué.`,'success');
  }catch(e){idleNotify(e.message,'error');}finally{document.getElementById('idle-automation-profiles')?.classList.remove('applying');}
}
async function toggleIdleAutoSkills(){const btn=document.getElementById('idle-auto-skills');if(btn?.disabled)return;try{const state=await api('/api/idle/auto-skills',{method:'POST',body:JSON.stringify({enabled:btn.dataset.enabled!=='1'})});renderIdleState(state);}catch(e){idleNotify(e.message,'error');}}
async function chooseIdleBattleMode(mode){
  if(mode==='farm'&&!await idleConfirm('Le mode Farm répète volontairement la vague actuelle : le compteur revient à 0/10, mais la vague ne progresse plus.',{title:'Activer le mode Farm ?',confirmLabel:'Activer le Farm'}))return;
  try{
    const state=await api('/api/idle/battle-mode',{method:'POST',body:JSON.stringify({mode,confirmed:mode==='farm'})});
    renderIdleState(state);
    idleNotify(mode==='farm'?'Mode Farm actif : cette vague sera répétée.':'Mode Progression actif : la prochaine vague sera débloquée.');
  }catch(e){idleNotify(e.message,'error');}
}
async function chooseIdleBattleSpeed(speed){try{const state=await api('/api/idle/battle-speed',{method:'POST',body:JSON.stringify({speed})});renderIdleState(state);}catch(e){idleNotify(e.message,'error');}}
function idleLabDelta(value){const number=Number(value)||0;return `${number>=0?'+':''}${idleFormatNumber(number)} DPS`;}
function renderIdleStrategyLab(data){
  const box=document.getElementById('idle-strategy-lab-results');if(!box)return;box.dataset.loaded='1';
  const current=data.current||{};const boss=data.boss||{};const recommended=data.recommended;
  const bossStatus=boss.ready?`Marge ${idleLabDelta(boss.gap)}`:`Déficit ${idleFormatNumber(Math.abs(boss.gap||0))} DPS`;
  const formationCards=(data.formations||[]).map((item)=>`<article class="idle-lab-card ${item.active?'current':''} ${recommended?.type==='formation'&&recommended.key===item.key?'best':''}"><header><span><small>${item.active?'FORMATION ACTUELLE':recommended?.type==='formation'&&recommended.key===item.key?'MEILLEURE PROJECTION':'FORMATION'}</small><b>${escapeHtml(item.name)}</b></span><strong>${idleFormatNumber(item.totalRate)} DPS</strong></header><p>${escapeHtml(item.description||'')}</p><div class="idle-lab-metrics"><span class="${item.delta>=0?'positive':'negative'}">${idleLabDelta(item.delta)} · ${item.deltaPercent>=0?'+':''}${Number(item.deltaPercent||0).toFixed(1)}%</span><span>${item.conditionMet?'Condition remplie':'Bonus inactif'}</span><span>${escapeHtml(item.synergy?.name||'Aucune synergie')}</span></div><button type="button" data-lab-formation="${escapeHtml(item.key)}" ${item.active?'disabled':''}><i class="fas ${item.active?'fa-check':'fa-bolt'}"></i> ${item.active?'Déjà active':'Appliquer cette formation'}</button></article>`).join('');
  const presetCards=(data.presets||[]).map((item)=>`<article class="idle-lab-card ${recommended?.type==='preset'&&recommended.key===item.name?'best':''} ${item.unlocked?'':'locked'}"><header><span><small>${recommended?.type==='preset'&&recommended.key===item.name?'MEILLEURE PROJECTION':'COMPOSITION SAUVEGARDÉE'}</small><b>${escapeHtml(item.name)}</b></span><strong>${idleFormatNumber(item.totalRate)} DPS</strong></header><p>${escapeHtml(item.formationName)} · ${item.heroCount} héros · ${escapeHtml(item.synergy?.name||'Aucune synergie')}</p><div class="idle-lab-team">${(item.team||[]).map((hero)=>`<span title="${escapeHtml(hero.name)} · ${escapeHtml(hero.role)}"><img src="${escapeHtml(hero.imageUrl||'/assets/default-avatar.svg')}" alt=""><b>${escapeHtml(hero.name)}</b><small>Niv. ${hero.level}${hero.leader?' · Chef':''}</small></span>`).join('')}</div><div class="idle-lab-metrics"><span class="${item.delta>=0?'positive':'negative'}">${idleLabDelta(item.delta)} · ${item.deltaPercent>=0?'+':''}${Number(item.deltaPercent||0).toFixed(1)}%</span><span>${item.conditionMet?'Formation active':'Bonus de formation inactif'}</span></div><button type="button" data-lab-preset="${escapeHtml(item.name)}" ${item.unlocked&&item.heroCount?'':'disabled'}><i class="fas ${item.unlocked?'fa-users-gear':'fa-lock'}"></i> ${item.unlocked?'Charger cette composition':'Emplacement verrouillé'}</button></article>`).join('');
  box.innerHTML=`<div class="idle-lab-summary"><span><small>DPS ACTUEL</small><b>${idleFormatNumber(current.totalRate||0)}</b><em>${escapeHtml(current.formationName||'Équilibrée')} · ${current.heroCount||0} héros</em></span><span class="${boss.ready?'ready':'blocked'}"><small>BOSS CIBLE · STAGE ${boss.stage||10}</small><b>${boss.ready?'Prêt':'Encore trop juste'}</b><em>${bossStatus} · requis ${idleFormatNumber(boss.requiredDps||0)} DPS</em></span><span><small>RECOMMANDATION</small><b>${escapeHtml(recommended?.name||'Aucune')}</b><em>${recommended?`${idleFormatNumber(recommended.totalRate)} DPS projetés`:'Sauvegarde une composition pour la comparer'}</em></span></div><div class="idle-lab-section"><h4>Formations sur l'équipe actuelle</h4><div class="idle-lab-grid">${formationCards||'<p class="hint">Aucune formation disponible.</p>'}</div></div><div class="idle-lab-section"><h4>Compositions sauvegardées</h4><div class="idle-lab-grid">${presetCards||'<p class="hint">Aucune composition sauvegardée. Utilise les emplacements ci-dessus pour en créer une.</p>'}</div></div>`;
}
async function loadIdleStrategyLab(){const box=document.getElementById('idle-strategy-lab-results');if(!box)return;box.innerHTML='<p class="hint"><i class="fas fa-spinner fa-spin"></i> Calcul exact des variantes…</p>';try{renderIdleStrategyLab(await api('/api/idle/strategy-lab'));}catch(e){box.innerHTML=`<p class="idle-lab-error">${escapeHtml(e.message)}</p>`;}}
function refreshIdleStrategyLabIfOpen(){const box=document.getElementById('idle-strategy-lab-results');if(box?.dataset.loaded==='1')loadIdleStrategyLab();}
async function chooseIdleFormation(formation){try{renderIdleState(await api('/api/idle/formation',{method:'POST',body:JSON.stringify({formation})}));refreshIdleStrategyLabIfOpen();}catch(e){alert(e.message);}}
async function chooseIdleStage(stage){
  if(!Number.isInteger(stage)||stage<1||stage===idleState?.battle?.stage)return;
  // Revisiter un niveau déjà dépassé active automatiquement le mode Farm côté
  // serveur (cf. /api/idle/stage) — jusqu'ici sans confirmation, contrairement
  // au bouton dédié "Répéter la vague" qui, lui, demande toujours confirmation
  // avant de figer la progression. Un simple clic curieux sur "Niveau
  // précédent" ou le voyage rapide piégeait donc le joueur en Farm sans qu'il
  // l'ait choisi (retour joueur : "bloqué stage 1" après coup, sans se
  // souvenir avoir activé quoi que ce soit).
  const bestStage=idleState?.battle?.runBestStage||idleState?.battle?.bestStage||stage;
  if(stage<bestStage){
    if(!await idleConfirm(`Revenir au niveau ${stage} active le mode Farm : ta progression restera bloquée sur cette vague jusqu'à ce que tu repasses en Progression.`,{title:'Voyager en mode Farm ?',confirmLabel:`Voyager au niveau ${stage}`}))return;
  }
  try{const state=await api('/api/idle/stage',{method:'POST',body:JSON.stringify({stage})});renderIdleState(state);idleNotify(stage<state.battle.runBestStage?`Niveau ${stage} sélectionné · mode Farm actif.`:`Retour au niveau maximum ${stage} · progression active.`,'success');}catch(e){idleNotify(e.message,'error');}
}
async function chooseIdleLeader(characterId){try{const state=await api('/api/idle/team-leader',{method:'POST',body:JSON.stringify({characterId})});renderIdleState(state);idleNotify(`Lead Skill actif : ${state.strategy?.leaderSkill?.name||'bonus du chef'} · ${state.strategy?.leaderSkill?.description||'bonus appliqué au DPS.'}`,'success');document.getElementById('idle-character-sheet')?.classList.add('hidden');}catch(e){idleNotify(e.message,'error');}}
async function saveIdlePreset(slotIndex=null){const squad=(idleState?.strategy?.squads?.slots||[]).find((slot)=>slot.index===Number(slotIndex));const name=squad?.name||document.getElementById('idle-preset-name')?.value.trim();if(!name)return;try{renderIdleState(await api('/api/idle/team-preset/save',{method:'POST',body:JSON.stringify({name,slotIndex:squad?.index})}));idleAddCombatLog(`Squad ${name} sauvegardée`,'fa-floppy-disk');refreshIdleStrategyLabIfOpen();}catch(e){alert(e.message);}}
async function loadIdlePreset(name){try{renderIdleState(await api('/api/idle/team-preset/load',{method:'POST',body:JSON.stringify({name})}));idleAddCombatLog(`Preset ${name} chargé`,'fa-users-gear');refreshIdleStrategyLabIfOpen();}catch(e){alert(e.message);}}
async function claimIdleChallenge(key){try{const r=await api('/api/idle/challenge/claim',{method:'POST',body:JSON.stringify({key})});idleSpawnFloat(`DÉFI +${r.reward} SCEAUX`,'crit');renderIdleState(r.state);}catch(e){alert(e.message);}}
async function loadIdleTelemetry(){const box=document.getElementById('idle-telemetry-summary');if(!box)return;box.innerHTML='<p class="hint">Chargement…</p>';try{const data=await api('/api/idle/telemetry/beta');box.innerHTML=`<div class="idle-telemetry-head"><b>${data.betaPlayers} testeurs</b><small>${data.windowDays} derniers jours</small></div>${data.events.map((e)=>`<span><b>${escapeHtml(e.event)}</b><strong>${e.count}</strong><small>${e.averageStage?`Stage moyen ${Math.round(e.averageStage)}`:''}</small></span>`).join('')}`;}catch(e){box.innerHTML=`<p class="hint">${escapeHtml(e.message)}</p>`;}}
async function sendIdleFeedback(event){event.preventDefault();const input=document.getElementById('idle-feedback-text');const status=document.getElementById('idle-feedback-status');const message=input?.value.trim()||'';if(message.length<10)return;const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;status.textContent='Envoi…';try{await api('/api/idle/feedback',{method:'POST',body:JSON.stringify({message,context:JSON.stringify({stage:idleState?.battle?.stage||null,world:idleState?.dojo?.decor?.theme||null,version:window.BUILD_ID||'local'})})});input.value='';status.textContent='Merci, ton retour a bien été transmis.';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}}

function openIdleClassPicker() {
  const box = document.getElementById('idle-class-grid'); if (!box || !idleState?.heroClass) return;
  const classWait=Math.max(0,new Date(idleState.heroClass.changeReadyAt||0)-Date.now());
  box.innerHTML = idleState.heroClass.choices.map((c) => `<button class="idle-class-choice ${c.key === idleState.heroClass.key ? 'active' : ''}" data-hero-class="${c.key}" ${classWait&&c.key!==idleState.heroClass.key?'disabled':''}><i class="fas ${c.icon}"></i><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.description)}</span>${c.key === idleState.heroClass.key ? `<small>CLASSE ACTIVE${idleState.heroClass.passiveStatus?` · ${escapeHtml(idleState.heroClass.passiveStatus)}`:''}</small>` : classWait?`<small>Disponible dans ${Math.ceil(classWait/60000)} min</small>`:''}</button>`).join('');
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
  try { const r = await api('/api/idle/boss-chest', { method: 'POST', body: JSON.stringify({}) }); idleSpawnFloat(`COFFRE +${idleFormatNumber(r.reward)}`, 'crit'); showIdleBossReward(r); if (typeof sfx!=='undefined'&&sfx.idleChest)sfx.idleChest();if (typeof burstConfetti === 'function') burstConfetti(55); await refreshIdleState(); }
  catch (e) { idleNotify(e.message,'error'); }
}

// Carte de butin partagée par les deux modales de révélation (coffre de boss
// et Donjon des Objets) — même objet stocké/recyclé, même gabarit visuel.
function idleLootCardHTML(loot){
  if(!loot)return '';
  const names = Object.fromEntries(IDLE_RUNE_KINDS.map((kind,index)=>[kind,`Objet ${index+1}`]));
  return `<div class="idle-boss-loot ${escapeHtml(loot.rarity)}">${idleItemArt(loot,'reveal')}<div><small>${escapeHtml(loot.rarity.toUpperCase())} · SET ${escapeHtml(loot.setKey||'energy').toUpperCase()}</small><b>${escapeHtml(loot.name||names[loot.kind])}</b><span>${loot.stored?`Objet ajouté · ${escapeHtml(names[loot.kind]||'Objet')} · +0`:`Inventaire plein · converti en +${idleFormatNumber(loot.salvage||0)} Essence`}</span></div><em>${loot.stored?'NOUVEAU':'RECYCLÉ'}</em></div>${loot.stored?'<button class="btn-secondary idle-boss-open-items" data-open-equipment><i class="fas fa-diamond"></i> Voir et équiper l’objet</button>':''}`;
}
function showIdleBossReward(reward) {
  const modal=document.getElementById('idle-boss-reveal');const body=document.getElementById('idle-boss-reveal-body');const title=document.getElementById('idle-boss-reveal-title');if(!modal||!body)return;
  if(title)title.innerHTML='<i class="fas fa-box-open"></i> Coffre de boss';
  body.innerHTML=`<div class="idle-boss-reward-main"><i class="fas fa-trophy"></i><span><small>COFFRE ${reward.tier}</small><b>Butin du gardien</b></span></div><div class="idle-boss-reward-grid"><span><i class="fas fa-bolt"></i><b>+${idleFormatNumber(reward.reward)}</b><small>Essence</small></span><span><i class="fas fa-ticket"></i><b>+${reward.seals}</b><small>Sceau${reward.seals>1?'x':''}</small></span></div>${idleLootCardHTML(reward.loot)}`;
  modal.classList.remove('hidden');
}

// Réutilise la modale de révélation du coffre de boss (même structure) pour
// le butin du Donjon des Objets — pas d'Essence/Sceaux gagnés ici (sauf
// recyclage si l'inventaire est plein), juste l'objet obtenu dans le slot choisi.
function showIdleRuneDungeonReward(result){
  const modal=document.getElementById('idle-boss-reveal');const body=document.getElementById('idle-boss-reveal-body');const title=document.getElementById('idle-boss-reveal-title');if(!modal||!body)return;
  if(title)title.innerHTML='<i class="fas fa-dungeon"></i> Donjon des Objets';
  body.innerHTML=idleLootCardHTML(result.loot);
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
  const economy=document.getElementById('idle-recruit-economy');if(economy)economy.innerHTML=`<i class="fas fa-ticket"></i> <b>Les Sceaux n’augmentent pas le prix en Essence</b> · prochain achat Essence : ${idleFormatNumber(recruit.essenceCostAfter)} · Épique dans ${recruit.guaranteedEpicIn||10}`;
  const pity=document.getElementById('idle-summon-pity');if(pity)pity.textContent=`Épique dans ${recruit.guaranteedEpicIn||10} invocation(s) max.`;
  const navPrice=document.getElementById('idle-nav-summon-price');if(navPrice)navPrice.textContent=`1 Sceau ou ${idleFormatNumber(recruit.essenceCost)} Essence`;
  const summonBalance=document.getElementById('idle-summon-balance');if(summonBalance){const pullsLeft=Math.floor(recruit.balance/Math.max(1,recruit.nextCost));summonBalance.innerHTML=`<i class="fas fa-ticket"></i><span><small>TON SOLDE</small><b>${idleFormatNumber(recruit.balance)} Sceau${recruit.balance!==1?'x':''} disponible${recruit.balance!==1?'s':''} · ${pullsLeft} invocation${pullsLeft!==1?'s':''} restante${pullsLeft!==1?'s':''}</b></span>`;}
  const pullsDone=Math.max(0,10-(recruit.guaranteedEpicIn||10));
  const pityProgress=document.getElementById('idle-summon-pity-progress');if(pityProgress)pityProgress.textContent=`${pullsDone} / 10 tirages`;
  const pityFill=document.getElementById('idle-summon-pity-fill');if(pityFill)pityFill.style.width=`${pullsDone*10}%`;
  const odds=document.getElementById('idle-summon-odds');if(odds){const labels={rare:'Rare',epic:'Épique',legendary:'Légendaire',mythic:'Mythique'};const values=recruit.odds||{};odds.innerHTML=Object.entries(labels).map(([key,label])=>`<span class="r-${key}"><small>${label}</small><b>${Number(values[key]||0).toFixed(Number(values[key]||0)%1?1:0)}%</b></span>`).join('');}
}

function renderIdleCoach(guide){
  const coach=document.getElementById('idle-coach');if(!coach||!guide?.next){coach?.classList.add('hidden');return;}
  const step=guide.next;const key=`idle-coach:${step.title}`;
  if(sessionStorage.getItem(key)==='hidden'){coach.classList.add('hidden');return;}
  document.getElementById('idle-coach-title').textContent=step.title;
  document.getElementById('idle-coach-text').textContent=step.description;
  idleCoachAction=()=>{coach.classList.add('hidden');idleShowPanel(step.tab||'home');};
  coach.dataset.key=key;coach.classList.remove('hidden');
}

function idleRewardLabel(item){return `+${idleFormatNumber(item.reward)} ${item.rewardCurrency==='seals'?'<i class="fas fa-ticket"></i>':'<i class="fas fa-mortar-pestle"></i>'}`;}
function renderIdleMissions(missions,rank) {
  const box = document.getElementById('idle-missions'); if (!box) return;
  box.innerHTML = missions.length ? missions.map((m) => {const progress=Math.min(100,m.progress/Math.max(1,m.target)*100);return `<article class="idle-mission ${m.completed ? 'done' : ''}"><span class="idle-mission-icon"><i class="fas ${m.completed?'fa-check':m.cadence === 'Quotidienne' ? 'fa-sun' : 'fa-calendar-week'}"></i></span><div><small>${escapeHtml(m.cadence)} · ${m.completed?'TERMINÉE':'EN COURS'}</small><b>${escapeHtml(m.title)}</b><span>${escapeHtml(m.description)}</span><div class="idle-mission-progress"><em style="--progress:${progress}%"></em><strong>${idleFormatNumber(Math.min(m.progress,m.target))} / ${idleFormatNumber(m.target)}</strong></div></div><button class="btn-secondary" data-idle-mission="${m.key}" ${!m.completed || m.claimed ? 'disabled' : ''}>${m.claimed ? '<i class="fas fa-check"></i> Réclamée' : `${idleRewardLabel(m)}<small>Réclamer</small>`}</button></article>`;}).join('') : idleEmptyState('fa-list-check','Aucune mission pour le moment','Reviens après ta prochaine synchronisation — de nouvelles missions arrivent chaque jour et chaque semaine.');
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
function renderIdleCommunityBoss(event){
  const box=document.getElementById('idle-community-boss');if(!box||!event)return;const progress=Math.round((event.progress||0)*100);const left=Math.max(0,new Date(event.endsAt)-Date.now());const reward=`+${idleFormatNumber(event.reward.seals)} Sceaux · +${idleFormatNumber(event.reward.essence)} Essence`;
  box.className=`idle-community-boss phase-${escapeHtml(event.phase.key)} ${event.completed?'completed':''}`;
  box.innerHTML=`<header><i class="fas ${escapeHtml(event.boss.icon)}"></i><span><small>BOSS COMMUNAUTAIRE · ${Math.ceil(left/86400000)} J RESTANT${left>86400000?'S':''}</small><b>${escapeHtml(event.boss.name)}</b><em>${escapeHtml(event.phase.name)} · ${escapeHtml(event.phase.description)}</em></span><button type="button" data-community-refresh title="Actualiser"><i class="fas fa-rotate"></i></button></header><div class="idle-community-health"><span><b>${idleFormatNumber(event.totalPoints)} / ${idleFormatNumber(event.target)} points</b><strong>${progress}%</strong></span><em><i style="--progress:${progress}%"></i></em></div><div class="idle-community-main"><section><span><small>TA CONTRIBUTION</small><b>${idleFormatNumber(event.myContribution)} points</b><em>${event.myContribution<event.minContribution?`Encore ${idleFormatNumber(event.minContribution-event.myContribution)} points pour être éligible`:`Seuil de contribution atteint · ${event.contributors} participants`}</em></span><p><i class="fas fa-circle-info"></i> 1 point par ennemi · 1 par 10 frappes · 3 par compétence · 60 par boss.</p><button type="button" class="btn-primary" data-community-claim ${!event.eligible||event.claimed?'disabled':''}>${event.claimed?'<i class="fas fa-check"></i> Récompense réclamée':event.completed&&event.myContribution<event.minContribution?'Contribution insuffisante':event.completed?`<i class="fas fa-gift"></i> ${reward}`:'Victoire collective requise'}</button></section><section class="idle-community-ranking"><h4><i class="fas fa-ranking-star"></i> Meilleurs contributeurs</h4>${event.leaderboard.slice(0,5).map((player)=>`<button type="button" data-idle-player="${escapeHtml(player.id)}" class="${player.isMe?'me':''}"><strong>${player.rank<=3?['🥇','🥈','🥉'][player.rank-1]:player.rank}</strong><span class="avatar" ${player.avatarUrl?`style="background-image:url('${escapeHtml(player.avatarUrl)}')"`:''}></span><b>${escapeHtml(player.name)}</b><em>${idleFormatNumber(player.points)} pts</em></button>`).join('')||'<p class="hint">Sois le premier à contribuer cette semaine.</p>'}</section></div>`;
}
async function loadIdleCommunityBoss(){
  if(idleCommunityBossPromise)return idleCommunityBossPromise;const box=document.getElementById('idle-community-boss');
  idleCommunityBossPromise=(async()=>{try{const event=await api('/api/idle/community-boss');renderIdleCommunityBoss(event);return event;}catch(error){if(box)box.innerHTML=idleEmptyState('fa-triangle-exclamation','Gardien indisponible',error.message);}finally{idleCommunityBossPromise=null;}})();return idleCommunityBossPromise;
}
async function claimIdleCommunityBoss(){try{const event=await api('/api/idle/community-boss/claim',{method:'POST',body:JSON.stringify({})});renderIdleCommunityBoss(event);idleSpawnFloat(`COMMUNAUTÉ · +${idleFormatNumber(event.reward.seals)} SCEAUX`,'crit');if(typeof burstConfetti==='function')burstConfetti(50);await refreshIdleState();}catch(error){idleNotify(error.message,'error');}}
function renderIdleAchievements(items, bonus) {
  const box = document.getElementById('idle-achievements'); if (!box) return;
  // Chaque succès complété vaut +1% de DPS permanent (appliqué automatiquement
  // côté serveur) — la bannière rappelle pourquoi ces objectifs comptent.
  const banner = bonus ? `<div class="idle-achievement-bonus"><i class="fas fa-trophy"></i><span><b>${bonus.completed}/${bonus.total} succès complétés</b><small>+${Math.round((bonus.perAchievement || .01) * 100)}% de production permanente chacun, appliqué automatiquement</small></span><strong>×${Number(bonus.multiplier || 1).toFixed(2)} DPS</strong></div>` : '';
  box.innerHTML = banner + (items.length ? items.map((a) => `<div class="idle-achievement ${a.completed ? 'completed' : ''}"><i class="fas ${a.icon}"></i><div><b>${escapeHtml(a.title)}</b><span>${escapeHtml(a.description)} · ${idleFormatNumber(a.progress)}/${idleFormatNumber(a.target)} · +1% DPS</span><em style="--progress:${a.progress/a.target*100}%"></em></div><button class="btn-secondary" data-achievement="${a.key}" ${!a.completed || a.claimed ? 'disabled' : ''}>${a.claimed ? '<i class="fas fa-check"></i>' : idleRewardLabel(a)}</button></div>`).join('') : idleEmptyState('fa-trophy','Aucun succès pour le moment'));
}
function renderIdleGuide(guide){if(!guide)return;renderIdleCoach(guide);const count=document.getElementById('idle-guide-count');if(count)count.textContent=`${guide.completed}/${guide.total}`;const text=document.getElementById('idle-guide-progress-text');if(text)text.textContent=`${guide.completed}/${guide.total} étapes`;const bar=document.getElementById('idle-guide-progress-bar');if(bar)bar.style.setProperty('--progress',`${guide.completed/guide.total*100}%`);const list=document.getElementById('idle-guide-list');if(list)list.innerHTML=guide.items.map((x,i)=>`<div class="idle-guide-step ${x.done?'done':x===guide.next?'current':''}"><span>${x.done?'<i class="fas fa-check"></i>':i+1}</span><div><b>${escapeHtml(x.title)}</b><small>${escapeHtml(x.description)}</small></div>${x.done?'':`<button class="btn-secondary" data-guide-tab="${x.tab}">Voir</button>`}</div>`).join('');}
function renderIdleSeason(season){const box=document.getElementById('idle-season-card');if(!box)return;box.classList.toggle('hidden',!season?.enabled);if(!season?.enabled)return;const left=Math.max(0,new Date(season.endsAt)-Date.now());const next=season.tiers.find((t)=>!t.completed);const seasonProgress=next?Math.min(100,season.level/Math.max(1,next.level)*100):100;box.innerHTML=`<div class="idle-season-head"><i class="fas fa-crown"></i><div><small>PARCOURS MENSUEL · SAISON ${season.period}</small><b>${escapeHtml(season.name)}</b><span>Progresse en combattant, améliorant et recrutant.</span><strong>${idleFormatNumber(season.level)}${next?` / ${idleFormatNumber(next.level)}`:''} activité · ${Math.ceil(left/86400000)} jour(s) restants</strong></div></div><div class="idle-season-main-progress"><em style="--progress:${seasonProgress}%"></em><span>${next?`Prochain palier : ${next.tier}`:'Parcours terminé'}</span></div><div class="idle-season-track">${season.tiers.map((t)=>`<div class="idle-season-tier ${t.completed?'completed':''} ${t.claimed?'claimed':''}"><span>PALIER ${t.tier}<b>${idleFormatNumber(t.level)}</b></span><i class="fas ${t.claimed?'fa-check':t.completed?'fa-gift':'fa-lock'}"></i><button data-season-tier="${t.tier}" ${!t.completed||t.claimed?'disabled':''}>${t.claimed?'Réclamé':`+${idleFormatNumber(t.reward)} Sceau${t.reward>1?'x':''}${t.essence?` · ${idleFormatNumber(t.essence)} Essence`:''}`}</button></div>`).join('')}</div><details class="idle-season-sources"><summary>Voir d’où vient mon activité <i class="fas fa-chevron-down"></i></summary><div class="idle-season-breakdown">${(season.breakdown||[]).map((x)=>`<span><small>${escapeHtml(x.label)}</small><b>+${idleFormatNumber(x.score)}</b><em>${idleFormatNumber(x.value)}/${idleFormatNumber(x.cap)}</em></span>`).join('')}</div></details>`;}
function renderIdleWeeklyRogue(event){const box=document.getElementById('idle-weekly-rogue');if(!box||!event)return;box.className=`idle-weekly-rogue ${event.active?'active':''}`;box.innerHTML=`<i class="fas ${escapeHtml(event.icon)}"></i><span><small>MUTATEUR ROGUELIKE HEBDOMADAIRE</small><b>${escapeHtml(event.name)}</b><p>${escapeHtml(event.description)}</p><em>${event.matches}/2 pouvoirs ${escapeHtml(event.affinity)} · bonus actuel ×${Number(event.multiplier||1).toFixed(2)}</em></span><time data-event-end="${escapeHtml(event.endsAt)}"></time>`;}
function renderIdleExpeditions(expeditions){const box=document.getElementById('idle-expeditions');if(!box||!expeditions)return;const active=expeditions.active;if(active){box.innerHTML=`<article class="idle-expedition-active ${active.ready?'ready':''}"><i class="fas ${escapeHtml(active.icon)}"></i><span><small>${active.ready?'EXPÉDITION TERMINÉE':'EN MISSION'}</small><b>${escapeHtml(active.name)}</b><p>${(active.heroes||[]).map((hero)=>escapeHtml(hero.name)).join(' · ')}</p><em>${active.ready?'Récompense prête':`${idleFormatDuration(active.remainingMs)} restante`} · ${idleFormatNumber(active.reward?.essence||0)} Essence${active.reward?.seals?` · ${active.reward.seals} Sceau${active.reward.seals>1?'x':''}`:''}</em></span><button type="button" class="btn-primary" data-expedition-claim ${active.ready?'':'disabled'}>${active.ready?'<i class="fas fa-gift"></i> Réclamer':'En cours'}</button></article>`;return;}box.innerHTML=`<div class="idle-expedition-reserves"><i class="fas fa-users"></i><b>${expeditions.reserveCount} héros au repos disponibles</b><small>Les meilleures recrues compatibles seront choisies automatiquement.</small></div><div class="idle-expedition-grid">${(expeditions.missions||[]).map((mission)=>`<article><i class="fas ${escapeHtml(mission.icon)}"></i><span><small>${idleFormatDuration(mission.durationSeconds*1000)}</small><b>${escapeHtml(mission.name)}</b><em>${idleFormatNumber(mission.reward?.essence||0)} Essence${mission.reward?.seals?` · ${mission.reward.seals} Sceau${mission.reward.seals>1?'x':''}`:''}</em></span><button type="button" data-expedition-start="${escapeHtml(mission.key)}" ${mission.available?'':'disabled'}>${mission.available?'Envoyer':`${mission.minimumReserves} réserves requises`}</button></article>`).join('')}</div>`;}
async function startIdleExpedition(missionKey){try{const state=await api('/api/idle/expedition/start',{method:'POST',body:JSON.stringify({missionKey})});renderIdleState(state);idleNotify('Escouade secondaire envoyée.','success');}catch(e){idleNotify(e.message,'error');}}
async function claimIdleExpedition(){try{const result=await api('/api/idle/expedition/claim',{method:'POST',body:JSON.stringify({})});renderIdleState(result.state);idleSpawnFloat(`EXPÉDITION +${idleFormatNumber(result.essence)}`,'xp');idleNotify(`Expédition : +${idleFormatNumber(result.essence)} Essence${result.seals?` et ${result.seals} Sceau${result.seals>1?'x':''}`:''}.`,'success');}catch(e){idleNotify(e.message,'error');}}
function renderIdleRift(rift){
  const box=document.getElementById('idle-rift-card');if(!box||!rift)return;
  box.classList.toggle('locked',!rift.unlocked);
  // Verrouillée : un aperçu compact (pas la carte détaillée avec ses 3
  // statistiques) — un joueur de niveau 1 n'a rien à faire d'un record de
  // Faille avant le niveau 20 ; lui montrer quand même la mécanique complète
  // n'ajoute que du bruit avant qu'elle soit pertinente.
  if(!rift.unlocked){
    box.innerHTML=`<div class="idle-locked-teaser"><i class="fas fa-lock"></i><div><small>DÉFI HEBDOMADAIRE</small><b>Faille dimensionnelle</b><span>Débloquée au Rang ${rift.unlockLevel}</span></div></div>`;
    return;
  }
  const canImprove=rift.projectedFloor>rift.bestFloor;const bestPercent=Math.min(100,rift.bestFloor/Math.max(1,rift.maxFloor)*100);const projectedPercent=Math.min(100,rift.projectedFloor/Math.max(1,rift.maxFloor)*100);
  // Reliques actives cette semaine (choisies tous les 5 paliers franchis) :
  // une rangée d'icônes avec infobulle, pas une carte détaillée — elles
  // restent un bonus contextuel, pas le sujet principal de l'écran.
  const relicsRow=rift.relics.length?`<div class="idle-rift-relics">${rift.relics.map((r)=>`<span title="${escapeHtml(r.name)} — ${escapeHtml(r.description)}"><i class="fas ${r.icon}"></i></span>`).join('')}</div>`:'';
  const relicBadge=rift.pendingChoice.length?`<button type="button" class="idle-rift-relic-pending" data-idle-relic-open><i class="fas fa-gift"></i> Choisir ta relique</button>`:'';
  box.innerHTML=`<header><i class="fas fa-dungeon"></i><div><small>DÉFI HEBDOMADAIRE · ${rift.maxFloor} SALLES</small><b>Faille dimensionnelle</b><span>${escapeHtml(rift.variant.name)} · ${escapeHtml(rift.variant.description)}</span></div><strong><small>RECORD</small>${rift.bestFloor}<em>/${rift.maxFloor}</em></strong></header>${relicsRow}${relicBadge}<div class="idle-rift-progress" style="--best:${bestPercent}%;--projected:${projectedPercent}%"><div><i></i><em></em></div><span><b>0</b><b>${rift.maxFloor}</b></span></div><div class="idle-rift-summary"><span><small>RECORD ACTUEL</small><b><i class="fas fa-trophy"></i> Salle ${rift.bestFloor}</b></span><span class="projected"><small>ESTIMATION AVEC TON DPS</small><b><i class="fas fa-bolt"></i> Salle ${rift.projectedFloor}</b></span><span><small>PROCHAIN OBSTACLE</small><b><i class="fas fa-shield-halved"></i> ${idleFormatNumber(rift.nextTarget)} PV</b></span></div><p class="idle-rift-help"><i class="fas fa-circle-info"></i> La zone violette est ton record. Le repère clair montre jusqu’où ton équipe devrait aller aujourd’hui.</p><footer><span>${canImprove?`Une tentative peut améliorer ton record de ${rift.projectedFloor-rift.bestFloor} salle${rift.projectedFloor-rift.bestFloor>1?'s':''}.`:'Améliore ton DPS pour dépasser ton record.'}</span><button class="btn-primary" id="idle-rift-attempt" ${!canImprove?'disabled':''}>${canImprove?`Tenter la Faille <small>Gain : ${idleFormatNumber(rift.reward.essence)} Essence${rift.reward.seals?` + ${rift.reward.seals} Sceau${rift.reward.seals>1?'x':''}`:''}${rift.reward.tokens?` + ${rift.reward.tokens} token${rift.reward.tokens>1?'s':''}`:''}</small>`:'Record hors de portée'}</button></footer>`;
  // Ouvre automatiquement le choix UNE fois par nouvelle offre (signature des
  // clés proposées) — si le joueur ferme la modale sans choisir, elle ne se
  // rouvre pas toute seule à chaque rendu, mais le badge ci-dessus reste
  // cliquable pour y revenir quand il veut.
  const offerSignature=rift.pendingChoice.map((r)=>r.key).join(',');
  if(offerSignature&&idleRelicChoiceOffer!==offerSignature){idleRelicChoiceOffer=offerSignature;openIdleRiftRelicChoice(rift.pendingChoice);}
  else if(!offerSignature)idleRelicChoiceOffer=null;
}
async function attemptIdleRift(){try{const result=await api('/api/idle/rift/attempt',{method:'POST',body:JSON.stringify({})});idleSpawnFloat(`FAILLE ${result.floor}/20`,'crit huge');sfx?.idleChest?.();if(result.tokens)idleNotify(`+${idleFormatNumber(result.tokens)} tokens gacha gagnés !`,'success');for(const drop of result.loot||[]){idleAddCombatLog(drop.stored?`Butin de Faille : ${drop.name}`:`Butin de Faille recyclé (sac plein) : +${idleFormatNumber(drop.salvage)} Essence`,'fa-diamond');idleNotify(drop.stored?`La Faille lâche ${drop.name} (${idleRarityLabel(drop.rarity)}) !`:`Sac plein — ${drop.name} recyclé pour ${idleFormatNumber(drop.salvage)} Essence.`,'success');}renderIdleState(result.state);}catch(e){idleNotify(e.message,'error');}}
let idleRelicChoiceOffer=null;
function openIdleRiftRelicChoice(options){
  const box=document.getElementById('idle-relic-choice-options');
  if(box)box.innerHTML=options.map((r)=>`<button type="button" class="idle-relic-option" data-relic-choice="${r.key}"><i class="fas ${r.icon}"></i><b>${escapeHtml(r.name)}</b><p>${escapeHtml(r.description)}</p></button>`).join('');
  document.getElementById('idle-relic-choice')?.classList.remove('hidden');
}
async function chooseIdleRiftRelic(key){
  try{const result=await api('/api/idle/rift/relic',{method:'POST',body:JSON.stringify({key})});document.getElementById('idle-relic-choice')?.classList.add('hidden');idleRelicChoiceOffer=null;idleSpawnFloat('RELIQUE ACTIVÉE','crit');renderIdleState(result.state);}
  catch(e){idleNotify(e.message,'error');}
}
async function claimIdleSeason(tier){try{const r=await api('/api/idle/season/claim',{method:'POST',body:JSON.stringify({tier})});idleSpawnFloat(`SAISON +${idleFormatNumber(r.reward)}`,'crit');if(r.tokens)idleNotify(`+${idleFormatNumber(r.tokens)} tokens gacha gagnés !`,'success');await refreshIdleState();}catch(e){idleNotify(e.message,'error');}}
function openIdleGuide(){document.getElementById('idle-guide-modal')?.classList.remove('hidden');}
function idleRankingMetric(type,value){if(type==='speed')return idleFormatDuration(Number(value)||0)||'—';return idleFormatNumber(value);}
function idleRankingRows(players,type){
  if(!players.length)return idleEmptyState(type==='friends'?'fa-user-group':'fa-ranking-star',type==='friends'?'Aucun ami à comparer':'Aucun joueur classé',type==='friends'?'Ajoute des amis depuis la Communauté pour suivre leur progression.':'Ce classement se remplira avec les prochaines aventures.');
  const rankOf=(p,index)=>type==='friends'?index+1:p.rank;
  const metricOf=(p)=>idleRankingMetric(type,type==='friends'?p.stage:p.metric);
  const metricLabel=type==='speed'?'CHRONO':type==='collection'?'HÉROS':type==='rift'?'PALIER':type==='level'?'RANG':'VAGUE';
  const playerName=(p)=>`${escapeHtml(p.name)}${p.isMe?'<em>VOUS</em>':''}`;
  const podium=players.slice(0,3).map((p,index)=>{const rank=rankOf(p,index);return `<button type="button" class="idle-ranking-podium rank-${rank} ${p.isMe?'me':''}" data-idle-player="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.name)}, rang ${rank}"><span class="idle-podium-rank"><i class="fas ${rank===1?'fa-crown':'fa-medal'}"></i><b>${rank}</b></span><span class="avatar" ${p.avatarUrl?`style="background-image:url('${escapeHtml(p.avatarUrl)}')"`:''}></span><span class="idle-podium-player"><b>${playerName(p)}</b><small>${escapeHtml(p.className)}</small></span><strong>${metricOf(p)}</strong><small>${metricLabel}</small></button>`;}).join('');
  const rows=players.slice(3).map((p,index)=>{const rank=rankOf(p,index+3);return `<button type="button" class="idle-ranking-row ${p.isMe?'me':''}" data-idle-player="${escapeHtml(p.id)}"><strong><span>${rank}</span></strong><span class="idle-ranking-player"><span class="avatar" ${p.avatarUrl?`style="background-image:url('${escapeHtml(p.avatarUrl)}')"`:''}></span><span><b>${playerName(p)}</b><small>${escapeHtml(p.className)}</small></span></span><b>${metricOf(p)}</b><b>${idleFormatNumber(p.level)}</b><b>${idleFormatNumber(p.prestige)}</b><i class="fas fa-chevron-right" aria-hidden="true"></i></button>`;}).join('');
  return `<section class="idle-ranking-podiums" aria-label="Podium">${podium}</section>${rows?`<div class="idle-ranking-table"><div class="idle-ranking-head"><span>RANG</span><span>JOUEUR</span><span>${metricLabel}</span><span>NIV.</span><span>PRESTIGE</span><span></span></div>${rows}</div>`:''}`;
}
async function openIdleRanking(type=idleRankingType){
  idleRankingType=type;const modal=document.getElementById('idle-ranking-modal');const list=document.getElementById('idle-ranking-list');const metric=document.getElementById('idle-ranking-metric-title');const hint=document.getElementById('idle-ranking-hint');
  modal?.classList.remove('hidden');document.querySelectorAll('[data-idle-ranking]').forEach((button)=>button.classList.toggle('active',button.dataset.idleRanking===type));
  const titles={stage:'Vague',level:'Niveau',speed:'Temps',rift:'Palier',collection:'Héros',friends:'Vague'};if(metric)metric.textContent=titles[type]||'Score';
  // Une phrase par classement : ce qu'il mesure ET comment y grimper — un
  // nouveau joueur ne devine pas ce que « Prestige » ou « Palier » classe.
  // « Progression » (stage) et « Niveau » (Rang de compte) sont deux
  // classements DISTINCTS : la vague la plus haute n'est pas le même critère
  // que le Rang, qui mesure des séries d'épreuves indépendantes de la
  // progression de combat (cf. rankQuestSeries côté serveur).
  const hints={
    stage:'Meilleure vague jamais atteinte, toutes runs confondues. Améliore ton DPS pour aller plus loin. Clique un joueur pour voir son équipe.',
    level:'Rang de compte le plus élevé (séries d’épreuves validées : ennemis, frappes, améliorations, compétences, recrues) — indépendant de la vague atteinte. Termine tes objectifs de Rang pour grimper.',
    speed:'Prestige le plus rapide : le temps de la meilleure run terminée. Optimise ta boucle pour prestiger plus vite.',
    rift:'Meilleur palier de la Faille dimensionnelle cette semaine (remise à zéro chaque lundi). Débloquée au niveau 20.',
    collection:'Nombre de héros distincts recrutés. Invoque avec tes Sceaux pour compléter ta collection.',
    friends:'Tes amis triés par meilleure vague. Ouvre une ligne pour comparer leur build.',
  };
  if(hint)hint.textContent=hints[type]||'Ouvre un joueur pour inspecter sa composition active.';
  if(list)list.innerHTML='<p class="hint">Chargement…</p>';
  try{const data=type==='friends'?await api('/api/idle/social'):await api(`/api/idle/leaderboard?type=${encodeURIComponent(type)}`);const players=type==='friends'?data.friends:data.players;if(list)list.innerHTML=idleRankingRows(players,type);}catch(e){if(list)list.innerHTML=`<p class="hint">${escapeHtml(e.message)}</p>`;}
}
function idlePlayerTeamText(player){return (player.team||[]).map((slot)=>`${slot.leader?'★ ':''}${slot.character.name} niv. ${slot.level}`).join(' · ');}
async function openIdlePlayer(userId){
  const modal=document.getElementById('idle-player-modal');const content=document.getElementById('idle-player-content');modal?.classList.remove('hidden');if(content)content.innerHTML='<p class="hint">Chargement…</p>';
  try{const data=await api(`/api/idle/players/${encodeURIComponent(userId)}`);const p=data.player;idleInspectedPlayer=p;if(!content)return;
    content.innerHTML=`<header class="idle-player-head"><span class="avatar" ${p.avatarUrl?`style="background-image:url('${escapeHtml(p.avatarUrl)}')"`:''}></span><div><small>ÉQUIPE PUBLIQUE</small><h3 id="idle-player-title">${escapeHtml(p.name)}</h3><span>${escapeHtml(p.className)} · ${escapeHtml(p.formation)}</span></div><button type="button" id="idle-player-share"><i class="fas fa-share-nodes"></i> Partager</button></header><div class="idle-player-stats"><span><small>Vague record</small><b>${idleFormatNumber(p.stage)}</b></span><span><small>DPS d'équipe</small><b>${idleFormatNumber(p.totalRate)}</b></span><span><small>Rang</small><b>${idleFormatNumber(p.level)}</b></span><span><small>Prestige</small><b>${idleFormatNumber(p.prestige)}</b></span><span><small>Faille</small><b>${idleFormatNumber(p.rift)}</b></span><span><small>Collection</small><b>${idleFormatNumber(p.collection)}</b></span></div><div class="idle-player-synergy"><i class="fas fa-people-arrows"></i><span><small>SYNERGIE ACTIVE</small><b>${escapeHtml(p.synergy?.name||'Aucune')}</b><em>${p.synergy?.bonus?`+${Math.round(p.synergy.bonus*100)}% DPS`:p.synergy?.bestSeries?escapeHtml(p.synergy.bestSeries):'Composition libre'}</em></span></div><div class="idle-public-team">${(p.team||[]).map((slot)=>`<article class="r-${escapeHtml(slot.character.rarity||'common')} ${slot.leader?'leader':''}"><span class="idle-public-portrait" ${slot.character.imageUrl?`style="background-image:url('${escapeHtml(slot.character.imageUrl)}')"`:''}></span><div><small>${slot.leader?'<i class="fas fa-crown"></i> CHEF':escapeHtml(slot.role)}</small><b>${escapeHtml(slot.character.name)}</b><span>Niv. ${idleFormatNumber(slot.level)}${slot.ascension?` · Asc. ${slot.ascension}`:''}${slot.awakenStars?` · ★${slot.awakenStars}`:''}</span><em>${escapeHtml(slot.character.series||'Licence inconnue')} · ${slot.equipmentCount}/3 objets</em></div></article>`).join('')||idleEmptyState('fa-user-plus','Équipe vide','Ce joueur n’a aucun héros actif.')}</div>`;
  }catch(e){if(content)content.innerHTML=`<p class="hint">${escapeHtml(e.message)}</p>`;}
}
async function shareIdlePlayer(){const p=idleInspectedPlayer;if(!p)return;const text=`Anime Ascension — ${p.name}\nVague ${p.stage} · Rang ${p.level} · ${idleFormatNumber(p.totalRate)} DPS\n${idlePlayerTeamText(p)}`;try{if(navigator.share)await navigator.share({title:`Équipe de ${p.name}`,text});else{await navigator.clipboard.writeText(text);idleNotify('Composition copiée dans le presse-papiers.','success');}}catch(e){if(e?.name!=='AbortError')idleNotify('Impossible de partager cette composition.','error');}}
async function claimIdleAchievement(key) { try { const r = await api('/api/idle/achievement/claim', { method: 'POST', body: JSON.stringify({ key }) }); idleSpawnFloat(`SUCCÈS +${idleFormatNumber(r.reward)}`, 'crit'); if(r.tokens)idleNotify(`+${idleFormatNumber(r.tokens)} tokens gacha gagnés !`,'success'); if (typeof burstConfetti === 'function') burstConfetti(25); await refreshIdleState(); } catch (e) { alert(e.message); } }
async function claimIdleEvent() { try { const r = await api('/api/idle/event/claim', { method: 'POST', body: JSON.stringify({}) }); idleSpawnFloat(`CONVERGENCE +${idleFormatNumber(r.reward)}`, 'crit'); await refreshIdleState(); } catch (e) { alert(e.message); } }

async function claimIdleMission(key) {
  try { const r = await api('/api/idle/mission/claim', { method: 'POST', body: JSON.stringify({ key }) }); idleSpawnFloat(`MISSION +${idleFormatNumber(r.reward)}`, 'xp'); await refreshIdleState(); }
  catch (e) { alert(e.message); }
}

// Réclame en un appel tout ce qui est déjà complété (missions, défis, succès,
// paliers de saison, convergence hebdomadaire) — évite de cliquer chaque
// bouton « Réclamer » un par un une fois qu'on a plusieurs objectifs en attente.
async function claimAllIdle() {
  const btn = document.getElementById('idle-claim-all');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Réclamation…'; }
  try {
    const r = await api('/api/idle/claim-all', { method: 'POST', body: JSON.stringify({}) });
    if (r.claimed > 0) {
      idleSpawnFloat(`TOUT RÉCLAMÉ · +${idleFormatNumber(r.seals)} SCEAUX${r.essence ? ` · +${idleFormatNumber(r.essence)} ESSENCE` : ''}`, 'crit huge');
      idleNotify(`${r.claimed} récompense${r.claimed > 1 ? 's' : ''} réclamée${r.claimed > 1 ? 's' : ''} : +${idleFormatNumber(r.seals)} Sceaux${r.essence ? ` · +${idleFormatNumber(r.essence)} Essence` : ''}${r.tokens ? ` · +${idleFormatNumber(r.tokens)} tokens gacha` : ''}.`, 'success');
      if (typeof burstConfetti === 'function') burstConfetti(30);
      if (typeof sfx !== 'undefined' && sfx.idleChest) sfx.idleChest();
    } else {
      idleNotify('Rien à réclamer pour l’instant.', 'info');
    }
    renderIdleState(r.state);
    await loadIdleCommunityBoss();
  } catch (e) {
    idleNotify(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check-double"></i> Tout réclamer'; }
  }
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
  idleRenderBoss(world.boss||dojo.decor.boss, world.theme, battle?.world?.wave||1, battle?.isBoss?'boss':battle?.isElite?'elite':battle?.enemy?.key||'standard',battle?.world?.enemyName,battle?.enemyNumber||1);
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
function idleKillBurst(count, waveComplete=false) {
  const scene = document.getElementById('idle-scene');
  const fighter = document.getElementById('idle-decor-boss');
  if (scene) {
    scene.classList.remove('idle-kill-flash');
    scene.classList.remove('idle-wave-cleared');
    void scene.offsetWidth;
    scene.classList.add(waveComplete?'idle-wave-cleared':'idle-kill-flash');
  }
  if(fighter){fighter.classList.remove('idle-enemy-arrival');void fighter.offsetWidth;fighter.classList.add('idle-enemy-arrival');}
  idleSpawnFloat(count > 1 ? `×${count} ENNEMIS VAINCUS` : waveComplete?'VAGUE TERMINÉE !':'ENNEMI VAINCU !', waveComplete?'crit':'kill');
  if (typeof sfx !== 'undefined') { if(waveComplete&&sfx.idleWave)sfx.idleWave();else if(sfx.idleKill)sfx.idleKill(); }
}

// Une synchronisation peut solder plusieurs vagues si l'équipe est largement
// plus forte que les ennemis. L'état serveur final reste autoritaire, mais on
// restitue chaque transition dans l'ordre pour ne plus donner l'impression
// que la numérotation saute (par exemple directement de 6 à 8).
function idleShowWaveSequence(fromStage,toStage){
  idleWaveTransitionTimers.forEach(clearTimeout);idleWaveTransitionTimers=[];
  const crossed=[];for(let stage=fromStage+1;stage<=toStage&&crossed.length<10;stage++)crossed.push(stage);
  if(crossed.length<2)return;
  idleAddCombatLog(`Progression auto : ${crossed.map((stage)=>`vague ${((stage-1)%10)+1}`).join(' → ')}`,'fa-forward-step');
  crossed.forEach((stage,index)=>{
    const timer=setTimeout(()=>idleSpawnFloat(`VAGUE ${((stage-1)%10)+1}/10`,'xp'),index*420);
    idleWaveTransitionTimers.push(timer);
  });
  idleAnnounce(`${crossed.length} vagues franchies automatiquement : ${crossed.map((stage)=>((stage-1)%10)+1).join(', puis ')}.`);
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
  // Le fond peint suffit : les silhouettes SVG ajoutaient une maison, un
  // temple ou des lampadaires dans des mondes auxquels ils n'appartiennent pas.
  box.replaceChildren();
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
function idleRenderBoss(boss, theme, wave=1, kind='normal', enemyName='Adversaire', enemyNumber=1) {
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
  el.dataset.archetype=kind;
  const enemyAtlases = Object.fromEntries(['wood','garden','temple','gold','celestial','hueco','ua','shibuya','aincrad','void'].map((key)=>[key,`/assets/idle/enemies/world-${key}-v1.webp`]));
  const atlas = enemyAtlases[theme];
  if (atlas) {
    const spriteIndex = kind === 'boss' ? 5 : kind === 'elite'||kind==='captain' ? 4 : (Math.max(1,wave)+Math.max(1,enemyNumber)-2)%4;
    const x = [0,50,100,0,50,100][spriteIndex];
    const y = spriteIndex < 3 ? 0 : 100;
    el.classList.add('idle-scene-fighter');
    el.innerHTML = `<span class="idle-fighter-sprite idle-enemy-sprite" role="img" aria-label="${escapeHtml(enemyName)}" style="background-image:url('${atlas}');background-position:${x}% ${y}%"></span>
      <span class="idle-boss-name"><small>${kind==='boss'?'BOSS':kind==='elite'?'ÉLITE':kind==='captain'?'CAPITAINE':kind==='armored'?'BLINDÉ':kind==='swift'?'RAPIDE':'ENNEMI'}</small><b>${escapeHtml(enemyName)}</b></span>`;
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
  const stageReady=dojo.prestige.runBestStage>=dojo.prestige.minStage;const remainingMs=Math.max(0,(dojo.prestige.minRunMs||0)-(dojo.prestige.runElapsedMs||0));const remainingMinutes=Math.ceil(remainingMs/60000);
  if (btn) btn.disabled = !dojo.prestige.eligible;
  if (hint) {
    hint.textContent = dojo.prestige.eligible
      ? `Prestige disponible : +${idleFormatNumber(dojo.prestige.reward)} Sagesse.`
      : !stageReady?`Atteins le stage ${dojo.prestige.minStage} pendant cette run (record : ${dojo.prestige.runBestStage}).`:`Stage atteint · stabilise encore cette run pendant ${remainingMinutes} min avant le Prestige.`;
  }
  const quick=document.getElementById('idle-prestige-quick');
  if(quick){
    quick.classList.toggle('available',!!dojo.prestige.eligible);
    quick.innerHTML=`<i class="fas fa-brain"></i><span><small>${dojo.prestige.eligible?'ASCENSION DISPONIBLE':'PROCHAINE ASCENSION'}</small><b>+${idleFormatNumber(dojo.prestige.reward)} Sagesse</b><em>${dojo.prestige.eligible?'Voir et confirmer':stageReady?`Stage validé · encore ${remainingMinutes} min`:'Record '+idleFormatNumber(dojo.prestige.runBestStage)+' / '+idleFormatNumber(dojo.prestige.minStage)}</em></span><i class="fas fa-arrow-right"></i>`;
  }
  const paths=document.getElementById('idle-prestige-paths');
  if(paths){
    // Les Voies de Prestige ont été supprimées (redondantes avec classes,
    // bénédictions et Ancients). L'emplacement affiche désormais la Mémoire
    // du Maître : les niveaux gratuits offerts à la prochaine Retraite.
    const startingLevels=dojo.prestige.startingLevels||0;
    paths.classList.remove('locked');
    paths.innerHTML=`<div class="idle-locked-teaser"><i class="fas fa-forward-fast"></i><div><small>MÉMOIRE DU MAÎTRE</small><b>Reprise accélérée</b><span>${startingLevels?`Prochaine Retraite : Discipline et Concentration démarrent au niveau ${startingLevels}.`:'Chaque Prestige offre des niveaux de départ (Discipline + Concentration) à la run suivante.'}</span></div></div>`;
  }
  const preview=document.getElementById('idle-prestige-preview');const details=dojo.prestige.preview;
  if(preview&&details){const value=(v)=>typeof v==='number'?idleFormatNumber(v):escapeHtml(String(v));preview.innerHTML=`<section class="reset"><header><i class="fas fa-rotate-left"></i><span><b>RÉINITIALISÉ</b><small>Progression de cette run</small></span></header>${details.reset.map((item)=>`<p><span>${escapeHtml(item.label)}</span><strong>${value(item.before)} <i class="fas fa-arrow-right"></i> ${value(item.after)}</strong></p>`).join('')}</section><section class="kept"><header><i class="fas fa-shield-heart"></i><span><b>CONSERVÉ</b><small>Progression permanente</small></span></header>${details.kept.map((item)=>`<p><span>${escapeHtml(item.label)}</span><strong>${value(item.value)}</strong></p>`).join('')}</section><aside><i class="fas fa-circle-info"></i>${escapeHtml(details.note)}</aside>`;}
  const history=document.getElementById('idle-run-history-content');const efficiency=dojo.prestige.efficiency;
  if(history&&efficiency){
    const formatMs=(ms)=>idleFormatDuration(Math.max(0,Math.round((ms||0)/1000)));
    const recommendation=efficiency.recommendation==='push'
      ? `<span class="push"><i class="fas fa-forward"></i><span><b>Continuer la run</b><small>Le rendement actuel est inférieur à ta moyenne. Le prochain point de Sagesse arrive au stage ${idleFormatNumber(efficiency.nextWisdomStage)}.</small></span></span>`
      : efficiency.recommendation==='prestige'
        ? `<span class="prestige"><i class="fas fa-arrows-rotate"></i><span><b>Fenêtre de Prestige efficace</b><small>Ton rendement actuel est au niveau de tes runs précédentes ou supérieur.</small></span></span>`
        : `<span><i class="fas fa-chart-line"></i><span><b>Première référence en préparation</b><small>Ton premier Prestige créera une base de comparaison pour les runs suivantes.</small></span></span>`;
    history.innerHTML=`<div class="idle-run-efficiency">${recommendation}<span><small>RENDEMENT ACTUEL</small><b>${Number(efficiency.currentWisdomPerHour||0).toFixed(2)} Sagesse/h</b></span><span><small>MOYENNE HISTORIQUE</small><b>${efficiency.total?Number(efficiency.averageWisdomPerHour||0).toFixed(2)+' Sagesse/h':'—'}</b></span><span><small>PROCHAIN GAIN</small><b>Stage ${idleFormatNumber(efficiency.nextWisdomStage)}</b></span></div>${efficiency.runs?.length?`<div class="idle-run-history-list">${efficiency.runs.map((run)=>`<article><span><small>PRESTIGE ${run.prestigeLevel}</small><b>Stage ${idleFormatNumber(run.bestStage)}</b></span><span><small>DURÉE</small><b>${formatMs(run.durationMs)}</b></span><span><small>SAGESSE</small><b>+${idleFormatNumber(run.wisdomGained)}</b></span><span><small>DPS FINAL</small><b>${idleFormatNumber(run.teamDps)}/s</b></span><span><small>BUILD</small><b>${run.heroCount} héros · ${(run.blessings||[]).length} pouvoirs</b></span></article>`).join('')}</div>`:'<p class="hint">Aucune run terminée pour le moment.</p>'}`;
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
  autoClickRate: (v) => `${v} frappe${v > 1 ? 's' : ''} automatique${v > 1 ? 's' : ''}/s ajoutée${v > 1 ? 's' : ''} au DPS / niveau`,
  startStage: (v) => `Chaque run démarre ${v} niveaux de combat plus loin / niveau`,
  bossRewardMult: (v) => `+${(v * 100).toFixed(0)}% d'Essence des coffres de boss / niveau`,
};
// Ancients : arbre de talents PERMANENT (jamais reset), payé en Sagesse — pas
// en essence. 4 branches × 6 paliers (voir ANCIENT_BRANCHES/ANCIENTS côté
// serveur, src/idle/idle.js) : chaque palier exige le précédent DE LA MÊME
// BRANCHE acheté (`it.unlocked`, déjà résolu côté serveur) — une chaîne
// linéaire par branche plutôt qu'un graphe, pour rester lisible d'un coup
// d'œil. `data-ancient` reste le point de routage vers /api/idle/ancient.
function renderIdleAncients(ancients) {
  const box = document.getElementById('idle-ancients');
  const points = document.getElementById('idle-wisdom-points');
  if (points) points.textContent = idleFormatNumber(ancients.points);
  if (!box) return;
  // De la Sagesse à dépenser : la section repliée se déplie toute seule (une
  // fois par session, pour ne pas lutter contre le joueur qui la referme),
  // un compteur s'affiche sur son titre et le bouton SAGESSE du HUD pulse.
  const affordable = ancients.items.filter((it) => it.unlocked && ancients.points >= it.cost).length;
  const section = box.closest('.idle-collapsible');
  if (section && affordable && !idleAncientsAutoOpened) { section.classList.remove('collapsed'); idleAncientsAutoOpened = true; }
  const title = section?.querySelector('.idle-collapse-title > span');
  if (title) {
    let badge = title.querySelector('.idle-collapse-badge');
    if (!affordable) badge?.remove();
    else {
      if (!badge) { badge = document.createElement('b'); badge.className = 'idle-collapse-badge'; title.appendChild(badge); }
      badge.textContent = `${affordable} achetable${affordable > 1 ? 's' : ''}`;
    }
  }
  document.getElementById('idle-spend-wisdom')?.classList.toggle('idle-affordable', affordable > 0);
  const byKey = new Map(ancients.items.map((it) => [it.key, it]));
  const focus=ancients.focus;const focusHtml=`<div class="idle-prestige-focus"><i class="fas ${escapeHtml(focus?.icon||'fa-compass')}"></i><span><small>ORIENTATION PERMANENTE</small><b>${focus?`${escapeHtml(focus.name)} · ${focus.levels} niveau${focus.levels>1?'x':''}`:'Choisis ta première voie'}</b><em>${focus?escapeHtml(focus.description):'Offensive, Résilience, Croissance ou Économie : tes achats dessinent le style de tes prochaines runs.'}</em></span>${focus?.nextName?`<strong>Prochain : ${escapeHtml(focus.nextName)} · ${idleFormatNumber(focus.nextCost)} Sagesse</strong>`:''}</div>`;
  box.innerHTML = `${focusHtml}<div class="idle-talent-tree">${(ancients.branches || []).map((branch) => {
    const nodes = ancients.items.filter((it) => it.branch === branch.key).sort((a, b) => a.tier - b.tier);
    return `<div class="idle-talent-branch">
      <header><i class="fas ${branch.icon}"></i><div><b>${escapeHtml(branch.name)}</b><small>${escapeHtml(branch.description)}</small></div></header>
      <div class="idle-talent-column">${nodes.map((it, idx) => {
        const desc = (IDLE_ANCIENT_DESC[it.kind] || (() => ''))(it.effectPerLevel);
        const affordableNode = it.unlocked && ancients.points >= it.cost;
        const prereqName = it.requires ? byKey.get(it.requires)?.name : null;
        return `${idx > 0 ? `<div class="idle-talent-connector ${nodes[idx - 1].level > 0 ? 'active' : ''}"></div>` : ''}<div class="idle-talent-node${it.unlocked ? '' : ' locked'}${it.level > 0 ? ' owned' : ''}${it.tier === 6 ? ' capstone' : ''}">
          <div class="idle-talent-node-ico"><i class="fas ${it.unlocked ? it.icon : 'fa-lock'}"></i>${it.level > 0 ? `<span class="idle-talent-node-lvl">${it.level}</span>` : ''}</div>
          <div class="idle-talent-node-info">
            <h4>${escapeHtml(it.name)}</h4>
            <p>${it.unlocked ? desc : `Nécessite ${escapeHtml(prereqName || 'le talent précédent')}`}</p>
          </div>
          <button class="btn-secondary idle-ancient-btn${affordableNode ? ' idle-affordable' : ''}" data-ancient="${it.key}" ${(!it.unlocked || ancients.points < it.cost) ? 'disabled' : ''}>${idleFormatNumber(it.cost)} <i class="fas fa-brain"></i></button>
        </div>`;
      }).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

function idleHeroMilestonesHTML(character, sheet = false) {
  const milestones=character?.milestones||[];if(!milestones.length)return'';
  const next=milestones.find((item)=>!item.reached);
  return `<section class="idle-hero-milestone-guide ${sheet?'sheet':''}"><header><span><i class="fas fa-flag-checkered"></i><b>Paliers de puissance</b></span><small>Chaque palier atteint double la production du personnage. Les bonus se cumulent.</small></header><div>${milestones.map((item)=>`<span class="${item.reached?'reached':item===next?'next':''}" title="${escapeHtml(item.effect)} · multiplicateur cumulé ×${item.cumulativeMultiplier}"><b>Niv. ${item.target}</b><em>${item.target===10?'×2 + passif':item.target===(character.ascensionLevel||100)?'×2 + Ascension':'Production ×2'}</em>${item.reached?'<i class="fas fa-check"></i>':''}</span>`).join('')}</div>${next?`<p><i class="fas fa-arrow-trend-up"></i> Prochain : <b>niveau ${next.target}</b> · ${escapeHtml(next.effect)} · multiplicateur total des paliers <strong>×${next.cumulativeMultiplier}</strong></p>`:'<p><i class="fas fa-circle-check"></i> Tous les paliers sont atteints.</p>'}</section>`;
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
  const isLeader=idleState?.strategy?.leaderCharacterId===c.id;
  const img = c.imageUrl ? ` style="background-image:url('${c.imageUrl}')"` : '';
  // Carte compactée (retour "trop lourd") : 2 lignes par emplacement au lieu
  // de 3 — le set reste visible (essentiel pour viser un 2/4 pièces), l'effet
  // et le "Changer" (implicite, tout le bouton est cliquable) passent dans le
  // tooltip plutôt qu'imprimés en permanence.
  const equipment=c.equipments.map((e)=>{const meta=IDLE_ITEM_META[e.kind]||IDLE_ITEM_META.rune1;return e.empty?`<button class="empty" data-action="team-gear" data-slot="${slot.index}" data-kind="${escapeHtml(e.kind)}" title="Équiper ${meta.label} sur ${escapeHtml(c.name)}"><i class="fas ${meta.icon}"></i><div><small>${meta.label}</small><b>Équiper</b></div></button>`:`<button class="r-${e.rarity}" data-action="team-gear" data-slot="${slot.index}" data-kind="${escapeHtml(e.kind)}" title="${escapeHtml(idleItemEffect(e))} · Changer ${meta.label} pour ${escapeHtml(c.name)}"><i class="fas ${meta.icon}"></i><span><small>${meta.label} · ${escapeHtml(e.setName||'Énergie')}</small><b>+${e.enhancementLevel||0} ${escapeHtml(e.name)}</b></span></button>`;}).join('');
  // data-action="pick" sur le conteneur : cliquer la carte propose de la
  // remplacer (un seul geste, au lieu de retirer puis réassigner). Les
  // boutons ×/niveau matchent leur propre data-action en premier dans la
  // délégation d'événements (cf. initIdleUI), donc pas de conflit.
  return `<div class="idle-hero r-${c.rarity} ${isLeader?'is-leader':''} ${c.awakened?'is-awakened':''}" data-slot="${slot.index}" data-action="pick" title="${escapeHtml(c.name)} — cliquer pour remplacer">
    <div class="idle-hero-portrait"${img}>${c.awakened?'<span class="idle-awakened-badge" title="Héros Éveillé · +10% de production personnelle">✦ ÉVEILLÉ</span>':''}</div>
    <button class="idle-hero-remove" data-slot="${slot.index}" data-action="unassign" title="Retirer"><i class="fas fa-xmark"></i></button>
    <button class="idle-hero-details" data-slot="${slot.index}" data-action="details" title="Voir la fiche complète"><i class="fas fa-circle-info"></i><span>Fiche</span></button>
    <button class="idle-hero-leader" data-character-id="${c.id}" data-action="leader" title="${isLeader?'Chef d’équipe actuel':'Définir comme chef d’équipe'}" ${isLeader?'disabled':''}><i class="fas fa-crown"></i><span>${isLeader?'Chef actuel':'Définir comme chef'}</span></button>
    <div class="idle-hero-name">${escapeHtml(c.name)}</div>
    <div class="idle-hero-meta">
      <span class="idle-hero-lvl">Nv. ${idleFormatNumber(c.level)}</span>
      <span class="idle-hero-rate" title="DPS personnel ${idleFormatNumber(c.personalRate||c.rate)}/s × bonus d’équipe ${Number(c.teamMultiplier||1).toFixed(2)}"><i class="fas ${role.icon}" style="color:${role.color}"></i> ${role.name} · DPS réel ${idleFormatNumber(c.rate)}/s</span>
      ${c.ascension ? `<span class="idle-ascension-rank"><i class="fas fa-sun"></i> A${c.ascension} · ×${c.ascensionMultiplier}</span>` : ''}
    </div>
    <div class="idle-hero-passive ${c.passiveUnlocked ? 'unlocked' : 'locked'}"><i class="fas ${c.passiveUnlocked ? 'fa-wand-sparkles' : 'fa-lock'}"></i><span><b>Passif</b><small>${escapeHtml(c.passive)}</small></span><em>${c.passiveUnlocked ? 'Actif' : 'Niv. 10'}</em></div>
    <details class="idle-hero-more" data-more-key="hero-${slot.index}" ${idleOpenDetails.has(`hero-${slot.index}`)?'open':''}>
      <summary><i class="fas fa-circle-info"></i> Talents, compétences et paliers <i class="fas fa-chevron-down"></i></summary>
      <div class="idle-hero-stats"><span><small>Production de base</small><b>${idleFormatNumber(c.baseRate)}/s</b></span><span><small>Gain par niveau</small><b>+${Math.round(c.scaling * 100)}%</b></span></div>
      <div class="idle-leader-skill ${isLeader?'active':''}"><i class="fas fa-crown"></i><span><small>LEAD SKILL ${isLeader?'ACTIF':'INACTIF'}</small><b>${escapeHtml(c.leaderSkill?.name||'Commandement')}</b><em>${escapeHtml(c.leaderSkill?.description||'Désigne ce héros comme chef pour activer son bonus.')}</em></span><strong>${isLeader?'APPLIQUÉ':'CHOISIR'}</strong></div>
      <div class="idle-character-talent"><i class="fas fa-fingerprint"></i><span><b>${escapeHtml(c.talent.name)}</b><small>${escapeHtml(c.talent.description)}</small></span></div>
      <div class="idle-character-talent combat"><i class="fas fa-bolt"></i><span><b>${escapeHtml(c.combatSkill?.name||'Technique')}</b><small>${escapeHtml(c.combatSkill?.description||'Compétence de combat')}</small></span></div>
      ${idleHeroMilestonesHTML(c)}
    </details>
    <div class="idle-equipment-title"><i class="fas fa-shield-halved"></i> ÉQUIPEMENT <small>6 runes · sets 2/4 pièces</small></div>
    <div class="idle-equipment">${equipment}</div>
    <div class="idle-level-buys">${(()=>{const buyCost=idleQuickBuyCost(c,idleBuyAmount);const affordable=idleState&&(idleBuyAmount==='max'?idleState.essence>=(c.levelUpCost||1):idleState.essence>=buyCost);const menuOpen=idleLevelupMenuSlot===slot.index;return `<button class="idle-hero-levelup ${affordable?'idle-affordable':''}" data-slot="${slot.index}" data-amount="${idleBuyAmount}" data-action="levelup" aria-disabled="${affordable?'false':'true'}" title="${affordable?`Monter ${escapeHtml(c.name)} de ${idleBuyAmount==='max'?'tous les niveaux abordables':`${idleBuyAmount} niveau${idleBuyAmount==='1'?'':'x'}`}`:`Essence insuffisante pour ${idleBuyAmount==='max'?'un niveau':`×${idleBuyAmount}`} — cliquer pour changer la quantité`}"><i class="fas fa-arrow-up"></i> <b>${idleBuyAmount==='max'?'MAX':`×${idleBuyAmount}`}</b><small>${idleBuyAmount==='max'?'budget dispo':idleFormatNumber(buyCost)}</small></button><button type="button" class="idle-hero-levelup-caret" data-slot="${slot.index}" data-action="levelup-menu" aria-haspopup="true" aria-expanded="${menuOpen}" title="Choisir la quantité"><i class="fas fa-chevron-down"></i></button>${menuOpen?`<div class="idle-levelup-menu">${IDLE_BUY_AMOUNTS.map((a)=>`<button type="button" data-buy-amount="${a}" class="${a===idleBuyAmount?'active':''}">${a==='max'?'MAX':`×${a}`}</button>`).join('')}</div>`:''}`;})()}</div>
    <div class="idle-power-row">
      ${c.canAscend ? `<button class="idle-ascend-btn" data-slot="${slot.index}" data-action="ascend" title="Augmente la puissance sans perdre les niveaux · réinitialisée au Prestige" ${idleState && idleState.essence < c.ascensionCost ? 'disabled' : ''}><i class="fas fa-sun"></i> ×${idleFormatNumber(c.ascensionCost)}</button>` : c.ascension >= (c.ascensionMax||10) ? `<span class="idle-ascend-max" title="Ascension maximale · ×${Number(c.ascensionMultiplier||1).toFixed(2)}, réinitialisée au Prestige"><i class="fas fa-sun"></i> MAX ×${Number(c.ascensionMultiplier||1).toFixed(2)}</span>` : `<span class="idle-ascend-hint" title="Ascension au niveau ${c.ascensionLevel||100} · niveaux conservés"><i class="fas fa-lock"></i> Nv. ${c.ascensionLevel||100}</span>`}
      ${(c.awakenStars||0)<(c.awakenStarMax||10)
        ? `<button class="idle-ascend-btn idle-awaken-btn" data-character="${c.id}" data-action="awaken" title="+${Math.round((c.awakenStarBonus||.08)*100)}% de production personnelle par étoile · permanent, conservé au Prestige" ${idleState && idleState.essence < c.awakenStarCost ? 'disabled' : ''}><i class="fas fa-star"></i> ${c.awakenStars||0}/${c.awakenStarMax||10} · ${idleFormatNumber(c.awakenStarCost)}</button>`
        : `<span class="idle-ascend-max" title="Éveil maximal · ×${Number(c.awakenStarMultiplier||1).toFixed(2)} permanent"><i class="fas fa-star"></i> MAX ×${Number(c.awakenStarMultiplier||1).toFixed(2)}</span>`}
    </div>
  </div>`;
}

function renderIdleSlots(slots) {
  const heroes=slots.filter((slot)=>!slot.locked&&slot.character);
  const compact=slots.filter((slot)=>slot.locked||!slot.character);
  return `${heroes.length?`<div class="idle-slot-grid idle-slot-heroes">${heroes.map(idleSlotHTML).join('')}</div>`:''}
    ${compact.length?`<section class="idle-slot-management"><h4><i class="fas fa-table-cells-large"></i> Gestion des emplacements <span>${slots.length-compact.filter((slot)=>slot.locked).length}/${slots.length} débloqués</span></h4><div class="idle-slot-grid idle-slot-compact">${compact.map(idleSlotHTML).join('')}</div></section>`:''}`;
}

// Coût/quantité à afficher pour une carte d'amélioration selon la quantité
// d'achat globale sélectionnée (idleBuyAmount, cf. dock ×1/×5/×10/×100/MAX
// déjà utilisé pour l'entraînement des héros — même sélecteur, mêmes achats
// groupés, ici pour Discipline/Concentration/Instinct/Flux).
function idleUpgradeBuyPlan(item) {
  if (idleBuyAmount === '1' || !item.bulkCosts) return { amount: 1, cost: item.cost, count: 1 };
  // `after` : stat projetée une fois le lot acheté (serveur) — sans elle, la
  // carte affichait l'aperçu du seul niveau suivant quel que soit ×5/×10/×100
  // (retour joueur). Pour MAX, aperçu au nombre de niveaux abordables au
  // moment du rendu ; le coût exact reste décidé à l'achat (budget entier).
  if (idleBuyAmount === 'max') return { amount: 'max', cost: null, count: item.bulkCosts.max?.count ?? null, after: item.bulkCosts.max?.after };
  const bulk = item.bulkCosts[idleBuyAmount];
  if (!bulk) return { amount: 1, cost: item.cost, count: 1 }; // déjà au plafond sur ce lot : retombe sur ×1
  return { amount: idleBuyAmount === '5' ? 5 : idleBuyAmount === '10' ? 10 : 100, cost: bulk.cost, count: bulk.count, after: bulk.after };
}
function renderIdleUpgrades(state) {
  const nextSlotCost = state.slots.find((s) => s.locked)?.unlockCost ?? null;
  const rate=Math.max(0,state.totalRate||0);
  const essence=Math.max(0,state.essence||0);
  const waitLabel=(cost)=>cost<=essence?'Achetable maintenant':rate>0?`Environ ${Math.ceil((cost-essence)/rate)}s de production`:'Assigne un producteur';
  const items = [
    {
      type: 'prod', icon: 'fa-brain', title: 'Discipline', level: state.prod.level, maxed: state.prod.maxed, cost: state.prod.nextCost, bulkCosts: state.prod.bulkCosts, bulk: true,
      label:'Production automatique',before:`×${state.prod.multiplier.toFixed(2)}`,after:`×${(state.prod.nextMultiplier??state.prod.multiplier).toFixed(2)}`,formatAfter:(v)=>`×${Number(v).toFixed(2)}`,desc:'Augmente toute la production de l’équipe, en ligne et hors ligne.',
    },
    {
      type: 'click', icon: 'fa-hand-fist', title: 'Concentration', level: state.click.level, maxed: state.click.maxed, cost: state.click.nextCost, bulkCosts: state.click.bulkCosts, bulk: true,
      label:'Dégâts par clic',before:idleFormatNumber(state.click.damage ?? state.click.yield),after:idleFormatNumber(state.click.nextDamage ?? state.click.damage ?? state.click.yield),formatAfter:(v)=>idleFormatNumber(v),desc:'Renforce les frappes manuelles et la base de dégâts de l’Ultime.',
    },
    {
      type: 'slot', icon: 'fa-square-plus', title: 'Nouvel emplacement', level: state.slotsUnlocked, maxed: state.slotsUnlocked >= state.maxSlots, cost: nextSlotCost,
      label:'Héros actifs',before:`${state.slotsUnlocked}/${state.maxSlots}`,after:`${Math.min(state.maxSlots,state.slotsUnlocked+1)}/${state.maxSlots}`,desc:'Ajoute une place pour un producteur et ses bonus de rôle, talent et équipement.',
    },
    {
      type:'crit',icon:'fa-bullseye',title:'Instinct',level:state.crit.level,maxed:state.crit.maxed,cost:state.crit.nextCost, bulkCosts: state.crit.bulkCosts, bulk: true,
      label:'Chance de coup critique',before:`${Math.round(state.crit.chance*100)}%`,after:`${Math.round((state.crit.nextChance??state.crit.chance)*100)}%`,formatAfter:(v)=>`${Math.round(v*100)}%`,desc:'Ajoute +1 point de chance critique aux frappes manuelles par niveau. Un critique inflige ×2 dégâts.',
    },
    {
      type:'cooldown',icon:'fa-stopwatch',title:'Flux',level:state.cooldown.level,maxed:state.cooldown.maxed,cost:state.cooldown.nextCost, bulkCosts: state.cooldown.bulkCosts, bulk: true,
      label:'Recharge des compétences',before:`${state.cooldown.burstSeconds}s · ${state.cooldown.teamSeconds}s`,after:`${state.cooldown.nextBurstSeconds??state.cooldown.burstSeconds}s · ${state.cooldown.nextTeamSeconds??state.cooldown.teamSeconds}s`,formatAfter:(v)=>`${v.burst}s · ${v.team}s`,desc:'Réduit de 2% par niveau la recharge de l’Ultime et du Combo. Se cumule avec les Supports.',
    },
    {
      type:'multistrike',icon:'fa-hand-sparkles',title:'Frappes Multiples',level:state.multiStrike.level,maxed:state.multiStrike.maxed,cost:state.multiStrike.nextCost, bulkCosts: state.multiStrike.bulkCosts, bulk: true,
      label:'Frappes simulées par clic',before:`+${Math.round(state.multiStrike.bonus*100)}%`,after:`+${Math.round((state.multiStrike.nextBonus??state.multiStrike.bonus)*100)}%`,formatAfter:(v)=>`+${Math.round(v*100)}%`,desc:'Chaque clic manuel simule des frappes supplémentaires (dégâts et kills comptés). Réinitialisé au Prestige.',
    },
  ];
  const available=items.filter((item)=>!item.maxed&&Number.isFinite(item.cost));
  const recommended=available.slice().sort((a,b)=>(a.cost<=essence?0:1)-(b.cost<=essence?0:1)||a.cost-b.cost)[0];
  const essenceEl=document.getElementById('idle-upgrade-essence');if(essenceEl)essenceEl.textContent=idleFormatNumber(essence);
  const productionEl=document.getElementById('idle-upgrade-production');if(productionEl)productionEl.textContent=`${idleFormatNumber(rate)}/s`;
  const clickEl=document.getElementById('idle-upgrade-click');if(clickEl)clickEl.textContent=idleFormatNumber(state.click.damage??state.click.yield);
  const recommendation=document.getElementById('idle-upgrade-recommendation');if(recommendation)recommendation.textContent=recommended?`${recommended.title} · ${waitLabel(recommended.cost)}`:'Toutes les améliorations sont au maximum';
  renderIdleBuyAmountControl('idle-upgrade-buy-amount');
  return items.map((it) => {
    const plan = it.bulk ? idleUpgradeBuyPlan(it) : { amount: 1, cost: it.cost, count: 1 };
    const label = plan.amount === 'max' ? 'MAX' : plan.count && plan.count !== 1 ? `×${plan.count}` : 'Améliorer';
    const affordable = plan.amount === 'max' ? essence >= (it.cost || Infinity) : plan.cost != null && essence >= plan.cost;
    const costLabel = plan.amount === 'max' ? 'budget' : idleFormatNumber(plan.cost);
    return `
    <div class="idle-upgrade-card idle-upgrade-${it.type} ${recommended===it?'recommended':''}">
      ${recommended===it?'<span class="idle-upgrade-best"><i class="fas fa-star"></i> CONSEILLÉ</span>':''}
      <div class="idle-upgrade-ico"><i class="fas ${it.icon}"></i></div>
      <div class="idle-upgrade-info">
        <small>${it.label}</small><h4>${it.title} <span class="idle-upgrade-lvl">Nv. ${it.level}</span></h4>
        <p>${it.desc}</p>
        <div class="idle-upgrade-comparison"><span><small>ACTUEL</small><b>${it.before}</b></span><i class="fas fa-arrow-right"></i><span><small>APRÈS ACHAT${plan.count&&plan.count>1?` ×${plan.count}`:''}</small><b>${plan.after!=null&&it.formatAfter?it.formatAfter(plan.after):it.after}</b></span></div>
      </div>
      ${it.maxed
        ? '<span class="idle-upgrade-maxed">MAX</span>'
        : `<div class="idle-upgrade-buy"><small>${plan.amount===1?waitLabel(it.cost):costLabel+' Essence'}</small><button class="btn-secondary idle-upgrade-btn${affordable ? ' idle-affordable' : ''}" data-upgrade="${it.type}" data-upgrade-amount="${plan.amount}"${affordable ? '' : ' disabled'}>${label} · ${costLabel} <i class="fas fa-mortar-pestle"></i></button></div>`}
    </div>`;
  }).join('');
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
  if (typeof sfx !== 'undefined' && sfx.idleHit) sfx.idleHit(false);
  const essenceEl = document.getElementById('idle-essence-val');
  if (essenceEl) idleBump(essenceEl);
}

async function clickIdle() {
  const now=Date.now();if(now<idleNextClickAt)return;idleNextClickAt=now+45;
  // Le Boss n'encaisse plus rien tant qu'il n'est pas engagé (cf. bouton
  // dédié) : mieux vaut le dire clairement que de laisser croire au joueur
  // que ses frappes comptent pour rien, silencieusement.
  if(idleState?.battle?.needsBossEngage){idleNotify('Clique « Affronter le Boss » pour lancer le combat.','info');return;}
  // Frénésie : enchaîner les frappes fait monter un combo purement visuel —
  // les chiffres grossissent, le compteur s'affiche à partir de 5. Aucune
  // influence sur les dégâts réels (le serveur reste seul juge).
  idleComboCount=now<idleComboExpireAt?idleComboCount+1:1;
  idleComboExpireAt=now+1400;
  idleRenderCombo();
  const predicted=idleState?.click?.damage||idleState?.click?.yield||1;
  const comboTier=idleComboCount>=40?'huge':idleComboCount>=15?'big':'';
  idleClickFeedback(predicted);idleSpawnFloat(`−${idleFormatNumber(predicted)}`,['damage',comboTier||idleFloatTier(predicted)].filter(Boolean).join(' '));
  // Chaque tap animé doit finir par être envoyé au serveur : plafonner ici à
  // 10 faisait perdre en silence les taps au-delà pendant qu'un envoi était
  // déjà en vol (le joueur voyait le coup, mais rien n'était jamais transmis
  // — retour testeur « les kills ne donnent pas toujours de gold »). Le
  // plafond de 200 n'est qu'un garde-fou, pas un mécanisme de troncature :
  // flushIdleClicks() envoie par lots de 10 (limite serveur) et rattrape
  // le solde tout seul, sans jamais perdre de tap.
  idleClickPending=Math.min(200,idleClickPending+1);
  if(!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,160);
}

function idleRenderCombo() {
  if(!idleSessionStats)resetIdleSessionStats(false);idleSessionStats.bestCombo=Math.max(idleSessionStats.bestCombo,idleComboCount);
  const scene=document.getElementById('idle-scene');if(!scene)return;
  let meter=scene.querySelector('.idle-combo-meter');
  const active=idleComboCount>=5&&Date.now()<idleComboExpireAt;
  if(!active){meter?.remove();return;}
  if(!meter){meter=document.createElement('span');meter.className='idle-combo-meter';meter.setAttribute('aria-hidden','true');scene.appendChild(meter);}
  meter.dataset.tier=idleComboCount>=40?'3':idleComboCount>=15?'2':'1';
  meter.innerHTML=`<small>COMBO</small><b>×${idleComboCount}</b>`;
  meter.classList.remove('pop');void meter.offsetWidth;meter.classList.add('pop');
}

async function flushIdleClicks(){
  idleClickFlushTimer=null;if(idleClickSending||(!idleClickPending&&!idleClickRetryBatch))return;
  // Le serveur ne traite jamais plus de 10 frappes par requête (POST /click).
  // On envoie donc par lots de 10 maximum et on ne retire du solde QUE ce qui
  // part réellement dans ce lot — tout reliquat déclenche automatiquement un
  // lot suivant (cf. fin de fonction), au lieu de vider tout le solde d'un
  // coup et perdre ce que le serveur n'aurait pas pu absorber.
  const batch=idleClickRetryBatch||{count:Math.min(10,idleClickPending),requestId:(globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9_-]/g,'')};if(!idleClickRetryBatch)idleClickPending-=batch.count;idleClickSending=true;let r;
  try{r=await api('/api/idle/click',{method:'POST',body:JSON.stringify(batch)});idleClickRetryBatch=null;}
  catch{idleClickRetryBatch=batch;}
  finally{idleClickSending=false;}
  if(!r){if((idleClickPending||idleClickRetryBatch)&&!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,250);return;}
  if(r.duplicate){await refreshIdleState();if(idleClickPending&&!idleClickFlushTimer)idleClickFlushTimer=setTimeout(flushIdleClicks,80);return;}
  const count=r.count||batch.count;
  // Le budget serveur par seconde peut n'accepter qu'une partie du lot
  // envoyé (count < batch.count) sans renvoyer d'erreur — le reliquat non
  // traité doit revenir dans le solde, sinon ces taps (déjà animés côté
  // client) disparaissent silencieusement au lieu d'être repris au lot
  // suivant.
  if(count<batch.count)idleClickPending+=batch.count-count;
  if(idleState)idleState.essence=r.essence;
  if(r.criticals){idleSpawnFloat(`${r.criticals>1?`${r.criticals}× `:''}CRITIQUE −${idleFormatNumber(r.damage||r.gained)}`,'damage crit huge');if(typeof sfx!=='undefined'&&sfx.idleHit)sfx.idleHit(true);idleCombatMotion('hero');}
  if(r.passiveKills)idleSpawnFloat(`ÉQUIPE AUTO · ${r.passiveKills} élimination${r.passiveKills>1?'s':''}`,'xp');
  idleRecordStrikeBatch(count, r.damage || 0, r.kills || 0, r.passiveKills || 0);
  idleForceHpSync=true;
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
  if (typeof sfx !== 'undefined' && sfx.idleHit) sfx.idleHit(false);
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
  if (typeof sfx !== 'undefined' && sfx.idleUpgrade) sfx.idleUpgrade();
  if (slotEl) idleCardBump(slotEl);
  refreshIdleState();
}
async function awakenIdleHero(characterId){
  try{
    const state=await api('/api/idle/hero-awaken',{method:'POST',body:JSON.stringify({characterId})});
    if(typeof burstConfetti==='function')burstConfetti(40);
    const character=(state.slots||[]).map((slot)=>slot.character).find((c)=>c?.id===(state.awaken?.characterId??characterId));
    const starMax=character?.awakenStarMax||10;const starBonus=Math.round((character?.awakenStarBonus||.08)*100);
    idleSpawnFloat(`ÉVEIL ${'★'.repeat(state.awaken?.stars||1)}`,'crit');
    idleNotify(`Éveil ${state.awaken?.stars||1}/${starMax} : +${starBonus}% de production personnelle permanente.`,'success');
    renderIdleState(state);
  }catch(e){idleNotify(e.message,'error');}
}
async function ascendIdleSlot(slotIndex) {
  if (!await idleConfirm('L’Ascension augmente la puissance du héros sans retirer ses niveaux. Elle sera réinitialisée au prochain Prestige.',{title:'Ascensionner ce héros ?',confirmLabel:'Ascensionner'})) return;
  try { const state = await api('/api/idle/slot-ascend', { method: 'POST', body: JSON.stringify({ slotIndex }) }); if (typeof burstConfetti === 'function') burstConfetti(60); idleSpawnFloat('ASCENSION · PUISSANCE DOUBLÉE', 'crit'); renderIdleState(state); }
  catch (e) { alert(e.message); }
}
async function optimizeIdleTeam(){const btn=document.getElementById('idle-optimize-team');if(btn)btn.disabled=true;try{const state=await api('/api/idle/optimize-team',{method:'POST',body:JSON.stringify({})});const o=state.optimization||{};idleSpawnFloat(`${o.placed||0} HÉROS PLACÉ${(o.placed||0)>1?'S':''}`,'crit');idleAddCombatLog(o.placed?`Remplissage : ${o.selected.join(', ')}`:'Aucun emplacement à combler','fa-user-plus');idleNotify(o.placed?`${o.placed} recrue${o.placed>1?'s':''} placée${o.placed>1?'s':''} dans les emplacements vides. À toi d’ajuster synergies et formation.`:'Aucun emplacement vide à combler.','success');if(typeof sfx!=='undefined'&&sfx.idleUpgrade)sfx.idleUpgrade();renderIdleState(state);}catch(e){idleNotify(e.message,'error');}finally{if(btn)btn.disabled=false;}}
async function enhanceIdleEquipment(itemId,amount=1){try{const state=await api('/api/idle/equipment/enhance',{method:'POST',body:JSON.stringify({itemId,amount})});idleSpawnFloat('OBJET AMÉLIORÉ','xp');renderIdleState(state);requestAnimationFrame(()=>{const card=Array.from(document.querySelectorAll('#idle-inventory-grid [data-item-id]')).find((node)=>node.dataset.itemId===String(itemId));card?.scrollIntoView({block:'center'});card?.classList.add('idle-item-focus');setTimeout(()=>card?.classList.remove('idle-item-focus'),1000);});}catch(e){idleNotify(e.message,'error');}}
function openIdleEquipmentForSlot(slotIndex,kind='all'){idleEquipmentTargetSlot=Number(slotIndex);idleItemFilter=kind||'all';persistIdleInventoryPrefs();document.querySelectorAll('#idle-item-filters [data-item-filter]').forEach((button)=>button.classList.toggle('active',button.dataset.itemFilter===idleItemFilter));idleShowPanel('equipment');requestAnimationFrame(()=>renderIdleInventory(idleState));}

async function buyIdleUpgrade(type, cardEl, amount = 1) {
  let result;
  try {
    result = await api('/api/idle/upgrade', { method: 'POST', body: JSON.stringify({ type, amount }) });
  } catch (e) {
    alert(e.message);
    return;
  }
  if (typeof sfx !== 'undefined' && sfx.idleUpgrade) sfx.idleUpgrade();
  const label={click:'Concentration',prod:'Discipline',crit:'Instinct',cooldown:'Flux'}[type]||'Emplacement';
  idleAddCombatLog(amount!==1&&amount!=='1'?`${label} amélioré (lot ${amount==='max'?'max':`×${amount}`})`:`${label} amélioré`,'fa-arrow-trend-up');
  if (cardEl) idleCardBump(cardEl);
  renderIdleState(result);
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
  if (typeof sfx !== 'undefined' && sfx.idleUpgrade) sfx.idleUpgrade();
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
  const slotLabel=document.getElementById('idle-picker-slot-label');if(slotLabel)slotLabel.textContent=String(slotIndex+1);
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
    data = await api(`/api/idle/roster?slotIndex=${encodeURIComponent(idlePickerSlot)}`);
  } catch (e) {
    document.getElementById('idle-picker-hint').textContent = e.message;
    return;
  }
  const assignedIds = new Set((idleState?.slots || []).filter((s) => s.character && s.index !== idlePickerSlot).map((s) => s.character.id));
  const available = (data.recruits || []).filter((c) => !assignedIds.has(c.id));
  idleRosterCharacters = new Map((data.recruits||[]).map((c)=>[Number(c.id),c]));
  idleRosterAvailable=available;
  renderIdleRosterList();
}

function idleRosterProjection(c){
  const active=(idleState?.slots||[]).filter((slot)=>slot.character&&slot.index!==idlePickerSlot).map((slot)=>slot.character);
  const sameSeries=active.filter((hero)=>hero.series&&hero.series===c.series).length+1;
  const synergyBonus=sameSeries>=3?.25:sameSeries===2?.10:active.length+1>=3?.05:0;
  const formation=(idleState?.strategy?.formations||[]).find((item)=>item.active);
  const roles=[...active.map((hero)=>hero.role),c.role];
  const formationReady=formation?.key==='assault'?roles.filter((role)=>['attaquant','assassin'].includes(role)).length>=2:formation?.key==='fortress'?roles.includes('tank')&&roles.includes('support'):formation?.key==='industry'?roles.includes('producteur')&&roles.includes('support'):false;
  const formationBonus=formationReady?({assault:.15,fortress:.20,industry:.18}[formation.key]||0):0;
  const exactDelta=Number(c.delta);
  const exactPercent=Number(c.deltaPercent);
  return {synergyBonus,formationBonus,sameSeries,exactDelta:Number.isFinite(exactDelta)?exactDelta:null,exactPercent:Number.isFinite(exactPercent)?exactPercent:null,score:Number.isFinite(exactDelta)?exactDelta:synergyBonus*1000+formationBonus*800+(IDLE_RARITY_ORDER[c.rarity]||0)*3+Math.log10(1+(c.rate||c.baseRate||0))*5};
}
// Insensible à la casse et aux accents (« Éveillé » doit matcher « eveille »).
function renderIdleRosterList(){
  const list=document.getElementById('idle-picker-list');const hint=document.getElementById('idle-picker-hint');if(!list||!hint)return;
  const searchNeedle=idleNormalizeSearch(idleRosterSearch);
  let available=idleRosterAvailable.filter((c)=>(idleRosterRole==='all'||c.role===idleRosterRole)&&(idleRosterRarity==='all'||c.rarity===idleRosterRarity)&&(!searchNeedle||idleNormalizeSearch(c.name).includes(searchNeedle)||idleNormalizeSearch(c.series||'').includes(searchNeedle)));
  const roleOrder={attaquant:1,producteur:2,support:3,tank:4,assassin:5};
  available=[...available].sort((a,b)=>{
    if(idleRosterSort==='name')return String(a.name).localeCompare(String(b.name),'fr');
    if(idleRosterSort==='role')return (roleOrder[a.role]||9)-(roleOrder[b.role]||9)||String(a.name).localeCompare(String(b.name),'fr');
    if(idleRosterSort==='rarity')return (IDLE_RARITY_ORDER[b.rarity]||0)-(IDLE_RARITY_ORDER[a.rarity]||0)||(b.rate||0)-(a.rate||0);
    if(idleRosterSort==='power')return (b.rate||b.baseRate||0)-(a.rate||a.baseRate||0);
    if(idleRosterSort==='level')return (b.level||1)-(a.level||1)||(b.rate||0)-(a.rate||0);
    const pa=idleRosterProjection(a),pb=idleRosterProjection(b);return idleRosterSort==='synergy'?pb.synergyBonus-pa.synergyBonus||pb.formationBonus-pa.formationBonus:pb.score-pa.score;
  });
  hint.innerHTML=idleRosterAvailable.length?`<i class="fas fa-users"></i><span><b>${available.length}</b> personnage${available.length>1?'s':''} affiché${available.length>1?'s':''} sur ${idleRosterAvailable.length}<small>Le tri recommandé compare synergie, formation, rareté et production.</small></span>`:'<i class="fas fa-circle-info"></i><span>Aucun personnage disponible<small>Utilise l’espace Invocation de la page Équipe.</small></span>';
  list.innerHTML=available.length?available.map(idleRosterCardHTML).join(''):'<p class="idle-roster-empty"><i class="fas fa-filter"></i>Aucun héros ne correspond à ces filtres.</p>';
}

function idleRosterCardHTML(c,index){const role=idleRoleFor(c);const rarity=idleRarityLabel(c.rarity);const projection=idleRosterProjection(c);const recommended=idleRosterSort==='meta'&&index===0;const exact=projection.exactDelta===null?'':`<span class="idle-roster-delta ${projection.exactDelta>=0?'positive':'negative'}"><small>DPS D’ÉQUIPE APRÈS CHANGEMENT</small><b>${idleFormatNumber(c.projectedTotalRate||0)}/s</b><em>${projection.exactDelta>=0?'+':''}${idleFormatNumber(projection.exactDelta)}/s · ${projection.exactPercent>=0?'+':''}${Math.round(projection.exactPercent*100)}%</em></span>`;const badges=[projection.synergyBonus?`${projection.sameSeries>=3?'Alliance':'Synergie'} +${Math.round(projection.synergyBonus*100)}%`:'',projection.formationBonus?`Formation +${Math.round(projection.formationBonus*100)}%`:''].filter(Boolean);return `<article class="idle-roster-card r-${escapeHtml(c.rarity)} ${recommended?'recommended':''} ${c.awakened?'is-awakened':''}" data-cid="${c.id}"><span class="idle-roster-portrait" ${c.imageUrl?`style="background-image:url('${escapeHtml(c.imageUrl)}')"`:''}><em>${c.awakened?'✦ ':''}${escapeHtml(rarity)}</em></span><span class="idle-roster-main"><span class="idle-roster-heading"><span><b>${c.awakened?'✦ ':''}${escapeHtml(c.name)}</b><small>${escapeHtml(c.series||'Univers inconnu')}</small></span>${recommended?'<em><i class="fas fa-star"></i> Meilleur choix</em>':''}</span><span class="idle-roster-overview"><span class="idle-roster-role" style="--role:${role.color}"><i class="fas ${role.icon}"></i><span><small>RÔLE</small><b>${role.name}</b><em>${escapeHtml(role.description)}</em></span></span><span class="idle-roster-power"><small>PRODUCTION · NIV. ${idleFormatNumber(c.level||1)}</small><b>+${idleFormatNumber(c.rate||c.baseRate||0)}<em>/s</em></b></span></span>${exact}${badges.length?`<span class="idle-roster-fit">${badges.map((badge)=>`<b><i class="fas fa-link"></i>${escapeHtml(badge)}</b>`).join('')}</span>`:'<span class="idle-roster-fit neutral"><b><i class="fas fa-circle-minus"></i>Aucun bonus d’équipe immédiat</b></span>'}<span class="idle-roster-details"><span><i class="fas fa-fingerprint"></i><span><small>TALENT</small><b>${escapeHtml(c.talent?.name||'Talent')}</b><em>${escapeHtml(c.talent?.description||'Aucun détail disponible.')}</em></span></span><span><i class="fas fa-bolt"></i><span><small>TECHNIQUE</small><b>${escapeHtml(c.combatSkill?.name||'Technique')}</b><em>${escapeHtml(c.combatSkill?.description||'Aucun détail disponible.')}</em></span></span></span></span><span class="idle-roster-actions"><button type="button" class="btn-secondary" data-character-details><i class="fas fa-circle-info"></i> Voir la fiche</button><button type="button" class="btn-primary" data-character-pick><i class="fas fa-user-plus"></i> Choisir</button></span></article>`;}

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
  if ((['epic', 'legendary', 'mythic'].includes(r.recruited.rarity) || r.recruited.awakened) && typeof burstConfetti === 'function') {
    burstConfetti(r.recruited.awakened ? 70 : r.recruited.rarity === 'mythic' ? 50 : 30);
  }
  renderIdleState(r);
  idleAddCombatLog(`${r.recruited.name} rejoint le Dojo`,'fa-user-plus');
  document.getElementById('idle-summon')?.classList.add('hidden');
  showIdleRecruitReveal(r.recruited,r.recruit);
  await refreshIdlePickerList(); // no-op si la modale n'est pas ouverte
}

function showIdleRecruitReveal(character,recruit) {
  idleLastRecruit = character;
  const modal = document.getElementById('idle-recruit-reveal');
  const body = document.getElementById('idle-recruit-reveal-body');
  if (!modal || !body) return;
  const rarity = (typeof RARITY_LABELS !== 'undefined' && RARITY_LABELS[character.rarity]) || character.rarity;
  const img = character.imageUrl ? `style="background-image:url('${escapeHtml(character.imageUrl)}')"` : '';
  const role=idleRoleFor(character);
  modal.className=`modal-overlay idle-recruit-reveal-modal reveal-${character.rarity}${character.awakened?' reveal-awakened':''}`;
  body.innerHTML = `<div class="idle-recruit-reveal-art r-${character.rarity}${character.awakened?' is-awakened':''}">
      <div class="idle-recruit-reveal-img" ${img}></div>
      <div class="idle-recruit-reveal-glow"></div>
    </div>
    ${character.awakened?'<span class="idle-recruit-reveal-awakened">✦ ÉVEILLÉ · +10% de production personnelle, pour toujours</span>':''}
    <strong class="idle-recruit-reveal-name">${escapeHtml(character.name)}</strong>
    <span class="idle-recruit-reveal-series">${escapeHtml(character.series || 'Univers inconnu')}</span>
    <span class="idle-recruit-reveal-rarity r-${character.rarity}">${escapeHtml(rarity)}</span>
    <span class="idle-recruit-reveal-role" style="--role:${role.color}"><i class="fas ${role.icon}"></i><b>${escapeHtml(role.name)}</b> · ${escapeHtml(role.description)}</span>
    ${character.talent ? `<div class="idle-reveal-talent"><i class="fas fa-fingerprint"></i><div><b>Talent · ${escapeHtml(character.talent.name)}</b><span>${escapeHtml(character.talent.description)}</span></div></div>` : ''}`;
  const rates=(idleState?.slots||[]).filter((s)=>s.character).map((s)=>s.character.rate); const weakest=rates.length?Math.min(...rates):0;
  body.insertAdjacentHTML('beforeend',`<div class="idle-recruit-comparison"><span><small>PRODUCTION DE BASE</small><b>+${idleFormatNumber(character.baseRate||0)}/s</b></span><span><small>COMPARAISON ÉQUIPE</small><b class="${(character.baseRate||0)>weakest?'better':''}">${!rates.length?'Premier héros':(character.baseRate||0)>weakest?'Plus forte que le plus faible':'À entraîner'}</b></span></div>`);
  const sealsLeft=recruit?.balance??idleState?.recruit?.balance??0;
  body.insertAdjacentHTML('beforeend',`<div class="idle-recruit-remaining"><i class="fas fa-ticket"></i><span><small>APRÈS CETTE INVOCATION</small><b>${idleFormatNumber(sealsLeft)} Sceau${sealsLeft!==1?'x':''} restant${sealsLeft!==1?'s':''}</b></span></div>`);
  const again=document.getElementById('idle-recruit-again');if(again)again.innerHTML=`<i class="fas fa-rotate"></i> Invoquer encore <small>${idleFormatNumber(sealsLeft)} Sceau${sealsLeft!==1?'x':''}</small>`;
  const freeSlot = idleState?.slots?.find((s) => !s.locked && !s.character);
  const assign = document.getElementById('idle-recruit-assign');
  if (assign) assign.innerHTML = freeSlot
    ? '<i class="fas fa-user-plus"></i> Ajouter à l’équipe'
    : '<i class="fas fa-users"></i> Voir mon équipe';
  modal.classList.remove('hidden');
  requestAnimationFrame(()=>modal.classList.add('is-revealed'));
}

function renderIdleRecruitHistory(items){const box=document.getElementById('idle-recruit-history');if(!box)return;box.innerHTML=items.length?items.map((c)=>`<div class="idle-history-row"><i class="fas fa-user-plus"></i><div><b>${escapeHtml(c.name||'Personnage')}</b><span>${escapeHtml(c.series||'Univers inconnu')} · ${escapeHtml(c.talent?.name||'')}</span></div><small>${c.recruitedAt?new Date(c.recruitedAt).toLocaleDateString('fr-FR'):''}</small></div>`).join(''):'<p class="hint">Aucun recrutement pour le moment.</p>';}

function closeIdleRecruitReveal() {
  const modal=document.getElementById('idle-recruit-reveal');modal?.classList.add('hidden');modal?.classList.remove('is-revealed');
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

// Ouvre le bilan de Prestige (modale) : le joueur voit EXACTEMENT ce qui
// repart à zéro et ce qui est conservé avant de confirmer — le confirm()
// texte brut laissait les testeurs dans le doute (« jsp si les sceaux sont
// reset ou non »).
function prestigeIdle() {
  if (!idleState || !idleState.dojo.prestige.eligible) return;
  const modal = document.getElementById('idle-prestige-modal');
  if (!modal) return;
  const gain = idleFormatNumber(idleState.dojo.prestige.reward);
  const gainEl = document.getElementById('idle-prestige-gain');
  if (gainEl) gainEl.textContent = gain;
  const gainBtn = document.getElementById('idle-prestige-gain-btn');
  if (gainBtn) gainBtn.textContent = gain;
  document.getElementById('idle-prestige-confirm-view')?.classList.remove('hidden');
  document.getElementById('idle-prestige-result-view')?.classList.add('hidden');
  const confirmBtn = document.getElementById('idle-prestige-confirm');
  if (confirmBtn) confirmBtn.disabled = false;
  modal.classList.remove('hidden');
}

async function confirmIdlePrestige() {
  const confirmBtn = document.getElementById('idle-prestige-confirm');
  if (confirmBtn) confirmBtn.disabled = true;
  let r;
  try {
    r = await api('/api/idle/prestige', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    if (confirmBtn) confirmBtn.disabled = false;
    idleNotify(e.message, 'error');
    return;
  }
  renderIdleState(r);
  const recap = r.prestige || {};
  const grid = document.getElementById('idle-prestige-result-grid');
  if (grid) grid.innerHTML = `
    <span><i class="fas fa-brain"></i><b>+${idleFormatNumber(recap.gained || 0)}</b><small>Sagesse gagnée</small></span>
    <span><i class="fas fa-flag-checkered"></i><b>${idleFormatNumber(recap.stage || 0)}</b><small>Stage atteint cette run</small></span>
    ${recap.seals ? `<span><i class="fas fa-ticket"></i><b>+${idleFormatNumber(recap.seals)}</b><small>Sceaux de palier</small></span>` : ''}
    ${recap.tokens ? `<span><i class="fas fa-coins"></i><b>+${idleFormatNumber(recap.tokens)}</b><small>Tokens gacha</small></span>` : ''}
    <span><i class="fas fa-tags"></i><b>Minimum</b><small>Prix d’invocation Essence</small></span>`;
  document.getElementById('idle-prestige-confirm-view')?.classList.add('hidden');
  document.getElementById('idle-prestige-result-view')?.classList.remove('hidden');
  if (typeof burstConfetti === 'function') burstConfetti(50);
  if (typeof sfx !== 'undefined' && sfx.win) sfx.win();
}

function idleModalFocusable(modal){return [...modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((element)=>element.offsetParent!==null);}
function idleInitModalFocus(){
  if(idleModalObserver)return;
  const modals=[...document.querySelectorAll('.modal-overlay[id^="idle-"]')];
  idleModalObserver=new MutationObserver((mutations)=>mutations.forEach(({target})=>{
    if(!target.classList.contains('hidden')){idleModalFocusOrigins.set(target,document.activeElement);requestAnimationFrame(()=>idleModalFocusable(target)[0]?.focus());}
    else{const origin=idleModalFocusOrigins.get(target);idleModalFocusOrigins.delete(target);if(origin?.isConnected)requestAnimationFrame(()=>origin.focus());}
  }));
  modals.forEach((modal)=>idleModalObserver.observe(modal,{attributes:true,attributeFilter:['class']}));
}
function idleTrapModalFocus(event,modal){
  const focusable=idleModalFocusable(modal);if(!focusable.length)return;
  const first=focusable[0];const last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}

function initIdleUI() {
  idleInitModalFocus();
  document.getElementById('view-idle')?.addEventListener('click', (e) => {
    const title = e.target.closest('[data-idle-collapse]'); if (!title) return;
    const section = title.closest('.idle-collapsible'); section?.classList.toggle('collapsed');
  });
  document.getElementById('idle-collect-btn')?.addEventListener('click', collectIdle);
  document.getElementById('idle-click-btn')?.addEventListener('click', clickIdle);
  document.getElementById('idle-buy-amount')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-buy-amount]');
    if (b) chooseIdleBuyAmount(b.dataset.buyAmount);
  });
  document.getElementById('idle-team-buy-amount')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-buy-amount]');
    if (b) chooseIdleBuyAmount(b.dataset.buyAmount);
  });
  document.getElementById('idle-quick-buy')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-quick-team]')) return idleShowPanel('team');
    const b = e.target.closest('[data-action="quick-levelup"]');
    if (b && !b.disabled) return levelUpIdleSlot(Number(b.dataset.slot), b.closest('.idle-quick-hero'), idleBuyAmount === 'max' ? 'max' : Number(idleBuyAmount));
  });
  document.getElementById('idle-collection')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-collection-series]');
    if (b) openIdleCollectionSeries(b.dataset.collectionSeries);
  });
  document.getElementById('idle-collection-sort')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-collection-sort]');
    if (!b || b.dataset.collectionSort === idleCollectionSort) return;
    idleCollectionSort = b.dataset.collectionSort;
    localStorage.setItem('idle-collection-sort', idleCollectionSort);
    if (idleState) renderIdleCollection(idleState.codex);
  });
  document.getElementById('idle-collection-close')?.addEventListener('click', () => document.getElementById('idle-collection-modal')?.classList.add('hidden'));
  document.getElementById('idle-collection-modal')?.addEventListener('click', (e) => { if (e.target.id === 'idle-collection-modal') e.currentTarget.classList.add('hidden'); });
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
  document.getElementById('idle-mode-control')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-battle-mode]');if(b&&!b.disabled)chooseIdleBattleMode(b.dataset.battleMode);});
  document.getElementById('idle-automation-profiles')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-automation-profile]');if(b&&!b.disabled)applyIdleAutomationProfile(b.dataset.automationProfile);});
  document.getElementById('idle-stage-nav')?.addEventListener('click',(e)=>{const button=e.target.closest('button[data-stage]');if(button&&!button.disabled)chooseIdleStage(Number(button.dataset.stage));});
  document.getElementById('idle-world-open')?.addEventListener('click',()=>{const panel=document.getElementById('idle-world-jump');const open=panel?.classList.toggle('hidden')===false;document.getElementById('idle-world-open')?.setAttribute('aria-expanded',String(open));});
  document.getElementById('idle-world-current')?.addEventListener('click',()=>document.getElementById('idle-world-open')?.click());
  document.getElementById('idle-world-close')?.addEventListener('click',()=>{document.getElementById('idle-world-jump')?.classList.add('hidden');document.getElementById('idle-world-open')?.setAttribute('aria-expanded','false');});
  document.getElementById('idle-world-jump-list')?.addEventListener('click',(e)=>{const button=e.target.closest('[data-world-stage]');if(!button||button.disabled)return;document.getElementById('idle-world-jump')?.classList.add('hidden');document.getElementById('idle-world-open')?.setAttribute('aria-expanded','false');chooseIdleStage(Number(button.dataset.worldStage));});
  document.getElementById('idle-auto-skills')?.addEventListener('click',toggleIdleAutoSkills);
  document.getElementById('idle-formations')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-idle-formation]');if(b)chooseIdleFormation(b.dataset.idleFormation);});
  document.getElementById('idle-presets')?.addEventListener('click',(e)=>{const saveSlot=e.target.closest('[data-preset-save-slot]');if(saveSlot)return saveIdlePreset(Number(saveSlot.dataset.presetSaveSlot));const save=e.target.closest('[data-preset-save]');if(save)return saveIdlePreset();const load=e.target.closest('[data-preset-load]');if(load)return loadIdlePreset(load.dataset.presetLoad);});
  document.getElementById('idle-strategy-lab-load')?.addEventListener('click',loadIdleStrategyLab);
  document.getElementById('idle-strategy-lab-results')?.addEventListener('click',(e)=>{const formation=e.target.closest('[data-lab-formation]');if(formation&&!formation.disabled)return chooseIdleFormation(formation.dataset.labFormation);const preset=e.target.closest('[data-lab-preset]');if(preset&&!preset.disabled)return loadIdlePreset(preset.dataset.labPreset);});
  document.getElementById('idle-challenges')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-challenge-claim]');if(b&&!b.disabled)claimIdleChallenge(b.dataset.challengeClaim);});
  document.getElementById('idle-claim-all')?.addEventListener('click',claimAllIdle);
  document.getElementById('idle-session-reset')?.addEventListener('click',()=>{resetIdleSessionStats();idleNotify('Bilan de session remis à zéro.','success');});
  document.getElementById('idle-community-boss')?.addEventListener('click',(e)=>{if(e.target.closest('[data-community-claim]'))return claimIdleCommunityBoss();if(e.target.closest('[data-community-refresh]'))return loadIdleCommunityBoss();const player=e.target.closest('[data-idle-player]');if(player)return openIdlePlayer(player.dataset.idlePlayer);});
  document.getElementById('idle-telemetry-load')?.addEventListener('click',loadIdleTelemetry);
  document.getElementById('idle-feedback-form')?.addEventListener('submit',sendIdleFeedback);
  document.getElementById('idle-chat-form')?.addEventListener('submit',idleSendChat);
  document.getElementById('idle-chat-toggle')?.addEventListener('click',idleToggleChat);
  document.getElementById('idle-chat-close')?.addEventListener('click',()=>{localStorage.removeItem('idle-chat-open');idleSetChatOpen(false);});
  document.getElementById('idle-run-choice')?.addEventListener('click',(e)=>{
    const reroll=e.target.closest('#idle-run-reroll');if(reroll)return void(!reroll.disabled&&rerollIdleRunBlessing());
    const button=e.target.closest('[data-run-blessing]');if(button&&!button.disabled)chooseIdleRunBlessing(button.dataset.runBlessing);
  });
  document.querySelector('.idle-community-chat')?.addEventListener('click',idleChatCommunityClick);
  document.getElementById('idle-community-ranking')?.addEventListener('click',()=>openIdleRanking());
  document.getElementById('idle-community-friends')?.addEventListener('click',()=>document.getElementById('friends-popover-btn')?.click());
  document.getElementById('idle-guide-btn')?.addEventListener('click',openIdleGuide);document.getElementById('idle-guide-close')?.addEventListener('click',()=>document.getElementById('idle-guide-modal')?.classList.add('hidden'));document.getElementById('idle-guide-modal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-guide-modal')e.currentTarget.classList.add('hidden');const b=e.target.closest('[data-guide-tab]');if(b){e.currentTarget.classList.add('hidden');idleShowPanel(b.dataset.guideTab);}});
  document.getElementById('idle-ranking-btn')?.addEventListener('click',()=>openIdleRanking());document.getElementById('idle-ranking-close')?.addEventListener('click',()=>document.getElementById('idle-ranking-modal')?.classList.add('hidden'));document.getElementById('idle-ranking-modal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-ranking-modal')e.currentTarget.classList.add('hidden');const tab=e.target.closest('[data-idle-ranking]');if(tab)return openIdleRanking(tab.dataset.idleRanking);const player=e.target.closest('[data-idle-player]');if(player)return openIdlePlayer(player.dataset.idlePlayer);});
  document.getElementById('idle-player-close')?.addEventListener('click',()=>document.getElementById('idle-player-modal')?.classList.add('hidden'));document.getElementById('idle-player-modal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-player-modal')e.currentTarget.classList.add('hidden');if(e.target.closest('#idle-player-share'))shareIdlePlayer();});
  const settingsModal=document.getElementById('idle-settings-modal');document.getElementById('idle-settings-btn')?.addEventListener('click',()=>{applyIdleComfortSettings();mountIdleShortcutHelp();settingsModal?.classList.remove('hidden');});document.getElementById('idle-settings-close')?.addEventListener('click',()=>settingsModal?.classList.add('hidden'));settingsModal?.addEventListener('click',(e)=>{if(e.target===settingsModal)settingsModal.classList.add('hidden');});document.getElementById('idle-volume')?.addEventListener('input',(e)=>sfx?.setIdleVolume?.(e.target.value));document.getElementById('idle-effects-reduced')?.addEventListener('change',(e)=>{sfx?.setIdleEffectsReduced?.(!e.target.checked);applyIdleComfortSettings();});
  ['large-text','high-contrast','data-saver'].forEach((key)=>document.getElementById(`idle-${key}`)?.addEventListener('change',(e)=>{localStorage.setItem(`idle-${key}`,e.target.checked?'1':'0');applyIdleComfortSettings();if(key==='data-saver'&&idleSyncTicker)idleStartSyncTicker();}));
  document.getElementById('idle-connection-retry')?.addEventListener('click',()=>refreshIdleState());
  window.addEventListener('offline',()=>{idleSetConnectionState('offline');idleAnnounce('Connexion perdue. La dernière progression reste affichée.');});
  window.addEventListener('online',()=>{idleSetConnectionState('retrying','Connexion retrouvée · synchronisation…');if(!document.getElementById('view-idle')?.classList.contains('hidden'))refreshIdleState();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!document.getElementById('view-idle')?.classList.contains('hidden'))refreshIdleState();});
  const characterSheet=document.getElementById('idle-character-sheet');document.getElementById('idle-character-sheet-close')?.addEventListener('click',()=>characterSheet?.classList.add('hidden'));characterSheet?.addEventListener('click',(e)=>{if(e.target===characterSheet)e.currentTarget.classList.add('hidden');const leader=e.target.closest('[data-sheet-leader]');if(leader)return chooseIdleLeader(Number(leader.dataset.sheetLeader));const gear=e.target.closest('[data-sheet-gear]');if(gear){const characterId=Number(characterSheet.dataset.characterId);const slot=(idleState?.slots||[]).find((item)=>item.character?.id===characterId);if(slot)return openIdleEquipmentPicker(slot.index,gear.dataset.sheetGear);}if(e.target.closest('[data-sheet-equipment]')){e.currentTarget.classList.add('hidden');idleShowPanel('equipment');}if(e.target.closest('[data-sheet-team]')){e.currentTarget.classList.add('hidden');idleShowPanel('team');}});
  document.getElementById('idle-season-card')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-season-tier]');if(b&&!b.disabled)claimIdleSeason(Number(b.dataset.seasonTier));});
  document.getElementById('idle-rift-card')?.addEventListener('click',(e)=>{if(e.target.closest('#idle-rift-attempt'))attemptIdleRift();else if(e.target.closest('[data-idle-relic-open]'))openIdleRiftRelicChoice(idleState?.rift?.pendingChoice||[]);});
  const relicChoiceModal=document.getElementById('idle-relic-choice');document.getElementById('idle-relic-choice-close')?.addEventListener('click',()=>relicChoiceModal?.classList.add('hidden'));relicChoiceModal?.addEventListener('click',(e)=>{if(e.target===relicChoiceModal)e.currentTarget.classList.add('hidden');const b=e.target.closest('[data-relic-choice]');if(b)chooseIdleRiftRelic(b.dataset.relicChoice);});
  document.getElementById('idle-boss-chest')?.addEventListener('click', claimIdleBossChest);
  const closeBossReward=()=>document.getElementById('idle-boss-reveal')?.classList.add('hidden');
  document.getElementById('idle-boss-reveal-close')?.addEventListener('click',closeBossReward);
  document.getElementById('idle-boss-reveal-continue')?.addEventListener('click',closeBossReward);
  document.getElementById('idle-boss-reveal')?.addEventListener('click',(e)=>{if(e.target.id==='idle-boss-reveal')closeBossReward();});
  document.getElementById('idle-boss-reveal')?.addEventListener('click',(e)=>{if(e.target.closest('[data-open-equipment]')){closeBossReward();idleShowPanel('equipment');}});
  document.getElementById('idle-item-filters')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-item-filter]');if(!b)return;idleItemFilter=b.dataset.itemFilter;persistIdleInventoryPrefs();document.querySelectorAll('[data-item-filter]').forEach((x)=>x.classList.toggle('active',x===b));renderIdleInventory(idleState);});
  document.getElementById('idle-set-codex')?.addEventListener('click',(e)=>{const button=e.target.closest('[data-codex-set]');if(!button)return;idleItemSet=idleItemSet===button.dataset.codexSet?'all':button.dataset.codexSet;persistIdleInventoryPrefs();renderIdleInventory(idleState);document.querySelector('.idle-inventory-commandbar')?.scrollIntoView({behavior:'smooth',block:'start'});});
  document.getElementById('idle-item-sort')?.addEventListener('change',(e)=>{idleItemSort=e.target.value;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-rarity')?.addEventListener('change',(e)=>{idleItemRarity=e.target.value;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-set')?.addEventListener('change',(e)=>{idleItemSet=e.target.value;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-status')?.addEventListener('change',(e)=>{idleItemStatus=e.target.value;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-search')?.addEventListener('input',(e)=>{idleItemSearch=e.target.value;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-recommended-only')?.addEventListener('click',()=>{idleItemRecommendedOnly=!idleItemRecommendedOnly;persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-item-reset')?.addEventListener('click',()=>{resetIdleInventoryFilters();renderIdleInventory(idleState);document.getElementById('idle-item-search')?.focus();});
  const salvageRarity=document.getElementById('idle-salvage-rarity');const salvageEnhancement=document.getElementById('idle-salvage-enhancement');const salvageKeepSets=document.getElementById('idle-salvage-keep-sets');
  if(salvageRarity)salvageRarity.value=idleSalvageRules.rarity;if(salvageEnhancement)salvageEnhancement.value=String(idleSalvageRules.enhancement);if(salvageKeepSets)salvageKeepSets.checked=!!idleSalvageRules.keepSets;
  const saveSalvageRules=()=>{idleSalvageRules={rarity:salvageRarity?.value||'rare',enhancement:Number(salvageEnhancement?.value||0),keepSets:!!salvageKeepSets?.checked};localStorage.setItem('idle-salvage-rules',JSON.stringify(idleSalvageRules));};
  salvageRarity?.addEventListener('change',saveSalvageRules);salvageEnhancement?.addEventListener('change',saveSalvageRules);salvageKeepSets?.addEventListener('change',saveSalvageRules);
  document.getElementById('idle-select-recyclable')?.addEventListener('click',selectIdleItemsBySalvageRules);
  document.getElementById('idle-auto-equip')?.addEventListener('click',autoEquipIdleItems);
  document.getElementById('idle-rune-dungeon-grid')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-rune-dungeon]');if(b&&!b.disabled)runIdleRuneDungeon(b.dataset.runeDungeon);});
  document.getElementById('idle-equipment-target')?.addEventListener('change',(e)=>{idleEquipmentTargetSlot=Number(e.target.value);persistIdleInventoryPrefs();renderIdleInventory(idleState);});
  document.getElementById('idle-equipment-target-next')?.addEventListener('click',()=>{
    const active=(idleState?.slots||[]).filter((slot)=>slot.character);if(!active.length)return;
    const currentIndex=active.findIndex((slot)=>slot.index===idleEquipmentTargetSlot);
    idleEquipmentTargetSlot=active[(currentIndex+1)%active.length].index;
    persistIdleInventoryPrefs();
    renderIdleInventory(idleState);
  });
  document.getElementById('idle-equipment-auto-lock')?.addEventListener('click',autoLockIdleEquipment);
  document.getElementById('idle-unequip-all')?.addEventListener('click',unequipAllIdleEquipment);
  document.getElementById('idle-enhance-all-one')?.addEventListener('click',()=>enhanceAllIdleEquipment(1));
  document.getElementById('idle-enhance-all-five')?.addEventListener('click',()=>enhanceAllIdleEquipment(5));
  document.getElementById('idle-expeditions')?.addEventListener('click',(e)=>{const start=e.target.closest('[data-expedition-start]');if(start&&!start.disabled)return startIdleExpedition(start.dataset.expeditionStart);const claim=e.target.closest('[data-expedition-claim]');if(claim&&!claim.disabled)claimIdleExpedition();});
  document.getElementById('idle-loadouts')?.addEventListener('click',(e)=>{const quick=e.target.closest('[data-loadout-empty]');if(quick)return openIdleEquipmentPicker(Number(quick.dataset.loadoutSlot),quick.dataset.loadoutEmpty);const target=e.target.closest('[data-loadout-target]');if(target){idleEquipmentTargetSlot=Number(target.dataset.loadoutTarget);persistIdleInventoryPrefs();renderIdleInventory(idleState);return;}const transfer=e.target.closest('[data-loadout-transfer]');if(transfer)return transferIdleEquipment(Number(transfer.dataset.loadoutTransfer),idleEquipmentTargetSlot);const item=e.target.closest('[data-loadout-item]');if(item)focusIdleInventoryItem(item.dataset.loadoutItem);});
  const equipmentPicker=document.getElementById('idle-equipment-picker');document.getElementById('idle-equipment-picker-close')?.addEventListener('click',()=>equipmentPicker?.classList.add('hidden'));equipmentPicker?.addEventListener('click',async(e)=>{if(e.target===equipmentPicker)return equipmentPicker.classList.add('hidden');if(e.target.closest('[data-picker-full]')){equipmentPicker.classList.add('hidden');openIdleEquipmentForSlot(idleEquipmentPickerSlot,idleEquipmentPickerKind);return;}const equip=e.target.closest('[data-picker-equip]');if(equip&&!equip.disabled){equip.disabled=true;const success=await equipIdleItem(equip.dataset.pickerEquip,idleEquipmentPickerSlot);if(success)equipmentPicker.classList.add('hidden');else equip.disabled=false;}});
  document.getElementById('idle-run-shortcut')?.addEventListener('click',()=>{idleShowPanel('progression');requestAnimationFrame(()=>document.getElementById('idle-run-journey')?.scrollIntoView({behavior:'smooth',block:'start'}));});
  document.getElementById('idle-salvage-selected')?.addEventListener('click',()=>salvageIdleItems([...idleSelectedItems]));
  document.getElementById('idle-inventory-grid')?.addEventListener('click',(e)=>{if(e.target.closest('[data-item-reset-filters]')){resetIdleInventoryFilters();renderIdleInventory(idleState);return;}const card=e.target.closest('[data-item-id]');if(!card)return;const itemId=card.dataset.itemId;const item=idleState.inventory.items.find((x)=>x.id===itemId);const lock=e.target.closest('[data-item-lock]');if(lock)return lockIdleItem(itemId,!item.locked);if(e.target.closest('[data-item-select]'))return toggleIdleItemSelection(itemId);if(e.target.closest('[data-item-expand]'))return toggleIdleItemExpand(itemId);const enhance=e.target.closest('[data-item-enhance]');if(enhance)return enhanceIdleEquipment(itemId,enhance.dataset.itemEnhanceAmount==='max'?'max':Number(enhance.dataset.itemEnhanceAmount||1));if(e.target.closest('[data-item-equip]'))return equipIdleItem(itemId,idleEquipmentTargetSlot);if(e.target.closest('[data-item-unequip]'))return unequipIdleItem(itemId);if(e.target.closest('[data-item-reroll]'))return rerollIdleItem(itemId);if(e.target.closest('[data-item-salvage]'))return salvageIdleItem(itemId);});
  // Taper la scène = entraîner (comme frapper le monstre dans un idle game).
  // L'anti-spam serveur (900 ms) borne le rythme, l'échec 429 est silencieux.
  document.getElementById('idle-scene')?.addEventListener('pointerdown', clickIdle);
  document.getElementById('idle-boss-engage-btn')?.addEventListener('click', (e) => { e.stopPropagation(); engageIdleBoss(); });
  document.getElementById('idle-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-idle-tab]');
    if (tab) idleShowPanel(tab.dataset.idleTab);
  });
  document.getElementById('idle-tabs')?.addEventListener('keydown',(e)=>{
    if(!['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','Home','End'].includes(e.key))return;
    const tabs=[...e.currentTarget.querySelectorAll('[data-idle-tab]')];let index=tabs.indexOf(document.activeElement);
    if(e.key==='Home')index=0;else if(e.key==='End')index=tabs.length-1;else index=(index+(['ArrowDown','ArrowRight'].includes(e.key)?1:-1)+tabs.length)%tabs.length;
    e.preventDefault();idleShowPanel(tabs[index].dataset.idleTab);tabs[index].focus();
  });
  document.addEventListener('keydown',(e)=>{
    if(document.getElementById('view-idle')?.classList.contains('hidden'))return;
    const openModals=[...document.querySelectorAll('.modal-overlay[id^="idle-"]:not(.hidden)')];
    if(e.key==='Escape'&&openModals.length){e.preventDefault();openModals.at(-1).classList.add('hidden');return;}
    if(e.key==='Tab'&&openModals.length){idleTrapModalFocus(e,openModals.at(-1));return;}
    const typing=e.target.closest?.('input,textarea,select,[contenteditable="true"]');
    const interactive=typing||e.target.closest?.('button,a[href]');
    if(e.code==='Space'&&!interactive&&!openModals.length&&idleActivePanel==='home'){e.preventDefault();clickIdle();}
    const shortcutIndex=/^Digit[1-7]$/.test(e.code)?Number(e.code.slice(-1))-1:-1;
    if(shortcutIndex>=0&&!typing&&!openModals.length){e.preventDefault();const panel=IDLE_PANEL_NAMES[shortcutIndex];if(idleShowPanel(panel)!==false)document.getElementById(`idle-tab-${panel}`)?.focus();}
  });
  document.getElementById('idle-picker-close')?.addEventListener('click', closeIdlePicker);
  document.getElementById('idle-picker')?.addEventListener('click', (e) => { if (e.target.id === 'idle-picker') closeIdlePicker(); });
  document.getElementById('idle-open-summon')?.addEventListener('click',()=>document.getElementById('idle-summon')?.classList.remove('hidden'));
  document.getElementById('idle-open-hero-style')?.addEventListener('click',openIdleClassPicker);
  document.querySelectorAll('[data-open-idle-summon]').forEach((button)=>button.addEventListener('click',()=>document.getElementById('idle-summon')?.classList.remove('hidden')));
  document.getElementById('idle-howto-close')?.addEventListener('click',()=>{localStorage.setItem('idle-howto-dismissed','1');document.getElementById('idle-howto')?.classList.add('hidden');});
  document.querySelectorAll('#idle-howto [data-idle-goto]').forEach((button)=>button.addEventListener('click',()=>idleShowPanel(button.dataset.idleGoto)));
  document.getElementById('idle-nav-summon')?.addEventListener('click',()=>document.getElementById('idle-summon')?.classList.remove('hidden'));
  document.getElementById('idle-spend-summon')?.addEventListener('click',()=>document.getElementById('idle-summon')?.classList.remove('hidden'));
  // OUVRE toujours la section Ancients (jamais de bascule qui pourrait la
  // refermer) et défile jusqu'à elle : « j'ai de la Sagesse mais je ne peux
  // pas l'utiliser » venait de là — la section restait repliée hors écran.
  document.getElementById('idle-spend-wisdom')?.addEventListener('click',()=>{idleShowPanel('upgrades');setTimeout(()=>{const section=document.getElementById('idle-ancients')?.closest('.idle-collapsible');section?.classList.remove('collapsed');section?.scrollIntoView({behavior:'smooth',block:'start'});},80);});
  // Ascension prête → confirmation directe ; sinon, montrer les conditions.
  document.getElementById('idle-prestige-quick')?.addEventListener('click',()=>{
    if(idleState?.dojo?.prestige?.eligible)return prestigeIdle();
    idleShowPanel('upgrades');setTimeout(()=>document.getElementById('idle-prestige-btn')?.scrollIntoView({behavior:'smooth',block:'center'}),80);
  });
  const prestigeModal=document.getElementById('idle-prestige-modal');
  document.getElementById('idle-prestige-confirm')?.addEventListener('click',confirmIdlePrestige);
  const closePrestigeModal=()=>prestigeModal?.classList.add('hidden');
  document.getElementById('idle-prestige-modal-close')?.addEventListener('click',closePrestigeModal);
  document.getElementById('idle-prestige-cancel')?.addEventListener('click',closePrestigeModal);
  document.getElementById('idle-prestige-result-continue')?.addEventListener('click',()=>{closePrestigeModal();idleShowPanel('home');});
  document.getElementById('idle-prestige-open-ancients')?.addEventListener('click',()=>{closePrestigeModal();idleShowPanel('upgrades');setTimeout(()=>document.getElementById('idle-ancients')?.closest('.idle-collapsible')?.classList.remove('collapsed'),80);});
  prestigeModal?.addEventListener('click',(e)=>{if(e.target===prestigeModal)closePrestigeModal();});
  document.getElementById('idle-coach-action')?.addEventListener('click',()=>idleCoachAction?.());
  document.getElementById('idle-coach-close')?.addEventListener('click',()=>{const coach=document.getElementById('idle-coach');if(coach?.dataset.key)sessionStorage.setItem(coach.dataset.key,'hidden');coach?.classList.add('hidden');});
  document.getElementById('idle-summon-close')?.addEventListener('click',()=>document.getElementById('idle-summon')?.classList.add('hidden'));
  document.getElementById('idle-summon')?.addEventListener('click',(e)=>{if(e.target.id==='idle-summon')e.currentTarget.classList.add('hidden');});
  document.getElementById('idle-roster-search')?.addEventListener('input',(e)=>{idleRosterSearch=e.target.value;renderIdleRosterList();});
  document.getElementById('idle-roster-sort')?.addEventListener('change',(e)=>{idleRosterSort=e.target.value;renderIdleRosterList();});
  document.getElementById('idle-roster-role')?.addEventListener('change',(e)=>{idleRosterRole=e.target.value;renderIdleRosterList();});
  document.getElementById('idle-roster-rarity')?.addEventListener('change',(e)=>{idleRosterRarity=e.target.value;renderIdleRosterList();});
  document.getElementById('idle-advisor')?.addEventListener('click',(e)=>{const button=e.target.closest('[data-advisor-tab]');if(!button)return;const command=button.dataset.advisorCommand;if(command==='claim-all'){idleShowPanel('activities');return claimAllIdle();}if(command==='rank-up'){idleShowPanel('progression');return advanceIdleRank();}idleShowPanel(button.dataset.advisorTab||'home');});
  document.getElementById('idle-slots')?.addEventListener('click', (e) => {
    // Les sections dépliables ne doivent pas déclencher le remplacement de
    // héros (data-action="pick" sur toute la carte) : le listener global a
    // déjà mémorisé l'état, on laisse le toggle natif faire son travail.
    if (e.target.closest('.idle-hero-more')) return;
    const removeBtn = e.target.closest('[data-action="unassign"]');
    if (removeBtn) return unassignIdleSlot(Number(removeBtn.dataset.slot));
    const leaderBtn=e.target.closest('[data-action="leader"]');
    if(leaderBtn&&!leaderBtn.disabled)return chooseIdleLeader(Number(leaderBtn.dataset.characterId));
    const detailsBtn=e.target.closest('[data-action="details"]');
    if(detailsBtn)return openIdleCharacterSheet(idleState?.slots?.find((slot)=>slot.index===Number(detailsBtn.dataset.slot))?.character);
    const levelBtn = e.target.closest('[data-action="levelup"]');
    // Quantité trop chère (ex. ×10 sélectionné, budget pour ×1 seulement) : le
    // bouton n'est plus un cul-de-sac désactivé — il ouvre le choix de
    // quantité, sinon le joueur croit qu'« on ne peut plus améliorer ».
    if (levelBtn && levelBtn.getAttribute('aria-disabled') === 'true') { idleLevelupMenuSlot = Number(levelBtn.dataset.slot); const slots=document.getElementById('idle-slots');if(slots)slots.innerHTML=renderIdleSlots(idleState.slots||[]); return; }
    if (levelBtn) return levelUpIdleSlot(Number(levelBtn.dataset.slot), levelBtn.closest('.idle-hero'), levelBtn.dataset.amount==='max'?'max':Number(levelBtn.dataset.amount || 1));
    const menuToggle = e.target.closest('[data-action="levelup-menu"]');
    if (menuToggle) { const slotIndex=Number(menuToggle.dataset.slot); idleLevelupMenuSlot = idleLevelupMenuSlot===slotIndex?null:slotIndex; const slots=document.getElementById('idle-slots');if(slots)slots.innerHTML=renderIdleSlots(idleState.slots||[]); return; }
    const menuAmount = e.target.closest('.idle-levelup-menu [data-buy-amount]');
    if (menuAmount) { idleLevelupMenuSlot = null; return chooseIdleBuyAmount(menuAmount.dataset.buyAmount); }
    const ascendBtn = e.target.closest('[data-action="ascend"]');
    if (ascendBtn) return ascendIdleSlot(Number(ascendBtn.dataset.slot));
    const awakenBtn = e.target.closest('[data-action="awaken"]');
    if (awakenBtn && !awakenBtn.disabled) return awakenIdleHero(Number(awakenBtn.dataset.character));
    const teamGear=e.target.closest('[data-action="team-gear"]');if(teamGear)return openIdleEquipmentForSlot(Number(teamGear.dataset.slot),teamGear.dataset.kind||'all');
    const equipmentBtn=e.target.closest('[data-action="enhance-equipment"]');if(equipmentBtn)return enhanceIdleEquipment(equipmentBtn.dataset.itemEnhanceId);
    const unlockBtn = e.target.closest('.idle-unlock-btn');
    if (unlockBtn) return buyIdleUpgrade('slot', unlockBtn.closest('.idle-hero'));
    const pickBtn = e.target.closest('[data-action="pick"]');
    if (pickBtn) return openIdlePicker(Number(pickBtn.dataset.slot));
  });
  // #idle-upgrade-buy-amount est un voisin de #idle-upgrades dans le DOM (pas
  // un descendant, cf. index.html) : un clic dessus ne remontait jamais
  // jusqu'à l'écouteur posé sur #idle-upgrades ci-dessous, qui l'attendait en
  // vain via closest() — le sélecteur de quantité ×1/×5/×10/×100 de l'écran
  // Améliorer ne réagissait donc à AUCUN clic (retour joueur : la quantité
  // semble figée sur ce que l'onglet Équipe avait laissé, "en fonction du
  // multiplicateur d'équipe"). Écouteur dédié, même schéma que
  // #idle-buy-amount et #idle-team-buy-amount juste au-dessus.
  document.getElementById('idle-upgrade-buy-amount')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-buy-amount]');
    if (b) chooseIdleBuyAmount(b.dataset.buyAmount);
  });
  document.getElementById('idle-upgrades')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.idle-upgrade-btn');
    if (btn) buyIdleUpgrade(btn.dataset.upgrade, btn.closest('.idle-upgrade-card'), btn.dataset.upgradeAmount==='max'?'max':Number(btn.dataset.upgradeAmount||1));
  });
  document.getElementById('idle-ancients')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.idle-ancient-btn');
    if (btn) buyIdleAncient(btn.dataset.ancient, btn.closest('.idle-upgrade-card'));
  });
  document.getElementById('idle-picker-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-cid]');
    if (!card) return;
    const character=idleRosterCharacters.get(Number(card.dataset.cid));
    if(e.target.closest('[data-character-details]'))return openIdleCharacterSheet(character);
    if(e.target.closest('[data-character-pick]'))pickIdleCharacter(Number(card.dataset.cid));
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
    openIdleMainHeroAction();
  });
  document.getElementById('idle-main-hero')?.addEventListener('click',(e)=>{e.stopPropagation();if(!e.target.closest('#idle-customize-hero'))openIdleMainHeroAction();});
  document.getElementById('idle-main-hero')?.addEventListener('keydown',(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openIdleMainHeroAction();}});
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

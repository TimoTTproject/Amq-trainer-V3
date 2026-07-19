const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('bulle Idle : la prise se fait dès pointerdown et tout refus reste visible', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');

  assert.match(source, /orb\.addEventListener\('pointerdown', claim\)/);
  assert.match(source, /idleOrbCooldownUntil = Date\.now\(\)/);
  assert.doesNotMatch(source, /includes\('dissipé'\)/);
});

test('chat Idle : le tiroir reste vertical et seul le fil de messages défile', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  assert.match(styles, /\.idle-community-chat\{[^}]*flex-direction:column!important[^}]*overflow:hidden!important/);
  assert.match(styles, /\.idle-community-chat \.idle-chat-feed\{[^}]*flex:1 1 auto[^}]*overflow-x:hidden/);
  assert.match(styles, /\.idle-community-chat \.idle-chat-form\{[^}]*position:relative!important[^}]*width:calc\(100% \+ 28px\)/);
});

test('combat Idle : les paliers d\'un héros actif se rendent sans interrompre toute la scène', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const start = source.indexOf('function idleHeroMilestonesHTML');
  const end = source.indexOf('// Ligne de héros compacte', start);
  assert.ok(start >= 0 && end > start, 'fonction de rendu des paliers introuvable');

  const context = {
    escapeHtml: (value) => String(value),
    character: {
      ascensionLevel: 100,
      milestones: [
        { target: 10, reached: true, effect: 'Passif', cumulativeMultiplier: 2 },
        { target: 100, reached: false, effect: 'Ascension', cumulativeMultiplier: 4 },
      ],
    },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = idleHeroMilestonesHTML(character);`, context);
  assert.match(context.result, /Niv\. 100/);
  assert.match(context.result, /×2 \+ Ascension/);
});

test('conseiller Idle : une recommandation contextualisée dirige vers un onglet ou une action', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /id="idle-advisor"/);
  assert.match(source, /function renderIdleAdvisor\(advisor,roadmap=/);
  assert.match(source, /data-advisor-command/);
  assert.match(source, /command==='claim-all'/);
});

test('inventaire Idle : les filtres avancés et les règles de recyclage restent explicites', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /id="idle-item-rarity"/);
  assert.match(html, /id="idle-item-set"/);
  assert.match(html, /id="idle-item-status"/);
  assert.match(html, /id="idle-salvage-keep-sets"/);
  assert.match(source, /function selectIdleItemsBySalvageRules\(\)/);
  assert.match(source, /function resetIdleInventoryFilters\(\)/);
  assert.match(source, /data-item-reset-filters/);
  assert.match(source, /confirmHighRarity:preciousConfirmation\?'RECYCLER'/);
  assert.match(source, /!item\.locked&&!item\.equipped/);
});

test('Prestige Idle : l’historique expose rendement, durée et build de chaque run', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /id="idle-run-history"/);
  assert.match(source, /RENDEMENT ACTUEL/);
  assert.match(source, /efficiency\.nextWisdomStage/);
  assert.match(source, /run\.heroCount/);
});

test('social Idle : les classements spécialisés ouvrent les compositions publiques', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(html, /data-idle-ranking="speed"/);
  assert.match(html, /data-idle-ranking="rift"/);
  assert.match(html, /data-idle-ranking="collection"/);
  assert.match(html, /data-idle-ranking="friends"/);
  assert.match(html, /id="idle-player-modal"/);
  assert.match(source, /\/api\/idle\/social/);
  assert.match(source, /\/api\/idle\/players\//);
  assert.match(source, /function shareIdlePlayer\(\)/);
});

test('résilience Idle : les lectures d’état simultanées sont regroupées et le dernier écran reste affiché hors ligne', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const start = source.indexOf('async function refreshIdleState()');
  const end = source.indexOf('// Certains blocs sont coûteux', start);
  assert.ok(start >= 0 && end > start, 'fonction de synchronisation introuvable');
  let calls = 0; let renders = 0; const view = { setAttribute() {}, removeAttribute() {} };
  const context = {
    idleRefreshPromise: null, idleSyncFailures: 0, idleState: { stage: 10 }, navigator: { onLine: true },
    document: { getElementById: () => view }, api: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return { stage: 11 }; },
    renderIdleState: () => { renders++; }, idleSetConnectionState() {}, idleEmptyState: () => '', escapeHtml: String,
  };
  await vm.runInNewContext(`${source.slice(start, end)}\nPromise.all([refreshIdleState(),refreshIdleState()]);`, context);
  assert.equal(calls, 1); assert.equal(renders, 1);
  assert.match(source.slice(start, end), /if\(!idleState\)/);
  assert.doesNotMatch(source.slice(start, end), /idle-upgrades'\)\.innerHTML = ''/);
});

test('confort Idle : connexion, lisibilité persistante et focus des modales sont accessibles', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="idle-connection-status"[^>]*aria-live="polite"/);
  for (const id of ['idle-large-text','idle-high-contrast','idle-data-saver']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(source, /window\.addEventListener\('offline'/);
  assert.match(source, /window\.addEventListener\('online'/);
  assert.match(source, /function idleTrapModalFocus\(/);
  assert.match(source, /new MutationObserver\(/);
  assert.match(styles, /#view-idle\.idle-high-contrast/);
  assert.match(styles, /#view-idle\.idle-data-saver/);
});

test('pilotage Idle : bilan personnel et diagnostic admin rendent les données actionnables', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="idle-session-summary"/);
  assert.match(html, /data-admin-tab="idle"/);
  assert.match(html, /id="admin-idle-balance"/);
  assert.match(source, /function renderIdleSessionReport\(/);
  assert.match(source, /idleSessionStats\.clicks\+=count/);
  assert.match(source, /idleSessionStats\.bestCombo=Math\.max/);
  assert.match(admin, /\/api\/idle\/diagnostics\/balance/);
  assert.match(main, /loadAdminIdleBalance\(\)/);
});

test('boss communautaire Idle : progression, contribution, classement et récompense sont visibles', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="idle-community-boss"/);
  assert.match(source, /function renderIdleCommunityBoss\(/);
  assert.match(source, /\/api\/idle\/community-boss\/claim/);
  assert.match(source, /1 point par ennemi/);
  assert.match(source, /data-idle-player/);
  assert.match(styles, /\.idle-community-boss\.completed/);
});

test('laboratoire tactique Idle : compare sans mutation puis laisse appliquer une variante explicitement', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="idle-strategy-lab-load"/);
  assert.match(html, /id="idle-strategy-lab-results"[^>]*aria-live="polite"/);
  assert.match(html, /sans modifier l'équipe/i);
  assert.match(source, /\/api\/idle\/strategy-lab/);
  assert.match(source, /function renderIdleStrategyLab\(/);
  assert.match(source, /data-lab-formation/);
  assert.match(source, /data-lab-preset/);
  assert.match(source, /boss\.requiredDps/);
  assert.match(styles, /\.idle-lab-summary/);
  assert.match(styles, /\.idle-lab-card\.best/);
});

test('équipement Idle : les emplacements ouvrent un sélecteur rapide qui priorise les sets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="idle-equipment-picker"[^>]*role="dialog"/);
  assert.match(source, /function openIdleEquipmentPicker\(slotIndex,kind\)/);
  assert.match(source, /data-loadout-empty=/);
  assert.match(source, /data-picker-equip=/);
  assert.match(source, /impact\.completes/);
  assert.match(source, /ACTIVE UN BONUS DE SET/);
  assert.match(source, /recommendedId/);
  assert.match(styles, /\.idle-picker-item\.set-complete/);
  assert.match(styles, /button\.idle-loadout-empty/);
});

test('aventure roguelike Idle : vit dans Progression et garde un raccourci contextuel depuis Combat', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const homeStart = html.indexOf('id="idle-panel-home"');
  const progressionStart = html.indexOf('id="idle-panel-progression"');
  const activitiesStart = html.indexOf('id="idle-panel-activities"');
  const journey = html.indexOf('id="idle-run-journey"');
  assert.ok(homeStart >= 0 && progressionStart > homeStart && journey > progressionStart && journey < activitiesStart);
  assert.match(html.slice(homeStart, progressionStart), /id="idle-run-shortcut"/);
  assert.doesNotMatch(html.slice(homeStart, progressionStart), /id="idle-run-journey"/);
  assert.match(source, /idle-run-shortcut-label/);
  assert.match(source, /idleShowPanel\('progression'\)/);
});

test('aventure roguelike Idle : une erreur de reroll réactive le bouton selon le dernier état connu', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const start = source.indexOf('async function rerollIdleRunBlessing()');
  const end = source.indexOf('function renderIdleOnboarding', start);
  assert.ok(start >= 0 && end > start, 'gestionnaire de reroll introuvable');
  assert.match(source.slice(start, end), /catch\(e\)\{idleNotify\(e\.message,'error'\);if\(idleState\)renderIdleRunJourney\(idleState\);\}/);
});

test('pilotage stratégique Idle : builds, diagnostic combat et profils automatiques restent exposés', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const id of ['idle-run-combos', 'idle-combat-analysis', 'idle-automation-profiles']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /function renderIdleCombatAnalysis\(/);
  assert.match(source, /async function applyIdleAutomationProfile\(/);
  assert.match(source, /keepBest:true/);
  assert.match(styles, /\.idle-advisor ol/);
  assert.match(styles, /\.idle-run-combos/);
  assert.match(styles, /\.idle-automation-profiles/);
});

test('endgame Idle : expéditions, mutateur hebdomadaire et protection intelligente sont pilotables', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const id of ['idle-weekly-rogue','idle-expeditions','idle-equipment-auto-lock']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(source,/function renderIdleExpeditions\(/);assert.match(source,/\/api\/idle\/expedition\/start/);assert.match(source,/\/api\/idle\/expedition\/claim/);assert.match(source,/\/api\/idle\/equipment\/auto-lock/);
  assert.match(styles,/\.idle-expedition-grid/);assert.match(styles,/\.idle-weekly-rogue\.active/);
});

test('équipement Idle : tout retirer et amélioration groupée couvrent aussi les héros au repos',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','idle.js'),'utf8');const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');const styles=fs.readFileSync(path.join(__dirname,'..','public','styles.css'),'utf8');
  for(const id of ['idle-unequip-all','idle-enhance-all-one','idle-enhance-all-five','idle-equipment-bulk-summary'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(source,/function unequipAllIdleEquipment\(\)/);assert.match(source,/\/api\/idle\/equipment\/unequip-all/);assert.match(source,/function enhanceAllIdleEquipment\(levels\)/);assert.match(source,/\/api\/idle\/equipment\/enhance-all/);assert.match(styles,/idle-equipment-bulk-tools/);
});

test('retours joueurs : bénédictions rendues à chaque synchro, confirmations intégrées, tri de collection', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  // L'aventure roguelike (choix/reroll/liste de bénédictions) doit être rendue
  // à chaque renderIdleState, pas seulement depuis l'onglet Équipe — sinon les
  // propositions n'apparaissaient qu'après un F5 (retour joueurs).
  assert.match(source, /\n {2}renderIdleRunJourney\(state\);/);

  // window.confirm est silencieusement ignoré par certaines WebViews mobiles :
  // toutes les confirmations du Dojo passent par la modale intégrée.
  assert.match(source, /function idleConfirm\(/);
  assert.doesNotMatch(source, /!confirm\(/);
  assert.doesNotMatch(source, /window\.confirm\(['"`]/);
  assert.match(source, /await idleConfirm\(`Revenir au niveau /);

  // Aperçu « APRÈS ACHAT » adapté au lot sélectionné (×5/×10/×100/MAX).
  assert.match(source, /after: item\.bulkCosts\.max\?\.after/);
  assert.match(source, /plan\.after!=null&&it\.formatAfter\?it\.formatAfter\(plan\.after\):it\.after/);

  // Tri de la collection par licence (complétion / recrutés / A–Z), persisté.
  assert.match(html, /id="idle-collection-sort"/);
  assert.match(source, /data-collection-sort/);
  assert.match(source, /localStorage\.setItem\('idle-collection-sort'/);
  assert.match(styles, /\.idle-collection-sort-bar/);
});

test('Donjon des Objets : la descente en 10 étages est visible et seul le dernier récompense', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

  assert.match(html, /id="idle-rune-dungeon-progress"/);
  assert.match(styles, /\.idle-rune-dungeon-progress/);
  // La récompense (et son jingle de coffre) n'apparaît qu'à l'étage final ;
  // les étages intermédiaires gardent un combat bref sans loot.
  assert.match(source, /if\(result\.cleared\)\{/);
  assert.match(source, /IDLE_RUNE_DUNGEON_FLOOR_MS/);
  assert.match(source, /ÉTAGE \$\{result\.floor\}\/\$\{result\.floors\}/);
  // Gratuit : plus de compteur de tentatives ni de coût en Essence, et la
  // durée du combat vient du serveur (PV de l'étage ÷ DPS de l'équipe).
  assert.match(source, /result\.encounter\?\.fightMs/);
  assert.doesNotMatch(source, /Descentes gratuites épuisées/);
  assert.doesNotMatch(source, /runeDungeon\?\.freeRemaining/);
});

test('QoL Idle : reprend le dernier onglet, mémorise l’inventaire et expose les raccourcis',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','idle.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  const styles=fs.readFileSync(path.join(__dirname,'..','public','styles.css'),'utf8');
  assert.match(source,/localStorage\.setItem\('idle-last-panel',name\)/);
  assert.match(source,/const rememberedPanel=localStorage\.getItem\('idle-last-panel'\)/);
  assert.match(source,/idlePanelScrolls\.set\(idleActivePanel,window\.scrollY\)/);
  assert.match(source,/localStorage\.setItem\('idle-inventory-prefs'/);
  assert.match(source,/\^Digit\[1-7\]\$/);
  assert.match(source,/class="idle-shortcuts"/);
  assert.match(source,/<kbd>Espace<\/kbd> Frapper/);
  assert.match(styles,/\.idle-shortcuts kbd/);
  assert.match(html,/id="idle-item-search"/);
  assert.match(html,/id="idle-item-recommended-only"/);
  assert.match(html,/id="idle-inventory-results"/);
  assert.match(source,/function idleRecommendedItems\(slotIndex\)/);
  assert.match(source,/idleItemSearchHaystack\(x\)\.includes\(normalizedSearch\)/);
  assert.match(source,/recommendedOnly:idleItemRecommendedOnly/);
  assert.match(styles,/\.idle-inventory-commandbar/);
  assert.match(styles,/\.idle-item-card\.recommended/);
  assert.match(styles,/position:sticky;top:62px/);
  assert.match(html,/class="idle-visual-details"/);
  assert.match(html,/Comprendre les compétences/);
  assert.match(styles,/#idle-panel-equipment\{--idle-panel-accent:#60a5fa\}/);
  assert.match(styles,/\.idle-tabs::before\{content:"NAVIGATION"/);
  assert.match(styles,/\.idle-tab\.active span\{display:block/);
  assert.match(html,/id="idle-set-codex"/);
  assert.match(html,/Catalyseur/);
  assert.match(source,/data-codex-set/);
  assert.match(source,/rune6:\{label:'Halo'/);
  assert.match(styles,/\.kind-rune1,\[data-item-kind="rune1"\]/);
  assert.match(styles,/#idle-set-codex>button\.active/);
});

test('direction Idle : combat, objectif, comparaison, favoris et onboarding partagent le nouveau langage visuel',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','idle.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  const styles=fs.readFileSync(path.join(__dirname,'..','public','styles.css'),'utf8');
  for(const id of ['idle-focus-objective','idle-team-compare','idle-boss-reveal'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/class="idle-reward-rays"/);
  assert.match(html,/idle-advanced-system/);
  assert.match(source,/function renderIdleTeamComparison\(/);
  assert.match(source,/idle-favorite-items/);
  assert.match(source,/function applyIdleRewardRarity\(/);
  assert.match(source,/data-team-compare-slot/);
  assert.match(styles,/\.idle-focus-objective/);
  assert.match(styles,/\.idle-team-compare/);
  assert.match(styles,/\.idle-item-card\.favorite/);
  assert.match(styles,/\.idle-beginner \.idle-advanced-system/);
  assert.match(styles,/VAGUE NETTOYÉE/);
  assert.match(styles,/\.idle-reward-rays/);
});

test('joueur expert : les huit outils compétitifs sont actionnables et les loadouts restaurent le profil complet',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','idle.js'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'..','src','idle','idle.routes.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  const styles=fs.readFileSync(path.join(__dirname,'..','public','styles.css'),'utf8');
  assert.match(html,/id="idle-competitive-title"/);
  for(const tab of ['optimizer','boss','loadouts','simulator','endgame','inventory','prestige','records'])assert.match(html,new RegExp(`data-competitive-tab="${tab}"`));
  assert.match(source,/function idleCompetitiveActions\(/);
  assert.match(source,/function idleCompetitiveDominatedItems\(/);
  assert.match(source,/function shareIdleCompetitiveBuild\(/);
  assert.match(source,/data-comp-select-dominated/);
  assert.match(server,/equipmentIds:itemsByCharacter/);
  assert.match(server,/data\.idleBattleMode=\['progress','farm'\]/);
  assert.match(server,/'dps','efficiency'/);
  assert.match(styles,/\.idle-competitive-center/);
  assert.match(styles,/\.idle-simulator-result/);
});

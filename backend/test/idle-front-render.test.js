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
  assert.match(source, /function renderIdleAdvisor\(advisor\)/);
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

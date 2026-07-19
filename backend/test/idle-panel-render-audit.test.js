// Audit statique : chaque bloc de rendu conditionné à un onglet
// (`idleActivePanel === 'x'` dans renderIdleState) ne doit toucher que des
// éléments DOM qui vivent DANS cet onglet (ou hors de tout onglet : HUD,
// scène, modales). Régression vécue : la section « aventure roguelike » a
// déménagé de l'onglet Équipe vers Niveaux, mais son rendu est resté dans le
// bloc Équipe — choix de bénédictions, reroll et sélection ne se mettaient à
// jour qu'après un F5 (retour joueurs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'idle.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const PANELS = ['home', 'team', 'upgrades', 'progression', 'equipment', 'farm', 'activities'];

// id DOM → onglet qui l'héberge (les ids hors panneau ne sont pas dans la map).
function buildPanelIdMap() {
  const map = new Map();
  for (const panel of PANELS) {
    const marker = `id="idle-panel-${panel}"`;
    const start = html.indexOf(marker);
    assert.ok(start >= 0, `panneau idle-panel-${panel} introuvable dans index.html`);
    // Fin de la section : le prochain panneau (les sections se suivent).
    let end = Infinity;
    for (const other of PANELS) {
      if (other === panel) continue;
      const position = html.indexOf(`id="idle-panel-${other}"`);
      if (position > start && position < end) end = position;
    }
    const slice = html.slice(start, end === Infinity ? html.indexOf('id="idle-tabs"') : end);
    for (const match of slice.matchAll(/id="([\w-]+)"/g)) {
      if (match[1].startsWith('idle-panel-')) continue;
      map.set(match[1], panel);
    }
  }
  return map;
}

// Corps de renderIdleState, découpé en blocs conditionnés par onglet.
function extractPanelBlocks() {
  const start = source.indexOf('function renderIdleState(state)');
  assert.ok(start >= 0, 'renderIdleState introuvable');
  const end = source.indexOf('\nfunction ', start + 10);
  const body = source.slice(start, end);
  const blocks = [];
  const regex = /if \(?idleActivePanel ?=== ?'(\w+)'\)? ?/g;
  let match;
  while ((match = regex.exec(body))) {
    const panel = match[1];
    let cursor = regex.lastIndex;
    let code;
    if (body[cursor] === '{') {
      // Bloc accolades : avance jusqu'à l'accolade fermante correspondante.
      let depth = 0; let position = cursor;
      do {
        if (body[position] === '{') depth++;
        if (body[position] === '}') depth--;
        position++;
      } while (depth > 0 && position < body.length);
      code = body.slice(cursor, position);
    } else {
      code = body.slice(cursor, body.indexOf('\n', cursor));
    }
    blocks.push({ panel, code });
  }
  assert.ok(blocks.length >= 5, 'blocs par onglet introuvables dans renderIdleState');
  return blocks;
}

// Source d'une fonction de rendu (heuristique : jusqu'à la prochaine
// déclaration de fonction au niveau module).
function functionSource(name) {
  const declaration = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (declaration < 0) return null;
  const next = source.slice(declaration + 10).search(/\n(?:async )?function [\w$]+\(/);
  return next < 0 ? source.slice(declaration) : source.slice(declaration, declaration + 10 + next);
}

function referencedIds(code) {
  return [...code.matchAll(/getElementById\('([\w-]+)'\)/g)].map((match) => match[1]);
}

test('renderIdleState : chaque bloc d’onglet ne touche que le DOM de SON onglet', () => {
  const idToPanel = buildPanelIdMap();
  const blocks = extractPanelBlocks();

  // Onglets autorisés par fonction = union des blocs qui l'appellent (une
  // fonction partagée entre Combat et Équipe peut toucher les deux).
  const functionPanels = new Map();
  for (const block of blocks) {
    for (const call of block.code.matchAll(/([\w$]+)\(/g)) {
      const name = call[1];
      if (!/^(render|load)[A-Z]/.test(name)) continue;
      if (!functionPanels.has(name)) functionPanels.set(name, new Set());
      functionPanels.get(name).add(block.panel);
    }
  }

  const violations = [];
  const check = (label, code, allowedPanels) => {
    for (const id of referencedIds(code)) {
      const owner = idToPanel.get(id);
      if (owner && !allowedPanels.has(owner)) {
        violations.push(`${label} touche #${id} (onglet « ${owner} ») depuis le bloc « ${[...allowedPanels].join('/')} »`);
      }
    }
  };
  for (const block of blocks) check(`bloc ${block.panel}`, block.code, new Set([block.panel]));
  for (const [name, panels] of functionPanels) {
    const code = functionSource(name);
    if (code) check(name, code, panels);
  }

  assert.deepEqual(violations, [], `Rendus hors de leur onglet :\n${violations.join('\n')}`);
});

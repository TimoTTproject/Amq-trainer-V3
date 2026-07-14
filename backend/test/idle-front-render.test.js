const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function loadSim() {
  const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
  const c = {}; vm.createContext(c); vm.runInContext(eng, c); return c.Sim;
}
function loadUI() {
  const src = html.match(/\/\/ UI_START([\s\S]*?)\/\/ UI_END/)[1];
  const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
  const ctx = { document: undefined, window: {} };
  vm.createContext(ctx);
  vm.runInContext(eng, ctx);
  vm.runInContext(src, ctx); // bootstrap IIFE early-returns when document is undefined
  return ctx.UI;
}

test('layout shell has the input bar, single result panel, and sessions table', () => {
  assert.ok(/id="inputs"/.test(html));
  assert.ok(/id="result"/.test(html));
  assert.ok(/id="sessions"/.test(html));
  assert.ok(!/id="cards"/.test(html));
  assert.ok(!/id="overlay"/.test(html));
});

test('UI_FIELDS ids are unique', () => {
  const ids = loadUI().UI_FIELDS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('UI_FIELDS includes supercharge, min-trailer-SoC, and 7 "run session" checkboxes', () => {
  const UI = loadUI();
  const ids = UI.UI_FIELDS.map(f => f.id);
  assert.ok(ids.indexOf('supercharge') !== -1);
  assert.ok(ids.indexOf('minTrailerSocPct') !== -1);
  for (let i = 1; i <= 7; i++) assert.ok(ids.indexOf('runS' + i) !== -1, 'runS' + i + ' present');
  // defaults: supercharge on; all sessions checked except 1pm (runS4)
  const def = id => UI.UI_FIELDS.find(f => f.id === id).default;
  assert.equal(def('supercharge'), true);
  assert.equal(def('runS4'), false); // 1pm unchecked
  [1, 2, 3, 5, 6, 7].forEach(i => assert.equal(def('runS' + i), true));
});

test('readParams(default form values) deep-equals engine defaultParams', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const values = {};
  UI.UI_FIELDS.forEach(f => { values[f.id] = String(f.default); });
  assert.deepEqual(UI.readParams(values), Sim.defaultParams());
});

test('a "run session" checkbox maps (inverted) to the engine skip flag', () => {
  const UI = loadUI();
  const values = {};
  UI.UI_FIELDS.forEach(f => { values[f.id] = String(f.default); });
  values.runS5 = false;        // unchecking "run 2pm" -> skip it
  values.runS6 = 'true';       // checked -> run it
  const p = UI.readParams(values);
  assert.equal(p.skipS5, true);
  assert.equal(p.skipS6, false);
});

test('hhmmToMin / minToHHMM round-trip', () => {
  const UI = loadUI();
  assert.equal(UI.hhmmToMin('08:00'), 480);
  assert.equal(UI.minToHHMM(480), '08:00');
  assert.equal(UI.hhmmToMin('13:15'), 795);
});

test('formatMetrics returns labeled rows incl. fuel, min SoC, sessions run', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const rows = UI.formatMetrics(Sim.simulate(Sim.defaultParams()).metrics);
  const labels = rows.map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('lowest')));
  assert.ok(labels.some(l => l.includes('gas') || l.includes('fuel')));
  assert.ok(labels.some(l => l.includes('end')));
  assert.ok(labels.some(l => l.includes('sessions run')));
  rows.forEach(r => { assert.equal(typeof r.value, 'string'); });
});

test('formatMetrics adds supercharge + skipped rows when supercharging (default)', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const labels = UI.formatMetrics(Sim.simulate(Sim.defaultParams()).metrics).map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('supercharged')));
  assert.ok(labels.some(l => l.includes('back')));
  assert.ok(labels.some(l => l.includes('skipped')));
});

test('formatMetrics shows a skipped row when a session is manually skipped', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const p = Sim.defaultParams(); p.supercharge = false; p.skipS4 = false; p.skipS2 = true;
  const labels = UI.formatMetrics(Sim.simulate(p).metrics).map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('skipped')));
});

test('chartScale maps domain to canvas box', () => {
  const UI = loadUI();
  assert.ok(typeof UI.chartScale === 'function');
  const s = UI.chartScale({ w:100, h:100, padL:10, padR:0, padT:0, padB:0, xMin:0, xMax:10, yMin:0, yMax:100 });
  assert.equal(s.X(0), 10);
  assert.equal(s.X(10), 100);
  assert.equal(s.Y(100), 0);
  assert.equal(s.Y(0), 100);
});

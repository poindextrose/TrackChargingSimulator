const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('layout shell has the input bar, three card slots, and overlay', () => {
  assert.ok(/id="inputs"/.test(html));
  assert.ok(/id="cards"/.test(html));
  assert.ok(/id="overlay"/.test(html));
  ['cardA', 'cardB', 'cardC'].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"').test(html), id + ' present');
  });
});

function loadUI() {
  const src = html.match(/\/\/ UI_START([\s\S]*?)\/\/ UI_END/)[1];
  // engine is a dependency of the UI block; load it first into the same context
  const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
  const ctx = { document: undefined, window: {} };
  vm.createContext(ctx);
  vm.runInContext(eng, ctx);
  // UI block references `document` only inside functions we will not call here.
  vm.runInContext(src, ctx);
  return ctx.UI;
}

test('UI_FIELDS ids are unique', () => {
  const UI = loadUI();
  const ids = UI.UI_FIELDS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('readParams(default form values) deep-equals engine defaultParams', () => {
  const UI = loadUI();
  const Sim = (() => {
    const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
    const c = {}; vm.createContext(c); vm.runInContext(eng, c); return c.Sim;
  })();
  // Build a values map from each field's default.
  const values = {};
  UI.UI_FIELDS.forEach(f => { values[f.id] = String(f.default); });
  const parsed = UI.readParams(values);
  assert.deepEqual(parsed, Sim.defaultParams());
});

test('hhmmToMin / minToHHMM round-trip', () => {
  const UI = loadUI();
  assert.equal(UI.hhmmToMin('08:00'), 480);
  assert.equal(UI.minToHHMM(480), '08:00');
  assert.equal(UI.hhmmToMin('13:15'), 795);
});

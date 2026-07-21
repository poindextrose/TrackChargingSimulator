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

test('layout shell has profiles bar, input bar, result panel, and sessions table', () => {
  assert.ok(/id="profiles"/.test(html));
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

test('car and track field ids are disjoint subsets of UI_FIELDS', () => {
  const UI = loadUI();
  const all = new Set(UI.UI_FIELDS.map(f => f.id));
  UI.CAR_FIELD_IDS.forEach(id => assert.ok(all.has(id), 'car field ' + id));
  UI.TRACK_FIELD_IDS.forEach(id => assert.ok(all.has(id), 'track field ' + id));
  const overlap = UI.CAR_FIELD_IDS.filter(id => UI.TRACK_FIELD_IDS.includes(id));
  assert.deepEqual(overlap, []);
});

test('builtinProfiles seeds Plaid + Ridge with field defaults', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  assert.equal(bp.cars.length, 1);
  assert.equal(bp.tracks.length, 1);
  assert.equal(bp.cars[0].id, UI.BUILTIN_CAR_ID);
  assert.equal(bp.tracks[0].id, UI.BUILTIN_TRACK_ID);
  assert.equal(bp.cars[0].name, 'Tesla Model S Plaid');
  assert.equal(bp.tracks[0].name, 'Ridge Motorsports Park');
  assert.equal(bp.cars[0].values.capacityKwh, '100');
  assert.equal(bp.tracks[0].values.driveTimeMin, '30');
  assert.equal(bp.tracks[0].values.scPowerCapKw, '250');
});

test('normalizeProfiles restores missing builtins and repairs bad active ids', () => {
  const UI = loadUI();
  const n = UI.normalizeProfiles({
    cars: [{ id: 'car-custom', name: 'My EV', values: { capacityKwh: '75' } }],
    tracks: [],
    activeCarId: 'missing',
    activeTrackId: 'also-missing',
  });
  assert.ok(n.cars.some(p => p.id === UI.BUILTIN_CAR_ID));
  assert.ok(n.cars.some(p => p.id === 'car-custom'));
  assert.equal(n.cars.find(p => p.id === 'car-custom').values.capacityKwh, '75');
  // custom still gets remaining car defaults filled in
  assert.equal(n.cars.find(p => p.id === 'car-custom').values.sessionEnergyKwh, '35');
  assert.ok(n.tracks.some(p => p.id === UI.BUILTIN_TRACK_ID));
  assert.equal(n.activeCarId, n.cars[0].id); // repaired to first available
  assert.equal(n.activeTrackId, n.tracks[0].id);
});

test('pickFields / valuesEqual / upsert / remove profile helpers', () => {
  const UI = loadUI();
  const picked = UI.pickFields({ capacityKwh: '90', dcPowerKw: '40', junk: 1 }, UI.CAR_FIELD_IDS);
  assert.equal(picked.capacityKwh, '90');
  assert.equal(picked.dcPowerKw, undefined);
  assert.ok(UI.valuesEqual({ a: '1', b: true }, { a: 1, b: 'true' }, ['a', 'b']));
  assert.ok(!UI.valuesEqual({ a: '1' }, { a: '2' }, ['a']));

  let list = [{ id: 'x', name: 'X', values: { a: 1 } }];
  list = UI.upsertProfile(list, { id: 'x', name: 'X2', values: { a: 2 } });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'X2');
  list = UI.upsertProfile(list, { id: 'y', name: 'Y', values: {} });
  assert.equal(list.length, 2);
  list = UI.removeProfile(list, 'x');
  assert.deepEqual(list.map(p => p.id), ['y']);
});

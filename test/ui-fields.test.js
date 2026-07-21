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
  vm.runInContext(src, ctx);
  return ctx.UI;
}

test('layout shell has inputs, session table, and result panel', () => {
  assert.ok(/id="inputs"/.test(html));
  assert.ok(/sessionTable/.test(html));
  assert.ok(/id="result"/.test(html));
  assert.ok(!/id="sessions"/.test(html));
  assert.ok(!/Per-session state of charge/.test(html));
  assert.ok(!/id="supercharge"/.test(html));
  assert.ok(!/id="runS1"/.test(html));
});

test('UI_FIELDS ids are unique', () => {
  const ids = loadUI().UI_FIELDS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('readParams(default form values) deep-equals engine defaultParams', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const values = {};
  UI.UI_FIELDS.forEach(f => { values[f.id] = String(f.default); });
  values.sessions = UI.defaultSessionsForm();
  assert.deepEqual(UI.readParams(values), Sim.defaultParams());
});

test('sessions form maps after + start; sorts by time', () => {
  const UI = loadUI();
  const eng = UI.sessionsToEngine([
    { start: '13:00' },
    { start: '09:00', after: 'offsite' },
  ]);
  assert.deepEqual(eng, [
    { startMin: 9 * 60, enabled: true, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30 },
    { startMin: 13 * 60, enabled: true },
  ]);
});
// note: form defaults offsite extras to next/80%/30 when after is offsite

test('normalizeSessionsForm sorts and migrates legacy before to after', () => {
  const UI = loadUI();
  // Legacy: charge mode lived on the *next* session as before/action
  const n = UI.normalizeSessionsForm([
    { start: '14:00', action: 'run' },
    { start: '10:00', action: 'offsite' },
  ]);
  assert.deepEqual(n, [
    { start: '10:00', enabled: true, after: 'onsite' }, // from 14:00 action run → onsite
    { start: '14:00', enabled: true }, // last: no after
  ]);
  // Explicit: before on second becomes after on first
  const m = UI.normalizeSessionsForm([
    { start: '09:00', before: 'onsite' },
    { start: '13:00', before: 'offsite' },
  ]);
  assert.deepEqual(m, [
    { start: '09:00', enabled: true, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30 },
    { start: '13:00', enabled: true },
  ]);
});

test('adding a session keeps existing after modes attached to their sessions', () => {
  const UI = loadUI();
  const base = [
    { start: '09:00', after: 'onsite' },
    { start: '11:00', after: 'offsite' },
    { start: '13:00' },
  ];
  // Insert 10:00 between 9 and 11 — 11's after must stay offsite (on 11), not move
  const withNew = UI.normalizeSessionsForm(base.concat([{ start: '10:00', after: 'onsite' }]));
  assert.deepEqual(withNew, [
    { start: '09:00', enabled: true, after: 'onsite' },
    { start: '10:00', enabled: true, after: 'onsite' },
    { start: '11:00', enabled: true, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30 }, // form default extras
    { start: '13:00', enabled: true },
  ]);
});

test('disabled session has no after; charge continues from previous enabled', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const n = UI.normalizeSessionsForm([
    { start: '09:00', after: 'offsite' },
    { start: '10:00', enabled: false },
    { start: '13:00' },
  ]);
  assert.equal(n[1].enabled, false);
  assert.ok(!('after' in n[1]));
  assert.equal(n[0].after, 'offsite');
  const sched = Sim.buildSchedule({
    ...Sim.defaultParams(),
    sessions: UI.sessionsToEngine(n),
  });
  assert.equal(sched[0].enabled, true);
  assert.equal(sched[0].after, 'offsite');
  assert.equal(sched[1].enabled, false);
  assert.equal(sched[1].before, 'offsite'); // inherits prior after
  assert.equal(sched[2].before, 'offsite');
  assert.equal(sched[2].enabled, true);
});

test('hhmmToMin / minToHHMM round-trip', () => {
  const UI = loadUI();
  assert.equal(UI.hhmmToMin('08:00'), 480);
  assert.equal(UI.minToHHMM(480), '08:00');
});

test('formatMetrics rows include fuel and sessions run', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const rows = UI.formatMetrics(Sim.simulate(Sim.defaultParams()).metrics);
  const labels = rows.map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('lowest')));
  assert.ok(labels.some(l => l.includes('gas') || l.includes('fuel')));
  assert.ok(labels.some(l => l.includes('sessions run')));
});

test('formatMetrics adds offsite row for default plan', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const labels = UI.formatMetrics(Sim.simulate(Sim.defaultParams()).metrics).map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('offsite')));
});

test('chartScale maps domain to canvas box', () => {
  const UI = loadUI();
  const s = UI.chartScale({ w:100, h:100, padL:10, padR:0, padT:0, padB:0, xMin:0, xMax:10, yMin:0, yMax:100 });
  assert.equal(s.X(0), 10);
  assert.equal(s.X(10), 100);
  assert.equal(s.Y(100), 0);
  assert.equal(s.Y(0), 100);
});

test('builtin track profile has after-gap session plan and drive-in costs', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  const track = bp.tracks[0].values;
  const sess = track.sessions;
  assert.equal(sess.length, 7);
  assert.equal(sess.find(s => s.start === '11:00').after, 'offsite');
  assert.ok(!('after' in sess.find(s => s.start === '16:00')));
  assert.ok(sess.every(s => !s.action && !s.before));
  assert.equal(track.arrivalCostNoTrailerKwh, '13');
  assert.equal(track.towingCostKwh, '4');
});

test('builtin cars include Plaid and Model 3 Performance with charge curves', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  assert.ok(bp.cars.length >= 2);
  const plaid = bp.cars.find(c => c.id === UI.BUILTIN_CAR_ID);
  const m3p = bp.cars.find(c => c.id === UI.BUILTIN_CAR_M3P_ID);
  assert.ok(plaid);
  assert.ok(m3p);
  assert.equal(plaid.values.chargeCurveId, 'model-s-plaid');
  assert.equal(plaid.values.capacityKwh, '99.4');
  assert.equal(m3p.values.chargeCurveId, 'model-3-performance');
  assert.equal(m3p.values.capacityKwh, '75');
  assert.ok(!('arrivalCostNoTrailerKwh' in plaid.values));
  assert.ok(!('towingCostKwh' in plaid.values));
});

test('normalizeProfiles does not resurrect deleted profiles on reload', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  // User deleted Model S Plaid but kept M3P + a custom car
  const custom = {
    id: 'car-custom', name: 'My Track Car', builtin: false,
    values: UI.fieldDefaults(UI.CAR_FIELD_IDS),
  };
  const carsAfterDelete = UI.removeProfile(bp.cars, UI.BUILTIN_CAR_ID).concat([custom]);
  assert.ok(!carsAfterDelete.some(c => c.id === UI.BUILTIN_CAR_ID));
  assert.ok(carsAfterDelete.some(c => c.id === UI.BUILTIN_CAR_M3P_ID));

  const reloaded = UI.normalizeProfiles({
    cars: carsAfterDelete,
    activeCarId: custom.id,
    tracks: bp.tracks,
    activeTrackId: bp.activeTrackId,
    sites: bp.sites,
    activeSiteId: bp.activeSiteId,
  });
  assert.ok(!reloaded.cars.some(c => c.id === UI.BUILTIN_CAR_ID),
    'deleted builtin car must stay deleted after normalize/reload');
  assert.ok(reloaded.cars.some(c => c.id === UI.BUILTIN_CAR_M3P_ID));
  assert.ok(reloaded.cars.some(c => c.id === 'car-custom'));
  assert.equal(reloaded.activeCarId, custom.id);

  // Empty list still seeds defaults (first run / wipe)
  const empty = UI.normalizeProfiles({
    cars: [], activeCarId: 'gone',
    tracks: [], activeTrackId: 'gone',
    sites: [], activeSiteId: 'gone',
  });
  assert.ok(empty.cars.some(c => c.id === UI.BUILTIN_CAR_ID));
  assert.ok(empty.tracks.some(t => t.id === UI.BUILTIN_TRACK_ID));
  assert.ok(empty.sites.some(s => s.id === UI.BUILTIN_SITE_ID));
});

test('sessionsEqual compares after fields', () => {
  const UI = loadUI();
  assert.ok(UI.sessionsEqual(
    [{ start: '09:00', after: 'onsite' }, { start: '10:00' }],
    [{ start: '09:00', after: 'onsite' }, { start: '10:00' }]
  ));
  assert.ok(!UI.sessionsEqual(
    [{ start: '09:00', after: 'onsite' }, { start: '10:00' }],
    [{ start: '09:00', after: 'offsite' }, { start: '10:00' }]
  ));
});

test('GAP_ACTION_OPTIONS includes onsite, offsite, and none', () => {
  const UI = loadUI();
  assert.deepEqual(UI.GAP_ACTION_OPTIONS.map(o => o.value), ['onsite', 'offsite', 'none']);
  assert.ok(UI.GAP_ACTION_OPTIONS.some(o => /Charge onsite/i.test(o.label)));
  assert.ok(UI.GAP_ACTION_OPTIONS.some(o => /No charging/i.test(o.label)));
});

test('packExport / parseImport round-trip selected profiles', () => {
  const UI = loadUI();
  const state = UI.builtinProfiles();
  state.cars.push({
    id: 'car-custom', name: 'My EV', builtin: false,
    values: Object.assign(UI.fieldDefaults(UI.CAR_FIELD_IDS), { capacityKwh: '75' }),
  });
  state.activeCarId = 'car-custom';
  state.activeTrackId = UI.BUILTIN_TRACK_ID;
  const packed = UI.packExport(state, {
    cars: ['car-custom'],
    tracks: [UI.BUILTIN_TRACK_ID],
    sites: [],
  });
  assert.equal(packed.format, UI.EXPORT_FORMAT);
  assert.equal(packed.cars.length, 1);
  assert.equal(packed.cars[0].name, 'My EV');
  assert.equal(packed.tracks.length, 1);
  assert.equal(packed.sites.length, 0);
  assert.equal(packed.activeCarId, 'car-custom');
  assert.equal(packed.activeCarName, 'My EV');
  assert.equal(packed.activeTrackId, UI.BUILTIN_TRACK_ID);
  assert.equal(packed.activeTrackName, 'Ridge Motorsports Park');
  const parsed = UI.parseImport(JSON.stringify(packed));
  assert.equal(parsed.cars[0].values.capacityKwh, '75');
  assert.equal(parsed.tracks[0].name, 'Ridge Motorsports Park');
  assert.equal(parsed.activeCarName, 'My EV');
  assert.equal(parsed.activeTrackName, 'Ridge Motorsports Park');
});

test('applyImport restores active car and track from export metadata', () => {
  const UI = loadUI();
  let state = UI.builtinProfiles();
  const packed = UI.packExport(Object.assign({}, state, {
    activeCarId: UI.BUILTIN_CAR_M3P_ID,
    activeTrackId: UI.BUILTIN_TRACK_ID,
  }), {
    cars: [UI.BUILTIN_CAR_M3P_ID],
    tracks: [UI.BUILTIN_TRACK_ID],
    sites: [UI.BUILTIN_SITE_ID],
  });
  const parsed = UI.parseImport(JSON.stringify(packed));
  // Fresh state with only builtins; import M3P + track and restore actives
  const items = [
    { kind: 'car', profile: parsed.cars[0] },
    { kind: 'track', profile: parsed.tracks[0] },
  ];
  const r = UI.applyImport(state, items, {
    'car:Tesla Model 3 Performance': 'replace',
    'track:Ridge Motorsports Park': 'replace',
  }, {
    activeCarId: parsed.activeCarId,
    activeCarName: parsed.activeCarName,
    activeTrackId: parsed.activeTrackId,
    activeTrackName: parsed.activeTrackName,
  });
  assert.equal(r.state.activeCarId, UI.BUILTIN_CAR_M3P_ID);
  assert.equal(r.state.activeTrackId, UI.BUILTIN_TRACK_ID);
});

test('applyImport adds new, replaces, or duplicates with …import', () => {
  const UI = loadUI();
  let state = UI.builtinProfiles();
  // add new
  let r = UI.applyImport(state, [{
    kind: 'car',
    profile: { name: 'Leaf', values: UI.fieldDefaults(UI.CAR_FIELD_IDS) },
  }], {});
  assert.equal(r.summary.added, 1);
  assert.ok(r.state.cars.some(p => p.name === 'Leaf'));

  // replace builtin-named track
  r = UI.applyImport(r.state, [{
    kind: 'track',
    profile: {
      name: 'Ridge Motorsports Park',
      values: Object.assign(UI.trackFieldDefaults(), { driveTimeMin: '45' }),
    },
  }], { 'track:Ridge Motorsports Park': 'replace' });
  assert.equal(r.summary.replaced, 1);
  const ridge = r.state.tracks.find(p => p.name === 'Ridge Motorsports Park');
  assert.equal(ridge.values.driveTimeMin, '45');
  assert.equal(ridge.id, UI.BUILTIN_TRACK_ID);

  // duplicate on name conflict
  r = UI.applyImport(r.state, [{
    kind: 'car',
    profile: { name: 'Leaf', values: UI.fieldDefaults(UI.CAR_FIELD_IDS) },
  }], { 'car:Leaf': 'duplicate' });
  assert.equal(r.summary.duplicated, 1);
  assert.ok(r.state.cars.some(p => p.name === 'Leaf …import'));
});

test('layout has export/import controls and modal', () => {
  assert.ok(/id="btnExport"/.test(html));
  assert.ok(/id="btnImport"/.test(html));
  assert.ok(/id="importFile"/.test(html));
  assert.ok(/id="modal"/.test(html));
});

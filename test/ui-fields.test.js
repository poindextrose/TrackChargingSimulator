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

test('session table has End column immediately before For', () => {
  assert.ok(/<th>Start<\/th><th>Activity<\/th><th>End<\/th><th>For<\/th>/.test(html));
  assert.ok(/class="c-end"/.test(html));
  // Row templates include end cells before duration cells
  assert.ok(/sess-end/.test(html));
  assert.ok(/ch-end/.test(html));
  assert.ok(/do-end/.test(html));
  assert.ok(/db-end/.test(html));
  assert.ok(/wt-end/.test(html));
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
    { startMin: 9 * 60, enabled: true, durationMin: 20, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30, residualMode: 'onsite',
      offsiteSiteId: 'offsite-default' },
    { startMin: 13 * 60, enabled: true, durationMin: 20 },
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
    { start: '10:00', enabled: true, durationMin: 20, after: 'onsite' }, // from 14:00 action run → onsite
    { start: '14:00', enabled: true, durationMin: 20 }, // last: no after
  ]);
  // Explicit: before on second becomes after on first
  const m = UI.normalizeSessionsForm([
    { start: '09:00', before: 'onsite' },
    { start: '13:00', before: 'offsite' },
  ]);
  assert.deepEqual(m, [
    { start: '09:00', enabled: true, durationMin: 20, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30, residualMode: 'onsite',
      offsiteSiteId: 'offsite-default' },
    { start: '13:00', enabled: true, durationMin: 20 },
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
    { start: '09:00', enabled: true, durationMin: 20, after: 'onsite' },
    { start: '10:00', enabled: true, durationMin: 20, after: 'onsite' },
    { start: '11:00', enabled: true, durationMin: 20, after: 'offsite',
      offsiteStop: 'next', offsiteUntilSocPct: 80, offsiteForMin: 30, residualMode: 'onsite',
      offsiteSiteId: 'offsite-default' },
    { start: '13:00', enabled: true, durationMin: 20 },
  ]);
});

test('disabled session keeps after for full-hour onsite charge option', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const n = UI.normalizeSessionsForm([
    { start: '09:00', after: 'offsite' },
    { start: '10:00', enabled: false, after: 'onsite' },
    { start: '13:00' },
  ]);
  assert.equal(n[1].enabled, false);
  assert.equal(n[1].after, 'onsite'); // skipped hour can charge onsite
  assert.equal(n[0].after, 'offsite');
  const sched = Sim.buildSchedule({
    ...Sim.defaultParams(),
    sessions: UI.sessionsToEngine(n),
  });
  assert.equal(sched[0].enabled, true);
  assert.equal(sched[0].after, 'offsite');
  assert.equal(sched[1].enabled, false);
  assert.equal(sched[1].after, 'onsite');
  assert.equal(sched[1].before, 'offsite'); // gap into skipped still from prior offsite
  assert.equal(sched[2].before, 'onsite'); // next session inherits skipped hour mode
  assert.equal(sched[2].enabled, true);
});

test('hhmmToMin / minToHHMM round-trip', () => {
  const UI = loadUI();
  assert.equal(UI.hhmmToMin('08:00'), 480);
  assert.equal(UI.minToHHMM(480), '08:00');
});

test('minToAmPm formats 12-hour times for intermediate rows', () => {
  const UI = loadUI();
  assert.equal(UI.minToAmPm(0), '12:00 AM');
  assert.equal(UI.minToAmPm(480), '8:00 AM');
  assert.equal(UI.minToAmPm(12 * 60 + 30), '12:30 PM');
  assert.equal(UI.minToAmPm(13 * 60 + 5), '1:05 PM');
  assert.equal(UI.minToAmPm(23 * 60 + 59), '11:59 PM');
});

// Regression: switching track with site off → track with site on used to demote
// stored "onsite" gaps to "none" because sessions were built before site enable.
test('applyTrackProfile restores site enable before building session gap selects', () => {
  const src = html.match(/function applyTrackProfile\([\s\S]*?\n  \}/)[0];
  // Ignore comments; match the assignment / call that actually run.
  const siteEnableAt = src.search(/vals\.siteChargingEnabled/);
  const sessionsAt = src.search(/setSessionsForm\s*\(/);
  assert.ok(siteEnableAt >= 0, 'sets siteChargingEnabled');
  assert.ok(sessionsAt >= 0, 'calls setSessionsForm');
  assert.ok(siteEnableAt < sessionsAt, 'site enable must come before session rows');
  // Must not rebuild sessions via applyProfileValues('track') which would run too early
  assert.ok(!/applyProfileValues\(\s*['"]track['"]/.test(src));
});

test('buildTrackDayStats includes min/kWh, lowest SoC, and gen/fuel when present', () => {
  const UI = loadUI();
  const Sim = loadSim();
  const p = Sim.defaultParams();
  const m = Sim.simulate(p).metrics;
  const chips = UI.buildTrackDayStats(p, m);
  const text = chips.map(c => c.html).join(' ').toLowerCase();
  assert.ok(text.includes('min on track'));
  assert.ok(text.includes('kwh on track'));
  assert.ok(text.includes('lowest session end'));
  // Default plan uses portable gen — expect fuel and/or from generator when energy flows
  assert.ok(
    text.includes('from generator') || text.includes('gasoline') || text.includes('propane') ||
    text.includes('min on track'),
    'day stats text=' + text
  );
  // Bottom metrics list is empty (stats moved under Track)
  assert.deepEqual(UI.formatMetrics(m), []);
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
  // Match track-charging-profiles-2026-07-22.json
  assert.equal(bp.tracks.length, 6);
  assert.equal(bp.sites.length, 2);
  assert.equal(bp.activeTrackId, UI.BUILTIN_TRACK_ID);
  assert.equal(bp.activeSiteId, UI.BUILTIN_SITE_GEN_WALL_ID);
  const track = bp.tracks.find(t => t.id === UI.BUILTIN_TRACK_ID).values;
  assert.equal(bp.tracks.find(t => t.id === UI.BUILTIN_TRACK_ID).name, 'The Ridge w/ gen');
  const sess = track.sessions;
  assert.equal(sess.length, 7);
  assert.equal(sess.find(s => s.start === '09:00').after, 'onsite');
  assert.equal(sess.find(s => s.start === '10:00').after, 'offsite');
  assert.equal(sess.find(s => s.start === '10:00').offsiteStop, 'next');
  assert.equal(sess.find(s => s.start === '11:00').enabled, false);
  assert.equal(sess.find(s => s.start === '11:00').after, 'onsite');
  assert.equal(sess.find(s => s.start === '13:00').enabled, true);
  assert.equal(sess.find(s => s.start === '13:00').after, 'onsite');
  assert.equal(sess.find(s => s.start === '14:00').after, 'offsite');
  assert.equal(sess.find(s => s.start === '15:00').enabled, false);
  assert.ok(!('after' in sess.find(s => s.start === '16:00')));
  assert.ok(sess.every(s => !s.action && !s.before));
  assert.equal(track.towingCostKwh, '4');
  assert.ok(track.offsiteSites && track.offsiteSites.length >= 1);
  assert.equal(track.offsiteSites[0].name, 'Tumwater');
  assert.equal(Number(track.offsiteSites[0].driveConsumptionKwh), 13);
  assert.equal(Number(track.offsiteSites[0].driveTimeMin), 30);
  // Drive-in cost comes from pre-track charger site (not a separate arrival cost field)
  assert.equal(track.preTrackSiteId, track.offsiteSites[0].id);
  assert.ok(!('arrivalCostNoTrailerKwh' in track));
  // Default start SoC at pre-track charger (Ridge w/ gen arrives at 80%)
  assert.equal(Number(track.preTrackArriveSocPct), 80);
  // Onsite charging lives on the track profile, not portable site
  assert.ok(UI.TRACK_FIELD_IDS.includes('gridEnabled'));
  assert.ok(UI.TRACK_FIELD_IDS.includes('gridPowerKw'));
  assert.ok(UI.TRACK_FIELD_IDS.includes('sessionDurationMin'));
  assert.ok(!UI.SITE_FIELD_IDS.includes('gridEnabled'));
  assert.ok(!UI.SITE_FIELD_IDS.includes('gridPowerKw'));
  assert.equal(track.gridEnabled, true);
  assert.equal(String(track.gridPowerKw), '11.5');
  assert.equal(track.siteChargingEnabled, false);
  assert.equal(track.siteProfileId, UI.BUILTIN_SITE_GEN_WALL_ID);
  // Max session time defaults to 20 min for new/builtin tracks
  assert.equal(String(track.sessionDurationMin), '20');
  const maxSessField = UI.UI_FIELDS.find(f => f.id === 'sessionDurationMin');
  assert.ok(maxSessField);
  assert.equal(maxSessField.label, 'Max session time');
  assert.equal(maxSessField.default, 20);
  assert.equal(maxSessField.g, 'Track');
  assert.equal(maxSessField.embed, 'sessionsHead'); // sessions header, before min on track
  assert.equal(String(UI.trackFieldDefaults().sessionDurationMin), '20');
  assert.ok(!('gridEnabled' in bp.sites[0].values));
  assert.equal(UI.PROFILE_META.site.label, 'Portable Charging');
  assert.equal(bp.sites.find(s => s.id === UI.BUILTIN_SITE_ID).name, 'Trailer battery/gen');
  assert.equal(String(bp.sites.find(s => s.id === UI.BUILTIN_SITE_ID).values.trailerCapKwh), '24');
  assert.equal(bp.sites.find(s => s.id === UI.BUILTIN_SITE_GEN_WALL_ID).name, 'Generator @ 11.5kw');
  assert.ok(bp.tracks.some(t => t.id === UI.BUILTIN_TRACK_QLISPE_ID));
  assert.ok(bp.tracks.some(t => t.id === UI.BUILTIN_TRACK_WALL_ID));
  assert.ok(bp.tracks.some(t => t.id === UI.BUILTIN_TRACK_AREA27_ID));
  assert.ok(bp.tracks.some(t => t.id === UI.BUILTIN_TRACK_RIDGE_ID));
  assert.ok(bp.tracks.some(t => t.id === UI.BUILTIN_TRACK_RIDGE_GEN_BATT_ID));
});

test('normalizeOffsiteSites migrates legacy single-site fields', () => {
  const Sim = loadSim();
  const sites = Sim.normalizeOffsiteSites(null, {
    scName: 'Tumwater', scPowerCapKw: 250, driveTimeMin: 30, driveConsumptionKwh: 13,
  });
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, 'Tumwater');
  assert.equal(sites[0].driveTimeMin, 30);
  // Default activity color (green palette[0])
  assert.equal(sites[0].color, '#22c55e');
});

test('offsite sites get distinct default colors; custom colors are preserved', () => {
  const Sim = loadSim();
  const sites = Sim.normalizeOffsiteSites([
    { id: 'a', name: 'One', powerKw: 250, driveTimeMin: 20, driveConsumptionKwh: 10 },
    { id: 'b', name: 'Two', powerKw: 150, driveTimeMin: 15, driveConsumptionKwh: 5 },
    { id: 'c', name: 'Three', powerKw: 350, driveTimeMin: 40, driveConsumptionKwh: 20, color: '#ff0000' },
  ]);
  assert.equal(sites.length, 3);
  assert.equal(sites[0].color, Sim.defaultOffsiteColor(0));
  assert.equal(sites[1].color, Sim.defaultOffsiteColor(1));
  assert.notEqual(sites[0].color, sites[1].color);
  assert.equal(sites[2].color, '#ff0000');
  assert.equal(Sim.normalizeOffsiteColor('#0f0', 0), '#00ff00');
  assert.equal(Sim.normalizeOffsiteColor('not-a-color', 3), Sim.defaultOffsiteColor(3));
});

test('pickTrackValues preserves preTrackArriveSocPct for profile save/reload', () => {
  const UI = loadUI();
  const base = UI.defaultProfileValues('track');
  const picked = UI.pickTrackValues(Object.assign({}, base, { preTrackArriveSocPct: '33' }));
  assert.equal(Number(picked.preTrackArriveSocPct), 33);
  const again = UI.pickTrackValues(picked);
  assert.equal(Number(again.preTrackArriveSocPct), 33);
  // Dirty check treats changed from % as a track edit
  assert.equal(UI.trackValuesEqual(base, picked), false);
  assert.equal(UI.trackValuesEqual(picked, again), true);
});

test('normalizeProfiles migrates onsite grid from site onto track', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  const reloaded = UI.normalizeProfiles({
    cars: bp.cars,
    activeCarId: bp.activeCarId,
    tracks: [{
      id: bp.tracks[0].id,
      name: bp.tracks[0].name,
      builtin: true,
      values: {
        sessions: bp.tracks[0].values.sessions,
        siteProfileId: bp.sites[0].id,
        // no gridEnabled on track — pre-migration shape
      },
    }],
    activeTrackId: bp.activeTrackId,
    sites: [{
      id: bp.sites[0].id,
      name: bp.sites[0].name,
      builtin: true,
      values: Object.assign({}, bp.sites[0].values, {
        gridEnabled: true,
        gridPowerKw: '22',
      }),
    }],
    activeSiteId: bp.activeSiteId,
  });
  assert.equal(reloaded.tracks[0].values.gridEnabled, true);
  assert.equal(String(reloaded.tracks[0].values.gridPowerKw), '22');
  assert.ok(!('gridEnabled' in reloaded.sites[0].values));
});

test('builtin cars include My Plaid and Model 3 Performance with charge curves', () => {
  const UI = loadUI();
  const bp = UI.builtinProfiles();
  assert.ok(bp.cars.length >= 2);
  assert.equal(bp.activeCarId, UI.BUILTIN_CAR_ID);
  const plaid = bp.cars.find(c => c.id === UI.BUILTIN_CAR_ID);
  const m3p = bp.cars.find(c => c.id === UI.BUILTIN_CAR_M3P_ID);
  assert.ok(plaid);
  assert.equal(plaid.name, 'My Plaid');
  assert.ok(m3p);
  assert.equal(m3p.name, 'Random Model 3');
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

test('defaultProfileValues returns fresh defaults per kind', () => {
  const UI = loadUI();
  const car = UI.defaultProfileValues('car');
  assert.equal(String(car.capacityKwh), '99.4');
  assert.equal(car.chargeCurveId, 'model-s-plaid');
  const track = UI.defaultProfileValues('track');
  assert.ok(Array.isArray(track.sessions) && track.sessions.length >= 2);
  assert.ok(Array.isArray(track.offsiteSites) && track.offsiteSites.length >= 1);
  // New tracks match The Ridge w/ gen: onsite grid on, portable panel off
  assert.equal(track.siteChargingEnabled, false);
  assert.equal(track.gridEnabled, true);
  const site = UI.defaultProfileValues('site');
  assert.equal(site.genEnabled, true);
  assert.equal(site.batteryEnabled, true);
  assert.equal(String(site.trailerCapKwh), '24');
  // Mutating one return value must not affect the next
  car.capacityKwh = '1';
  assert.equal(String(UI.defaultProfileValues('car').capacityKwh), '99.4');
});

test('profile menus include New action', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/data-action="new"/.test(html));
  assert.ok(/>New…</.test(html) || />New\u2026</.test(html) || /New…/.test(html));
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
  assert.equal(packed.activeTrackName, 'The Ridge w/ gen');
  const parsed = UI.parseImport(JSON.stringify(packed));
  assert.equal(parsed.cars[0].values.capacityKwh, '75');
  assert.equal(parsed.tracks[0].name, 'The Ridge w/ gen');
  assert.equal(parsed.activeCarName, 'My EV');
  assert.equal(parsed.activeTrackName, 'The Ridge w/ gen');
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
    'car:Random Model 3': 'replace',
    'track:The Ridge w/ gen': 'replace',
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
      name: 'The Ridge w/ gen',
      values: Object.assign(UI.trackFieldDefaults(), { driveTimeMin: '45' }),
    },
  }], { 'track:The Ridge w/ gen': 'replace' });
  assert.equal(r.summary.replaced, 1);
  const ridge = r.state.tracks.find(p => p.name === 'The Ridge w/ gen');
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

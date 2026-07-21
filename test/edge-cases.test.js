/**
 * Edge cases for session gaps, skipped hours, offsite trips, and residual paddock charging.
 * These guard against weird SoC / mode interactions found in the track day planner.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('path');

function loadSim() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/);
  if (!m) throw new Error('engine markers not found');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx);
  return ctx.Sim;
}
function loadUI() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
  const src = html.match(/\/\/ UI_START([\s\S]*?)\/\/ UI_END/)[1];
  const ctx = { document: undefined, window: {} };
  vm.createContext(ctx);
  vm.runInContext(eng, ctx);
  vm.runInContext(src, ctx);
  return ctx.UI;
}

const Sim = loadSim();
const UI = loadUI();

function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
function pt(r, min) {
  return r.timeline.find(function (t) { return t.min === min; });
}
function modesIn(r, from, to) {
  var m = {};
  r.timeline.forEach(function (t) {
    if (t.min >= from && t.min < to) m[t.mode] = (m[t.mode] || 0) + 1;
  });
  return m;
}
function deltaPct(r, from, to, key) {
  key = key || 'carPct';
  var a = pt(r, from), b = pt(r, to);
  if (!a || !b) return null;
  return b[key] - a[key];
}
/** Build a day plan from compact rows: { t: 'HH:MM'|min, en?, after?, stop?, until?, for? } */
function plan(rows) {
  return rows.map(function (row, i) {
    var startMin = typeof row.t === 'number' ? row.t
      : (row.startMin != null ? row.startMin
        : UI.hhmmToMin(row.t || row.start || '09:00'));
    var o = { startMin: startMin, enabled: row.en !== false && row.enabled !== false };
    if (i < rows.length - 1 || row.after != null) {
      if (row.after != null) o.after = row.after;
      else if (o.enabled) o.after = 'onsite';
    }
    if (o.after === 'offsite') {
      if (row.stop) o.offsiteStop = row.stop;
      if (row.until != null) o.offsiteUntilSocPct = row.until;
      if (row.for != null) o.offsiteForMin = row.for;
    }
    return o;
  });
}
function sim(rows, over) {
  var p = Sim.defaultParams();
  for (var k in (over || {})) p[k] = over[k];
  p.sessions = plan(rows);
  return { p: p, r: Sim.simulate(p), sched: Sim.buildSchedule(p) };
}

// ─── Skipped sessions & charge modes ────────────────────────────────────────

test('skipped hour with after=onsite: charges while at track for full hour body', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', en: false, after: 'onsite' },
    { t: '11:00' },
  ], { offsiteChargingEnabled: false });
  // 10:00–10:20 is disabled body — should CHARGE (onsite), not SESSION
  var m = modesIn(x.r, 10 * 60, 10 * 60 + 20);
  assert.ok((m.CHARGE || 0) > 15, 'expected CHARGE during skipped body: ' + JSON.stringify(m));
  assert.equal(m.SESSION || 0, 0);
  // SoC rises over the skipped hour when starting mid-pack
  assert.ok(deltaPct(x.r, 10 * 60, 11 * 60 - 1) > 0.5);
});

test('skipped hour with after=none: IDLE at track, flat SoC (no cooling drain)', () => {
  var x = sim([
    { t: '09:00', after: 'none' },
    { t: '10:00', en: false, after: 'none' },
    { t: '11:00' },
  ], {
    offsiteChargingEnabled: false,
    siteChargingEnabled: true,
    // Force known mid-pack start by zeroing arrival costs
    arrivalCostNoTrailerKwh: 0, towingCostKwh: 0,
  });
  var m = modesIn(x.r, 9 * 60 + 20, 11 * 60);
  assert.ok((m.IDLE || 0) > 30, JSON.stringify(m));
  assert.equal(m.CHARGE || 0, 0);
  // Flat car SoC during pure none paddock (after first session ends)
  var d = deltaPct(x.r, 9 * 60 + 25, 10 * 60 + 50);
  assert.ok(Math.abs(d) < 0.2, 'none paddock should not drain car, delta=' + d);
});

test('no charging gap: car flat but gen still tops trailer', () => {
  // After a run that drains the trailer, a "none" gap should refill trailer from gen
  // while leaving car SoC unchanged.
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', en: false, after: 'none' },
    { t: '11:00' },
  ], {
    offsiteChargingEnabled: false,
    genEnabled: true,
    batteryEnabled: true,
    genPowerKw: 13,
    trailerCapKwh: 40,
    minTrailerSocPct: 5,
    // Drain trailer during first onsite gap so none-gap has room to refill
    sessionEnergyKwh: 40,
    arrivalCostNoTrailerKwh: 20,
    towingCostKwh: 4,
  });
  // Sample mid none-hour (10:00–11:00 skipped)
  var a = pt(x.r, 10 * 60 + 5);
  var b = pt(x.r, 10 * 60 + 55);
  assert.ok(a && b, 'timeline points');
  assert.equal(a.mode, 'IDLE');
  assert.equal(b.mode, 'IDLE');
  assert.ok(Math.abs(b.carPct - a.carPct) < 0.5, 'car flat during none, d=' + (b.carPct - a.carPct));
  assert.ok(b.trlPct > a.trlPct + 1, 'trailer should rise on gen while car idle, ' +
    a.trlPct.toFixed(1) + ' -> ' + b.trlPct.toFixed(1));
});

test('skipped hour inherits after when not set (buildSchedule)', () => {
  var p = Sim.defaultParams();
  p.sessions = [
    { startMin: 9 * 60, enabled: true, after: 'offsite', offsiteStop: 'next' },
    { startMin: 10 * 60, enabled: false }, // no after — inherit
    { startMin: 11 * 60, enabled: true },
  ];
  var sched = Sim.buildSchedule(p);
  assert.equal(sched[1].enabled, false);
  assert.equal(sched[1].after, 'offsite');
  assert.equal(sched[1].before, 'offsite');
  assert.equal(sched[2].before, 'offsite');
});

test('two consecutive skips: after modes chain for next enabled before', () => {
  var p = Sim.defaultParams();
  p.sessions = [
    { startMin: 9 * 60, enabled: true, after: 'onsite' },
    { startMin: 10 * 60, enabled: false, after: 'none' },
    { startMin: 11 * 60, enabled: false, after: 'onsite' },
    { startMin: 13 * 60, enabled: true },
  ];
  var sched = Sim.buildSchedule(p);
  assert.equal(sched[1].after, 'none');
  assert.equal(sched[2].after, 'onsite');
  assert.equal(sched[3].before, 'onsite');
});

// ─── Offsite trips + skipped destinations ───────────────────────────────────

test('offsite until-next targets next enabled (skip expands SC window)', () => {
  // Drive 30 min → with dest 13:00 leave SC @ 12:30 → 40 min charge
  // With 13 disabled, dest 14:00 leave @ 13:30 → ~100 min charge
  var with13 = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'next' },
    { t: '13:00', after: 'onsite' },
    { t: '14:00' },
  ]);
  var skip13 = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'next' },
    { t: '13:00', en: false, after: 'onsite' },
    { t: '14:00' },
  ]);
  var sc1 = with13.r.metrics.trips[0].scDurationMin;
  var sc2 = skip13.r.metrics.trips[0].scDurationMin;
  assert.ok(sc1 > 0 && sc2 > 0);
  assert.ok(sc2 > sc1 + 20, 'skipping next should lengthen offsite charge: ' + sc1 + ' vs ' + sc2);
  assert.equal(with13.r.metrics.trips[0].sessionIndex, 4); // 13:00 is index 4
  assert.equal(skip13.r.metrics.trips[0].sessionIndex, 5); // 14:00
});

test('offsite until-next with 30 min drive → 40 min SC when next is one hour later', () => {
  var x = sim([
    { t: '11:00', after: 'offsite', stop: 'next' },
    { t: '13:00' },
  ], { driveTimeMin: 30, driveConsumptionKwh: 13 });
  // Depart 11:20, arrive SC 11:50, leave 12:30, SC = 40
  var t = x.r.metrics.trips[0];
  assert.ok(t);
  assert.ok(near(t.scDurationMin, 40, 2), 'scDurationMin=' + t.scDurationMin);
  assert.ok(t.returnMin <= 13 * 60);
});

test('offsite after last enabled session: no trip (nowhere to return for)', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'offsite', stop: 'until', until: 80 },
  ]);
  assert.ok(!x.r.metrics.trips || x.r.metrics.trips.length === 0);
  assert.equal(x.r.metrics.sc, null);
});

test('offsite for-min dwell ends near requested minutes', () => {
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'for', for: 20 },
    { t: '14:00' },
  ]);
  var t = x.r.metrics.trips[0];
  assert.ok(t);
  assert.ok(near(t.scDurationMin, 20, 2), 'scDurationMin=' + t.scDurationMin);
});

test('offsite until-SoC reaches target before returning', () => {
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'until', until: 50 },
    { t: '16:00' },
  ]);
  var t = x.r.metrics.trips[0];
  assert.ok(t);
  var endSc = pt(x.r, t.scEndMin - 1);
  assert.ok(endSc.carPct >= 49, 'end SC SoC=' + endSc.carPct);
});

// ─── Residual paddock after offsite return ──────────────────────────────────

test('residual after return charges onsite even when skipped hour is none', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '13:00', en: false, after: 'none' },
    { t: '14:00', after: 'onsite' },
    { t: '15:00' },
  ]);
  var trip = x.r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  assert.ok(trip.returnMin < 14 * 60, 'return before 2pm');
  var a = pt(x.r, trip.returnMin);
  var b = pt(x.r, 14 * 60 - 1);
  assert.equal(a.mode, 'CHARGE');
  assert.equal(b.mode, 'CHARGE');
  assert.ok(b.carPct > a.carPct + 1, 'car should charge after return');
  // Trailer should discharge (or stay if already at floor) — not silently stuck mid-pack with flat car
  assert.ok(b.trlPct <= a.trlPct + 0.5 || b.carPct > 99, 'trailer drains or car full');
});

test('residual after return does not charge when site charging fully off', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 90 },
    { t: '13:00', en: false, after: 'none' },
    { t: '14:00' },
  ], {
    siteChargingEnabled: false,
    gridEnabled: false,
    genEnabled: false,
    batteryEnabled: false,
  });
  var trip = x.r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  var m = modesIn(x.r, trip.returnMin, 14 * 60);
  assert.equal(m.CHARGE || 0, 0, JSON.stringify(m));
  assert.ok((m.IDLE || 0) > 0);
  var d = deltaPct(x.r, trip.returnMin, 14 * 60 - 1);
  assert.ok(Math.abs(d) < 0.5, 'flat when no site power, delta=' + d);
});

test('residual charges with grid-only onsite (no portable)', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 80 },
    { t: '13:00', en: false, after: 'none' },
    { t: '14:00' },
  ], {
    gridEnabled: true,
    gridPowerKw: 40,
    siteChargingEnabled: false, // portable off; onsite grid still works
    genEnabled: true,
    batteryEnabled: true,
  });
  assert.equal(Sim.siteSources(x.p).grid, true);
  assert.equal(Sim.siteSources(x.p).gen, false);
  var trip = x.r.metrics.trips[0];
  assert.ok(trip);
  var a = pt(x.r, trip.returnMin);
  var b = pt(x.r, 14 * 60 - 1);
  assert.equal(a.mode, 'CHARGE');
  assert.ok(b.carPct > a.carPct + 0.5);
  assert.ok(x.r.metrics.fromGridKwh > 0.5);
});

test('multiple skips after offsite: residual until first enabled', () => {
  var x = sim([
    { t: '11:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '12:00', en: false, after: 'none' },
    { t: '13:00', en: false, after: 'none' },
    { t: '15:00' },
  ]);
  var trip = x.r.metrics.trips[0];
  assert.ok(trip);
  assert.equal(trip.sessionIndex, 4); // 15:00
  // Charge from return through 15:00
  var m = modesIn(x.r, trip.returnMin, 15 * 60);
  assert.ok((m.CHARGE || 0) > 10, JSON.stringify(m));
  assert.ok(pt(x.r, 15 * 60 - 1).mode === 'CHARGE' || pt(x.r, 15 * 60 - 1).mode === 'SESSION');
});

test('skipped hour after=offsite launches a real second trip (drive+SC), not silent onsite', () => {
  // Illogical plan: offsite after 11, skip 13 also set to offsite, then 14 enabled.
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '13:00', en: false, after: 'offsite', stop: 'next' },
    { t: '14:00', after: 'onsite' },
    { t: '15:00' },
  ], { driveTimeMin: 30, driveConsumptionKwh: 13 });
  assert.ok(x.r.metrics.trips && x.r.metrics.trips.length >= 2,
    'expected 2 offsite trips, got ' + (x.r.metrics.trips && x.r.metrics.trips.length));
  var t1 = x.r.metrics.trips[0];
  var t2 = x.r.metrics.trips[1];
  assert.equal(t1.originIndex, 3); // 11:00 is index 3
  assert.equal(t2.originIndex, 4); // 13:00 skipped is index 4
  // Second trip must include drive legs (not pure CHARGE at track)
  assert.ok(t2.departMin != null && t2.scStartMin != null);
  assert.ok(t2.scStartMin >= t2.departMin + 25, 'drive out ~30 min before SC');
  // While on second trip, no CHARGE mode at track
  if (t2.returnMin != null) {
    var m = modesIn(x.r, t2.departMin, t2.returnMin);
    assert.ok((m.DRIVE || 0) > 20, JSON.stringify(m));
    assert.ok((m.SC || 0) >= 0);
  }
  // Supercharger energy should reflect at least one substantial SC stop
  assert.ok(x.r.metrics.fromSuperchargerKwh > 20);
});

test('two offsite trips: first residual does not replace second trip with portable charge', () => {
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'for', for: 15 },
    { t: '11:00', en: false, after: 'offsite', stop: 'for', for: 15 },
    { t: '14:00' },
  ], { driveTimeMin: 20, driveConsumptionKwh: 8 });
  assert.ok(x.r.metrics.trips.length >= 2);
  var t2 = x.r.metrics.trips[1];
  // Second departure should be around the skipped hour (11:00), not free onsite fill
  assert.ok(t2.departMin >= 11 * 60 - 1, 'departMin=' + t2.departMin);
  assert.ok(t2.scStartMin > t2.departMin);
});

// ─── Missed sessions (away offsite during an enabled run) ───────────────────

test('enabled session during offsite trip is missed (not SESSION minutes)', () => {
  // Short gap: depart after 9, must return for 10 — still away part of morning
  // Longer: offsite after 9 until 100% may miss 11 if still away
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'onsite' },
    { t: '13:00' },
  ], { driveTimeMin: 30 });
  var trip = x.r.metrics.trips[0];
  assert.ok(trip);
  // 10:00 session starts while potentially away
  if (trip.returnMin > 10 * 60) {
    assert.ok(x.r.metrics.skippedSessions.some(function (s) { return s.startMin === 10 * 60; })
      || x.r.metrics.sessionsRun < 3);
  }
  // Every SESSION minute belongs to an enabled session the car attended
  x.r.timeline.forEach(function (t) {
    if (t.mode !== 'SESSION') return;
    assert.ok(t.min < trip.departMin || t.min >= trip.returnMin,
      'SESSION while on trip at t=' + t.min);
  });
});

// ─── Site / portable exclusivity in engine params ───────────────────────────

test('readParams: grid on forces portable off for sources', () => {
  var values = {};
  UI.UI_FIELDS.forEach(function (f) {
    values[f.id] = f.kind === 'check' ? !!f.default : String(f.default);
  });
  values.sessions = UI.defaultSessionsForm();
  values.gridEnabled = true;
  values.siteChargingEnabled = true;
  values.genEnabled = true;
  values.batteryEnabled = true;
  var p = UI.readParams(values);
  assert.equal(p.gridEnabled, true);
  assert.equal(p.siteChargingEnabled, false);
  var src = Sim.siteSources(p);
  assert.equal(src.grid, true);
  assert.equal(src.gen, false);
  assert.equal(src.battery, false);
});

test('siteCanCharge false when none of onsite/portable active', () => {
  assert.equal(Sim.siteCanCharge({
    gridEnabled: false, siteChargingEnabled: false, genEnabled: true, batteryEnabled: true,
  }), false);
  assert.equal(Sim.siteCanCharge({
    gridEnabled: false, siteChargingEnabled: true, genEnabled: false, batteryEnabled: false,
  }), false);
  assert.equal(Sim.siteCanCharge({
    gridEnabled: true, siteChargingEnabled: false,
  }), true);
});

// ─── Effective gap modes ────────────────────────────────────────────────────

test('effectiveGapMode coerces onsite→none when site cannot charge', () => {
  var p = { siteChargingEnabled: false, gridEnabled: false, offsiteChargingEnabled: true };
  assert.equal(Sim.effectiveGapMode('onsite', p), 'none');
  assert.equal(Sim.effectiveGapMode('offsite', p), 'offsite');
  assert.equal(Sim.effectiveGapMode('none', p), 'none');
});

test('effectiveGapMode coerces offsite→none when offsite disabled', () => {
  var p = { siteChargingEnabled: true, genEnabled: true, batteryEnabled: true,
    offsiteChargingEnabled: false };
  assert.equal(Sim.effectiveGapMode('offsite', p), 'none');
  assert.equal(Sim.effectiveGapMode('onsite', p), 'onsite');
});

// ─── Form / engine round-trip edge cases ────────────────────────────────────

test('normalizeSessionsForm keeps after on disabled non-last rows', () => {
  var n = UI.normalizeSessionsForm([
    { start: '09:00', after: 'offsite', offsiteStop: 'until', offsiteUntilSocPct: 100 },
    { start: '13:00', enabled: false, after: 'none' },
    { start: '14:00', after: 'onsite' },
    { start: '16:00' },
  ]);
  assert.equal(n[1].enabled, false);
  assert.equal(n[1].after, 'none');
  assert.equal(n[2].after, 'onsite');
  var eng = UI.sessionsToEngine(n);
  assert.equal(eng[1].enabled, false);
  assert.equal(eng[1].after, 'none');
});

test('sessionsToEngine round-trip: disabled after=onsite survives', () => {
  var form = [
    { start: '09:00', enabled: true, after: 'offsite', offsiteStop: 'next',
      offsiteUntilSocPct: 80, offsiteForMin: 30 },
    { start: '10:00', enabled: false, after: 'onsite' },
    { start: '11:00', enabled: true },
  ];
  var eng = UI.sessionsToEngine(form);
  var back = UI.normalizeSessionsForm(eng.map(function (s) {
    return {
      start: UI.minToHHMM(s.startMin),
      enabled: s.enabled,
      after: s.after,
      offsiteStop: s.offsiteStop,
      offsiteUntilSocPct: s.offsiteUntilSocPct,
      offsiteForMin: s.offsiteForMin,
    };
  }));
  assert.equal(back[1].enabled, false);
  assert.equal(back[1].after, 'onsite');
});

// ─── Timeline integrity ─────────────────────────────────────────────────────

test('timeline is contiguous minute-by-minute from arrival', () => {
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'until', until: 90 },
    { t: '13:00', en: false, after: 'onsite' },
    { t: '14:00' },
  ]);
  var tl = x.r.timeline;
  assert.ok(tl.length > 100);
  assert.equal(tl[0].min, x.p.arrivalTimeMin);
  for (var i = 1; i < tl.length; i++) {
    assert.equal(tl[i].min, tl[i - 1].min + 1, 'gap at i=' + i);
  }
});

test('no NaN in timeline or metrics for messy plan', () => {
  var x = sim([
    { t: '08:30', after: 'none' },
    { t: '09:00', en: false, after: 'none' },
    { t: '10:00', after: 'offsite', stop: 'for', for: 5 },
    { t: '11:00', en: false, after: 'onsite' },
    { t: '12:00', after: 'offsite', stop: 'until', until: 60 },
    { t: '15:00', en: false, after: 'none' },
    { t: '16:00' },
  ], { driveTimeMin: 15, driveConsumptionKwh: 7 });
  x.r.timeline.forEach(function (t, i) {
    assert.ok(isFinite(t.carPct), 'carPct NaN at ' + i);
    assert.ok(isFinite(t.trlPct), 'trlPct NaN at ' + i);
  });
  var m = x.r.metrics;
  assert.ok(isFinite(m.minSocPct));
  assert.ok(isFinite(m.endSocPct));
  assert.ok(isFinite(m.fromTrailerKwh));
  assert.ok(isFinite(m.fromSuperchargerKwh));
});

test('late return after offsite marks enabled session as missed (no SESSION minutes)', () => {
  // Second offsite until 100% leaves after 1pm skip; returns after 2pm session window
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '13:00', en: false, after: 'offsite', stop: 'until', until: 100 },
    { t: '14:00', after: 'onsite' },
    { t: '15:00', after: 'onsite' },
    { t: '16:00' },
  ], { driveTimeMin: 30, driveConsumptionKwh: 13 });
  assert.ok(x.r.metrics.trips.length >= 2);
  var t2 = x.r.metrics.trips[1];
  assert.ok(t2.returnMin > 14 * 60 + 20, 'return after 2pm session ends, got ' + t2.returnMin);
  var miss14 = x.r.metrics.skippedSessions.some(function (s) { return s.startMin === 14 * 60; });
  assert.ok(miss14, '2pm must be in skippedSessions: ' + JSON.stringify(x.r.metrics.skippedSessions));
  var sess14 = x.r.timeline.filter(function (t) {
    return t.min >= 14 * 60 && t.min < 14 * 60 + 20 && t.mode === 'SESSION';
  }).length;
  assert.equal(sess14, 0, 'no SESSION minutes during 2pm while away');
});

test('setSocCell preserves finder class so missed can overwrite prior SoC HTML', () => {
  // Regression: class became only "soc-range …", losing sess-soc-post → missed never painted
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/baseCls \? baseCls \+ ' ' : ''/.test(html) || /baseCls \+ ' soc-range'/.test(html) ||
    /className = \(baseCls/.test(html) && /soc-range/.test(html));
  // Source must keep baseCls when assigning range className
  const m = html.match(/range\.className = ([^;]+);/);
  assert.ok(m, 'range.className assignment');
  assert.ok(/baseCls/.test(m[1]), 'range.className must include baseCls, got: ' + m[1]);
});

test('SESSION minutes only occur for enabled sessions when car is present', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', en: false, after: 'onsite' },
    { t: '11:00', after: 'onsite' },
  ], { offsiteChargingEnabled: false });
  var sessionStarts = {};
  x.r.timeline.forEach(function (t) {
    if (t.mode !== 'SESSION') return;
    // map to hour slot
    var hour = Math.floor(t.min / 60) * 60;
    sessionStarts[hour] = (sessionStarts[hour] || 0) + 1;
  });
  assert.ok(sessionStarts[9 * 60] > 0);
  assert.ok(!sessionStarts[10 * 60], 'no SESSION during skipped 10:00');
  assert.ok(sessionStarts[11 * 60] > 0);
});

// ─── Trailing EOD charge ────────────────────────────────────────────────────

test('trailing hour after last session charges onsite when site available', () => {
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00' },
  ], { offsiteChargingEnabled: false });
  var lastEnd = 10 * 60 + 20;
  var m = modesIn(x.r, lastEnd, lastEnd + 60);
  assert.ok((m.CHARGE || 0) > 30, JSON.stringify(m));
});

test('trailing hour idle when no site charging', () => {
  var x = sim([
    { t: '09:00', after: 'none' },
    { t: '10:00' },
  ], {
    siteChargingEnabled: false, gridEnabled: false,
    offsiteChargingEnabled: false,
  });
  var lastEnd = 10 * 60 + 20;
  var m = modesIn(x.r, lastEnd, lastEnd + 60);
  assert.equal(m.CHARGE || 0, 0);
  assert.ok((m.IDLE || 0) > 30);
});

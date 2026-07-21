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

test('residualMode none: idle after return (no paddock charge)', () => {
  var p = Sim.defaultParams();
  p.sessions = [
    { startMin: 9 * 60, enabled: true, after: 'offsite', offsiteStop: 'for', offsiteForMin: 10,
      residualMode: 'none' },
    { startMin: 13 * 60, enabled: true },
  ];
  p.driveTimeMin = 20;
  p.driveConsumptionKwh = 8;
  var r = Sim.simulate(p);
  var trip = r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  // After return until next session: IDLE not CHARGE
  var m = modesIn(r, trip.returnMin, 13 * 60);
  assert.equal(m.CHARGE || 0, 0, JSON.stringify(m));
  assert.ok((m.IDLE || 0) > 5, JSON.stringify(m));
  var d = deltaPct(r, trip.returnMin, 13 * 60 - 1);
  assert.ok(Math.abs(d) < 0.5, 'flat when residual none, delta=' + d);
});

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

test('long offsite: skipped 1pm hour has no CHARGE while still at SC or driving back', () => {
  // Drive 90 min each way; SC until 100%; 13:00 skipped with after=onsite is impossible to honor
  // while away — engine must stay DRIVE/SC, not pretend onsite charge.
  var x = sim([
    { t: '09:00', after: 'onsite' },
    { t: '10:00', after: 'onsite' },
    { t: '11:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '13:00', en: false, after: 'onsite' },
    { t: '14:00', after: 'onsite' },
    { t: '15:00', after: 'onsite' },
    { t: '16:00' },
  ], { driveTimeMin: 90, driveConsumptionKwh: 30 });
  var trip = x.r.metrics.trips[0];
  assert.ok(trip);
  assert.ok(trip.scEndMin >= 13 * 60, 'SC still running into 1pm hour, scEnd=' + trip.scEndMin);
  assert.ok(trip.returnMin > 14 * 60, 'return after 2pm, return=' + trip.returnMin);
  var m = modesIn(x.r, 13 * 60, 14 * 60);
  assert.equal(m.CHARGE || 0, 0, 'no onsite CHARGE during 1pm while away: ' + JSON.stringify(m));
  assert.ok((m.SC || 0) + (m.DRIVE || 0) > 50, JSON.stringify(m));
});

test('late return after offsite marks enabled session as fully missed (0 SESSION min)', () => {
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
  assert.equal(x.r.metrics.sessionRunMinutes[5] || 0, 0);
  var sess14 = x.r.timeline.filter(function (t) {
    return t.min >= 14 * 60 && t.min < 14 * 60 + 20 && t.mode === 'SESSION';
  }).length;
  assert.equal(sess14, 0, 'no SESSION minutes during 2pm while away');
});

test('return mid-session: partial SESSION minutes and prorated energy rate', () => {
  // 9:20 leave, 50 min drive → SC 10:10, 5 min SC → leave 10:15, 50 min back → return 11:05
  // into the 11:00–11:20 session (15 of 20 minutes)
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'for', for: 5 },
    { t: '11:00', after: 'onsite' },
    { t: '13:00' },
  ], {
    driveTimeMin: 50, driveConsumptionKwh: 20,
    sessionDurationMin: 20, sessionEnergyKwh: 40,
  });
  var trip = x.r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  var ret = trip.returnMin;
  var sessStart = 11 * 60, sessEnd = 11 * 60 + 20;
  assert.ok(ret > sessStart && ret < sessEnd, 'return mid-session, ret=' + ret);
  var mins = x.r.metrics.sessionRunMinutes[2] || 0;
  assert.equal(mins, 15);
  assert.ok(x.r.metrics.partialSessions.some(function (ps) {
    return ps.startMin === sessStart && ps.minutesRun === 15 && near(ps.energyKwh, 30, 1e-9);
  }));
  var carAtStart = pt(x.r, ret);
  var carAtEnd = pt(x.r, sessEnd - 1);
  var dKwh = (carAtStart.carPct - carAtEnd.carPct) / 100 * x.p.capacityKwh;
  assert.ok(near(dKwh, 30, 3), 'prorated energy ~30 got ' + dKwh);
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

// ─── DaySM: activity priority + trip transitions ────────────────────────────

test('DaySM is exported with phases, modes, and helpers', () => {
  assert.ok(Sim.DaySM);
  assert.deepEqual(Sim.DaySM.PHASES, ['idle', 'out', 'sc', 'back']);
  assert.ok(Sim.DaySM.MODES.indexOf('SESSION') >= 0);
  assert.ok(Sim.DaySM.MODES.indexOf('DRIVE') >= 0);
  assert.ok(typeof Sim.DaySM.resolveActivityState === 'function');
  assert.ok(typeof Sim.DaySM.canTransitionTrip === 'function');
});

test('DaySM trip transitions: only idle→out→sc→back→idle', () => {
  var D = Sim.DaySM;
  assert.equal(D.canTransitionTrip('idle', 'out'), true);
  assert.equal(D.canTransitionTrip('out', 'sc'), true);
  assert.equal(D.canTransitionTrip('sc', 'back'), true);
  assert.equal(D.canTransitionTrip('back', 'idle'), true);
  // Illegal jumps
  assert.equal(D.canTransitionTrip('idle', 'sc'), false);
  assert.equal(D.canTransitionTrip('idle', 'back'), false);
  assert.equal(D.canTransitionTrip('out', 'idle'), false);
  assert.equal(D.canTransitionTrip('out', 'back'), false);
  assert.equal(D.canTransitionTrip('sc', 'out'), false);
  assert.equal(D.canTransitionTrip('back', 'sc'), false);
  // Stay in phase allowed
  assert.equal(D.canTransitionTrip('out', 'out'), true);
  assert.equal(D.canTransitionTrip('sc', 'sc'), true);
});

test('DaySM modeFromTripPhase maps out/back→DRIVE, sc→SC, idle→null', () => {
  var D = Sim.DaySM;
  assert.equal(D.modeFromTripPhase('out'), 'DRIVE');
  assert.equal(D.modeFromTripPhase('back'), 'DRIVE');
  assert.equal(D.modeFromTripPhase('sc'), 'SC');
  assert.equal(D.modeFromTripPhase('idle'), null);
});

test('DaySM resolveActivityState: SESSION beats residual and gap', () => {
  var D = Sim.DaySM;
  assert.equal(D.resolveActivityState({
    inSession: true, residualActive: true, canCharge: true, gapMode: 'none',
  }), 'SESSION');
});

test('DaySM resolveActivityState: residual CHARGE even when gap is none', () => {
  var D = Sim.DaySM;
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: true, canCharge: true, gapMode: 'none',
  }), 'CHARGE');
  // Without site power residual cannot invent CHARGE
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: true, canCharge: false, gapMode: 'none',
  }), 'IDLE');
});

test('DaySM resolveActivityState: offsite gap at track → CHARGE if site can, else IDLE', () => {
  var D = Sim.DaySM;
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: false, canCharge: true, gapMode: 'offsite',
  }), 'CHARGE');
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: false, canCharge: false, gapMode: 'offsite',
  }), 'IDLE');
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: false, canCharge: true, gapMode: 'onsite',
  }), 'CHARGE');
  assert.equal(D.resolveActivityState({
    inSession: false, residualActive: false, canCharge: true, gapMode: 'none',
  }), 'IDLE');
});

test('DaySM residualUntilAfterReturn caps at next enabled and next offsite leave', () => {
  var D = Sim.DaySM;
  var sessions = [
    { enabled: false, startMin: 13 * 60 },
    { enabled: true, startMin: 14 * 60 },
    { enabled: true, startMin: 15 * 60 },
  ];
  // Return 12:30 → residual until 14:00 (first enabled ≥ return)
  assert.equal(D.residualUntilAfterReturn(12 * 60 + 30, sessions, 15 * 60 + 20, null), 14 * 60);
  // Next offsite leave at 13:00 caps residual
  assert.equal(D.residualUntilAfterReturn(12 * 60 + 30, sessions, 15 * 60 + 20, 13 * 60), 13 * 60);
  // Next leave already passed → residual ends immediately
  assert.equal(D.residualUntilAfterReturn(13 * 60 + 5, sessions, 15 * 60 + 20, 13 * 60), 13 * 60 + 5);
});

test('DaySM scDone: for-min, until-SoC, and until-next leaveBy', () => {
  var D = Sim.DaySM;
  // for 20 min dwell
  assert.equal(D.scDone({
    t: 100, scStartMin: 90, eCar: 50, cap: 100,
    stopMode: 'for', forMin: 20, driveTimeMin: 30, endMin: 1000,
  }).done, false); // 11 min into SC
  assert.equal(D.scDone({
    t: 109, scStartMin: 90, eCar: 50, cap: 100,
    stopMode: 'for', forMin: 20, driveTimeMin: 30, endMin: 1000,
  }).done, true); // 20 min complete at t+1

  // until SoC 80%
  assert.equal(D.scDone({
    t: 100, scStartMin: 90, eCar: 70, cap: 100,
    stopMode: 'until', untilSocPct: 80, driveTimeMin: 30, endMin: 1000,
  }).done, false);
  assert.equal(D.scDone({
    t: 100, scStartMin: 90, eCar: 80, cap: 100,
    stopMode: 'until', untilSocPct: 80, driveTimeMin: 30, endMin: 1000,
  }).done, true);

  // until next: leave by mustReturnBy - driveTime
  // mustReturnBy 600, drive 30 → leaveBy 570; at t=569 → t+1=570 done
  assert.equal(D.scDone({
    t: 568, scStartMin: 500, eCar: 40, cap: 100,
    stopMode: 'next', mustReturnBy: 600, driveTimeMin: 30, endMin: 1000,
  }).done, false);
  assert.equal(D.scDone({
    t: 569, scStartMin: 500, eCar: 40, cap: 100,
    stopMode: 'next', mustReturnBy: 600, driveTimeMin: 30, endMin: 1000,
  }).done, true);
});

test('DaySM tryStartTrip only from idle when queue ready', () => {
  var D = Sim.DaySM;
  var trip = { phase: 'idle', residualUntilMin: 999 };
  var q = [{ gapStart: 100, sessionIndex: 2, originIndex: 1 }];
  assert.equal(D.tryStartTrip(trip, q, 50, 30), false); // too early
  assert.equal(trip.phase, 'idle');
  assert.equal(D.tryStartTrip(trip, q, 100, 30), true);
  assert.equal(trip.phase, 'out');
  assert.equal(trip.driveEndMin, 130);
  assert.equal(trip.residualUntilMin, null);
  assert.equal(q.length, 0);
  // already on trip
  assert.equal(D.tryStartTrip(trip, [{ gapStart: 0 }], 200, 30), false);
});

test('simulate never emits CHARGE/SESSION while trip phase is away (timeline modes)', () => {
  var x = sim([
    { t: '09:00', after: 'offsite', stop: 'until', until: 100 },
    { t: '13:00', en: false, after: 'onsite' },
    { t: '14:00' },
  ], { driveTimeMin: 40, driveConsumptionKwh: 15 });
  var trip = x.r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  x.r.timeline.forEach(function (pt) {
    if (pt.min >= trip.departMin && pt.min < trip.returnMin) {
      assert.ok(pt.mode === 'DRIVE' || pt.mode === 'SC',
        'while away mode=' + pt.mode + ' at ' + pt.min);
    }
  });
});

// ─── UI trip window layout (DOM row order) ──────────────────────────────────

test('layoutTripWindowSegments: drive-back then residual never puts charge above back', () => {
  // Reproduce dump "Track Charging Simulator 8": return 2:24 under the 2pm skip window.
  // DOM order is Drive out → Charge → Drive back → Wait. Residual after a same-window
  // drive-back must use waitSeg only (not chargePadSeg), so 2:24 charge is not above 2:00 back.
  var trip = {
    departMin: 11 * 60 + 20,
    scStartMin: 12 * 60 + 20,
    scEndMin: 13 * 60 + 24,
    returnMin: 14 * 60 + 24,
    residualUntilMin: 15 * 60,
  };
  var winStart = 14 * 60, winEnd = 15 * 60; // 2pm skipped hour
  var segs = UI.layoutTripWindowSegments(trip, winStart, winEnd, { driveTimeMin: 60 });
  assert.equal(segs.scSeg, null);
  assert.equal(segs.chargePadSeg, null, 'must not put residual on charge row above drive-back');
  assert.ok(segs.backSeg, 'drive back continues into 2pm window');
  assert.equal(segs.backSeg.a, 14 * 60);
  assert.equal(segs.backSeg.b, 14 * 60 + 24);
  assert.ok(segs.waitSeg, 'residual after return on wait row');
  assert.equal(segs.waitSeg.a, 14 * 60 + 24);
  assert.equal(segs.waitSeg.b, 15 * 60);
  // Chronological: back starts before wait
  assert.ok(segs.backSeg.a < segs.waitSeg.a);
});

test('layoutTripWindowSegments: residual-only window uses charge row (no drive-back)', () => {
  var trip = {
    departMin: 11 * 60 + 20,
    scStartMin: 12 * 60,
    scEndMin: 12 * 60 + 30,
    returnMin: 13 * 60, // back by 1pm
    residualUntilMin: 15 * 60,
  };
  // 2pm window: only residual left
  var segs = UI.layoutTripWindowSegments(trip, 14 * 60, 15 * 60, { driveTimeMin: 30 });
  assert.equal(segs.backSeg, null);
  assert.equal(segs.waitSeg, null);
  assert.ok(segs.chargePadSeg);
  assert.equal(segs.chargePadSeg.a, 14 * 60);
  assert.equal(segs.chargePadSeg.b, 15 * 60);
});

test('layoutTripWindowSegments: SC then drive-back order (1pm skip mid-return)', () => {
  var trip = {
    departMin: 11 * 60 + 20,
    scStartMin: 12 * 60 + 20,
    scEndMin: 13 * 60 + 24,
    returnMin: 14 * 60 + 24,
    residualUntilMin: 15 * 60,
  };
  var segs = UI.layoutTripWindowSegments(trip, 13 * 60, 14 * 60, { driveTimeMin: 60 });
  assert.ok(segs.scSeg);
  assert.equal(segs.scSeg.a, 13 * 60);
  assert.equal(segs.scSeg.b, 13 * 60 + 24);
  assert.ok(segs.backSeg);
  assert.equal(segs.backSeg.a, 13 * 60 + 24);
  assert.equal(segs.backSeg.b, 14 * 60);
  assert.equal(segs.chargePadSeg, null);
  assert.equal(segs.waitSeg, null); // return after this window
  assert.ok(segs.scSeg.a < segs.backSeg.a);
});

test('clampPercentTyping strips trailing digits above 100; allows 99.9', () => {
  assert.equal(UI.clampPercentTyping('99', 100), '99');
  assert.equal(UI.clampPercentTyping('999', 100), '99');
  assert.equal(UI.clampPercentTyping('99.9', 100), '99.9');
  assert.equal(UI.clampPercentTyping('100', 100), '100');
  // 100.1 → strip last digit → "100." (still a valid incomplete ≤100)
  assert.equal(UI.clampPercentTyping('100.1', 100), '100.');
  assert.equal(UI.clampPercentTyping('100.', 100), '100.');
  assert.equal(UI.clampPercentTyping('150', 100), '15');
  assert.equal(UI.clampPercentTyping('', 100), '');
  assert.equal(UI.clampPercentTyping('80', 100), '80');
  // typing 9 after 100 → strip back to 100
  assert.equal(UI.clampPercentTyping('1009', 100), '100');
  // 99 then 9 → stay at 99
  assert.equal(UI.clampPercentTyping('999', 100), '99');
});

test('clampNumericTyping blocks negatives and caps at max', () => {
  assert.equal(UI.clampNumericTyping('-5', { min: 0, max: 100 }), '5');
  assert.equal(UI.clampNumericTyping('-', { min: 0 }), '');
  assert.equal(UI.clampNumericTyping('40', { min: 0, max: 35 }), '4'); // strip last digit
  assert.equal(UI.clampNumericTyping('35', { min: 0, max: 99.4 }), '35');
  assert.equal(UI.clampNumericTyping('99.4', { min: 0, max: 99.4 }), '99.4');
  assert.equal(UI.clampNumericTyping('99.5', { min: 0, max: 99.4 }), '99.');
  assert.equal(UI.clampNumericTyping('250', { min: 1, max: 250 }), '250');
  assert.equal(UI.clampNumericTyping('251', { min: 1, max: 250 }), '25');
  assert.equal(UI.clampNumericTyping('', { min: 0, max: 50 }), '');
});

test('continueActivityLabel prefixes Continue when activity started earlier', () => {
  assert.equal(UI.continueActivityLabel('Drive back', 13 * 60 + 24, 14 * 60),
    'Continue drive back');
  assert.equal(UI.continueActivityLabel('Charge offsite', 12 * 60 + 20, 13 * 60),
    'Continue charge offsite');
  assert.equal(UI.continueActivityLabel('Charge onsite', 14 * 60 + 24, 15 * 60),
    'Continue charge onsite');
  assert.equal(UI.continueActivityLabel('Drive to Tumwater', 11 * 60 + 20, 12 * 60),
    'Continue drive to Tumwater');
  // First appearance in this window — no prefix
  assert.equal(UI.continueActivityLabel('Drive back', 14 * 60, 14 * 60), 'Drive back');
  assert.equal(UI.continueActivityLabel('Charge offsite', 13 * 60, 13 * 60), 'Charge offsite');
  assert.equal(UI.continueActivityLabel('Drive back', 14 * 60 + 10, 14 * 60), 'Drive back');
});

test('layoutFullTripSegments keeps full drive/SC/back without window splits', () => {
  var trip = {
    departMin: 11 * 60 + 20,
    scStartMin: 12 * 60 + 20,
    scEndMin: 13 * 60 + 24,
    returnMin: 14 * 60 + 24,
    residualUntilMin: 15 * 60,
  };
  var segs = UI.layoutFullTripSegments(trip, { driveTimeMin: 60 });
  assert.deepEqual(segs.outSeg, { a: 11 * 60 + 20, b: 12 * 60 + 20 });
  assert.deepEqual(segs.scSeg, { a: 12 * 60 + 20, b: 13 * 60 + 24 });
  assert.deepEqual(segs.backSeg, { a: 13 * 60 + 24, b: 14 * 60 + 24 });
  assert.deepEqual(segs.waitSeg, { a: 14 * 60 + 24, b: 15 * 60 });
  assert.equal(segs.chargePadSeg, null);
});

test('sessionDisplayOrder moves away-missed skips after trip origin', () => {
  // 9,10 enabled; 11 origin offsite; 13,14 disabled during trip; 15 enabled
  var sched = [
    { index: 1, startMin: 9 * 60, enabled: true },
    { index: 2, startMin: 10 * 60, enabled: true },
    { index: 3, startMin: 11 * 60, enabled: true },
    { index: 4, startMin: 13 * 60, enabled: false },
    { index: 5, startMin: 14 * 60, enabled: false },
    { index: 6, startMin: 15 * 60, enabled: true },
  ];
  var trips = [{
    originIndex: 3,
    departMin: 11 * 60 + 20,
    returnMin: 14 * 60 + 24,
  }];
  assert.equal(UI.isAwayMissedSession(sched[3], trips), true);
  assert.equal(UI.isAwayMissedSession(sched[4], trips), true);
  assert.equal(UI.isAwayMissedSession(sched[2], trips), false);
  var order = UI.sessionDisplayOrder(sched, trips);
  // 0,1,2 (9/10/11) then missed 13+14 (idx 3,4) then 15 (idx 5)
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  // Chronological would also be that — use return before 14 so 14 is missed but
  // 15 stays after; move 13+14 after origin even if a later enabled is between them
  // in time… already after origin. Force 15 between in schedule with early return:
  trips[0].returnMin = 13 * 60 + 30; // back mid-1pm hour
  // 14:00 still after return → not away-missed; 13:00 is away-missed
  assert.equal(UI.isAwayMissedSession(sched[3], trips), true); // 13:00
  assert.equal(UI.isAwayMissedSession(sched[4], trips), false); // 14:00 after return
  order = UI.sessionDisplayOrder(sched, trips);
  // 9,10,11, then missed 13, then 14,15
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);

  // Insert an enabled 12:00 so chronological has miss between sessions
  sched = [
    { index: 1, startMin: 11 * 60, enabled: true },
    { index: 2, startMin: 12 * 60, enabled: true }, // would be after origin in time but
    { index: 3, startMin: 13 * 60, enabled: false },
    { index: 4, startMin: 15 * 60, enabled: true },
  ];
  // Trip from 11 covers 13 skip; 12 enabled stays in place chronologically before we
  // would list misses — display: origin 11, miss 13, then 12, 15? User wants misses
  // after drive-back (origin), so: 11, 13, 12, 15
  trips = [{ originIndex: 1, departMin: 11 * 60 + 20, returnMin: 14 * 60 }];
  order = UI.sessionDisplayOrder(sched, trips);
  assert.deepEqual(order, [0, 2, 1, 3], 'missed 13 after origin 11, before later 12/15');
});

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Extract the engine IIFE block from index.html and run it in a sandbox.
function loadSim() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/);
  if (!m) throw new Error('engine markers not found in index.html');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx, { filename: 'index.html#engine' });
  return ctx.Sim;
}

const Sim = loadSim();
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }
// params with overrides applied onto the (supercharge + skip-1pm) defaults.
function cfg(over) { var p = Sim.defaultParams(); for (var k in (over || {})) p[k] = over[k]; return p; }
// the "full day on trailer power" config: no supercharge, every session run.
function fullDay(over) { return cfg(Object.assign({ supercharge: false, skipS4: false }, over || {})); }

test('engine loads and exposes Sim', () => {
  assert.equal(typeof Sim, 'object');
  assert.equal(typeof Sim.simulate, 'function');
});

test('curvePower hits known anchors', () => {
  assert.equal(Sim.curvePower(10), 250);
  assert.equal(Sim.curvePower(33), 250);
  assert.equal(Sim.curvePower(80), 68);
  assert.equal(Sim.curvePower(100), 7);
});

test('curvePower interpolates linearly between anchors', () => {
  assert.ok(Math.abs(Sim.curvePower(45) - 171.5) < 1e-6); // 40->195, 50->148; mid -> 171.5
});

test('curvePower clamps outside the table', () => {
  assert.equal(Sim.curvePower(0), 210);
  assert.equal(Sim.curvePower(120), 7);
});

test('defaultParams matches the spec defaults (supercharge on, 1pm skipped)', () => {
  var p = Sim.defaultParams();
  assert.equal(p.capacityKwh, 100);
  assert.equal(p.arrivalSocNoTrailerPct, 87);
  assert.equal(p.towingCostPct, 4);
  assert.equal(p.dcPowerKw, 40);
  assert.equal(p.dcdcEff, 0.95);
  assert.equal(p.acdcEff, 0.94);
  assert.equal(p.genPowerKw, 13);
  assert.equal(p.trailerCapKwh, 50);
  assert.equal(p.minTrailerSocPct, 5);
  assert.equal(p.sessionEnergyKwh, 35);
  assert.equal(p.sessionEndReservePct, 20);
  assert.equal('reserveKwh' in p, false); // renamed to sessionEndReservePct
  assert.equal(p.supercharge, true);
  assert.equal(p.skipS4, true); // 1pm unchecked by default
  [1, 2, 3, 5, 6, 7].forEach(i => assert.equal(p['skipS' + i], false));
});

test('effectiveArrivalKwh applies the towing cost', () => {
  assert.equal(Sim.effectiveArrivalKwh(Sim.defaultParams()), 83); // (87-4)% of 100
});

test('buildSchedule: 7 sessions, hourly from 9:00, no 12:00; default flags 1pm skipped', () => {
  var s = Sim.buildSchedule(Sim.defaultParams());
  assert.equal(s.length, 7);
  assert.deepEqual(s.map(x => x.startMin), [9*60, 10*60, 11*60, 13*60, 14*60, 15*60, 16*60]);
  assert.deepEqual(s.map(x => x.index), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(s[0].endMin, 9*60 + 15);
  assert.equal(s.find(x => x.index === 4).skipped, true);               // 1pm (default skip)
  assert.ok(s.filter(x => x.index !== 4).every(x => x.skipped === false));
});

test('chargeDelivery: mid-SoC is governed by the 40 kW DC-DC cap', () => {
  var r = Sim.chargeDelivery(50, 60, 50, Sim.defaultParams()); // curve(50)=148 >> 40
  assert.ok(Math.abs(r.deliverKw - 40) < 1e-6);
  assert.ok(Math.abs(r.fromGenBusKw - 12.22) < 1e-3);
  assert.ok(Math.abs(r.fromTrailerBusKw - (40/0.95 - 12.22)) < 1e-3);
});

test('chargeDelivery: near 100% the curve caps delivery below 40 kW', () => {
  var r = Sim.chargeDelivery(95, 95, 50, Sim.defaultParams()); // curve(95)=27 < 40
  assert.ok(Math.abs(r.deliverKw - 27) < 1e-6);
});

test('chargeDelivery: empty trailer falls back to generator-only', () => {
  var r = Sim.chargeDelivery(50, 60, 0, Sim.defaultParams());
  assert.ok(Math.abs(r.fromTrailerBusKw - 0) < 1e-6);
  assert.ok(Math.abs(r.deliverKw - 12.22 * 0.95) < 1e-2);
});

test('chargeDelivery: respects headroom near full pack', () => {
  var r = Sim.chargeDelivery(50, 99.9, 50, Sim.defaultParams());
  assert.ok(r.deliverKw <= 6 + 1e-6);
});

test('chargeDelivery: near-full, both curve and headroom bind below 40 kW', () => {
  var r = Sim.chargeDelivery(99, 99.8, 50, Sim.defaultParams());
  assert.ok(Math.abs(r.deliverKw - 11) < 1e-6);
  assert.ok(r.deliverKw <= (100 - 99.8) * 60 + 1e-9);
});

test('chargeDelivery: trailer cannot discharge below its minimum SoC floor', () => {
  var p = Sim.defaultParams(); // minTrailerSocPct 5% of 50 kWh -> 2.5 kWh floor
  var atFloor = Sim.chargeDelivery(50, 60, 2.5, p);
  assert.ok(Math.abs(atFloor.fromTrailerBusKw - 0) < 1e-6);          // nothing left to give
  assert.ok(Math.abs(atFloor.deliverKw - 12.22 * 0.95) < 1e-2);      // generator-only
  var justAbove = Sim.chargeDelivery(50, 60, 2.6, p);                // 0.1 kWh above floor
  assert.ok(justAbove.fromTrailerBusKw <= 6 + 1e-6);                 // only that 0.1 kWh -> 6 kW/min
});

test('simulate: timeline spans arrival to last session end', () => {
  var r = Sim.simulate(Sim.defaultParams());
  assert.equal(r.timeline[0].min, 8 * 60);
  assert.equal(r.timeline[r.timeline.length - 1].min, 16 * 60 + 15 - 1);
  r.timeline.forEach(function (pt) {
    assert.ok(pt.carPct <= 100.0001);
    assert.ok(pt.trlPct <= 100.0001 && pt.trlPct >= -0.0001);
  });
});

test('simulate: a session removes ~sessionEnergy from the pack', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p);
  function kwhAt(min) { return r.timeline.find(x => x.min === min).carPct / 100 * p.capacityKwh; }
  var drop = kwhAt(9 * 60 - 1) - kwhAt(9 * 60 + 14); // S1 runs in every plan
  assert.ok(near(drop, p.sessionEnergyKwh, 0.6));
});

test('simulate: trailer SoC never dips below the minimum floor', () => {
  var p = fullDay(); // stresses the trailer the most
  var r = Sim.simulate(p);
  var minTrl = Math.min.apply(null, r.timeline.map(x => x.trlPct));
  assert.ok(minTrl >= p.minTrailerSocPct - 1e-6, 'trailer floored at ' + minTrl + '%');
});

test('fullDay metrics: 7 sessions run, nothing skipped, no supercharge block', () => {
  var m = Sim.simulate(fullDay()).metrics;
  assert.equal(m.sessionsRun, 7);
  assert.deepEqual(m.skippedSessions, []);
  assert.equal(m.sc, null);
  assert.ok(m.fuelGal > 0);
  assert.ok(near(m.fuelGal, m.genAcKwh * (fullDay().fuelBurnGalPerHr / fullDay().genPowerKw), 1e-6));
  assert.equal(m.fromArrivalKwh, 83);
});

test('configs: full day runs 7; skip-1pm runs 6 and ends fuller; supercharge runs 6 with SC info', () => {
  var full = Sim.simulate(fullDay()).metrics;
  var skip = Sim.simulate(fullDay({ skipS4: true })).metrics; // skip 1pm, no SC
  var sc = Sim.simulate(cfg({ supercharge: true })).metrics;   // = default
  assert.equal(full.sessionsRun, 7);
  assert.equal(skip.sessionsRun, 6);
  assert.equal(sc.sessionsRun, 6);
  assert.ok(skip.endSocKwh > full.endSocKwh);  // skipping a 35 kWh draw helps
  assert.ok(sc.fromSuperchargerKwh > 0 && sc.sc);
  assert.ok(sc.sc.returnMin > 13 * 60 && sc.sc.returnMin < 14 * 60); // returns early afternoon, before 2pm
  // with 35 kWh sessions the trailer-only plans can't keep up (infeasible);
  // the supercharge plan clears the 20% session-end reserve (lowest session-end ~27%).
  assert.equal(full.feasible, false);
  assert.equal(sc.feasible, true);
  assert.ok(near(sc.minSocPct, 27.0, 1.0), 'supercharge lowest session-end ~27%');
});

test('the feasibility low is taken at a session end (on-track), not the supercharge drive dip', () => {
  var r = Sim.simulate(Sim.defaultParams());
  var pt = r.timeline.find(x => x.min === r.metrics.minSocAtMin);
  assert.equal(pt.mode, 'SESSION');
});

test('the session-end reserve is the feasibility trigger', () => {
  assert.equal(Sim.simulate(Sim.defaultParams()).metrics.feasible, true); // clears the 20% reserve
  var r = Sim.simulate(cfg({ sessionEndReservePct: 30 }));                 // demand 30% at session ends
  assert.equal(r.metrics.feasible, false);
  assert.ok(r.metrics.shortfallKwh > 0);
});

test('supercharge ⟺ 1pm exclusive: toggling skipS4 under supercharge has no effect (bug regression)', () => {
  var a = Sim.simulate(cfg({ supercharge: true, skipS4: false })).metrics;
  var b = Sim.simulate(cfg({ supercharge: true, skipS4: true })).metrics;
  assert.ok(near(a.endSocPct, b.endSocPct, 1e-9));
  assert.ok(near(a.minSocPct, b.minSocPct, 1e-9));
  [a, b].forEach(function (m) {
    var s4 = m.skippedSessions.find(s => s.index === 4);
    assert.ok(s4 && s4.reason === 'supercharge');
  });
});

test('supercharge always skips the 1pm session, even with a reachable target', () => {
  var r = Sim.simulate(cfg({ supercharge: true, scTargetSocPct: 80 })).metrics; // returns ~12:30
  var s4 = r.skippedSessions.find(s => s.index === 4);
  assert.ok(s4 && s4.reason === 'supercharge');
  assert.equal(r.sessionsRun, 6); // only S4 skipped; S5..S7 run
});

test('skip a session: it is not run, recorded as a skip, and frees energy', () => {
  var r = Sim.simulate(fullDay({ skipS2: true }));
  assert.equal(r.metrics.sessionsRun, 6);
  assert.equal(r.metrics.skippedSessions.length, 1);
  assert.equal(r.metrics.skippedSessions[0].index, 2);
  assert.equal(r.metrics.skippedSessions[0].reason, 'skip');
  r.timeline.forEach(function (pt) {
    if (pt.min >= 10 * 60 && pt.min < 10 * 60 + 15) assert.notEqual(pt.mode, 'SESSION');
  });
  assert.ok(r.metrics.endSocKwh >= Sim.simulate(fullDay()).metrics.endSocKwh - 1e-6);
});

test('supercharge: drives out after S3, charges to target, and skips session 4', () => {
  var p = cfg({ supercharge: true });
  var r = Sim.simulate(p);
  assert.ok(r.metrics.sc && r.metrics.sc.scDurationMin > 0);
  var awayPt = r.timeline.find(x => x.min === 11 * 60 + 20);
  assert.ok(awayPt.mode === 'DRIVE' || awayPt.mode === 'SC');
  var maxPct = Math.max.apply(null, r.timeline.map(x => x.carPct));
  assert.ok(maxPct >= p.scTargetSocPct - 0.5);
  var s4 = r.metrics.skippedSessions.find(s => s.index === 4);
  assert.ok(s4 && s4.reason === 'supercharge');
});

test('supercharge: no cooling debit while the car is away (DRIVE/SC)', () => {
  var r = Sim.simulate(cfg({ supercharge: true }));
  r.timeline.forEach(function (pt) {
    if (pt.mode === 'DRIVE' || pt.mode === 'SC') assert.equal(pt.coolingKw, 0);
  });
});

test('supercharge lands the car fuller than the full day on trailer power', () => {
  assert.ok(Sim.simulate(cfg({ supercharge: true })).metrics.endSocKwh
          > Sim.simulate(fullDay()).metrics.endSocKwh);
});

test('lowering scTargetSoc pulls the supercharge return time earlier', () => {
  var r1 = Sim.simulate(cfg({ supercharge: true })).metrics.sc.returnMin;
  var r2 = Sim.simulate(cfg({ supercharge: true, scTargetSocPct: 80 })).metrics.sc.returnMin;
  assert.ok(r2 < r1);
});

test('supercharge at 100% target skips only session 4 (away covers just S4)', () => {
  var r = Sim.simulate(cfg({ supercharge: true })); // returns ~13:09
  assert.deepEqual(r.metrics.skippedSessions.map(s => s.startMin), [13 * 60]);
  r.timeline.forEach(function (pt) {
    if (pt.min >= 13 * 60 && pt.min < 13 * 60 + 15) assert.notEqual(pt.mode, 'SESSION');
  });
});

test('every session that runs is whole (no partial draws), with supercharge', () => {
  var p = cfg({ supercharge: true });
  var r = Sim.simulate(p);
  var sessionMinutes = r.timeline.filter(pt => pt.mode === 'SESSION').length;
  assert.equal(sessionMinutes, r.metrics.sessionsRun * p.sessionDurationMin);
});

test('a slow supercharge that runs past 2pm skips both S4 and S5', () => {
  var p = cfg({ supercharge: true, scPowerCapKw: 20 }); // returns ~14:34
  var r = Sim.simulate(p);
  var skipMin = r.metrics.skippedSessions.map(s => s.startMin);
  assert.ok(skipMin.indexOf(13 * 60) !== -1 && skipMin.indexOf(14 * 60) !== -1);
  var sessionMinutes = r.timeline.filter(pt => pt.mode === 'SESSION').length;
  assert.equal(sessionMinutes, r.metrics.sessionsRun * p.sessionDurationMin);
});

test('a supercharge that never finishes skips every post-departure session', () => {
  var r = Sim.simulate(cfg({ supercharge: true, scPowerCapKw: 5 }));
  assert.equal(r.metrics.sc.returnMin, null);
  var skipMin = r.metrics.skippedSessions.map(s => s.startMin);
  [13 * 60, 14 * 60, 15 * 60, 16 * 60].forEach(function (m) {
    assert.ok(skipMin.indexOf(m) !== -1, 'expected session at ' + m + ' skipped');
  });
});

test('energy conservation: net charge into the car is positive over the full day', () => {
  var p = fullDay();
  var r = Sim.simulate(p); var m = r.metrics;
  var sessionDraw = m.sessionsRun * p.sessionEnergyKwh;
  var coolingDraw = r.timeline.reduce((s, pt) => s + (pt.coolingKw || 0), 0) / 60;
  var carCharge = m.endSocKwh - m.fromArrivalKwh + sessionDraw + coolingDraw;
  assert.ok(carCharge > 0);
  assert.ok(m.fromTrailerKwh >= 0 && m.fromGeneratorKwh >= 0);
});

test('pre-session cooling lump is applied to the arrival window (full day)', () => {
  var p = fullDay();
  var r = Sim.simulate(p);
  var totalCooling = r.timeline.reduce((s, pt) => s + (pt.coolingKw || 0), 0) / 60;
  var expected = p.preSessionCoolingKwh + (r.metrics.sessionsRun - 1) * p.coolingPerGapKwh; // 5 + 36
  assert.ok(Math.abs(totalCooling - expected) < 1e-6);
  assert.ok(r.timeline.find(pt => pt.min === p.arrivalTimeMin).coolingKw > 0);
  var t0 = Sim.simulate(fullDay({ preSessionCoolingKwh: 0 }))
    .timeline.reduce((s, pt) => s + (pt.coolingKw || 0), 0) / 60;
  assert.ok(Math.abs((totalCooling - t0) - p.preSessionCoolingKwh) < 1e-6);
});

test('a starved generator runs the car dead and is infeasible', () => {
  var p = fullDay({ genPowerKw: 3 });
  var r = Sim.simulate(p);
  assert.equal(r.metrics.feasible, false);
  assert.ok(r.metrics.minSocKwh < 0, 'true deficit must be negative, not clamped at 0');
  var reserve = p.sessionEndReservePct / 100 * p.capacityKwh;
  assert.ok(Math.abs(r.metrics.shortfallKwh - (reserve - r.metrics.minSocKwh)) < 1e-9);
});

test('the default (supercharge) day stays feasible, clearing the session-end reserve', () => {
  var r = Sim.simulate(Sim.defaultParams());
  assert.equal(r.metrics.feasible, true);
  assert.ok(r.metrics.minSocKwh > 20); // > 20% reserve of a 100 kWh pack
});

test('no generator (0 kW) yields zero fuel and finite results', () => {
  var r = Sim.simulate(fullDay({ genPowerKw: 0 }));
  assert.equal(r.metrics.fuelGal, 0);
  assert.ok(isFinite(r.metrics.minSocKwh) && isFinite(r.metrics.endSocKwh));
  assert.equal(typeof r.metrics.feasible, 'boolean');
});

test('SMOKE: full day / skip-1pm / supercharge are all coherent', () => {
  var full = Sim.simulate(fullDay()).metrics;
  var skip = Sim.simulate(fullDay({ skipS4: true })).metrics;
  var sc = Sim.simulate(cfg({ supercharge: true })).metrics;
  [full, skip, sc].forEach(function (m) {
    assert.ok(m.endSocPct >= -200 && m.endSocPct <= 100);
    assert.ok(m.fuelGal >= 0);
  });
  assert.ok(skip.endSocKwh >= full.endSocKwh - 1e-6);
  assert.ok(sc.fromSuperchargerKwh > 0);
});

test('degenerate inputs do not crash or produce NaN', () => {
  // # sessions = 0 -> empty but valid result (no TypeError on sessions[-1])
  var z = Sim.simulate(cfg({ sessionCount: 0 }));
  assert.equal(z.timeline.length, 0);
  assert.equal(z.metrics.sessionsRun, 0);
  assert.ok(isFinite(z.metrics.endSocPct) && isFinite(z.metrics.minSocKwh));
  // trailer capacity = 0 (no trailer battery) -> finite display percentages
  var noTrl = Sim.simulate(fullDay({ trailerCapKwh: 0 }));
  assert.ok(noTrl.timeline.every(pt => isFinite(pt.trlPct)));
  assert.ok(isFinite(noTrl.metrics.trailerEndPct) && isFinite(noTrl.metrics.minSocKwh));
  // AC-DC efficiency = 0 -> finite (zero) fuel, no NaN
  var noAc = Sim.simulate(fullDay({ acdcEff: 0 }));
  assert.ok(isFinite(noAc.metrics.fuelGal) && isFinite(noAc.metrics.genAcKwh));
});

module.exports = { loadSim };

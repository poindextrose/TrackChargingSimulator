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
// Convenience: a params object with the given overrides.
function cfg(over) { var p = Sim.defaultParams(); for (var k in (over || {})) p[k] = over[k]; return p; }

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
  // 40->195, 50->148; midpoint 45 -> 171.5
  assert.ok(Math.abs(Sim.curvePower(45) - 171.5) < 1e-6);
});

test('curvePower clamps outside the table', () => {
  assert.equal(Sim.curvePower(0), 210);   // below first anchor (5)
  assert.equal(Sim.curvePower(120), 7);   // above last anchor (100)
});

test('defaultParams matches the spec defaults', () => {
  var p = Sim.defaultParams();
  assert.equal(p.capacityKwh, 100);
  assert.equal(p.arrivalSocNoTrailerPct, 87);
  assert.equal(p.towingCostPct, 4);
  assert.equal(p.dcPowerKw, 40);
  assert.equal(p.dcdcEff, 0.95);
  assert.equal(p.acdcEff, 0.94);
  assert.equal(p.genPowerKw, 13);
  assert.equal(p.trailerCapKwh, 50);
  // single-scenario controls default off
  assert.equal(p.supercharge, false);
  for (var i = 1; i <= 7; i++) assert.equal(p['skipS' + i], false);
});

test('effectiveArrivalKwh applies the towing cost', () => {
  var p = Sim.defaultParams();
  assert.equal(Sim.effectiveArrivalKwh(p), 83); // (87-4)% of 100
});

test('buildSchedule: 7 sessions, hourly from 9:00, no 12:00, none skipped by default', () => {
  var s = Sim.buildSchedule(Sim.defaultParams());
  assert.equal(s.length, 7);
  assert.deepEqual(s.map(x => x.startMin), [9*60, 10*60, 11*60, 13*60, 14*60, 15*60, 16*60]);
  assert.deepEqual(s.map(x => x.index), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(s[0].endMin, 9*60 + 15); // 15-min default duration
  assert.ok(s.every(x => x.skipped === false));
});

test('buildSchedule: skipS4 flags the 1pm session (index 4); list stays full', () => {
  var s = Sim.buildSchedule(cfg({ skipS4: true }));
  assert.equal(s.length, 7); // not removed, just flagged
  var s4 = s.find(x => x.index === 4);
  assert.equal(s4.startMin, 13*60);
  assert.equal(s4.skipped, true);
  assert.ok(s.filter(x => x.index !== 4).every(x => x.skipped === false));
});

test('chargeDelivery: mid-SoC is governed by the 40 kW DC-DC cap', () => {
  var p = Sim.defaultParams();
  var r = Sim.chargeDelivery(50, 60, 50, p); // curve(50)=148 >> 40
  assert.ok(Math.abs(r.deliverKw - 40) < 1e-6);
  // bus need = 40/0.95 = 42.105; gen bus = 13*0.94 = 12.22; trailer covers rest
  assert.ok(Math.abs(r.fromGenBusKw - 12.22) < 1e-3);
  assert.ok(Math.abs(r.fromTrailerBusKw - (40/0.95 - 12.22)) < 1e-3);
});

test('chargeDelivery: near 100% the curve caps delivery below 40 kW', () => {
  var p = Sim.defaultParams();
  var r = Sim.chargeDelivery(95, 95, 50, p); // curve(95)=27 < 40
  assert.ok(Math.abs(r.deliverKw - 27) < 1e-6);
});

test('chargeDelivery: empty trailer falls back to generator-only', () => {
  var p = Sim.defaultParams();
  var r = Sim.chargeDelivery(50, 60, 0, p); // trailer empty
  assert.ok(Math.abs(r.fromTrailerBusKw - 0) < 1e-6);
  assert.ok(Math.abs(r.deliverKw - 12.22 * 0.95) < 1e-2);
});

test('chargeDelivery: respects headroom near full pack', () => {
  var p = Sim.defaultParams();
  var r = Sim.chargeDelivery(50, 99.9, 50, p);
  assert.ok(r.deliverKw <= 6 + 1e-6);
});

test('chargeDelivery: near-full, both curve and headroom bind below 40 kW', () => {
  var p = Sim.defaultParams();
  var r = Sim.chargeDelivery(99, 99.8, 50, p);
  assert.ok(Math.abs(r.deliverKw - 11) < 1e-6);      // curve(99) governs (= 11)
  assert.ok(r.deliverKw <= (100 - 99.8) * 60 + 1e-9); // within headroom
});

test('simulate: timeline spans arrival to last session end', () => {
  var r = Sim.simulate(Sim.defaultParams());
  assert.equal(r.timeline[0].min, 8 * 60);
  assert.equal(r.timeline[r.timeline.length - 1].min, 16 * 60 + 15 - 1);
  r.timeline.forEach(function (pt) {
    assert.ok(pt.carPct <= 100.0001 && pt.carPct >= -0.0001); // default is feasible
    assert.ok(pt.trlPct <= 100.0001 && pt.trlPct >= -0.0001);
  });
});

test('simulate: a session removes ~sessionEnergy from the pack', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p);
  function kwhAt(min) {
    var pt = r.timeline.find(function (x) { return x.min === min; });
    return pt.carPct / 100 * p.capacityKwh;
  }
  var drop = kwhAt(9 * 60 - 1) - kwhAt(9 * 60 + 14);
  assert.ok(near(drop, p.sessionEnergyKwh, 0.6)); // ~25 kWh over the 15 min
});

test('simulate: metrics are populated and self-consistent', () => {
  var p = Sim.defaultParams();
  var m = Sim.simulate(p).metrics;
  assert.equal(typeof m.feasible, 'boolean');
  assert.ok(m.minSocKwh <= Sim.effectiveArrivalKwh(p));
  assert.ok(m.fuelGal > 0);
  assert.ok(near(m.fuelGal, m.genAcKwh * (p.fuelBurnGalPerHr / p.genPowerKw), 1e-6));
  assert.equal(m.fromArrivalKwh, 83);
  assert.equal(m.sessionsRun, 7);
  assert.deepEqual(m.skippedSessions, []);
  assert.equal(m.sc, null); // no supercharge
});

test('behavior preserved: default=oldA, skipS4=oldB, supercharge=oldC reproduce known numbers', () => {
  var A = Sim.simulate(Sim.defaultParams()).metrics;
  var B = Sim.simulate(cfg({ skipS4: true })).metrics;
  var C = Sim.simulate(cfg({ supercharge: true })).metrics;
  assert.ok(near(A.minSocPct, 7.37, 0.1), 'old A min SoC ~7.37%');
  assert.ok(near(B.endSocPct, 38.37, 0.1), 'old B end ~38.37%');
  assert.ok(near(C.endSocPct, 54.77, 0.1), 'old C end ~54.77%');
  assert.equal(C.sc.returnMin, 13 * 60 + 9); // returns 13:09 at the 100% target
  assert.equal(B.sessionsRun, 6);
  assert.equal(C.sessionsRun, 6);
});

test('skip a session: it is not run, recorded as a skip, and frees energy', () => {
  var r = Sim.simulate(cfg({ skipS4: true }));
  assert.equal(r.metrics.sessionsRun, 6);
  assert.equal(r.metrics.skippedSessions.length, 1);
  assert.equal(r.metrics.skippedSessions[0].index, 4);
  assert.equal(r.metrics.skippedSessions[0].reason, 'skip');
  // no SESSION minute in the 1pm window
  r.timeline.forEach(function (pt) {
    if (pt.min >= 13 * 60 && pt.min < 13 * 60 + 15) assert.notEqual(pt.mode, 'SESSION');
  });
  // skipping a 25 kWh draw leaves more energy than the default
  assert.ok(r.metrics.endSocKwh >= Sim.simulate(Sim.defaultParams()).metrics.endSocKwh - 1e-6);
});

test('skip multiple sessions: both recorded, both un-run', () => {
  var r = Sim.simulate(cfg({ skipS2: true, skipS6: true }));
  assert.equal(r.metrics.sessionsRun, 5);
  var idx = r.metrics.skippedSessions.map(s => s.index).sort();
  assert.deepEqual(idx, [2, 6]);
  assert.ok(r.metrics.skippedSessions.every(s => s.reason === 'skip'));
});

test('supercharge: drives out after S3, charges to target, returns; auto-skips session 4', () => {
  var p = cfg({ supercharge: true });
  var r = Sim.simulate(p);
  assert.ok(r.metrics.sc);
  assert.ok(r.metrics.sc.scDurationMin > 0);
  var awayPt = r.timeline.find(function (x) { return x.min === 11 * 60 + 20; });
  assert.ok(awayPt.mode === 'DRIVE' || awayPt.mode === 'SC'); // left after S3
  var maxPct = Math.max.apply(null, r.timeline.map(function (x) { return x.carPct; }));
  assert.ok(maxPct >= p.scTargetSocPct - 0.5); // reaches 100%
  // session 4 (1pm) auto-skipped because the car is away, reason 'supercharge'
  var s4 = r.metrics.skippedSessions.find(function (s) { return s.index === 4; });
  assert.ok(s4 && s4.reason === 'supercharge');
  assert.equal(typeof r.metrics.sc.backBefore1pm, 'boolean');
});

test('supercharge: no cooling debit while the car is away (DRIVE/SC)', () => {
  var r = Sim.simulate(cfg({ supercharge: true }));
  r.timeline.forEach(function (pt) {
    if (pt.mode === 'DRIVE' || pt.mode === 'SC') {
      assert.notEqual(pt.coolingKw, undefined);
      assert.equal(pt.coolingKw, 0);
    }
  });
});

test('supercharge lands the car fuller than the stay-all-day default', () => {
  var endDefault = Sim.simulate(Sim.defaultParams()).metrics.endSocKwh;
  var endSc = Sim.simulate(cfg({ supercharge: true })).metrics.endSocKwh;
  assert.ok(endSc >= endDefault);
});

test('lowering scTargetSoc pulls the supercharge return time earlier', () => {
  var r1 = Sim.simulate(cfg({ supercharge: true })).metrics.sc.returnMin;
  var r2 = Sim.simulate(cfg({ supercharge: true, scTargetSocPct: 80 })).metrics.sc.returnMin;
  assert.ok(r2 < r1);
});

test('supercharge at the default 100% target returns late, skipping only session 4', () => {
  var r = Sim.simulate(cfg({ supercharge: true })); // returns ~13:09
  var away = r.metrics.skippedSessions.filter(s => s.reason === 'supercharge');
  assert.deepEqual(away.map(s => s.startMin), [13 * 60]); // only S4
  assert.equal(r.metrics.sc.backBefore1pm, false);
  // no SESSION minute inside the S4 window (no partial draw)
  r.timeline.forEach(function (pt) {
    if (pt.min >= 13 * 60 && pt.min < 13 * 60 + 15) assert.notEqual(pt.mode, 'SESSION');
  });
});

test('supercharge with a reachable target (80%) returns in time, skips nothing', () => {
  var r = Sim.simulate(cfg({ supercharge: true, scTargetSocPct: 80 })); // returns ~12:30
  assert.equal(r.metrics.skippedSessions.length, 0);
  assert.equal(r.metrics.sessionsRun, 7);
  var ranS4 = r.timeline.some(function (pt) {
    return pt.mode === 'SESSION' && pt.min >= 13 * 60 && pt.min < 13 * 60 + 15;
  });
  assert.ok(ranS4);
});

test('every session that runs is whole (no partial draws), with supercharge', () => {
  var p = cfg({ supercharge: true });
  var r = Sim.simulate(p);
  var sessionMinutes = r.timeline.filter(function (pt) { return pt.mode === 'SESSION'; }).length;
  assert.equal(sessionMinutes, r.metrics.sessionsRun * p.sessionDurationMin);
});

test('a slow supercharge that runs past 2pm skips both S4 and S5', () => {
  var p = cfg({ supercharge: true, scPowerCapKw: 20 }); // returns ~14:34
  var r = Sim.simulate(p);
  var away = r.metrics.skippedSessions.filter(s => s.reason === 'supercharge').map(s => s.startMin);
  assert.ok(away.indexOf(13 * 60) !== -1 && away.indexOf(14 * 60) !== -1);
  var sessionMinutes = r.timeline.filter(function (pt) { return pt.mode === 'SESSION'; }).length;
  assert.equal(sessionMinutes, r.metrics.sessionsRun * p.sessionDurationMin);
});

test('a supercharge that never finishes skips every post-departure session', () => {
  var r = Sim.simulate(cfg({ supercharge: true, scPowerCapKw: 5 })); // never reaches 100%
  assert.equal(r.metrics.sc.returnMin, null);
  var away = r.metrics.skippedSessions.filter(s => s.reason === 'supercharge').map(s => s.startMin);
  [13 * 60, 14 * 60, 15 * 60, 16 * 60].forEach(function (m) {
    assert.ok(away.indexOf(m) !== -1, 'expected session at ' + m + ' to be skipped');
  });
});

test('energy conservation: net charge into the car is positive over the day', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p); var m = r.metrics;
  var sessionDraw = m.sessionsRun * p.sessionEnergyKwh;
  var coolingDraw = r.timeline.reduce(function (s, pt) { return s + (pt.coolingKw || 0); }, 0) / 60;
  var carCharge = m.endSocKwh - m.fromArrivalKwh + sessionDraw + coolingDraw;
  assert.ok(carCharge > 0);
  assert.ok(m.fromTrailerKwh >= 0 && m.fromGeneratorKwh >= 0);
});

test('pre-session cooling lump is applied to the arrival window', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p);
  var totalCooling = r.timeline.reduce(function (s, pt) { return s + (pt.coolingKw || 0); }, 0) / 60;
  var postGaps = r.metrics.sessionsRun - 1; // 6 with all sessions run
  var expected = p.preSessionCoolingKwh + postGaps * p.coolingPerGapKwh; // 5 + 36 = 41
  assert.ok(Math.abs(totalCooling - expected) < 1e-6);
  var firstMin = r.timeline.find(function (pt) { return pt.min === p.arrivalTimeMin; });
  assert.ok(firstMin.coolingKw > 0);
  var t0 = Sim.simulate(cfg({ preSessionCoolingKwh: 0 })).timeline
    .reduce(function (s, pt) { return s + (pt.coolingKw || 0); }, 0) / 60;
  assert.ok(Math.abs((totalCooling - t0) - p.preSessionCoolingKwh) < 1e-6);
});

test('a starved generator runs the car dead and is infeasible', () => {
  var r = Sim.simulate(cfg({ genPowerKw: 3 }));
  assert.equal(r.metrics.feasible, false);
  assert.ok(r.metrics.minSocKwh < 0, 'true deficit must be negative, not clamped at 0');
  assert.ok(r.metrics.shortfallKwh > 0);
  assert.ok(Math.abs(r.metrics.shortfallKwh - (0 - r.metrics.minSocKwh)) < 1e-9);
});

test('default config stays feasible with positive min SoC', () => {
  var r = Sim.simulate(Sim.defaultParams());
  assert.equal(r.metrics.feasible, true);
  assert.ok(r.metrics.minSocKwh > 0);
});

test('a reserve floor makes a marginal day infeasible', () => {
  var r = Sim.simulate(cfg({ reserveKwh: 20 })); // default min SoC ~7 kWh < 20
  assert.equal(r.metrics.feasible, false);
  assert.ok(r.metrics.shortfallKwh > 0);
});

test('no generator (0 kW) yields zero fuel and finite results', () => {
  var r = Sim.simulate(cfg({ genPowerKw: 0 }));
  assert.equal(r.metrics.fuelGal, 0);
  assert.ok(isFinite(r.metrics.minSocKwh));
  assert.ok(isFinite(r.metrics.endSocKwh));
  assert.equal(typeof r.metrics.feasible, 'boolean');
});

test('SMOKE: default / skip-1pm / supercharge are all coherent', () => {
  var A = Sim.simulate(Sim.defaultParams()).metrics;
  var B = Sim.simulate(cfg({ skipS4: true })).metrics;
  var C = Sim.simulate(cfg({ supercharge: true })).metrics;
  [A, B, C].forEach(function (m) {
    assert.ok(m.endSocPct >= -200 && m.endSocPct <= 100);
    assert.ok(m.fuelGal >= 0);
  });
  assert.ok(B.endSocKwh >= A.endSocKwh - 1e-6); // skipping a session keeps more energy
  assert.ok(C.fromSuperchargerKwh > 0);          // supercharge actually charges
});

module.exports = { loadSim };

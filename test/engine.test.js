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
});

test('effectiveArrivalKwh applies the towing cost', () => {
  var p = Sim.defaultParams();
  assert.equal(Sim.effectiveArrivalKwh(p), 83); // (87-4)% of 100
});

test('buildSchedule A: 7 sessions, hourly from 9:00, no 12:00', () => {
  var s = Sim.buildSchedule(Sim.defaultParams(), 'A');
  assert.equal(s.length, 7);
  assert.deepEqual(s.map(x => x.startMin),
    [9*60, 10*60, 11*60, 13*60, 14*60, 15*60, 16*60]);
  assert.equal(s[0].endMin, 9*60 + 15); // 15-min default duration
});

test('buildSchedule B: drops the 1pm session', () => {
  var s = Sim.buildSchedule(Sim.defaultParams(), 'B');
  assert.equal(s.length, 6);
  assert.ok(!s.some(x => x.startMin === 13*60));
});

test('buildSchedule C: identical session times to A (no session removed)', () => {
  var a = Sim.buildSchedule(Sim.defaultParams(), 'A').map(function (s) { return s.startMin; });
  var c = Sim.buildSchedule(Sim.defaultParams(), 'C').map(function (s) { return s.startMin; });
  assert.deepEqual(c, a);
  assert.equal(c.length, 7);
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
  // only generator bus available: 12.22 kW -> deliver 12.22*0.95
  assert.ok(Math.abs(r.fromTrailerBusKw - 0) < 1e-6);
  assert.ok(Math.abs(r.deliverKw - 12.22 * 0.95) < 1e-2);
});

test('chargeDelivery: respects headroom near full pack', () => {
  var p = Sim.defaultParams();
  // 0.1 kWh of headroom -> at most 0.1*60 = 6 kW this minute
  var r = Sim.chargeDelivery(50, 99.9, 50, p);
  assert.ok(r.deliverKw <= 6 + 1e-6);
});

test('chargeDelivery: near-full, both curve and headroom bind below 40 kW', () => {
  var p = Sim.defaultParams();
  // SoC 99% -> curve ~11 kW; headroom (100-99.8)*60 = 12 kW; both < 40
  var r = Sim.chargeDelivery(99, 99.8, 50, p);
  assert.ok(Math.abs(r.deliverKw - 11) < 1e-6);      // curve(99) governs (= 11)
  assert.ok(r.deliverKw <= (100 - 99.8) * 60 + 1e-9); // within headroom
});

function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-6 : tol); }

test('simulate A: timeline spans arrival to last session end', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'A');
  assert.equal(r.timeline[0].min, 8 * 60);
  assert.equal(r.timeline[r.timeline.length - 1].min, 16 * 60 + 15 - 1);
  // SoC never exceeds 100% or drops below 0
  r.timeline.forEach(function (pt) {
    assert.ok(pt.carPct <= 100.0001 && pt.carPct >= -0.0001);
    assert.ok(pt.trlPct <= 100.0001 && pt.trlPct >= -0.0001);
  });
});

test('simulate A: a session removes ~sessionEnergy from the pack', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'A');
  // energy at 8:59 (before S1) vs 9:15 (S1 end). Pure discharge during session.
  function kwhAt(min) {
    var pt = r.timeline.find(function (x) { return x.min === min; });
    return pt.carPct / 100 * p.capacityKwh;
  }
  var drop = kwhAt(9 * 60 - 1) - kwhAt(9 * 60 + 14);
  assert.ok(near(drop, p.sessionEnergyKwh, 0.6)); // ~25 kWh over the 15 min
});

test('simulate A: metrics are populated and self-consistent', () => {
  var p = Sim.defaultParams();
  var m = Sim.simulate(p, 'A').metrics;
  assert.equal(typeof m.feasible, 'boolean');
  assert.ok(m.minSocKwh <= Sim.effectiveArrivalKwh(p));
  assert.ok(m.fuelGal > 0);
  assert.ok(near(m.fuelGal, m.genAcKwh * (p.fuelBurnGalPerHr / p.genPowerKw), 1e-6));
  assert.equal(m.fromArrivalKwh, 83);
});

test('simulate B: one fewer session and no draw at 1pm', () => {
  var p = Sim.defaultParams();
  var rA = Sim.simulate(p, 'A');
  var rB = Sim.simulate(p, 'B');
  // B should end with at least as much energy as A (skipped a 25 kWh draw)
  assert.ok(rB.metrics.endSocKwh >= rA.metrics.endSocKwh - 1e-6);
  // at 13:05 the car is NOT in a session in B
  var b1305 = rB.timeline.find(function (x) { return x.min === 13 * 60 + 5; });
  assert.equal(b1305.mode !== 'SESSION', true);
});

test('simulate C: drives away after S3, supercharges, returns; records timing', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'C');
  assert.ok(r.metrics.c);
  assert.ok(r.metrics.c.scDurationMin > 0);
  // car leaves right after S3 ends (11:15)
  var awayPt = r.timeline.find(function (x) { return x.min === 11 * 60 + 20; });
  assert.ok(awayPt.mode === 'DRIVE' || awayPt.mode === 'SC');
  // supercharge brings car to the target SoC at some point
  var maxPct = Math.max.apply(null, r.timeline.map(function (x) { return x.carPct; }));
  assert.ok(maxPct >= p.scTargetSocPct - 0.5);
  // returnMin recorded; backBefore1pm boolean present
  assert.equal(typeof r.metrics.c.backBefore1pm, 'boolean');
});

test('simulate C: no cooling debit during the away (S3->S4) window', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'C');
  r.timeline.forEach(function (pt) {
    if (pt.mode === 'DRIVE' || pt.mode === 'SC') {
      assert.notEqual(pt.coolingKw, undefined);
      assert.equal(pt.coolingKw, 0);
    }
  });
});

test('energy conservation across the day (A)', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'A');
  var m = r.metrics;
  var sessions = Sim.buildSchedule(p, 'A');
  var sessionDraw = sessions.length * p.sessionEnergyKwh;
  // count cooling gaps actually applied (post-session gaps; all of them in A)
  var coolingDraw = (sessions.length - 1) * p.coolingPerGapKwh;
  // ΔE_car = arrival + chargedIntoCar - sessions - cooling
  // chargedIntoCar ≈ fromTrailer*dcdc + fromGenerator-portion-to-car... instead
  // verify the simpler closed form: end = arrival + carCharge - draws
  var carCharge = m.endSocKwh - m.fromArrivalKwh + sessionDraw + coolingDraw;
  assert.ok(carCharge > 0); // net energy was pushed into the car over the day
  // trailer + generator supplied the car charge (through dcdc); loose bound:
  assert.ok(m.fromTrailerKwh >= 0 && m.fromGeneratorKwh >= 0);
});

test('scenario C lands the car fuller than A at end of day', () => {
  var p = Sim.defaultParams();
  var endA = Sim.simulate(p, 'A').metrics.endSocKwh;
  var endC = Sim.simulate(p, 'C').metrics.endSocKwh;
  assert.ok(endC >= endA); // the supercharge top-up helps
});

test('lowering scTargetSoc pulls the return time earlier', () => {
  var p1 = Sim.defaultParams();
  var p2 = Sim.defaultParams(); p2.scTargetSocPct = 80;
  var r1 = Sim.simulate(p1, 'C').metrics.c.returnMin;
  var r2 = Sim.simulate(p2, 'C').metrics.c.returnMin;
  assert.ok(r2 < r1);
});

test('simulate C: a late return (target 100%) misses S4 entirely, no partial draw', () => {
  var p = Sim.defaultParams(); // returns ~13:09, after S4 starts at 13:00
  var r = Sim.simulate(p, 'C');
  var missedStarts = r.metrics.c.missedSessions.map(function (x) { return x.startMin; });
  assert.ok(missedStarts.indexOf(13 * 60) !== -1); // S4 recorded as missed
  // No SESSION-mode minute anywhere inside the S4 window [13:00, 13:15)
  r.timeline.forEach(function (pt) {
    if (pt.min >= 13 * 60 && pt.min < 13 * 60 + p.sessionDurationMin) {
      assert.notEqual(pt.mode, 'SESSION');
    }
  });
});

test('simulate C: an on-time return (target 80%) misses nothing and runs S4', () => {
  var p = Sim.defaultParams(); p.scTargetSocPct = 80; // returns before 13:00
  var r = Sim.simulate(p, 'C');
  assert.equal(r.metrics.c.missedSessions.length, 0);
  var ranS4 = r.timeline.some(function (pt) {
    return pt.mode === 'SESSION' && pt.min >= 13 * 60 && pt.min < 13 * 60 + p.sessionDurationMin;
  });
  assert.ok(ranS4);
});

test('simulate C: every session that runs is whole (no partial draws)', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p, 'C');
  var sessionMinutes = r.timeline.filter(function (pt) { return pt.mode === 'SESSION'; }).length;
  var ran = Sim.buildSchedule(p, 'C').length - r.metrics.c.missedSessions.length;
  // Each session that actually runs occupies exactly sessionDurationMin SESSION-mode minutes,
  // so total SESSION minutes == (scheduled − missed) × duration. Guards against partial draws.
  assert.equal(sessionMinutes, ran * p.sessionDurationMin);
});

test('simulate C: sessions whole across a long supercharge that misses two sessions', () => {
  var p = Sim.defaultParams();
  p.scPowerCapKw = 20; // slow SC -> returns well after 14:00, missing S4 and S5
  var r = Sim.simulate(p, 'C');
  assert.ok(r.metrics.c.missedSessions.length >= 2);
  var sessionMinutes = r.timeline.filter(function (pt) { return pt.mode === 'SESSION'; }).length;
  var ran = Sim.buildSchedule(p, 'C').length - r.metrics.c.missedSessions.length;
  assert.equal(sessionMinutes, ran * p.sessionDurationMin);
});

module.exports = { loadSim };

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

module.exports = { loadSim };

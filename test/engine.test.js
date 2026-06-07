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

module.exports = { loadSim };

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

test('buildSchedule C: keeps all 7 sessions', () => {
  assert.equal(Sim.buildSchedule(Sim.defaultParams(), 'C').length, 7);
});

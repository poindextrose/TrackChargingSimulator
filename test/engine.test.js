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

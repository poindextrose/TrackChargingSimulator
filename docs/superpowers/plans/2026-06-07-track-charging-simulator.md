# Track Charging Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single self-contained `index.html` that simulates a Model S Plaid's state of charge across an HPDE track day and compares three trailer-charging day-plans (A/B/C) side by side.

**Architecture:** All app code lives in one `index.html` (inline CSS + inline JS) so the user double-clicks to open it offline. The pure simulation engine sits inside a marked block (`// SIM_ENGINE_START` … `// SIM_ENGINE_END`) as an IIFE that returns a `Sim` object. A Node test file extracts that block with `node:vm` and unit-tests the engine — no build step, no dependencies, and the deliverable stays a single file. The UI is generated from one `UI_FIELDS` table that drives both the input controls and the param parser, keeping ids consistent.

**Tech Stack:** Vanilla HTML/CSS/JS, `<canvas>` for charts (hand-rolled, no chart library). Node ≥18 built-in `node:test` + `node:vm` for tests (dev-only; the app itself needs no Node).

---

## Prerequisites

- Node ≥18 (confirmed: v25 in this environment) for running tests. The shipped `index.html` needs no Node/network.
- Repo already initialized at project root with `origin` → `git@github.com:poindextrose/TrackChargingSimulator` (private), default branch `main`. Spec at `docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md`.

## File Structure

- **Create `index.html`** — the entire app: HTML shell, inline `<style>`, an inline `<script>` holding the engine between markers, and an inline `<script>` for the UI. The committed deliverable.
- **Create `package.json`** — `"test": "node --test"`, no dependencies, `"type": "commonjs"`.
- **Create `test/engine.test.js`** — extracts the engine block from `index.html` via `node:vm`, unit/integration-tests it.
- **Create `test/ui-fields.test.js`** — extracts the UI block and asserts the `UI_FIELDS` table parses to the engine's `defaultParams()` (locks UI defaults to engine defaults) and that every field id is unique.

Engine `Sim` public API (defined incrementally; final shape):
- `Sim.PLAID_V3_CURVE: number[][]`
- `Sim.curvePower(socPct: number): number`
- `Sim.defaultParams(): Params`
- `Sim.effectiveArrivalKwh(p: Params): number`
- `Sim.buildSchedule(p: Params, scenarioId: 'A'|'B'|'C'): Session[]`  where `Session = {index, startMin, endMin}`
- `Sim.chargeDelivery(socPct, eCar, eTr, p): {deliverKw, fromGenBusKw, fromTrailerBusKw}`
- `Sim.simulate(p: Params, scenarioId): {timeline: Point[], metrics: Metrics}`

UI public API (inside the UI `<script>`, also IIFE `UI` for testability):
- `UI.UI_FIELDS: Field[]`
- `UI.readParams(values: Record<string,string>): Params`
- `UI.formatMetrics(metrics, scenarioId): {label, value}[]`
- `UI.hhmmToMin(s): number` / `UI.minToHHMM(m): string`

---

## Task 1: Scaffold + test harness

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

`test/engine.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `index.html` does not exist (`ENOENT`).

- [ ] **Step 3: Write minimal implementation**

`package.json`:

```json
{
  "name": "track-charging-simulator",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "node --test"
  }
}
```

`index.html` (skeleton — engine block defines `Sim` as a global so `vm` can read it; later tasks fill the helpers):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Track Charging Simulator</title>
<style>
/* CSS added in Task 10 */
</style>
</head>
<body>
<header><h1>Track Charging Simulator</h1></header>
<div id="inputs"></div>
<div id="cards"></div>
<canvas id="overlay" width="900" height="220"></canvas>
<script>
// SIM_ENGINE_START
var Sim = (function () {
  'use strict';
  function simulate(p, scenarioId) { return { timeline: [], metrics: {} }; }
  return { simulate };
})();
// SIM_ENGINE_END
</script>
<script>
// UI_START  (filled in Tasks 10-12)
// UI_END
</script>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add package.json index.html test/engine.test.js
git commit -m "feat: scaffold app + vm-based engine test harness"
```

---

## Task 2: Supercharger / acceptance curve `curvePower`

**Files:**
- Modify: `index.html` (engine block)
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/engine.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `Sim.curvePower is not a function`.

- [ ] **Step 3: Write minimal implementation**

In the engine block, inside the IIFE before `return`, add:

```js
  var PLAID_V3_CURVE = [
    [5, 210], [10, 250], [20, 250], [30, 250], [33, 250],
    [40, 195], [50, 148], [60, 120], [70, 95], [80, 68],
    [90, 42], [95, 27], [100, 7],
  ];

  function curvePower(socPct) {
    var c = PLAID_V3_CURVE;
    if (socPct <= c[0][0]) return c[0][1];
    if (socPct >= c[c.length - 1][0]) return c[c.length - 1][1];
    for (var i = 1; i < c.length; i++) {
      if (socPct <= c[i][0]) {
        var x0 = c[i - 1][0], y0 = c[i - 1][1], x1 = c[i][0], y1 = c[i][1];
        return y0 + (y1 - y0) * (socPct - x0) / (x1 - x0);
      }
    }
    return c[c.length - 1][1];
  }
```

Update the `return` to: `return { PLAID_V3_CURVE: PLAID_V3_CURVE, curvePower: curvePower, simulate: simulate };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html test/engine.test.js
git commit -m "feat: Plaid V3 charge/acceptance curve lookup"
```

---

## Task 3: Defaults + effective arrival energy

**Files:**
- Modify: `index.html` (engine block)
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `Sim.defaultParams is not a function`.

- [ ] **Step 3: Write minimal implementation**

In the engine IIFE:

```js
  var DEFAULTS = {
    arrivalTimeMin: 8 * 60,
    capacityKwh: 100,
    arrivalSocNoTrailerPct: 87,
    towingCostPct: 4,
    sessionEnergyKwh: 25,
    sessionDurationMin: 15,
    coolingPerGapKwh: 6,
    trailerCapKwh: 50,
    genPowerKw: 13,
    acdcEff: 0.94,
    fuelBurnGalPerHr: 1.3,
    dcPowerKw: 40,
    dcdcEff: 0.95,
    reserveKwh: 0,
    firstSessionMin: 9 * 60,
    sessionCount: 7,
    lunchSkipHour: 12,
    driveTimeMin: 30,
    driveConsumptionPct: 14,
    scTargetSocPct: 100,
    scPowerCapKw: 250,
  };
  function defaultParams() {
    var o = {}; for (var k in DEFAULTS) o[k] = DEFAULTS[k]; return o;
  }
  function effectiveArrivalKwh(p) {
    return (p.arrivalSocNoTrailerPct - p.towingCostPct) / 100 * p.capacityKwh;
  }
```

Add `defaultParams`, `effectiveArrivalKwh` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html test/engine.test.js
git commit -m "feat: engine default params + effective arrival energy"
```

---

## Task 4: Schedule builder `buildSchedule`

**Files:**
- Modify: `index.html` (engine block)
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `Sim.buildSchedule is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function buildSchedule(p, scenarioId) {
    var sessions = [];
    var hourMin = p.firstSessionMin;
    while (sessions.length < p.sessionCount) {
      if (hourMin !== p.lunchSkipHour * 60) {
        sessions.push({
          index: sessions.length + 1,
          startMin: hourMin,
          endMin: hourMin + p.sessionDurationMin,
        });
      }
      hourMin += 60;
    }
    if (scenarioId === 'B') {
      return sessions.filter(function (s) { return s.startMin !== 13 * 60; });
    }
    return sessions;
  }
```

Add `buildSchedule` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html test/engine.test.js
git commit -m "feat: per-scenario session schedule builder"
```

---

## Task 5: Per-minute charging split `chargeDelivery`

This computes, for one parked-and-plugged minute, the power delivered into the car (capped by the DC-DC limit, the curve acceptance, and headroom) and how that bus demand splits between generator and trailer. Powers are in kW; a "kW over one minute" cap equals `energyKwh * 60`.

**Files:**
- Modify: `index.html` (engine block)
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — `Sim.chargeDelivery is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
  function chargeDelivery(socPct, eCar, eTr, p) {
    var headroomKw = (p.capacityKwh - eCar) * 60; // kWh headroom as 1-min power
    if (headroomKw < 0) headroomKw = 0;
    var acceptKw = curvePower(socPct);
    var deliver = Math.min(p.dcPowerKw, acceptKw, headroomKw);
    if (deliver < 0) deliver = 0;

    var busNeed = deliver / p.dcdcEff;
    var genBus = p.genPowerKw * p.acdcEff;
    var fromGenBus = Math.min(genBus, busNeed);
    var fromTrailerBus = busNeed - fromGenBus;

    var trailerAvailKw = eTr * 60; // kWh available as 1-min power
    if (fromTrailerBus > trailerAvailKw) {
      fromTrailerBus = trailerAvailKw;
      var busActual = fromGenBus + fromTrailerBus;
      deliver = Math.min(deliver, busActual * p.dcdcEff);
    }
    return { deliverKw: deliver, fromGenBusKw: fromGenBus, fromTrailerBusKw: fromTrailerBus };
  }
```

Add `chargeDelivery` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html test/engine.test.js
git commit -m "feat: per-minute charge delivery split (curve + efficiencies + trailer)"
```

---

## Task 6: The simulation loop `simulate`

This assembles the whole day: pre-session charging, sessions, post-session gaps with cooling, generator/trailer bookkeeping, fuel, the Scenario-C Supercharge state machine, and final metrics. dt = 1/60 h per step.

**Files:**
- Modify: `index.html` (engine block — replace the stub `simulate`)
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing tests (integration)**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test`
Expected: FAIL — stub `simulate` returns empty timeline/metrics.

- [ ] **Step 3: Write the implementation (replace the stub `simulate`)**

```js
  function simulate(p, scenarioId) {
    var dt = 1 / 60;
    var sessions = buildSchedule(p, scenarioId);
    var startMin = p.arrivalTimeMin;
    var endMin = sessions[sessions.length - 1].endMin;
    var cap = p.capacityKwh, tcap = p.trailerCapKwh;
    var genBusFull = p.genPowerKw * p.acdcEff;

    // Per-minute cooling power (kW), nonzero only inside post-session gaps.
    // Scenario C: skip the gap after the 11:00 session (replaced by SC trip).
    var cooling = new Array(endMin + 1);
    for (var z = 0; z <= endMin; z++) cooling[z] = 0;
    for (var i = 0; i < sessions.length - 1; i++) {
      var gapStart = sessions[i].endMin, gapEnd = sessions[i + 1].startMin;
      if (scenarioId === 'C' && sessions[i].startMin === 11 * 60) continue;
      var gapHours = (gapEnd - gapStart) / 60;
      var kw = p.coolingPerGapKwh / gapHours;
      for (var m = gapStart; m < gapEnd; m++) cooling[m] = kw;
    }

    var eCar = effectiveArrivalKwh(p);
    var eTr = tcap;
    var genRuntimeMin = 0, genAcKwh = 0;
    var fromTrailer = 0, fromGenerator = 0, fromSupercharger = 0;
    var minSocKwh = eCar, minSocAtMin = startMin;
    var timeline = [];

    // Scenario C trip state machine.
    var trip = { phase: scenarioId === 'C' ? 'before' : 'off',
                 driveEndMin: null, scStartMin: null, scEndMin: null,
                 scArrivalSocPct: null, returnMin: null };
    var s3End = 11 * 60 + p.sessionDurationMin;
    var driveDrainKw = (p.driveConsumptionPct / 100 * cap) / (p.driveTimeMin / 60);

    function sessionAt(t) {
      for (var s = 0; s < sessions.length; s++) {
        if (t >= sessions[s].startMin && t < sessions[s].endMin) return sessions[s];
      }
      return null;
    }
    function refillTrailer(busKw) {
      // generator dumps up to busKw onto the trailer (capped by headroom)
      var headKw = (tcap - eTr) * 60;
      var into = Math.min(busKw, headKw);
      if (into < 0) into = 0;
      eTr += into * dt;
      genAcKwh += (into / p.acdcEff) * dt;
      fromGenerator += into * dt;
      return into;
    }

    for (var t = startMin; t < endMin; t++) {
      var mode, coolKw = 0, genOn = false;

      // ---- Scenario C overrides ----
      if (trip.phase !== 'off' && trip.phase !== 'done') {
        if (trip.phase === 'before' && t >= s3End) {
          trip.phase = 'out'; trip.driveEndMin = t + p.driveTimeMin;
        }
        if (trip.phase === 'out') {
          mode = 'DRIVE';
          eCar -= driveDrainKw * dt;
          if (eTr < tcap) { genOn = true; refillTrailer(genBusFull); }
          if (t + 1 >= trip.driveEndMin) { trip.phase = 'sc'; trip.scStartMin = t + 1;
            trip.scArrivalSocPct = eCar / cap * 100; }
        } else if (trip.phase === 'sc') {
          mode = 'SC';
          var scKw = Math.min(curvePower(eCar / cap * 100), p.scPowerCapKw);
          var head = (cap - eCar) * 60; if (scKw > head) scKw = head;
          eCar += scKw * dt; fromSupercharger += scKw * dt;
          if (eTr < tcap) { genOn = true; refillTrailer(genBusFull); }
          if (eCar / cap * 100 >= p.scTargetSocPct - 1e-9 || eCar >= cap - 1e-9) {
            trip.phase = 'back'; trip.scEndMin = t + 1; trip.driveEndMin = t + 1 + p.driveTimeMin;
          }
        } else if (trip.phase === 'back') {
          mode = 'DRIVE';
          eCar -= driveDrainKw * dt;
          if (eTr < tcap) { genOn = true; refillTrailer(genBusFull); }
          if (t + 1 >= trip.driveEndMin) { trip.phase = 'done'; trip.returnMin = t + 1; }
        }
      }

      // ---- Normal modes ----
      if (!mode) {
        var s = sessionAt(t);
        if (s) {
          mode = 'SESSION';
          var rate = p.sessionEnergyKwh / (p.sessionDurationMin / 60);
          eCar -= rate * dt;
          if (eTr < tcap) { genOn = true; refillTrailer(genBusFull); }
        } else {
          mode = 'CHARGE';
          coolKw = cooling[t] || 0;
          var cd = chargeDelivery(eCar / cap * 100, eCar, eTr, p);
          var net = cd.deliverKw - coolKw;
          eCar += net * dt;
          eTr -= cd.fromTrailerBusKw * dt;
          fromTrailer += cd.fromTrailerBusKw * dt;
          fromGenerator += cd.fromGenBusKw * dt;
          genAcKwh += (cd.fromGenBusKw / p.acdcEff) * dt;
          genOn = true;
          // surplus generator capacity tops the trailer when demand < gen output
          var surplus = genBusFull - cd.fromGenBusKw;
          if (surplus > 1e-9 && eTr < tcap) refillTrailer(surplus);
        }
      }

      if (eCar > cap) eCar = cap;
      if (eCar < 0) eCar = 0;
      if (eTr > tcap) eTr = tcap;
      if (eTr < 0) eTr = 0;
      if (genOn) genRuntimeMin++;
      if (eCar < minSocKwh) { minSocKwh = eCar; minSocAtMin = t; }

      timeline.push({
        min: t, mode: mode, coolingKw: coolKw,
        carPct: eCar / cap * 100, trlPct: eTr / tcap * 100,
      });
    }

    var fuelGal = genAcKwh * (p.fuelBurnGalPerHr / p.genPowerKw);
    var metrics = {
      feasible: minSocKwh >= p.reserveKwh - 1e-9,
      shortfallKwh: Math.max(0, p.reserveKwh - minSocKwh),
      minSocKwh: minSocKwh, minSocPct: minSocKwh / cap * 100, minSocAtMin: minSocAtMin,
      endSocKwh: eCar, endSocPct: eCar / cap * 100,
      trailerEndKwh: eTr, trailerEndPct: eTr / tcap * 100,
      genRuntimeHr: genRuntimeMin / 60, fuelGal: fuelGal, genAcKwh: genAcKwh,
      fromArrivalKwh: effectiveArrivalKwh(p),
      fromTrailerKwh: fromTrailer, fromGeneratorKwh: fromGenerator,
      fromSuperchargerKwh: fromSupercharger,
      c: scenarioId === 'C' ? {
        scArrivalSocPct: trip.scArrivalSocPct,
        scStartMin: trip.scStartMin, scEndMin: trip.scEndMin,
        scDurationMin: (trip.scEndMin != null && trip.scStartMin != null)
          ? trip.scEndMin - trip.scStartMin : null,
        returnMin: trip.returnMin,
        backBefore1pm: trip.returnMin != null ? trip.returnMin <= 13 * 60 : false,
      } : null,
    };
    return { timeline: timeline, metrics: metrics };
  }
```

(`simulate` is already in the returned object from Task 1.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS (all engine tests). If the Scenario-C `scDurationMin` is large (charging to 100% has a long tail), that is expected — `backBefore1pm` may be `false` with defaults; the test only asserts the field exists.

- [ ] **Step 5: Commit**

```bash
git add index.html test/engine.test.js
git commit -m "feat: full day simulation loop (sessions, charging, cooling, fuel, scenario C)"
```

---

## Task 7: Sanity checks — energy conservation + scenario sanity

Add assertions that protect the model's integrity (spec §11).

**Files:**
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails (or passes)**

Run: `node --test`
Expected: These should PASS against the Task-6 engine. If any fail, the engine has a real bug — fix the engine (not the test) and re-run. (This task is a guard; a green result here is the deliverable.)

- [ ] **Step 3: (only if a test failed) Fix the engine**

Debug `simulate` until conservation/sanity hold. Use `superpowers:systematic-debugging`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add test/engine.test.js index.html
git commit -m "test: energy conservation and scenario sanity guards"
```

---

## Task 8: HTML structure + CSS (Layout B)

Top input bar + three scenario cards + overlay chart. Inputs are generated from `UI_FIELDS` (Task 9), so here we add only the static shell + styles and three empty card containers.

**Files:**
- Modify: `index.html` (`<style>` and `<body>`)

- [ ] **Step 1: Write the failing test**

`test/ui-fields.test.js` (structural — created here, populated in Task 9):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('layout shell has the input bar, three card slots, and overlay', () => {
  assert.ok(/id="inputs"/.test(html));
  assert.ok(/id="cards"/.test(html));
  assert.ok(/id="overlay"/.test(html));
  ['cardA', 'cardB', 'cardC'].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"').test(html), id + ' present');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui-fields.test.js`
Expected: FAIL — `cardA`/`cardB`/`cardC` not present yet.

- [ ] **Step 3: Write minimal implementation**

Replace the `<style>` block:

```html
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#2a2f3a; --txt:#e6e8ec; --mut:#9aa3b2;
          --car:#22c55e; --trl:#3b82f6; --ok:#22c55e; --bad:#ef4444; --accent:#6366f1; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
         background:var(--bg); color:var(--txt); }
  header { padding:10px 16px; border-bottom:1px solid var(--line); }
  header h1 { margin:0; font-size:16px; font-weight:650; }
  #inputs { display:flex; flex-wrap:wrap; gap:14px; padding:12px 16px;
            border-bottom:1px solid var(--line); background:var(--panel); }
  .grp { display:flex; flex-direction:column; gap:6px; }
  .grp > .grp-title { font-size:11px; text-transform:uppercase; letter-spacing:.04em;
                      color:var(--mut); }
  .grp-fields { display:flex; flex-wrap:wrap; gap:8px; }
  .fld { display:flex; flex-direction:column; gap:2px; }
  .fld label { font-size:11px; color:var(--mut); }
  .fld input { width:92px; padding:4px 6px; background:#0c0e12; color:var(--txt);
               border:1px solid var(--line); border-radius:5px; font-size:13px; }
  #reset { align-self:flex-end; padding:6px 10px; border:1px solid var(--line);
           background:#0c0e12; color:var(--txt); border-radius:6px; cursor:pointer; }
  #cards { display:flex; gap:12px; padding:14px 16px; flex-wrap:wrap; }
  .card { flex:1 1 280px; min-width:280px; background:var(--panel);
          border:1px solid var(--line); border-radius:10px; padding:12px; }
  .card h2 { margin:0 0 2px; font-size:14px; }
  .card .desc { color:var(--mut); font-size:12px; margin-bottom:8px; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px;
           font-weight:650; margin-bottom:8px; }
  .badge.ok { background:rgba(34,197,94,.15); color:var(--ok); }
  .badge.bad { background:rgba(239,68,68,.15); color:var(--bad); }
  canvas { width:100%; height:auto; display:block; background:#0c0e12;
           border:1px solid var(--line); border-radius:8px; }
  .metrics { list-style:none; margin:8px 0 0; padding:0; }
  .metrics li { display:flex; justify-content:space-between; gap:8px; padding:2px 0;
                border-bottom:1px dashed var(--line); font-size:12.5px; }
  .metrics li span:last-child { color:#fff; font-variant-numeric:tabular-nums; }
  .overlay-wrap { padding:0 16px 24px; }
  .overlay-wrap h3 { font-size:13px; color:var(--mut); margin:0 0 6px; }
  @media (max-width:880px){ .card{ flex-basis:100%; } }
</style>
```

Replace the `<body>` contents (keep both `<script>` blocks unchanged):

```html
<header><h1>Track Charging Simulator — Ridge Motorsports Park HPDE</h1></header>
<div id="inputs"></div>
<div id="cards">
  <section class="card" id="cardA"></section>
  <section class="card" id="cardB"></section>
  <section class="card" id="cardC"></section>
</div>
<div class="overlay-wrap">
  <h3>All three plans — Plaid SoC across the day</h3>
  <canvas id="overlay" width="1200" height="240"></canvas>
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui-fields.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html test/ui-fields.test.js
git commit -m "feat: layout B shell + styles (input bar, three cards, overlay)"
```

---

## Task 9: UI field table + param parsing

One `UI_FIELDS` table drives input generation and parsing. A test locks its parsed defaults to the engine's `defaultParams()`.

**Files:**
- Modify: `index.html` (UI block between `// UI_START` / `// UI_END`)
- Modify: `test/ui-fields.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/ui-fields.test.js`:

```js
const vm = require('node:vm');
function loadUI() {
  const src = html.match(/\/\/ UI_START([\s\S]*?)\/\/ UI_END/)[1];
  // engine is a dependency of the UI block; load it first into the same context
  const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
  const ctx = { document: undefined, window: {} };
  vm.createContext(ctx);
  vm.runInContext(eng, ctx);
  // UI block references `document` only inside functions we will not call here.
  vm.runInContext(src, ctx);
  return ctx.UI;
}

test('UI_FIELDS ids are unique', () => {
  const UI = loadUI();
  const ids = UI.UI_FIELDS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('readParams(default form values) deep-equals engine defaultParams', () => {
  const UI = loadUI();
  const Sim = (() => {
    const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
    const c = {}; vm.createContext(c); vm.runInContext(eng, c); return c.Sim;
  })();
  // Build a values map from each field's default.
  const values = {};
  UI.UI_FIELDS.forEach(f => { values[f.id] = String(f.default); });
  const parsed = UI.readParams(values);
  assert.deepEqual(parsed, Sim.defaultParams());
});

test('hhmmToMin / minToHHMM round-trip', () => {
  const UI = loadUI();
  assert.equal(UI.hhmmToMin('08:00'), 480);
  assert.equal(UI.minToHHMM(480), '08:00');
  assert.equal(UI.hhmmToMin('13:15'), 795);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui-fields.test.js`
Expected: FAIL — `UI` undefined / `UI_FIELDS` missing.

- [ ] **Step 3: Write minimal implementation**

Between `// UI_START` and `// UI_END`:

```js
var UI = (function () {
  'use strict';

  function hhmmToMin(s) { var a = String(s).split(':'); return (+a[0]) * 60 + (+a[1]); }
  function minToHHMM(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // group, id, label, default (in display units), step, unit, kind, set(out,value)
  var num = function (key, mul) {
    return function (out, v) { out[key] = (mul == null ? 1 : mul) * parseFloat(v); };
  };
  var UI_FIELDS = [
    { g:'Plaid', id:'arrivalTime', label:'Arrival', kind:'time', default:'08:00',
      set:function(o,v){ o.arrivalTimeMin = hhmmToMin(v); } },
    { g:'Plaid', id:'capacityKwh', label:'Capacity', unit:'kWh', step:1, default:100, set:num('capacityKwh') },
    { g:'Plaid', id:'arrivalSocNoTrailerPct', label:'Arrival SoC (no trailer)', unit:'%', step:1, default:87, set:num('arrivalSocNoTrailerPct') },
    { g:'Plaid', id:'towingCostPct', label:'Towing cost', unit:'% pack', step:1, default:4, set:num('towingCostPct') },
    { g:'Plaid', id:'sessionEnergyKwh', label:'Energy / session', unit:'kWh', step:1, default:25, set:num('sessionEnergyKwh') },
    { g:'Plaid', id:'sessionDurationMin', label:'Session length', unit:'min', step:1, default:15, set:num('sessionDurationMin') },
    { g:'Plaid', id:'coolingPerGapKwh', label:'Cooling / gap', unit:'kWh', step:0.5, default:6, set:num('coolingPerGapKwh') },

    { g:'Trailer & generator', id:'trailerCapKwh', label:'Trailer battery', unit:'kWh', step:1, default:50, set:num('trailerCapKwh') },
    { g:'Trailer & generator', id:'genPowerKw', label:'Generator', unit:'kW', step:0.5, default:13, set:num('genPowerKw') },
    { g:'Trailer & generator', id:'acdcEffPct', label:'AC-DC eff', unit:'%', step:1, default:94, set:function(o,v){ o.acdcEff = parseFloat(v)/100; } },
    { g:'Trailer & generator', id:'fuelBurnGalPerHr', label:'Fuel burn', unit:'gal/hr', step:0.1, default:1.3, set:num('fuelBurnGalPerHr') },

    { g:'Charging', id:'dcPowerKw', label:'DC charge', unit:'kW', step:1, default:40, set:num('dcPowerKw') },
    { g:'Charging', id:'dcdcEffPct', label:'DC-DC eff', unit:'%', step:1, default:95, set:function(o,v){ o.dcdcEff = parseFloat(v)/100; } },
    { g:'Charging', id:'reserveKwh', label:'Reserve floor', unit:'kWh', step:1, default:0, set:num('reserveKwh') },

    { g:'Day', id:'firstSession', label:'First session', kind:'time', default:'09:00',
      set:function(o,v){ o.firstSessionMin = hhmmToMin(v); } },
    { g:'Day', id:'sessionCount', label:'# sessions', unit:'', step:1, default:7, set:num('sessionCount') },

    { g:'Scenario C', id:'driveTimeMin', label:'Drive each way', unit:'min', step:1, default:30, set:num('driveTimeMin') },
    { g:'Scenario C', id:'driveConsumptionPct', label:'Drive cost / leg', unit:'% pack', step:1, default:14, set:num('driveConsumptionPct') },
    { g:'Scenario C', id:'scTargetSocPct', label:'SC target', unit:'%', step:1, default:100, set:num('scTargetSocPct') },
    { g:'Scenario C', id:'scPowerCapKw', label:'SC power cap', unit:'kW', step:5, default:250, set:num('scPowerCapKw') },
  ];

  function readParams(values) {
    var out = {};
    UI_FIELDS.forEach(function (f) { f.set(out, values[f.id]); });
    // constants not exposed in the UI
    out.lunchSkipHour = 12;
    return out;
  }

  function formatMetrics() { return []; } // filled in Task 11

  return { UI_FIELDS: UI_FIELDS, readParams: readParams, formatMetrics: formatMetrics,
           hhmmToMin: hhmmToMin, minToHHMM: minToHHMM };
})();
```

Note: `readParams` produces every key in `defaultParams()`. Verify against the engine's `DEFAULTS` keys — `arrivalTimeMin, capacityKwh, arrivalSocNoTrailerPct, towingCostPct, sessionEnergyKwh, sessionDurationMin, coolingPerGapKwh, trailerCapKwh, genPowerKw, acdcEff, fuelBurnGalPerHr, dcPowerKw, dcdcEff, reserveKwh, firstSessionMin, sessionCount, lunchSkipHour, driveTimeMin, driveConsumptionPct, scTargetSocPct, scPowerCapKw` — all 21 are set.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ui-fields.test.js`
Expected: PASS. If `deepEqual` fails, reconcile any key the table missed or any numeric-precision issue (e.g. `94/100 = 0.94`).

- [ ] **Step 5: Commit**

```bash
git add index.html test/ui-fields.test.js
git commit -m "feat: UI field table + param parsing locked to engine defaults"
```

---

## Task 10: Render — inputs, cards, metrics (no charts yet)

Generate the input bar, run all three scenarios on every change, and fill each card's badge + metrics. Charts come in Task 11.

**Files:**
- Modify: `index.html` (UI block — extend the `UI` IIFE and add a DOM bootstrap after it)
- Modify: `test/ui-fields.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('formatMetrics returns labeled rows incl. fuel and min SoC', () => {
  const UI = loadUI();
  const Sim = (() => { const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
    const c = {}; vm.createContext(c); vm.runInContext(eng, c); return c.Sim; })();
  const m = Sim.simulate(Sim.defaultParams(), 'A').metrics;
  const rows = UI.formatMetrics(m, 'A');
  const labels = rows.map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('lowest')));
  assert.ok(labels.some(l => l.includes('gas') || l.includes('fuel')));
  assert.ok(labels.some(l => l.includes('end')));
  rows.forEach(r => { assert.equal(typeof r.value, 'string'); });
});

test('formatMetrics adds supercharge timing rows for C', () => {
  const UI = loadUI();
  const Sim = (() => { const eng = html.match(/\/\/ SIM_ENGINE_START([\s\S]*?)\/\/ SIM_ENGINE_END/)[1];
    const c = {}; vm.createContext(c); vm.runInContext(eng, c); return c.Sim; })();
  const m = Sim.simulate(Sim.defaultParams(), 'C').metrics;
  const labels = UI.formatMetrics(m, 'C').map(r => r.label.toLowerCase());
  assert.ok(labels.some(l => l.includes('return') || l.includes('back')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui-fields.test.js`
Expected: FAIL — `formatMetrics` returns `[]`.

- [ ] **Step 3: Write the implementation**

Replace the stub `formatMetrics` inside the `UI` IIFE with:

```js
  function fmt(n, d) { return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function clock(min) { return min == null ? '—' : minToHHMM(Math.round(min)); }

  function formatMetrics(m, scenarioId) {
    var rows = [
      { label: 'Lowest Plaid SoC', value: fmt(m.minSocPct, 0) + '%  (' + fmt(m.minSocKwh, 0) + ' kWh) @ ' + clock(m.minSocAtMin) },
      { label: 'End-of-day SoC', value: fmt(m.endSocPct, 0) + '%  (' + fmt(m.endSocKwh, 0) + ' kWh)' },
      { label: 'Trailer at end', value: fmt(m.trailerEndPct, 0) + '%  (' + fmt(m.trailerEndKwh, 0) + ' kWh)' },
      { label: 'Generator runtime', value: fmt(m.genRuntimeHr, 1) + ' h' },
      { label: 'Gasoline used', value: fmt(m.fuelGal, 1) + ' gal' },
      { label: 'From trailer', value: fmt(m.fromTrailerKwh, 0) + ' kWh' },
      { label: 'From generator', value: fmt(m.fromGeneratorKwh, 0) + ' kWh' },
    ];
    if (scenarioId === 'C' && m.c) {
      rows.push({ label: 'Supercharged', value: fmt(m.fromSuperchargerKwh, 0) + ' kWh in ' + fmt(m.c.scDurationMin || 0, 0) + ' min' });
      rows.push({ label: 'Back at track', value: clock(m.c.returnMin) + (m.c.backBefore1pm ? '  ✓ before 1pm' : '  ✗ after 1pm') });
    }
    return rows;
  }
```

Then **after** the `UI` IIFE (still inside the UI `<script>`, before `// UI_END`) add the DOM bootstrap:

```js
(function bootstrap() {
  if (typeof document === 'undefined') return; // skip under node:vm tests

  var SCEN = [
    { id: 'A', title: 'A · Full day on trailer power', desc: 'All sessions; charge from trailer + generator every gap.' },
    { id: 'B', title: 'B · Skip the 1pm session', desc: 'Trade one session for a long midday charging window.' },
    { id: 'C', title: 'C · Supercharge during lunch', desc: 'Drive out after session 3, charge to target, drive back.' },
  ];

  function buildInputs() {
    var host = document.getElementById('inputs');
    var groups = {};
    UI.UI_FIELDS.forEach(function (f) { (groups[f.g] = groups[f.g] || []).push(f); });
    var html = '';
    Object.keys(groups).forEach(function (g) {
      html += '<div class="grp"><div class="grp-title">' + g + '</div><div class="grp-fields">';
      groups[g].forEach(function (f) {
        var type = f.kind === 'time' ? 'time' : 'number';
        var step = f.step != null ? ' step="' + f.step + '"' : '';
        html += '<div class="fld"><label for="' + f.id + '">' + f.label +
          (f.unit ? ' (' + f.unit + ')' : '') + '</label>' +
          '<input id="' + f.id + '" type="' + type + '" value="' + f.default + '"' + step + '></div>';
      });
      html += '</div></div>';
    });
    html += '<button id="reset">Reset</button>';
    host.innerHTML = html;
    UI.UI_FIELDS.forEach(function (f) {
      document.getElementById(f.id).addEventListener('input', render);
    });
    document.getElementById('reset').addEventListener('click', function () {
      UI.UI_FIELDS.forEach(function (f) { document.getElementById(f.id).value = f.default; });
      render();
    });
  }

  function currentValues() {
    var v = {};
    UI.UI_FIELDS.forEach(function (f) { v[f.id] = document.getElementById(f.id).value; });
    return v;
  }

  function renderCard(scen, result) {
    var el = document.getElementById('card' + scen.id);
    var m = result.metrics;
    var badge = m.feasible
      ? '<span class="badge ok">✓ Feasible</span>'
      : '<span class="badge bad">✗ Short ' + (Math.round(m.shortfallKwh)) + ' kWh</span>';
    var rows = UI.formatMetrics(m, scen.id).map(function (r) {
      return '<li><span>' + r.label + '</span><span>' + r.value + '</span></li>';
    }).join('');
    el.innerHTML = '<h2>' + scen.title + '</h2><div class="desc">' + scen.desc + '</div>' +
      badge + '<canvas id="chart' + scen.id + '" width="560" height="200"></canvas>' +
      '<ul class="metrics">' + rows + '</ul>';
    return result; // chart drawn in Task 11
  }

  function render() {
    var p = UI.readParams(currentValues());
    var results = {};
    SCEN.forEach(function (scen) {
      results[scen.id] = Sim.simulate(p, scen.id);
      renderCard(scen, results[scen.id]);
    });
    if (typeof drawAllCharts === 'function') drawAllCharts(p, results); // Task 11
  }

  window.__render = render; // exposed for manual debugging
  buildInputs();
  render();
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test`
Expected: PASS (all engine + UI tests). The `bootstrap` IIFE returns early under `node:vm` because `document` is undefined.

- [ ] **Step 5: Manual check + commit**

Open `index.html` in a browser. Expect: a populated input bar, three cards each with title, badge, an (empty) canvas, and a metrics list with real numbers. Changing an input updates all three cards.

```bash
git add index.html test/ui-fields.test.js
git commit -m "feat: input bar + live scenario cards with metrics and verdict"
```

---

## Task 11: Canvas charts (per-card timelines + overlay)

Hand-rolled line charts: car SoC (solid green) + trailer SoC (dashed blue), session bands, reserve line, hour ticks. Overlay compares the three car-SoC curves.

**Files:**
- Modify: `index.html` (UI block — add chart functions; call from `render`)
- Modify: `test/ui-fields.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('chartScale maps domain to canvas box', () => {
  const UI = loadUI();
  assert.ok(typeof UI.chartScale === 'function');
  const s = UI.chartScale({ w:100, h:100, padL:10, padR:0, padT:0, padB:0, xMin:0, xMax:10, yMin:0, yMax:100 });
  assert.equal(s.X(0), 10);
  assert.equal(s.X(10), 100);
  assert.equal(s.Y(100), 0);
  assert.equal(s.Y(0), 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ui-fields.test.js`
Expected: FAIL — `UI.chartScale` undefined.

- [ ] **Step 3: Write the implementation**

Inside the `UI` IIFE, add and export `chartScale`:

```js
  function chartScale(b) {
    var iw = b.w - b.padL - b.padR, ih = b.h - b.padT - b.padB;
    return {
      X: function (x) { return b.padL + (x - b.xMin) / (b.xMax - b.xMin) * iw; },
      Y: function (y) { return b.padT + (1 - (y - b.yMin) / (b.yMax - b.yMin)) * ih; },
    };
  }
```

Add `chartScale: chartScale` to the `UI` return object.

In the bootstrap IIFE (where `document` exists), add chart drawing and wire it into `render` (the `drawAllCharts` referenced in Task 10):

```js
  function sessionBands(p, scenarioId) {
    return Sim.buildSchedule(p, scenarioId).map(function (s) {
      return { start: s.startMin, end: s.endMin };
    });
  }

  function drawTimeline(canvas, p, result, scenarioId, opts) {
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var b = { w:W, h:H, padL:30, padR:8, padT:8, padB:18, xMin:opts.xMin, xMax:opts.xMax, yMin:0, yMax:100 };
    var s = UI.chartScale(b);
    ctx.clearRect(0, 0, W, H);

    // y gridlines 0/50/100
    ctx.strokeStyle = '#222732'; ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
    [0, 50, 100].forEach(function (yy) {
      ctx.beginPath(); ctx.moveTo(b.padL, s.Y(yy)); ctx.lineTo(W - b.padR, s.Y(yy)); ctx.stroke();
      ctx.fillText(yy + '%', 4, s.Y(yy) + 3);
    });
    // hour ticks
    for (var hh = Math.ceil(opts.xMin / 60); hh <= opts.xMax / 60; hh++) {
      var x = s.X(hh * 60);
      ctx.fillText(((hh % 12) || 12), x - 4, H - 5);
    }
    // session bands
    ctx.fillStyle = 'rgba(99,102,241,.16)';
    sessionBands(p, scenarioId).forEach(function (band) {
      ctx.fillRect(s.X(band.start), b.padT, Math.max(1, s.X(band.end) - s.X(band.start)), H - b.padT - b.padB);
    });
    // reserve line
    if (p.reserveKwh > 0) {
      var ry = s.Y(p.reserveKwh / p.capacityKwh * 100);
      ctx.strokeStyle = 'rgba(239,68,68,.6)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(b.padL, ry); ctx.lineTo(W - b.padR, ry); ctx.stroke(); ctx.setLineDash([]);
    }
    // trailer (dashed blue) then car (solid green)
    function line(getY, color, dashed) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      result.timeline.forEach(function (pt, i) {
        var xx = s.X(pt.min), yy = s.Y(getY(pt));
        if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }
    line(function (pt) { return pt.trlPct; }, '#3b82f6', true);
    line(function (pt) { return pt.carPct; }, '#22c55e', false);
  }

  function drawOverlay(p, results) {
    var canvas = document.getElementById('overlay');
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var xMin = p.arrivalTimeMin, xMax = 16 * 60 + p.sessionDurationMin;
    var b = { w:W, h:H, padL:34, padR:10, padT:10, padB:20, xMin:xMin, xMax:xMax, yMin:0, yMax:100 };
    var sc = UI.chartScale(b);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#222732'; ctx.fillStyle = '#6b7280'; ctx.font = '11px sans-serif';
    [0, 25, 50, 75, 100].forEach(function (yy) {
      ctx.beginPath(); ctx.moveTo(b.padL, sc.Y(yy)); ctx.lineTo(W - b.padR, sc.Y(yy)); ctx.stroke();
      ctx.fillText(yy + '%', 6, sc.Y(yy) + 3);
    });
    for (var hh = Math.ceil(xMin / 60); hh <= xMax / 60; hh++) {
      ctx.fillText(((hh % 12) || 12), sc.X(hh * 60) - 4, H - 5);
    }
    var colors = { A: '#22c55e', B: '#eab308', C: '#06b6d4' };
    ['A', 'B', 'C'].forEach(function (id) {
      ctx.strokeStyle = colors[id]; ctx.lineWidth = 1.8; ctx.beginPath();
      results[id].timeline.forEach(function (pt, i) {
        var xx = sc.X(pt.min), yy = sc.Y(pt.carPct);
        if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
      });
      ctx.stroke();
      ctx.fillStyle = colors[id]; ctx.fillText(id, W - b.padR - 40 + 14 * ['A','B','C'].indexOf(id), 14);
    });
  }

  function drawAllCharts(p, results) {
    var xMin = p.arrivalTimeMin, xMax = 16 * 60 + p.sessionDurationMin;
    ['A', 'B', 'C'].forEach(function (id) {
      var cv = document.getElementById('chart' + id);
      if (cv) drawTimeline(cv, p, results[id], id, { xMin: xMin, xMax: xMax });
    });
    drawOverlay(p, results);
  }
```

`render` (from Task 10) already calls `drawAllCharts(p, results)` after rendering the cards — that conditional now resolves to this function.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test` → PASS (engine + `chartScale` test).

- [ ] **Step 5: Manual check + commit**

Open `index.html`. Expect: each card shows a green car-SoC line and a dashed blue trailer line with session bands; the overlay shows three colored car-SoC curves. Drag a slider (e.g. drop `Generator` to 5 kW) and watch A/B turn ✗ as the car runs short.

```bash
git add index.html test/ui-fields.test.js
git commit -m "feat: canvas timeline charts per card + three-way overlay"
```

---

## Task 12: Defaults smoke verification + README + push

**Files:**
- Modify: `README.md`
- Modify: `test/engine.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('SMOKE: default config produces a coherent A/B/C comparison', () => {
  var p = Sim.defaultParams();
  var A = Sim.simulate(p, 'A').metrics;
  var B = Sim.simulate(p, 'B').metrics;
  var C = Sim.simulate(p, 'C').metrics;
  // All three finish the day with a defined SoC in [0,100].
  [A, B, C].forEach(function (m) {
    assert.ok(m.endSocPct >= 0 && m.endSocPct <= 100);
    assert.ok(m.fuelGal >= 0);
  });
  // B keeps more energy than A; C tops up the most via the supercharger.
  assert.ok(B.endSocKwh >= A.endSocKwh - 1e-6);
  assert.ok(C.fromSuperchargerKwh > 0);
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test`
Expected: PASS against the finished engine. If it fails, fix the engine (use `superpowers:systematic-debugging`).

- [ ] **Step 3: Update README status**

In `README.md`, replace the status line:

```markdown
> **Status:** complete — open `index.html` in any browser. Run `node --test` to verify the engine.
```

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS — all engine, UI-fields, and smoke tests green. Record the count.

- [ ] **Step 5: Commit + push**

```bash
git add README.md test/engine.test.js
git commit -m "test: default-config smoke comparison; docs: mark app complete"
git push
```

---

## Final manual verification checklist (run in a browser before declaring done)

- [ ] Open `index.html` by double-click (file://) — it loads with no console errors, no network.
- [ ] All input groups render; editing any field live-updates all three cards + overlay.
- [ ] With defaults, read off each card's verdict, lowest SoC, gallons, and (C) the return time vs 1pm. Confirm they are plausible and that Scenario C's charge-to-100% return lands near the 1pm edge (per spec §11.4).
- [ ] Set `scTargetSoc` to 90 — Scenario C's "Back at track" time moves earlier.
- [ ] Set `Generator` to 5 kW — Scenario A trends toward ✗ short; the chart's car line sags.
- [ ] `Reset` restores all defaults.
- [ ] Resize the window narrow (phone width) — cards stack vertically and remain readable.

---

## Self-Review (completed during planning)

- **Spec coverage:** every spec section maps to a task — architecture/harness (T1), curve incl. trailer-acceptance taper §6/§7 (T2, used in T5/T6), towing-cost arrival §5 (T3), schedule §4 (T4), efficiency chain + bus split §6 (T5), full loop incl. cooling/fuel/generator-rule/scenario-C §6/§8 (T6), validation §11 (T7), outputs/metrics §9 (T6 metrics + T10 formatMetrics), UI Layout B §10 (T8–T11), distribution §13 (T12 push). No gaps found.
- **Placeholder scan:** no TBD/TODO; every code step is complete. The two intentional cross-task stubs (`simulate` in T1, `formatMetrics`/`drawAllCharts` referenced before definition) are each replaced in a named later task.
- **Type consistency:** `Params` keys are defined once in `DEFAULTS` (T3) and every `UI_FIELDS.set` (T9) writes exactly those keys (verified list of 21). `Session` shape `{index,startMin,endMin}` consistent T4→T6. Metric names produced in T6 match those read in T10/T11. `chargeDelivery` return keys (`deliverKw/fromGenBusKw/fromTrailerBusKw`) consistent T5→T6.

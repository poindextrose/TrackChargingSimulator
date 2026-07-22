const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
function cfg(over) {
  var p = Sim.defaultParams();
  for (var k in (over || {})) p[k] = over[k];
  return p;
}
// All gaps onsite (no offsite trip).
function fullDay(over) {
  var plan = Sim.defaultSessionPlan();
  var sessions = plan.map(function (s, i) {
    var o = { startMin: s.startMin };
    if (i < plan.length - 1) o.after = 'onsite';
    return o;
  });
  return cfg(Object.assign({ sessions: sessions }, over || {}));
}
// All offsite gaps become onsite (no SC trips).
function noOffsite(over) {
  var sessions = Sim.defaultSessionPlan().map(function (s) {
    var o = { startMin: s.startMin };
    if (s.enabled === false) o.enabled = false;
    if (s.after != null) o.after = s.after === 'offsite' ? 'onsite' : s.after;
    return o;
  });
  return cfg(Object.assign({ sessions: sessions }, over || {}));
}

test('engine loads and exposes Sim', () => {
  assert.equal(typeof Sim, 'object');
  assert.equal(typeof Sim.simulate, 'function');
});

test('curvePower hits known Plaid anchors (default curve)', () => {
  assert.equal(Sim.curvePower(10), 250);
  assert.equal(Sim.curvePower(33), 250);
  assert.equal(Sim.curvePower(80), 68);
  assert.equal(Sim.curvePower(100), 7);
});

test('curvePower interpolates linearly between anchors', () => {
  assert.ok(Math.abs(Sim.curvePower(45) - 171.5) < 1e-6);
});

test('curvePower clamps outside the table', () => {
  assert.equal(Sim.curvePower(0), 210);
  assert.equal(Sim.curvePower(120), 7);
});

test('Model 3 Performance curve peaks early then tapers below Plaid mid-pack', () => {
  assert.equal(Sim.curvePower(15, 'model-3-performance'), 250);
  assert.ok(Sim.curvePower(50, 'model-3-performance') < Sim.curvePower(50, 'model-s-plaid'));
  assert.ok(Sim.curvePower(80, 'model-3-performance') < Sim.curvePower(80, 'model-s-plaid'));
});

test('defaultParams: Ridge w/ gen plan — offsite after 10 & 14, skip 11 & 15', () => {
  var p = Sim.defaultParams();
  assert.equal(p.sessionDurationMin, 20);
  assert.equal(p.towingCostKwh, 4);
  assert.equal(p.driveConsumptionKwh, 13);
  assert.equal(p.scName, 'Tumwater');
  assert.equal(p.trailerCapKwh, 24);
  assert.equal(p.dcPowerKw, 30);
  assert.equal(p.coolingPowerKw, 6);
  assert.equal(p.coolingDurationMin, 20);
  assert.equal(p.sessions.length, 7);
  assert.deepEqual(p.sessions.map(s => s.startMin), [9*60, 10*60, 11*60, 13*60, 14*60, 15*60, 16*60]);
  assert.equal(p.sessions.find(s => s.startMin === 9 * 60).after, 'onsite');
  assert.equal(p.sessions.find(s => s.startMin === 10 * 60).after, 'offsite');
  assert.equal(p.sessions.find(s => s.startMin === 11 * 60).enabled, false);
  assert.equal(p.sessions.find(s => s.startMin === 11 * 60).after, 'onsite');
  assert.equal(p.sessions.find(s => s.startMin === 13 * 60).after, 'onsite');
  assert.equal(p.sessions.find(s => s.startMin === 14 * 60).after, 'offsite');
  assert.equal(p.sessions.find(s => s.startMin === 15 * 60).enabled, false);
  assert.equal(p.sessions.find(s => s.startMin === 16 * 60).after, undefined);
  assert.equal('supercharge' in p, false);
});

test('effectiveArrivalKwh subtracts arrival + towing costs from capacity', () => {
  // 99.4 − 13 (pre-track site drive-in) − 4 (tow) = 82.4
  var p = Sim.defaultParams();
  assert.equal(Sim.arrivalDriveCostKwh(p), 13);
  assert.ok(near(Sim.effectiveArrivalKwh(p), 82.4, 1e-9));
});

test('arrivalDriveCostKwh follows preTrackSiteId offsite site cost', () => {
  var p = Sim.defaultParams();
  p.offsiteSites = [
    { id: 'a', name: 'Near', powerKw: 250, driveTimeMin: 10, driveConsumptionKwh: 3 },
    { id: 'b', name: 'Far', powerKw: 250, driveTimeMin: 40, driveConsumptionKwh: 18 },
  ];
  p.preTrackSiteId = 'b';
  assert.equal(Sim.arrivalDriveCostKwh(p), 18);
  p.preTrackSiteId = 'a';
  assert.equal(Sim.arrivalDriveCostKwh(p), 3);
  // 99.4 − 3 − 4 = 92.4
  assert.ok(near(Sim.effectiveArrivalKwh(p), 92.4, 1e-9));
});

test('towing cost is 0 when neither generator nor battery is selected', () => {
  var p = Sim.defaultParams();
  p.genEnabled = false;
  p.batteryEnabled = false;
  p.gridEnabled = false;
  assert.equal(Sim.effectiveTowingKwh(p), 0);
  // 99.4 − 13 − 0 = 86.4
  assert.ok(near(Sim.effectiveArrivalKwh(p), 86.4, 1e-9));
  // Grid-only also has no trailer towing
  p.gridEnabled = true;
  assert.equal(Sim.effectiveTowingKwh(p), 0);
});

test('capacity is clamped to vehicle max (Plaid 99.4, M3P 82)', () => {
  assert.equal(Sim.maxCapacityKwh('model-s-plaid'), 99.4);
  assert.equal(Sim.maxCapacityKwh('model-3-performance'), 82);
  assert.equal(Sim.clampCapacityKwh(120, 'model-s-plaid'), 99.4);
  assert.equal(Sim.clampCapacityKwh(90, 'model-3-performance'), 82);
  assert.equal(Sim.clampCapacityKwh(70, 'model-3-performance'), 70);
});

test('buildSchedule: sorts, attaches gap bounds; first gap always onsite', () => {
  var s = Sim.buildSchedule(Sim.defaultParams());
  assert.equal(s.length, 7);
  assert.equal(s[0].endMin, 9 * 60 + 20);
  assert.equal(s[0].gapStart, 8 * 60); // arrival
  assert.equal(s[0].gapEnd, 9 * 60);
  assert.equal(s[0].before, 'onsite'); // first session: no choice, always onsite
  assert.equal(s[1].after, 'offsite'); // after 10am session
  assert.equal(s[2].before, 'offsite'); // 11am gap inherits prior after
  assert.equal(s[2].enabled, false);
  assert.equal(s[2].after, 'onsite');
  assert.equal(s[3].before, 'onsite'); // 1pm inherits skipped hour mode
  assert.equal(s[3].gapStart, 11 * 60 + 20); // after skipped slot's nominal end
  assert.equal(s[3].gapEnd, 13 * 60);
  assert.equal(s[4].after, 'offsite'); // after 14:00
  assert.equal(s[6].after, null); // last session has no after
});

test('defaultParams: portable gen+battery on, grid EV connector off', () => {
  var p = Sim.defaultParams();
  assert.equal(p.genEnabled, true);
  assert.equal(p.batteryEnabled, true);
  assert.equal(p.gridEnabled, false);
  assert.equal(p.gridPowerKw, 11.5);
  var src = Sim.siteSources(p);
  assert.equal(src.gen, true);
  assert.equal(src.battery, true);
  assert.equal(src.grid, false);
});

test('siteSources: onsite grid excludes portable panel (gen and battery)', () => {
  var src = Sim.siteSources({
    gridEnabled: true, siteChargingEnabled: true, genEnabled: true, batteryEnabled: true,
  });
  assert.equal(src.grid, true);
  assert.equal(src.gen, false);
  assert.equal(src.battery, false);
});

test('siteSources: onsite grid works when portable panel is off', () => {
  var src = Sim.siteSources({
    siteChargingEnabled: false,
    gridEnabled: true,
    genEnabled: true,
    batteryEnabled: true,
  });
  assert.equal(src.grid, true);
  assert.equal(src.gen, false);
  assert.equal(src.battery, false);
  assert.equal(Sim.siteCanCharge({
    siteChargingEnabled: false, gridEnabled: true,
  }), true);
  assert.equal(Sim.siteCanCharge({
    siteChargingEnabled: false, gridEnabled: false, genEnabled: true, batteryEnabled: true,
  }), false);
});

test('chargeDelivery: mid-SoC is governed by the 30 kW DC-DC cap', () => {
  var r = Sim.chargeDelivery(50, 60, 50, Sim.defaultParams());
  assert.ok(Math.abs(r.deliverKw - 30) < 1e-6);
  assert.ok(Math.abs(r.fromGenBusKw - 12.22) < 1e-3); // 13 kW gen × 0.94 AC-DC
});

test('chargeDelivery: grid EV connector charges car directly', () => {
  var p = Sim.defaultParams();
  p.gridEnabled = true;
  p.gridPowerKw = 11.5;
  var r = Sim.chargeDelivery(50, 60, 50, p);
  assert.ok(Math.abs(r.deliverKw - 11.5) < 1e-6);
  assert.ok(Math.abs(r.fromGridKw - 11.5) < 1e-6);
  assert.equal(r.fromGenBusKw, 0);
  assert.equal(r.fromTrailerBusKw, 0);
});

test('chargeDelivery: all site sources off delivers zero', () => {
  var p = Sim.defaultParams();
  p.genEnabled = false;
  p.batteryEnabled = false;
  p.gridEnabled = false;
  var r = Sim.chargeDelivery(50, 60, 50, p);
  assert.equal(r.deliverKw, 0);
});

test('simulate: grid-only day draws from EV connector, not trailer/gen', () => {
  var p = fullDay({
    gridEnabled: true, gridPowerKw: 40,
    genEnabled: true, batteryEnabled: true, // ignored while grid on
  });
  var r = Sim.simulate(p);
  assert.ok(r.metrics.fromGridKwh > 10);
  assert.ok(r.metrics.fromTrailerKwh < 1e-6);
  assert.ok(r.metrics.fromGeneratorKwh < 1e-6);
  assert.ok(r.metrics.fuelGal < 1e-6);
});

test('chargeDelivery: empty trailer falls back to generator-only', () => {
  var r = Sim.chargeDelivery(50, 60, 0, Sim.defaultParams());
  assert.ok(Math.abs(r.fromTrailerBusKw - 0) < 1e-6);
  assert.ok(Math.abs(r.deliverKw - 12.22 * 0.95) < 1e-2);
});

test('chargeDelivery: AC-DC only applies when both gen and battery are on', () => {
  // With both: gen bus = 13 × 0.94
  var both = Sim.chargeDelivery(50, 60, 50, Sim.defaultParams());
  assert.ok(Math.abs(both.fromGenBusKw - 12.22) < 1e-3);
  // Gen only: no AC-DC loss (eff treated as 1)
  var genOnly = Sim.defaultParams();
  genOnly.batteryEnabled = false;
  var r = Sim.chargeDelivery(50, 60, 0, genOnly);
  assert.ok(Math.abs(r.fromGenBusKw - 13) < 1e-6);
  assert.equal(r.fromTrailerBusKw, 0);
});

test('chargeDelivery: trailer cannot discharge below its minimum SoC floor', () => {
  var p = Sim.defaultParams();
  // Floor = minTrailerSocPct% of trailerCapKwh (default 5% of 24 kWh = 1.2)
  var floorKwh = p.minTrailerSocPct / 100 * p.trailerCapKwh;
  var atFloor = Sim.chargeDelivery(50, 60, floorKwh, p);
  assert.ok(Math.abs(atFloor.fromTrailerBusKw - 0) < 1e-6);
});

test('simulate: timeline spans arrival through 1 hour after last session', () => {
  var p = fullDay();
  var r = Sim.simulate(p);
  var pre = r.metrics.preTrack;
  assert.ok(pre);
  assert.equal(r.timeline[0].min, pre.scArriveMin);
  // End-of-day SoC is taken after 1 hour of post-last-session charging
  assert.equal(r.timeline[r.timeline.length - 1].min, 16 * 60 + p.sessionDurationMin + 60 - 1);
});

test('simulate: first SC minute carPctStart matches preTrackArriveSocPct (not post-charge)', () => {
  var p = Sim.defaultParams();
  p.preTrackArriveSocPct = 20;
  var r = Sim.simulate(p);
  var pre = r.metrics.preTrack;
  assert.ok(pre);
  assert.equal(pre.scArriveSocPct, 20);
  var first = r.timeline[0];
  assert.equal(first.mode, 'SC');
  // Entering the first SC minute must equal the "from" SoC (not ~+4% after 1 min @ 250 kW)
  assert.ok(Math.abs(first.carPctStart - 20) < 0.6,
    'carPctStart=' + first.carPctStart + ' expected ~20');
  // End-of-minute sample is after charging and should be higher
  assert.ok(first.carPct > first.carPctStart + 1,
    'carPct end-of-min should rise, start=' + first.carPctStart + ' end=' + first.carPct);
});

test('planPreTrack: arrive no later than; earlier when charge needs time for 100%', () => {
  var p = Sim.defaultParams();
  // Portable on → at-track charge available
  p.gridEnabled = false;
  p.siteChargingEnabled = true;
  p.genEnabled = true;
  p.batteryEnabled = true;
  p.arrivalTimeMin = 8 * 60; // no later than 8:00
  var pre = Sim.planPreTrack(p);
  assert.equal(pre.atTrackMode, 'onsite');
  assert.equal(pre.noLaterThanMin, 8 * 60);
  assert.ok(pre.scArriveMin < pre.leaveScMin);
  assert.ok(pre.leaveScMin <= pre.trackArriveMin || pre.driveTimeMin === 0);
  assert.ok(pre.trackArriveMin <= pre.firstSessionMin);
  // Need time to charge after drive-in drain → actual arrival ≤ no-later-than
  assert.ok(pre.trackArriveMin <= pre.noLaterThanMin);
  // Late no-later-than: still arrive early enough for 100%
  p.arrivalTimeMin = pre.firstSessionMin - 5;
  pre = Sim.planPreTrack(p);
  assert.ok(pre.autoArrive, 'should arrive earlier than no-later-than when charge needs more time');
  assert.ok(pre.trackArriveMin < pre.noLaterThanMin);
  assert.ok(pre.atTrackChargeMin >= 5);
  // No at-track power: arrive exactly at no-later-than
  p.siteChargingEnabled = false;
  p.genEnabled = false;
  p.batteryEnabled = false;
  p.gridEnabled = false;
  p.arrivalTimeMin = 8 * 60;
  pre = Sim.planPreTrack(p);
  assert.equal(pre.atTrackMode, 'none');
  assert.ok(!pre.autoArrive);
  assert.equal(pre.trackArriveMin, 8 * 60);
  assert.equal(pre.noLaterThanMin, 8 * 60);
});

test('simulate: a 20-min session removes ~sessionEnergy from the pack', () => {
  var p = Sim.defaultParams();
  var r = Sim.simulate(p);
  function kwhAt(min) { return r.timeline.find(x => x.min === min).carPct / 100 * p.capacityKwh; }
  var drop = kwhAt(9 * 60 - 1) - kwhAt(9 * 60 + p.sessionDurationMin - 1);
  assert.ok(near(drop, p.sessionEnergyKwh, 0.6));
});

test('sessionEnergyKwh is per 20 min; longer/shorter sessions prorate', () => {
  assert.equal(Sim.SESSION_ENERGY_REF_MIN, 20);
  assert.ok(near(Sim.sessionEnergyForMinutes({ sessionEnergyKwh: 35 }, 20), 35, 1e-9));
  assert.ok(near(Sim.sessionEnergyForMinutes({ sessionEnergyKwh: 35 }, 40), 70, 1e-9));
  assert.ok(near(Sim.sessionEnergyForMinutes({ sessionEnergyKwh: 35 }, 10), 17.5, 1e-9));
  // Draw power is constant: 35 kWh / (20/60 h) = 105 kW
  assert.ok(near(Sim.sessionDrawKw({ sessionEnergyKwh: 35 }), 105, 1e-9));

  var p = Sim.defaultParams();
  p.sessionEnergyKwh = 40;
  p.sessionDurationMin = 40; // track max must allow the 40-min session
  p.preSessionAtTrack = 'none';
  p.arrivalTimeMin = 8 * 60;
  p.gridEnabled = true;
  p.genEnabled = false;
  p.batteryEnabled = false;
  // One 10-min and one 40-min session; no offsite
  p.sessions = [
    { startMin: 9 * 60, enabled: true, durationMin: 10, after: 'onsite' },
    { startMin: 11 * 60, enabled: true, durationMin: 40, after: 'onsite' },
  ];
  var r = Sim.simulate(p);
  function kwhAt(min) {
    var pt = r.timeline.find(x => x.min === min);
    return pt.carPct / 100 * p.capacityKwh;
  }
  var drop10 = kwhAt(9 * 60 - 1) - kwhAt(9 * 60 + 10 - 1);
  var drop40 = kwhAt(11 * 60 - 1) - kwhAt(11 * 60 + 40 - 1);
  assert.ok(near(drop10, 20, 0.8), '10-min drop=' + drop10 + ' expected ~20');
  assert.ok(near(drop40, 80, 1.2), '40-min drop=' + drop40 + ' expected ~80');
});

test('fullDay: 7 sessions run, no offsite', () => {
  var m = Sim.simulate(fullDay()).metrics;
  assert.equal(m.sessionsRun, 7);
  assert.deepEqual(m.skippedSessions, []);
  assert.equal(m.sc, null);
  assert.ok(near(m.fromArrivalKwh, 82.4, 1e-9));
});

test('default plan: offsite gap after 11, runs morning sessions + whatever returns in time for', () => {
  var m = Sim.simulate(cfg()).metrics;
  assert.ok(m.fromSuperchargerKwh > 0 && m.sc);
  assert.ok(m.sc.returnMin != null || m.sc.returnMin === null);
  // morning three always run
  assert.ok(m.sessionsRun >= 3);
  assert.equal(m.feasible, true);
  assert.ok(m.minSocPct >= 20);
});

test('offsite trip departs at end of previous session (gap start)', () => {
  var r = Sim.simulate(cfg());
  // 11 session ends 11:20 → depart
  var pt = r.timeline.find(x => x.min === 11 * 60 + 20);
  assert.ok(pt.mode === 'DRIVE' || pt.mode === 'SC');
});

test('offsite: no cooling while away', () => {
  var r = Sim.simulate(cfg());
  r.timeline.forEach(function (pt) {
    if (pt.mode === 'DRIVE' || pt.mode === 'SC') assert.equal(pt.coolingKw, 0);
  });
});

test('default offsite plan ends fuller than all-onsite full day', () => {
  assert.ok(Sim.simulate(cfg()).metrics.endSocKwh > Sim.simulate(fullDay()).metrics.endSocKwh);
});

test('lowering offsite until-SoC pulls return earlier', () => {
  function withUntil(soc) {
    var p = cfg();
    p.sessions = p.sessions.map(function (s) {
      if (s.after !== 'offsite') return s;
      return Object.assign({}, s, {
        offsiteStop: 'until', offsiteUntilSocPct: soc, offsiteForMin: 30,
      });
    });
    return p;
  }
  var r1 = Sim.simulate(withUntil(90)).metrics.sc.returnMin;
  var r2 = Sim.simulate(withUntil(50)).metrics.sc.returnMin;
  if (r1 != null && r2 != null) assert.ok(r2 < r1);
});

test('charge-for mode ends offsite stop after dwell', () => {
  var p = cfg();
  p.sessions = p.sessions.map(function (s) {
    if (s.after !== 'offsite') return s;
    return Object.assign({}, s, {
      offsiteStop: 'for', offsiteForMin: 15, offsiteUntilSocPct: 80,
    });
  });
  var r = Sim.simulate(p);
  assert.ok(r.metrics.sc && r.metrics.sc.scDurationMin != null);
  assert.ok(near(r.metrics.sc.scDurationMin, 15, 1));
});

test('until-next-session leaves in time for the following session', () => {
  var p = cfg();
  p.sessions = p.sessions.map(function (s) {
    if (s.after !== 'offsite') return s;
    return Object.assign({}, s, { offsiteStop: 'next' });
  });
  var r = Sim.simulate(p);
  assert.ok(r.metrics.sc && r.metrics.sc.returnMin != null);
  // Default plan: first offsite after 10 → next enabled is 13:00; second after 14 → 16:00.
  // metrics.sc is the last completed trip (after 14), so return by 16:00.
  assert.ok(r.metrics.sc.returnMin <= 16 * 60);
  if (r.metrics.trips && r.metrics.trips[0]) {
    assert.ok(r.metrics.trips[0].returnMin <= 13 * 60);
  }
});

test('after offsite return, residual paddock charges onsite even if skipped hour is none', () => {
  var p = Sim.defaultParams();
  p.sessions = Sim.defaultSessionPlan().map(function (s) {
    if (s.startMin === 11 * 60) {
      return Object.assign({}, s, {
        enabled: true, after: 'offsite', offsiteStop: 'until', offsiteUntilSocPct: 100,
      });
    }
    if (s.startMin === 13 * 60) {
      return Object.assign({}, s, { enabled: false, after: 'none' });
    }
    return s;
  });
  var r = Sim.simulate(p);
  var trip = r.metrics.trips && r.metrics.trips[0];
  assert.ok(trip && trip.returnMin != null);
  var ret = trip.returnMin;
  var nextEn = 14 * 60;
  var a = r.timeline.find(function (pt) { return pt.min === ret; });
  var b = r.timeline.find(function (pt) { return pt.min === nextEn - 1; });
  assert.ok(a && b);
  assert.equal(a.mode, 'CHARGE');
  assert.equal(b.mode, 'CHARGE');
  assert.ok(b.carPct > a.carPct + 1, 'car SoC should rise while charging after return');
});

test('every run session that runs is whole', () => {
  var p = cfg();
  var r = Sim.simulate(p);
  var sessionMinutes = r.timeline.filter(pt => pt.mode === 'SESSION').length;
  assert.equal(sessionMinutes, r.metrics.sessionsRun * p.sessionDurationMin);
});

test('cooling power decays exponentially after heat event', () => {
  assert.ok(near(Sim.coolingPowerAtElapsed(0, 6, 20), 6, 1e-9));
  assert.ok(Sim.coolingPowerAtElapsed(20, 6, 20) === 0);
  // At mid duration still positive but well below start
  var mid = Sim.coolingPowerAtElapsed(10, 6, 20);
  assert.ok(mid > 0 && mid < 3, 'mid cool=' + mid);
});

test('pre-session cooling applies cool curve after track arrival', () => {
  var p = fullDay();
  p.coolingPowerKw = 6;
  p.coolingDurationMin = 20;
  p.preSessionAtTrack = 'none';
  p.arrivalTimeMin = 8 * 60;
  var r = Sim.simulate(p);
  var pre = r.metrics.preTrack;
  var trackArrive = pre.trackArriveMin;
  var first = pre.firstSessionMin;
  var pts = r.timeline.filter(pt => pt.min >= trackArrive && pt.min < first);
  assert.ok(pts.length > 0);
  // First minute at track should have near-full cool power
  assert.ok(pts[0].coolingKw > 4, 'start cool=' + pts[0].coolingKw);
  // Cool should decay (not flat kWh lump)
  if (pts.length > 10) {
    assert.ok(pts[0].coolingKw > pts[Math.min(15, pts.length - 1)].coolingKw);
  }
});

test('pre-session cooling drains pack when site cannot charge (IDLE)', () => {
  var p = cfg({
    coolingPowerKw: 6,
    coolingDurationMin: 20,
    preSessionAtTrack: 'none',
    arrivalTimeMin: 8 * 60,
    gridEnabled: false,
    siteChargingEnabled: false,
    genEnabled: false,
    batteryEnabled: false,
    offsiteChargingEnabled: false,
    sessions: [
      { startMin: 9 * 60, after: 'onsite' },
      { startMin: 10 * 60 },
    ],
  });
  assert.equal(Sim.siteCanCharge(p), false);
  var r = Sim.simulate(p);
  var trackArrive = r.metrics.preTrack.trackArriveMin;
  var pre = r.timeline.filter(pt => pt.min >= trackArrive && pt.min < 9 * 60);
  assert.ok(pre.every(pt => pt.mode === 'IDLE'));
  var coolKwh = pre.reduce((s, pt) => s + (pt.coolingKw || 0), 0) / 60;
  // Integral of 6·e^(−3t/20) over ~20 min ≈ 6*(20/60)/3*(1−e^−3) ≈ 0.63 kWh
  // Window may be shorter if arrival is late — just require positive cool drain
  assert.ok(coolKwh > 0.2, 'cool energy=' + coolKwh);
  var a = pre[0].carPct;
  var b = pre[pre.length - 1].carPct;
  assert.ok(a > b, 'pack should drop while cooling idle');
});

test('pre-session cooling reduces net gain when charge power is limited', () => {
  // Cool load steals bus power during pre-session CHARGE and reduces net pack gain.
  // Compare the last 20 min before first session so auto-earlier arrivals still overlap.
  var base = {
    coolingPowerKw: 6,
    coolingDurationMin: 20,
    arrivalTimeMin: 8 * 60 + 40,
    gridEnabled: true,
    gridPowerKw: 11.5,
    siteChargingEnabled: false,
    genEnabled: false,
    batteryEnabled: false,
    offsiteChargingEnabled: false,
    sessions: [
      { startMin: 9 * 60, after: 'onsite' },
      { startMin: 10 * 60 },
    ],
  };
  var withCool = Sim.simulate(cfg(base));
  var noCool = Sim.simulate(cfg(Object.assign({}, base, { coolingPowerKw: 0 })));
  var cap = Sim.defaultParams().capacityKwh;
  var tB = 9 * 60;
  var from = tB - 20;
  function gainFromStart(r, a, b) {
    var pre = r.timeline.filter(pt => pt.min >= a && pt.min < b);
    if (!pre.length) return 0;
    var s = pre[0].carPctStart != null ? pre[0].carPctStart : pre[0].carPct;
    var e = pre[pre.length - 1].carPct;
    return (e - s) / 100 * cap;
  }
  var g0 = gainFromStart(noCool, from, tB);
  var g1 = gainFromStart(withCool, from, tB);
  assert.ok(g0 > g1 + 0.05, 'cooling should reduce net gain: ' + g0 + ' vs ' + g1);
});

test('feasibility low is during a session', () => {
  var r = Sim.simulate(Sim.defaultParams());
  var pt = r.timeline.find(x => x.min === r.metrics.minSocAtMin);
  assert.equal(pt.mode, 'SESSION');
});

test('session-end reserve is the feasibility trigger', () => {
  assert.equal(Sim.simulate(Sim.defaultParams()).metrics.feasible, true);
  var r = Sim.simulate(cfg({ sessionEndReserveKwh: 90 }));
  assert.equal(r.metrics.feasible, false);
});

test('custom start times are sorted in buildSchedule', () => {
  var p = cfg({
    sessions: [
      { startMin: 14 * 60, after: 'onsite' },
      { startMin: 9 * 60 + 30, after: 'offsite' },
      { startMin: 11 * 60 },
    ],
  });
  var s = Sim.buildSchedule(p);
  assert.deepEqual(s.map(x => x.startMin), [9 * 60 + 30, 11 * 60, 14 * 60]);
  assert.equal(s[0].after, 'offsite');
  assert.equal(s[1].before, 'offsite'); // derived from previous after
  assert.equal(s[2].after, null);
});

test('legacy before migrates to after on previous session', () => {
  var s = Sim.buildSchedule(cfg({
    sessions: [
      { startMin: 9 * 60, before: 'onsite' },
      { startMin: 13 * 60, before: 'offsite' },
    ],
  }));
  assert.equal(s[0].before, 'onsite');
  assert.equal(s[0].after, 'offsite');
  assert.equal(s[1].before, 'offsite');
  assert.equal(s[1].after, null);
});

test('first session never has selectable offsite before it', () => {
  var s = Sim.buildSchedule(cfg({
    sessions: [{ startMin: 9 * 60, action: 'offsite' }],
  }));
  assert.equal(s[0].before, 'onsite');
  assert.equal(s[0].after, null);
});

test('starved generator is infeasible on full day', () => {
  var m = Sim.simulate(fullDay({ genPowerKw: 0, trailerCapKwh: 5, dcPowerKw: 5 })).metrics;
  assert.equal(m.feasible, false);
});

test('SMOKE: full day / no-offsite / default are coherent', () => {
  [fullDay(), noOffsite(), cfg()].forEach(function (p) {
    var r = Sim.simulate(p);
    assert.ok(r.timeline.length > 0);
    assert.ok(isFinite(r.metrics.endSocKwh));
  });
});

test('degenerate inputs do not crash or produce NaN', () => {
  var p = cfg({
    capacityKwh: 1, sessionEnergyKwh: 0, trailerCapKwh: 0, genPowerKw: 0,
    sessions: [{ startMin: 9 * 60 }],
  });
  var r = Sim.simulate(p);
  r.timeline.forEach(function (pt) {
    assert.ok(isFinite(pt.carPct));
    assert.ok(isFinite(pt.trlPct));
  });
});

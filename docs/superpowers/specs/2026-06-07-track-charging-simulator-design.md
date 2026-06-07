# Track Charging Simulator — Design Spec

**Date:** 2026-06-07
**Status:** Approved design, pending spec review → implementation plan

## 1. Purpose

A single-use planning tool to help size a portable DC charging trailer (LFP battery + gasoline generator) for charging a Tesla Model S Plaid during an HPDE track day at Ridge Motorsports Park, where there is no charging infrastructure. The Plaid tows the trailer in. The tool lets the user vary trailer/generator/charging parameters and see how three day-plan scenarios play out, so they can decide how big a battery and generator to build before committing to hardware.

This is a throwaway planning aid, not production software. Once the user picks a configuration, the tool's job is done.

## 2. Goals / Non-goals

**Goals**
- Model the Plaid's battery state of charge (SoC) minute-by-minute across a full track day.
- Compare three scenarios side by side: stay all day on trailer power (A), skip the 1pm session (B), Supercharge during lunch (C).
- Answer: "With config X, can I complete all my sessions? How much gas do I burn? How big must the trailer battery be?"
- Run entirely offline, on any device (Mac/iPad/phone), with zero install.

**Non-goals**
- No persistence, accounts, saving, or export beyond what the browser offers.
- No thermal/cell-level battery modeling beyond a single cooling-energy figure.
- No optimization solver — the user explores parameters manually.
- Not a real-time or on-track tool; it is used at the workbench while planning.

## 3. Architecture

A **single self-contained `index.html` file**: HTML + CSS + vanilla JavaScript, no external dependencies, no network calls, no build step. Charts are hand-rolled on `<canvas>` (no charting library) to keep the file small and fully offline. Double-click to open; edit inputs; everything recomputes live.

**Core = a 1-minute time-step simulation engine** (pure function: `simulate(params, scenario) → timeline + metrics`). The UI calls it three times (once per scenario) on every input change and re-renders.

Suggested internal structure (still one file, but logically separated):
- `MODEL` — constants, the Supercharger curve, the day schedule builder.
- `simulate(params, scenarioId)` — the engine.
- `render()` — reads inputs, runs all three scenarios, draws charts + metrics.
- Small canvas chart helper.

## 4. Day schedule (defaults)

Sessions are 15 min, start at the top of each hour, 7 total, no 12:00 session (lunch), last at 16:00.

| ID | Start | Window |
|----|-------|--------|
| S1 | 9:00  | 09:00–09:15 |
| S2 | 10:00 | 10:00–10:15 |
| S3 | 11:00 | 11:00–11:15 |
| —  | lunch | (no 12:00 session) |
| S4 | 13:00 | 13:00–13:15 |
| S5 | 14:00 | 14:00–14:15 |
| S6 | 15:00 | 15:00–15:15 |
| S7 | 16:00 | 16:00–16:15 |

- Simulation runs from **arrival (08:00)** to **end of last session (16:15)**.
- **Charging windows** = arrival→S1 plus every gap between consecutive sessions.
- The arrival→S1 window (08:00–09:00) is **pure charging, no cooling** (battery is cold).
- Every gap that *follows* a session gets one cooling lump (see §6).

Schedule is parameterized by first-session time, session count, lunch-skip hour, and session duration, but defaults reproduce the table above.

## 5. Parameters (inputs)

All live; changing any re-runs all three scenarios. Grouped in the top input bar.

### Plaid
| Param | Default | Unit | Notes |
|-------|---------|------|-------|
| Arrival time | 08:00 | clock | Start of charging |
| Plaid capacity | 100 | kWh | Usable pack; SoC% = energy / capacity; charge ceiling |
| Arrival SoC (no trailer) | 87 | % | SoC the Plaid would arrive at if driven in *without* the trailer |
| Towing energy cost | 4 | % of capacity | Extra battery spent towing the trailer in. Effective arrival SoC = 87 − 4 = **83% (83 kWh)** |
| Energy per session | 25 | kWh | Drawn from pack during a session (includes on-track cooling) |
| Session duration | 15 | min | |
| Cooling per gap | 6 | kWh | Track-mode cooling debited per post-session gap |

### Trailer & generator
| Param | Default | Unit | Notes |
|-------|---------|------|-------|
| Trailer battery capacity | 50 | kWh | LFP, starts at 100% SoC; treated as lossless |
| Generator power | 13 | kW | AC output at full load |
| AC-DC converter efficiency | 94 | % | Generator AC → DC bus |
| Generator fuel burn | 1.3 | gal/hr | At full (13 kW) load; fuel scales with actual output |

### Charging (trailer → car)
| Param | Default | Unit | Notes |
|-------|---------|------|-------|
| DC charge power | 40 | kW | DC-DC limit, **delivered into the car** |
| DC-DC efficiency | 95 | % | Bus draw = 40 / 0.95 ≈ 42.1 kW to deliver 40 kW |
| Reserve floor | 0 | kWh | Min car energy for "feasible" (adjustable) |

### Scenario C (Supercharge run)
| Param | Default | Unit | Notes |
|-------|---------|------|-------|
| Drive time each way | 30 | min | Used for timing the lunch window |
| Drive consumption per leg | 14 | % of capacity | Energy used driving to/from the Supercharger |
| Supercharge target SoC | 100 | % | Charge to this, then drive back |
| Supercharger power cap | 250 | kW | Clips the Plaid curve (e.g. 150 for a slower site) |

A "Reset to defaults" button restores all of the above.

## 6. Energy model

Units: kWh, kW, hours. Time step Δt = 1 min = 1/60 h.

### State variables (updated each minute)
- `E_car` ∈ [0, capacity] — Plaid pack energy; starts at **effective arrival energy** = `(arrivalSoCNoTrailer − towingCostPct)/100 × capacity` (default (87 − 4)% × 100 = 83 kWh).
- `E_tr` ∈ [0, trailerCap] — trailer battery energy; starts at trailerCap (100%).
- `genRuntimeMin` — minutes the generator was ON.
- `genAcKwh` — total AC energy generated.
- Per-source tallies: `fromTrailer`, `fromGenerator`, `fromSupercharger`.

### Efficiency chain
- Generator onto bus: `P_gen_bus = genPower × η_acdc` = 13 × 0.94 = **12.22 kW**.
- Car charging draws from bus: to deliver `P` into the car, bus must supply `P / η_dcdc`. At full 40 kW, bus draw = 40 / 0.95 = **42.11 kW**.
- Trailer battery: lossless (charge and discharge at 100%).

### Cooling
Track-mode cooling is debited as a **fixed lump of `coolingPerGap` (6 kWh) per post-session gap**, spread evenly across that gap as a continuous draw:
`P_cool = coolingPerGap / gapHours` kW, subtracted from the car pack throughout the gap.
- Applied to gaps following S1…S6 while the car is parked at the track.
- **Not** applied to the arrival→S1 window, the period after the final session, or (scenario C) the Supercharge trip.
- While the car is plugged in, cooling is covered by the DC-DC feed (so net pack gain = delivered charge − P_cool). If the car is parked but not charging (e.g. pack full), cooling discharges the pack directly.

### Per-minute logic
For each minute, classify the car's state:

**IN_SESSION** (minute inside a session window):
- Car discharges at `sessionEnergy / (sessionDuration/60)` kW. `E_car -= rate × Δt`.
- No car charging. Generator: ON if `E_tr < trailerCap`, refilling trailer at up to `P_gen_bus` (capped by headroom).

**CHARGING** (in a charging window, car parked & plugged):
- Target delivery to car = min(`dcPower` 40 kW, **`plaidCurve(SoC%)`** ← the car's DC charge-acceptance limit, headroom `(capacity − E_car)/Δt`). The curve only binds above ~90% SoC — below that the 40 kW DC-DC cap governs; near full, trailer charging tapers just as it would at a Supercharger.
- Generator ON (it is always useful here). Bus supply available = `P_gen_bus` + trailer discharge.
  - Bus needed for target = `delivered / η_dcdc`.
  - Generator supplies `P_gen_bus`; trailer supplies the remainder by discharging, capped by `E_tr`.
  - If trailer can't cover the remainder, `delivered` is reduced to what `(P_gen_bus + trailerAvail) × η_dcdc` allows (≤ 40).
- Net pack change: `E_car += (delivered − P_cool) × Δt`. (`P_cool` = 0 in the arrival→S1 window.)
- Trailer is discharging (not charging) while feeding the car. `fromTrailer += trailerDischarge × Δt`. `fromGenerator += P_gen_bus × Δt`.

**AWAY_DRIVE** (scenario C, the two 30-min legs):
- `E_car -= (driveConsumptionPct/100 × capacity) / (driveTime/60) × Δt` (i.e. the leg's energy spread over the drive time). No cooling, no trailer charging of the car.
- Trailer still refills off the generator if `E_tr < trailerCap`.

**AWAY_SC** (scenario C, at the Supercharger):
- `P = min(plaidCurve(SoC%), superchargerCap)`. `E_car += P × Δt`. `fromSupercharger += P × Δt`.
- Continue until `SoC% ≥ targetSoC` (or pack full). Record SC start/end time and duration.
- Trailer still refills off the generator.

**IDLE / END** (after the final session, or pack full with nothing to do):
- No car flow (except cooling discharge if applicable). Generator refills trailer if below 100%, else OFF.

### Generator run rule
Generator is **ON** whenever the car is charging **or** `E_tr < trailerCap`; otherwise **OFF** (saves fuel). It runs only as much as is useful.

### Fuel
Fuel is tied to actual AC energy generated, not just runtime:
`fuelGallons = genAcKwh × (fuelBurnGalPerHr / genPower)` = `genAcKwh × (1.3 / 13)` = `genAcKwh × 0.1` → **~0.1 gal per AC kWh (10 kWh/gal)**.
Where `genAcKwh` accumulates the generator's actual AC output each ON minute (`busContribution / η_acdc × Δt`). This scales fuel with load (less gas when only trickle-refilling the trailer).

## 7. Supercharger curve (Model S Plaid, V3 250 kW)

Cross-checked across InsideEVs, EVKX, findyourev, Recharged. Piecewise-linear lookup, SoC% → kW. Assumes a warm/preconditioned pack (the 30-min drive keeps it warm). Clip with `superchargerCap`.

This curve is used **both** for Supercharging (Scenario C) **and** as the Plaid's DC charge-acceptance ceiling when charging from the trailer — so trailer charging is `min(40 kW, curve(SoC))` and tapers near 100%. (Between sessions the pack is warm off the track, so the warm curve applies.)

```js
const PLAID_V3_CURVE = [
  [5, 210], [10, 250], [20, 250], [30, 250], [33, 250],
  [40, 195], [50, 148], [60, 120], [70, 95], [80, 68],
  [90, 42], [95, 27], [100, 7],
];
// Below 5%: clamp to ~180 kW. Linear-interpolate between anchors.
```

Sanity anchors from sources: peak 250 kW held ~10–33%; ~148 kW @ 50%; ~68 kW @ 80%; single-digit kW near 100%; 10→80% ≈ 28 min; 0→100% ≈ 60–80 min (the slow tail dominates). Interpolated mid-points (40/60/70/90%) are ±10%.

## 8. The three scenarios

- **A — Full day on trailer power.** All 7 sessions. Charge from trailer+generator in every gap. The 11:15→13:00 lunch gap is the big recovery window. Cooling lumps after S1–S6.
- **B — Skip the 1pm session (S4).** Sessions S1,S2,S3,S5,S6,S7 (six). One fewer 25 kWh draw, and a long 11:15→14:00 charging window. Cooling lumps after S1,S2,S3,S5,S6.
- **C — Supercharge during lunch.** After S3 (11:15): drive 30 min (−14%), Supercharge to target SoC along the Plaid curve, drive 30 min back (−14%), resume S4–S7. Trailer just refills off the generator while away. The engine computes the real SC duration and the **return time vs the 1pm session**, and flags if you'd be late. No cooling during the away period; cooling lumps after S1,S2,S4,S5,S6.

## 9. Outputs / metrics

Per scenario:
- **Timeline chart** — x: 08:00→16:15; y: SoC %. Car SoC (solid line) and trailer SoC (dashed line). Session windows as shaded bands; reserve floor as a horizontal line. Scenario C additionally shades the drive/Supercharge period.
- **Verdict badge** — ✅ feasible if `min(E_car) ≥ reserveFloor` for the whole day (car never lacks energy to finish a session); ❌ otherwise, annotated with the shortfall (kWh below floor) and when it first occurs.
- **Key numbers:** lowest car SoC (% and kWh) and when; end-of-day car SoC; trailer end SoC; generator runtime (h); **gasoline used (gal)**; AC kWh generated; energy sourced from {arrival / trailer / generator / supercharger}.
- **Scenario C extras:** SoC at Supercharger arrival, Supercharge duration, departure & return clock times, and a "back before 1pm?" indicator.

Plus one **full-width overlay chart**: the three car-SoC curves on shared axes, color-coded, with session bands — the at-a-glance comparison.

## 10. UI layout (Layout B — top input bar)

- **Top input bar:** the parameter groups from §5 as labeled, compact field groups (number inputs; sliders optional for the most-played-with values). Groups can be collapsible to manage density. A "Reset to defaults" button.
- **Three scenario cards** in a row (A / B / C): title + one-line description, verdict badge, timeline chart, key-numbers list.
- **Overlay chart** full-width beneath the three cards.
- Responsive: on narrow screens the input groups and the three cards stack vertically.

## 11. Validation / sanity checks (for implementation)

Build these as quick assertions or a debug panel:
1. **Energy conservation:** `ΔE_car + ΔE_tr` over any interval ≈ `(charge delivered) − (sessions) − (cooling) + (supercharger) − (drive)`, within rounding.
2. **Caps respected:** `E_car ≤ capacity`, `E_tr ≤ trailerCap`, both ≥ 0; delivered charge ≤ 40 kW car-side.
3. **Default-config smoke test:** with defaults, Scenario A should show the car slowly declining session-to-session with a strong lunch recovery; record the min SoC and whether it stays feasible.
4. **Scenario C timing:** with target 100% and defaults, verify the computed return time lands near/just after 13:00 (the design expectation that 100% is right at the lunch-window edge), and that lowering target to ~90% pulls it comfortably earlier.
5. **Fuel reasonableness:** generator at ~12 kW for several hours → on the order of ~5–10 gal/day; flag if wildly off.

## 12. Assumptions (open to revision)

- Plaid usable capacity 100 kWh; arrival SoC 87% without the trailer, minus a 4%-of-capacity towing cost → **83 kWh effective arrival**.
- The Plaid V3 curve doubles as the car's DC charge-acceptance limit, so trailer charging also tapers near 100% (`min(40 kW, curve)`).
- Session energy (25 kWh) includes on-track cooling; cooling between sessions is a flat 6 kWh/gap.
- Generator AC output 13 kW at full load; AC-DC converter 94%; fuel 10 kWh/gal (1.3 gal/hr).
- Trailer LFP battery lossless (no separate round-trip efficiency).
- Supercharger curve is for a warm pack at a 250 kW V3 site; no cold-pack derate.
- Drive legs consume 14% of pack each; no cooling load while driving (Track Mode effectively off on the highway).
- Generator runs only when useful (car charging or trailer < 100%).

## 13. Distribution

Published to a new **private** GitHub repository (`TrackChargingSimulator`) under the `poindextrose` account. The app is the single `index.html` at the repo root — clone and open it directly in any browser (Mac / iPad / phone). The spec lives under `docs/`.

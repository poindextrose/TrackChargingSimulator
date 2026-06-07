# Track Charging Simulator — Design Spec

**Date:** 2026-06-07
**Status:** Approved design, pending spec review → implementation plan

## 1. Purpose

A single-use planning tool to help size a portable DC charging trailer (LFP battery + gasoline generator) for charging a Tesla Model S Plaid during an HPDE track day at Ridge Motorsports Park, where there is no charging infrastructure. The Plaid tows the trailer in. The tool lets the user vary trailer/generator/charging parameters and see how three day-plan scenarios play out, so they can decide how big a battery and generator to build before committing to hardware.

This is a throwaway planning aid, not production software. Once the user picks a configuration, the tool's job is done.

## 2. Goals / Non-goals

**Goals**
- Model the Plaid's battery state of charge (SoC) minute-by-minute across a full track day.
- Model one configurable day plan: skip any session(s) and/or run a Supercharger trip after session 3, and see the effect on SoC, feasibility, and gas. (The old "stay all day / skip the 1pm / Supercharge at lunch" plans are just three configurations of this.)
- Answer: "With config X, can I complete all my sessions? How much gas do I burn? How big must the trailer battery be?"
- Run entirely offline, on any device (Mac/iPad/phone), with zero install.

**Non-goals**
- No persistence, accounts, saving, or export beyond what the browser offers.
- No thermal/cell-level battery modeling beyond a single cooling-energy figure.
- No optimization solver — the user explores parameters manually.
- Not a real-time or on-track tool; it is used at the workbench while planning.

## 3. Architecture

A **single self-contained `index.html` file**: HTML + CSS + vanilla JavaScript, no external dependencies, no network calls, no build step. Charts are hand-rolled on `<canvas>` (no charting library) to keep the file small and fully offline. Double-click to open; edit inputs; everything recomputes live.

**Core = a 1-minute time-step simulation engine** (pure function: `simulate(params) → timeline + metrics`). The UI calls it once on every input change and re-renders the single result panel.

Suggested internal structure (still one file, but logically separated):
- `MODEL` — constants, the Supercharger curve, the day schedule builder.
- `simulate(params, scenarioId)` — the engine.
- `render()` — reads inputs, runs the simulation, draws the chart + metrics.
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
- The arrival→S1 window (08:00–09:00) carries a separate **pre-session cooling lump** (`preSessionCooling`, default 5 kWh) for heat carried in from the drive/tow, then charges.
- Every gap that *follows* a session gets one cooling lump (see §6).

Schedule is parameterized by first-session time, session count, lunch-skip hour, and session duration, but defaults reproduce the table above.

## 5. Parameters (inputs)

All live; changing any re-runs the simulation. Grouped in the top input bar. Plus two checkbox groups: **Supercharge after session 3** (one toggle) and **Skip sessions** (one toggle per session).

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
| Pre-session cooling | 5 | kWh | Cooling lump over the arrival→first-session window (heat from the drive/tow in) |

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

### Supercharge run (when the "Supercharge after session 3" toggle is on)
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
Track-mode cooling is debited as fixed lumps, each spread evenly across its window as a continuous draw (`P_cool = lump / windowHours`, subtracted from the car pack throughout):
- A **pre-session lump** (`preSessionCooling`, default 5 kWh) over the arrival→first-session window — heat carried in from the drive/tow.
- A **per-gap lump** of `coolingPerGap` (default 6 kWh) in each post-session gap (gaps following S1…S6), while the car is parked at the track.
- **Not** applied to the period after the final session, or (scenario C) the Supercharge trip.
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
- Net pack change: `E_car += (delivered − P_cool) × Δt`. (`P_cool` carries the pre-session lump in the arrival→S1 window.)
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
// Below 5%: clamp to the 5% anchor (210 kW). Linear-interpolate between anchors.
```

Sanity anchors from sources: peak 250 kW held ~10–33%; ~148 kW @ 50%; ~68 kW @ 80%; single-digit kW near 100%; 10→80% ≈ 28 min; 0→100% ≈ 60–80 min (the slow tail dominates). Interpolated mid-points (40/60/70/90%) are ±10%.

## 8. The configurable day plan

A single day plan, shaped by checkbox controls (defaults reproduce "full day on trailer power"). `simulate(params)` runs one plan; `buildSchedule(params)` returns all sessions, each tagged `skipped` from its per-session toggle.

- **Skip any session.** Each of the 7 sessions has a skip toggle. A skipped session draws no energy and incurs no cooling; the car charges in that slot instead. (Checking the 1pm/S4 skip reproduces the old "skip the 1pm session" plan: one fewer 25 kWh draw, and a long 11:15→14:00 charging window.)
- **Supercharge after session 3.** After S3 (11:15): drive 30 min (−14%), Supercharge to target SoC along the Plaid curve, drive 30 min back (−14%), resume. The session(s) you're away for are **skipped automatically** (the 1pm/S4 by default); the trailer refills off the generator while away. The engine computes the real SC duration, the return time, and exactly which sessions the trip cost you. No cooling during the away trip.

Cooling lumps apply after each session the car **actually runs** (plus the pre-session lump before the first run session); the supercharge away-trip gap gets no lump. With nothing skipped and no supercharge this is the full 7-session day; the old "A/B/C" are just three points in this configuration space.

## 9. Outputs / metrics

A single result panel:
- **Timeline chart** — x: 08:00→last session end; y: SoC %. Plaid SoC (solid green) and trailer SoC (dashed blue). Sessions that run are solid bands; skipped sessions (manual or supercharge-away) are hollow dashed bands; reserve floor as a horizontal line. Hover anywhere to read the time, Plaid SoC (% and kWh), and trailer SoC at that minute.
- **Verdict badge** — ✅ feasible if `min(E_car) ≥ reserveFloor` for the whole day; ❌ otherwise, annotated with the shortfall (kWh below floor).
- **Key numbers:** lowest Plaid SoC (% and kWh) and when; end-of-day SoC; trailer end SoC; **sessions run (of total)**; generator runtime (h); **gasoline used (gal)**; energy from {trailer / generator}; the list of **skipped sessions** (each tagged manual or `(SC)`). When supercharging: energy supercharged + duration, and the return time.

## 10. UI layout (top input bar + single result panel)

- **Top input bar:** the parameter groups from §5 as labeled, compact field groups, plus a **Supercharge** group (the "Supercharge after session 3" toggle + SC params) and a **Skip sessions** group (a checkbox per session, labeled by start time: 9:00 … 4:00). A "Reset to defaults" button. All inputs, including checkbox state, persist to localStorage.
- **Single result panel** beneath: the verdict badge, the full-width timeline chart, and a responsive grid of the key numbers.
- Responsive: on narrow screens the input groups and metrics reflow.

## 11. Validation / sanity checks (for implementation)

Build these as quick assertions or a debug panel:
1. **Energy conservation:** `ΔE_car + ΔE_tr` over any interval ≈ `(charge delivered) − (sessions) − (cooling) + (supercharger) − (drive)`, within rounding.
2. **Caps respected:** `E_car ≤ capacity`, `E_tr ≤ trailerCap`, both ≥ 0; delivered charge ≤ 40 kW car-side.
3. **Default-config smoke test:** with defaults, Scenario A should show the car slowly declining session-to-session with a strong lunch recovery; record the min SoC and whether it stays feasible.
4. **Supercharge timing:** with the supercharge toggle on, target 100% and defaults, verify the computed return time lands ~13:09 (just after 1pm, so S4 is the skipped-away session), and that lowering the target pulls it earlier so nothing is skipped.
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

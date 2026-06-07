# Track Charging Simulator

A single-file, fully offline planning tool for sizing a portable DC fast-charging
trailer (LFP battery + gasoline generator) used to charge a Tesla Model S Plaid during
HPDE track days where there is no charging infrastructure. The Plaid tows the trailer in.

The tool models the Plaid's state of charge minute-by-minute across a track day for one
configurable day-plan. Two checkbox controls shape the day:

- **Supercharge after session 3** — drive to a Supercharger after the third session, charge to a target SoC, and drive back; the session you're away for (the 1pm by default) is skipped automatically.
- **Skip any session** — a checkbox per session (9:00 … 4:00) drops that session: no energy drawn, no cooling, the car charges in that slot instead.

With both off you get the full day on trailer power; check "skip 1:00" to trade a session
for a long midday charging window; check "Supercharge after session 3" for the Supercharger
run. You vary the parameters (battery size, generator power, charge rate, efficiencies,
fuel burn, towing/cooling cost, etc.) and watch how SoC, feasibility, and gas usage change —
so you can decide what to build before committing to hardware.

## Usage

Open `index.html` in any browser (Mac / iPad / phone). No install, no server, no
network connection required. Adjust the inputs (and the supercharge / skip checkboxes) and
the day recomputes live. Your inputs are saved in the browser, so a refresh keeps them;
**Reset** returns to defaults. Hover the chart to read the Plaid and trailer state of charge
at that moment; skipped sessions show as hollow (dashed) bands.

## Design

The full energy model, the Model S Plaid Supercharger charge curve, and the simulation
algorithm are documented in
[`docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md`](docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md).

> **Status:** complete — open `index.html` in any browser. Run `node --test` to verify the engine and UI logic.

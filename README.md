# Track Charging Simulator

A single-file, fully offline planning tool for sizing a portable DC fast-charging
trailer (LFP battery + gasoline generator) used to charge a Tesla Model S Plaid during
HPDE track days where there is no charging infrastructure. The Plaid tows the trailer in.

The tool models the Plaid's state of charge minute-by-minute across a track day and
compares three day-plans side by side:

- **A — Full day on trailer power** — run all 7 sessions on what the trailer battery + generator can supply.
- **B — Skip the 1pm session** — trade one session for a long midday charging window.
- **C — Supercharge during lunch** — drive to a Supercharger over lunch while the trailer tops itself off.

You vary the parameters (battery size, generator power, charge rate, efficiencies,
fuel burn, towing cost, etc.) and watch how each scenario's SoC, feasibility, and gas
usage change — so you can decide what to build before committing to hardware.

## Usage

Open `index.html` in any browser (Mac / iPad / phone). No install, no server, no
network connection required. Adjust the inputs and all three scenarios recompute live.
Your inputs are saved in the browser, so a refresh keeps them; **Reset** returns to defaults.

## Design

The full energy model, the Model S Plaid Supercharger charge curve, and the simulation
algorithm are documented in
[`docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md`](docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md).

> **Status:** complete — open `index.html` in any browser. Run `node --test` to verify the engine and UI logic.

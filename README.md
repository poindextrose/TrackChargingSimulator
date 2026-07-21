# Track Charging Simulator

A single-file, fully offline planning tool for sizing portable DC fast-charging
(trailer battery + generator) and/or onsite EV connectors used to charge a Tesla
(Plaid, Model 3 Performance, or custom) during HPDE track days.

Model car state of charge minute-by-minute across a configurable track day plan
with **onsite**, **portable**, and **offsite** charging options between sessions.

**Live site:** https://poindextrose.github.io/TrackChargingSimulator/

## Defaults

Shipped with example profiles (export `track-charging-profiles-2026-07-21.json`):

| Kind | Profiles |
|------|----------|
| **EV** | My Plaid, Tesla Model 3 Performance |
| **Track** | Ridge Motorsports Park (default), Qlispe Raceway Park, Example track with wall connector |
| **Portable** | Trailer battery + generator (default), Generator + wall connector, 9.6kW connector |

## Usage

Open `index.html` in any browser (Mac / iPad / phone), or use the live site above.
No install or network required for local use.

- Adjust car, track, and portable profiles; the day recomputes live
- Inputs and profiles are saved in the browser; **Reset** reloads the active profile
- **Export / Import** shares profile packs as JSON
- Hover the chart for SoC at any minute; the session table shows per-block SoC ranges

## Development

```bash
node --test
```

Design notes: [`docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md`](docs/superpowers/specs/2026-06-07-track-charging-simulator-design.md).

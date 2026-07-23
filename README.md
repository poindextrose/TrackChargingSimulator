> **Source of truth:** private monorepo [PlaidModifications](https://github.com/poindextrose/PlaidModifications) → `apps/track-charging/`. This public repo is the **GitHub Pages deploy mirror** only. Last sync: `8ed13d5`.
>
> Publish: `./scripts/publish-track-charging.sh` from the monorepo root.

# Track Charging Simulator

A single-file, fully offline planning tool for sizing portable DC fast-charging
(trailer battery + generator) and/or onsite EV connectors used to charge a Tesla
(Plaid, Model 3 Performance, or custom) during HPDE track days.

Model car state of charge minute-by-minute across a configurable track day plan
with **onsite**, **portable**, and **offsite** charging options between sessions.

**Live site:** https://poindextrose.github.io/TrackChargingSimulator/

**Source of truth:** this monorepo package (`apps/track-charging/`).  
**Public deploy mirror:** [poindextrose/TrackChargingSimulator](https://github.com/poindextrose/TrackChargingSimulator) (GitHub Pages).

To publish after monorepo changes:

```bash
# from monorepo root
./scripts/publish-track-charging.sh
```

## Defaults

Shipped with example profiles (export `track-charging-profiles-2026-07-22.json`):

| Kind | Profiles |
|------|----------|
| **EV** | My Plaid (default), Random Model 3 |
| **Track** | The Ridge w/ gen (default), The Ridge, The Ridge w/ gen+battery, Area 27, Qlispe Raceway Park, Pacific Raceway |
| **Portable** | Generator @ 11.5kw (default), Trailer battery/gen |

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

# AI Evaluation And Seeded Simulation Guide

This document is for coding models and developers changing player intelligence.
Treat visual inspection as useful diagnosis, not evidence that a change improved
the simulation. Use seeded batch runs before and after behavioral work.

## Why Seeded Runs Exist

Player attributes, manager instructions, pass error, shots, tackles and movement
choice noise are randomized. Without a fixed random stream, changing one scoring
constant and then watching a match compares two different matches.

`src/random.ts` owns the random source:

- `setSeed(seed)` installs a repeatable PRNG stream.
- `random()`, `randomInt()` and `shuffle()` consume that stream.
- Simulation code must use these helpers, never call `Math.random()` directly.

The deterministic guarantee is: identical source code, inputs and seed produce
identical output. Adding a new random draw intentionally changes later draws,
so compare behavior using a new baseline after such a code change.

## Commands

Fast regression comparison:

```powershell
npm.cmd run batch -- --matches 5 --minutes 5 --seed 101
```

Longer benchmark:

```powershell
npm.cmd run benchmark
```

Verify deterministic execution after editing random or loop-order code:

```powershell
$a = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$b = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$a -ceq $b
```

Repeatable visual match:

```powershell
$env:SIM_SEED='101'; npm.cmd run server
```

The browser setup controls are forwarded to the server when the first match is
started. Overlap, midfield freedom and line height therefore affect the
rendered match as well as batch experiments.

Run controlled tactical comparisons for both teams:

```powershell
npm.cmd run batch -- --matches 5 --minutes 5 --seed 101 --overlap 80 --midfield 70 --line 60
```

The override flags are `--overlap`, `--midfield` and `--line`, each from 0 to
100. With no overrides, managers receive seeded tactical instructions.

## Measurement Workflow

1. Run `npm.cmd run build`.
2. Capture a seeded batch baseline before the behavior change.
3. Make one coherent intelligence change.
4. Rerun the same seeds and compare aggregate output plus per-match outliers.
5. Reproduce bad seeds individually, for example `--matches 1 --minutes 5 --seed 104`.
6. Use debug events to identify the mechanism before adjusting thresholds.
7. Keep a change only when it fixes the diagnosed mechanism without introducing
   a worse seeded regression.

Useful aggregate output:

| Metric | What it diagnoses |
| --- | --- |
| Pass completion and intercepted passes | Risk selection, receiving pressure and disruption |
| Through-ball attempts/completion | Whether runners are actually being released |
| Shots, on-target percentage, saves, conversion | Shot choice and keeper credibility |
| Offsides | Timing/line behavior, not a goal to maximize |
| Territory and possession | Stagnation or one-sided lockups |
| Tactical activity | Whether assignments reach agent execution |
| Quality flags | Known failure modes needing a seed-specific replay |

## Interpreting Quality Flags

Flags are alarms, not automatically defects. A single `no_shots` flag may be
plausible; repeated `ball_stationary_in_play`, `player_stuck` or
`defensive_line_absent` flags usually warrant immediate replay of that seed.

Examples of defects found by this process:

- A pass could stop far from every player because the intended receiver cached
  a pre-pass perception snapshot and never chased the live ball.
- A pressured carrier at the touchline selected a shielding position outside
  the pitch, then remained clamped at the boundary.
- A defensive-line alarm used a depth narrower than the formation's normal
  defensive starting position, producing a false diagnosis.

## Initial Target Bands

These are prototype guardrails, not calibrated professional-football data:

| Metric | Investigate when |
| --- | --- |
| Pass completion | Consistently below 55% or above 88% |
| Shots on target | Near 0% or consistently above 70% |
| Goals per shot | Consistently above 35% |
| Through balls | Zero over several active matches |
| Offsides | Zero with no through balls, or repeated large counts |
| Possession | A team repeatedly exceeds 80% without an intended style test |
| Stuck/stationary flags | Any recurring event in the same seed |

## Current Benchmark Baseline

Recorded on 2026-05-24 with:

```powershell
npm.cmd run benchmark
```

This command runs seeds 101 through 108 for ten simulated minutes each.

| Metric | Current value |
| --- | ---: |
| Goals per ten-minute match | 1.4 |
| Shots per ten-minute match | 5.4 |
| Shots on target | 62.8% |
| Saves per ten-minute match | 1.9 |
| Goals per shot | 25.6% |
| Passes per ten-minute match | 338.6 |
| Pass completion | 71.8% |
| Intercepted passes per ten-minute match | 59.1 |
| Through balls per ten-minute match | 24.9 |
| Through-ball completion | 51.8% |
| Middle-third territory | 62.6% |

Known interpretation for the next intelligence pass:

- Timed runner releases are active; through-ball volume is no longer zero.
- Offsides remain zero because agents still see the line exactly and reject
  targets already offside. Add imperfect line awareness only if it improves
  behavior rather than inserting arbitrary errors.
- Repeated pass-pair and low-completion flags remain useful indicators for
  improving possession structure and press resistance.
- The remaining isolated stuck/stationary flags need seed-level replay before
  further broad movement tuning.

## Engineering Rules For AI Changes

- Preserve fixed update ordering unless the ordering defect is specifically
  diagnosed; changing order can invalidate every comparison.
- Log new tactical actions at the engine boundary where outcomes can be counted.
- Distinguish selection quality from execution physics: a good target can still
  receive a poor pass, and an intelligent shot can still miss.
- Prefer a small new metric over an unexplained utility-score bonus.
- Keep the seed and exact command in review notes so another model can replay a
  claimed improvement.

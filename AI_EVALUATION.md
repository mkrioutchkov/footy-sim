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
| Goals per ten-minute match | 1.1 |
| Shots per ten-minute match | 5.9 |
| Shots on target | 51.1% |
| Saves per ten-minute match | 1.6 |
| Goals per shot | 19.1% |
| Passes per ten-minute match | 353.3 |
| Pass completion | 83.3% |
| Intercepted passes per ten-minute match | 57.8 |
| Through balls per ten-minute match | 30.4 |
| Through-ball completion | 49.8% |
| Timed runs per ten-minute match | 1.5 |
| Timed-run offsides per ten-minute match | 0.4 |
| Offsides per ten-minute match | 0.4 |
| Middle-third territory | 60.6% |

Known interpretation for the next intelligence pass:

- Regulation penalty and goal area dimensions now match the horizontal pitch
  axis. Rendering no longer leaves a stopped-ball trail or a controller
  connector, and marking arcs start explicit paths so Pixi does not draw
  diagonal lines between boxes.
- Goal decisions now match the rendered frame: the whole ball must cross the
  painted line, clear the posts by its radius, and remain under the crossbar.
  `goal_line_crossing` records accepted `x`, `y`, and `z` values. Direction
  arrows have a bounded turn rate and slide tackle bodies retain their
  initial orientation rather than pivoting during contact.
- Tackles now require live contact with the current carrier. Rear challenges
  are less likely to win cleanly and more likely to concede a free kick, and a
  failed tackle no longer draws a successful-looking slide animation.
- Pass outcomes are resolved on control or headed contact; open-play cross
  completions and goalkeeper distributions now enter the same accounting. In
  this benchmark, six recorded open-play crosses produced two completions, so
  wide delivery exists but remains too rare to tune confidently.
- The artificial `offside_risk` position and random offside-rule bypass were
  removed. Through balls can now prepare a short committed run from an onside
  position; that runner sprints while the passer releases. A one-pixel
  numerical offside tolerance replaces the former half-metre grace margin.
  The resulting `0.3` offsides per match come from logged release timing.
- Alerts now describe narrower failures: `rapid_control_changes` is team
  turnover churn, not routine receptions; `ball_unclaimed` requires a slow
  grounded ball near an outfielder; possession imbalance waits three simulated
  minutes; pressured shielding does not trigger `backward_dribble` or
  `why_no_shoot`.
- Remaining high-signal concerns are repeated pass pairs (52 benchmark alerts)
  and recoverable slow loose-ball cases (25). A trial penalty for recently
  repeated non-progressive pass pairs reduced repeats to 40 but reduced shots
  from 5.3 to 4.4; it was not retained. Diagnose circulation chains and
  progression before changing pass utility.

## Engineering Rules For AI Changes

- Preserve fixed update ordering unless the ordering defect is specifically
  diagnosed; changing order can invalidate every comparison.
- Log new tactical actions at the engine boundary where outcomes can be counted.
- Distinguish selection quality from execution physics: a good target can still
  receive a poor pass, and an intelligent shot can still miss.
- Prefer a small new metric over an unexplained utility-score bonus.
- Keep the seed and exact command in review notes so another model can replay a
  claimed improvement.

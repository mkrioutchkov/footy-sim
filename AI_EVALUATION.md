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
| Shots per ten-minute match | 4.0 |
| Shots on target | 43.8% |
| Saves per ten-minute match | 0.5 |
| Goals per shot | 28.1% |
| Passes per ten-minute match | 371.4 |
| Pass completion | 84.9% |
| Intercepted passes per ten-minute match | 54.5 |
| Through balls per ten-minute match | 28.1 |
| Through-ball completion | 49.3% |
| Timed runs per ten-minute match | 1.5 |
| Timed-run offsides per ten-minute match | 0.4 |
| Offsides per ten-minute match | 0.4 |
| Crosses per ten-minute match | 0.5 |
| Goalkeeper distribution completion | 84.8% |
| Goalkeeper dangerous turnovers per match | 0.5 |
| Mean shot launch speed | 485.6 px/s |
| Mean header launch speed | 134.8 px/s |
| Middle-third territory | 63.6% |

Known interpretation for the next intelligence pass:

- Regulation penalty and goal area dimensions now match the horizontal pitch
  axis. Rendering no longer leaves a stopped-ball trail or a controller
  connector, and marking arcs start explicit paths so Pixi does not draw
  diagonal lines between boxes.
- Goal decisions now match the rendered frame: the whole ball must cross the
  painted line, clear the posts by its radius, and remain under the crossbar.
  The crossing decision now runs immediately after ball physics, before any
  generic collection or save can retrieve a ball already over the line.
  `goal_line_crossing` records accepted `x`, `y`, and `z` values. Player
  orientation now uses visible legs and a head instead of a triangle, and
  headed contacts briefly project the head and display a contact ring.
- Tackles now require live contact with the current carrier. Rear challenges
  are less likely to win cleanly and more likely to concede a free kick, and a
  failed tackle no longer draws a successful-looking slide animation.
- Pass outcomes are resolved on control or headed contact; open-play and
  corner crosses plus goalkeeper distributions now enter the same accounting.
  `cross_to_shot` and `cross_goal` retain positive attacking outcomes, while
  harmful defensive-third distributions produce `bad_gk_distribution` or
  `bad_player_distribution`. A same-team header from a cross now opens a
  tracked cross-origin shot chain rather than becoming an unaccounted touch.
  This benchmark produced four crosses, two
  completions and no cross-led shots or goals, so wide delivery remains too
  rare to tune confidently.
- The artificial `offside_risk` position and random offside-rule bypass were
  removed. Through balls can now prepare a short committed run from an onside
  position; that runner sprints while the passer releases. A one-pixel
  numerical offside tolerance replaces the former half-metre grace margin.
  The resulting `0.3` offsides per match come from logged release timing.
- Alerts now describe narrower failures: `rapid_control_changes` is team
  turnover churn, not routine receptions; `ball_unclaimed` requires a slow
  grounded ball near an outfielder; possession imbalance waits three simulated
  minutes; pressured shielding does not trigger `backward_dribble` or
  `why_no_shoot`. Goalkeeper outcomes now log speed, projected offset,
  distance/time to the line and assessed save chance. No
  `unrealistic_gk_save` or `poor_gk_save_attempt` alarms occurred in this
  standard benchmark.
- Remaining high-signal concerns are chance creation and progression: shots
  are down to `4.0` per match, `no_shots` fired eight times, repeated pass
  pairs fired 72 times and slow loose-ball cases fired 26 times. Do not
  recover shots by allowing post-line saves or radius-blind goals. Diagnose
  circulation and final-third entries before changing pass utility.

## 2026-05-25 Selection, Goal-Angle And Off-Ball Iteration

The latest pass was compared with both the original repository root and
DeepSeek's incoming `f87ef60` state using the standard seeds 101 through 108
for ten simulated minutes each:

| Revision | Goals | Shots | Pass completion | Through balls | Crosses | Low-value goals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository root `2d81c67` | 1.4 | 5.4 | 71.8% | 24.9 | not recorded | not recorded |
| DeepSeek `f87ef60` | 1.8 | 6.3 | 81.2% | 29.5 | 0.9 | not recorded |
| Latest accepted state | 0.8 | 3.0 | 80.7% | 28.6 | 0.3 | 0 |

The lower current goal and shot count is accepted for this slice because the
incoming simulation could award visually implausible goals from acute,
near-byline positions. Six scored goals in the current benchmark were audited;
none were low value and each had a recorded opening angle of at least `7.5`
degrees. Current benchmark additions include `2.8` cutbacks per match,
`0.3` cutback-led shots, an average chosen shot angle of `13.3` degrees and
`12.6` raw avoidable primary-presser selections per match.

Mechanisms and telemetry now in place:

- Pass choices log `pass_selection` with distance, expected completion,
  forward progress and a comparable safer alternative when one exists.
  Shot and goal audits record distance, opening angle, pressure and the
  highest-ranked passing alternative.
- `moment_start` and `moment_followup` capture two snapshots roughly `1200ms`
  apart for `why_this_pass`, `why_this_shot`, `why_no_shoot`,
  `why_this_presser`, `why_player_running_direction` and
  `untracked_attacking_run`. A moment begun just before the final whistle may
  reasonably have no follow-up frame.
- Acute shooting geometry is penalized at selection time and cannot aim
  through the painted goal aperture from the diagnosed near-post angle.
  `goal_audit` and `low_value_goal` protect this repair from future tuning.
- Wide deliveries distinguish `cutback_start`, `cutback_to_shot` and
  `cutback_goal`. A completed finishing delivery now lets its receiver shoot
  immediately; seed `104` produced a cutback-led shot `17ms` after control.
- Attacking tasks now create stable role-shaped movement: central forwards
  normally choose central open lanes, wide midfielders normally preserve
  width with occasional inside runs, and fullbacks normally overlap wide.
  Defenders add lane blocks for advanced off-ball threats and prefer a
  materially quicker urgent presser when the carrier is dangerous.
- The prior cross-to-shot bonus bug is removed: the receiver is now detected
  from the completed delivery record rather than reading a last-toucher value
  already replaced on collection.

Next measured slice:

1. Replay `no_shots` and `why_no_shoot` moments and create more centrally
   prepared, credible shots without relaxing the angle safeguard. Standard
   seeds currently contain no cross-led shots and only `0.3` cutback-led
   shots per match.
2. Reduce the raw `12.6` avoidable press assignments while retaining defensive
   coverage. Diagnose `why_this_presser` snapshots before changing thresholds.
3. Inspect `bad_player_distribution` and outfield dangerous turnovers, now
   `4.3` per match, so extra attacking motion does not merely generate cheap
   transition chances.

Acceptance constraints remain deterministic seeded output, zero
`low_value_goal` events in the benchmark, and preservation of the pitch,
goal-aperture, tackle and rendered-line repairs.

## Engineering Rules For AI Changes

- Preserve fixed update ordering unless the ordering defect is specifically
  diagnosed; changing order can invalidate every comparison.
- Log new tactical actions at the engine boundary where outcomes can be counted.
- Distinguish selection quality from execution physics: a good target can still
  receive a poor pass, and an intelligent shot can still miss.
- Prefer a small new metric over an unexplained utility-score bonus.
- Keep the seed and exact command in review notes so another model can replay a
  claimed improvement.

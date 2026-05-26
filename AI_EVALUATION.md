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

## 2026-05-25 Contact, Control And Readability Iteration

A live log reproduced the apparent ghost dispossession: an opponent retained a
cached loose-ball chase after control had already changed, then called
`collectBall()` from the previous `36.4` px chase envelope. Separately, tackle
wins were permitted at `29` px. Both distances could show a visible gap between
the player bodies.

This slice rejects collection while another player controls the ball,
invalidates stale loose-ball perceptions as soon as control changes, and
requires tackle body contact. Successful control now records its source and
contact distance; batch output reports collection, interception and tackle
distance limits.

| Metric | Pre-contact baseline `584ac2b` | Latest accepted state |
| --- | ---: | ---: |
| Goals per match | 0.8 | 0.4 |
| Shots per match | 3.0 | 3.3 |
| Pass completion | 80.7% | 73.4% |
| Intercepted passes per match | 55.8 | 60.0 |
| Low-value goals per match | 0 | 0 |
| Maximum interception collection distance | not recorded | 20 px |
| Maximum winning tackle distance | not recorded | 24 px |
| Stale chase candidates cancelled per match | not recorded | 51.1 |
| Rejected controlled grabs per match | not recorded | 0 |
| Rejected long-reach grabs per match | not recorded | 0 |

Physical and visual constraints now in place:

- Ordinary loose-ball collection and interceptions require contact within
  `20` px. A specifically intended receiver may stretch to `28` px for a
  delivered pass, then the ball is immediately positioned at the visible
  `12` px foot-control distance.
- Tackles must be within `24` px, the diameter of the two rendered player
  bodies. A direct scenario rejects an illegal controlled-ball grab, a normal
  collection attempt from `21` px and a tackle attempt from `25` px.
- The old single-player rebound lock is now a per-player timed contest block,
  and first-touch shielding is tied to the actual receiver rather than any
  later carrier.
- A whole ball past a touchline or non-goal endline now triggers a restart.
  Seed `103` previously stopped outside the endline and generated recurring
  stationary/stuck alarms; after the repair it generated no
  `ball_stationary_in_play` alarm.
- The top-down player head is centered in the body marker. Visible boots point
  toward and bracket a controlled ball; a grounded ball no longer bobs into
  the head marker.

The completion reduction is an accepted diagnostic tradeoff for this repair:
previously some passes survived because distant or stale collections were
allowed. Do not recover completion by expanding opponent contact range. A
later pass-selection/receiver-movement slice should address the current
`73.4%` completion, `15.4` avoidable press selections per match and
`2.9` outfield dangerous turnovers per match while preserving these contact
bounds.

## 2026-05-25 DeepSeek Stabilization And Metric Validation

DeepSeek's incoming `3edfbd9` state contained useful attacking experiments,
but was not acceptable as a baseline: TypeScript failed to compile, a
completed cross referenced an undefined player variable, and aerial cross
receivers could initiate header contact from the removed long-reach envelope.
It also reported final-third conversion above `100%`, never attributed
outfield blocks, and counted dribble types every simulation tick.

The repaired state was measured with:

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark
```

`npm.cmd run scenarios` covers controlled-ball grab rejection, ordinary
collection and tackle distance bounds, completed-cross handling, aerial
header reach, both controlled and deflected shot blocks, and bounded
final-third entry-to-shot conversion.

| Metric | Contact/control baseline | Stabilized DeepSeek state |
| --- | ---: | ---: |
| Goals per match | 0.4 | 0.9 |
| Shots per match | 3.3 | 6.9 |
| Shots on target | 19.2% | 36.4% |
| Pass completion | 73.4% | 77.1% |
| Through balls per match | 24.3 | 39.0 |
| Crosses per match | 0.1 | 0.4 |
| Cross-led shots per match | 0 | 0 |
| Cutback-led shots per match | 0.1 | 0.8 |
| Final-third entries per match | not recorded | 26.8 |
| Final-third entries yielding a shot | not recorded | 24.3% |
| Outfield shot blocks per match | not recorded | 0.6 |
| Outfield shot block rate | not recorded | 9.1% |
| Low-value shots per match | 0.4 | 2.1 |
| Low-value goals per match | 0 | 0 |
| Outfield dangerous turnovers per match | 2.9 | 3.9 |
| Avoidable press selections per match | 15.4 | 11.0 |

Preserved correctness constraints:

- Ordinary and aerial contact remains bounded to `20` px, intended grounded
  receptions may use `28` px, and winning tackles remain bounded to `24` px.
  The standard run reported no illegal controlled grabs or rejected
  long-reach attempts.
- Final-third conversion now means one attacking-third possession entry can
  contribute at most one resulting shot; it cannot exceed `100%`.
- Outfield shot blocks are recorded before shot state is cleared, including
  fast physical deflections. `panic_clear` now specifically requires an
  unpressured forced pass within one second of receiving from a teammate.
- Out-of-play distribution audits store pressure at launch and do not blame
  the passer after an opposing last touch.

Next measured slice should not add another blanket shot bonus. Replay the
`2.1` low-value shots per match and the `0.4` preventable goals per match,
then improve genuine wide-delivery creation: this run produced only three
cross attempts across eight matches, with no completed cross or cross-led
shot. Preserve the new scenario checks while doing so.

## Engineering Rules For AI Changes

- Preserve fixed update ordering unless the ordering defect is specifically
  diagnosed; changing order can invalidate every comparison.
- Log new tactical actions at the engine boundary where outcomes can be counted.
- Distinguish selection quality from execution physics: a good target can still
  receive a poor pass, and an intelligent shot can still miss.
- Prefer a small new metric over an unexplained utility-score bonus.
- Keep the seed and exact command in review notes so another model can replay a
  claimed improvement.

## 2026-05-25 Corner Wind-Up And Shot Eligibility Slice

Starting point: `ce1e74b`. Replays of seeds `101`, `106`, and `107` exposed
two causes of low-value attempts:

- Seed `107` generated normal `shot_start` events from corner takers during
  the scripted `200ms` cross wind-up, immediately before `cross_attempt`.
- Rejected shots returned score `0`, then pressure and final-third bonuses
  made the invalid action selectable again.

Seed `103` also marked three legitimate goals as `poor_gk_save_attempt` at
assessed save chances of `74%`, `80%`, and `82%`; these are probabilistic
outcomes rather than clear keeper failures.

Accepted fixes:

- A pending scripted corner cross is a reserved restart phase; the taker
  cannot execute ordinary pass or shot actions before delivery.
- Shot selection rejects the same `>300px` or acute geometry class recorded by
  `lowValue`, and rejected shot options stay negative through later bonuses.
- `poor_gk_save_attempt` now requires a clear failure (`>=84%` assessed save
  chance, or a very slow and central delayed reaction). Borderline beaten
  assessments remain available as `gk_save_assessment` events.
- Scenarios now cover pressured invalid-shot rejection and reserved corner
  wind-up execution.

Standard benchmark (`npm.cmd run benchmark`, seeds `101-108`, ten simulated
minutes each):

| Metric | Stabilized state | Current state |
| --- | ---: | ---: |
| Goals / match | 0.9 | 1.1 |
| Shots / match | 6.9 | 4.4 |
| Shots on target | 36.4% | 51.4% |
| Pass completion | 77.1% | 77.7% |
| Through balls / match | 39.0 | 37.3 |
| Crosses / match | 0.4 | 0.3 |
| Cutback shots / match | 0.8 | 1.1 |
| Final-third entries yielding a shot | 24.3% | 18.6% |
| Low-value shots / match | 2.1 | 0.0 |
| Poor keeper goals / match | 0.4 | 0.0 |
| Avoidable press selections / match | 11.0 | 10.8 |
| Outfield dangerous turnovers / match | 3.9 | 3.3 |

The reduced shot count reflects removal of bogus attempts, not successful
chance-creation tuning. Restore credible shots next through wide progression
and central cutback/cross receivers; do not weaken shot geometry, the goal
aperture, or reception reach to increase volume.

## 2026-05-25 Open-Play Cross Attribution Slice

The next replay found that the apparently missing open-play crosses were
already present but misclassified. In seed `103`, wide midfielders repeatedly
played forward deliveries from wide positions into a central forward; the
existing predicate counted all of them as `cutback` because it did not
distinguish a forward cross from a pull-back.

Changes in this slice:

- Wide forward deliveries to the central finishing zone now retain a
  `cross` purpose; remaining wide pull-backs retain `cutback`.
- A selected cross keeps its evaluated flight rather than receiving an
  additional generic whipped-cross boost. Contact distances and header reach
  remain unchanged.
- Cross telemetry splits open-play and corner attempts/completions, and keeps
  that origin through resulting shots and goals.
- A completed cross no longer stacks two first-time finishing bonuses for the
  same delivery.
- Scenarios now cover selected open-play cross classification and
  open-play-origin shot attribution.

Standard benchmark against `4c7b2fa` (`npm.cmd run benchmark`, seeds
`101-108`, ten simulated minutes each):

| Metric | `4c7b2fa` category output | Current attributed output |
| --- | ---: | ---: |
| Goals / match | 1.1 | 1.1 |
| Shots / match | 4.4 | 4.4 |
| Shots on target | 51.4% | 51.4% |
| Pass completion | 77.7% | 77.7% |
| Through balls / match | 37.3 | 37.3 |
| Crosses / match | 0.3 | 2.6 |
| Open-play crosses / match | not split (trace: 0 counted) | 2.4 |
| Open-play cross completion | not split | 63.2% |
| Open-play cross-led shots / match | not split | 1.0 |
| Open-play cross goals / match | not split | 0.4 |
| Cutbacks / match | 2.5 | 0.1 |
| Low-value shots / match | 0 | 0 |
| Poor keeper goals / match | 0 | 0 |
| Avoidable press selections / match | 10.8 | 10.8 |

Headline outcomes and quality flags are unchanged; this corrects attribution
and preserves the existing flight/contact rules. Cross production is no
longer a missing-mechanism target. The high-signal next replay is seed `103`,
which contains `9` open-play crosses in ten simulated minutes, plus the six
remaining `no_shots` alarms and press-selection review.

## 2026-05-25 Physical Dribbling And Knock-Ahead Slice

The prior dribble categories were labels only: every controlled carrier used
the same movement limit and a fast dribble never released the ball. This
slice makes the tradeoff physical:

- Close control moves at `39.4` px/s and has stronger tackle protection in
  crowded shielding; ordinary carrying is `52` px/s.
- A fast dribble is a short loose-ball knock-ahead. During that episode the
  runner is capped at `95%` of sprint pace, and the released ball has no
  intended-receiver reach or first-touch shield.
- A recovered knock-ahead has a short cadence delay before another burst.
  `knock_ahead_start`, `knock_ahead_result` and
  `bad_knock_ahead_turnover` expose the decision and outcome.
- Deterministic scenarios cover tier speeds, legal risky turnover collection,
  carrier recovery and immediate-repeat prevention.

Standard benchmark against `8d2017b` (`npm.cmd run benchmark`, seeds
`101-108`, ten simulated minutes each):

| Metric | Prior attributed state | Physical dribbling state |
| --- | ---: | ---: |
| Goals / match | 1.1 | 1.1 |
| Shots / match | 4.4 | 4.4 |
| Shots on target | 51.4% | 60.0% |
| Pass completion | 77.7% | 77.2% |
| Through balls / match | 37.3 | 42.6 |
| Open-play crosses / match | 2.4 | 2.9 |
| Final-third entries yielding a shot | 18.6% | 20.3% |
| Low-value shots / match | 0 | 0 |
| Poor keeper goals / match | 0 | 0.3 |
| Knock-aheads / match | not physical | 7.0 |
| Knock-ahead launch speed | not measured | 58 px/s |
| Carrier recovery | not measured | 80.4% |
| Knock-ahead turnovers / match | not measured | 1.4 |
| Risky knock-aheads / risky losses | not measured | 1.9 / 1.1 |
| Avoidable press selections / match | 10.8 | 10.9 |

Headline chance volume is preserved, but the new audit identifies an
immediate outlier: seed `103` attempts `7` knock-aheads and loses `5`, with
`4` of those losses flagged as risky starts. Its open-play crosses have fallen
from the previous `9` to `3`, so the next replay target is now risky dribble
choice rather than crossing repetition. Also replay the `8` `no_shots` flags
and the two `poor_gk_save_attempt` events in seeds `103` and `105`; do not
relax contact bounds or goal/shot geometry to compensate.
# Historical TypeScript Evaluation

This document describes the retired TypeScript simulator and is retained only
as historical diagnosis. The current simulation runtime is the C++ engine in
`native/`; use `native/RECOVERY_NOTES.md`, `TODO.md`, and
`DEEPSEEK_CONTINUATION_PROMPT.md` for current benchmarks and next work.

# DeepSeek Continuation Prompt: Chance Creation After Outcome Telemetry

Use this prompt for the next coding pass in this repository.

## Objective

Continue improving football realism and simulation richness without adding
unmeasured score bonuses or undoing recent correctness fixes. The current code
compiles and produces deterministic seeded output. Work in small slices,
measure each behavior change, and prefer mechanisms that explain what is seen
on screen.

## Latest Accepted State (2026-05-25)

This is the baseline to use for new changes. The later historical evidence
section describes an older state and must not be treated as the current
benchmark.

Standard `npm.cmd run benchmark` results for seeds 101 through 108, ten
simulated minutes each:

| Revision | Goals / match | Shots / match | Pass completion | Through balls / match | Crosses / match | Low-value goals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Repository root `2d81c67` | 1.4 | 5.4 | 71.8% | 24.9 | not recorded | not recorded |
| DeepSeek `f87ef60` | 1.8 | 6.3 | 81.2% | 29.5 | 0.9 | not recorded |
| Latest accepted state | 0.8 | 3.0 | 80.7% | 28.6 | 0.3 | 0 |

The accepted drop in output is intentional: the incoming branch could score
from very acute positions that looked outside the rendered goal. The latest
run audited six goals with no low-value goals. Average chosen shot angle is
`13.3` degrees; all scored-goal opening angles were at least `7.5` degrees.

### Contact And Control Addendum (2026-05-25)

The contact/readability repair after that selection baseline is the new
starting point. Standard `npm.cmd run benchmark` output is:

| Metric | Selection baseline `584ac2b` | Contact/control state |
| --- | ---: | ---: |
| Goals / match | 0.8 | 0.4 |
| Shots / match | 3.0 | 3.3 |
| Pass completion | 80.7% | 73.4% |
| Interceptions / match | 55.8 | 60.0 |
| Low-value goals / match | 0 | 0 |
| Maximum interception collection distance | not recorded | 20 px |
| Maximum winning tackle distance | not recorded | 24 px |
| Stale chase candidates cancelled / match | not recorded | 51.1 |
| Illegal controlled grabs in standard run | not recorded | 0 |
| Rejected long-reach grabs in standard run | not recorded | 0 |

Diagnosed mechanism: a cached loose-ball chase could still call
`collectBall()` after an opponent had taken control, using the former
`36.4` px collection envelope. The engine now refuses collection of a
controlled ball, cancels the stale perception, and logs contest distances.
Ordinary/interception control is restricted to `20` px and tackle wins to
`24` px. An intended receiver may make a `28` px stretched first touch, which
immediately places the ball at the rendered boots.

Also preserve the related visual and restart repairs: heads are centered
inside player markers, boots visibly bracket a controlled ball, grounded balls
do not bob into the head marker, and a whole ball beyond a non-goal endline or
touchline causes an immediate restart. The boundary fix removed a reproducible
seed `103` stationary-ball cascade.

Do not raise contact distances to recover the pass-completion decline. Improve
target selection, pass execution or receiver approach behavior and rerun this
same benchmark. Current additional targets are `15.4` avoidable press
selections and `2.9` outfield dangerous turnovers per match.

### Stabilized DeepSeek State (2026-05-25)

Treat this section and `TODO.md` as the current baseline. DeepSeek's incoming
`3edfbd9` source contained uncompiled telemetry/cross edits and briefly
reintroduced enlarged aerial cross contact. The repaired standard benchmark
is:

| Metric | Stabilized value |
| --- | ---: |
| Goals / match | 0.9 |
| Shots / match | 6.9 |
| Shots on target | 36.4% |
| Pass completion | 77.1% |
| Through balls / match | 39.0 |
| Crosses / match | 0.4 |
| Cross-led shots / match | 0 |
| Cutback-led shots / match | 0.8 |
| Final-third entries yielding a shot | 24.3% |
| Outfield shot block rate | 9.1% |
| Low-value shots / match | 2.1 |
| Low-value goals / match | 0 |
| Avoidable press selections / match | 11.0 |
| Outfield dangerous turnovers / match | 3.9 |

### Corner Wind-Up And Shot Eligibility Addendum (2026-05-25)

This addendum supersedes the stabilized benchmark above as the current state.
Replays showed that corner takers could shoot during their prescribed
`200ms` cross wind-up, and that a shot rejected with score `0` could be
revived by later pressure/final-third bonuses. Both are now guarded by
scenarios.

| Metric | Stabilized state | Current state |
| --- | ---: | ---: |
| Goals / match | 0.9 | 1.1 |
| Shots / match | 6.9 | 4.4 |
| Shots on target | 36.4% | 51.4% |
| Pass completion | 77.1% | 77.7% |
| Through balls / match | 39.0 | 37.3 |
| Crosses / match | 0.4 | 0.3 |
| Cross-led shots / match | 0 | 0 |
| Cutback-led shots / match | 0.8 | 1.1 |
| Final-third entries yielding a shot | 24.3% | 18.6% |
| Low-value shots / match | 2.1 | 0.0 |
| Poor keeper goals / match | 0.4 | 0.0 |
| Avoidable press selections / match | 11.0 | 10.8 |
| Outfield dangerous turnovers / match | 3.9 | 3.3 |

Do not restore low-value shots to increase volume. The following addendum
resolves the suspected missing-cross gap and gives the current next task.
`poor_gk_save_attempt` is deliberately a high-confidence alert now; beaten
`74-82%` chances remain debug evidence, not automatic failures.

### Open-Play Cross Attribution Addendum (2026-05-25)

This is the latest accepted state. Replay showed that forward passes from
wide players into a central forward were being labeled as cutbacks. The
engine now distinguishes those open-play crosses from genuine pull-backs and
from corner crosses, retaining origin through completion, shot and goal.
No reception or header distance was increased and a selected cross retains
its evaluated ball flight.

| Metric | Previous category output | Current attributed output |
| --- | ---: | ---: |
| Goals / match | 1.1 | 1.1 |
| Shots / match | 4.4 | 4.4 |
| Shots on target | 51.4% | 51.4% |
| Pass completion | 77.7% | 77.7% |
| Through balls / match | 37.3 | 37.3 |
| Crosses / match | 0.3 | 2.6 |
| Open-play crosses / match | not split | 2.4 |
| Open-play cross completion | not split | 63.2% |
| Open-play cross-led shots / match | not split | 1.0 |
| Open-play cross goals / match | not split | 0.4 |
| Cutbacks / match | 2.5 | 0.1 |
| Low-value shots / match | 0 | 0 |
| Poor keeper goals / match | 0 | 0 |

The next task is not to manufacture more crosses. Replay seed `103`, which
contains `9` open-play crosses in ten simulated minutes, for repetitive
delivery selection and receiver movement. Also address the six remaining
`no_shots` flags and pressing decisions while preserving the current shot and
contact constraints.

Mandatory checks before and after the next behavioral edit:

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark
```

The scenarios protect controlled-ball collection, collection/tackle/header
reach limits, completed crosses, shot-block attribution, bounded final-third
conversion, invalid pressured-shot rejection and reserved corner wind-ups.
Do not restore any extended cross receiver reach:
ordinary and aerial contact is `20` px, intended grounded reception may use
`28` px, and tackle wins are capped at `24` px.

Work next on cross variation, shotless possession chains and pressing
quality. The corrected run has `4.4` shots per match with `0` selected
low-value shots and `0` clear keeper-failure alerts, while attributed
open-play crosses already create `1.0` shots and `0.4` goals per match.
Improve choices and receiver movement, not contact envelopes or generic
shooting bonuses.

New instrumentation and behavior you must preserve:

- `pass_selection`, shot selection data and `goal_audit` quantify distance,
  opening angle, pressure and available alternatives.
- `moment_start` / `moment_followup` provide paired snapshots for
  `why_this_pass`, `why_this_shot`, `why_no_shoot`, `why_this_presser`,
  `why_player_running_direction` and `untracked_attacking_run`. A moment
  raised in the final `1200ms` may end without a follow-up.
- `cutback_start`, `cutback_to_shot` and `cutback_goal` distinguish pulled
  back wide delivery from generic passing. The receiver of a recent cross or
  cutback may take a first-time shot without entering a holding delay.
- Off-ball attack is role-shaped and stable: CFs normally seek central lanes,
  wide midfielders normally hold width with occasional inside runs, and
  fullbacks overlap wide. Defensive lane blocks track advanced threats, while
  urgent pressing may switch to a materially quicker defender.
- Tight-angle shot selection and aiming protect the radius-aware rendered goal
  aperture. Do not increase goals by weakening these constraints.

Work next on replayable causes of low credible chance volume. In the latest
standard run, open-play crosses produce `1.0` shots and `0.4` goals per match,
but seed `103` accounts for `9` cross attempts and six `no_shots` alerts
remain across the seed set. Use paired moments to reduce repetitive delivery,
improve centrally prepared chances and improve pressing handoff without
admitting acute goals.

## Start Here

Read these files before editing:

1. `AI_EVALUATION.md`, especially the current benchmark and alert meanings.
2. `src/engine.ts`: pass outcome tracking, tackle contact, restarts, quality
   checks, and ball contest handling.
3. `src/agent.ts`: pass utility, runs, chase decisions, and defending.
4. `src/renderer.ts` and `src/constants.ts`: recent visual and pitch fixes.
5. `DESIGN.md`: architecture and debug events.

Then run:

```powershell
npm.cmd run build
npm.cmd run benchmark
$a = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$b = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$a -ceq $b
```

Do not tune from an unseeded visual impression. Use a repeatable seed when
investigating an animation or event sequence.

## Do Not Regress These Repairs

- Pitch geometry uses screen axes correctly: penalty depth is `165`, width is
  `403`; goal-area depth is `55`, width is `183`.
- The renderer clears loose-ball trails when the ball slows or becomes
  controlled and does not draw a controller-to-ball connector line. Marking
  arcs must begin explicit paths; otherwise Pixi joins distant markings with
  diagonal lines across the pitch.
- A tackle can dispossess only the currently controlling opponent at contact
  range. Rear tackles are penalized and failed challenges do not render a
  successful slide.
- `collectBall()` cannot silently transfer an already controlled ball. Preserve
  `collection_rejected` and `stale_chase_cancelled` telemetry, the `20` px
  ordinary/interception reach bound, and the `24` px winning-tackle bound.
- Keep endline and touchline restart checks whole-ball based. A loose ball just
  outside the painted line must not remain stopped in play.
- A pending pass resolves on control or headed contact. Do not restore stale
  pending possession after a header.
- Foul and offside restarts are `free_kick` restarts, not disguised goal kicks.
- Do not restore `offside_risk` positions or random bypass of an already
  detected offside. Offside must emerge from timing and movement.
- Prepared through balls hold the passer briefly while a selected runner
  commits to a sprint. Keep `timed_run_start` and `timed_pass_release`
  telemetry, and keep offside tolerance as a small numerical buffer rather
  than a visible positional allowance.
- A goal now requires the whole ball beyond the painted line and inside a
  radius-aware, crossbar-aware aperture. Preserve `goal_line_crossing`
  telemetry and do not restore center-point-only scoring. Goal detection runs
  immediately after loose-ball physics so a goalkeeper or collision cannot
  retrieve a ball that has already fully crossed the line.
- Player orientation is now drawn as legs plus a centered head rather than a
  triangle. Controlled-ball boots point toward and bracket the ball, grounded
  ball rendering has no artificial bob, facing turns remain capped, slide
  tackles keep their captured orientation, and headed contact uses
  `headingAnim` plus a short `header` event ring.
- Preserve `cross_to_shot`, `cross_goal`, `gk_distribution_result` and
  `gk_save_assessment` events. Preserve `bad_gk_distribution`,
  `bad_player_distribution`, `unrealistic_gk_save` and
  `poor_gk_save_attempt` flags; their context values make bad seeds
  reproducible instead of anecdotal. Headed same-team cross contacts begin an
  active cross-origin shot chain so a later save or goal stays attributable.
- Keep alert semantics narrow. Do not bring back broad
  `player_way_off`/`defender_passive` spam or count normal receptions as rapid
  turnovers.

## Historical Baseline (Before Selection And Off-Ball Slice)

Current `npm.cmd run benchmark` runs seeds 101-108 for ten simulated minutes:

| Metric | Value |
| --- | ---: |
| Goals / match | 1.1 |
| Shots / match | 4.0 |
| Shots on target | 43.8% |
| Pass completion | 84.9% |
| Interceptions / match | 54.5 |
| Through balls / match | 28.1 |
| Through completion | 49.3% |
| Timed runs / match | 1.5 |
| Timed-run offsides / match | 0.4 |
| Offsides / match | 0.4 |
| Crosses / match | 0.5 |
| GK distribution completion | 84.8% |
| GK dangerous turnovers / match | 0.5 |
| Shot launch speed | 485.6 px/s |
| Header launch speed | 134.8 px/s |
| Middle-third territory | 63.6% |

The most frequent quality flags are `repeated_pass_pair` (72),
`ball_unclaimed` (26), `bad_player_distribution` (22), and `no_shots` (8).
There were four `bad_gk_distribution` alarms. Cross accounting works, but only
four crosses and no cross-led shots occurred, so wide delivery is still too
rare for confident tuning. Timed offsides remain present without selecting
illegal receivers. The goalkeeper assessment thresholds did not raise an
implausible-save or preventable-goal flag in this seed set; do not loosen them
without a replayable case.

## Historical Recommended Slice (Already Implemented In Part)

Diagnose missing chances and weak wide progression before changing keeper or
goal rules:

1. Replay seeds with `no_shots` and high repeated circulation, especially
   `105` and `108`, and count final-third possessions that end without a shot,
   cross or dangerous turnover.
2. Add possession-chain progression context so recycling under pressure is
   separated from stagnant repeated pairs.
3. Implement one measured attacking mechanism, such as a credible wide
   outlet/cross target or a final-third support run, and retain its event
   telemetry through shot outcome.
4. Compare the standard benchmark and inspect any keeper/distribution flags
   generated by the changed attack pattern.

Acceptance criteria:

- Shots improve from the current 4.0-per-match benchmark without inflating
  radius-invalid goals or undoing the post-line collection fix.
- Cross-led shots become observable often enough to assess, rather than merely
  increasing harmless cross attempts.
- `repeated_pass_pair` declines for stagnant chains, not merely because normal
  possession is being lost sooner.
- Determinism remains true for identical source, seed, and inputs.

A simple penalty on recently repeated non-progressive receiver pairs has
already been tried and rejected: it reduced pair flags from 50 to 40, but
shots fell from 5.3 to 4.4 and `no_shots` alerts increased; rerun an equivalent
experiment from the current 4.0-shot baseline rather than assuming it carries forward.

## Later Slices

After the circulation slice, address these in order:

1. Replay `ball_unclaimed` events and decide whether slow rebounds need a team
   recovery assignment or a collection-physics adjustment.
2. Increase credible wide attacks through overlapping/wide-ball situations,
   tracking cross origin, recipient contact, and resulting shot separately
   from corners.
3. Add scenario-level checks for front, side, and rear tackle contacts plus
   headed pass resolution and free-kick placement.

For every slice, state the diagnosed mechanism, edit only the relevant files,
run `npm.cmd run build` and the seeded comparison, and record the result in
`AI_EVALUATION.md`.

## Latest Accepted Slice: Physical Dribbling (2026-05-25)

This section supersedes the older recommended-next-step text above. The
accepted engine now gives dribbling an actual speed/control tradeoff:

- Close control is `39.4` px/s and is harder to tackle in crowded shielding.
- Ordinary attached carrying is `52` px/s, below a `68` px/s sprint.
- Fast dribbling is a short loose-ball knock-ahead. Only its runner approaches
  sprint pace, capped at `95%`; the ball receives no intended-receiver reach
  or reception shield.
- A carrier who recovers a pushed ball must wait briefly before repeating the
  burst. Do not remove this cadence or reattach the fast ball.
- Preserve `knock_ahead_start`, `knock_ahead_result`,
  `bad_knock_ahead_turnover` and the batch metrics for attempts, launch speed,
  recoveries, turnovers, risky attempts and risky losses.

Accepted standard benchmark for seeds `101-108`, ten simulated minutes:

| Metric | Value |
| --- | ---: |
| Goals / match | 1.1 |
| Shots / match | 4.4 |
| Shots on target | 60.0% |
| Pass completion | 77.2% |
| Through balls / match | 42.6 |
| Open-play crosses / match | 2.9 |
| Open-play cross-led shots / match | 0.9 |
| Final-third entry-to-shot | 20.3% |
| Low-value shots / match | 0 |
| Preventable keeper goals / match | 0.3 |
| Knock-aheads / match | 7.0 |
| Average knock-ahead launch speed | 58 px/s |
| Carrier recovery | 80.4% |
| Knock-ahead turnovers / match | 1.4 |
| Risky knock-aheads / risky turnovers | 1.9 / 1.1 |
| Avoidable press selections / match | 10.9 |

Your next measured slice should replay seed `103` first. It has `7`
knock-aheads, `5` losses and `4` `bad_knock_ahead_turnover` events, while its
open-play crosses are now `3` rather than the previous `9`. Diagnose whether
the risky bursts are repeated by one carrier, selected into a closing lane,
or missing a preferable pass; use the paired moment data before changing
thresholds. Also replay the `8` `no_shots` flags and the two
`poor_gk_save_attempt` events in seeds `103` and `105`.

Run before and after any accepted behavioral edit:

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark
$a = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$b = npm.cmd run batch -- --matches 1 --minutes 2 --seed 44 | Out-String
$a -ceq $b
```

Do not increase collection or tackle reach, do not grant a knock-ahead the
selected-receiver collection advantage, and do not loosen shot or goal
geometry to restore chances. Improve burst choice, central support movement,
or keeper response only from replayable logged cases.

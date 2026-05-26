# C++ Engine Recovery Notes

Date: 2026-05-25
Updated: 2026-05-26

## Integrated Runtime State (Supersedes Repository State Below)

The recovered engine has been moved into the main `footy-sim` repository.
These `native/` source files are now authoritative; the former
`.scratch/cpp-engine` checkout is archival recovery history only. The
TypeScript simulation runtime has been removed, while the browser renderer
and paced native relay remain TypeScript.
Ignore later historical instructions referring work back to the scratch
repository or `main.exe`; they predate this integration.

Build and validation from `footy-sim`:

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark
npm.cmd run server
```

`native/benchmark.exe` is used for headless simulation and `native/live.exe`
for the relay, avoiding Windows executable locks during rebuilds.

Current ten-minute benchmark for seeds `101-108`: `0.6` goals/match, `3.9`
shots/match, `48.4%` on target, `81.8%` completion and `35.4` tackle
attempts/match. Stuck-carrier, long/OOB tackle deflection, own-pass goal,
unknown loose-goal and invalid-shot quality guards are all zero.

The retained decision telemetry samples CF openings at most once per 500 ms.
It records `3.6` credible samples/match (`<190` px, opening `>9` degrees,
maximum one nearby defender), all deferred for dribbling, but no deferred
close samples (`<120` px). A targeted shoot-score bonus was rejected: it
dropped shots from `3.9` to `2.9` and goals from `0.6` to `0.4`. Work next
on chance construction and the missing native offside/onside-run contract,
not on relaxing shot geometry.

## Repository State

The frontend TypeScript repository and this native engine are separate Git
repositories:

- Frontend/reference engine: `..\..\footy-sim`
- Native engine: this repository, `Game\.scratch\cpp-engine`

Do not reset `footy-sim` to recover C++ source. The native source is not in
that repository. The failed full-agent native attempt is preserved in
`stash@{0}` on the native repository, and recovery work is on branch
`recovery/full-agent-port`.

The executable used by the frontend relay is built from the root source
files in this directory:

```powershell
cl /nologo /std:c++20 /EHsc /O2 main.cpp /Fe:main.exe
.\main.exe 103 5 --summary
```

There is also a tracked `src\` copy from the failed port. It is not the
authoritative build input and must be deliberately reconciled or removed
before declaring this port clean.

## Recovered So Far

- Seeded initialization now consumes the same manager/shuffle/attribute RNG
  sequence as the TypeScript batch engine; the seed 101 first player's
  generated attributes match.
- Formation positions and penalty-area dimensions match the TypeScript
  reference.
- Kickoff places the taker at the center spot and resets legal half positions.
- The controlled-ball freeze was removed by implementing carrier movement,
  attached-ball movement, reception, and restart release paths.
- Pass release now implements the reference lead, inaccuracy, variable speed,
  loft decisions, kickoff tap, and key RNG consumption.
- Releaser contest blocking and receiver first-touch shielding prevent
  immediate self-recollections and reduce teammate pinball.
- Tackles produce bounded loose-ball outcomes and expose long-launch/OOB
  counters.
- Shot release, whole-ball goal-line geometry, goalkeeper positioning, saves,
  parries, catches, and goalkeeper release are implemented at a functional
  parity level.
- `--summary` avoids frame streaming during benchmark runs.

## Current Benchmark

Five-minute runs, seeds 101 through 105:

| Engine | Passes / match | Shots / match | Goals / match | Tackle attempts / match |
| --- | ---: | ---: | ---: | ---: |
| TypeScript reference | 123.4 | 2.8 | 0.8 | 4.0 |
| Native recovery | 129.0 | 2.8 | 1.2 | 33.6 |

Seed 103 finishes `0-1` in both engines. The native longest unchanged
ball/controller state observed in a one-minute streamed seed 103 run is about
`900 ms`; the previous broken port held one state for about `102 seconds`.

These aggregate results are useful smoke tests only. The engines do not yet
produce the same game for the same seed.

## Inspection Build (Uncommitted)

The first inspection executable added audit-only native JSON fields without
changing the recovered five-seed gameplay outcomes:

- `passesCompleted`, `passesIntercepted`, `passCompletionPct`
- `ballSpeed` (`peak`, loose-ball average, pass/shot launch averages)
- `goalsByDistance`, `directDeliveryGoals`, `directCrossGoals`,
  `untrackedGoals`
- `goalkeeping` (`assessedShots`, `unlikelySaves`, `preventableGoals`)
- `qualityFlags` for stuck carriers, tackle launch distance/OOB, goal source
  and goalkeeper quality
- Renderer contract fields (`half`, per-team shots, possession, engine
  version) and JSON `null` for a loose ball controller, so the native browser
  view has a valid HUD and loose-ball trail rendering.
- Native `tackleAnim`/`headingAnim` and ball reception/touch metadata are
  now relayed to the renderer rather than discarded at the JSON boundary.
- The frontend native relay now backpressures the fast executable and paces
  visible playback, with functioning pause, speed and restart handling. Its
  prior unbounded broadcast could appear to freeze the browser around minute
  9 while the engine had continued running.

Before the movement change below, seeds 101-105 matched commit `03296c0` for
scores, pass attempts, shots and tackle attempts. That initial audit exposed:

- Native pass completion is `82.1%` to `88.6%` in that sample, materially
  above the TypeScript reference.
- Seed `103` has one `untracked_goal` in five minutes; it is not currently
  attributed to a shot or direct crossed/delivered pass.
- Native reports `10` `player_stuck` observations and `14`
  `slide_tackle_distance` observations across those five seeds.
- A 20-minute seed `103` run reports one untracked goal, `83.0%` completion,
  `160` tackle attempts and `9` long tackle launches.

Two behavior changes were tested and rejected rather than retained:

- Partial coordinated role assignments starved passing options in several
  seeds.
- Standalone offside filtering altered outcomes while increasing existing
  tackle/direct-goal problems.

Those mechanics need to be ported as complete contracts with through-ball,
phase and attack/defence coordination support.

## Carrier Turning Improvement (Uncommitted)

Native carriers previously moved directly toward each newly selected target
every fixed update. In continuous possession this allowed an instant
direction reversal and produced visible flicker in the browser. Carrier
movement now applies a bounded turn arc: close-control dribbling can turn
fastest, ordinary carrying is moderate, and fast carrying has the least
agile turn rate.

New JSON output records `carrierTurns` (`samples`, `requestedSharp`,
`appliedSharp`, `limitedFrames`) and publishes each player's `targetX`,
`targetY` and `dribbleType` for visual diagnosis.

Continuous-possession seed `101`, five minutes:

| Build | Sharp carrier turns | Near reversals | Maximum one-frame turn |
| --- | ---: | ---: | ---: |
| Recovery baseline `03296c0` | 671 / 4709 (14.25%) | 532 | 180 deg |
| Current native build | 0 / 3955 (0.00%) | 0 | 62 deg |

Five-minute seeds 101-105:

| Build | Passes / match | Shots / match | Goals / match | Tackles / match | Stuck flags | Long tackle launches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Recovery baseline | 129.0 | 2.8 | 1.2 | 33.6 | 10 | 14 |
| Current native build | 136.0 | 3.4 | 0.8 | 27.6 | 1 | 17 |

Ten-minute seeds 101-103 retain usable attacking volume while reducing tackle
attempts from `71.3` to `57.0` per match. Long tackle-launch alerts remain
unresolved and rose marginally in both samples; tackle outcome physics should
be addressed next rather than loosening carrier movement.

## Realism Slice (Uncommitted, 2026-05-26)

The current native working tree retains the carrier turning fix and adds the
following diagnosed behavior changes:

- Winning tackles now resolve as either controlled wins or short loose
  deflections; they no longer launch clearance-speed balls by default.
- Shot eligibility uses radial distance and the true opening subtended by the
  posts. Shot output reports distance bands and questionable selections.
- Goal source reporting distinguishes shots, shot deflections, direct
  deliveries, own passes, tackle deflections, parries, lost shot state,
  unknown loose goals and knock-ahead goals.
- A defensive-third pass may not be launched through its own goal mouth.
  Scripted restart and goalkeeper releases try alternate teammates or retry,
  so a rejected dangerous release cannot freeze play.
- Fast dribbling is now a physical loose-ball knock-ahead with ordinary
  collection reach, a recovery cadence, and recovered/retained/turnover/risky
  telemetry. The prior native stub allowed an attached near-sprint carry.
- Goalkeepers may legally collect slow loose balls inside their area, and a
  tracked shot retains its attacking team after an outfield deflection. This
  removed a seed `107` five-goals-from-seven-shots outlier caused by the
  wrong goalkeeper being assessed or a slow ball rolling past an ineligible
  keeper.

One attempted edit was rejected: extending the failed-tackle cooldown reduced
tackle attempts only marginally and increased goal outliers. Tackle volume
needs coordinated defensive assignments rather than a local timing penalty.

Standard ten-minute benchmark, seeds 101-108:

| Engine | Passes | Completion | Shots | Goals | On target | Tackles | Knock-aheads | Knock losses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript reference (2026-05-26 workspace) | 261.0 | 76.2% | 5.0 | 1.00 | 55.0% | 4.1 | 8.5 | 1.3 |
| Current native build | 281.1 | 83.9% | 8.5 | 2.38 | 61.8% | 35.5 | 9.75 | 0.75 |

The native sample has zero `slide_tackle_distance`, `own_pass_goal` and
`unknown_loose_goal` flags. It has `19` `player_stuck` flags and `8`
questionable-shot flags across the eight matches. Its chance creation,
conversion, pass completion and tackle frequency are still substantially
above reference and are not accepted parity metrics.

Longer native smoke test, twenty minutes:

| Seed | Score | Passes | Shots | Tackles | Stuck flags | Slide/own/unknown goals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 101 | 1-2 | 609 | 19 | 85 | 8 | 0 / 0 / 0 |
| 102 | 3-2 | 572 | 23 | 49 | 6 | 0 / 0 / 0 |
| 103 | 3-1 | 547 | 18 | 78 | 4 | 0 / 0 / 0 |

Before the restart retry fix, seed `103` stopped making actions at minute 12
with an attacking-corner throw-in holder and ended on `62` stuck flags. It
now continues adding passes and shots through minute 20.

## Defensive Coordination And Decision Audits (Uncommitted, 2026-05-26)

This round restores a limited deterministic defensive coordinator in native:
one primary presser is selected with an ETA override when a materially closer
defender should engage, then cover, screen, lane-block and defensive-line
tasks bias the remaining defenders. Attacking assignments were prototyped and
rejected in this round because their current native action weights suppressed
shots almost completely.

Additional retained fixes and telemetry:

- Contested intended receivers no longer automatically trap every slow pass;
  pressured receptions now expose attempts and failed traps in
  `passSelection`.
- `marking`, `passSelection`, `shotSelection` and expanded `carrierTurns`
  JSON summaries make the highlighted behavior benchmarkable.
- Ball and player positions are emitted with subpixel precision, carrier
  direction changes use a tighter arc, and a carrier's published facing is
  kept aligned with its movement. This eliminates large rendered snapping
  caused by rounded positions plus rapid low-speed direction changes.
- Touchline and goal-line restarts now trigger once the entire ball crosses
  the boundary. Seed `102` previously exposed a ball stopped at `y=-18` with
  no reachable restart; it now completes normally.

Ten-minute native benchmark, seeds 101-108:

| Build | Passes | Completion | Shots | Goals | On target | Tackles | Stuck flags |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before this round | 281.1 | 83.9% | 8.50 | 2.38 | 61.8% | 35.5 | 19 total |
| Current native build | 333.4 | 81.8% | 3.88 | 0.63 | 48.4% | 35.4 | 0 total |
| TypeScript reference | 261.0 | 76.2% | 5.00 | 1.00 | 55.0% | 4.1 | 6 total |

The current eight-match sample has zero slide-tackle distance alerts,
own-pass goals and unknown loose-ball goals. It records `60` pressured
receptions with `39` failed traps, `41` questionable primary-presser samples,
and no tight-angle or clearly better-pass-than-shot selections. Final-third
unmarked-CB samples fall to `12.2%`; shot volume is now slightly too low
rather than excessively high.

Rendered five-minute rotation sample, seeds 101-104:

| Build | Controlled movement turns over 30 deg | Over 45 deg |
| --- | ---: | ---: |
| Before this round | 5,503 | 1,540 |
| Current native build | 395 | 0 |

Twenty-minute current-native smoke test:

| Seed | Score | Passes | Shots | Tackles | Stuck flags | Slide/own/unknown goals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 101 | 0-0 | 686 | 4 | 99 | 0 | 0 / 0 / 0 |
| 102 | 1-1 | 702 | 9 | 66 | 0 | 0 / 0 / 0 |
| 103 | 1-1 | 663 | 4 | 63 | 0 | 0 / 0 / 0 |

## Known Gaps

The following native callbacks are still missing or materially simplified:

- `updateTeamAssignments()` now implements defensive pressing/cover only;
  attacking support and run coordination is not retained because the first
  port suppressed chance creation.
- Tactical phase transitions, offside line/decision enforcement, and timed
  through-ball preparation/release.
- Full TypeScript pending-pass semantics, header contacts, and full
  goalkeeper distribution/set-piece behavior.
- TypeScript quality-flag output is only partly ported; pinball, distribution,
  and snapshot decision audits are still incomplete in native.
- Native pass completion and especially tackle attempts remain high, while
  shot/goal volume is now below the TypeScript reference.
- Very high native playback speed settings are constrained by the current
  JSON-frame generation/relay throughput; they are stable but are not yet a
  benchmark-speed simulation path.

Native tackle frequency and chance creation remain failing parity metrics.

## Required Method

Do not tune native constants to make totals look close. Continue as a
contract-by-contract port from `footy-sim\src\engine.ts` and
`footy-sim\src\agent.ts`, preserving:

1. RNG calls and their order.
2. Player iteration order and restart order.
3. Action release and contact rules.
4. Quality counters used to reject unrealistic output.

Recommended next milestones:

1. Add a parity harness that runs TypeScript and native for the same seed and
   compares the initial state, first possession changes, first pass, first
   shot, and aggregate summary.
2. Add measured attacking support/run choices incrementally, accepting each
   role only if shots return toward `5.0` without undoing defensive coverage.
3. Port full pending-pass resolution and remaining quality summaries.
4. Port timed runs, offside handling and full set-piece/distribution choices.
5. Only then attempt exact frame/RNG parity.

## Follow-Up Prompt For DeepSeek

Work only on `Game\.scratch\cpp-engine` branch `recovery/full-agent-port`.
Read this file before editing. Do not reset `footy-sim`; it is the reference
engine and the native source is a separate repository. Root `main.cpp` builds
the current executable; do not silently edit only `src\` duplicates.

Preserve the current diagnosed fixes: subpixel native frame output and
bounded carrier turns, short
tackle-deflection outcomes, radial shot/goal aperture checks, defensive-third
own-goal pass prevention with restart retry, physical knock-ahead dribbles,
legal goalkeeper collection of slow loose balls, contested intended
receptions, the defensive assignment slice and full-ball boundary restarts.
Seeds `102` and `103` must continue progressing through twenty minutes; do
not reintroduce dead out-of-play balls or restart holds.

Next task: improve attacking chance creation incrementally. The current
native ten-minute benchmark is `333.4` passes at `81.8%`, `3.88` shots,
`0.63` goals and `35.4` tackles; current TypeScript is `261.0`, `76.2%`,
`5.0`, `1.00` and `4.1`. A prototype that activated all attacking assignment
tasks produced only `1.875` shots and `0.125` goals, so do not reapply it as
a batch. Start with one measured support or final-third run behavior, retain
the defensive coordinator, and reject any change that depresses shot volume.

Build root `main.cpp`, run seeds `101-108` for ten minutes and seeds
`101-103` for twenty minutes, and report passes, completion, shots, goals,
tackles, stuck carriers, slide-tackle flags and all loose-goal source flags.
Accept a behavior change only if tackle/chance excess materially improves
without restoring a restart stall, own-pass goal, unknown loose goal or
carrier-turn flicker.

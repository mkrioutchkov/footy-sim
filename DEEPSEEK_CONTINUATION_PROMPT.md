# DeepSeek Continuation Prompt: Chance Creation After Outcome Telemetry

Use this prompt for the next coding pass in this repository.

## Objective

Continue improving football realism and simulation richness without adding
unmeasured score bonuses or undoing recent correctness fixes. The current code
compiles and produces deterministic seeded output. Work in small slices,
measure each behavior change, and prefer mechanisms that explain what is seen
on screen.

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
- Player orientation is now drawn as legs plus a head rather than a triangle.
  Facing turns remain capped, slide tackles keep their captured orientation,
  and headed contact uses `headingAnim` plus a short `header` event ring.
- Preserve `cross_to_shot`, `cross_goal`, `gk_distribution_result` and
  `gk_save_assessment` events. Preserve `bad_gk_distribution`,
  `bad_player_distribution`, `unrealistic_gk_save` and
  `poor_gk_save_attempt` flags; their context values make bad seeds
  reproducible instead of anecdotal. Headed same-team cross contacts begin an
  active cross-origin shot chain so a later save or goal stays attributable.
- Keep alert semantics narrow. Do not bring back broad
  `player_way_off`/`defender_passive` spam or count normal receptions as rapid
  turnovers.

## Current Evidence

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

## Recommended Next Slice

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

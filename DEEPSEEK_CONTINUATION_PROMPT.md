# DeepSeek Continuation Prompt: Realism Pass After Contact And Visual Repairs

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
- Keep alert semantics narrow. Do not bring back broad
  `player_way_off`/`defender_passive` spam or count normal receptions as rapid
  turnovers.

## Current Evidence

Current `npm.cmd run benchmark` runs seeds 101-108 for ten simulated minutes:

| Metric | Value |
| --- | ---: |
| Goals / match | 0.6 |
| Shots / match | 5.3 |
| Shots on target | 54.8% |
| Pass completion | 80.3% |
| Interceptions / match | 64.6 |
| Through balls / match | 33.4 |
| Through completion | 46.4% |
| Timed runs / match | 1.5 |
| Timed-run offsides / match | 0.3 |
| Offsides / match | 0.3 |
| Middle-third territory | 62.6% |

The most frequent quality flags are `repeated_pass_pair` (50) and
`ball_unclaimed` (27). Cross accounting works, but wide delivery remains too
rare for confident tuning. Timed offsides are now present without selecting
illegal receivers.

## Recommended Next Slice

Diagnose repeated circulation before changing pass choices:

1. Add metrics for possession-chain progression and repeated-pair context,
   separating harmless recycling under pressure from stagnant loops.
2. Replay seeds `101`, `105`, and `108`, and identify which pair flags occur
   without territorial progress or an eventual shot/cross.
3. Only then alter utility or introduce an outlet/run mechanism; log which
   repeated chain was broken and what replaced it.
4. Compare the standard benchmark after the single measured change.

Acceptance criteria:

- `repeated_pass_pair` declines for stagnant chains, not merely because normal
  possession is being lost sooner.
- Shots do not fall below the current 5.3-per-match benchmark without a clear,
  measured improvement in chance quality.
- Determinism remains true for identical source, seed, and inputs.

A simple penalty on recently repeated non-progressive receiver pairs has
already been tried and rejected: it reduced pair flags from 50 to 40, but
shots fell from 5.3 to 4.4 and `no_shots` alerts increased.

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

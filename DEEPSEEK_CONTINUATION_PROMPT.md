# DeepSeek Continuation Prompt: Native Engine After Consolidation

## Current Runtime

The C++ engine is now the only simulation runtime. Do not restore or edit the
deleted TypeScript simulator files. Authoritative simulation files are:

- `native/main.cpp`
- `native/engine.hpp`
- `native/agent.hpp`
- `native/constants.hpp`
- `native/types.hpp`
- `native/rng.hpp`

TypeScript remains only for browser rendering, the paced live relay and native
test drivers:

- `src/cpp-server.ts`
- `src/native-batch.ts`
- `src/native-scenarios.ts`
- `src/main.ts`
- `src/renderer.ts`

The live relay executes `native/live.exe`. Headless tests execute
`native/benchmark.exe`; the two executable names are intentionally distinct
because Windows locks the running live binary.

## Mandatory Workflow

For one behavioral mechanism at a time:

```powershell
npm.cmd run build
npm.cmd run scenarios
npm.cmd run benchmark
```

Record the baseline, edit one diagnosed mechanism with telemetry or a scenario
where appropriate, rerun the same commands, and reject the edit if it worsens
realism or reopens a hard guard. Never use broad reset/checkout operations in
the shared worktree.

`npm.cmd run benchmark` concurrently executes seeds `101-108` for ten
simulated minutes, making regular C++ comparisons practical.

## Accepted Native Baseline

As of `2026-05-26`, the accepted standard result is:

| Metric | Value |
| --- | ---: |
| Goals / match | 0.6 |
| Shots / match | 3.9 |
| Shots on target | 48.4% |
| Pass completion | 81.8% |
| Tackle attempts / match | 35.4 |
| Knock-aheads / turnovers per match | 2.5 / 0.3 |
| Questionable press selections / match | 5.1 |
| Unmarked final third | 12.2% |
| Carrier turns over 30 degrees / match | 0 |

Hard guards are currently zero for stuck carriers, long or out-of-play tackle
deflections, own-pass goals, unknown loose-ball goals, better-pass shot
choices and tight-angle shot choices. Preserve that.

## Latest Diagnostic

`shotSelection` now samples centre-forward eligible openings at most once per
500 ms. A sample requires distance under `190` px, goal opening over `9`
degrees and at most one nearby defender.

The standard benchmark reports:

| Sample | Per match |
| --- | ---: |
| CF credible windows | 3.6 |
| CF deferred windows | 3.6 |
| Deferred for dribble | 3.6 |
| Deferred for pass | 0.0 |
| CF close windows under 120 px | 0.0 |
| CF close deferred windows | 0.0 |

A targeted shooting score bonus for the `120-190` px windows was tried and
rejected. It reduced shots from `3.9` to `2.9` and goals from `0.6` to `0.4`
per match. Do not reapply it or loosen goal/shot geometry. The diagnosis is
that the engine needs legal close chance construction, not speculative shots.

## Next Slice

The largest explicit native realism hole is that these methods are still
placeholders in `native/engine.hpp`:

- `GameEngine::isOffsideTarget`
- `GameEngine::offsideLineFor`
- `GameEngine::committedRunFor`
- `GameEngine::teamPhaseFor`

Implement offside eligibility together with coherent onside forward support
movement. A bare offside filter may further suppress already-low legal chance
volume; evaluate the whole contract through fixed-seed results and add
scenario coverage for onside/offside delivery eligibility before accepting it.

After that, target the two measured excesses:

- Pass completion is `81.8%`, above the intended `75-80%` range.
- Tackle attempts are `35.4` per ten-minute match and need replayable
  reduction without creating passive defenders.

## Constraints

- Do not increase ordinary collection reach or the `24` px tackle reach.
- Do not weaken the physical goal aperture or accept visually missing goals.
- Do not restore ghost dispossessions or privileged knock-ahead collection.
- Do not force medium-range shots solely to raise shot count.
- Keep the live relay on `native/live.exe` and benchmark driver on
  `native/benchmark.exe`.

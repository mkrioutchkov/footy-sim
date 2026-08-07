# Golden baseline — engine determinism reference

> **Baseline generation:** 2026-08-07, after the three-defect audit round (the
> defects recorded in GAME_LAYER_NOTES.md's 2026-08-05 anomaly hunt). **(1)** The
> loose-ball freeze watchdog now arms its "is anyone actually coming for it?"
> baseline on the nearest **outfielder** instead of the nearest player. A keeper
> standing near a dead ball pinned that baseline so low no genuine chaser could
> ever beat it, so the watchdog fired on top of live chases and rolled the ball
> away from the man about to reach it. Censused over seeds 101-140 @90min, pre-fix:
> **13 fires, 13/13** with an outfielder who had closed since the watch armed
> (median 224px at arm time down to 66px at the fire), 3 of them shoving the ball
> to a keeper; post-fix **0**. **(2)** `preventableGoals` was structurally
> unreachable — `saveChance >= 0.90` against a value clamped to GK_SAVE_MAX = 0.76 —
> and now gates on `GK_SAVE_MAX * GK_PREVENTABLE_SAVE_FRAC` (0.95). Stat-only, and
> proven so: 39/40 seeds @90min byte-identical, the 40th differing in that one
> field and nothing else. **(3)** `SubstitutionRecord` gained `outYellowCards` so a
> booked-then-substituted man's card survives the swap; purely additive, 40/40
> @10min and 12/12 @90min identical once the new key is stripped.
>
> Only the watchdog moves the RNG stream, and only on seeds where it used to fire:
> **2 of the 40 golden seeds drift at 10min** (106, 129), 11 of 40 at 90min — those
> are the seeds where the WATCHDOG fired; at 90min a 12th row (seed 116) also moves,
> from the preventableGoals flag, which is stat-only and reshuffles nothing. At
> 10min×40 not one of 282 metrics clears noise and goals is identical seed-for-seed.
> At 90min×40 the only REAL** verdict is `simulationFreezes` 0.325 → 0.000 (the
> intended effect, and it replicates: 0.42 → 0.00 on seeds 141-180). Goals +0.375
> was the largest headline movement but **did not replicate** — an independent batch
> (141-180) gave −0.25, pooling to +0.06 over 80 paired seeds; goal count remains the
> noisiest stat and this is a chaotic re-draw in 11 matches, not a scoring change.
> Match length is unchanged (mean clockMs +0.05%, longest match +1.5s), so silencing
> the watchdog does **not** bring back the dead-ball hang it exists to break, and
> stuckCarrierAlerts / invariantViolations / unknownLooseGoals / ownPassGoals are 0
> before and after. `npm run scenarios` passes.
>
> Prior baseline note: 2026-07-07, after the ghost-corner fix (a cut-near-line
> corner is only awarded when the ball is genuinely heading behind the goal line,
> in bounds, off a goal-side defender — not for an overhit cross drifting out by
> the flag). Corners 5.28 -> 4.47 per 30min (clear ghosts removed); goals/shots
> essentially flat (the removed corners were illegitimate). Prior baseline note:
> after the seed-105 watch round
> (distance-scaled fast free-kick frequency; crosser/lofted-passer facing
> pivot for the render; GK long-distribution mix and anti-keeper-swarm both
> A/B-rejected and tombstoned). Measured at 30min×40 vs the prior build:
> shots-on-target +0.40, clearances +3.0, goals −0.15 (goal count is the
> noisiest stat — on-target moved the other way); all metrics realistic.

Frozen reference for verifying that an engine refactor is **behaviour-preserving**.
The engine is deterministic (same seed + spec + binary ⇒ byte-identical output),
so a *pure* refactor must reproduce this baseline **byte-for-byte**. See
CLAUDE.md "Changing the engine": any real behavioural change
reshuffles the RNG stream and moves emergent stats, so byte-identity is the only
proof a refactor changed nothing.

## Files

- `fingerprint.sha256` — sha256 of the seed-ordered per-seed summaries. The single
  gate: match ⇒ pure refactor.
- `baseline_summaries.jsonl` — one raw `--summary` line per seed (101–140), in seed
  order. The actual byte-identical reference; diff a drifting seed against its row
  to see which stat moved.
- `baseline_batch.json` — the human-readable aggregate benchmark (`native-batch.ts`,
  40 seeds). This is the "should stay ~95% the same" dashboard; a pure refactor
  keeps it 100% identical.

## Frozen parameters

| | |
|---|---|
| seeds | 101–140 (40 matches) |
| minutes | 10 |
| flags | `--summary --no-debug` |
| build | `g++ -std=c++20 -O2 -I third_party -o build/live.exe engine/*.cpp` |

The build toolchain is part of the fingerprint — floating-point results can differ
across compilers/opt levels, so regenerate the baseline if the toolchain changes.

## Verify a refactor

```
bash tools/golden/verify.sh          # rebuild + rerun + compare  → ✓ BYTE-IDENTICAL or ✗ DRIFT (per-seed)
```

## Regenerate (only when a change is a *deliberate* balance change, measured & accepted)

```
for s in $(seq 101 140); do ./build/live.exe $s 10 --summary --no-debug | tail -1; done > tools/golden/baseline_summaries.jsonl
sha256sum tools/golden/baseline_summaries.jsonl | awk '{print $1"  seeds 101-140 @10min, g++ -O2 -std=c++20"}' > tools/golden/fingerprint.sha256
npx tsx tools/native-batch.ts --matches 40 --minutes 10 --seed 101 > tools/golden/baseline_batch.json
```

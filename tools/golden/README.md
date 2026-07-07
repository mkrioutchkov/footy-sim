# Golden baseline — engine determinism reference

> **Baseline generation:** 2026-07-07, after the ghost-corner fix (a cut-near-line
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
`docs/ENGINE_AUDIT_2026-07.md` "Golden rule": any real behavioural change
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

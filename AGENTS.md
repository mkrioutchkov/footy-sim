# AGENTS.md — Footy Sim autonomous workflow

## Loop protocol
When asked to "iterate" or "continue autonomously", follow this cycle:
1. `npm.cmd run build` and `npm.cmd run scenarios` — verify correctness guardrails.
2. Run a fixed seeded baseline, preferably `npm.cmd run benchmark`.
3. Identify one diagnosed mechanism behind the largest credible gap.
4. Make one targeted code change and add telemetry or a scenario check when a new rule is introduced.
5. Rerun `npm.cmd run build` and `npm.cmd run scenarios`.
6. Rerun the exact same seeded benchmark command used in step 2.
7. If accepted, stage only intended files, commit with the measured result, and push.
8. If rejected, inspect the diff and remove only the current experiment; never discard unrelated work.
9. Repeat from step 1.

## Runtime Ownership
- `native/*.hpp` and `native/main.cpp` are the authoritative simulation.
- `src/cpp-server.ts` relays `native/live.exe` for visible play.
- `src/native-batch.ts` and `src/native-scenarios.ts` drive `native/benchmark.exe`.
- The retired TypeScript simulation source is not a reference implementation to restore.

## Target bands
| Metric | Current | Target |
|--------|---------|--------|
| Goals/match | 0.6 | improve from credible close chances |
| Shots/match | 3.9 | 6+ credible chances |
| On target % | 48.4% | 35-50% |
| Pass completion | 81.8% | 75-80% |
| Tackle attempts/match | 35.4 | reduce repeated challenges safely |
| CF credible/deferred samples | 3.6 / 3.6 | create close options first |
| CF close deferred samples | 0.0 | do not force medium shots |
| Questionable press | 5.1 | <12 |
| Unmarked final third | 12.2% | monitor while increasing chances |
| Hard quality guards | 0 | keep at zero |

## Rules
- Never increase contact distances (max intercept 20px, tackle 24px)
- Aerial contact must also remain within the ordinary 20px visible-contact radius.
- Never weaken goal aperture constraints
- Implement offside eligibility and onside supporting runs as one measured slice; native offside methods are currently placeholders.
- Prefer diagnosed behavior changes over stacked score bonuses.
- Treat telemetry as invalid until its definition is bounded and covered by a scenario or replay.
- Do not relabel forward wide crosses as cutbacks; preserve origin-specific cross attempts, shots and goals.
- Preserve dribble speed tiers and loose-ball knock-ahead contact rules; do not grant a burst intended-receiver reach or shielding.
- Use `knock_ahead_result` and `bad_knock_ahead_turnover` to tune risky bursts, starting with seed `103`.
- Always benchmark after every change
- Commit after measurable improvements
- Push after every 2-3 commits
- Use identical deterministic seeds for before/after comparisons.
- Never use broad checkout/reset commands to discard an experiment in a shared worktree.

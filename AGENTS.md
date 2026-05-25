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

## Target bands
| Metric | Current | Target |
|--------|---------|--------|
| Goals/match | 0.4-2.0 | 1.0+ stable |
| Shots/match | 3-8 | 6+ |
| On target % | 37-75% | 35-50% |
| Pass completion | 73-82% | 75-80% |
| Open-play crosses/match | 2.4 | audit repetitive outliers |
| Open-play cross shots/match | 1.0 | retain origin attribution |
| Through-balls | 24-47 | 25-40 |
| No_shots flags | 1-12 | <5 |
| Avoidable press | 12-16 | <12 |
| Unpressured clearances | 0-? | benchmark |
| Time-wasting dribbles | 0-1 | track |

## Rules
- Never increase contact distances (max intercept 20px, tackle 24px)
- Aerial contact must also remain within the ordinary 20px visible-contact radius.
- Never weaken goal aperture constraints
- Prefer diagnosed behavior changes over stacked score bonuses.
- Treat telemetry as invalid until its definition is bounded and covered by a scenario or replay.
- Do not relabel forward wide crosses as cutbacks; preserve origin-specific cross attempts, shots and goals.
- Always benchmark after every change
- Commit after measurable improvements
- Push after every 2-3 commits
- Use identical deterministic seeds for before/after comparisons.
- Never use broad checkout/reset commands to discard an experiment in a shared worktree.

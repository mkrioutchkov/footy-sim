# AGENTS.md — Footy Sim autonomous workflow

## Loop protocol
When asked to "iterate" or "continue autonomously", follow this cycle:
1. `npm run build` — verify no regressions
2. `npm run batch -- --matches 2 --minutes 10 --seed <increment>` — measure current state
3. Identify the single biggest gap vs targets
4. Make ONE targeted code change (no sweeping rewrites)
5. `npm run build` — verify
6. `npm run batch -- --matches 2 --minutes 10 --seed <new>` — measure impact
7. If improved → `git add -A && git commit -m "<metric> change" && git push`
8. If regressed → `git checkout -- src/` and try different approach
9. Repeat from step 1

## Target bands
| Metric | Current | Target |
|--------|---------|--------|
| Goals/match | 0.4-1.1 | 1.0+ stable |
| Shots/match | 3-6 | 6+ |
| On target % | 30-50% | 35-45% |
| Pass completion | 73-78% | 75-80% |
| Crosses/match | 0.1-1.5 | 1+ |
| Cross shots/match | 0-0.5 | 0.5+ |
| Through-balls | 24-47 | 25-35 |
| No_shots flags | 2-12 | <5 |
| Avoidable press | 12-16 | <12 |

## Rules
- Never increase contact distances (max intercept 20px, tackle 24px)
- Never weaken goal aperture constraints
- Prefer small score tweaks over architectural changes
- Always benchmark after every change
- Commit after measurable improvements
- Push after every 2-3 commits
- Use deterministic seeds for comparisons
- If stuck, revert to last good commit and try different approach

# DeepSeek Review Brief: Player Intelligence in Footy Sim

## Assignment

Act as a senior simulation-AI reviewer. Review this football simulation prototype with a narrow priority: improve the intelligence and credibility of player behavior before more systems are built on top of it.

Do not begin by implementing feature work. First establish whether the existing decision model, coordination model, telemetry, and simulation loop are trustworthy enough to tune. Produce a critical review and a practical plan of action.

## Review Goals

The prototype needs players that:

- make plausible on-ball choices: retain, progress, switch, dribble, shoot, or clear under appropriate pressure;
- behave coherently off the ball: offer passing lanes, maintain shape, make runs, mark, cover, press, and recover;
- demonstrate visible differences from player attributes and manager instructions;
- can be evaluated repeatably so that "smarter" behavior is measurable rather than anecdotal.

Favor a small, testable decision architecture appropriate for prototyping over elaborate AI systems that cannot yet be validated.

## Codebase Context

The app is a TypeScript football simulation. A Node/WebSocket server runs the simulation and a PixiJS client renders state.

Read in this order:

1. `src/agent.ts`: per-outfield-player utility selection, perception, movement, passing, shooting, defending.
2. `src/engine.ts`: loop order, ball interactions, passing/collection, GK behavior, role assignments, stats and debug telemetry.
3. `src/types.ts`, `src/intention.ts`, `src/constants.ts`: behavioral contracts and tuning model.
4. `src/manager.ts`, `src/teams.ts`: tactical controls, randomized players and reproducibility.
5. `src/server.ts`: log persistence and match lifecycle.
6. `DESIGN.md`: intended architecture and logging expectations.

Current runtime structure:

- Simulation: fixed-timestep `GameEngine`, nominal 60 Hz.
- Outfield intelligence: one `PlayerAgent` per player; GK logic remains inside the engine.
- Action style: utility-score candidates for `pass`, `shoot`, `dribble`, `tackle`, `mark`, `chase`, `position`, and `hold`.
- Team coordination: engine-created assignment map plus per-team blackboards.
- Logs: JSONL sessions under `../.scratch/footy-sim-logs/`.

## Verified Baseline Evidence

Treat these as observations to validate and explain, not as conclusions to accept without checking.

### Build State

Running `npm.cmd run build` on 2026-05-24 fails:

```text
src/engine.ts(1677,1): error TS1005: '}' expected.
```

The on-disk source is therefore not currently a reliable reproducible baseline. The running log session may have been started from an earlier parseable state.

### Latest Active Session Snapshot

Source log: `../.scratch/footy-sim-logs/game_20260524T065312Z_glibk4.jsonl`.

At approximately 15.2 simulated minutes, the latest `distance` entry reported:

| Metric | Observation |
| --- | ---: |
| Pass attempts | 463 |
| Completed passes | 243 |
| Apparent pass completion | 52.5% |
| Reported interceptions | 0 |
| Offsides observed through the snapshot | 57 |
| Offsides / pass attempts | 12.3% |
| Shots | 5 |
| Territory in middle third | 84% |
| Possession | home 48%, away 52% |

Decision logging through roughly the same run is dominated by off-ball positioning/marking. Logged on-ball choices are sparse because decision logging samples only periodically, but the event totals still suggest low attacking yield and excessive offsides.

### Comparison Session

The prior log `../.scratch/footy-sim-logs/game_20260524T064705Z_f8a87v.jsonl` covered approximately 13.0 simulated minutes and recorded 357 pass attempts, 172 completed passes, 39 offsides, and 7 shots in its final `distance` snapshot. This is enough to motivate instrumentation and decision work, but not enough for statistically meaningful tuning.

## Preliminary Findings To Confirm

These are suspected high-value findings from an initial inspection. Confirm severity, find related cases, and correct any mistaken inference.

### P0: Establish a Valid Measurement Baseline

- `src/engine.ts` currently has a syntax error at end of file, so all intelligence work starts from a broken baseline.
- `src/engine.ts` declares `qLastQualityCheck` but `simQualityCheck()` uses `lastQualityCheck`; once parsing is fixed this should fail type checking or require correction.
- `src/server.ts` accumulates `entriesReceived` by adding the current cumulative sequence number on every flush, inflating metadata rather than counting persisted entries.
- `collectBall()` assigns `ball.lastTouchTeam = collector.team` before using it to determine whether the collector intercepted a pass. The opposing-team comparison can no longer succeed, which explains reported interceptions remaining zero despite failed passes.
- There is no seeded randomness or repeatable headless match runner. Attribute generation, manager settings, pass errors, duels, runs, shots, and restarts all use `Math.random()`.

Questions:

- Which metrics can be trusted from existing logs?
- What minimum deterministic match harness and telemetry schema are required before any tuning?
- What realistic target bands should be tracked for passes, shots, possession transitions, offsides, territory, defensive shape, and role involvement?

### P1: Team Coordination Is Calculated But Not Driving Players

- `GameEngine.updateTeamAssignments()` creates `primary_press`, `cover`, `lane_block`, `support_outlet`, and `run_ahead` assignments.
- `PlayerAgent` does not call `engine.assignmentFor()` or otherwise consume those assignments.
- The blackboard pressing/marking arbitration occurs while agents execute sequentially, after clearing slots each tick. This may make behavior iteration-order dependent instead of selecting the tactically best player.
- `activeRuns`, `zoneClaims`, and `passPairCount` exist on `TeamBlackboard` but do not appear to drive decisions.

Questions:

- Should coordination own team intent and give bounded instructions to agents, or should it be removed until needed?
- What is the minimal coordination model needed for pressing roles, defensive cover, outlets, and runs?

### P1: Perception And Intent Are Not Coherent Abstractions

- `src/intention.ts` defines `Perceived`, `Phase`, and `zoneFromX`, but `agent.ts` defines a separate local perception interface and appears not to use the shared module.
- The agent maintains ball memory and facing, yet its perception and many tactical calculations access exact engine state. The resulting information model is neither fully omniscient nor meaningfully perception-limited.
- A fresh utility competition is effectively performed every tick, with stickiness bonuses but little explicit action intent, commitment horizon, or transition state.

Questions:

- For this prototype, should player knowledge deliberately be omniscient and deterministic, with perception introduced later, or should a real perception boundary be enforced now?
- Would a small hierarchy of team phase, role task, and execution intent produce more controllable intelligence than continually adding score modifiers?

### P1: On-Ball Choice Does Not Yet Model Football Risk Well

- Passing uses many hand-added score bonuses, simple lane blocker counts, and role preference rules. It does not expose a clear expected-value calculation for completion probability, progress, receiver pressure, turnover danger, offside risk, or shot value.
- Offside rates in both sampled sessions are high enough to investigate before adding further attacking behaviors.
- Pass release and collection physics, receiver shielding, lofting, and selection are tightly coupled; low completion can be a physics issue, a target-choice issue, or both.
- The current escape behavior can force a pass after stalled possession, bypassing ordinary decision quality.

Questions:

- How should pass utility be decomposed so failed passing can be attributed to selection, execution, receiving, or defensive action?
- What simple spatial value model is justified now: field progression, zones, approximate expected threat, or another compact proxy?

### P1: Off-Ball And Defensive Behavior Need Explicit Outcomes

- Position candidates are numerous and heavily heuristic, making it difficult to know why shape succeeds or fails.
- Defenders independently mark/tackle/chase while the unused coordinator separately computes roles.
- Pressing selection, cover shadows, compactness, offside line behavior, recovery runs, overloads, and width require outcome metrics, not just visual observation.
- Tackling is attempted via random chance at close range; it is difficult to distinguish bad engagement decisions from unlucky execution.

Questions:

- Which team-shape measurements best expose intelligence defects in this prototype?
- Which behaviors should be coordinated centrally and which remain local execution choices?

## Required Deliverable

Produce a review with these sections:

1. **Findings**: prioritized P0/P1/P2 issues with specific file and line references, behavioral consequence, and evidence required to confirm each issue.
2. **Diagnosis Of Current Intelligence**: what the agents currently do well, what makes them appear unintelligent, and which failures are actually engine/telemetry failures rather than decision failures.
3. **Architecture Recommendation**: the smallest credible player-intelligence architecture for this prototype. State whether to retain utility AI, add tactical phases/tasks, restructure perception, or replace any current mechanism.
4. **Evaluation Harness**: seeded simulation design, scenario tests, match aggregates, log corrections, and acceptance metrics.
5. **Plan Of Action**: staged implementation order with expected benefit, effort/risk, files affected, and stop/go criteria.
6. **First Two Implementation Slices**: tightly scoped changes suitable for immediate implementation after review, with tests/measurements that demonstrate value.

Be direct. Do not recommend machine learning or large rewrites unless a simpler controlled system cannot meet the prototype's needs.

## Proposed Action Plan For Critique

Use this as a starting proposal, and change it where the evidence demands it.

### Phase 0: Make Behavior Measurable

- Restore a compiling source baseline and add a minimal test/check command.
- Fix event/stat tracking before using completion, interception, shot, or quality numbers for tuning.
- Introduce seeded random generation and a headless batch-match entry point.
- Add aggregated reporting by role and phase: possession chains, pass destination/outcome, turnovers, shots, offsides, progression, pressure, and shape.

Stop/go criterion: identical seeded runs produce identical aggregate output, and core metrics reconcile with logged events.

### Phase 1: Establish Team Intent And Agent Contracts

- Decide on explicit team phases such as settled possession, transition attack, settled defense, transition defense, and restart.
- Make a coordinator choose a small number of meaningful tasks per phase: presser, cover, outlet, runner, width holder, line holder.
- Have agents consume assignments and choose execution actions within their task.
- Remove or defer unused abstractions instead of letting duplicate planning models accumulate.

Stop/go criterion: visual and logged player role allocation is explainable, stable, and no longer iteration-order driven.

### Phase 2: Improve Decisions With Interpretable Utility

- Refactor pass evaluation into traceable components: completion probability, progression/threat benefit, turnover cost, receiver state, and offside exclusion.
- Separate action selection from execution noise so attributes affect observable outcomes in controlled ways.
- Add possession intent duration/cooldowns where tick-by-tick re-selection causes oscillation or implausible decisions.
- Define compact shooting and dribble value models rather than stacking special-case bonuses.

Stop/go criterion: scenario tests choose credible options and batch results improve within defined target bands without hand-fixing each role.

### Phase 3: Improve Off-Ball And Defensive Intelligence

- Model compact team shape, width/depth, passing-lane support, run timing, pressing triggers, cover shadows, and recovery priorities.
- Track whether intended defensive behaviors reduce dangerous entries and shots without producing passive matches.
- Expand manager controls only after their influence is observable and testable.

Stop/go criterion: tactical variation changes behavior predictably while basic football flow remains credible.

### Phase 4: Tune And Decide Prototype Direction

- Run seeded batches across formations and attribute profiles.
- Tune thresholds from aggregate failures and selected visual replays.
- Decide whether current architecture is sufficient for the product direction before building deeper management, animation, or match-rule features.


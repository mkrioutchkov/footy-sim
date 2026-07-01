# Engine audit — 2026-07 (deterministic C++ match engine)

A deep-dive correctness audit of `engine/`. Method: the engine compiles clean on
Linux with `g++ -std=c++20 -O2 -I third_party -o build/live engine/*.cpp` and is
deterministic, so findings were verified both by code reading and by empirical
A/B (30-seed sweeps, paired base-vs-fix binaries) + binary traces + `audit_weird.py`.

## Golden rule discovered this pass (read before "fixing" anything)

**Almost any *behavioural* change shifts the goal rate.** Changing a constant or a
decision reshuffles the RNG stream (butterfly), so every match diverges — and the
goal rate is an emergent, *sensitive* quantity. Consequences:

- The only **provably goal-neutral** fixes are those that are **byte-identical to
  baseline except in a rare/broken state** (e.g. the sent-off-player fixes below,
  which only differ once a red card exists) or **simulation-invariant** (dead-code
  removal, stat-only counters). Everything else must be treated as a *balance*
  change and measured on ≥30 seeds.
- The finishing conversion is **not tractable via single dials.** The dev-intended
  "primary goal-rate dial" `SHOT_SCOOP_CHANCE` moves goals only ~0.3 across its whole
  0.80→0.98 range (within noise); keeper reach and shot-error knobs are similarly weak.
  Holding goals while cutting cross/through-ball volume needs a *structural* finishing
  re-model, not tuning.

## Shipped (goal-neutral / match-integrity) — on `master`

1. **Match-hang fix** (`ee38f03`) — a loose ball abandoned in a corner (controller −1,
   at rest) was never rescued: `detectSimulationFreeze` ignored loose balls, the
   half-end whistle needs the ball out of the final third, and the +5:00 hard cap
   exited without finishing. 13% of matches hung (some never played the 2nd half).
   Fix: loose-ball rescue + proper hard-cap finish + bounded added-time overrun.
2. **Sent-off players excluded from back-line geometry** (`1cf0e37`) —
   `assignDefensiveRoles` "deepest runner" loop (`engine_defense.cpp`) and
   `posDefensiveLine` back-line average (`agent_positioning_helpers.cpp`) read
   ejected players parked off-pitch (y=−40) at their homeX. Every other geometry
   loop already skips `sentOff`; these two didn't. Byte-identical to baseline
   except in red-card matches (verified).
3. **Dead-code removal** (`1cf0e37`) — unreachable `receiver.crossCollected = 1500`
   in `resolvePendingPass` (every `plausibleHeader` path above it returns).

## HELD — real correctness fixes with a goal side-effect (need a balance call)

These are genuine bugs, but each shifts the goal rate, so they are parked for an
explicit decision rather than shipped.

| # | Fix | File:line | Measured goal impact | Notes |
|---|-----|-----------|----------------------|-------|
| A | Away retreat-cover `clamp` bounds reversed (`clamp(mid, og, p.x)` with og=1050>p.x collapses every away retreat target to the own goal line) → use `clampRange` | `agent_positioning_helpers.cpp:41` | **+0.65 goals** (23 seeds); also **corrects a backwards home/away asymmetry**: baseline home 1.30 < away 1.70 (home *disadvantage*), fixed → home 2.00 > away 1.65 (realistic ~+0.35 home advantage) | Strong correctness/fairness case; the away team currently bus-parks on its own line due to the bug. |
| B | Out-of-play test at the goal line uses whole-ball (`b.x + BALL_R < 0`); a ball resting with its centre behind the line is never a goal-kick/corner. Center-based `b.x < 0` matches the touchline test | `engine_physics.cpp:228/239` | **+0.6 goals** (isolated on no-red matches) | Was shipped in `1cf0e37`, then **reverted** (`2448903`) after the A/B showed it is not goal-neutral. It changes the restart of *every* byline-out ball. The freeze-rescue already backstops the rare dead-ball case, so nothing hangs without it. |
| C | End-of-match "nervy closing minutes" AI (harder press/chase, concentrated long-range screamers, urgent play out of the def third) keys off `phase.addedTimeActive`, which is true in **both** halves' added time — so it wrongly fires during *first-half* stoppage | `agent_shoot_dribble.cpp:131`, `agent_pass_helpers.cpp:326`, `agent_defend.cpp:154/473` | not measured (behavioural, ~1–2 min/match window) | Clean fix: gate on `half == 2` (add a `phase.matchClosing()` helper). |
| D | Free-kick "no pass target" fallback re-arms into a taker-less held-ball state the malformed-arm watchdog can't see → ~2.7s frozen restart until `auditStuckCarrier` force-passes | `engine_setpiece.cpp:269` | negligible (self-heals) | Low value; touches the delicate set-piece state machine. |
| E | **Loose-ball "separation standoff"**: a dead ball has no controller, so no chaser is exempt from the mutual `separateTeammates` push; 2+ converging players cancel each other and orbit ~20-33px out, never reaching the ~14px collect radius → the ball sits dead for 1-3s. Fix: exempt the single nearest eligible chaser (like the controller) | `engine_physics.cpp:30` (`separateTeammates`) | **+0.38 goals** (24 seeds, SEM 0.34 — borderline); reduces freeze-rescues (12→5/24 matches) and LOITER/dead-ball stalls | Match-integrity/polish (same character as the shipped freeze fix, distinct root cause). Prototype cut the worst standoff 5.4s→2.2s. Held only because the goal delta isn't provably zero. |
| F | Finish-flags (`crossCollected`/`firstTouchFinish`/`throughCollected`) are set just before `shootBall()` and never cleared on the shot — they decay over 900-1400ms, so a SAME-player rebound shot inside that window re-applies the first-time-finish error reduction (and re-counts `recordHeadedShot`) | `engine_actions.cpp:156`, `engine_physics.cpp:305` | negligible (rare: same player, rebound, <1s) | State-leak; clear the flags at the end of `shootBall()`. Very low frequency. |

## Rejected after verification (NOT bugs — don't re-file)

- **Cross "bend" up to 178°** → `COLLISION_REFLECT_FACTOR = 1.3` is correct physics
  (factor = 1 + restitution; 1.3 = a 0.3 restitution body-block). The 178° is the
  `audit_weird.py` tool conflating a legit deflection with in-flight curl.
- **Tackle attempts ~721/match** → metric-definition artifact: the engine counts
  loose-ball *deflections* as tackle wins. A tackle-recovery lock-out had no effect
  (post-miss the ball is already loose, so `scoreTackle` returns 0 anyway) and
  regressed goals. Devs already know duel volume is hard ("five rounds of score
  tweaks failed to dent ~1400 duels/match").
- **Loose-ball press-cap bypass (crowding)** → real but tiny (−5% crowd) and part of
  a goal regression when fixed.
- **GK "tip over the bar" counted in `keeperClaimTip`** → deliberate
  (`BORIS_GK_TIP_AUDIT` comment); a doc-vs-code naming nuance, not a bug.
- **`willSave` dead branch / `deepestX` unused** → harmless dead code in delicate GK
  / positioning paths; risk > reward to touch.

## Clean bill of health

- **Sanitizers**: ASan+UBSan clean across 6 full matches (freeze-rescue, red cards,
  corners, offsides, penalties) + the `--match`/directives path fuzzed with
  out-of-range player/target ids and garbage `when`-conditions. No memory errors,
  no UB, no OOB — the engine guards its id indexing.
- **Determinism**: same seed + same binary = byte-identical output (re-verified).

## Subsystems audited clean (no shippable bug found)

Verified by code reading + trace experiments; areas below are correct or only
behavioural/tuning (out of scope):

- **Shooting/dribbling/movement**: knock-ahead state resolution (no leak), dribble
  target sign/side for both teams (byline-seek, cut-inside, round-the-keeper,
  backward-carry clamps), tackle box-discipline goal-side sign, `tackleAnim` is a
  pure render hint (gates no logic), and the give-and-go re-arm guard all check out.
  `evadeSide`/`commitTargetX`/`CarrierPressure` are default-initialised (no
  determinism hazard). Only findings E/F above.
- **GK / stats / determinism**: RNG is splitmix32 seeded once; save double-count is
  gated (`saves ≤ shotsOnTarget` holds); pendingSave/pendingClaim self-heal; no
  small_vector under/overflow.
- **Positioning / marking / offside**: marking targets exclude GK/own-team/sent-off/
  carrier; offside line correct (includes GK per law, skips own+sent-off); no
  duplicate-marker paths. Only finding A above.
- **Set pieces**: spot placement, taker-end selection, penalty/keeper line, offside
  exemptions, and the FK wall are correct. Only findings B(now reverted)/D above.
- **Match flow**: card issuance, 2nd-yellow→red, send-off accounting, subs, injuries,
  clock/half transitions, and `offsideLineFor` are correct. Only findings C + the
  two sent-off-geometry fixes (shipped) above.

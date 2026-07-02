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
  re-model, not tuning. **Re-confirmed post-cut** (commit `84689c7`): with the cross/
  through spam removed, `SHOT_SCOOP_CHANCE 0.80→0.90` still moved goals the wrong way
  (within noise). So the goal rate after the cut (~3.47) is left for a structural
  finishing pass, not shipped as a dial tweak.

## Cross / through-ball volume cut — SHIPPED (commit `84689c7`)

The original request. Over 30 seeds: **crossesAttempted 246 → 73 (−70%)**,
**throughBallsAttempted 121 → 40 (−67%)** — both were ~5x real. Corners (14) and
shots-on-target (8.9) land realistic; health clean (0 unfinished / 0 freeze / 0
invariant / deterministic). Levers: the wide-carrier cross override now fires only for
a genuinely wide carrier in the final third with a good target at a competing weight;
the helper `isCross` bonus trimmed; the through-ball window narrowed to a real
in-behind ball. **Side effect: goals rose 2.77 → 3.47** (removing wasteful possession
lets teams work better chances) — to be re-calibrated via the structural finishing pass
noted above, NOT via dials.

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

## SHIPPED (commit `32332a9`) — all six behavioural correctness fixes

These were initially parked because each shifts the goal rate, then shipped on
direction ("don't care about the goal target so much, easy to fix post-mortem — fix
all"). They are genuine bugs; the goal rate is to be **re-calibrated post-hoc** from
this corrected baseline.

**Combined measured impact (30-seed sweep): goals = 2.77** (vs the 3.07 pre-fix
baseline — the goal-raising fixes A/B and the goal-reducing fix C more than offset, so
the rate lands *on* the ~2.8 real-world target), shots 24.8, with a now-realistic
home/away split (correcting the old backwards home *disadvantage*). Health: 0 unfinished
matches, 0 invariant violations, determinism preserved, and fewer freeze-rescues. So no
post-hoc goal re-tune turned out to be necessary.

| # | Fix | File:line | Measured goal impact | Notes |
|---|-----|-----------|----------------------|-------|
| A | Away retreat-cover `clamp` bounds reversed (`clamp(mid, og, p.x)` with og=1050>p.x collapses every away retreat target to the own goal line) → use `clampRange` | `agent_positioning_helpers.cpp:41` | **+0.65 goals** (23 seeds); also **corrects a backwards home/away asymmetry**: baseline home 1.30 < away 1.70 (home *disadvantage*), fixed → home 2.00 > away 1.65 (realistic ~+0.35 home advantage) | Strong correctness/fairness case; the away team currently bus-parks on its own line due to the bug. |
| B | Out-of-play test at the goal line uses whole-ball (`b.x + BALL_R < 0`); a ball resting with its centre behind the line is never a goal-kick/corner. Center-based `b.x < 0` matches the touchline test | `engine_physics.cpp:228/239` | **+0.6 goals** (isolated on no-red matches) | Was shipped in `1cf0e37`, then **reverted** (`2448903`) after the A/B showed it is not goal-neutral. It changes the restart of *every* byline-out ball. The freeze-rescue already backstops the rare dead-ball case, so nothing hangs without it. |
| C | End-of-match "nervy closing minutes" AI (harder press/chase, concentrated long-range screamers, urgent play out of the def third) keys off `phase.addedTimeActive`, which is true in **both** halves' added time — so it wrongly fires during *first-half* stoppage | `agent_shoot_dribble.cpp:131`, `agent_pass_helpers.cpp:326`, `agent_defend.cpp:154/473` | not measured (behavioural, ~1–2 min/match window) | Clean fix: gate on `half == 2` (add a `phase.matchClosing()` helper). |
| D | Free-kick "no pass target" fallback re-arms into a taker-less held-ball state the malformed-arm watchdog can't see → ~2.7s frozen restart until `auditStuckCarrier` force-passes | `engine_setpiece.cpp:269` | negligible (self-heals) | Low value; touches the delicate set-piece state machine. |
| E | **Loose-ball "separation standoff"**: a dead ball has no controller, so no chaser is exempt from the mutual `separateTeammates` push; 2+ converging players cancel each other and orbit ~20-33px out, never reaching the ~14px collect radius → the ball sits dead for 1-3s. Fix: exempt the single nearest eligible chaser (like the controller) | `engine_physics.cpp:30` (`separateTeammates`) | **+0.32 goals** (50 seeds, 1.2σ — not significant but consistently positive ≈ small real effect; no-red subset +0.35); reduces freeze-rescues and LOITER/dead-ball stalls | Match-integrity/polish (same character as the shipped freeze fix, distinct root cause). Prototype cut the worst standoff 5.4s→2.2s. Held only because the goal delta isn't provably zero. |
| F | Finish-flags (`crossCollected`/`firstTouchFinish`/`throughCollected`) are set just before `shootBall()` and never cleared on the shot — they decay over 900-1400ms, so a SAME-player rebound shot inside that window re-applies the first-time-finish error reduction (and re-counts `recordHeadedShot`) | `engine_actions.cpp:156`, `engine_physics.cpp:305` | negligible (rare: same player, rebound, <1s) | State-leak; clear the flags at the end of `shootBall()`. Very low frequency. |

## Stats-correctness fixes shipped (commit `5519235`) — simulation-invariant

Found by a dedicated stats audit; all three change only reported counters (verified
byte-identical scores + player positions) and all feed `report.ts` player **ratings**:

- **Own goals** no longer credit the conceding player a personal goal/assist or the
  goal's role/header (gate on `lastGoal.touchTeam == scoringTeam`). `report.ts` filtered
  `pGoals` but not assists/`goalsByRole`, so this leaked into ratings.
- **`shotsOnTarget`** now includes scored shots from a tracked shot (was counting only
  *saved* shots — a definitional under-count). Only raises it, so `saves ≤ shotsOnTarget`
  holds. (seed 113: 5→9 = +4 goals.)
- **Per-player `pTackles`** now counts loose-deflection wins, not only clean-control wins
  (was under-counting a ball-winner ~46%). (seed 113: per-player sum 213→352 = aggregate.)

Low-severity stat/telemetry items left unfixed (inert / cosmetic): the `headerAudit.unrealistic`
detector is tautologically always-false (`engine_actions.cpp:105`); `keeperClaimTip` also
counts shot-tips (deliberate per `BORIS_GK_TIP_AUDIT`).

## Keeper distribution freeze fixed (commit `241c80d`)

Sister bug to finding **D** (a held-ball state the malformed-arm watchdog can't see), but
in the **GK open-play distribution** path, and much more frequent. Surfaced by
`native-scenarios.ts` (seed 103 tripped `stuckCarrierAlerts`).

- **Root cause**: step 4 of `releaseGoalkeeperDistribution` ("no clean lane, not swarmed —
  hold and wait") did `setPiece.armed = true` (type stays `None`) to "retry shortly". But
  an armed set-piece routes `fixedUpdate` into `updateSetPiecePhase`, which has **no branch**
  for an armed/type-`None` keeper holding the ball — nothing ever re-called the distribution
  logic. The keeper sat frozen on the ball ~2.7s until the `auditStuckCarrier` watchdog
  force-passed him. Hit ~6/60 seeds (e.g. 103 twice).
- **Fix** (`engine_setpiece.cpp`, `engine.cpp`, `constants.h`, `engine.h`): don't arm —
  re-arm `goalKickMonitor.distributeTimer` (250 ms) so `fixedUpdate` → `releaseSetPiece` →
  distribution retries in **open play** (keeper positioned + tackle-immune). Cap the total
  wait at `GK_MAX_HOLD_MS` (1800 ms): then play the best outlet or hoof long. `holdSinceMs`
  tracks the wait, reset on release and centrally whenever no keeper holds the ball. Also
  **exempt the GK carrier from both the stuck-carrier and simulation-freeze watchdogs** —
  a keeper holding for distribution is legitimate (legal up to 6 s) and now self-capped;
  watching him only produced false-positive rescues that *raced* his own cap (the freeze
  detector even nudged him upfield with the ball).
- **Result**: `stuckCarrierAlerts` 0 across 30×90 min (was 6 seeds); matches complete;
  deterministic; ASan/UBSan clean. Goal rate reshuffles slightly (butterfly) — re-tune post-hoc.

### Wide/corner dead-ball pursuit gap — FIXED (`agent_defend.cpp`)

Instrumentation nailed the mechanism (details preserved below). The nearest defender to a
**stationary uncontested** ball produces a recovery Chase (`scoreChase`), but it caps at
0.96 (free-ball, `d≥45`) / 1.0 (urgent, `d<45`) and **loses action arbitration** to his
shape/line positioning candidate (which scores up to ~1.0), so a dead ball in his own
wide/corner zone is abandoned until the 3 s freeze-rescue teleports it to him.

**Fix**: a single dead-ball recovery override at the top of `scoreChase` (after
`urgentLooseBallRun` is computed, covering BOTH distance bands): when the ball is truly dead
(`bs<15`), loose, on the ground, reachable (`<340 px`), this player `canContest`, and he is
the nearest eligible man, return a Chase scored **1.60** — above any positioning/task
candidate — so recovery wins arbitration. Target is clamped to `BALL_R` (not the usual 10 px
inset) so a ball wedged in the true corner is reachable. Tightly gated to `bs<15`, so all
moving loose-ball play is byte-identical.

**Result** (50×90 min): the freeze-rescue rate fell from **6/40 → 2/50** (~4× fewer), every
originally-affected seed clean, `unfinished=0`, `stuck=0`, determinism preserved, ASan/UBSan
clean. The tail (~2/50) is irreducible: each behavioural change reshuffles which seed
produces a pathologically-wedged corner ball, and those remaining are the freeze-rescue
gracefully self-healing a ball resting in a spot no body can quite reach — the correct
behaviour (defenders now actively pursue dead corner balls) is in place.

<details><summary>Original root-cause note (pre-fix)</summary>

The residual freeze-rescues (~6 per 40×90 min, all `FREEZE LOOSE`) are balls that come to
rest fully dead (`bs = 0`) in a **wide/corner zone** — e.g. seed 103 `(86.8, 661.8)` &
`(87.8, 3.7)`, seed 104 `(960, 5.8)`, seed 114 `(79.8, 6.8)`. Instrumenting the freeze
moment showed the real cause is **pursuit, not collection geometry** (the earlier
dead-zone-radius hypothesis was wrong — `bs<30` already widens the collect radius to 14 px
at `engine_physics.cpp:570`). In every case the nearest player is a **fullback 35–50 px
away** who `canContest=1`, is `blockUntil=0` (not contest-blocked), and is the nearest
eligible man (`nCloserEligible=0`) — yet his target points to a defensive-line/shape
position *away from* the ball, not at it. Traced deeper: `agent_defend.cpp decide()`
**does** produce the recovery — `per.ballIsLoose` is true (`= controllerId<0`), the
hold-shape gate (`agent_defend.cpp:354`) is NOT taken (loose, canContest, `ballDist≈35<180`),
so it returns the `nearestEligibleFreeBall` Chase at `agent_defend.cpp:358`. The player's
final target is nonetheless the shape position, so **the Chase is overridden downstream at
action arbitration** — a higher-weight positioning/formation action beats the 0.96 recovery
Chase for a wide fullback. The ball sits until `detectSimulationFreeze` teleports control to
him at 3 s. Self-heals, deterministic, matches complete — but a real arbitration gap.

Fix direction (needs a 30-seed A/B — behavioural, not goal-neutral; and must be done at the
**action-selection layer**, not by reordering `decide()`): when a player is the nearest
eligible man to a **stationary uncontested** ball, the RecoverLoose Chase must win
arbitration over his shape/formation target (e.g. floor its weight above the positioning
action, gated tightly to `bs≈0 && nearestEligibleFreeBall` so normal shape-holding is
untouched). Held pending verification budget + arbitration-layer investigation, not
correctness doubt.
</details>

## Tools / harness correctness fixes (commit `5dd835f`) — simulation-invariant

Downstream of the `5519235` stat fix (`shotsOnTarget` now includes scored shots):

- **`native-batch.ts`**: `shotsOnTargetPct` added `+ goals` on top of the now-inclusive
  `shotsOnTarget` (double-count); `savePct` / `goalsPerShotOnTargetPct` used `saves+goals` /
  `shotsOnTarget+goals` denominators. All corrected to a single `total('shotsOnTarget')`.
- **`native-scenarios.ts`**: telemetry asserts were `(x ?? 0) >= 0` — trivially true and the
  `?? 0` let an absent field pass. Now assert presence / positive.
- **`audit_weird.py`**: GK-abandon probe measured distance from `goal_x = 35/1015`; true goal
  lines are `0/1050`.

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

## TypeScript game-layer audit (web/backend — separate from the C++ engine)

Extended the audit to the Node game layer (goal-neutral by construction — it doesn't
touch the sim). Results so far:

- **Season / standings / competition** (`season.ts`, `cup.ts`, `career.ts`,
  `objectives.ts`, `board.ts`, `history.ts`, standings in `game.ts`): CLEAN. Points
  3/1/0, `gd = gf - ga`, a stable transitive standings sort, promotion/relegation
  (right teams/count, no off-by-one), prize money, rollover ordering, objective
  thresholds, cup brackets, and history/career best-finish all verified correct.
- **Match result / reports / ratings / news / finances** (`match.ts`, `report.ts`,
  `news.ts`, `finances.ts`, `contracts.ts`, `market.ts`, `scout.ts`): CLEAN. Result
  persistence (no home/away swap), recording aggregation (survives frame sampling),
  possession, finance sign conventions (no double-charge, budget guarded), contract
  expiry, and ratings all correct. Crucially, the 3 engine stat fixes are consumed
  **without double-correction** (report.ts's score-delta attribution degrades
  gracefully). Only residual was **stale own-goal comments** in `report.ts` +
  `CONTRACT.md` (fixed — the logic was already correct).
- **Auth / DB / security** (`auth.ts`, `db.ts`, all `index.ts` routes): CLEAN of real
  defects — the codebase is disciplined: every `/api` route is auth-guarded, every
  mutation scopes SQL to the session team (`AND team_id = ?` etc.), all SQL uses
  bound params (no injection), no IDOR found, humans never share a league, session
  tokens are 24 random bytes with enforced expiry. Only 3 **LOW** hardening notes
  (flagged, NOT auto-applied since auth is sensitive): login is a username-enumeration
  timing oracle (`auth.ts:59` returns before scrypt — add a dummy hash on the miss
  path); session cookie lacks `secure` (has httpOnly+sameSite:lax); no CSRF token
  (sameSite:lax currently covers it).
- **Squad management / manager AI** (`training.ts`, `youth.ts`, `staff.ts`, `morale.ts`,
  `harmony.ts`, `rotation.ts`, `lineup.ts`, `fitness.ts`, `manager/*.ts`): CLEAN. The
  manager test suite passes 21/21; training/decline math (headroom-capped, clamped),
  youth regen (in-range, valid role, no dup slots), fitness/injury auto-sub, morale/
  harmony signs, lineup selection (exactly one GK, valid 11-permutation), and the
  manager AI (only signs affordable players, never fields an illegal XI) all verified.

## Frontend (web/frontend — PixiJS SPA) — 3 live-watch fixes SHIPPED (commit `a6a3a5c`)

Audited the SPA renderer + live-match replay/seek path (the commit log showed past
seek/banner bugs). Found and fixed 3 player-visible defects (typecheck clean):
- **Duplicate scrub markers**: goal/card markers were pushed once per FRAME, not per event
  — an engine event lingers ~78 frames, so one goal stacked ~78 markers (broke the
  highlights reel + `,`/`.` nav). Now deduped per event (renderer's ticker key).
- **False GOAL banner on rewind**: a plain buffer-rewind replayed forward across a goal and
  re-popped "GOAL!"/"HALF TIME" (didn't set replay-suppression mode). Fixed.
- **Invisible mid-stream error**: an error after the first frame was written to a detached
  DOM node (unseen while the pitch froze). Now re-attaches.

Renderer interpolation/seek-snap, sprite id-mapping, sent-off handling, api client
error/race paths, and the watch-teardown lifecycle audited clean.

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
  clock/half transitions, and `offsideLineFor` are correct. Only finding C + the
  two sent-off-geometry fixes (shipped) above.
- **Directives / tactics runtime + injuries/fitness** (2nd wave): CLEAN. Bias arrays
  reset every tick (no cross-tick/cross-match leak), bounded 0..21 indexing, `when`
  windows evaluated correctly & purely from clock+score, team-scope slots consistent,
  byte-deterministic under a 27-directive torture spec; injury severity monotonic and
  cleared on send-off/sub. Only unreachable defensive notes (dial default-intensity
  1.0-vs-0.5-neutral; sub doesn't reset moraleBoost) — not shipped.
- **Ball physics / collision / collection / weather / aerial duels** (2nd wave): CLEAN.
  327k-frame scan found zero NaN / negative-z / hover / tunnel-through; rain & wind
  sign/scale/gate correct; corner-side mapping consistent; extreme cross "bend" is a
  legit header layoff, not a curl error. Only the inert header-detector note above.

## Realism-benchmark pass (Fable session, 2026-07-02)

Method: 20-40 × 90-min sweeps benchmarked against real top-league averages at
every step (`scratchpad/bench.py` pattern — goals, shots, SoT, conversion,
saves, blocks, corners, fouls, cards, offsides, passes, completion, crosses,
pens, headed-goal share, draw rate, watchdogs).

**Shipped** (`3033d8a`, `0493240`, cutback-finish commit):
- Restart pacing: throw-in 4s / corner+FK 7s / goal kick 6s / pen 9s /
  post-goal kickoff 6s / GK hold 2s. `auditStuckCarrier` now skips armed
  restarts (it force-passed every held taker ~2.7s in).
- Composure dwell: unpressured carriers hold ~1-2.8s before non-killer passes.
- Cross rebalance: box-crowd penalties on both cross paths, cutback-only
  clean-window bonus, wide-funnel sugar trim, CROSS_CUTOUT_BASE 0.28→0.40,
  aerial-duel defender base 0.52→0.58.
- Cutback first-time finish (pendingPass.isCutback was render-only).

**Scoreboard** (was → now, real): goals 3.50→2.95 (2.7-2.9) · conv 13.7→11.2%
(10-11) · draws 17.5→~25-30% (25) · headed goals 30→20% (15-20) · fouls 27→23
(20-25) · corners 13.2→11 (10-11) · offsides 3.4 (3-4) · passes 2128→1840
(850-1000) · 0-0s exist again · 0 stuck/freeze/unfinished.

**Structural findings — the three projects that remain** (each A/B'd, reverted,
and documented in code comments at the decision sites):
1. **Press redesign** (`engine_defense_helpers.cpp assignPrimaryPress`,
   `agent_positioning.cpp` LocalCloseDown): median nearest-defender distance at
   pass release is 25px — permanent glue-contact pressing sets the frantic
   tempo AND is the only thing stopping ball progression. Standing off (34-40px
   graded standoff, anti-matador hold-ground jockey) leaked 36-37 shots/match
   because 1v1 jockeys can't delay carriers and wingers carry outside the
   goal-side contain point. Needs: jockey-beats-dribble mechanics + wide
   containment before the standoff can soften. Blocks the remaining pass-count
   gap (1840 vs ~1000).
2. **Cross volume is load-bearing offense** (`agent_pass.cpp` override
   comment): ~70/match vs real 30-40; the override supplies ~50 and per-tick
   re-evaluation defeats thresholds/weights. Restricting it to cross_early
   collapsed attack to 1.05 goals (9/20 goalless). Blocks on №3.
3. **Close-chance positioning**: shot mix close/medium/long = 2/68/30% vs real
   ~20/40/40. Per-bucket conversion is RIGHT — the box occupation is wrong:
   cutback receivers measured at tgd≈195 (edge of box), never in the
   penalty-spot band, so the new first-time finish rarely fires. Widening its
   gate to 215px was rejected (minted 20m pot-shots). Fix in positioning:
   runners must attack the 80-140px band on wide-carry triggers.

### Out-of-sample validation (seeds 301-340, n=40 — never used for tuning)

All session tuning used seeds 201-220; this is the honest held-out scoreboard
for the final tree (`bda26ad`):

goals 3.42 · shots 25.7 ✓ · SoT 9.3 ✓ · conv 13.4% · saves 3.9 · corners 13.1 ·
fouls 23.8 ✓ · yellows 3.2 ✓ · offsides 4.1 ✓ · passes 1810 · completion 86% ·
crosses 69 · headed goals 34% · draws 20% · 0 stuck/freeze/unfinished.

Read: the integrity + discipline + volume stats generalize; **goals (3.4) and
headed-share (34%) read worse out-of-sample than in-sample (3.05 / 25%)** —
partial overfit to the tuning seeds, and a real side effect: the box-burst
runs put bodies in the box while cross volume is still ~70/match, so crosses
find heads more often. Headed-share should normalize when cross volume drops,
which is blocked on central chance supply (the staged cutback work). Use fresh
seed ranges per tuning arc going forward.

### Keeper + 1v1 arc (post ghost-body fix)

- **Save ledger closed**: routine gathers now count as saves (Opta convention);
  the >295px/s gate was calibrated against the old under-counted SoT. Saves
  land 5.3-5.8 (real 5-6). Simulation-invariant.
- **The "dead keeper dial" mechanism found**: dive reach (stand 23.5 + dive
  ≤26px) barely covered typical placement (34-44px off), so saveChance sat on
  the 0.05 clamp floor — coefficient buffs were provably no-ops (byte-identical
  A/B). Re-based the physical reach (17+16·hand) + floor 0.09: goals 3.15→2.90,
  conv/SoT 38→34.5%, same-seed A/B on fresh seeds 401-420.
- **Breakaway drive**: through-ball collectors (27 completed/match) snap-shot
  from 18-25m because `tryFreshBallOverride` returned the shot inside a 0.18
  tolerance regardless of relative scores (another dead-dial: score nerfs
  changed nothing). Far + unpressured collectors now carry the 1v1 to ~9m
  (lane-checked corridor, was never-firing at ±120y). Goals 2.80 ✓.

Current held-in-range: goals 2.80-2.90 ✓ · conv/SoT 34.5 ~✓ · saves 5.6-5.8 ✓ ·
draws 25% ✓ · SoT 8.0-8.4 ✓ · corners 11.6 ✓ · offsides 3.1 ✓ · yellows 3.75 ✓.
Still open: crosses ~67 (load-bearing), headed-share ~32% (downstream of cross
volume), passes ~1840 (press redesign), fouls ~24-28 (borderline).

### Press redesign — the four-experiment map (all reverted; do NOT retry incrementally)

Four A/Bs establish that the defense has NO incremental softening path — every
pixel of press glue is load-bearing:

| experiment | change | result |
|---|---|---|
| tempo2 | primary standoff 16→34 + support 18→40 | shots 37, goals 4.25 |
| tempo5 | graded standoff 14-38 + anti-matador hold-ground + support 40 | shots 36, goals 4.65, crosses 97 |
| scrum  | support bodies ONLY 18→34 (primary glue untouched) | shots 34, goals 4.25, crosses 87, corners 18 |
| (analysis) | presser target `carrier − standoff·fd` | backpedals at carrier speed = 40-yard escort ("matador") |

Duels DID fall each time (804→633 attempts in `scrum`) — the glue is what
stops ball progression, not just what contests it. Conclusion: build 1v1
containment FIRST — (1) a jockey that holds ground and forces direction
changes rather than chasing an offset point, (2) a drive-past resolution
(carrier pushing through the jockey's zone triggers a contest), (3) wide-lane
containment so wingers can't carry outside a goal-side jockey. Only then can
standoffs widen and the pass tempo (~1820, real ~1000) come down. Until that
project lands, the glue press stays.

### Press redesign stage 1 — SHIPPED: the grudging-give-ground jockey

First standoff softening in five attempts that does NOT leak (shots 26.5 vs
the 34-37 leak signature). `assignPrimaryPress`: standoff 16 (flat contact) →
`clamp(30 − carrierDrive·0.45, 12, 30)` + half-body inside shade. A DRIVING
carrier compresses the jockey's held distance into tackle range within ~1s
(progression still stopped — kills the matador); a carrier who holds keeps a
30px gap (the carrier visually has the ball now, not a defender in his chest).
Cost: goals +0.2, crosses +7 (mild, within drift).

Stage 2 (support bodies 18→32 on top) LEAKED (shots 32.6, corners 19.6) and
was reverted: the support glue is ALSO load-bearing — not as pressure but as
short-lane interception around the jockey. Stage 3 therefore needs LANE-AWARE
support positioning (block the exits, not hug the carrier) before support
distances can widen; only then does the pass tempo unlock.

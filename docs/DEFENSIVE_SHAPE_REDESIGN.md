# Defensive-Shape Redesign — scoping the churn fix

_Status: SCOPE / not started. Author: engine (2026-06-22). This is the "next major
engine project" identified after the churn was proven architecturally homeostatic
(~12 lever experiments absorbed — see memory `gameplay-tuning-method`)._

## 1. What "churn" is

The ball changes hands far too often, so play is a stream of short possessions with
no sustained build-up. Measured (8×90 + paired watch_buildup):

| metric | engine | real | ratio |
|---|---|---|---|
| possessions / match | ~680 | 250-300 | ~2.4× |
| 5+ pass sequences /90 | ~200 | 35-50 | ~4× |
| 10+ /90 | ~32 | 16-24 | ~1.5× |
| 20+ /90 | **0** | 2-4 | — |
| tackle-wins (dispossessions) /90 | ~390 | ~25-30 | ~13× |
| interceptions /90 | ~490 | (high, but rate ~15% is real) | — |

The shape of the error is specific: **way too many 5-10 pass possessions, and the
ball never strings 20+ together.** It reads as scrappy/pinball even though per-pass
completion (~81%) and the per-duel win-rate (~47%) are both realistic.

## 2. Root cause — a dense, always-on defensive shape

The turnovers are not a tuning value; they are produced by the **defensive shape**.
Every possession, `assignDefensiveRoles` (engine_defense.cpp / engine_defense_helpers.cpp)
commits **6-8 bodies to ball-stopping duties**:

- `assignPrimaryPress` — always (nearest defender onto the carrier)
- `assignSecondaryPress` — a second man (gated on aggression/danger/shooting range)
- `assignShotLane` — **two** bodies deep in the shot lane
- `assignCrossLane` — a body on the delivery line
- `assignCoverRoles` — a CM screen + (in danger) a CB
- `assignMidfieldScreen` — a body on the most dangerous passing lane

So **every passing lane is occupied by positioning**, all the time. A pass sequence
therefore hits a defender no matter what — which is why:

- Interceptions are **passive/positional**, not active. Halving the active lane-cut
  reach (`agent_defend.cpp` `22+90t → 14+55t`) changed interceptions by ~0 — the
  bodies are simply *already there*.
- The churn is **homeostatic**: thin one turnover channel (press, commit-bar,
  lane-cut) and the others (re-challenge, loose ball, the next lane body) refill it.
  Proven ~12× across two sessions — single levers AND coordinated multi-lever tests
  (press standoff + commit-bar + lane-cut together) were all absorbed; 20+ never
  appeared; max possession stayed ~15 passes.

There is **no "hold shape / don't press" state** today. The aggression dial and
`containBias` only *modulate the standoff distance* of a press that is always on.

## 3. Why the attack matters too

Even if the defense held shape and let the opponent have the ball, the engine's
attack is **direct** (crosses ~247/match, through-balls ~178/match — both ~3-7×
real; also structural, see memory). Given space it *attacks* rather than circulates,
so it would still end possessions quickly. **20+ possessions need both** a defense
that lets the ball circulate **and** an attack that chooses to circulate.

## 4. The redesign — two coordinated subsystems

### A. Selective, trigger-based pressing (replace always-on press)

Introduce a per-team **press state**: `PRESSING` vs `HOLDING_SHAPE`.

- **HOLDING_SHAPE (default when the opponent is in a safe area):** defenders sit in
  zonal positions — a mid/low block. Only the nearest 1-2 contain the carrier;
  the rest **hold shape and do NOT pre-occupy passing lanes**. This is the key
  change: it removes ~4-6 of the 6-8 lane bodies during safe circulation, so the
  opponent can actually string passes.
- **PRESSING (trigger fired):** the current aggressive `assignDefensiveRoles` — win
  the ball back hard.

**Press triggers** (any one arms the press for a few seconds): ball enters our
press zone; a loose/bad touch; a backward or square pass; receiver under pressure;
a numerical advantage around the ball; the score/clock demands it (already in
`configFor`). Otherwise: hold shape.

Touch points: `assignDefensiveRoles` + the `assign*` helpers (gate lane/cover
assignment on the press state), a new press-state evaluation (per possession), the
`agent_defend` lane-cut (only active when PRESSING).

### B. Patient attack (circulate when unpressed)

When the attacking team is **unpressed** (defense holding shape), its pass scoring
should favour **safe circulation** (keep, switch, probe) over a forced direct ball;
when **pressed**, keep today's direct bias (play through/over the press).

This already half-exists: the `slow_it_down` tactic (`slowTempo` hook in
agent_pass_helpers) rewards safe recycling. The redesign makes the **default** attack
read the defensive press-state and circulate when the press is off — rather than only
under an explicit tactic.

Touch points: `scorePassToTarget` (read opponent press-state → shift the
recycle/direct balance), the `ActionPurpose::Through`/`Cross` selection.

## 5. Phased plan (each phase paired + measured over 16-30 seeds)

1. **Press-state machine + triggers.** Add `PRESSING`/`HOLDING_SHAPE` and the trigger
   set; in HOLDING_SHAPE, only the nearest 1-2 contain. _Measure: possessions, the
   5+/10+/20+ curve, goals._
2. **Shape-reduction in HOLDING_SHAPE.** Gate `assignShotLane`/`assignCrossLane`/
   `assignMidfieldScreen`/extra cover on `PRESSING`. _Measure: interceptions ↓,
   curve._
3. **Patient attack.** Make `scorePassToTarget` circulate when the opponent is
   holding shape. _Measure: 20+ appears, 5+ falls toward real._
4. **Re-balance.** The looser block will raise goals; claw back via press *efficiency*
   when triggered (win the ball cleanly), or accept higher goals (user is fine with
   10+). Re-baseline the golden.

Measurement is **paired same-seed `watch_buildup.py` over 16-30 seeds** — the curve
is noisy (3-seed means swing 3.3-4.5 for the SAME build), so small samples lie.

## 6. Risks (this is why it's a project, not a tweak)

- **High regression risk.** The defense is hard-won and well-tuned (goals ~5; the
  defensive round took many waves). Loosening it can explode goals or reopen old
  bugs (the penalty factory, the cross-collection gates, sweeper exposure).
- **New central subsystem.** The press-state machine sits in the core defensive AI
  (`assignDefensiveRoles`) — the most load-bearing, most-tuned code in the engine.
- **Homeostasis may persist.** If triggers fire too readily it collapses back to
  always-press; if the attack won't circulate, 20+ still won't appear. The payoff is
  genuinely uncertain.
- **Touches a lot at once.** Defense assignment + defensive movement + attacking pass
  scoring must move together (that's the whole point — neither half works alone).

## 7. Effort & recommendation

~3-5 focused sessions (state machine → shape-reduction → patient attack → re-balance),
each with a 16-30-seed measurement pass.

**Do it if** realistic possession/build-up is a product priority — it's the single
biggest step from "arcade-ish churn" toward "looks like real football," which matters
for an FM-style match engine. **Skip it if** the current playable, well-tuned state is
good enough — the churn is cosmetic-feel, not a correctness bug, and everything else
in the engine is in good shape.

## 8. Phase 1 + 3 prototype — empirical findings (2026-06-22)

Built a throwaway prototype of Phase 1 (mid-block: hold shape when the carrier is
in his own half, `carrierGoalDist > PITCH_W*0.52`, gating the second presser / cover
/ midfield screen / close-down) and Phase 3 (patient build-up: when `pressureCount==0`
in our own half, reward the safe keep + shun the risky/forward ball). Measured curve
(watch_buildup) + goals, then REVERTED. Results:

| build | goals | 5+ /90 | 20+ /90 | max seq |
|---|---|---|---|---|
| baseline | ~5 | 197 | 0 | 15 |
| Phase 1 alone | **~11** | 249-294 | 0 | 15-17 |
| Phase 1 + 3 | **~5** | 230-279 | **0** | 14-17 |

Takeaways (these REFINE the plan above):
- **Phase 3 works as the goal-balancer.** The patient attack pulled goals back from
  the mid-block's explosion (~11) to baseline (~5) by trading direct attacks for
  circulation. So "loosen defense + circulate" IS a viable goals-neutral pairing.
- **But the curve still won't crack — and the real bottleneck is BUILD-UP COMPLETION,
  not the press.** 20+ pass moves need ~90% completion during safe circulation; the
  engine sits at **~81% even when unpressed**, because a pass can still be cut by an
  opponent near the *receiver* or in the *lane* (not just a presser on the carrier).
  At 81%, expected run length ≈ 1/0.19 ≈ 5 passes, so 20+ is astronomically rare;
  real teams hit it because their unpressed build-up completes ~90%+.
- **Implication for Phase 2.** Removing the midfield screen/cover (the mid-block) is
  NOT enough to free the build-up zone — the back line, threat-markers, and the
  opponent's own high forwards still occupy lanes and hold completion at ~81%. The
  success metric for Phase 2 must be **unpressed-build-up completion → ~90%**, which
  requires the build-up third to be genuinely opponent-sparse (a deeper, riskier
  density cut than the mid-block, with the goal-balancing leaning even harder on
  Phase 3). This is the crux and it's why single-phase attempts can't win.
- Net: the redesign is **deeper than first scoped** — it's a build-up-completion
  problem gated by total lane density, not a press-aggression problem. Genuine
  multi-session research with real but uncertain payoff.

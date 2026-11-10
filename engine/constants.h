#pragma once
#include <cmath>
#include <string_view>
#include <array>
#include "types.h"

// ── Pi ──
inline constexpr double PI = 3.141592653589793;

// ── Pitch geometry ──
inline constexpr double PITCH_W   = 1050.0;
inline constexpr double PITCH_H   = 680.0;
inline constexpr double GOAL_W    = 73.0;
inline constexpr double GOAL_H    = 24.0;
inline constexpr double HOME_GOAL_X = 0.0;
inline constexpr double AWAY_GOAL_X = PITCH_W;
inline constexpr double HALF_X    = PITCH_W / 2.0;

// ── Entity radii ──
inline constexpr double PLAYER_R  = 12.0;
inline constexpr double BALL_R    = 4.5;

// ── Speed ──
inline constexpr double SPEED_RUN     = 52.0;
inline constexpr double SPEED_SPRINT  = 68.0;
inline constexpr double MAX_PLAYER_SPEED = 50.0;
// ── Approach-damping ceilings (agent_movement.cpp) ────────────────────────────
// The commanded speed is baseSpeed * df, where df is the distance term: it damps
// the last stride into a target and OVERRUNS when the target is far. Round-34
// found the two ceilings were never compared: committed pursuit was pinned at
// df = 1.0 while an off-ball mover with a target > 180px away got 1.5, so
// SPEED_SPRINT * 1.0 = 68 lost to SPEED_RUN * 1.5 = 78 — committing to a chase
// made you 13% SLOWER than a team-mate ambling toward a far spot. Name both
// ceilings and assert the gear ordering at compile time so it cannot silently
// invert again when either constant is retuned.
// The pursuit ceiling is 1.25, not the off-ball 1.5, and the number is measured
// rather than assumed. Handing pursuit the full 1.5 overrun DOES fix the
// ordering (sprint-gear commanded p95 49.8 -> 69.3 px/s, 24 seeds x 90 min) but
// it puts 8.74% of open-play frames above 5.5 m/s against a real 4-6%, with the
// >7 m/s band up 0.13 -> 1.43%: that is not a sprint, that is a rocket. At 1.25
// the band lands at 6.4% with the >7 m/s tail FLAT (0.13 -> 0.16%), i.e. the
// growth is entirely players sprinting rather than flying. The floor cannot go
// much lower: at 1.15 the two gears tie and the per-seed ordering invariant is
// violated on 7 of 8 seeds.
inline constexpr double MOVE_DF_MAX_OFFBALL = 1.5;
inline constexpr double MOVE_DF_MAX_PURSUIT = 1.25;
static_assert(SPEED_SPRINT * MOVE_DF_MAX_PURSUIT >= SPEED_RUN * MOVE_DF_MAX_OFFBALL,
              "gear inversion: a committed pursuer must never command less pace "
              "than an off-ball mover running to a distant target");
// Round-34: ceiling on the post-goal walk-in step (engine.cpp updateKickoffPhase).
// The lerp-to-arrive opens at distance/hold, so the far dot glided at 49 km/h for
// nearly the whole hold. SPEED_RUN is the engine's own run gear and sits strictly
// below the 5.5 m/s line the restart-phase speed census is judged on.
inline constexpr double KICKOFF_WALK_SPEED = SPEED_RUN;
// Post-goal hold. Widened 9s -> 17s alongside the cap above: the measured 99th
// percentile distance-to-spot is 750px and the observed max 881px, so a capped
// walk needs >= 17s to still arrive at KICKOFF_WALK_SPEED and leave the terminal
// snap a no-op (that snap was an 80px teleport before the walk-in was
// introduced). 52 x 17 = 884px of reach; anything beyond it is handled by the
// per-dot pace floor in GameEngine::kickoff, so arrival is guaranteed either way.
// Precedent: round-23 grew the arena hold 3s -> 6s for exactly this reason when
// the walk was added. Arena keeps its ARENA_RESTART_SCALE.
inline constexpr double POST_GOAL_HOLD_MS = 17000.0;
// Momentum v3 (agent_movement.cpp): off-ball, non-pursuit movers accelerate
// under this cap instead of teleport-steering; reversals plant-and-brake at
// the multiple below before relaunching. Pursuit states are exempt (the
// anticipation pass models their early reads) — see the tombstone note.
inline constexpr double MOMENTUM_ACCEL             = 340.0;
inline constexpr double MOMENTUM_REVERSAL_BRAKE_MUL = 2.2;
// Tackle lunge dash pace: the committed closing step toward the ball plays out
// at this speed instead of the old single-tick snap (~900px/s, seed 305 0:09).
// 170 -> 120 (seed 111 0:56 + 13:10: 2.5x sprint still read as "an unrealistic
// rapid burst of speed to win the ball" — 120 is a hard step, not a teleport).
inline constexpr double LUNGE_DASH_SPEED = 120.0;

// ── Free-kick RUN-UP (owner: "free kicks especially shot ones should have run ups") ──
// The old choreography stood the taker ~14px off the ball for the WHOLE hold and
// then launched the kick the instant the timer hit 0 — a standing-start poke, no
// approach. Now he waits a few steps BEHIND the ball along the strike axis for the
// bulk of the hold, then in the last RUNUP_LEAD_MS he accelerates THROUGH it and
// the kick releases the moment he arrives ("strikes as he arrives"). Pace is
// explosive-but-human, well under the 250px/s OffBallOverspeed line.
inline constexpr double RUNUP_LEAD_MS     = 900.0;  // window (before the scheduled release) when the approach begins
inline constexpr double RUNUP_DASH_SPEED  = 132.0;  // approach pace, px/s — an explosive burst (above the LUNGE_DASH_SPEED=120 tackle-dash, but capped at the RUNUP_STRIKE_MAX strike ceiling below)
inline constexpr double RUNUP_STRIKE_MAX   = 180.0;  // hard ceiling on the run-up strike-tick step (px/s) — a human stride into the ball, never a sprint-teleport onto it
inline constexpr double RUNUP_DIST_SHOT   = 52.0;   // ~4-5 steps back for a direct-shot free kick
inline constexpr double RUNUP_DIST_PASS   = 30.0;   // compact ~2-step approach for a short-pass free kick
inline constexpr double RUNUP_SIDE_OFFSET = 18.0;   // lateral offset of a SHOOTING run-up — the angled curler's approach
inline constexpr double RUNUP_OVERRUN     = 10.0;   // the dash target sits just BEYOND the ball so he strikes through it
inline constexpr double RUNUP_STRIKE_DIST = 8.0;    // he's "on the ball" — bring the release forward to this moment

// ── Short corner (owner, seed-111 replay @1:47: "5 is completely free [near the
// corner]... really a blue player perhaps 11 should be coming closer but as is i
// think more likely a short corner would be taken here") ──
// The taker plays the SHORT ball infield instead of the whip ONLY when a teammate
// is GENUINELY FREE by the flag (geometry gates below), and even then only a
// MINORITY of the time — the whipped delivery stays the norm. See releaseCornerKick
// (engine_setpiece.cpp) for the attack side and setPiecePositioning's defending
// Corner branch (agent_setpiece.cpp) for the short-lane cover.
inline constexpr double SHORT_CORNER_NEAR_R    = 130.0;  // a short option must stand within this of the corner spot
inline constexpr double SHORT_CORNER_MIN_R     = 40.0;   // ...but not on top of the taker (min radius from the flag)
inline constexpr double SHORT_CORNER_FREE_D    = 60.0;   // "genuinely free": his nearest defender must be beyond this
inline constexpr double SHORT_CORNER_PROB      = 0.55;   // minority tie-break AMONG free-man corners (whip stays the norm)
inline constexpr double SHORT_CORNER_LURK_R    = 140.0;  // defence: attackers this close to the spot are lurking a short option
inline constexpr double SHORT_CORNER_COVER_R   = 101.5;  // defence: cover sits here on the lane — JUST outside the 91.5px ring (LAW)
inline constexpr double SHORT_CORNER_COMMIT_R  = 120.0;  // defence: only a spare mid ALREADY this near the short RECEIVER can step across to
                                                         // mark him — no marker at hand ⇒ that corner goes uncovered and the short stays
                                                         // live. Probe-tuned (seeds 101-116, 25min): 130px→3.7%, 120px→13.2%, 110px→20.4%.

// ── Ball speed / physics ──
// 2026-07-02 audit ("passes look weird"): base 136/slope 0.105 makes launch
// speed near-UNIFORM — an 18px tap leaves the boot at 96% the speed of a
// 200px ball, so short passes zip and arrive hot (0.03-0.4s flights). A real
// gradient (92 + d*0.28, long-pass-anchored) was A/B'd at 48 paired seeds and
// HARD-FAILED: pass% 83.7->77.9, intercepts +43% — the completion calibration
// (lane-intercept reach `perp < 16+55t`, slow-collect gates) is anchored to
// THIS speed profile; slower rolls live too long under those radii. Fixing
// the zip needs a COUPLED re-anchor of speed + intercept/collect geometry —
// don't touch these two alone.
inline constexpr double PASS_SPEED_BASE = 136.0;
inline constexpr double PASS_SPEED_DIST = 0.105;
inline constexpr double SHOT_SPEED_BASE = 285.0;
// Out-of-bounds restarts: the ball keeps rolling out for up to this long
// before being placed at the spot (corner arc / touchline / goal-kick spot) —
// it used to teleport mid-flight the tick it crossed the line.
inline constexpr double OUT_BALL_GLIDE_MS = 700.0;
inline constexpr double BALL_FRICTION  = 0.70;
// Airborne drag base — MUCH lighter than rolling friction. The single 0.70
// constant doubled as air drag, shedding 30%/s of an airborne ball's pace
// (real air drag at cross pace loses ~20% over a whole second and collapses
// as speed drops). That constant-rate decay while vz stayed perfectly
// ballistic made every arc steepen and "stall and sink at a certain position"
// (watched replay: lofted balls "sink a fair bit"). 0.93/s ~= the real
// end-of-flight drag rate.
inline constexpr double BALL_AIR_DRAG  = 0.93;
inline constexpr double GRAVITY        = 500.0;
// §weather v2 WIND: a seed-derived per-match wind vector accelerates AIRBORNE balls laterally.
// Height-gated (h = min(z/WIND_HEIGHT_REF, 1)) so ground passes are immune -> passPct protected.
// t^2-scaling is emergent + free: a 2.5s long ball drifts ~12x a 0.7s cross. Tune via a paired agg.
inline constexpr double WIND_ACCEL_BASE   = 6.0;   // min per-match wind accel (units/s^2) — dialed back from 10 (adversarial review: 16-seed onTarget +25% breached the >20% "too strong" line)
inline constexpr double WIND_ACCEL_RANGE  = 5.0;   // +0..range (seed-derived) -> mag 6..11 (subtler; holds passPct, pulls the onTarget swing under threshold)
inline constexpr double WIND_HEIGHT_REF   = 24.0;  // z (= GOAL_H) at/above which wind is full

// ── Interaction distances ──
inline constexpr double TACKLE_RANGE   = 24.0;
inline constexpr double OFFSIDE_TOLERANCE = 1.0;
inline constexpr double COLLECT_DIST   = 8.0;
inline constexpr double INTENDED_COLLECT_DIST = 26.0;
inline constexpr double CONTROL_DIST   = 12.0;
// Max distance the ball may be repositioned in one tick at kick release;
// keeps release placement from reading as a teleport across the kicker's body.
inline constexpr double BALL_RELEASE_MAX_STEP = 6.0;   // was 14: every launch popped ~1m off the boot (micro audit #2 — median 9.7px overshoot, clustering at the 14px cap)
inline constexpr double PLAYER_AWARE_RANGE = 120.0;
inline constexpr double SHOOT_MIN_DIST = 100.0;
inline constexpr double SHOOT_MAX_DIST = 340.0;
inline constexpr double PENALTY_AREA_W = 165.0;
inline constexpr double PENALTY_AREA_H = 403.0;
inline constexpr double GK_RUSH_DIST   = 200.0;
inline constexpr double GK_LOOSE_COLLECT_DIST = 34.0;
inline constexpr double GK_LOOSE_COLLECT_FAST_DIST = 24.0;
inline constexpr double SEPARATION_DIST = 38.0;

// ── Timing ──
inline constexpr double FIXED_DT       = 16.667;
inline constexpr double MATCH_DURATION  = 90.0 * 60.0 * 1000.0;
inline constexpr double HALF_DURATION   = 45.0 * 60.0 * 1000.0;
inline constexpr double THIRD_1         = PITCH_W / 3.0;       // 350
inline constexpr double THIRD_2         = 2.0 * PITCH_W / 3.0; // 700

// A LOOSE ball left uncollected (nobody assigned to chase it — e.g. parked in a
// corner) otherwise sits dead forever: the half-end whistle needs the ball OUT
// of the final third, so a dead ball in a final third hangs the match to the
// +5:00 hard cap (some matches never even reach half-time). detectSimulationFreeze
// watches a stationary loose ball and, after this long, hands it to the nearest player.
inline constexpr double LOOSE_BALL_STALL_MS    = 3000.0;
inline constexpr double LOOSE_BALL_STALL_SPEED = 24.0;   // px/s below which a loose ball counts as 'at rest'
// How much closer the nearest OUTFIELDER has to get before the watch re-arms —
// the "somebody is actually coming for it" test. Was a bare 5.0 in engine_audit.
inline constexpr double LOOSE_BALL_CLOSING_EPS = 5.0;    // px of approach that counts as a live chase
// Round-21 (take-on audit) COMMIT 4b: a defender beaten by a take-on is off-balance
// for this long — a two-stage stun applied to his pursuit pace (see agent_movement).
inline constexpr double BEATEN_SLOW_TOTAL_MS = 1100.0;   // total off-balance window
inline constexpr double BEATEN_SLOW_HARD_MS  = 250.0;    // first stage (planted/wrong-footed, 0.25x); then 0.55x
// A half must not overrun announced added time indefinitely — a persistent
// final-third camp would otherwise starve the !inFinalThird whistle. Blow the
// whistle this far past announced added time regardless of where the ball is.
inline constexpr double ADDED_TIME_MAX_OVERRUN_MS = 120000.0;

// ── Utility ──
constexpr auto clamp(double v, double lo, double hi) -> double { return v < lo ? lo : v > hi ? hi : v; }
constexpr auto clampRange(double v, double a, double b) -> double { return clamp(v, std::min(a, b), std::max(a, b)); }
constexpr auto lerp(double a, double b, double t) -> double { return a + (b - a) * t; }
constexpr auto clampToPitchX(double x, double margin = 5.0) -> double { return clamp(x, margin, PITCH_W - margin); }
constexpr auto clampToPitchY(double y, double margin = 5.0) -> double { return clamp(y, margin, PITCH_H - margin); }
inline auto dist(double ax, double ay, double bx, double by) -> double {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}
constexpr auto attrFactor(double attr) -> double { return attr / 100.0; }
// staminaFrac: current/max stamina in [0,1]. 1.0 = fresh (decision gates are a
// no-op at kickoff), falls as the tank empties so late-game execution degrades
// (pass/shot/foul accuracy + first-touch settle). Deterministic scalar — adds
// NO rng; the gates multiply existing values so the RNG stream is byte-identical.
constexpr auto staminaFrac(double stamina) -> double { return clamp(stamina / 100.0, 0.0, 1.0); }
constexpr auto fdFor(Team team) -> double { return team == Team::Home ? 1.0 : -1.0; }
inline double goalXFor(Team team) { return team == Team::Home ? AWAY_GOAL_X : HOME_GOAL_X; }
inline double ownGoalXFor(Team team) { return team == Team::Home ? HOME_GOAL_X : AWAY_GOAL_X; }

// ── Stamina ──
inline constexpr double STAMINA_DRAIN_SPRINT  = 0.014;
inline constexpr double STAMINA_DRAIN_MOVE    = 0.020;    // base match-fatigue rate: a working player tires TOWARD the floor (FATIGUE_FINDING)
inline constexpr double STAMINA_MATCH_FLOOR   = 50.0;    // a working player never drains below this in-match (above the 0.35 speed-threshold) → no crash, speed stays dormant, only the decision gates bite; a fitter player floors higher
inline constexpr double STAMINA_RECOVER       = 0.012;
inline constexpr double STAMINA_SLOW_THRESHOLD = 0.35;

// ── Dribble speed tiers ──
inline constexpr double DRIBBLE_CLOSE_SPEED  = SPEED_SPRINT * 0.58;
inline constexpr double DRIBBLE_MEDIUM_SPEED = SPEED_RUN;
inline constexpr double DRIBBLE_FAST_SPEED   = SPEED_SPRINT * 0.95;
inline constexpr double DRIBBLE_KNOCK_SPEED_ADVANTAGE = -25.0;
inline constexpr double DRIBBLE_KNOCK_OFFSET = CONTROL_DIST + BALL_R + 5.0;
// The opener off a kickoff is a controlled carry for this window — never a
// blind knock-ahead into the man in front (Round-23 "kickoff mugging").
inline constexpr double POST_KICKOFF_CARRY_MS = 1500.0;

// ── Collect ──
inline constexpr double COLLECT_SPEED_MAX       = 80.0;
inline constexpr double INTENDED_COLLECT_BONUS   = 1.8;

// ── Pressure / detection ──
inline constexpr double PRESSURE_RANGE          = 58.0;
inline constexpr double STUCK_CARRIER_MOVE_THRESHOLD = 42.0;
inline constexpr double STUCK_CARRIER_TIMEOUT_MS = 4200.0;
// Defense goes to full protection (max marking, box guards, post guards)
// well before the box — 240 only triggered once the line was already beaten.
inline constexpr double DANGER_ZONE_DIST        = 330.0;
inline constexpr double PRESS_COMMIT_MAX_DIST   = 145.0;

// ── Pass scoring ──
// (old pass-completion-probability / turnover / pass-scoring weight constants
//  removed — dead after the pass-decision rework; the live pass geometry below stays.)
inline constexpr double PASS_MIN_DISTANCE       = 58.0;   // Round-20: 42 -> 58 (4.2m -> 5.8m) to cut the sub-6m ping-pong that inflated pass volume
inline constexpr double PASS_MAX_DISTANCE       = 550.0;
inline constexpr double PASS_MAX_DISTANCE_KEEPER = 455.0;
inline constexpr double PASS_DIST_NORMALIZATION = 850.0;
inline constexpr double PASS_BLOCKER_PERP       = 36.0;
inline constexpr double PASS_BLOCKER_PERP_OUTLET = 34.0;
inline constexpr double PASS_RECEIVER_PRESS_MAX = 45.0;
inline constexpr double PASS_TOUCHLINE_TRAPPED  = 90.0;
inline constexpr double BLOCKER_PERP_FREEKICK   = 42.0;
inline constexpr double BLOCKER_PERP_THROWIN     = 32.0;
inline constexpr double BLOCKER_PERP_GK_DIST     = 44.0;
inline constexpr double CARRIER_PRESSURE_RANGE   = 70.0;
inline constexpr double CARRIER_PRESSURE_COUNT_DIST = 48.0;

// ── Shot scoring ──
// (old shot-floor + shot-distance-band scoring constants removed — dead after the
//  shot-quality rework; the live acute-angle thresholds below stay.)
inline constexpr double SHOT_ANGLE_ACUTE_THRESH  = 7.5;
inline constexpr double SHOT_ACUTE_SOFT_THRESH   = 8.0;
inline constexpr double SHOT_ACUTE_HARD_THRESH    = 7.0;

// ── Chase ──
inline constexpr double PRE_CONTACT_CHASE_REACH = 36.4;

// ── Whipped deliveries (deliberate crosses + corners) ──
// These are the dials calibrated 2026-06-12: cut-out/misjudge govern how
// often a whip survives the box, the speed pair governs how it looks.
// User (watching fixture 2241): "crosses fly in too fast." 10px=1m, so 360-560 px/s was 36-56 m/s
// — a real driven cross is ~25-35 m/s and 56 m/s was absurd. Pulled to ~30-42 m/s (300-420 px/s).
// Calibrated to real cross pace (1 px/s = 0.36 km/h). Box deliveries were
// launching at 103-137 km/h — hard-SHOT speed; real crosses are 50-80 km/h,
// the hardest driven ~90. These land box crosses at ~88-108 km/h (top of the
// driven band, ~20% slower than before) rather than one-stepping to the
// floated band, which history says craters headed-goal output.
inline constexpr double CROSS_DRIVE_SPEED_BASE   = 220.0;
inline constexpr double CROSS_DRIVE_SPEED_PER_PX = 0.32;
inline constexpr double CROSS_DRIVE_SPEED_MIN    = 245.0;
inline constexpr double CROSS_DRIVE_SPEED_MAX    = 320.0;
inline constexpr double CROSS_DIP_TARGET_Z       = 18.0;  // ball height at arrival
inline constexpr double CROSS_CURL_MIN           = 0.27;  // rad/s — more visible whip on crosses + FK-crosses (was 0.20)
inline constexpr double CROSS_CURL_RANGE         = 0.21;  // (was 0.17). Pre-rot scales with curl -> aim preserved.
// ── Round-31: the aerial long ball ──
// A pass struck at least this far, that is not a cross, is a genuine LOFTED
// delivery: it must be contested in the AIR (aerial duel + second ball) rather
// than sailing untouchable over everyone to be collected off the deck.
// Distance-selective by construction, which is what keeps it clear of the
// r24/r25 quadratic-trim tombstone — short and medium passing is not touched.
inline constexpr double AERIAL_LONG_BALL_DIST = 300.0;
// The cut-out duel used to arm only above 300px/s. A corner arrives at ~250,
// so EVERY corner delivery was cut out deterministically by the first defender
// on the flight line (17 of 21 aerial first contacts won by a defender) and
// corner conversion collapsed to ~0%. Arm the duel at any genuine delivery
// pace; the pace PENALTY below still keeps a driven ball harder to cut out.
inline constexpr double CROSS_CUTOUT_MIN_SPEED = 210.0;
inline constexpr double CROSS_CUTOUT_PACE_REF  = 300.0;  // pace above which cutting out gets harder
inline constexpr double CROSS_CUTOUT_BASE        = 0.40;  // defender cut-out duel (0.28 -> 0.40: real defenses win first contact on ~50% of crosses. 0.48 was A/B'd and REJECTED: harder cut-outs just feed loose-ball box chaos — goals ROSE to 3.30 and headed share bounced back)
inline constexpr double CROSS_CUTOUT_SKILL       = 0.28;
inline constexpr double CROSS_MEET_BASE          = 0.55;  // runner timing roll
inline constexpr double CROSS_MEET_SKILL         = 0.30;

// ── Penalties ──
inline constexpr double PENALTY_SPOT_FROM_GOAL   = 110.0;
inline constexpr double PENALTY_SAVE_BASE        = 0.16;  // keeper is guessing
inline constexpr double PENALTY_SAVE_SKILL       = 0.10;
inline constexpr double PENALTY_SCOOP_CHANCE     = 0.10;
inline constexpr double SHOT_SCOOP_CHANCE        = 0.80;  // primary goal-rate dial

// ── GK save-roll bounds ──
// The old computed save-model inputs (MIN_SPEED, MAX_GOAL_DIST, SKILL_*,
// REACTION_*, PLACEMENT_*, SPEED_*, BASE) were removed: dead since the keeper
// became a physical tracker (he saves by reaching/collecting, not a placement
// roll). Only the final clamp(roll, MIN, MAX) survives in engine_gk.
inline constexpr double GK_SAVE_MIN             = 0.09;   // 0.05->0.09: even a wrong-footed keeper gets a boot/fingertip to some
// Save-ROLL ceiling. NOTE: measured a near-no-op on goal rate — the keeper saves
// mostly by physically COLLECTING the ball (the tracker), not this roll, so this
// is NOT the scoring throttle. Kept named (was a stray 0.84 literal in engine_gk).
inline constexpr double GK_SAVE_MAX             = 0.76;   // 0.72->0.76: real keepers stop ~2/3 of on-target; engine conceded 38% per SoT (real 30-34)
// "He should have saved that" — the saveChance gate on shot.preventable, as a
// FRACTION of the roll ceiling rather than an absolute. The test in engine_gk
// used to read `saveChance >= 0.90`, an absolute written against an implicit
// [0,1] scale; saveChance is clamp()ed to [GK_SAVE_MIN, GK_SAVE_MAX] just above
// the test and the only later write (the penalty path) LOWERS it, so 0.90 was
// structurally unreachable and preventableGoals reported 0 for every match ever
// simulated. Keyed off the ceiling it survives a re-tune of GK_SAVE_MAX.
// 0.95 measured, not guessed: over 30 matches @90min (seeds 101-130, 498 save
// rolls) 16 rolls passed the other three clauses, and their saveChance splits
// into a top group of 3 (0.730/0.760/0.760 — all at 185px/s, a shot speed one
// unit off the census minimum, with 1.1-1.8s of flight: gentle balls at him)
// and a body from 0.366 to 0.608. GK_SAVE_MAX*0.95 = 0.722 lands in the widest
// gap in that distribution and selects exactly the unambiguous group. Expect a
// rare flag (~0.03/match at 90min) — a genuine howler should be rare.
inline constexpr double GK_PREVENTABLE_SAVE_FRAC = 0.95;
inline constexpr double GK_CATCH_HANDLING_BASE  = 0.22;
// ── Realistic reach envelope (10px = 1m) ── replaces the flat isotropic circle.
// A keeper has a short STANDING reach but can EXTEND into a dive; a dive covers
// ground over TIME, so a fast shot far from his set line beats him, and a lofted
// ball adds a vertical cost he often can't pay. Centre/slow shots stay easy.
inline constexpr double GK_STAND_REACH    = PLAYER_R + BALL_R + 7.0;  // ~23.5px standing arm reach
// Dive reach re-based (13/13 -> 17/16): at 13+13·hand the keeper's total
// envelope (stand 23.5 + dive ≤26) barely covered typical shot placement
// (34-44px off his line), so `reachCover` sat near zero and saveChance hit the
// clamp FLOOR on most dive rolls — the save model's coefficients were dead
// dials (a +0.05 base buff changed literally nothing across 20 matches). Real
// keepers cover ~3m of lateral dive; 17+16·hand ≈ 25-33px dive + 23.5 stand.
inline constexpr double GK_MAX_DIVE_BASE  = 17.0;   // full lateral dive (base). NOTE round-7: 17->20 (+18->skill)
                                                    // was A/B'd as a volume compensator and measured INERT on
                                                    // goals (6.30 vs 6.38/90) — marginal reach doesn't reclaim
                                                    // clean corner strikes. The volume lever must be upstream.
inline constexpr double GK_MAX_DIVE_SKILL = 16.0;   // ...+ up to this with handling
inline constexpr double GK_DIVE_FULL_T    = 0.42;   // seconds of flight to reach full stretch
inline constexpr double GK_STAND_Z        = 8.0;    // free vertical reach (px) before height costs him
inline constexpr double GK_Z_WEIGHT       = 1.35;   // going UP is slow/expensive vs going sideways
inline constexpr double GK_CATCH_HANDLING_WEIGHT = 0.38;
// (old GK_CATCH_SPEED_* and GK_PARRY_SPEED_* model constants removed — dead since
//  the catch/parry outcome became handling-keyed in the keeper rework.)
// Hold after a clean catch before distributing — 250ms read as a pinball, and
// 950ms was still a hot-potato keeper. Real keepers hold 3-6s (bounce, scan,
// step up); 2000ms base × the game-state multipliers in gkDistributeMs lands
// 0.9-4.2s. Part of the restart-pacing pass toward realistic in-play time.
inline constexpr double GK_DISTRIBUTE_MS        = 2000.0;
// Max time the keeper will HOLD waiting for a clean lane before he stops
// stalling and just plays the best ball he has (or hoofs it). Sits well under
// the stuck-carrier watchdog (STUCK_CARRIER_TIMEOUT_MS*0.65 = 2730ms) so the
// keeper distributes himself instead of being force-passed as a "stuck carrier".
inline constexpr double GK_MAX_HOLD_MS          = 1800.0;

// Round-21 (arena audit): a 2-a-side duel doesn't need 11v11's restart-hold
// budgets (wall setup, box crowds forming) — those hold two players still for
// seconds and left even freeze-free arena matches ~40% non-action. Scale the
// set-piece action-timer budgets DOWN in arenaMode only (FK 7s->~2.5s, corner
// 4s->~1.4s, throw 4s->~1.4s). 11v11 is untouched (the factor is exactly 1.0).
inline constexpr double ARENA_RESTART_SCALE     = 0.35;

// Round-30 (arena generality): the largest small-sided side the arena can
// field — outfielders PER SIDE, so 10 is a full 11-a-side team. The engine
// keeps a real shape for every value in [1, ARENA_MAX_OUTFIELDERS]; anything
// outside it is rejected at the command line instead of silently collapsing
// to a 1v1 (the pre-round-30 parser accepted only the single characters
// '1'..'3' and ran "--arena 7" as a 1v1 with no diagnostic).
inline constexpr int    ARENA_MAX_OUTFIELDERS   = 10;

// Round-30 (arena audit D3): the arena keeper's punt is aimed at the outlet's
// LED position, but it is still a long ball played into space, not a pass to
// feet — dropped exactly on the receiver it becomes a 50/50 with his marker on
// the spot (measured at 1v1: fouls 46->124/90, tackles 372->1198/90). Land it
// this far BEYOND the lead point so the receiver runs onto it with a head
// start. The pre-round-30 launch was effectively a fixed ~575px carry, i.e. an
// uncontrollable ~275px overshoot; this is the calibrated version of that idea.
inline constexpr double ARENA_PUNT_RUN_ON       = 120.0;
// ...and it is still a CLEARANCE: a keeper does not roll it 250px into his own
// half to a man with a marker on his shoulder. Solving the range exactly did
// that (1v1 corners 6.8->63/90 — the short punt was turned over on the edge of
// the box, over and over). Never launch it shorter than this.
inline constexpr double ARENA_PUNT_MIN_RANGE    = 420.0;
// Lateral offset of the arena punt target, off the punt axis and away from the
// receiver's nearest opponent — the ball is played into space beside him, not
// onto his toes, and the delivery stops tracing one centre-line corridor.
inline constexpr double ARENA_PUNT_SPACE        = 90.0;

// ── Goal-kick long-distribution mix ── even a possession side mixes in a
// longer distribution to a target man rather than ALWAYS playing out short
// (watched replay seed 105: goal kicks were taken short unrealistically
// often). When a real advanced outlet exists and the keeper isn't being
// pressed into a rushed short escape, launch it long this fraction of the
// time. A genuine mix, not every kick.
inline constexpr double GK_LONG_MIX_PROB        = 0.30;
inline constexpr double GK_LONG_TARGET_MIN_PROG = 470.0; // outlet past halfway

// ── GK cross-claim (keeper commands his box) ──
// A claim is a save of the DELIVERY: the keeper attacks an aerial cross that
// nobody won in his 6-yard zone. Reuses catch/punch/tip physics — there is NO
// central live drop (a reverted "spill" scored less than the wide parry it
// replaced, because defenders mop up central drops). The z-band spans the full
// aerial range [AERIAL_HEIGHT, HEADER_MAX_HEIGHT]; below it, low/ground balls
// stay with the scoop/first-touch paths. The striker still gets first refusal
// (the intended-receiver/dueler block runs before the claim gate).
inline constexpr double GK_CLAIM_DEPTH       = 78.0;   // max |ball.x - ownGoalX| (~6-yd box +a touch)
inline constexpr double GK_CLAIM_HALF_W      = 95.0;   // max |ball.y - PITCH_H/2| (goal corridor)
inline constexpr double GK_CLAIM_MIN_Z       = 20.0;   // floor: at AERIAL_HEIGHT
inline constexpr double GK_CLAIM_MAX_Z       = 64.0;   // ceiling: full aerial range (= HEADER_MAX_HEIGHT)
inline constexpr double GK_CLAIM_REACH_Z     = 34.0;   // jump-and-hands reach height
inline constexpr double GK_CLAIM_RADIUS      = 44.0;   // slant commit reach (incl. z) — a keeper reaching/jumping
inline constexpr double GK_CLAIM_BASE        = 0.36;   // catch base
inline constexpr double GK_CLAIM_SKILL       = 0.40;   // handling weight
inline constexpr double GK_CLAIM_REACH_BONUS = 0.18;   // got-there-early comfort weight
inline constexpr double GK_CLAIM_CROWD_PEN   = 0.22;   // pressure penalty
inline constexpr double GK_CLAIM_PACE_FALL   = 560.0;  // pace penalty divisor
inline constexpr double GK_CLAIM_MIN         = 0.10;
inline constexpr double GK_CLAIM_MAX         = 0.88;
inline constexpr double GK_CLAIM_CROWD_DIST  = 40.0;   // opponent-in-airspace radius
inline constexpr double GK_CLAIM_PACE_PUNCH  = 320.0;  // above this, force a punch over a finesse hold

// ── Tackle ── (the old tackle-outcome model — TACKLE_BASE/SKILL_WEIGHT/
// CARRIER_CONTROL/CONTROL_BASE/CONTROL_MAX — was removed as dead after the rework;
// only the live foul-probability constants remain.)
inline constexpr double TACKLE_FOUL_FROM_BEHIND = 0.11;   // audit #3: fouls measured ~10/match (½ real 20-24) -> raise 0.06->0.11; reckless, carries the 0.28 card
inline constexpr double TACKLE_FOUL_NORMAL      = 0.048;   // audit #3: raise 0.023->0.048 toward real 20-24 fouls; clean foul, low 0.075 card so cards rise gently toward 3-4
// Deliberate (cynical) foul: the last man, beaten on a transition break OUTSIDE
// the box, hauls the carrier down to stop the counter — a yellow, never a
// penalty (the band starts beyond the box, so the award path is always a free
// kick). Folds into the existing foul/card draws (no new rng call site).
inline constexpr double CYNICAL_FOUL_DRIVE      = 0.50;   // carrier breaking clearly toward our goal
inline constexpr double CYNICAL_BAND_NEAR       = PENALTY_AREA_W * 1.2;  // never in/near the box (penalty guard)
inline constexpr double CYNICAL_BAND_FAR        = 375.0;  // a genuine break in the approach band, not from deep
inline constexpr double CYNICAL_MIN_SPEED       = 18.0;   // moving with it, not a standing duel
inline constexpr double CYNICAL_LASTMAN_LATERAL = 175.0;  // truly the last man (cover lane → goalSideCover==0 ~ a clear break)
inline constexpr double CYNICAL_FOUL_PROB       = 0.80;   // a committed cynical challenge is a deliberate foul
inline constexpr double CYNICAL_CARD            = 0.55;   // a professional foul is usually bookable

// ── Aerial / collision ──
inline constexpr double AERIAL_HEIGHT           = 20.0;
inline constexpr double HEADER_MIN_HEIGHT       = 16.0;
inline constexpr double HEADER_MAX_HEIGHT       = 64.0;
inline constexpr double HEADER_MIN_DELIVERY_DIST = 115.0;
inline constexpr double HEADER_MIN_SPEED        = 75.0;
// Aerial meet as a z-aware reach SPHERE (not a horizontal cylinder). A header
// reaches up to ~2.2m of contact height and ~2.0m horizontally; a low control
// reaches the floor at ~1.8m. The old flat cylinder let a runner "head" a
// cross from ~3-4m / chest height — the ghost mid-air deflection.
inline constexpr double HEADER_REACH_Z          = 22.0;  // leap contact height (~2.2m)
inline constexpr double MEET_REACH_HEAD         = 20.0;  // horizontal head-meet reach (~2.0m)
inline constexpr double MEET_REACH_GROUND       = 18.0;  // horizontal low/ground control reach (~1.8m)
inline constexpr double GROUND_MEET_MAX_Z       = 12.0;  // a ground control needs the ball at/below shin-knee

// ── Ball-player collision ──
inline constexpr double COLLISION_DAMP_SAME_TEAM  = 0.18;
inline constexpr double COLLISION_DAMP_OPPONENT   = 0.36;
inline constexpr double COLLISION_GLANCE_SAME     = 0.02;
inline constexpr double COLLISION_GLANCE_OPPONENT = 0.045;
inline constexpr double COLLISION_REFLECT_FACTOR  = 1.3;
inline constexpr double COLLISION_SPEED_THRESH    = 130.0;
inline constexpr double COLLISION_FAST_CONTACT    = 80.0;
// A fast loose ball driven through an opponent's body is a reaction duel:
// block chance falls off with pace so a hard ball can still beat a defender.
inline constexpr double LOOSE_BLOCK_BASE          = 0.52;
inline constexpr double LOOSE_BLOCK_SKILL         = 0.30;
inline constexpr double LOOSE_BLOCK_SPEED_FALLOFF = 480.0;
inline constexpr double INTENDED_NEARBY_DIST      = 70.0;
inline constexpr double INTENDED_PASS_SPEED_LIMIT = 220.0;
inline constexpr double PING_PONG_WINDOW_MS       = 300.0;

// ── Shot error ──
inline constexpr double SHOT_ERROR_FLOOR        = 12.0;
inline constexpr double SHOT_ERROR_BASE         = 11.0;
inline constexpr double SHOT_ERROR_SKILL        = 44.0;
inline constexpr double SHOT_ERROR_CLOSE_PRESSURE_NORMAL = 28.0;
inline constexpr double SHOT_ERROR_PRESSURE_NORMAL = 34.0;
inline constexpr double SHOT_ERROR_ANGLE        = 40.0;
inline constexpr double SHOT_ERROR_DISTANCE     = 26.0;
inline constexpr double SHOT_ERROR_LONG_RANGE   = 58.0;
inline constexpr double SHOT_ERROR_LANE_CROSS   = 52.0;
inline constexpr double SHOT_ERROR_LANE_NORMAL  = 58.0;
inline constexpr double SHOT_ERROR_PRESSURE_CROSS = 38.0;
inline constexpr double SHOT_ERROR_CLOSE_PRESSURE_CROSS = 30.0;
// Round-31: the crowd terms above (pressure + close-pressure + lane blockers)
// used to sum LINEARLY and without a ceiling. SHOT_ERROR_CROWD_SAT is the
// asymptote of their saturating sum — one defender still costs nearly the raw
// price, the fourth costs almost nothing extra. SHOT_ERROR_CAP_CLOSE/FAR bound
// the TOTAL spread by range (ramped over 60→220px): the accuracy floor that
// keeps a six-yard chance in traffic finishable. FAR is deliberately loose
// enough to be inert on genuine long shots — this is a box fix, not a
// long-range buff.
inline constexpr double SHOT_ERROR_CROWD_SAT   = 85.0;
inline constexpr double SHOT_ERROR_CAP_CLOSE   = 62.0;
inline constexpr double SHOT_ERROR_CAP_FAR     = 270.0;

// ── Perception ──
inline constexpr double PERCEPTION_CONE_NEAR    = PI / 3.0;
inline constexpr double PERCEPTION_CONE_DEFENDER = PI / 2.0;
// Cone-test guard bands (perceive). The test `nd < CONE` is decided on cos(nd)
// instead of nd, because cos is strictly decreasing on [0, PI]: cos(nd) above
// cos(CONE - SLACK) proves nd < CONE, and cos(nd) below cos(CONE + SLACK)
// proves nd >= CONE. cos(nd) is the unit dot product, which costs three flops
// against an atan2 call. SLACK is 1e-7 rad — eight orders of magnitude above
// the ~1e-15 error in either the dot product or the atan2, and the resulting
// gap in cosine (sin(CONE) * SLACK/2, i.e. >= 4e-8) dwarfs it just as far — so
// a candidate inside a band CANNOT be one the atan2 would have decided the
// other way. A candidate that survives BOTH bands (within 1e-7 rad of the cone
// edge) falls through to the original atan2 expression, so wherever the two
// formulations could conceivably disagree the atan2 still arbitrates.
inline constexpr double PERCEPTION_CONE_SLACK   = 1e-7;
inline const double PERCEPTION_COS_NEAR_IN      = std::cos(PERCEPTION_CONE_NEAR - PERCEPTION_CONE_SLACK);
inline const double PERCEPTION_COS_NEAR_OUT     = std::cos(PERCEPTION_CONE_NEAR + PERCEPTION_CONE_SLACK);
inline const double PERCEPTION_COS_DEFENDER_IN  = std::cos(PERCEPTION_CONE_DEFENDER - PERCEPTION_CONE_SLACK);
inline const double PERCEPTION_COS_DEFENDER_OUT = std::cos(PERCEPTION_CONE_DEFENDER + PERCEPTION_CONE_SLACK);
inline constexpr double PERCEPTION_NEAR_BALL    = 40.0;
inline constexpr double PERCEPTION_PRESSURE_DIST = 60.0;

// Panic-clearance side tests (considerPanicClearance): how far BEHIND the
// facing half-plane a body may sit and still count as pressure — a shoulder
// at his hip is pressure; a trail chaser a metre further back is not.
inline constexpr double PANIC_REAR_SHOULDER_PX = 12.0;

// Same discipline for updateFacing's "am I turning INTO my run line?" test,
// which compares two |wrap(facing - moveAngle)| values and reads neither. It
// is decided on the two facings' projections onto the velocity (the cosines
// of the same two angles, scaled by the speed), and the shortcut only fires
// when those projections are separated by more than this fraction of the
// speed — six orders above the ~1e-15 rounding on either side of the
// comparison. Anything closer falls back to the original atan2 pair.
inline constexpr double FACING_PROJ_SLACK       = 1e-9;

// ── Agent decision thresholds ──
inline constexpr double MIN_FALLBACK_SCORE      = 0.15;

// ── Carrier support (movement) ──
inline constexpr double SUPPORT_CARRIER_CLEAR_DIST   = 58.0;
inline constexpr double SUPPORT_CARRIER_PUSH_FORCE   = 70.0;
inline constexpr double SUPPORT_CARRIER_FORWARD_BIAS = 12.0;
inline constexpr double SUPPORT_CARRIER_LANE_BIAS    = 18.0;

// ── Ball speed thresholds for chase/recovery ──
inline constexpr double RECOVERY_BALL_SPEED_MAX  = 95.0;
inline constexpr double SELF_LOOSE_TOUCH_SPEED   = 90.0;
inline constexpr double SELF_LOOSE_TOUCH_DIST    = 85.0;

// ── Tackle proximity ──
inline constexpr double TACKLE_CLOSE_BOOST_RANGE = TACKLE_RANGE + 10.0;
inline constexpr double TACKLE_ZONE_MAX          = TACKLE_RANGE + 30.0;

// ── Goal proximity zones ──
inline constexpr double NEAR_GOAL_DIST           = 220.0;
inline constexpr double CLOSE_GOAL_DIST          = 120.0;
inline constexpr double PERIMETER_GOAL_DIST      = 150.0;
inline constexpr double WIDE_DANGER_DIST         = 250.0;
inline constexpr double EMERGENCY_BOX_DIST       = 230.0;

// ── Touchline proximity ──
inline constexpr double TOUCHLINE_PROXIMITY      = 85.0;

// ── Dribble behaviour ──
inline constexpr double DRIBBLE_DENSITY_RADIUS   = 80.0;
inline constexpr double DRIBBLE_EDGE_MARGIN      = 60.0;
inline constexpr double DRIBBLE_EVADE_DIST       = 50.0;
inline constexpr double DRIBBLE_SPACE_BONUS_DIST = 100.0;
inline constexpr double DRIBBLE_TIGHT_DIST       = 30.0;
inline constexpr int DRIBBLE_STUCK_HOLD_TICKS = 60;
inline constexpr int DRIBBLE_STUCK_SEVERE     = 180;

// ── Positioning ball distance zones ──
inline constexpr double POS_BALL_FAR_DIST        = 150.0;
inline constexpr double POS_BALL_VERY_FAR_DIST   = 250.0;
inline constexpr double POS_RECENT_PASS_DIST     = 250.0;
inline constexpr double POS_OPPONENT_TRACK_DIST  = 200.0;

// ── Timing / cooldowns ──
inline constexpr double GK_SAVE_MIN_BALL_SPEED  = 100.0;

// ── Round-42: protection must outlast the decision lock ──
// A man who has just taken the ball is briefly unable to act (gather / settle
// stun) and briefly protected from challenge (receiver shield). The two were set
// independently and the lock was the longer, so every adjacent opponent's
// challenge was in effect queued and landed on the first tick the shield lapsed,
// before the man on the ball had been allowed a decision.
inline constexpr double REGAIN_SHIELD_MS         = 450.0;  // interception / loose ball won off the opposition: parity with the Round-39 tackle-win shield
inline constexpr double TACKLE_WIN_SHIELD_MS     = 600.0;  // the 400ms tackle-win gather + one release window (was 450: 50ms of free decision under protection)
inline constexpr double REGAIN_MARKER_DIST       = 45.0;   // an opponent this close to a regain means the first decision comes now, not after the calm settle
inline constexpr double DEEP_RECEIVE_PROGRESS    = PITCH_W * 0.36;   // own territory where being robbed on the first touch is a shot (the keeper-recycle zone)
inline constexpr double DEEP_RECEIVE_MARKER_DIST = 60.0;   // a marker within 6m of a deep reception: hurry the touch and cover it
inline constexpr int    HURRIED_SETTLE_TICKS     = 16;     // ~270ms, the existing press-arriving settle
inline constexpr int    CALM_SETTLE_TICKS        = 45;     // ~750ms, the existing calm settle

// ── Replay frame sampling (main.cpp --frame-sample N) ──
// Output-only: nothing here is read by the simulation, so the RNG stream and every
// summary are untouched whether or not the flag is given.
// The thinning rule a recorded replay is stored under lives in the engine because a
// full-frame run spends its time SERIALISING frames, not simulating them: measured
// 2026-11-10 on the dev box, one 90' capture ran 389s (~166k frames, ~2.3ms each)
// where --summary runs 10 simulated minutes in ~2.4s. Thinning afterwards in the web
// layer paid for seven frames in eight only to drop them. The rule itself is the web
// layer's, unchanged (web/backend/match/capture.ts, captureLineStream); the two must
// agree, and tools/_frame_sample_test.ts holds them to it byte for byte.
inline constexpr int    FRAME_SAMPLE_MIN            = 2;      // 1-in-1 is "no sampling" — ask for that by omitting the flag
inline constexpr double FRAME_SAMPLE_FRESH_EVENT_MS = 150.0;  // a penalty/woodwork event this young pins its frame: it moves no score or state, so nothing else would keep it

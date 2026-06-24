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

// ── Ball speed / physics ──
inline constexpr double PASS_SPEED_BASE = 136.0;
inline constexpr double PASS_SPEED_DIST = 0.105;
inline constexpr double SHOT_SPEED_BASE = 285.0;
inline constexpr double BALL_FRICTION  = 0.70;
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
inline constexpr double BALL_RELEASE_MAX_STEP = 14.0;
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
constexpr auto fdFor(Team team) -> double { return team == Team::Home ? 1.0 : -1.0; }
inline double goalXFor(Team team) { return team == Team::Home ? AWAY_GOAL_X : HOME_GOAL_X; }
inline double ownGoalXFor(Team team) { return team == Team::Home ? HOME_GOAL_X : AWAY_GOAL_X; }

// ── Stamina ──
inline constexpr double STAMINA_DRAIN_SPRINT  = 0.014;
inline constexpr double STAMINA_RECOVER       = 0.012;
inline constexpr double STAMINA_SLOW_THRESHOLD = 0.35;

// ── Dribble speed tiers ──
inline constexpr double DRIBBLE_CLOSE_SPEED  = SPEED_SPRINT * 0.58;
inline constexpr double DRIBBLE_MEDIUM_SPEED = SPEED_RUN;
inline constexpr double DRIBBLE_FAST_SPEED   = SPEED_SPRINT * 0.95;
inline constexpr double DRIBBLE_KNOCK_SPEED_ADVANTAGE = -25.0;
inline constexpr double DRIBBLE_KNOCK_OFFSET = CONTROL_DIST + BALL_R + 5.0;

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
inline constexpr double PASS_MIN_DISTANCE       = 42.0;
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
inline constexpr double CROSS_DRIVE_SPEED_BASE   = 330.0;
inline constexpr double CROSS_DRIVE_SPEED_PER_PX = 0.45;
inline constexpr double CROSS_DRIVE_SPEED_MIN    = 360.0;
inline constexpr double CROSS_DRIVE_SPEED_MAX    = 560.0;
inline constexpr double CROSS_DIP_TARGET_Z       = 18.0;  // ball height at arrival
inline constexpr double CROSS_CURL_MIN           = 0.20;  // rad/s
inline constexpr double CROSS_CURL_RANGE         = 0.17;
inline constexpr double CROSS_CUTOUT_BASE        = 0.28;  // defender cut-out duel
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
inline constexpr double GK_SAVE_MIN             = 0.05;
// Save-ROLL ceiling. NOTE: measured a near-no-op on goal rate — the keeper saves
// mostly by physically COLLECTING the ball (the tracker), not this roll, so this
// is NOT the scoring throttle. Kept named (was a stray 0.84 literal in engine_gk).
inline constexpr double GK_SAVE_MAX             = 0.72;
inline constexpr double GK_CATCH_HANDLING_BASE  = 0.22;
// ── Realistic reach envelope (10px = 1m) ── replaces the flat isotropic circle.
// A keeper has a short STANDING reach but can EXTEND into a dive; a dive covers
// ground over TIME, so a fast shot far from his set line beats him, and a lofted
// ball adds a vertical cost he often can't pay. Centre/slow shots stay easy.
inline constexpr double GK_STAND_REACH    = PLAYER_R + BALL_R + 7.0;  // ~23.5px standing arm reach
inline constexpr double GK_MAX_DIVE_BASE  = 13.0;   // full lateral dive (base)
inline constexpr double GK_MAX_DIVE_SKILL = 13.0;   // ...+ up to this with handling
inline constexpr double GK_DIVE_FULL_T    = 0.42;   // seconds of flight to reach full stretch
inline constexpr double GK_STAND_Z        = 8.0;    // free vertical reach (px) before height costs him
inline constexpr double GK_Z_WEIGHT       = 1.35;   // going UP is slow/expensive vs going sideways
inline constexpr double GK_CATCH_HANDLING_WEIGHT = 0.38;
// (old GK_CATCH_SPEED_* and GK_PARRY_SPEED_* model constants removed — dead since
//  the catch/parry outcome became handling-keyed in the keeper rework.)
// Hold after a clean catch before distributing — 250ms read as a pinball.
inline constexpr double GK_DISTRIBUTE_MS        = 950.0;

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

// ── Perception ──
inline constexpr double PERCEPTION_CONE_NEAR    = PI / 3.0;
inline constexpr double PERCEPTION_CONE_DEFENDER = PI / 2.0;
inline constexpr double PERCEPTION_NEAR_BALL    = 40.0;
inline constexpr double PERCEPTION_PRESSURE_DIST = 60.0;

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

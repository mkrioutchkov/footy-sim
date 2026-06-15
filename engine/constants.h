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
inline constexpr double GOAL_DEPTH = 20.0;
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
inline constexpr double TACKLE_KICK_SPEED = 140.0;
inline constexpr double BALL_FRICTION  = 0.70;
inline constexpr double GRAVITY        = 500.0;
inline constexpr double BOUNCE_FACTOR  = -0.2;
inline constexpr double MIN_BALL_SPEED = 3.0;

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
inline constexpr double SEPARATION_FORCE = 140.0;

// ── Timing ──
inline constexpr double FIXED_DT       = 16.667;
inline constexpr double MATCH_DURATION  = 90.0 * 60.0 * 1000.0;
inline constexpr double HALF_DURATION   = 45.0 * 60.0 * 1000.0;
inline constexpr double THIRD_1         = PITCH_W / 3.0;       // 350
inline constexpr double THIRD_2         = 2.0 * PITCH_W / 3.0; // 700
inline constexpr double ADDED_TIME_WHISTLE_MS = 5000.0;

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

inline constexpr std::array<std::string_view, 6> ROLES = {"GK","CB","FB","CM","WM","CF"};

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
inline constexpr double CORNER_ZONE             = 80.0;
inline constexpr double CORNER_TRAP_SIZE        = 80.0;

// ── Pass scoring ──
inline constexpr double PASS_BASE_COMPLETION    = 0.89;
inline constexpr double PASS_SKILL_WEIGHT       = 0.10;
inline constexpr double PASS_RECEIVER_SKILL     = 0.06;
inline constexpr double PASS_DIST_FACTOR        = 0.28;
inline constexpr double PASS_BLOCKER_PENALTY    = 0.21;
inline constexpr double PASS_PRESSURE_PENALTY   = 0.12;
inline constexpr double PASS_MIN_COMPLETION     = 0.08;
inline constexpr double PASS_MAX_COMPLETION     = 0.98;
inline constexpr double PASS_PROGRESS_NORM      = 240.0;
inline constexpr double PASS_TURNOVER_OWN_THIRD = 0.42;
inline constexpr double PASS_TURNOVER_MID       = 0.25;
inline constexpr double PASS_FORWARD_WEIGHT     = 0.34;
inline constexpr double PASS_COMPLETION_WEIGHT  = 0.38;
inline constexpr double PASS_REPEAT_PENALTY     = 0.18;
inline constexpr double PASS_REPEAT_WINDOW_MS   = 3000.0;
inline constexpr double PASS_MIN_DISTANCE       = 42.0;
inline constexpr double PASS_MAX_DISTANCE       = 550.0;
inline constexpr double PASS_MAX_DISTANCE_KEEPER = 455.0;
inline constexpr double PASS_DIST_NORMALIZATION = 850.0;
inline constexpr double PASS_VISION_CONE        = PI / 3.0;
inline constexpr double PASS_BLOCKER_PERP       = 36.0;
inline constexpr double PASS_BLOCKER_PERP_OUTLET = 34.0;
inline constexpr double PASS_RECEIVER_PRESS_MAX = 45.0;
inline constexpr double PASS_RECEIVER_PRESS_CUT = 3;
inline constexpr double PASS_TOUCHLINE_TRAPPED  = 90.0;
inline constexpr double BLOCKER_PERP_FREEKICK   = 42.0;
inline constexpr double BLOCKER_PERP_THROWIN     = 32.0;
inline constexpr double BLOCKER_PERP_GK_DIST     = 44.0;
inline constexpr double CARRIER_PRESSURE_RANGE   = 70.0;
inline constexpr double CARRIER_PRESSURE_COUNT_DIST = 48.0;

// ── Shot scoring ──
inline constexpr double SHOT_FLOOR_CLOSE        = 0.35;
inline constexpr double SHOT_FLOOR_MEDIUM       = 0.52;
inline constexpr double SHOT_FLOOR_POINT_BLANK  = 0.70;
inline constexpr double SHOT_CLOSE_DISTANCE     = 90.0;
inline constexpr double SHOT_MEDIUM_DISTANCE    = 50.0;
inline constexpr double SHOT_POINT_BLANK        = 30.0;
inline constexpr double SHOT_ANGLE_ACUTE_THRESH  = 7.5;
inline constexpr double SHOT_ACUTE_SOFT_THRESH   = 8.0;
inline constexpr double SHOT_ACUTE_HARD_THRESH    = 7.0;
inline constexpr double SHOT_MAX_DISTANCE_HARD  = 225.0;
inline constexpr double SHOT_MAX_ANGLE_ACUTE    = 150.0;
inline constexpr double SHOT_ANGLE_DISTANCE_2ND = 200.0;
inline constexpr double SHOT_ANGLE_THRESH_2ND   = 9.0;

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

// ── GK save ──
inline constexpr double GK_SAVE_MIN_SPEED       = 200.0;
inline constexpr double GK_SAVE_MAX_GOAL_DIST   = 250.0;
inline constexpr double GK_SAVE_SKILL_POSITION  = 0.28;
inline constexpr double GK_SAVE_SKILL_SPEED     = 0.13;
inline constexpr double GK_SAVE_REACTION_ORIGIN = 55.0;
inline constexpr double GK_SAVE_REACTION_DIST   = 330.0;
inline constexpr double GK_SAVE_REACTION_MAX    = 0.16;
inline constexpr double GK_SAVE_PLACEMENT_DIST  = 72.0;
inline constexpr double GK_SAVE_PLACEMENT_MAX   = 0.58;
inline constexpr double GK_SAVE_SPEED_PENALTY   = 430.0;
inline constexpr double GK_SAVE_SPEED_RANGE     = 380.0;
inline constexpr double GK_SAVE_SPEED_MAX       = 0.20;
inline constexpr double GK_SAVE_BASE            = 0.08;
inline constexpr double GK_SAVE_MIN             = 0.05;
// Save-ROLL ceiling. NOTE: measured a near-no-op on goal rate — the keeper saves
// mostly by physically COLLECTING the ball (the tracker), not this roll, so this
// is NOT the scoring throttle. Kept named (was a stray 0.84 literal in engine_gk).
inline constexpr double GK_SAVE_MAX             = 0.84;
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
inline constexpr double GK_CATCH_SPEED_THRESH   = 520.0;
inline constexpr double GK_CATCH_SPEED_RANGE    = 900.0;
inline constexpr double GK_CATCH_MIN            = 0.12;
inline constexpr double GK_CATCH_MAX            = 0.58;
inline constexpr double GK_PARRY_SPEED_X_BASE   = 155.0;
inline constexpr double GK_PARRY_SPEED_X_FACTOR = 0.10;
inline constexpr double GK_PARRY_SPEED_Y_BASE   = 140.0;
inline constexpr double GK_PARRY_SPEED_Y_RANGE  = 90.0;
// Hold after a clean catch before distributing — 250ms read as a pinball.
inline constexpr double GK_DISTRIBUTE_MS        = 950.0;

// ── Tackle ──
inline constexpr double TACKLE_BASE             = 0.18;
inline constexpr double TACKLE_SKILL_WEIGHT     = 0.35;
inline constexpr double TACKLE_CARRIER_CONTROL  = 0.15;
inline constexpr double TACKLE_FOUL_FROM_BEHIND = 0.06;   // calibrated 2026-06-11 (0.34 gave ~190 fouls/match)
inline constexpr double TACKLE_FOUL_NORMAL      = 0.015;
inline constexpr double TACKLE_CONTROL_BASE     = 0.28;
inline constexpr double TACKLE_CONTROL_MAX      = 0.72;

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
inline constexpr double BOUNCE_DAMP_SAME_TEAM   = 0.18;
inline constexpr double BOUNCE_DAMP_OPPONENT    = 0.25;
inline constexpr double BOUNCE_SPIN_FACTOR      = 0.02;
inline constexpr double REBOUND_BLOCK_MS        = 600.0;

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

// ── Movement ──
inline constexpr double MOVEMENT_FACING_LERP    = 0.06;
inline constexpr double BALL_TRACKING_LERP      = 0.05;
inline constexpr double LOOSE_BALL_FACING_LERP  = 0.15;
inline constexpr double BALL_MEMORY_FACING_LERP = 0.02;
inline constexpr double BALL_MEMORY_TIMEOUT     = 30;

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
inline constexpr double DANGER_DEFENSIVE_OFFSET  = 170.0;

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
inline constexpr double LOG_INTERVAL_MS         = 500.0;
inline constexpr double ONE_TWO_WINDOW_MS       = 2000.0;
inline constexpr double GK_SAVE_MIN_BALL_SPEED  = 100.0;

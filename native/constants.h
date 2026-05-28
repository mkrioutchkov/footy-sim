#pragma once
#include <cmath>
#include <string_view>
#include <array>

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
inline constexpr double PASS_SPEED_BASE = 150.0;
inline constexpr double PASS_SPEED_DIST = 0.12;
inline constexpr double SHOT_SPEED_BASE = 380.0;
inline constexpr double TACKLE_KICK_SPEED = 140.0;
inline constexpr double BALL_FRICTION  = 0.70;
inline constexpr double GRAVITY        = 500.0;
inline constexpr double BOUNCE_FACTOR  = -0.2;
inline constexpr double MIN_BALL_SPEED = 3.0;

// ── Interaction distances ──
inline constexpr double TACKLE_RANGE   = 24.0;
inline constexpr double OFFSIDE_TOLERANCE = 1.0;
inline constexpr double COLLECT_DIST   = 20.0;
inline constexpr double INTENDED_COLLECT_DIST = 28.0;
inline constexpr double CONTROL_DIST   = 12.0;
inline constexpr double PLAYER_AWARE_RANGE = 120.0;
inline constexpr double SHOOT_MIN_DIST = 100.0;
inline constexpr double SHOOT_MAX_DIST = 340.0;
inline constexpr double PENALTY_AREA_W = 165.0;
inline constexpr double PENALTY_AREA_H = 403.0;
inline constexpr double GK_RUSH_DIST   = 200.0;
inline constexpr double SEPARATION_DIST = 38.0;
inline constexpr double SEPARATION_FORCE = 140.0;

// ── Timing ──
inline constexpr double FIXED_DT       = 16.667;
inline constexpr double MATCH_DURATION  = 90.0 * 60.0 * 1000.0;

// ── Utility ──
constexpr auto clamp(double v, double lo, double hi) -> double { return v < lo ? lo : v > hi ? hi : v; }
constexpr auto lerp(double a, double b, double t) -> double { return a + (b - a) * t; }
inline auto dist(double ax, double ay, double bx, double by) -> double {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}
constexpr auto attrFactor(double attr) -> double { return attr / 100.0; }
inline double goalXFor(std::string_view team) { return team == "home" ? AWAY_GOAL_X : HOME_GOAL_X; }
inline double ownGoalXFor(std::string_view team) { return team == "home" ? HOME_GOAL_X : AWAY_GOAL_X; }

inline constexpr std::array<std::string_view, 6> ROLES = {"GK","CB","FB","CM","WM","CF"};

// ── Stamina ──
inline constexpr double STAMINA_DRAIN_SPRINT  = 0.028;
inline constexpr double STAMINA_RECOVER       = 0.015;
inline constexpr double STAMINA_SLOW_THRESHOLD = 0.35;

// ── Dribble speed tiers ──
inline constexpr double DRIBBLE_CLOSE_SPEED  = SPEED_SPRINT * 0.58;
inline constexpr double DRIBBLE_MEDIUM_SPEED = SPEED_RUN;
inline constexpr double DRIBBLE_FAST_SPEED   = SPEED_SPRINT * 0.95;
inline constexpr double DRIBBLE_KNOCK_SPEED_ADVANTAGE = 16.0;
inline constexpr double DRIBBLE_KNOCK_OFFSET = CONTROL_DIST + BALL_R + 3.5;

// ── Collect ──
inline constexpr double COLLECT_SPEED_MAX       = 80.0;
inline constexpr double INTENDED_COLLECT_BONUS   = 1.8;

// ── Pressure / detection ──
inline constexpr double PRESSURE_RANGE          = 58.0;
inline constexpr double STUCK_CARRIER_MOVE_THRESHOLD = 42.0;
inline constexpr double STUCK_CARRIER_TIMEOUT_MS = 4200.0;
inline constexpr double DANGER_ZONE_DIST        = 240.0;
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
inline constexpr double PASS_MIN_DISTANCE       = 30.0;
inline constexpr double PASS_MAX_DISTANCE       = 550.0;
inline constexpr double PASS_VISION_CONE        = PI / 3.0;
inline constexpr double PASS_BLOCKER_PERP       = 30.0;
inline constexpr double PASS_RECEIVER_PRESS_MAX = 45.0;
inline constexpr double PASS_RECEIVER_PRESS_CUT = 3;

// ── Shot scoring ──
inline constexpr double SHOT_FLOOR_CLOSE        = 0.35;
inline constexpr double SHOT_FLOOR_MEDIUM       = 0.52;
inline constexpr double SHOT_FLOOR_POINT_BLANK  = 0.70;
inline constexpr double SHOT_CLOSE_DISTANCE     = 90.0;
inline constexpr double SHOT_MEDIUM_DISTANCE    = 50.0;
inline constexpr double SHOT_POINT_BLANK        = 30.0;
inline constexpr double SHOT_ANGLE_ACUTE_THRESH = 7.5;
inline constexpr double SHOT_MAX_DISTANCE_HARD  = 225.0;
inline constexpr double SHOT_MAX_ANGLE_ACUTE    = 150.0;
inline constexpr double SHOT_ANGLE_DISTANCE_2ND = 200.0;
inline constexpr double SHOT_ANGLE_THRESH_2ND   = 9.0;

// ── Chase ──
inline constexpr double PRE_CONTACT_CHASE_REACH = 36.4;

// ── GK save ──
inline constexpr double GK_SAVE_MIN_SPEED       = 200.0;
inline constexpr double GK_SAVE_MAX_GOAL_DIST   = 250.0;
inline constexpr double GK_SAVE_SKILL_POSITION  = 0.58;
inline constexpr double GK_SAVE_SKILL_SPEED     = 0.19;
inline constexpr double GK_SAVE_REACTION_ORIGIN = 65.0;
inline constexpr double GK_SAVE_REACTION_DIST   = 300.0;
inline constexpr double GK_SAVE_REACTION_MAX    = 0.25;
inline constexpr double GK_SAVE_PLACEMENT_DIST  = 70.0;
inline constexpr double GK_SAVE_PLACEMENT_MAX   = 0.30;
inline constexpr double GK_SAVE_SPEED_PENALTY   = 450.0;
inline constexpr double GK_SAVE_SPEED_RANGE     = 350.0;
inline constexpr double GK_SAVE_SPEED_MAX       = 0.15;
inline constexpr double GK_SAVE_BASE            = 0.11;
inline constexpr double GK_SAVE_MIN             = 0.08;
inline constexpr double GK_SAVE_MAX             = 0.86;
inline constexpr double GK_CATCH_HANDLING_BASE  = 0.22;
inline constexpr double GK_CATCH_HANDLING_WEIGHT = 0.38;
inline constexpr double GK_CATCH_SPEED_THRESH   = 520.0;
inline constexpr double GK_CATCH_SPEED_RANGE    = 900.0;
inline constexpr double GK_CATCH_MIN            = 0.12;
inline constexpr double GK_CATCH_MAX            = 0.58;
inline constexpr double GK_PARRY_SPEED_X_BASE   = 155.0;
inline constexpr double GK_PARRY_SPEED_X_FACTOR = 0.10;
inline constexpr double GK_PARRY_SPEED_Y_BASE   = 140.0;
inline constexpr double GK_PARRY_SPEED_Y_RANGE  = 90.0;
inline constexpr double GK_DISTRIBUTE_MS        = 400.0;

// ── Tackle ──
inline constexpr double TACKLE_BASE             = 0.18;
inline constexpr double TACKLE_SKILL_WEIGHT     = 0.35;
inline constexpr double TACKLE_CARRIER_CONTROL  = 0.15;
inline constexpr double TACKLE_FOUL_FROM_BEHIND = 0.34;
inline constexpr double TACKLE_FOUL_NORMAL      = 0.10;
inline constexpr double TACKLE_CONTROL_BASE     = 0.28;
inline constexpr double TACKLE_CONTROL_MAX      = 0.72;

// ── Aerial / collision ──
inline constexpr double AERIAL_HEIGHT           = 20.0;
inline constexpr double BOUNCE_DAMP_SAME_TEAM   = 0.18;
inline constexpr double BOUNCE_DAMP_OPPONENT    = 0.25;
inline constexpr double BOUNCE_SPIN_FACTOR      = 0.02;
inline constexpr double REBOUND_BLOCK_MS        = 600.0;

// ── Shot error ──
inline constexpr double SHOT_ERROR_BASE         = 16.0;
inline constexpr double SHOT_ERROR_SKILL        = 75.0;
inline constexpr double SHOT_ERROR_PRESSURE     = 18.0;
inline constexpr double SHOT_ERROR_ANGLE        = 32.0;
inline constexpr double SHOT_ERROR_DISTANCE     = 30.0;
inline constexpr double SHOT_ERROR_LONG_RANGE   = 65.0;

// ── Perception ──
inline constexpr double PERCEPTION_CONE_NEAR    = PI / 3.0;
inline constexpr double PERCEPTION_CONE_DEFENDER = PI / 2.0;
inline constexpr double PERCEPTION_NEAR_BALL    = 40.0;

// ── Movement ──
inline constexpr double MOVEMENT_FACING_LERP    = 0.06;
inline constexpr double BALL_TRACKING_LERP      = 0.05;
inline constexpr double LOOSE_BALL_FACING_LERP  = 0.15;
inline constexpr double BALL_MEMORY_FACING_LERP = 0.02;
inline constexpr double BALL_MEMORY_TIMEOUT     = 30;

// ── Timing / cooldowns ──
inline constexpr double LOG_INTERVAL_MS         = 500.0;
inline constexpr double ONE_TWO_WINDOW_MS       = 2000.0;
inline constexpr double GK_SAVE_MIN_BALL_SPEED  = 100.0;

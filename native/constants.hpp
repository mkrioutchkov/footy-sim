#pragma once
#include <cmath>
#include <string_view>
#include <array>

inline constexpr double PITCH_W   = 1050.0;
inline constexpr double PITCH_H   = 680.0;
inline constexpr double GOAL_W    = 73.0;
inline constexpr double GOAL_H    = 24.0;
inline constexpr double GOAL_DEPTH = 20.0;
inline constexpr double HOME_GOAL_X = 0.0;
inline constexpr double AWAY_GOAL_X = PITCH_W;
inline constexpr double HALF_X    = PITCH_W / 2.0;

inline constexpr double PLAYER_R  = 12.0;
inline constexpr double BALL_R    = 4.5;

inline constexpr double SPEED_RUN     = 55.0;
inline constexpr double SPEED_SPRINT  = 74.0;
inline constexpr double MAX_PLAYER_SPEED = 55.0;

inline constexpr double PASS_SPEED_BASE = 150.0;
inline constexpr double PASS_SPEED_DIST = 0.12;
inline constexpr double SHOT_SPEED_BASE = 380.0;
inline constexpr double TACKLE_KICK_SPEED = 120.0;

inline constexpr double TACKLE_RANGE   = 24.0;
inline constexpr double OFFSIDE_TOLERANCE = 1.0;
inline constexpr double COLLECT_DIST   = 20.0;
inline constexpr double INTENDED_COLLECT_DIST = 28.0;
inline constexpr double CONTROL_DIST   = 12.0;
inline constexpr double BALL_FRICTION  = 0.70;
inline constexpr double PLAYER_AWARE_RANGE = 120.0;
inline constexpr double SHOOT_MIN_DIST = 100.0;
inline constexpr double SHOOT_MAX_DIST = 340.0;
inline constexpr double PENALTY_AREA_W = 165.0;
inline constexpr double PENALTY_AREA_H = 403.0;
inline constexpr double GK_RUSH_DIST   = 200.0;
inline constexpr double SEPARATION_DIST = 38.0;
inline constexpr double SEPARATION_FORCE = 140.0;

inline constexpr double FIXED_DT       = 16.667;
inline constexpr double MATCH_DURATION  = 90.0 * 60.0 * 1000.0;

constexpr auto clamp(double v, double lo, double hi) -> double { return v < lo ? lo : v > hi ? hi : v; }
constexpr auto lerp(double a, double b, double t) -> double { return a + (b - a) * t; }
inline auto dist(double ax, double ay, double bx, double by) -> double {
    double dx = ax - bx, dy = ay - by;
    return std::sqrt(dx * dx + dy * dy);
}
constexpr auto attrFactor(double attr) -> double { return attr / 100.0; }

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

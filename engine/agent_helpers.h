#pragma once

#include "types.h"
#include "constants.h"
#include <cmath>

// ── Press-slot helpers ───────────────────────────────────────────────────────
// The press-slot system limits chasing/tackling to at most 2 defenders at a time.
// These helpers eliminate the duplicated boilerplate in resolveChoice().

struct PressSlotCheck {
    bool isSelf;
    bool slot1Free;
    bool slot2Free;
};

/// Read the current press-slot state for a given player.
inline PressSlotCheck checkPressSlots(const TeamBlackboard& bb, int playerId) {
    return {
        bb.pressingPlayerId == playerId || bb.pressingPlayerId2 == playerId,
        bb.pressingPlayerId < 0,
        bb.pressingPlayerId2 < 0
    };
}

/// Try to claim a press slot. Returns true if the player already owns one or
/// successfully claimed one. Returns false if both slots are full.
inline bool tryClaimPressSlot(TeamBlackboard& bb, int playerId,
                               bool isSelf, bool slot1Free, bool slot2Free) {
    if (isSelf) return true;
    if (slot1Free) { bb.pressingPlayerId = playerId; return true; }
    if (slot2Free) { bb.pressingPlayerId2 = playerId; return true; }
    return false;
}

// ── Common query helpers ────────────────────────────────────────────────────

/// Count opponents within `range` of (x, y), excluding the given team and GKs.
inline int countPressure(const std::vector<Player>& players, double x, double y,
                         Team team, double range) {
    int count = 0;
    for (auto& o : players) {
        if (o.team == team || o.role == Role::GK) continue;
        if (std::hypot(o.x - x, o.y - y) < range) count++;
    }
    return count;
}

/// Count lane blockers between `from` and `to` within perpendicular threshold.
inline int countLaneBlockers(const std::vector<Player>& players,
                              double fromX, double fromY, double toX, double toY,
                              Team passerTeam, double perpThreshold,
                              double alongMin = 0.06, double alongMax = 0.92) {
    double dx = toX - fromX, dy = toY - fromY;
    double lenSq = dx * dx + dy * dy;
    if (lenSq < 1.0) return 0;
    int blockers = 0;
    for (auto& o : players) {
        if (o.team == passerTeam || o.role == Role::GK) continue;
        double along = clamp(((o.x - fromX) * dx + (o.y - fromY) * dy) / lenSq, 0.0, 1.0);
        if (along <= alongMin || along >= alongMax) continue;
        double perp = std::hypot(o.x - fromX - along * dx, o.y - fromY - along * dy);
        if (perp < perpThreshold) blockers++;
    }
    return blockers;
}

/// Clamp a target X coordinate to the pitch boundary with a margin.
constexpr double clampPitchX(double x, double margin = 35.0) {
    return x < margin ? margin : x > PITCH_W - margin ? PITCH_W - margin : x;
}

/// Clamp a target Y coordinate to the pitch boundary with a margin.
constexpr double clampPitchY(double y, double margin = 35.0) {
    return y < margin ? margin : y > PITCH_H - margin ? PITCH_H - margin : y;
}

/// Shared rated-target struct used by set piece release functions.
struct RatedTarget {
    Player* player;
    double score;
};

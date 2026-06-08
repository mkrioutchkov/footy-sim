#pragma once

#include "types.h"

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

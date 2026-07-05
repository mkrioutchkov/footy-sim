#pragma once
#include "types.h"

// ══════════════════════════════════════════════════════════════════════════════
// RoleProfile — a role's tuning constants as DATA, in one readable block.
//
// The engine keys a lot of tuning on role. Historically each knob was a virtual
// hook (`double shotMaxDistance() const`) with a default in agent.h and a per-role
// `override` in role_ai.h — so a role's numbers were smeared across ~40 one-line
// overrides in six classes, and "what is a CF?" or "add a wing-back" meant hunting
// through all of them.
//
// Here every role is a single struct literal in the TABLE below. The PlayerAI
// constant-hooks read `profileFor(player.role).field`, so:
//   • understand a role  → read its row,
//   • tune a role        → edit its row,
//   • ADD a role         → add a Role enum value + one row here (+ a subclass only
//                          for genuine behavioural logic, not numbers).
//
// This holds the PURE-CONSTANT knobs only. Hooks with real per-role *logic*
// (adjustActionScores, shotRoleError, isOffensiveThreat, markerRoleBonus,
// abandonsDistantChase, defensiveLineOffsetX/TargetY, …) stay virtual in role_ai.h
// — data for numbers, virtual dispatch for behaviour.
//
// Each field's value is exactly what the corresponding hook returned before, so
// routing a hook through the profile is byte-identical (verified on tools/golden).
// ══════════════════════════════════════════════════════════════════════════════

struct RoleProfile {
    // ── Shooting / finishing ──
    double shotMaxDistance;          // hard cap on open-play shot distance
    double freshCrossMaxDistance;    // max range to strike a just-collected cross first-time
    double shotScoreBonus;           // flat bonus to the shoot action score
    double freshCrossShotBonus;      // shoot bonus specifically off a fresh cross
    double finalThirdShotMaxDistance;// max distance to take on a final-third shot
    double finalThirdShotMinAngle;   // min goal-opening angle (deg) for a final-third shot
    double centralShootBonus;        // bonus for shooting from a central position
    double wideShootPenalty;         // penalty for shooting from wide (wide players suffer less)
    double closeRangeShootBonus;     // bonus for a close-range central-ish chance
    double nearGoalShotBiasMargin;   // near-goal shoot-over-pass bias margin (-1 = off)
};

// Indexed by Role (GK=0, CB, FB, CM, WM, CF — see enum in types.h). A role that
// used the agent.h default simply carries that default value in its row.
inline const RoleProfile& profileFor(Role r) {
    static constexpr RoleProfile TABLE[] = {
        //                shotMax  freshX  shotBns  freshXBns  f3Max  f3Ang  central  widePen  closeBns  nearGoalBias
        /* GK */         { 225.0,  250.0,   0.0,     0.42,     165.0,  8.0,   0.0,     0.08,    0.0,      -1.0 },
        /* CB */         { 180.0,  250.0,   0.0,     0.42,     165.0,  8.0,   0.0,     0.08,    0.0,      -1.0 },
        /* FB */         { 205.0,  250.0,   0.0,     0.42,     165.0,  8.0,   0.0,     0.08,    0.0,      -1.0 },
        /* CM */         { 220.0,  250.0,   0.0,     0.42,     165.0, 10.0,   0.0,     0.08,    0.0,      -1.0 },
        /* WM */         { 215.0,  270.0,   0.0,     0.42,     175.0,  8.0,   0.08,    0.04,    0.0,      -1.0 },
        /* CF */         { 225.0,  285.0,   0.20,    0.62,     210.0,  8.0,   0.0,     0.08,    0.18,      0.22 },
    };
    return TABLE[static_cast<int>(r)];
}

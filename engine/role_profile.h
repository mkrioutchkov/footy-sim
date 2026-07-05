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
// (adjustActionScores, shotRoleError, shotDistancePenalty, nearGoalDribbleBonus,
// openSpaceDribbleBonus, isOffensiveThreat, markerRoleBonus, abandonsDistantChase,
// defensiveLineOffsetX/TargetY, …) stay virtual in role_ai.h — data for numbers,
// virtual dispatch for behaviour.
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
    // ── Passing ──
    double roleBonusForPassTarget;   // how attractive this role is as a pass target
    // ── Tackling ──
    double tackleBaseScore;          // base tackle-action score
    double tackleRoleAdjust;         // role adjustment to the tackle score
    double tackleDistCoeff;          // distance weight in the tackle score
    double tackleSkillCoeff;         // tackling-skill weight in the tackle score
    // ── Carrying / dribbling ──
    double dribbleOwnHalfExtraPenalty;// extra penalty for dribbling in own half
    double spaceCarryRoleBonus;      // bonus for a dribble-into-space carry
    double openLaneDribbleBonus;     // bonus for driving into an open lane
    double openLaneDribbleDistance;  // how far to drive an open lane
    // ── Positioning / defensive costs ──
    double observingCruiseMul;       // cruise-speed multiplier while off-ball observing
    double shotLaneCost;             // cost of being assigned to block a shot lane
    double crossLaneCost;            // cost of being assigned to a cross lane
    double boxGuardCost;             // cost of a box-guard assignment
    double cutbackGuardCost;         // cost of a cutback-guard assignment
    double penaltyTakerBonus;        // preference to be the penalty taker
    double pressCostSafe;            // defensivePressCost when NOT in danger
    double pressCostDanger;          // defensivePressCost when in danger
    // ── Capabilities (behaviours this role may use) ──
    bool   canUseFlankTargets;
    bool   canUseOpenLane;
    bool   canUseWideDribble;
    bool   shouldSearchForPassOverShot;
    // ── Defensive-line role ──
    DefensiveTask defensiveLineRoleTask;
};

// Indexed by Role (GK=0, CB, FB, CM, WM, CF — see enum in types.h). A role that
// used the agent.h default simply carries that default value in its row.
inline const RoleProfile& profileFor(Role r) {
    static const RoleProfile TABLE[] = {
        /* GK */ {
            /*shoot*/    225.0, 250.0, 0.0,  0.42, 165.0,  8.0, 0.0,  0.08, 0.0, -1.0,
            /*pass*/     0.0,
            /*tackle*/   0.60, 0.0,   0.40, 0.20,
            /*carry*/   -0.02, 0.08,  0.0,  0.0,
            /*position*/ 0.50, 34.0, 38.0, 28.0, 32.0,  0.0, 14.0, 14.0,
            /*caps*/     false, false, false, false,
            /*task*/     DefensiveTask::DefensiveLine,
        },
        /* CB */ {
            /*shoot*/    180.0, 250.0, 0.0,  0.42, 165.0,  8.0, 0.0,  0.08, 0.0, -1.0,
            /*pass*/     0.0,
            /*tackle*/   0.68, 0.0,   0.35, 0.22,
            /*carry*/   -0.02, 0.08,  0.0,  0.0,
            /*position*/ 0.65, 34.0, 38.0,  0.0, 32.0,  0.0, 120.0, 8.0,
            /*caps*/     false, false, false, false,
            /*task*/     DefensiveTask::DefensiveLine,
        },
        /* FB */ {
            /*shoot*/    205.0, 250.0, 0.0,  0.42, 165.0,  8.0, 0.0,  0.08, 0.0, -1.0,
            /*pass*/     0.0,
            /*tackle*/   0.50, 0.0,   0.35, 0.18,
            /*carry*/   -0.02, 0.12,  0.12, 135.0,
            /*position*/ 0.65, 12.0,  0.0, 28.0, 18.0,  0.0, 58.0, 14.0,
            /*caps*/     true,  true,  false, false,
            /*task*/     DefensiveTask::WideCover,
        },
        /* CM */ {
            /*shoot*/    220.0, 250.0, 0.0,  0.42, 165.0, 10.0, 0.0,  0.08, 0.0, -1.0,
            /*pass*/     0.0,
            /*tackle*/   0.60, 0.06,  0.40, 0.20,
            /*carry*/   -0.02, 0.18,  0.18, 165.0,
            /*position*/ 0.50,  0.0, 10.0, 18.0,  0.0, 45.0,  0.0,  0.0,
            /*caps*/     true,  true,  false, true,
            /*task*/     DefensiveTask::DefensiveLine,
        },
        /* WM */ {
            /*shoot*/    215.0, 270.0, 0.0,  0.42, 175.0,  8.0, 0.08, 0.04, 0.0, -1.0,
            /*pass*/     0.36,
            /*tackle*/   0.60, -0.04, 0.40, 0.20,
            /*carry*/    0.0,  0.18,  0.0,  0.0,
            /*position*/ 0.55, 34.0, 18.0, 28.0, 32.0, 25.0,  6.0,  6.0,
            /*caps*/     false, false, true,  false,
            /*task*/     DefensiveTask::DefensiveLine,
        },
        /* CF */ {
            /*shoot*/    225.0, 285.0, 0.20, 0.62, 210.0,  8.0, 0.0,  0.08, 0.18, 0.22,
            /*pass*/     0.72,
            /*tackle*/   0.60, -0.15, 0.40, 0.20,
            /*carry*/   -0.02, 0.08,  0.0,  0.0,
            /*position*/ 0.45, 34.0, 38.0, 28.0, 32.0, 90.0, 28.0, 28.0,
            /*caps*/     false, false, false, false,
            /*task*/     DefensiveTask::DefensiveLine,
        },
    };
    return TABLE[static_cast<int>(r)];
}

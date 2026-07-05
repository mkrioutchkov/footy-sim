#pragma once
#include "types.h"

// ══════════════════════════════════════════════════════════════════════════════
// Set-piece role-preference weights, as DATA (indexed by Role: GK,CB,FB,CM,WM,CF).
//
// Each of these was a `p.role == Role::X ? w : role == Role::Y ? … : fallback`
// ternary ladder buried in engine_setpiece.cpp — role-keyed weight maps that a
// new role would have to be threaded into in nine different places. Here they are
// one table each; adding a role is a new column, and the values are byte-identical
// to the ladders they replace (verified on tools/golden).
// ══════════════════════════════════════════════════════════════════════════════

namespace sp {

//                                     GK      CB     FB     CM     WM      CF
inline constexpr double FK_RECYCLE[6]   = {  0.0,  0.16,  0.20,  0.24,  0.06, -0.16 }; // free-kick safe/recycle target
inline constexpr double FK_FORWARD[6]   = { -0.08,-0.08,  0.04,  0.08,  0.22,  0.16 }; // free-kick forward/attacking target
inline constexpr double GK_SHORT[6]     = {  0.0, 22.0,  40.0,   0.0,   0.0,   0.0  }; // goal-kick short (to a defender)
inline constexpr double GK_LONG[6]      = {  0.0,  0.0,  25.0,   0.0, 125.0, 150.0  }; // goal-kick long (to an attacker)
inline constexpr double GK_BOXRUN[6]    = {  0.0,  0.0,   0.0,   0.0,  80.0, 100.0  }; // goal-kick box runner
inline constexpr double DIST_OUTLET[6]  = {  0.0,  0.0,  35.0,   0.0,  85.0,  70.0  }; // keeper-distribution outlet
inline constexpr double DIST_SAFE[6]    = {  0.0,  0.10,  0.30,  0.16,  0.20,  0.0  }; // keeper-distribution safe option
inline constexpr double CORNER_TARGET[6]= { -0.05, 0.06, -0.05,  0.18,  0.10,  0.35 }; // corner delivery target
inline constexpr double CORNER_TAKER[6] = {120.0,120.0,  20.0,  55.0,   0.0, 120.0  }; // corner-taker walk cost (lower = prefer)

inline double weight(const double (&t)[6], Role r) { return t[static_cast<int>(r)]; }

} // namespace sp

#pragma once
#include "types.h"
#include "constants.h"
#include <cmath>

// ══════════════════════════════════════════════════════════════════════════════
// Pitch-location vocabulary — "where on the pitch is this, in football terms?"
//
// This is what the old (dead, since removed) PitchArea enum was meant to be. The engine hand-rolls the
// same handful of location scalars everywhere — attack-direction progress up the
// pitch, distance from a goal, how far off-centre — each recomputed inline with a
// slightly different literal. These helpers name the *computation* once so a call
// site reads in football terms instead of raw coordinate algebra.
//
// DESIGN RULE — extract the computation, never the decision. `lateralFromCenter`
// is compared against ~20 different thresholds across the engine ("wide" means 120
// here, 140 there, 210 for a marking gate). So the shared primitive is the SCALAR;
// each site keeps its own comparison. There is deliberately no bool `isWide(y)` —
// that would force one threshold and change behaviour. Same for the goal-distance
// "danger" bands: `distToOwnGoal` is the scalar, the band stays at the call site.
//
// Every helper reproduces the existing arithmetic byte-for-byte, so routing a site
// through it is a pure refactor (verified against tools/golden).
//
// Wrapped in `namespace pitch` to keep call sites unambiguous (e.g. the struct data
// member `forwardProgress` never shadows the free function).
// ══════════════════════════════════════════════════════════════════════════════

namespace pitch {

// ── Lateral position (off-centre distance / side) ──
// The scalar behind every `std::abs(y - PITCH_H / 2.0) <>` "how wide is he" test.
inline double lateralFromCenter(double y) { return std::abs(y - PITCH_H / 2.0); }
inline double lateralFromCenter(const Player& p) { return lateralFromCenter(p.y); }
// Which touchline half he's in (drives left/right channel picks).
inline bool   leftOfCenter(double y) { return y < PITCH_H / 2.0; }
inline bool   leftOfCenter(const Player& p) { return leftOfCenter(p.y); }

// ── Up-pitch progress (attack-direction aware) ──
// Signed distance advanced from own goal toward the opponent goal: 0 at own goal
// line, +PITCH_W deep in the opponent half. The canonical `(x - ownGoalX) * fd`.
inline double forwardProgress(double x, Team team) {
    return (x - ownGoalXFor(team)) * fdFor(team);
}
inline double forwardProgress(const Player& p) { return forwardProgress(p.x, p.team); }

// Signed up-pitch gain from one x to another, in `team`'s attacking direction —
// the `(toX - fromX) * fd` behind every pass "forward progress" (fp) scalar.
inline double forwardGain(double fromX, double toX, Team team) {
    return (toX - fromX) * fdFor(team);
}

// ── Distance to a goal line (unsigned "depth") ──
inline double distToOwnGoal(double x, Team team) { return std::abs(x - ownGoalXFor(team)); }
inline double distToOwnGoal(const Player& p) { return distToOwnGoal(p.x, p.team); }
inline double distToOppGoal(double x, Team team) { return std::abs(x - goalXFor(team)); }
inline double distToOppGoal(const Player& p) { return distToOppGoal(p.x, p.team); }

// ── Goal-proximity bands (parameterised — the band stays the caller's choice) ──
// Replaces the scattered `std::abs(x - ownGoalX) < <band>` "in a dangerous area"
// checks. The threshold is an explicit argument so differing literals (240, 300,
// DANGER_ZONE_DIST, …) remain visible per-site instead of being silently unified.
inline bool inOwnGoalBand(double x, Team team, double band) { return distToOwnGoal(x, team) < band; }
inline bool inOwnGoalBand(const Player& p, double band) { return distToOwnGoal(p) < band; }
inline bool inOppGoalBand(double x, Team team, double band) { return distToOppGoal(x, team) < band; }
inline bool inOppGoalBand(const Player& p, double band) { return distToOppGoal(p) < band; }

// ── Thirds (attack-relative, using the named THIRD_1/THIRD_2 = PITCH_W/3, 2·/3) ──
enum class Third : uint8_t { Defensive, Middle, Final };
inline Third thirdOf(double x, Team team) {
    double prog = forwardProgress(x, team);
    if (prog < THIRD_1) return Third::Defensive;
    if (prog < THIRD_2) return Third::Middle;
    return Third::Final;
}
inline Third thirdOf(const Player& p) { return thirdOf(p.x, p.team); }

// ── Attack-relative half / third membership (boolean, mirrored per team) ──
// Written as each call site writes it — Home uses `<`/`>` against the near
// boundary, Away the mirror against the far one. IMPORTANT: do NOT derive the
// Away branch by flipping the Home inequality through forwardProgress; the strict
// comparator would move at the exact boundary (x == HALF_X / THIRD_1 / THIRD_2).
// These are distinct predicates on purpose — inFinalThird is a STRICT `> THIRD_2`
// and is NOT the same as `thirdOf(...) == Third::Final` (half-open at THIRD_2).
inline bool inOwnHalf(double x, Team team) { return team == Team::Home ? x < HALF_X : x > HALF_X; }
inline bool inOwnHalf(const Player& p) { return inOwnHalf(p.x, p.team); }
inline bool inOwnDefensiveThird(double x, Team team) { return team == Team::Home ? x < THIRD_1 : x > THIRD_2; }
inline bool inOwnDefensiveThird(const Player& p) { return inOwnDefensiveThird(p.x, p.team); }
inline bool inFinalThird(double x, Team team) { return team == Team::Home ? x > THIRD_2 : x < THIRD_1; }
inline bool inFinalThird(const Player& p) { return inFinalThird(p.x, p.team); }

// The one own-goal band every site spells with the SAME literal (DANGER_ZONE_DIST),
// so a boolean is allowed here (unlike the parameterised inOwnGoalBand). Does not
// cover sites that compare a min()/blended distance to the band — only a single x.
inline bool inDangerZone(double x, Team team) { return inOwnGoalBand(x, team, DANGER_ZONE_DIST); }
inline bool inDangerZone(const Player& p) { return inDangerZone(p.x, p.team); }

} // namespace pitch

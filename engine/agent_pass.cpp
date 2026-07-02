#include "engine.h"
#include "agent.h"
#include <optional>

SmallVector<Action, 24> PlayerAI::scorePass(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    SmallVector<Action, 24> r;
    // Still settling a fierce first touch — no measured pass this tick. He
    // takes a touch (dribble/shield) or shoots a first-timer instead. Slow
    // receptions carry ~0 settle, so one-twos off a controlled ball survive.
    if (engine.inFirstTouch(p.id)) return r;
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    double ownGoalX = ownGoalXFor(p.team);
    double ownProgress = (p.x - ownGoalX) * fd;

    auto clearOutfieldOutletExists = [&]() {
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK || t.sentOff) continue;
            if (engine.isOffsideTargetPerceived(p, t)) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < PASS_MIN_DISTANCE || d > 360.0) continue;
            double fp = (t.x - p.x) * fd;
            if (fp < -80.0) continue;
            double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
            if (ls < 1.0) continue;
            int bl = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK) continue;
                double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
                double perp = std::hypot(o.x - p.x - t2 * dx, o.y - p.y - t2 * dy);
                if (perp < PASS_BLOCKER_PERP_OUTLET) bl++;
            }
            if (bl > 1) continue;
            int receiverPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < PASS_RECEIVER_PRESS_MAX) receiverPressure++;
            }
            if (receiverPressure > 1) continue;
            return true;
        }
        return false;
    };
    bool hasClearOutfieldOutlet = clearOutfieldOutletExists();

    // Pre-compute per-iteration constants
    bool movingTowardOwnGoal = p.vx * fd < -8.0;
    bool trappedNearTouchline = (p.y < PASS_TOUCHLINE_TRAPPED || p.y > PITCH_H - PASS_TOUCHLINE_TRAPPED) && per.nearestOpponentDist < PASS_MIN_DISTANCE;
    bool nearOwnThird = ownProgress < PITCH_W * 0.40;
    bool urgentKeeperNeed = (per.pressureCount >= 2 && nearOwnThird)
        || (movingTowardOwnGoal && per.nearestOpponentDist < PASS_MIN_DISTANCE && nearOwnThird)
        || (trappedNearTouchline && ownProgress < PITCH_W * 0.36);

    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.id == p.id) continue;
        auto result = scorePassToTarget(t, per, fd, ownGoalX, ownProgress,
                                        hasClearOutfieldOutlet, urgentKeeperNeed, movingTowardOwnGoal);
        if (result) r.push_back(*result);
    }

    // ── Crossing carrier override ──
    // ⚠ Load-bearing offense — do NOT remove without replacing the chances.
    // History: this block is the engine's cross-volume machine (originally ~246
    // crosses/match, gated to ~76; attribution testing shows it produces ~50 of
    // those). Score thresholds and arbitration weights CANNOT cut its volume:
    // the carrier re-evaluates every tick, so any per-tick chance of the cross
    // winning saturates over a multi-second wide possession (threshold 0.42 ->
    // 1.05 and a 0.90 -> 0.72 weight cap each moved volume by ~1/match). And an
    // A/B with the override restricted to the cross_early directive collapsed
    // the attack entirely — 1.05 goals/match, 9-of-20 matches 0-0 — because
    // central penetration/cutback chance creation doesn't yet exist to replace
    // it. Until that exists (chance-mix rebuild), this stays as the offense.
    double goalX = goalXFor(p.team);
    bool crossEarly = engine.directiveBias[p.id].crossEarly;
    bool crossingCarrier = isWidePlayer()
        && std::abs(p.y - PITCH_H / 2.0) > (crossEarly ? 120.0 : 150.0)
        && std::abs(p.x - goalX) < (crossEarly ? 360.0 : 250.0);
    if (crossingCarrier) {
        Player* bestRunner = nullptr;
        double bestScore = -1e9;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK || t.sentOff) continue;
            if (engine.isOffsideTargetPerceived(p, t)) continue;
            double targetGoalDist = std::abs(t.x - goalX);
            if (targetGoalDist > 430.0 || std::abs(t.y - PITCH_H / 2.0) > 255.0) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < 65.0 || d > 520.0) continue;
            int pressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 48.0) pressure++;
            }
            double central = 1.0 - std::abs(t.y - PITCH_H / 2.0) / 230.0;
            double roleBonus = 0.0;
            for (auto& a : engine.agents) { if (a->player.id == t.id) { roleBonus = a->roleBonusForPassTarget(); break; } }
            double goalThreat = targetGoalDist < 150.0 ? 0.34 : targetGoalDist < 210.0 ? 0.20 : targetGoalDist < 260.0 ? 0.06 : -0.08;
            double score = central + roleBonus + goalThreat + (300.0 - targetGoalDist) / 390.0 - pressure * 0.25 - d / 900.0;
            if (score > bestScore) { bestScore = score; bestRunner = &t; }
        }
        // A packed box kills the cross: real wingers recycle or pull it back when
        // the area is crowded — whipping it into 4+ defenders is a turnover, and
        // indiscriminate crossing is why the engine sat at ~76 crosses (real
        // 30-40) with every attack looking identical.
        if (bestRunner) {
            int boxDefenders = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
                if (std::abs(o.x - goalX) < 200.0 && std::abs(o.y - PITCH_H / 2.0) < 170.0) boxDefenders++;
            }
            bestScore -= std::max(0, boxDefenders - 2) * 0.13;
        }
        // Threshold calibrated by attribution test: this override produced ~50 of
        // the ~72 crosses/match (helper ~21 + corners ~11 are the rest). The score
        // scale runs ~1.0-1.7 for a decent runner, so 0.42/0.55 barely gated —
        // 1.05 demands a genuinely elite target (central, near goal, unmarked,
        // uncrowded box) and drops the override's volume to a garnish on top of
        // the organic helper crosses.
        if (bestRunner && bestScore > (crossEarly ? 0.15 : 1.05)) {
            double d = dist(p.x, p.y, bestRunner->x, bestRunner->y);
            double fp = (bestRunner->x - p.x) * fd;
            r.push_back(Action{ActionType::Pass, clamp(0.55 + bestScore * 0.25, 0.0, 0.90), bestRunner, 0, 0,
                               ActionPurpose::Cross, ActionAudit{d, fp, 0.72, 0, 0, 0, 0}});
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════

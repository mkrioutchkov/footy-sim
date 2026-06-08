#include "engine.h"
#include "agent.h"
#include <optional>

std::vector<Action> PlayerAI::scorePass(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    std::vector<Action> r;
    double ownGoalX = ownGoalXFor(p.team);
    double ownProgress = (p.x - ownGoalX) * fd;

    auto clearOutfieldOutletExists = [&]() {
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
            if (engine.isOffsideTarget(p, t)) continue;
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
    double goalX = goalXFor(p.team);
    bool crossingCarrier = (p.role == Role::WM || p.role == Role::FB)
        && std::abs(p.y - PITCH_H / 2.0) > 75.0
        && std::abs(p.x - goalX) < 520.0;
    if (crossingCarrier) {
        Player* bestRunner = nullptr;
        double bestScore = -1e9;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
            if (engine.isOffsideTarget(p, t)) continue;
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
        if (bestRunner && bestScore > -0.05) {
            double d = dist(p.x, p.y, bestRunner->x, bestRunner->y);
            double fp = (bestRunner->x - p.x) * fd;
            r.push_back(Action{ActionType::Pass, clamp(0.78 + bestScore * 0.20, 0.0, 0.98), bestRunner, 0, 0,
                               ActionPurpose::Cross, ActionAudit{d, fp, 0.72, 0, 0, 0, 0}});
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════

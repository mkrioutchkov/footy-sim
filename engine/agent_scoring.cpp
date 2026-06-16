#include "engine.h"
#include "agent.h"

CarrierPressure assessCarrierPressure(GameEngine& engine, const Player& p) {
    CarrierPressure cp;
    auto& b = engine.state.ball;
    double ballDx = b.x - p.x, ballDy = b.y - p.y;
    double ballD = std::hypot(ballDx, ballDy);
    double ballUx = ballD > 0.1 ? ballDx / ballD : std::cos(p.facing);
    double ballUy = ballD > 0.1 ? ballDy / ballD : std::sin(p.facing);
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role == Role::GK || o.sentOff) continue;
        double dx = o.x - p.x, dy = o.y - p.y;
        double d = std::hypot(dx, dy);
        if (d > CARRIER_PRESSURE_RANGE) continue;
        if (d < cp.nearest) { cp.nearest = d; cp.nearestPlayer = &o; }
        if (d < CARRIER_PRESSURE_COUNT_DIST) cp.count++;
        double ux = d > 0.1 ? dx / d : 0.0;
        double uy = d > 0.1 ? dy / d : 0.0;
        cp.exposed = std::max(cp.exposed, ballUx * ux + ballUy * uy);
        double goalSideDir = p.team == Team::Home ? -1.0 : 1.0;
        if ((o.x - p.x) * goalSideDir > 0.0) cp.goalSide = std::max(cp.goalSide, 1.0 - d / CARRIER_PRESSURE_RANGE);
    }
    cp.score = clamp((CARRIER_PRESSURE_RANGE - cp.nearest) / CARRIER_PRESSURE_RANGE, 0.0, 1.0)
        + std::max(0, cp.count - 1) * 0.18
        + clamp(cp.exposed, 0.0, 1.0) * 0.38
        + cp.goalSide * 0.22;
    return cp;
}

// ══════════════════════════════════════════════════════════════════════════════

// cp() — can-pass
// ══════════════════════════════════════════════════════════════════════════════

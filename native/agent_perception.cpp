#include "engine.h"
#include "agent.h"

Perception PlayerAI::getCachedPerception() {
    perceptionAge++;
    if (cachedPerception.has_value() && perceptionAge < 3) return cachedPerception.value();
    cachedPerception = perceive();
    perceptionAge = 0;
    return cachedPerception.value();
}

// ══════════════════════════════════════════════════════════════════════════════
// pr() — perceive surroundings
// ══════════════════════════════════════════════════════════════════════════════
Perception PlayerAI::perceive() {
    const auto& p = player;
    auto& b = engine.state.ball;
    double dx = b.x - p.x, dy = b.y - p.y, bd = std::sqrt(dx * dx + dy * dy);

    Perception per;
    per.ballDist = bd;
    per.ballIsLoose = (b.controllerId < 0);
    per.iAmController = (b.controllerId == p.id);
    per.intendedId = b.intendedReceiverId;
    per.nearestOpponentDist = 1e9;

    int pc = 0;

    for (auto& o : engine.state.players) {
        if (o.id == p.id) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d > PLAYER_AWARE_RANGE) continue;

        bool inCone = false;
        if (d < 40.0) {
            inCone = true;
        } else {
            double angleTo = std::atan2(o.y - p.y, o.x - p.x);
            double diff = std::abs(angleTo - facing);
            double nd = (diff > 3.141592653589793) ? 2.0 * 3.141592653589793 - diff : diff;
            bool isOwnThird = (p.team == Team::Home) ? b.x < PITCH_W / 3.0 : b.x > PITCH_W * 2.0 / 3.0;
            bool defenderWide = isDefenderRole() && isOwnThird;
            inCone = nd < (defenderWide ? 3.141592653589793 / 2.0 : 3.141592653589793 / 3.0);
        }
        if (!inCone) continue;

        if (o.team == p.team) {
            per.nearbyTeammates.push_back(&o);
        } else {
            per.nearbyOpponents.push_back(&o);
            if (d < per.nearestOpponentDist) per.nearestOpponentDist = d;
            if (d < 60.0) pc++;
        }
    }

    per.pressureCount = pc;

    Player* ctrl = engine.playerById(b.controllerId);
    if (ctrl) {
        per.ballControllerId = ctrl->id;
        per.ballControllerTeam = ctrl->team;
    } else {
        per.ballControllerTeam = engine.teamInPossession();
    }

    bool ac = true, ao = false;
    int cc = 0;
    double ctd = 1e9;

    for (auto& o : engine.state.players) {
        if (o.id == p.id || o.role == Role::GK) continue;
        double d = dist(o.x, o.y, b.x, b.y);
        if (o.team == p.team && d < bd) { cc++; if (d < ctd) ctd = d; }
        if (o.team != p.team && d < bd) ao = true;
    }
    if (cc > 0 && ctd < bd - 30.0) ac = false;

    per.amClosestToBall = ac;
    per.chasingTeammatesCount = cc;
    per.anyOpponentCloserToBall = ao;

    return per;
}

// ══════════════════════════════════════════════════════════════════════════════
// am() — apply movement
// ══════════════════════════════════════════════════════════════════════════════

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

    // ── Cone-test invariants (perf, round-2 profile) ──
    // The cone's half-angle is fixed for the whole scan: isDefenderRole() is a
    // virtual call and the own-third read looks at the ball, and no candidate
    // in the loop can change either. (Both were re-evaluated per candidate.)
    bool isOwnThird = (p.team == Team::Home) ? b.x < PITCH_W / 3.0 : b.x > PITCH_W * 2.0 / 3.0;
    bool defenderWide = isDefenderRole() && isOwnThird;
    const double coneLimit  = defenderWide ? PERCEPTION_CONE_DEFENDER : PERCEPTION_CONE_NEAR;
    const double coneCosIn  = defenderWide ? PERCEPTION_COS_DEFENDER_IN  : PERCEPTION_COS_NEAR_IN;
    const double coneCosOut = defenderWide ? PERCEPTION_COS_DEFENDER_OUT : PERCEPTION_COS_NEAR_OUT;
    // The facing direction as a unit vector, so the cone test is a dot product
    // instead of an atan2 (see PERCEPTION_CONE_SLACK in constants.h). The
    // shortcut is only sound while `facing` is already wrapped into [-PI, PI]:
    // that is what makes the original's `diff > PI ? 2PI - diff : diff` the true
    // angular separation, and the true separation is the only thing cos(nd)
    // can measure. This guard is NOT theoretical — a carrier's facing is
    // accumulated unwrapped (engine_carry moveBallCarrier does `c->facing +=`
    // with no re-wrap), and an instrumented 45-min match found 17.2k of 3.34M
    // cone tests running on an out-of-range facing, every one of which the two
    // formulations would have answered differently. Those take the original path.
    const bool facingWrapped = (facing >= -PI && facing <= PI);
    const double cosFacing = std::cos(facing);
    const double sinFacing = std::sin(facing);

    for (auto& o : engine.state.players) {
        if (o.id == p.id || o.sentOff) continue;
        // Cheap pre-reject before the sqrt: an axis gap beyond RANGE + 0.5 puts
        // the true distance past RANGE by ~0.5px, dwarfing sqrt rounding (~1e-13
        // at these magnitudes), so the `d > RANGE` skip below fires regardless —
        // the 0.5 slack is what makes the shortcut provably decision-identical.
        // Most of the 21 candidates on a 1050x680 pitch fail this box.
        if (std::abs(o.x - p.x) > PLAYER_AWARE_RANGE + 0.5
            || std::abs(o.y - p.y) > PLAYER_AWARE_RANGE + 0.5) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d > PLAYER_AWARE_RANGE) continue;

        bool inCone = false;
        if (d < PERCEPTION_NEAR_BALL) {
            inCone = true;
        } else {
            // d is in [PERCEPTION_NEAR_BALL, PLAYER_AWARE_RANGE] here, so the
            // divide is never degenerate.
            bool decided = false;
            if (facingWrapped) {
                double cosNd = ((o.x - p.x) * cosFacing + (o.y - p.y) * sinFacing) / d;
                if (cosNd > coneCosIn)       { inCone = true;  decided = true; }
                else if (cosNd < coneCosOut) { inCone = false; decided = true; }
            }
            if (!decided) {
                double angleTo = std::atan2(o.y - p.y, o.x - p.x);
                double diff = std::abs(angleTo - facing);
                double nd = (diff > PI) ? 2.0 * PI - diff : diff;
                inCone = nd < coneLimit;
            }
        }
        if (!inCone) continue;

        if (o.team == p.team) {
            per.nearbyTeammates.push_back(&o);
        } else {
            per.nearbyOpponents.push_back(&o);
            if (d < per.nearestOpponentDist) per.nearestOpponentDist = d;
            if (d < PERCEPTION_PRESSURE_DIST) pc++;
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
        if (o.id == p.id || o.role == Role::GK || o.sentOff) continue;
        // Pre-reject before the sqrt: an axis gap of bd + 0.5 puts o's true
        // ball distance past bd by ~0.5px — far beyond fp rounding — so both
        // `d < bd` tests below are false regardless and o contributes nothing.
        if (std::abs(o.x - b.x) >= bd + 0.5 || std::abs(o.y - b.y) >= bd + 0.5) continue;
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

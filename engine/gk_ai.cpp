#include "engine.h"
#include "gk_ai.h"

void GKPlayerAI::tick(double sdt) {
    auto& b = engine.state.ball;
    if (b.controllerId == player.id && engine.goalKickMonitor.distributeTimer <= 0) {
        engine.releaseGoalkeeperDistribution(player);
    }
}

// ── GK virtual hooks: smarter behavior based on keeper attributes ──

double GKPlayerAI::rushAggression() const {
    // Good positioning + speed = keeper who reads the game and rushes out confidently
    return attrFactor(player.attrs.positioning) * 0.6 + attrFactor(player.attrs.speed) * 0.4;
}

double GKPlayerAI::catchThreshold() const {
    return GK_CATCH_HANDLING_BASE + attrFactor(player.attrs.positioning) * GK_CATCH_HANDLING_WEIGHT;
}

double GKPlayerAI::sweepDepth() const {
    return 18.0 + attrFactor(player.attrs.speed) * 55.0 + attrFactor(player.attrs.positioning) * 30.0;
}

bool GKPlayerAI::canUseHands() const {
    double goalX = ownGoalXFor(player.team);
    if (std::abs(player.x - goalX) >= PENALTY_AREA_W
        || std::abs(player.y - PITCH_H / 2.0) >= PENALTY_AREA_H / 2.0)
        return false;
    // Law 12: a keeper may NOT handle a ball deliberately KICKED back to him by a teammate — he
    // must play it with his FEET (which makes the back-pass PRESSABLE: the modern high-press loop).
    // A deliberate pass sets intendedReceiverId to me + my team made the last touch; a HEADED/chested
    // back-pass never targets a receiver, so it stays legal to catch. An opponent touch flips
    // lastTouchTeam, clearing the restriction. (controllerId<0 = still in flight, not yet collected.)
    const auto& b = engine.state.ball;
    if (b.controllerId < 0 && b.intendedReceiverId == player.id && b.lastTouchTeam == player.team)
        return false;
    return true;
}

double GKPlayerAI::punchPower() const {
    // Stronger keepers punch further; speed helps with explosive fist clearances
    return 0.85 + attrFactor(player.attrs.speed) * 0.55 + attrFactor(player.attrs.positioning) * 0.35;
}

bool GKPlayerAI::shouldRushOut(double threatDist, double ballSpeed, bool throughBall) const {
    if (threatDist > GK_RUSH_DIST + 10.0) return false;
    if (!throughBall && ballSpeed < GK_SAVE_MIN_BALL_SPEED + 20.0) return false;
    double confidence = attrFactor(player.attrs.positioning) * 0.5 + attrFactor(player.attrs.speed) * 0.5;
    double threshold = throughBall ? 0.22 : 0.38;
    return confidence > threshold;
}

double GKPlayerAI::rushOutSpeed() const {
    return attrFactor(player.attrs.speed) * MAX_PLAYER_SPEED * 0.45;
}

#include "engine.h"
#include "gk_ai.h"

void GKPlayerAI::tick(double sdt) {
    auto& b = engine.state.ball;
    if (b.controllerId == player.id && engine.gkDistributeTimer <= 0) {
        engine.releaseGoalkeeperDistribution(player);
    }
}

// ── GK virtual hooks: smarter behavior based on keeper attributes ──

double GKPlayerAI::rushAggression() const {
    // Good positioning + speed = keeper who reads the game and rushes out confidently
    return attrFactor(player.attrs.positioning) * 0.6 + attrFactor(player.attrs.speed) * 0.4;
}

double GKPlayerAI::catchThreshold() const {
    return 0.22 + attrFactor(player.attrs.positioning) * 0.38;
}

double GKPlayerAI::sweepDepth() const {
    return 18.0 + attrFactor(player.attrs.speed) * 55.0 + attrFactor(player.attrs.positioning) * 30.0;
}

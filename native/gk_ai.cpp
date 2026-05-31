#include "engine.h"
#include "gk_ai.h"

void GKPlayerAI::tick(double sdt) {
    // GK doesn't use the outfield decision loop (ev/rc/ex).
    // Positioning and save logic are handled by engine methods
    // (updateGK, tryGKSave) called from fixedUpdate.
    // This tick handles GK distribution after a save.
    auto& b = engine.state.ball;
    if (b.controllerId == player.id && engine.gkDistributeTimer <= 0) {
        engine.releaseGoalkeeperDistribution(player);
    }
}

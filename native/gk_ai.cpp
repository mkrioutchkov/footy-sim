#include "engine.h"
#include "gk_ai.h"

void GKPlayerAI::tick(double sdt) {
    // GK doesn't use the outfield decision loop (ev/rc/ex).
    // Positioning and save logic are handled by engine methods
    // (updateGK, tryGKSave) called from fixedUpdate.
    // This tick handles GK distribution after a save.
    auto& b = engine.state.ball;
    if (b.controllerId == player.id && engine.gkDistributeTimer <= 0) {
        // Find nearest teammate to distribute to
        Player* best = nullptr;
        double bestD = 1e9;
        for (auto& p : engine.state.players) {
            if (p.team != player.team || p.id == player.id || p.role == "GK") continue;
            double d = dist(player.x, player.y, p.x, p.y);
            if (d < bestD) { bestD = d; best = &p; }
        }
        if (best) {
            engine.passBallTo(player, *best);
            engine.gkDistributeTimer = 400;
        }
    }
}

#include "engine.h"
#include "role_ai.h"

void CFPlayerAI::adjustActionScores(std::vector<Action>& actions, bool isController) {
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Shoot) a.score += 0.13;
    }
}

void WMPlayerAI::adjustActionScores(std::vector<Action>& actions, bool isController) {
    if (!isController) return;
    int pc = 0;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble && a.score > 0.25) a.score += 0.05;
    }
    // Unpressured: hold ball wide
    if (player.role == Role::WM) {
        // This is already handled by the base evaluateActions pressure logic
    }
}

void CMPlayerAI::adjustActionScores(std::vector<Action>& actions, bool isController) {
    if (!isController) return;
    // CM: drive into space when no obvious pass
    Action* bestDribble = nullptr;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) {
            if (!bestDribble || a.score > bestDribble->score) bestDribble = &a;
        }
    }
    if (bestDribble && bestDribble->score > 0.25) bestDribble->score += 0.08;
}

void CBPlayerAI::adjustActionScores(std::vector<Action>& actions, bool /*isController*/) {
    // CB: prioritize tackles when defending
    for (auto& a : actions) {
        if (a.type == ActionType::Tackle) a.score += 0.05;
    }
}

void FBPlayerAI::adjustActionScores(std::vector<Action>& /*actions*/, bool /*isController*/) {
    // FB: balanced defender — no strong bias
}

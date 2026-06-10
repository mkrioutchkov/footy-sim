#include "engine.h"
#include "role_ai.h"

void CFPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Shoot) a.score += 0.18;
    }
}

void WMPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble && a.score > 0.25) a.score += 0.05;
    }
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.12;
        if (a.type == ActionType::Pass)   a.score += 0.04;
    }
}

void CMPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    if (!isController) return;
    Action* bestDribble = nullptr;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) {
            if (!bestDribble || a.score > bestDribble->score) bestDribble = &a;
        }
    }
    if (bestDribble && bestDribble->score > 0.25) bestDribble->score += 0.08;
    for (auto& a : actions) {
        if (a.type == ActionType::Dribble) a.score += 0.08;
        if (a.type == ActionType::Pass)   a.score += 0.02;
    }
}

void CBPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
    for (auto& a : actions) {
        if (a.type == ActionType::Tackle) a.score += 0.05;
    }
}

void FBPlayerAI::adjustActionScores(SmallVector<Action, 24>& actions, bool isController) {
    PlayerAI::adjustActionScores(actions, isController);
}

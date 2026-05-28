#pragma once
#include "agent.h"

class GKPlayerAI : public PlayerAI {
public:
    GKPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void tick(double sdt) override;
};

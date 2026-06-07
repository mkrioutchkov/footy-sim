#pragma once
#include "agent.h"

class GKPlayerAI : public PlayerAI {
public:
    GKPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void tick(double sdt) override;

    // ── GK-specific virtual hooks ──
    // How aggressively the GK rushes off the line (0.0 = stay, 1.0 = full rush)
    virtual double rushAggression() const;
    // Catch threshold: above this save chance, GK tries to catch; below, parries
    virtual double catchThreshold() const;
    // How far out the GK sweeps when ball is behind the defense
    virtual double sweepDepth() const;
};

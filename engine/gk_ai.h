#pragma once
#include "agent.h"

class GKPlayerAI : public PlayerAI {
public:
    GKPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void tick(double sdt) override;

    // ── GK-specific virtual hooks ──
    virtual double rushAggression() const;
    virtual double catchThreshold() const;
    virtual double sweepDepth() const;

    // Can the GK legally handle the ball? (within own penalty area only)
    virtual bool canUseHands() const;
    // How powerfully the GK punches/fists the ball away (multiplier on parry speed)
    virtual double punchPower() const;
    // Should the GK rush out to challenge a through ball / breakaway?
    virtual bool shouldRushOut(double threatDist, double ballSpeed, bool throughBall) const;
    // Extra speed multiplier when rushing out
    virtual double rushOutSpeed() const;
};

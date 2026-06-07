#pragma once
#include "agent.h"

class CFPlayerAI : public PlayerAI {
public:
    CFPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.72; }
    double shotMaxDistance() const override { return 265.0; }
    double freshCrossMaxDistance() const override { return 285.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return -0.15; }
};

class WMPlayerAI : public PlayerAI {
public:
    WMPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.36; }
    double shotMaxDistance() const override { return 240.0; }
    double freshCrossMaxDistance() const override { return 270.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return -0.04; }
};

class CMPlayerAI : public PlayerAI {
public:
    CMPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.00; }
    double shotMaxDistance() const override { return 245.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return 0.06; }
};

class CBPlayerAI : public PlayerAI {
public:
    CBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double shotMaxDistance() const override { return 180.0; }
    double tackleBaseScore() const override { return 0.68; }
    double tackleRoleAdjust() const override { return 0.0; }
};

class FBPlayerAI : public PlayerAI {
public:
    FBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double shotMaxDistance() const override { return 205.0; }
    double tackleBaseScore() const override { return 0.50; }
    double tackleRoleAdjust() const override { return 0.0; }
};

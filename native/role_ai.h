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
    double shotScoreBonus() const override { return 0.20; }
    double freshCrossShotBonus() const override { return 0.62; }
    double finalThirdShotMaxDistance() const override { return 210.0; }
    double nearGoalDribbleBonus(bool nearGoal, double distToGoal) const override { return nearGoal ? (distToGoal < 120.0 ? 0.12 : 0.18) : 0.0; }
    bool   isAttackerRole() const override { return true; }
    double nearGoalShotBiasMargin() const override { return 0.16; }
    double observingCruiseMul() const override { return 0.45; }
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
    double finalThirdShotMaxDistance() const override { return 175.0; }
    double dribbleOwnHalfExtraPenalty() const override { return 0.0; }
    bool   isAttackerRole() const override { return true; }
    bool   canUseWideDribble() const override { return true; }
    double observingCruiseMul() const override { return 0.55; }
};

class CMPlayerAI : public PlayerAI {
public:
    CMPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.00; }
    double shotMaxDistance() const override { return 245.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return 0.06; }
    double shotDistancePenalty(double shotDistance) const override { return shotDistance > 110.0 ? -0.12 : -0.07; }
    double finalThirdShotMinAngle() const override { return 10.0; }
    double openSpaceDribbleBonus(double nearestOppDist) const override { return nearestOppDist > 80.0 ? 0.08 : 0.0; }
    bool   canUseFlankTargets() const override { return true; }
    bool   canUseOpenLane() const override { return true; }
    double openLaneDribbleBonus() const override { return 0.18; }
    double openLaneDribbleDistance() const override { return 165.0; }
    bool   shouldSearchForPassOverShot() const override { return true; }
    bool   isDefenderLike() const override { return true; }
    double observingCruiseMul() const override { return 0.50; }
};

class CBPlayerAI : public PlayerAI {
public:
    CBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double shotMaxDistance() const override { return 180.0; }
    double tackleBaseScore() const override { return 0.68; }
    double tackleRoleAdjust() const override { return 0.0; }
    bool   isDefenderRole() const override { return true; }
    bool   isDefenderLike() const override { return true; }
    double observingCruiseMul() const override { return 0.65; }
};

class FBPlayerAI : public PlayerAI {
public:
    FBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(std::vector<Action>& actions, bool isController) override;
    double shotMaxDistance() const override { return 205.0; }
    double tackleBaseScore() const override { return 0.50; }
    double tackleRoleAdjust() const override { return 0.0; }
    bool   canUseFlankTargets() const override { return true; }
    bool   canUseOpenLane() const override { return true; }
    double openLaneDribbleBonus() const override { return 0.12; }
    double openLaneDribbleDistance() const override { return 135.0; }
    bool   isDefenderRole() const override { return true; }
    bool   isDefenderLike() const override { return true; }
    double observingCruiseMul() const override { return 0.65; }
};

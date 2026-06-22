#pragma once
#include "agent.h"

class CFPlayerAI : public PlayerAI {
public:
    CFPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 24>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.72; }
    double shotMaxDistance() const override { return 225.0; }
    double shotRoleError(bool, double) const override { return -42.0; }
    double freshCrossMaxDistance() const override { return 285.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return -0.15; }
    double shotScoreBonus() const override { return 0.20; }
    double freshCrossShotBonus() const override { return 0.62; }
    double finalThirdShotMaxDistance() const override { return 210.0; }
    double nearGoalDribbleBonus(bool nearGoal, double distToGoal) const override { return nearGoal ? (distToGoal < 120.0 ? 0.12 : 0.18) : 0.0; }
    bool   isAttackerRole() const override { return true; }
    bool   isCenterForward() const override { return true; }
    double nearGoalShotBiasMargin() const override { return 0.22; }
    double observingCruiseMul() const override { return 0.45; }
    double defensivePressCost(bool danger) const override { (void)danger; return 28.0; }
    double boxGuardCost() const override { return 28.0; }
    double penaltyTakerBonus() const override { return 90.0; }
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 340.0 : 270.0); }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        if (defender.isCenterBack()) return -35.0;
        if (danger && defender.isDefenderLike() && !defender.isDefenderRole()) return -53.0;
        if (defender.isFullBack()) return 0.0;
        return 1e9;
    }
};

class WMPlayerAI : public PlayerAI {
public:
    WMPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 24>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.36; }
    double shotMaxDistance() const override { return 215.0; }
    double shotRoleError(bool freshCross, double) const override { return freshCross ? -8.0 : 0.0; }
    double spaceCarryRoleBonus() const override { return 0.18; }
    double freshCrossMaxDistance() const override { return 270.0; }
    double tackleBaseScore() const override { return 0.60; }
    double tackleRoleAdjust() const override { return -0.04; }
    double finalThirdShotMaxDistance() const override { return 175.0; }
    double dribbleOwnHalfExtraPenalty() const override { return 0.0; }
    bool   isAttackerRole() const override { return true; }
    bool   isWideMidfielder() const override { return true; }
    bool   canUseWideDribble() const override { return true; }
    double observingCruiseMul() const override { return 0.55; }
    double defensivePressCost(bool danger) const override { (void)danger; return 6.0; }
    double crossLaneCost() const override { return 18.0; }
    double penaltyTakerBonus() const override { return 25.0; }
    bool   isOffensiveThreat(double depth, bool danger, double yDistFromCenter) const override { return depth < (danger ? 285.0 : 220.0) && yDistFromCenter < (danger ? 245.0 : 200.0); }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        (void)danger;
        if (defender.isFullBack()) return -35.0;
        if (defender.isCenterBack()) return 0.0;
        return 1e9;
    }
};

class CMPlayerAI : public PlayerAI {
public:
    CMPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 24>& actions, bool isController) override;
    double roleBonusForPassTarget() const override { return 0.00; }
    double shotMaxDistance() const override { return 220.0; }
    double shotRoleError(bool freshCross, double shotDistance) const override { return freshCross ? 58.0 : (shotDistance > 130.0 ? 30.0 : 0.0); }
    double spaceCarryRoleBonus() const override { return 0.18; }
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
    bool   isCentralMidfielder() const override { return true; }
    double observingCruiseMul() const override { return 0.50; }
    double defensivePressCost(bool danger) const override { (void)danger; return 0.0; }
    double shotLaneCost() const override { return 0.0; }
    double crossLaneCost() const override { return 10.0; }
    double boxGuardCost() const override { return 18.0; }
    double cutbackGuardCost() const override { return 0.0; }
    double penaltyTakerBonus() const override { return 45.0; }
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 230.0 : 190.0); }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        if (danger && defender.isDefenderLike() && !defender.isDefenderRole()) return -35.0;
        if (defender.isCenterBack() || defender.isFullBack()) return 0.0;
        return 1e9;
    }
};

class CBPlayerAI : public PlayerAI {
public:
    CBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 24>& actions, bool isController) override;
    double shotMaxDistance() const override { return 180.0; }
    double tackleBaseScore() const override { return 0.68; }
    double tackleRoleAdjust() const override { return 0.0; }
    double tackleDistCoeff() const override { return 0.35; }
    double tackleSkillCoeff() const override { return 0.22; }
    bool   isDefenderRole() const override { return true; }
    bool   isDefenderLike() const override { return true; }
    bool   isCenterBack() const override { return true; }
    double observingCruiseMul() const override { return 0.65; }
    double defensivePressCost(bool danger) const override { return danger ? 8.0 : 120.0; }
    double shotLaneCost() const override { return 34.0; }
    double crossLaneCost() const override { return 38.0; }
    double boxGuardCost() const override { return 0.0; }
    double cutbackGuardCost() const override { return 32.0; }
    double defensiveLineOffsetX(bool danger, double lineProgress) const override { return danger ? 92.0 : lineProgress; }
};

class FBPlayerAI : public PlayerAI {
public:
    FBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 24>& actions, bool isController) override;
    double shotMaxDistance() const override { return 205.0; }
    double spaceCarryRoleBonus() const override { return 0.12; }
    double tackleBaseScore() const override { return 0.50; }
    double tackleRoleAdjust() const override { return 0.0; }
    double tackleDistCoeff() const override { return 0.35; }
    double tackleSkillCoeff() const override { return 0.18; }
    bool   canUseFlankTargets() const override { return true; }
    bool   canUseOpenLane() const override { return true; }
    double openLaneDribbleBonus() const override { return 0.12; }
    double openLaneDribbleDistance() const override { return 135.0; }
    bool   isDefenderRole() const override { return true; }
    bool   isDefenderLike() const override { return true; }
    bool   isFullBack() const override { return true; }
    double observingCruiseMul() const override { return 0.65; }
    double defensivePressCost(bool danger) const override { return danger ? 14.0 : 58.0; }
    double shotLaneCost() const override { return 12.0; }
    double crossLaneCost() const override { return 0.0; }
    double boxGuardCost() const override { return 28.0; }
    double cutbackGuardCost() const override { return 18.0; }
    double defensiveLineOffsetX(bool danger, double lineProgress) const override { return danger ? 104.0 : lineProgress + 8.0; }
    double defensiveLineTargetY(double homeY, double, double carrierY) const override { return lerp(homeY, carrierY, 0.20); }
    DefensiveTask defensiveLineRoleTask() const override { return DefensiveTask::WideCover; }
    // An OVERLAPPING fullback was the one off-ball runner the defense never
    // picked up (base isOffensiveThreat=false, base markerRoleBonus=1e9 = no
    // marker). Detect him (wide by definition, no lateral gate) and let our own
    // FB track him, with a CM/CB as fallback.
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 250.0 : 200.0); }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        (void)danger;
        if (defender.isFullBack()) return -35.0;
        if (defender.isCenterBack() || defender.isCentralMidfielder()) return 0.0;
        return 1e9;
    }
};

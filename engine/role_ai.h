#pragma once
#include "agent.h"

// Per-role AI subclasses. Numbers live in role_profile.h (RoleProfile TABLE);
// what remains here is genuine per-role *behaviour* — the scoring overlay
// (adjustActionScores) and the hooks with real logic (shot placement error,
// off-ball threat/marking, chase-abandon zones, defensive-line shaping).

class CFPlayerAI : public PlayerAI {
public:
    CFPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 48>& actions, bool isController) override;
    double shotRoleError(bool, double) const override { return -42.0; }
    double nearGoalDribbleBonus(bool nearGoal, double distToGoal) const override { return nearGoal ? (distToGoal < 120.0 ? 0.12 : 0.18) : 0.0; }
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 340.0 : 270.0); }
    bool   abandonsDistantChase(const Perception& per, const Ball& b) const override {
        if (per.ballDist <= 80.0) return false;
        return std::abs(b.x - goalXFor(player.team)) >= 200.0;   // ball not near the opp goal
    }
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
    void adjustActionScores(SmallVector<Action, 48>& actions, bool isController) override;
    double shotRoleError(bool freshCross, double) const override { return freshCross ? -8.0 : 0.0; }
    bool   isOffensiveThreat(double depth, bool danger, double yDistFromCenter) const override { return depth < (danger ? 285.0 : 220.0) && yDistFromCenter < (danger ? 245.0 : 200.0); }
    bool   abandonsDistantChase(const Perception& per, const Ball& b) const override {
        if (per.ballDist <= 80.0) return false;
        bool onMyFlank = (player.homeY < PITCH_H / 2.0) ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
        return !onMyFlank;
    }
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
    void adjustActionScores(SmallVector<Action, 48>& actions, bool isController) override;
    double shotRoleError(bool freshCross, double shotDistance) const override { return freshCross ? 58.0 : (shotDistance > 130.0 ? 30.0 : 0.0); }
    double shotDistancePenalty(double shotDistance) const override { return shotDistance > 110.0 ? -0.12 : -0.07; }
    double openSpaceDribbleBonus(double nearestOppDist) const override { return nearestOppDist > 80.0 ? 0.08 : 0.0; }
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 230.0 : 190.0); }
    bool   abandonsDistantChase(const Perception& per, const Ball& b) const override {
        if (per.ballDist <= 100.0) return false;
        bool ballInMiddle = b.x > PITCH_W * 0.25 && b.x < PITCH_W * 0.75;
        return !ballInMiddle;
    }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        if (danger && defender.isDefenderLike() && !defender.isDefenderRole()) return -35.0;
        if (defender.isCenterBack() || defender.isFullBack()) return 0.0;
        return 1e9;
    }
};

class CBPlayerAI : public PlayerAI {
public:
    CBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 48>& actions, bool isController) override;
    double defensiveLineOffsetX(bool danger, double lineProgress) const override { return danger ? 92.0 : lineProgress; }
    bool   abandonsDistantChase(const Perception& per, const Ball& b) const override {
        if (per.ballDist <= 120.0) return false;
        bool ballInOwnHalf = (player.team == Team::Home) ? b.x < PITCH_W * 0.6 : b.x > PITCH_W * 0.4;
        return !ballInOwnHalf;
    }
};

class FBPlayerAI : public PlayerAI {
public:
    FBPlayerAI(Player& p, GameEngine& e) : PlayerAI(p, e) {}
    void adjustActionScores(SmallVector<Action, 48>& actions, bool isController) override;
    double defensiveLineOffsetX(bool danger, double lineProgress) const override { return danger ? 104.0 : lineProgress + 8.0; }
    double defensiveLineTargetY(double homeY, double, double carrierY) const override { return lerp(homeY, carrierY, 0.20); }
    // An OVERLAPPING fullback was the one off-ball runner the defense never
    // picked up (base isOffensiveThreat=false, base markerRoleBonus=1e9 = no
    // marker). Detect him (wide by definition, no lateral gate) and let our own
    // FB track him, with a CM/CB as fallback.
    bool   isOffensiveThreat(double depth, bool danger, double) const override { return depth < (danger ? 250.0 : 200.0); }
    bool   abandonsDistantChase(const Perception& per, const Ball& b) const override {
        if (per.ballDist <= 100.0) return false;
        bool onMyFlank = (player.homeY < PITCH_H / 2.0) ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
        return !onMyFlank;
    }
    double markerRoleBonus(const PlayerAI& defender, bool danger) const override {
        (void)danger;
        if (defender.isFullBack()) return -35.0;
        if (defender.isCenterBack() || defender.isCentralMidfielder()) return 0.0;
        return 1e9;
    }
};

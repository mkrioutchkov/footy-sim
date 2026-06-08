#pragma once

#include "types.h"
#include "constants.h"
#include "rng.h"
#include <vector>
#include <string>
#include <cmath>
#include <optional>

// ── Forward declare GameEngine ────────────────────────────────────────────────
class GameEngine;

// ── Shared helpers ───────────────────────────────────────────────────────────
struct CarrierPressure {
    int count = 0;
    double nearest = 1e9;
    double exposed = 0.0;
    double goalSide = 0.0;
    double score = 0.0;
    Player* nearestPlayer = nullptr;
};
CarrierPressure assessCarrierPressure(GameEngine& engine, const Player& p);

// ══════════════════════════════════════════════════════════════════════════════
// Agent-internal types (mirror TS interfaces from agent.ts)
// ══════════════════════════════════════════════════════════════════════════════

struct ActionAudit {
    double distance         = 0;
    double forwardProgress  = 0;
    double expectedCompletion = 0;
    int    blockers         = 0;
    int    receiverPressure = 0;
    double angleDeg         = 0;
    int    pressureCount    = 0;
};

struct Action {
    ActionType  type    = ActionType::Hold;
    double      score   = 0;
    Player*     target  = nullptr;
    double      posX    = 0;
    double      posY    = 0;
    ActionPurpose purpose = ActionPurpose::Keep;
    ActionAudit audit;
};

struct GameContext {
    int    scoreDiff = 0;
    double timeLeft  = 0;
    int    half      = 1;
};

struct Perception {
    double              ballDist      = 0;
    bool                ballIsLoose   = false;
    Team                ballControllerTeam = Team::Home;
    int                 ballControllerId = -1;
    std::vector<Player*> nearbyTeammates;
    std::vector<Player*> nearbyOpponents;
    double              nearestOpponentDist = 1e9;
    bool                iAmController    = false;
    bool                amClosestToBall  = false;
    int                 chasingTeammatesCount = 0;
    bool                anyOpponentCloserToBall = false;
    int                 pressureCount    = 0;
    int                 intendedId       = -1;
};

struct PassSelectionAudit {
    double score              = 0;
    double distance           = 0;
    double forwardProgress    = 0;
    double expectedCompletion = 0;
    int    blockers           = 0;
    int    receiverPressure   = 0;
    ActionPurpose purpose = ActionPurpose::Keep;
    int    saferOptionTargetId   = -1;
    double saferOptionScore      = 0;
    double saferOptionCompletion = 0;
    double saferOptionProgress   = 0;
};

struct ShotSelectionAudit {
    double score          = 0;
    double distance       = 0;
    double angleDeg       = 0;
    int    pressureCount  = 0;
    int    bestPassTargetId   = -1;
    double bestPassScore      = 0;
    double bestPassCompletion = 0;
};

// ══════════════════════════════════════════════════════════════════════════════
// PlayerAgent class
// ══════════════════════════════════════════════════════════════════════════════

class PlayerAI {
public:
    Player&     player;
    GameEngine& engine;

    PlayerAI(Player& p, GameEngine& e)
        : player(p), engine(e)
    {
        facing = (player.team == Team::Home) ? 0.0 : PI;
    }

    virtual ~PlayerAI() = default;
    virtual void tick(double sdt);

    // ── Role/Area virtual hooks ──
    virtual double  roleBonusForPassTarget() const { return 0.0; }
    virtual double  shotMaxDistance() const { return 260.0; }
    virtual double  freshCrossMaxDistance() const { return 250.0; }
    virtual double  tackleBaseScore() const { return 0.60; }
    virtual double  tackleRoleAdjust() const { return 0.0; }
    virtual double  shotScoreBonus() const { return 0.0; }
    virtual double  shotDistancePenalty(double shotDistance) const { (void)shotDistance; return 0.0; }
    virtual double  freshCrossShotBonus() const { return 0.42; }
    virtual double  finalThirdShotMaxDistance() const { return 165.0; }
    virtual double  finalThirdShotMinAngle() const { return 8.0; }
    virtual double  dribbleOwnHalfExtraPenalty() const { return -0.02; }
    virtual double  openSpaceDribbleBonus(double nearestOppDist) const { (void)nearestOppDist; return 0.0; }
    virtual double  nearGoalDribbleBonus(bool nearGoal, double distToGoal) const { (void)nearGoal; (void)distToGoal; return 0.0; }
    virtual bool    isAttackerRole() const { return false; }
    virtual bool    isCenterBack() const { return false; }
    virtual bool    isFullBack() const { return false; }
    virtual bool    isCentralMidfielder() const { return false; }
    virtual bool    isWideMidfielder() const { return false; }
    virtual bool    isCenterForward() const { return false; }
    virtual double  nearGoalShotBiasMargin() const { return -1.0; }
    virtual bool    canUseFlankTargets() const { return false; }
    virtual bool    canUseOpenLane() const { return false; }
    virtual double  openLaneDribbleBonus() const { return 0.0; }
    virtual double  openLaneDribbleDistance() const { return 0.0; }
    virtual bool    canUseWideDribble() const { return false; }
    virtual bool    shouldSearchForPassOverShot() const { return false; }
    virtual bool    isDefenderRole() const { return false; }
    virtual bool    isDefenderLike() const { return false; }
    virtual double  observingCruiseMul() const { return 0.50; }
    virtual double  defensivePressCost(bool danger) const { (void)danger; return 14.0; }
    virtual double  shotLaneCost() const { return 34.0; }
    virtual double  crossLaneCost() const { return 38.0; }
    virtual double  boxGuardCost() const { return 28.0; }
    virtual double  cutbackGuardCost() const { return 32.0; }
    virtual double  defensiveLineOffsetX(bool danger, double lineProgress) const { (void)danger; return lineProgress; }
    virtual double  defensiveLineTargetY(double homeY, double pitchCenterY, double carrierY) const { (void)carrierY; return lerp(homeY, pitchCenterY, 0.08); }
    virtual DefensiveTask defensiveLineRoleTask() const { return DefensiveTask::DefensiveLine; }
    virtual double  penaltyTakerBonus() const { return 0.0; }
    virtual double  catchThreshold() const { return 0.22; }
    virtual double  rushAggression() const { return 0.0; }
    virtual double  sweepDepth() const { return 0.0; }
    virtual bool    canUseHands() const { return false; }
    virtual double  punchPower() const { return 0.0; }
    virtual bool    shouldRushOut(double, double, bool) const { return false; }
    virtual double  rushOutSpeed() const { return 0.0; }
    virtual bool    isOffensiveThreat(double depth, bool danger, double yDistFromCenter) const { (void)depth; (void)danger; (void)yDistFromCenter; return false; }
    virtual double  markerRoleBonus(const PlayerAI& defender, bool danger) const { (void)defender; (void)danger; return 1e9; }
    virtual PitchArea currentPitchArea() const;
    double dizzyRotationAccum = 0;
    double dizzyWindowStartMs = 0;

private:
    int    stunLockTicks = 0;
    int    shotCooldown = 0;
    int    perceptionAge = 0;
    std::optional<Perception> cachedPerception;

    int    holdTicks = 0;
    double lastPosX = 0, lastPosY = 0;

    ActionType lastActionType = ActionType::Hold;
    ActionPurpose lastPurpose = ActionPurpose::Keep;
    int    lastTargetId = -1;
    int    lastPassTargetId = -1;

    double facing = 0;

    int    recentPassTarget = -1;
    double recentPassTime   = 0;

    double ballMemoryX   = 0;
    double ballMemoryY   = 0;
    int    ballMemoryAge = 0;

    GameContext           buildContext();
    std::vector<Action>   evaluateActions(const Perception& per, bool isController, const GameContext& ctx);
    std::vector<Action>   scorePass(const Perception& per, const GameContext& ctx);
    virtual Action        scoreShot(const Perception& per, const GameContext& ctx);
    virtual Action        scoreDribble(const Perception& per, const GameContext& ctx);
    virtual Action        scoreTackle(const Perception& per, const GameContext& ctx);
    Action                scoreMark(const Perception& per, const GameContext& ctx);
    Action                scoreChase(const Perception& per);
    virtual std::vector<Action> scorePositioning(const Perception& per, const GameContext& ctx);
protected:
    virtual void          adjustActionScores(std::vector<Action>& actions, bool isController);
    Action                resolveChoice(std::vector<Action>& actions);

    // resolveChoice() pipeline helpers — each returns nullptr to continue, or a chosen action
    Action* tryFreshBallOverride(std::vector<Action>& a, Action& best, bool ic, bool nearGoal);
    Action* tryLowScoreFallback(std::vector<Action>& a, Action& best);
    Action* tryLongCarryOverride(std::vector<Action>& a, Action& best, bool ic);
    Action* managePressSlots(std::vector<Action>& a, Action& best, TeamBlackboard& bb);
    void    auditBackpass(std::vector<Action>& a, Action& best, bool ic);
    Action* tryClearPathOverride(std::vector<Action>& a, Action& best, bool ic, double gx);
    Action* tryPressureSafetyPass(std::vector<Action>& a, Action& best, bool ic, bool nearGoal);
    Action* tryFinalThirdOverride(std::vector<Action>& a, Action& best, bool ic);
    Action* tryNearGoalShotBias(std::vector<Action>& a, Action& best, bool ic, bool nearGoal, double gx);
private:
    void                  executeAction(Action& action, double sdt, std::vector<Action>& actions);
    Perception            getCachedPerception();
    Perception            perceive();
    void                  applyMovement(double sdt);
    void                  tryCollectAfterChase();
    void                  auditDefensiveMovement(const Action& choice);
    PassSelectionAudit    passSelectionAudit(const Action& choice, const std::vector<Action>& actions);
    ShotSelectionAudit    shotSelectionAudit(const Action& choice, const std::vector<Action>& actions);
public:
    virtual void          setPiecePositioning(SetPiece spType, Team spTeam);
    void                  stunLock(int ticks) { stunLockTicks = std::max(stunLockTicks, ticks); }
    bool                  setPieceHold = false;
};

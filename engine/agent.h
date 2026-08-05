#pragma once

#include "types.h"
#include "constants.h"
#include "role_traits.h"
#include "role_profile.h"
#include "rng.h"
#include <vector>
#include "small_vector.h"
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

struct Perception {
    double              ballDist      = 0;
    bool                ballIsLoose   = false;
    Team                ballControllerTeam = Team::Home;
    int                 ballControllerId = -1;
    SmallVector<Player*, 11> nearbyTeammates;
    SmallVector<Player*, 11> nearbyOpponents;
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
    // Pure-constant knobs read from the role's RoleProfile row (role_profile.h);
    // the data lives in that one table, not in six subclass overrides.
    virtual double  roleBonusForPassTarget() const { return profileFor(player.role).roleBonusForPassTarget; }
    virtual double  shotMaxDistance() const { return profileFor(player.role).shotMaxDistance; }
    virtual double  freshCrossMaxDistance() const { return profileFor(player.role).freshCrossMaxDistance; }
    virtual double  tackleBaseScore() const { return profileFor(player.role).tackleBaseScore; }
    virtual double  tackleRoleAdjust() const { return profileFor(player.role).tackleRoleAdjust; }
    // Distance/skill weights in the tackle score (scoreTackle). Defenders commit on
    // a flatter distance curve and full-backs/centre-backs weight tackling skill
    // differently — was a role if/else that recomputed the whole score.
    virtual double  tackleDistCoeff() const { return profileFor(player.role).tackleDistCoeff; }
    virtual double  tackleSkillCoeff() const { return profileFor(player.role).tackleSkillCoeff; }
    virtual double  shotScoreBonus() const { return profileFor(player.role).shotScoreBonus; }
    virtual double  shotDistancePenalty(double shotDistance) const { (void)shotDistance; return 0.0; }
    // Per-role placement-error offset added to the open-play shot spread — was a
    // role ternary in the shot path (CF tucks it tighter, CM sprays from range).
    virtual double  shotRoleError(bool freshCross, double shotDistance) const { (void)freshCross; (void)shotDistance; return 0.0; }
    virtual double  finalThirdShotMaxDistance() const { return profileFor(player.role).finalThirdShotMaxDistance; }
    virtual double  finalThirdShotMinAngle() const { return profileFor(player.role).finalThirdShotMinAngle; }
    virtual double  dribbleOwnHalfExtraPenalty() const { return profileFor(player.role).dribbleOwnHalfExtraPenalty; }
    virtual double  openSpaceDribbleBonus(double nearestOppDist) const { (void)nearestOppDist; return 0.0; }
    virtual double  nearGoalDribbleBonus(bool nearGoal, double distToGoal) const { (void)nearGoal; (void)distToGoal; return 0.0; }
    // Bonus for a dribble-into-space carry from the launch zone — was a role ternary
    // in scoreActions (WM/CM most, FB next, rest least). Role-arch migration.
    virtual double  spaceCarryRoleBonus() const { return profileFor(player.role).spaceCarryRoleBonus; }
    // Shoot-scorer per-role scalars (were role branches in scoreShoot). Role-arch.
    virtual double  centralShootBonus() const { return profileFor(player.role).centralShootBonus; }
    virtual double  wideShootPenalty() const { return profileFor(player.role).wideShootPenalty; }
    virtual double  closeRangeShootBonus() const { return profileFor(player.role).closeRangeShootBonus; }
    // Role predicates delegate to the role_traits.h taxonomy keyed on player.role,
    // so the role→trait map has ONE definition (see role_traits.h). Kept virtual for
    // the interface; the per-role subclasses no longer need to override these.
    virtual bool    isAttackerRole() const { return roles::isAttacker(player.role); }
    virtual bool    isCenterBack() const { return roles::isCenterBack(player.role); }
    virtual bool    isFullBack() const { return roles::isFullBack(player.role); }
    virtual bool    isWidePlayer() const { return roles::isWide(player.role); }   // winger or full-back (wide-channel)
    virtual bool    isGoalkeeper() const { return roles::isGoalkeeper(player.role); }
    virtual bool    isCentralMidfielder() const { return roles::isCentralMidfielder(player.role); }
    virtual bool    isWideMidfielder() const { return roles::isWideMidfielder(player.role); }
    virtual bool    isCenterForward() const { return roles::isCenterForward(player.role); }
    virtual double  nearGoalShotBiasMargin() const { return profileFor(player.role).nearGoalShotBiasMargin; }
    virtual bool    canUseFlankTargets() const { return profileFor(player.role).canUseFlankTargets; }
    virtual bool    canUseOpenLane() const { return profileFor(player.role).canUseOpenLane; }
    virtual double  openLaneDribbleBonus() const { return profileFor(player.role).openLaneDribbleBonus; }
    virtual double  openLaneDribbleDistance() const { return profileFor(player.role).openLaneDribbleDistance; }
    virtual bool    canUseWideDribble() const { return profileFor(player.role).canUseWideDribble; }
    virtual bool    shouldSearchForPassOverShot() const { return profileFor(player.role).shouldSearchForPassOverShot; }
    virtual bool    isDefenderRole() const { return roles::isDefenderRole(player.role); }
    virtual bool    isDefenderLike() const { return roles::isDefenderLike(player.role); }
    virtual double  observingCruiseMul() const { return profileFor(player.role).observingCruiseMul; }
    virtual double  defensivePressCost(bool danger) const { return danger ? profileFor(player.role).pressCostDanger : profileFor(player.role).pressCostSafe; }
    virtual double  shotLaneCost() const { return profileFor(player.role).shotLaneCost; }
    virtual double  crossLaneCost() const { return profileFor(player.role).crossLaneCost; }
    virtual double  boxGuardCost() const { return profileFor(player.role).boxGuardCost; }
    virtual double  cutbackGuardCost() const { return profileFor(player.role).cutbackGuardCost; }
    virtual double  defensiveLineOffsetX(bool danger, double lineProgress) const { (void)danger; return lineProgress; }
    virtual double  defensiveLineTargetY(double homeY, double pitchCenterY, double carrierY) const { (void)carrierY; return lerp(homeY, pitchCenterY, 0.08); }
    virtual DefensiveTask defensiveLineRoleTask() const { return profileFor(player.role).defensiveLineRoleTask; }
    // A loose/live ball far away AND outside this role's zone of responsibility
    // isn't worth chasing — hold shape instead (the caller returns Chase 0.0).
    // Each role defines its own trigger distance + zone; GK and the plain base
    // never bail here, so the default keeps its previous "always evaluate the
    // chase" behaviour.
    virtual bool    abandonsDistantChase(const Perception& per, const Ball& b) const { (void)per; (void)b; return false; }
    virtual double  penaltyTakerBonus() const { return profileFor(player.role).penaltyTakerBonus; }
    virtual double  catchThreshold() const { return 0.22; }
    virtual double  rushAggression() const { return 0.0; }
    virtual double  sweepDepth() const { return 0.0; }
    virtual bool    canUseHands() const { return false; }
    virtual double  punchPower() const { return 0.0; }
    virtual bool    shouldRushOut(double, double, bool) const { return false; }
    virtual double  rushOutSpeed() const { return 0.0; }
    virtual bool    isOffensiveThreat(double depth, bool danger, double yDistFromCenter) const { (void)depth; (void)danger; (void)yDistFromCenter; return false; }
    virtual double  markerRoleBonus(const PlayerAI& defender, bool danger) const { (void)defender; (void)danger; return 1e9; }
    double dizzyRotationAccum = 0;
    double dizzyWindowStartMs = 0;

private:
    int    stunLockTicks = 0;
    // Consecutive ticks this AI has CHOSEN Tackle on the same carrier while
    // stuck outside contact — the earned-lunge trigger (see executeAction).
    int    tackleShadowTicks = 0;
    int    tackleShadowCarrierId = -1;
    // Round-28 C4 (trailing-defender shepherd): persistence for the swing-around
    // cut-off. The old velocity-dot gate flickered (hysteresis-free limit cycle
    // ~200ms). Re-keyed on the carrier->own-goal along-axis projection with a
    // release hysteresis + a minimum hold once engaged.
    bool   shepherdEngaged = false;
    int    shepherdCarrierId = -1;
    double shepherdHoldUntilMs = -1e9;
    double shepherdSprintSinceMs = -1e9;   // episode sprint-cap anchor (agent_movement)
    double gaLastFireMs = -1e9;            // grounded-anticipate census latch (agent_defend)
    int    skillMoveCooldown = 0;
    // Round-21 (arena 1v1): take-on state. A carrier being escorted by a single
    // jockeying defender (close, goal-side, small relative velocity) accrues
    // jockeyLockTicks; once sustained he commits to a beat (feint + burst).
    // Mirrors how skillMoveCooldown gates the ambient flourish.
    int    jockeyLockTicks = 0;
    int    jockeyLockDefId = -1;
    int    takeOnCooldown = 0;
    int    ballContestTicks = 0;   // audit #1: ticks glued within TACKLE_RANGE of an opponent carrier's ball
    double evadeSide = 1.0;
    double evadeSideUntilMs = -1e9;
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
    double prevFacingDeltaSigned = 0;   // G2 dizzy-spin: last tick's signed facing change, to damp oscillation (reversals)

    int    recentPassTarget = -1;
    double recentPassTime   = 0;

    double ballMemoryX   = 0;
    double ballMemoryY   = 0;
    int    ballMemoryAge = 0;

    // Movement-target hysteresis: a reversal may only be accepted every
    // ~300ms, so two arguing decision branches can't vibrate a player at 60Hz.
    double commitTargetX  = 0;
    double commitTargetY  = 0;
    double commitUntilMs  = 0;
    // Round-27 COMMIT 2 (tackle jitter): latch the contain-point Y side. The bare
    // sign-flip (containY = carrier.y +/- 16) made a jockeying defender cross the
    // carrier's Y line and jump his target 32px every time noise nudged him past
    // it -> a limit-cycle lateral shuffle. Only flip once past a ~22px deadband.
    int    containSideLatch = 0;   // 0 unset, -1 above carrier, +1 below

    SmallVector<Action, 24> evaluateActions(const Perception& per, bool isController);
    SmallVector<Action, 24> scorePass(const Perception& per);
    virtual Action        scoreShot(const Perception& per);
    virtual Action        scoreDribble(const Perception& per);
    virtual Action        scoreTackle(const Perception& per);
    Action                scoreMark(const Perception& per);
    Action                scoreChase(const Perception& per);
    struct PositionCandidate { double x, y; ActionPurpose pur = ActionPurpose::Keep; };
    struct PositioningContext {
        double fd; bool myTeam; double ballAdvance; double pushUp; double widthPush;
        Team inPossession;
    };
    virtual SmallVector<Action, 24> scorePositioning(const Perception& per);

    // scorePositioning pipeline helpers
    void posBaseCandidates(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc);
    void posDefensiveCover(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per);
    void posBallFarOffers(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per);
    void posAttackingSupport(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per);
    void posDefensiveLine(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per);
    void posGeneralCover(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per);
    [[nodiscard]] double clampToLegalX(double x, double fd) const;

protected:
    // ── Narrow views onto engine internals, for the role subclasses ──
    // GameEngine grants friendship to PlayerAI alone. The role subclasses do not
    // inherit that (friendship never is), and rather than name all six in the
    // engine's friend list, the three internals they actually need are exposed
    // here. Anything else they want should be added here too, deliberately —
    // that keeps the engine's friend list at one entry and makes the agents'
    // dependency on engine internals an explicit, greppable list.
    // (Defined in agent.cpp, with the rest of the PlayerAI base implementation.)
    [[nodiscard]] bool    directiveBallPlaying() const;   // this player's ball-playing directive bias
    [[nodiscard]] double  gkDistributeTimer() const;      // goal-kick monitor countdown
    void                  releaseGkDistribution();        // keeper plays it away

    virtual void          adjustActionScores(SmallVector<Action, 24>& actions, bool isController);
    // Tight press now, or arriving within ~0.6s — the defender quick-release trigger.
    bool                  pressedTightOrClosing() const;
    // In-possession last man: no own outfield teammate goal-side of the carrier.
    bool                  carrierIsLastMan() const;
    // Last man, deep, and genuinely pressed — the "cornered" release trigger.
    bool                  carrierLastManTrapped() const;
    Action                resolveChoice(SmallVector<Action, 24>& actions);

    // resolveChoice() pipeline helpers — each returns nullptr to continue, or a chosen action
    Action* tryFreshBallOverride(SmallVector<Action, 24>& a, Action& best, bool ic, bool nearGoal);
    Action* tryLowScoreFallback(SmallVector<Action, 24>& a, Action& best);
    Action* tryLongCarryOverride(SmallVector<Action, 24>& a, Action& best, bool ic);
    Action* managePressSlots(SmallVector<Action, 24>& a, Action& best, TeamBlackboard& bb);
    void    auditBackpass(SmallVector<Action, 24>& a, Action& best, bool ic);
    Action* tryClearPathOverride(SmallVector<Action, 24>& a, Action& best, bool ic, double gx);
    Action* tryPressureSafetyPass(SmallVector<Action, 24>& a, Action& best, bool ic, bool nearGoal);
    Action* tryFinalThirdOverride(SmallVector<Action, 24>& a, Action& best, bool ic);
    Action* tryNearGoalShotBias(SmallVector<Action, 24>& a, Action& best, bool ic, bool nearGoal, double gx);
private:
    void                  executeAction(Action& action, double sdt, SmallVector<Action, 24>& actions);
    void                  executeDribble(Action& a, double sdt);
    // The two big phases of executeDribble. tryTakeOn returns true when it has
    // consumed the tick and the caller must return. Both read only the awareness
    // pass's counts; everything else they touch is on the player.
    bool                  tryTakeOn(int nearbyOpps, double nearestOppDist, bool ownDefensiveThird,
        const CarrierPressure& cp);
    void                  steerCarryTarget(int nearbyOpps, double nearestOppDist,
        const CarrierPressure& cp);
    // The one escape-lane solve, shared by both evade sites in scoreDribble.
    // See agent_shoot_dribble.cpp — round-36's "two bugs" were one bug copied.
    [[nodiscard]] bool    escapeLaneBlocked(double cx, double cy, const Player* evaded) const;
    void                  solveEscapeLane(double& tx, double& ty, double sideSeedY, double lateral,
        const Player* evaded, bool securing, double fd);
    // Carry target for a pinned carrier (the cornered-escape branch of scoreDribble).
    void                  steerCorneredCarry(const CarrierPressure& cp, double fd, bool securing,
        double& tx, double& ty);
    // The plain loose-ball chase at the end of scoreChase's cascade: returns the
    // score, writes the lead time.
    double                scoreLooseChase(const Perception& per, double ballSpeed, bool isDef, double& la);
    std::optional<Action> scorePassToTarget(Player& target, const Perception& per,
        double fd, double ownGoalX, double ownProgress, bool hasClearOutfieldOutlet,
        bool urgentKeeperNeed, bool movingTowardOwnGoal, bool corneredEscape, bool oppClosingSoon);
    // The filter half of scorePassToTarget, and the facts it hands the scoring
    // half. Defined in agent_pass_helpers.cpp; see PassLook there.
    bool                  passTargetGates(Player& target, const Perception& per,
        double fd, double ownGoalX, double ownProgress, bool hasClearOutfieldOutlet,
        bool urgentKeeperNeed, bool movingTowardOwnGoal, bool corneredEscape, bool oppClosingSoon,
        struct PassLook& look);
    // Balls played INTO space ahead of the receiver (through ball / wide outlet,
    // killer-ball projection, open advanced man, led-runner loft). Adjusts `sc`
    // only — it reads everything else.
    void                  scoreThroughBallFamily(Player& target, const Perception& per, double fd,
        const struct PassLook& look, double completion, bool isWideDelivery, bool targetWide,
        double targetGoalDist, double& sc, ActionPurpose& pur);
    Perception            getCachedPerception();
    Perception            perceive();
    void                  applyMovement(double sdt);
    // Stamina drain/recovery + the morale shade, returning the pace multiplier
    // applyMovement uses from there on. Mutates only the player's own fields.
    double                updateStaminaAndEffort(double secs, double spd);
    // Recovery sprint / step-with-the-pass / observing crawl. Writes defendSprint,
    // returns the cruise multiplier.
    double                chooseDefensiveGear(double bd, bool isObserving, bool& defendSprint);
    // The facing half of applyMovement: where the player LOOKS once his position
    // and velocity for the tick are settled. Takes the ball's distance and offset.
    void                  updateFacing(double ballDist, double ballDx, double ballDy);
    void                  tryCollectAfterChase();
    void                  auditDefensiveMovement(const Action& choice);
    PassSelectionAudit    passSelectionAudit(const Action& choice, const SmallVector<Action, 24>& actions);
    ShotSelectionAudit    shotSelectionAudit(const Action& choice, const SmallVector<Action, 24>& actions);
public:
    virtual void          setPiecePositioning(SetPiece spType, Team spTeam);
    void                  stunLock(int ticks) { stunLockTicks = std::max(stunLockTicks, ticks); }
    bool                  setPieceHold = false;
    // Read-only peek for the FOOTY_BLOBDEBUG knot logger (engine.cpp auditBlobPurposes).
    ActionType            lastAction() const { return lastActionType; }
    ActionPurpose         lastActionPurpose() const { return lastPurpose; }
};

#pragma once
#include "rng.h"
#include "constants.h"
#include "types.h"
#include "stats.h"
#include "small_vector.h"
#include <format>
#include <algorithm>
#include <memory>

// Forward declarations — full includes only in .cpp files that need them
class PlayerAI;
struct PassSelectionAudit;
struct ShotSelectionAudit;

class GameEngine {
public:
    mutable SeededRNG rng;
    EngineState state;
    TeamBlackboard blackboards[2]; // [0]=home, [1]=away
    static int teamIndex(Team team) { return static_cast<int>(team); }
    StatsCollector stats;
    std::vector<std::unique_ptr<PlayerAI>> agents;

    ~GameEngine();
    std::array<Player*, 22> playerLookup = {};
    double accumulator = 0.0;

    // ── Match Metrics & Tracking ──
    struct Metrics {
        double possessionHome = 0, possessionAway = 0;
        double peakBallSpeed = 0, looseBallSpeedTotal = 0;
        double passLaunchSpeedTotal = 0, shotLaunchSpeedTotal = 0;
        int looseBallSpeedSamples = 0, passLaunchCount = 0, shotLaunchCount = 0;
    } metrics;

    struct CarrierTracker {
        int watchedCarrierId = -1;
        double watchedCarrierX = 0, watchedCarrierY = 0, watchedCarrierMs = 0;
        double lastStuckAlertMs = -1e9;
        int stuckCarrierAlerts = 0;

        int backwardCarryCarrierId = -1;
        double backwardCarryStartX = 0;
        bool backwardCarryRecorded = false;

        int carryTrackerId = -1;
        double carryLastX = 0, carryLastY = 0, carryPathDistance = 0;

        int stationaryHoldCarrierId = -1;
        double stationaryHoldMs = 0;
        bool stationaryHoldRecorded = false;
    } carrierTracker;

    struct FreezeDetector {
        int simulationFreezes = 0;
        double freezeWatchMs = 0;
        double freezeBallX = 0, freezeBallY = 0;
        int freezeLastController = -1;
        double lastFreezeAlertMs = -1e9;
    } freezeDetector;

    struct GoalInfo {
        std::string source = "none";
        Team scoringTeam = Team::Home;
        Team touchTeam = Team::Home;
        int toucherId = -1;
        double ballSpeed = 0;
    } lastGoal;

    // ── Game Logic State ──
    int teammatePingPongs = 0;
    double lastSameTeamCollectionMs = 0;
    std::optional<Team> lastCollectionTeam;
    int dizzySpins = 0;
    double nextTacticalAuditMs = 0;

    struct MatchPhase {
        int half = 1;
        double halfTimePause = 0;
        bool addedTimeActive = false;
        Team nextKickoffTeam = Team::Home;
        double lastKickoffMs = 0;
        bool kickoffPhase = false;
        double actionTimer = 0;
    } phase;

    struct SetPieceState {
        bool armed = false;
        SetPiece type = SetPiece::None;
        Team team = Team::Home;
        int takerId = -1;
        double spotX = 0, spotY = 0;
        bool takerArrived = false;
        std::string reason;
    } setPiece;

    double prevBallX = 525, prevBallY = 340;
    double prevBallVx = 0, prevBallVy = 0;
    int prevControllerId = -1;
    int ballImpulseGraceTicks = 0;

    struct ShotTracking {
        bool active = false;
        bool tracked = false;
        bool preventable = false;
        bool header = false;
        bool penalty = false;
        bool dribble20m = false;
        Team team = Team::Home;
        int shooterId = -1;
        // Pre-rolled at launch: the one defender allowed to block this shot
        // (-1 = shot is committed past every body in the lane).
        int blockerId = -1;
        // Pre-rolled: may the keeper recover this shot via positioning pickup
        // after a failed reflex save? false = it beat him clean.
        bool scoopAllowed = true;
        void clearFlags() { tracked = false; preventable = false; header = false; penalty = false; dribble20m = false; }
        double originX = 0, originY = 0;
    } shot;

    // A save rolled at the assessment gate but resolved only when the ball
    // PHYSICALLY reaches the keeper — the roll used to teleport the ball
    // 100-200px into his gloves the same tick the shot was struck.
    struct PendingSave {
        bool active = false;
        int gkId = -1;
        int shooterId = -1;
        double crossY = 0;     // predicted intercept y at roll time (dive target)
        double reach = 0;      // rolled reach, reused for the handling decision
    } pendingSave;
    void resolvePendingSave();
    void applySaveOutcome(Player& gk, int shooterId, double reach);

    struct GKMonitor {
        double distributeTimer = 0;
        bool active = false;
        Team team = Team::Home;
        double startedMs = 0;
    } goalKickMonitor;

    std::array<double, 22> contestBlockedUntil = {};
    int receiverShieldTargetId = -1, receiverShieldedPlayerId = -1;
    double receiverShieldUntil = 0;
    struct PendingPass {
        bool active = false;
        int fromId = -1, toId = -1;
        Team team = Team::Home;
        bool isCross = false;
        bool isThrough = false;
        bool offsideExempt = false;
        // The law judges the receiver's position at the MOMENT the ball is
        // played — captured here; judging at collection flagged legal runs.
        bool receiverOffsideAtPass = false;
        double passerX = 0.0;
        double passerY = 0.0;
        double offsideLine = 0.0;
    } pendingPass;
    struct ActiveKnockAhead {
        bool active = false;
        int playerId = -1;
        Team team = Team::Home;
        double launchedAt = 0;
        int nearestOpponentId = -1;
        double nearestOpponentDistance = 0;
        bool risky = false;
    } activeKnockAhead;
    std::array<double, 22> knockAheadCooldownUntil = {};
    std::string lastLooseOrigin;
    struct VisualEvent {
        std::string type;
        double x = 0, y = 0, clockMs = 0;
        int playerId = -1, targetId = -1;
    };
    std::vector<VisualEvent> visualEvents;
    // Full event log for the trace file — the host drains this every tick
    // (visualEvents is renderer-facing and capped, so it drops history).
    std::vector<VisualEvent> traceEventQueue;

    // ── Agent-accessible state ──
    struct RecentPass { double bx=525,by=340,vx=0,vy=0; Team team=Team::Home; double clockMs=0; };
    RecentPass qRecentPassVal;
    RecentPass* qRecentPass() { return &qRecentPassVal; }
    [[nodiscard]] int clockMs() const { return static_cast<int>(state.clockMs); }
    [[nodiscard]] Team teamInPossession() const { return state.ball.lastTouchTeam; }

    // ── Tactical callbacks ──
    struct Config {
        double aggression=50, passingDirectness=50, overlapFrequency=50;
        double midfieldFreedom=50, defensiveLineHeight=50;
    };
    Config homeConfig, awayConfig;
    [[nodiscard]] Config configFor(Team team) const { return team==Team::Home ? homeConfig : awayConfig; }
    [[nodiscard]] double offsideLineFor(Team t) const;
    [[nodiscard]] bool checkOffside(const Player& receiver, const Player& passer) const;
    void awardOffsideFreeKick(Team defTeam, const Player& offsidePlayer);
    [[nodiscard]] bool isOffsideTarget(const Player& passer, const Player& receiver) const;
    struct AgentTeamAssignment { DefensiveTask role = DefensiveTask::None; int opponentId=-1; double targetX=0, targetY=0; };
    std::array<AgentTeamAssignment, 22> assignmentByPlayer = {};
    [[nodiscard]] AgentTeamAssignment* assignmentFor(int playerId) {
        if (playerId < 0 || playerId >= 22 || assignmentByPlayer[playerId].role == DefensiveTask::None) return nullptr;
        return &assignmentByPlayer[playerId];
    }
    [[nodiscard]] const AgentTeamAssignment* assignmentFor(int playerId) const {
        if (playerId < 0 || playerId >= 22 || assignmentByPlayer[playerId].role == DefensiveTask::None) return nullptr;
        return &assignmentByPlayer[playerId];
    }
    [[nodiscard]] Player* playerById(int id);
    [[nodiscard]] const Player* playerById(int id) const;
    [[nodiscard]] PlayerAI* agentFor(const Player& p);
    [[nodiscard]] const PlayerAI* agentFor(const Player& p) const;
    [[nodiscard]] Player* findGK(Team team);
    [[nodiscard]] const Player* findGK(Team team) const;
    [[nodiscard]] SmallVector<Player*, 11> nearPlayers(Player& p, double range);
    [[nodiscard]] Player* findNearestOutfieldPlayer(Team team, double x, double y);
    [[nodiscard]] bool isCarrierShielded(int playerId) const { return receiverShieldedPlayerId==playerId&&state.clockMs<receiverShieldUntil; }
    bool canContestBall(Player& player);
    [[nodiscard]] bool canKnockBallAhead(int playerId) const {
        return !activeKnockAhead.active && knockAheadCooldownUntil[playerId] <= state.clockMs;
    }
    [[nodiscard]] bool isActiveKnockAheadRunner(int playerId) const { return activeKnockAhead.active&&activeKnockAhead.playerId==playerId; }

    // ── Actions ──

    bool knockBallAhead(Player&, double, double);
    void resolveKnockAhead(Player* collector, const std::string& stopped = "");
    void emitEvent(const std::string&, double, double, int=-1, int=-1);
    void blockReboundFor(int playerId, double ms);
    void recordBallImpulse();
    void beginTrackedPass(Player& from, Player& to, bool isCross = false, bool isThrough = false);
    bool resolvePendingPass(Player& receiver);
    void auditStuckCarrier(double sdt);
    void updateTeamAssignments();
    void assignDefensiveRoles(Team team, Player& carrier);
    void setAssignment(Player& player, DefensiveTask role, double x, double y, int opponentId=-1);
    // Defense pipeline helpers
    struct DefenseContext {
        struct Rated { Player* player; double distance; double eta; double score; };
        struct Threat { Player* player; double depth; };
        Team team;
        double fd;
        double ownGoalX;
        bool danger;
        Config tactics;
        double lineProgress = 0;
        bool shootingRange = false;
        bool wideDanger = false;
        double carrierGoalDist = 0;
        std::array<bool, 22> assigned = {};
        SmallVector<Rated, 12> ranked;
        SmallVector<Threat, 12> threats;
        bool used(const Player* p) const { return assigned[p->id]; }
    };
    SmallVector<DefenseContext::Rated, 12> rankDefenders(Team team, Player& carrier);
    void assignPrimaryPress(DefenseContext& ctx, Player& carrier);
    void assignSecondaryPress(DefenseContext& ctx, Player& carrier);
    void assignShotLane(DefenseContext& ctx, Player& carrier);
    void assignCrossLane(DefenseContext& ctx, Player& carrier);
    void assignCoverRoles(DefenseContext& ctx, Player& carrier);
    void assignMidfieldScreen(DefenseContext& ctx, Player& carrier);
    void assignCloseDown(DefenseContext& ctx, Player& carrier);
    SmallVector<DefenseContext::Threat, 12> identifyThreats(DefenseContext& ctx, Player& carrier);
    void assignThreatMarking(DefenseContext& ctx, Player& carrier);
    void assignBoxProtection(DefenseContext& ctx, Player& carrier);
    void assignDefensiveLine(DefenseContext& ctx, Player& carrier);
    void auditTacticalCoverage(Player& carrier);
    void auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                 int pressureCount, const std::string& choiceType);

    [[nodiscard]] double goalOpeningAngleDeg(double x, double y, double gx) const;

    void placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset=CONTROL_DIST+BALL_R+4.0);
    void passBallTo(Player& f, Player& t);
    void applyWhipDelivery(double dist, double speed, double goalX, double curlMin, double curlRange);
    bool passBallTo(Player& f, Player& t, bool throughBall, bool lob, const PassSelectionAudit* selectionAudit);
    void forcePassTo(Player& f, Player& t, const PassSelectionAudit*);
    bool attemptTackle(Player& tackler, Player& carrier);
    void shootBall(Player& s, const ShotSelectionAudit* selectionAudit);
    bool collectBall(Player& c, const std::string&, double allowedDist);

    // ── Quality flag logging ──
    template<typename...A> void logQualityFlag(QualityFlag flag, A&&...) { stats.recordQualityFlag(flag); }
    template<typename...A> void logQualityFlag(const std::string& tag, A&&...) { stats.recordQualityFlag(qualityFlagFromStr(tag)); }
    template<typename...A> void captureDecisionMoment(const std::string&, A&&...) { stats.recordDecisionMoment(); }
    template<typename...A> void logPlayerDecision(A&&...) { stats.recordPlayerDecision(); }
    void notePreventedStaleGrab(Player&) { stats.recordStaleGrabPrevented(); }
    void noteTaskSelection(Player&, DefensiveTask role) { stats.recordTaskSelection(role); }

    // ── Lifecycle ──
    GameEngine();
    void initWithSeed(int seed);
    void equalizeAttributes(int val);
    void createHomeTeam();
    void createAwayTeam();
    Player mkPlayer(int id, Team t, Role r, double hx, double hy);
    void startMatch();
    void kickoff(Team t);
    void update(double dM);
    void fixedUpdate(double sdt);
    void tickAgents(double sdt, bool ic);
private:
    void cacheBallState();
    void updatePlayerAnimations(double sdt);
    void updatePossessionTracking(double sdt);
    void detectSimulationFreeze(double sdt);
    void updateSetPiecePhase(double sdt, double sec);
    void updateKickoffPhase(double sdt);
    void updateOpenPlayPhase(double sdt, double sec);
public:
    void kickoffTap();
    void releaseSetPiece();
    void releaseGoalKick(Player& holder);
    void releaseGoalkeeperDistribution(Player& holder);
    void releaseCornerKick(Player& holder);
    void releaseThrowIn(Player& holder);

    // ── Physics ──
    void applyBallPhysics(double s);
    void clampBallPosition();
    bool checkGoal();
    bool checkOutOfPlay();
    void checkBallPlayerCollision(double);
    void collectBall(Player& c);
    void updateControlledBall(double secs);
    void moveBallCarrier(double sdt);
    void separateTeammates(double sdt);
    void updateGK(double sdt);
    void updateOneGK(Player& gk, double secs);
    void tryGKSave();
    void awardThrowIn(Team lastTouchTeam, double y);
    void awardSetPiece(SetPiece t, Team tm);
    void awardCorner(Team attackingTeam, bool atHomeEnd, double y);
    void updateGoalKickMonitor();

    std::string getSummaryJSON() const;
    std::string getJSON() const;
};

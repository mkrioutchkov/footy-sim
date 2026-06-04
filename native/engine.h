#pragma once
#include "rng.h"
#include "constants.h"
#include "types.h"
#include "agent.h"
#include "gk_ai.h"
#include "role_ai.h"
#include "stats.h"
#include "json.h"
#include <format>
#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <memory>

class GameEngine {
public:
    mutable SeededRNG rng;
    EngineState state;
    TeamBlackboard blackboards[2]; // [0]=home, [1]=away
    static int teamIndex(Team team) { return static_cast<int>(team); }
    StatsCollector stats;
    std::vector<std::unique_ptr<PlayerAI>> agents;
    std::array<Player*, 22> playerLookup = {};
    double accumulator = 0.0;

    // per-frame state (not stats — used by game logic)
    double possessionHome = 0, possessionAway = 0;
    double peakBallSpeed = 0, looseBallSpeedTotal = 0;
    double passLaunchSpeedTotal = 0, shotLaunchSpeedTotal = 0;
    int looseBallSpeedSamples = 0, passLaunchCount = 0, shotLaunchCount = 0;
    std::string lastGoalSource = "none";
    Team lastGoalScoringTeam = Team::Home, lastGoalTouchTeam = Team::Home;
    int lastGoalToucherId = -1;
    double lastGoalBallSpeed = 0;
    int stuckCarrierAlerts = 0;
    int teammatePingPongs = 0;
    double lastSameTeamCollectionMs = 0;
    std::optional<Team> lastCollectionTeam;
    int simulationFreezes = 0;
    double freezeWatchMs = 0;
    double freezeBallX = 0, freezeBallY = 0;
    int freezeLastController = -1;
    double lastFreezeAlertMs = -1e9;
    int dizzySpins = 0;
    double nextTacticalAuditMs = 0;
    int watchedCarrierId = -1;
    double watchedCarrierX = 0, watchedCarrierY = 0, watchedCarrierMs = 0, lastStuckAlertMs = -1e9;

    double lastKickoffMs = 0; bool kickoffPhase = false;
    double actionTimer = 0; bool setPieceArmed = false;
    double prevBallX = 525, prevBallY = 340;
    int prevControllerId = -1;
    std::string setPieceType, setPieceTeam;
    int setPieceTakerId = -1;
    double setPieceSpotX = 0, setPieceSpotY = 0;
    bool setPieceTakerArrived = false;
    std::string setPieceReason;
    int half = 1; double halfTimePause = 0;
    Team nextKickoffTeam = Team::Home;
    bool shotActive = false;
    bool trackedShot = false;
    bool trackedShotPreventable = false;
    bool trackedShotHeader = false;
    Team trackedShotTeam = Team::Home;
    int trackedShooterId = -1;
    double shotOriginX = 0, shotOriginY = 0;
    double gkDistributeTimer = 0;
    bool goalKickMonitorActive = false;
    Team goalKickMonitorTeam = Team::Home;
    double goalKickMonitorStartedMs = 0;
    std::unordered_map<int,double> contestBlockedUntil;
    int receiverShieldTargetId = -1, receiverShieldedPlayerId = -1;
    double receiverShieldUntil = 0;
    struct PendingPass {
        bool active = false;
        int fromId = -1, toId = -1;
        Team team = Team::Home;
        bool isCross = false;
        bool isThrough = false;
        bool offsideExempt = false;
        double passerX = 0.0;
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
    std::unordered_map<int,double> knockAheadCooldownUntil;
    std::string lastLooseOrigin;
    struct VisualEvent {
        std::string type;
        double x = 0, y = 0, clockMs = 0;
        int playerId = -1, targetId = -1;
    };
    std::vector<VisualEvent> visualEvents;

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
    void awardOffsideFreeKick(const std::string& defendingTeam, const Player& offsidePlayer);
    [[nodiscard]] bool isOffsideTarget(const Player& passer, const Player& receiver) const;
    struct AgentTeamAssignment { std::string role; int opponentId=-1; double targetX=0, targetY=0; };
    std::unordered_map<int, AgentTeamAssignment> assignmentByPlayer;
    [[nodiscard]] AgentTeamAssignment* assignmentFor(int playerId) {
        auto it=assignmentByPlayer.find(playerId);
        return it==assignmentByPlayer.end()?nullptr:&it->second;
    }
    [[nodiscard]] const AgentTeamAssignment* assignmentFor(int playerId) const {
        auto it=assignmentByPlayer.find(playerId);
        return it==assignmentByPlayer.end()?nullptr:&it->second;
    }
    [[nodiscard]] Player* playerById(int id);
    [[nodiscard]] const Player* playerById(int id) const;
    [[nodiscard]] std::vector<Player*> nearPlayers(Player& p, double range);
    [[nodiscard]] bool isCarrierShielded(int playerId) const { return receiverShieldedPlayerId==playerId&&state.clockMs<receiverShieldUntil; }
    bool canContestBall(Player& player);
    [[nodiscard]] bool canKnockBallAhead(int playerId) const {
        auto it=knockAheadCooldownUntil.find(playerId);
        return !activeKnockAhead.active&&(it==knockAheadCooldownUntil.end()||it->second<=state.clockMs);
    }
    [[nodiscard]] bool isActiveKnockAheadRunner(int playerId) const { return activeKnockAhead.active&&activeKnockAhead.playerId==playerId; }

    // ── Actions ──
    void notePreventedStaleGrab(Player&) {}
    void noteTaskSelection(Player&, const std::string&) {}
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
    void setAssignment(Player& player, const std::string& role, double x, double y, int opponentId=-1);
    void auditTacticalCoverage(Player& carrier);
    void auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                 int pressureCount, const std::string& choiceType);

    [[nodiscard]] double goalOpeningAngleDeg(double x, double y, double gx) const;

    void placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset=CONTROL_DIST+BALL_R+4.0);
    void passBallTo(Player& f, Player& t);
    bool passBallTo(Player& f, Player& t, bool throughBall, bool lob, const PassSelectionAudit* selectionAudit);
    void forcePassTo(Player& f, Player& t, const PassSelectionAudit*);
    bool attemptTackle(Player& tackler, Player& carrier);
    void shootBall(Player& s, const ShotSelectionAudit* selectionAudit);
    bool collectBall(Player& c, const std::string&, double allowedDist);

    // ── Logging (no-ops for C++) ──
    template<typename...A> void logPlayerDecision(A&&...){}
    template<typename...A> void logQualityFlag(A&&...){}
    template<typename...A> void captureDecisionMoment(A&&...){}
    template<typename...A> void auditDefensiveMovement(A&&...){}

    // ── Lifecycle ──
    GameEngine();
    void initWithSeed(int seed);
    void equalizeAttributes(int val);
    void createHomeTeam();
    void createAwayTeam();
    void startMatch(){state.matchState="running";state.clockMs=0;kickoff(Team::Home);}
    void kickoff(Team t);
    void update(double dM);
    void fixedUpdate(double sdt);
    void tickAgents(double sdt, bool ic);
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
    void tryGKSave();
    void awardThrowIn(std::string lt, double y);
    void awardSetPiece(std::string t, std::string tm);
    void awardCorner(Team attackingTeam, bool atHomeEnd, double y);
    void updateGoalKickMonitor();

    std::string getSummaryJSON() const { return stats.summaryJSON(); }
    std::string getJSON() const;
};

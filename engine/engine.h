#pragma once
#include "rng.h"
#include "constants.h"
#include "types.h"
#include "stats.h"
#include "small_vector.h"
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
        Team matchKickoffTeam = Team::Home;   // who kicked the match off (law: other side starts H2)
        double lastKickoffMs = 0;
        bool kickoffPhase = false;
        double actionTimer = 0;
        double stoppageMs = 0;            // accumulated dead time this half
        double announcedAddedMs = 0;      // the board: +N minutes
    } phase;
    std::array<int, 22> yellowCards = {};

    // Match length is a RUNTIME parameter (default 90'), not the compile-time
    // constant it used to be — the product needs 20/40/90-minute variants and
    // each wants its own clock. Set before startMatch; half is always half.
    double matchDurationMs = MATCH_DURATION;
    double halfDurationMs   = HALF_DURATION;
    void setMatchLengthMinutes(double minutes) {
        matchDurationMs = minutes * 60000.0;
        halfDurationMs  = matchDurationMs / 2.0;
    }

    // Substitutions: an in-place identity swap (the on-pitch slot keeps its
    // id/role/position; only name+attrs+freshness change), so the 22-slot
    // player array and every pointer into it stay valid — no bench array to
    // dangle. Each team has a reserve pool and a 5-sub allowance.
    struct BenchPlayer { std::string name; PlayerAttributes attrs; bool used = false; };
    std::array<std::vector<BenchPlayer>, 2> bench;
    std::array<int, 2> subsRemaining = {5, 5};
    double nextSubCheckMs = 0;
    void initBench();
    void updateSubstitutions();
    void substituteSlot(Player& slot, BenchPlayer& in);
    void sendOff(Player& p);

    // Per-player match tallies for the report (scorers, assists). Indexed by
    // slot id; a substitution inherits the slot's running tally, which is fine
    // for a match report keyed on the shirt.
    std::array<int, 22> pGoals = {};
    std::array<int, 22> pAssists = {};
    std::array<int, 22> pShots = {};
    std::array<int, 22> pTackles = {};
    // Assist chain: who last fed this slot a completed pass, and when.
    std::array<int, 22> lastReceiveFrom = {};
    std::array<double, 22> lastReceiveMs = {};
    void creditGoal(int scorerId);

    struct SetPieceState {
        bool armed = false;
        SetPiece type = SetPiece::None;
        Team team = Team::Home;
        int takerId = -1;
        double spotX = 0, spotY = 0;
        bool takerArrived = false;
        double walkMs = 0;   // time spent trying to reach the ball — backstop against a never-arriving taker
        std::string reason;
    } setPiece;

    double prevBallX = 525, prevBallY = 340;
    double prevBallVx = 0, prevBallVy = 0;
    int prevControllerId = -1;
    int ballImpulseGraceTicks = 0;
    // Quick-transition window: for ~400ms after a LIVE turnover the defence is
    // unset, so reward fast vertical passes + forward runs to manufacture
    // counters and 1v1s (end-to-end excitement; breakaway finishes also feed the
    // first-touch keeper wrong-foot). Pure clock+controller function — no rng.
    double transitionUntilMs = 0.0;
    Team transitionLastCtrlTeam = Team::Home;
    bool transitionHadCtrl = false;

    struct ShotTracking {
        bool active = false;
        bool tracked = false;
        bool preventable = false;
        bool header = false;
        bool penalty = false;
        bool dribble20m = false;
        bool freshFinish = false;   // first-touch / fresh cross or through-ball snap finish: keeper is wrong-footed
        int type = 0;               // shot type for instrumentation (0 normal 1 finesse 2 power 3 curl) — debug only
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
        bool willSave = true;  // false = a beaten dive: he commits but won't save
    } pendingSave;
    void resolvePendingSave();
    void applySaveOutcome(Player& gk, int shooterId, double reach);
    // Keeper claims an aerial cross in his box: catch / punch / tip-for-corner,
    // keyed on handling. claimD is the slant distance (incl. z) at commit.
    void resolveCrossClaim(Player& gk, double claimD);

    struct GKMonitor {
        double distributeTimer = 0;
        bool active = false;
        Team team = Team::Home;
        double startedMs = 0;
    } goalKickMonitor;

    std::array<double, 22> contestBlockedUntil = {};
    // First touch: after gaining a moving ball an outfielder must settle it
    // before he can play a deliberate pass — without this, ~1/3 of passes
    // were instant one-touch redirects of near-shot-speed balls into measured
    // passes, which reads as physically impossible. Scales with incoming pace.
    std::array<double, 22> firstTouchUntilMs = {};
    [[nodiscard]] bool inFirstTouch(int id) const {
        return id >= 0 && id < 22 && firstTouchUntilMs[id] > state.clockMs;
    }
    // Authoritative per-tick velocity: positions are sampled before any
    // movement, and every player's vx/vy is recomputed from true displacement
    // AFTER all movement phases (separation, carrier, GK). Mid-tick writers
    // left stationary/separated players reporting full-sprint velocity, which
    // drove on-screen moonwalk and 180-degree facing snaps.
    std::array<double, 22> velSampleX = {};
    std::array<double, 22> velSampleY = {};
    void sampleVelocityOrigins() { for (auto& p : state.players) { velSampleX[p.id] = p.x; velSampleY[p.id] = p.y; } }
    void finalizeVelocities(double secs) {
        if (secs < 1e-4) return;
        for (auto& p : state.players) { p.vx = (p.x - velSampleX[p.id]) / secs; p.vy = (p.y - velSampleY[p.id]) / secs; }
    }
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
        // Pass-decision audit, carried to the interception site (FOOTY_PASSDEBUG).
        double auComp = 0.0; int auBlk = 0; int auPress = 0; double auFwd = 0.0;
        double auSafer = 0.0; int auSaferId = -1;
    } pendingPass;
    bool passDebug = false;   // FOOTY_PASSDEBUG: dump each intercepted pass's decision context to stderr
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
    // Runtime dial deltas set by team-wide directives ("park the bus", "all out
    // attack", "high press" ...). [0]=home, [1]=away. Rebuilt every tick by
    // applyDirectives (pure clock+score function, no rng), added on top of the
    // base config in configFor and clamped. All-zero = no override.
    struct ConfigDelta { double aggression=0, passingDirectness=0, overlapFrequency=0, midfieldFreedom=0, defensiveLineHeight=0; };
    std::array<ConfigDelta, 2> dialOverride{};
    // play_it_long: a direct per-team pass-scorer hook (NOT a dial) — the dial's
    // passingDirectness already varies by score-state in the default match, so
    // coupling the long-ball gamble to it would change default play. This stays
    // 0 unless the directive sets it, keeping the no-directive match identical.
    std::array<double, 2> longBallBias{};
    // counter_attack: per-team amplifier on the quick-transition through-ball +
    // off-ball-run bonuses (0 => no-directive match identical). offside_trap:
    // per-team flag that holds the line high in the danger zone. Both reset every
    // tick in applyDirectives (pure clock/score functions, no rng).
    std::array<double, 2> counterAttackBonus{};
    std::array<bool, 2> offsideTrapActive{};
    // all_out_attack: commit the overlap FB + a CM forward even on central /
    // slightly-earlier carries (throw bodies forward), read by assignAttackingRoles.
    // One-tick lagged (updateTeamAssignments precedes applyDirectives) — fine for a
    // match-long order; deterministic. 0/false by default => no-directive identical.
    std::array<bool, 2> allOutActive{};
    [[nodiscard]] Config configFor(Team team) const {
        Config c = team==Team::Home ? homeConfig : awayConfig;
        const ConfigDelta& dv = dialOverride[team==Team::Home ? 0 : 1];
        c.aggression += dv.aggression; c.passingDirectness += dv.passingDirectness;
        c.overlapFrequency += dv.overlapFrequency; c.midfieldFreedom += dv.midfieldFreedom;
        c.defensiveLineHeight += dv.defensiveLineHeight;
        // Score-state tactics: a side chasing the game late pushes — higher
        // line, more aggression, more directness; a side protecting a lead
        // drops off. Pure function of score+clock, so determinism holds.
        int diff = team==Team::Home ? state.homeScore - state.awayScore : state.awayScore - state.homeScore;
        double minLeft = (matchDurationMs - state.clockMs) / 60000.0;
        if (diff < 0 && minLeft < 20.0) {
            double urgency = clamp((20.0 - minLeft) / 20.0, 0.0, 1.0) * std::min(-diff, 2);
            c.aggression += 14.0 * urgency;
            c.defensiveLineHeight += 12.0 * urgency;
            c.passingDirectness += 13.0 * urgency;
        } else if (diff > 0 && minLeft < 15.0) {
            c.aggression -= 8.0;
            c.defensiveLineHeight -= 12.0;
        }
        c.aggression = clamp(c.aggression, 0.0, 100.0);
        c.passingDirectness = clamp(c.passingDirectness, 0.0, 100.0);
        c.overlapFrequency = clamp(c.overlapFrequency, 0.0, 100.0);
        c.midfieldFreedom = clamp(c.midfieldFreedom, 0.0, 100.0);
        c.defensiveLineHeight = clamp(c.defensiveLineHeight, 0.0, 100.0);
        return c;
    }
    [[nodiscard]] double offsideLineFor(Team t) const;
    [[nodiscard]] bool checkOffside(const Player& receiver, const Player& passer) const;
    void awardOffsideFreeKick(Team defTeam, const Player& offsidePlayer);
    [[nodiscard]] bool isOffsideTarget(const Player& passer, const Player& receiver) const;
    [[nodiscard]] bool isOffsideTargetPerceived(const Player& passer, const Player& receiver) const;
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
    // Wake the in-possession team's off-ball runners: designate up to 3 attacking
    // roles (RunAhead/InsideRun/Overlap/AdvanceMidfield) so the dormant assignment-
    // gated pass bonuses + run-target overrides fire. Pure geometry, no rng.
    void assignAttackingRoles(Team team, Player& carrier);
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

    // ── Data-driven rosters (FM-style game). When a roster is active, the 11
    // players in that team's fixed formation slots (0..10) take their name +
    // attributes from the override instead of the hardcoded legends, and the
    // Config dials are taken as-is (configOverride) rather than randomized.
    // This is how a user-created team plays. Set before initWithSeed(). ──
    struct RosterOverride {
        bool active = false;
        std::array<PlayerAttributes, 11> attrs{};
        std::array<std::string, 11> names{};
        // Formation/lineup: per-slot role + home anchor (engine frame, absolute —
        // the backend mirrors for away). Default = the current 4-3-3 roles; anchors
        // <=0 mean "use the hardcoded default for this slot". hasLayout=false =>
        // the whole hardcoded literal layout (back-compat; no-directive match
        // stays byte-identical).
        std::array<Role, 11> roles{ Role::GK, Role::FB, Role::CB, Role::CB, Role::FB,
                                    Role::CM, Role::CM, Role::CM, Role::WM, Role::CF, Role::WM };
        std::array<double, 11> homeX{};
        std::array<double, 11> homeY{};
        bool hasLayout = false;
        // Optional per-slot pre-match morale shading in [-1,1] (default 0 = neutral).
        std::array<double, 11> moraleBoost{};
    };
    RosterOverride homeRoster, awayRoster;
    bool configOverride = false;

    // ── Plain-English tactics (P1): compiled directives the engine executes
    // each tick. Player ids are resolved (0..21) by the caller. Conditions are a
    // PURE function of clock + score (no rng — must not perturb the stream).
    // See docs/TACTICS.md. ──
    enum class DirectiveKind : uint8_t {
        // ── per-player (playerId 0..21) ──
        ManMark, ShootOnSight, GetForward, SitDeep, TargetPlayer,
        StayWide, ComeInside, StayCentral,
        CrossEarly, SwitchPlay, PlaySimple,
        RunInBehind, MakeRuns, DribbleMore,
        PressHard, TackleHard, StayOnFeet,
        // ── team-wide dial commands (teamScope >= 0, playerId unused) ──
        AllOutAttack, ParkTheBus, HighPress, DropOff, PlayItLong,
        KeepItOnGround, GetItWide, PlayNarrow, PushUp, SlowItDown,
        CounterAttack, OffsideTrap,
    };
    enum class CondScore : uint8_t { Any, Winning, Drawing, Losing };
    struct Directive {
        int playerId = -1;                          // who it applies to (engine id 0..21)
        int teamScope = -1;                         // -1 = player-scoped; 0 = home team, 1 = away team (dial commands)
        DirectiveKind kind = DirectiveKind::ManMark;
        int targetId = -1;                          // man_mark / target_player target
        double intensity = 1.0;
        int fromMin = 0;                            // active from this match minute...
        int toMin = 1000;                           // ...to this one, inclusive (default = whole match)
        CondScore scoreState = CondScore::Any;      // active only in this score state
        int scoreBy = 0;                            // ...by at least N goals (0 => any margin)
    };
    std::vector<Directive> directives;
    // Per-player score nudges the scorers read THIS tick; rebuilt every tick by
    // applyDirectives() (stateless, so deterministic).
    struct DirectiveBias { bool shootOnSight=false; double pushUp=0.0; int passTargetId=-1; double passTargetBias=0.0;
        bool crossEarly=false; double switchBias=0.0; double simplifyBias=0.0;
        double runAheadBias=0.0; double dribbleBonus=0.0;
        double pressTightness=0.0; double tackleAggression=0.0; double stayOnFeet=0.0; };
    std::array<DirectiveBias, 22> directiveBias = {};
    // Timed plan changes (P2): each entry REPLACES the active directive set once
    // the clock reaches atMs. The match is then a pure function of seed + this
    // timeline, so it replays identically. Applied at the top of applyDirectives.
    // moraleDelta[id] is added to that player's moraleBoost when the entry fires (a
    // motivational shout's effect); 0 for everyone by default. A mid-match FORMATION
    // change also carries a per-player layout: where layoutHX[id] > 0, that player
    // re-anchors (base + current) + re-roles + gets a fresh role-AI on fire.
    struct TimelineEntry {
        double atMs = 0.0;
        std::vector<Directive> directives;
        std::array<double, 22> moraleDelta{};
        std::array<double, 22> layoutHX{};
        std::array<double, 22> layoutHY{};
        std::array<Role, 22>   layoutRole{};
        // A layout slot is APPLIED only when role+homeX+homeY were ALL present in
        // the spec — guards against a partial row defaulting role to GK / homeY to 0,
        // and lets a legit homeX==0 (left touchline) anchor through.
        std::array<bool, 22>   layoutSet{};
    };
    std::vector<TimelineEntry> directiveTimeline;
    size_t directiveTimelineIdx = 0;
    // get_forward/sit_deep relocate a player's formation ANCHOR (homeX) up or
    // down the pitch — every positioning candidate keys off homeX, so the whole
    // shape (attacking base AND defensive station) moves coherently. We snapshot
    // the kickoff anchors once, then each tick rebuild homeX = base + fd*shift so
    // dropping a directive restores the original station. Pure clock function.
    // homeX = forward/back anchor (get_forward/sit_deep); homeY = lateral anchor
    // (stay_wide/come_inside/stay_central). Both snapshotted once, rebuilt each
    // tick from the base so a lapsed directive springs back to station.
    std::array<double, 22> baseHomeX = {};
    std::array<double, 22> baseHomeY = {};
    bool baseHomeXCaptured = false;
    void applyDirectives();

    // ── Lifecycle ──
    GameEngine();
    void initWithSeed(int seed);
    void equalizeAttributes(int val);
    void createHomeTeam();
    void createAwayTeam();
    void buildTeam(Team team, const RosterOverride& ro, const double* defHX);
    Player mkPlayer(int id, Team t, Role r, double hx, double hy);
    void reassignAgent(Player& p, Role r);   // mid-match role change: swap the player's role-AI
    void startMatch();
    void kickoff(Team t);
    void update(double dM);
    void fixedUpdate(double sdt);
    void tickAgents(double sdt, bool ic);
private:
    bool initialized_ = false;   // one-shot guard: GameEngine is one-match-per-instance (initWithSeed)
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
    bool checkWoodwork();
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

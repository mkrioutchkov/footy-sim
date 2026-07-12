#pragma once
#include "rng.h"
#include "constants.h"
#include "types.h"
#include "ball_flight.h"
#include "pitch_zones.h"
#include "role_traits.h"
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

    // Ball-carrier diagnostics: stuck detection, backward-carry, carry distance,
    // stationary-hold — feeds quality-flag stats, does not steer play.
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
        // Marathon/shuttle carry flags (2026-07-02 user: "Tanaka dribbled non
        // stop for ages side to side, defenders in repeat patterns"): carry
        // start clock, amplitude-qualified lateral reversals (hysteresis peak
        // detection — carryPivotY is the y-extreme of the current committed
        // swing direction), and one-shot markers.
        double carryStartMs = 0;
        double carryStartX = 0;   // x at carry start — net forward-progress gate for the moving-marathon release
        // Facing at possession-gain: the clearance shank must measure "across
        // the body" against where he FACED when he won it — the body rotates
        // freely during even a 400ms hold, so the live facing reads square by
        // release and the shank never fired (seed 111 2:05, pid19's 43.6m
        // first-time switch at full pace).
        double carryStartFacing = 0;
        int carryRevsY = 0, carryLastDirY = 0;
        double carryPivotY = 0;
        bool marathonRecorded = false, shuttleRecorded = false;
        bool marathonReleased = false;   // one-shot: forced-release of a stuck long carry already fired

        int stationaryHoldCarrierId = -1;
        double stationaryHoldMs = 0;
        bool stationaryHoldRecorded = false;
    } carrierTracker;

    // Anti-stall watchdog: if a controlled ball sits still too long, nudge it.
    struct FreezeDetector {
        int simulationFreezes = 0;
        double freezeWatchMs = 0;
        double freezeBallX = 0, freezeBallY = 0;
        int freezeLastController = -1;
        double lastFreezeAlertMs = -1e9;
        double looseNearestD = 1e9;   // closest player to a stalled loose ball while it is watched
    } freezeDetector;

    struct GoalInfo {
        GoalSource source = GoalSource::None;
        Team scoringTeam = Team::Home;
        Team touchTeam = Team::Home;
        int toucherId = -1;
        double ballSpeed = 0;
    } lastGoal;

    // ── Game Logic State ──
    int teammatePingPongs = 0;
    double lastSameTeamCollectionMs = 0;
    std::optional<Team> lastCollectionTeam;
    // Last deliberate-risk launch (through/cross) — sticky past pendingPass
    // resolution so the senseless-out-of-play census can exclude an overhit
    // killer ball that runs dead AFTER the pass tracker already failed it.
    double lastRiskyBallMs = -1e9;
    int lastRiskyBallToucher = -1;
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

    // §weather feature-depth: match-level pitch condition affecting BALL physics. 0=clear (DEFAULT
    // -> zero effect, byte-identical default game), 1=rain/wet (the pitch greases the ball: it skids
    // further, shedding less rolling friction). Set from FOOTY_WEATHER env (or spec) before startMatch.
    // Kept ball-only + small on purpose. 2=wind (§v2): a seed-derived per-match wind vector drifts
    // AIRBORNE balls laterally (height-gated, so ground passes are immune -> passPct protected).
    int weather = 0;
    double windX = 0.0, windY = 0.0;   // §weather v2: per-match wind accel vector (units/s^2), seed-derived when weather==2

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
    // for a match report keyed on the shirt. One struct per player (was six
    // parallel arrays) — add a per-player stat by adding ONE field here.
    struct PlayerTally {
        int goals = 0;
        int assists = 0;
        int shots = 0;
        int tackles = 0;
        int passes = 0;           // pass attempts (match-rating input via --summary)
        int passesCompleted = 0;  // ...and completions (credited to pendingPass.fromId)
    };
    std::array<PlayerTally, 22> pStats = {};
    // Assist chain: who last fed this slot a completed pass, and when.
    std::array<int, 22> lastReceiveFrom = {};
    std::array<double, 22> lastReceiveMs = {};
    // When this player last WON possession off the opponent (intercept/clean
    // tackle). A fresh windfall high up opens the aggressive menu — long pot
    // shot / hard forward drive (owner, seed 111 1:13: Messi intercepted 31m
    // out, feinted backward, was dispossessed 2.3s later).
    std::array<double, 22> lastTurnoverWinMs = {};
    // Tackle lunge dash (seed 305 0:09/0:42: the round-11 commit-the-body snap
    // moved the tackler 60% of the gap in ONE tick ≈ 900px/s — read as a
    // teleport). Same commitment, now played out over the next few ticks at a
    // bounded burst pace in fixedUpdate (runs for controller and off-ball alike).
    std::array<double, 22> lungeDashDirX = {};
    std::array<double, 22> lungeDashDirY = {};
    std::array<double, 22> lungeDashRemainPx = {};
    // OffBallOverspeed tripwire: last-tick positions for the displacement
    // check in fixedUpdate. Invalidated on restarts/kickoffs/halves/subs so
    // legitimate repositioning teleports don't count.
    std::array<double, 22> qfPrevX = {};
    std::array<double, 22> qfPrevY = {};
    bool qfPrevValid = false;
    // Law 13-17 double-touch: the restart taker (FK/corner/throw/goal kick/
    // penalty/kickoff) may not touch again until another player has. Enforced
    // by prevention (the engine's referee idiom): set at release, cleared on
    // any other player's touch. -1 = nobody restricted.
    int restartRetouchBlockedId = -1;
    // Law 11 'gaining an advantage': offside snapshot at the SHOT — a teammate
    // in an offside position when the shot was struck may not play the rebound
    // (post/bar/keeper). Mirror of pendingPass.offsideAtPass for shots.
    std::array<bool, 22> offsideAtShot{};
    Team shotTeam = Team::Home;
    bool shotSnapshotLive = false;
    // Locked-body ricochet memory, RESTART ATTRIBUTION ONLY (Law 17 audit: a
    // real ricochet off a contest-locked defender's legs that ran behind his
    // own line restarted as a goal kick because lastToucher deliberately isn't
    // updated there). Never consulted for possession or offside.
    Team lastRicochetTeam = Team::Home;
    double lastRicochetMs = -1e9;
    // Law 12 back-pass: the keeper holding a ball deliberately KICKED to him
    // by a teammate is feet-only — no protected hold, no hold choreography,
    // no from-hands punt. Set at collect, cleared at release/next collect.
    bool gkHoldFeetOnly = false;
    // Carry touch texture (micro audit #1: the dribbled ball sat at a
    // mathematically constant offset — welded to the foot, zero touches).
    // Tracks distance traveled since the last knock so the control offset
    // breathes: push ahead at each stride-touch, close up in between.
    int    carryTouchCarrier = -1;
    double carryTouchTravel = 0.0, carryLastPx = 0.0, carryLastPy = 0.0;
    // Keeper-distribution choreography latch (set per tick in fixedUpdate):
    // while a GK holds the ball in his box, goal-kick shapes own everyone's
    // targets and executeAction defers (see the anti-swarm tombstone).
    bool keeperHoldChoreo = false;
    // Own-corner-concession census: last DELIBERATE outfield kick (pass/clear),
    // so awardCorner can flag a corner gifted by the conceder's own boot.
    double lastDeliberateKickMs = -1e9;
    int lastDeliberateKickToucher = -1;
    // Goal-source tagging: the most recent restart RELEASE (kick actually taken).
    double lastRestartReleaseMs = -1e9;
    SetPiece lastRestartReleaseType = SetPiece::None;
    void creditGoal(int scorerId);

    struct SetPieceState {
        bool armed = false;
        SetPiece type = SetPiece::None;
        Team team = Team::Home;
        int takerId = -1;
        double spotX = 0, spotY = 0;
        bool takerArrived = false;
        bool fast = false;   // rare sneaky quick free kick: skip the full hold, play it before the defense sets
        double walkMs = 0;   // time spent trying to reach the ball — backstop against a never-arriving taker
        // Out-ball glide: for corner/throw/goal-kick awards the ball keeps
        // ROLLING out under friction until this clock, then snaps to the spot —
        // it used to teleport mid-flight ("goal kicks look weird"). 0 = placed.
        double placeBallAtMs = 0;
        // Free-kick RUN-UP (owner: "free kicks especially shot ones should have
        // run ups"). Planned ONCE when the FK taker reaches the ball: he holds at
        // (runUpStartX,runUpStartY) — a few steps behind the ball along the strike
        // axis, angled to the side for a shot — then dashes along (runUpDir) THROUGH
        // the ball in the last RUNUP_LEAD_MS and strikes on arrival. Geometry+ids
        // only, no rng. runUpActive=false ⇒ legacy stand-and-poke (fast FK / other
        // restarts / the never-arrived backstop path).
        bool runUpActive = false;
        double runUpStartX = 0, runUpStartY = 0;
        double runUpDirX = 0, runUpDirY = 0;
        std::string reason;
    } setPiece;

    // A played advantage: the ref waved a foul on because the fouled side kept the
    // ball. If they LOSE it to the offending team within the window, the ref brings
    // the free kick BACK to the foul spot (real-ref recall); otherwise it stands.
    // Set on grant in attemptTackle, resolved atop fixedUpdate, cleared on kickoff.
    struct AdvantageState {
        bool active = false;
        Team team = Team::Home;        // the FOULED side — gets the FK if recalled
        double foulX = 0, foulY = 0, grantMs = 0;
    } advantage;

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
    // USERWATCH B: situational keeper distribution tempo — the hold time before the keeper
    // releases, keyed on score + clock + pressure (rush chasing/late, hold leading/seeing-out/
    // unpressured) instead of the old uniform GK_DISTRIBUTE_MS.
    double gkDistributeMs(const Player& gk) const;
    // Gaylord seam (16:48): engine id of the designated taker for this set-piece type on this
    // team (fk/corner/pen/long_throw_taker directive), or -1 => default position-based pick.
    int designatedTakerFor(SetPiece type, Team team);

    // Goal-kick distribution window: the active goal-kick + a release/timeout timer.
    struct GKMonitor {
        double distributeTimer = 0;
        bool active = false;
        Team team = Team::Home;
        double startedMs = 0;
        double holdSinceMs = -1;   // clock when the keeper began HOLDING for a lane (-1 = not holding)
    } goalKickMonitor;

    std::array<double, 22> contestBlockedUntil = {};
    // Render-only facing: a display copy of each player's facing that damps rapid
    // direction reversals, so a jockeying defender doesn't shimmer ~30deg
    // left-right in the watch view. NEVER read by logic (tackle geometry/dribble
    // use the raw Player::facing) — purely the getJSON output, so gameplay is
    // byte-identical. updated each tick after finalizeVelocities.
    std::array<double, 22> renderFacing = {};
    bool renderFacingInit = false;
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
    double activeShieldUntil[22] = {0};   // carrier actively shielding + working a pass angle: tackle RESISTANCE (not the receive-grace immunity)
    struct PendingPass {
        bool active = false;
        int fromId = -1, toId = -1;
        Team team = Team::Home;
        bool isCross = false;
        bool isThrough = false;
        bool isCutback = false;   // render-hint only: in-flight ball is a pulled-back cutback (Gaylord's box-finish lime cue); never read by gameplay
        bool offsideExempt = false;
        // The law judges the receiver's position at the MOMENT the ball is
        // played — captured here; judging at collection flagged legal runs.
        bool receiverOffsideAtPass = false;
        double passerX = 0.0;
        double passerY = 0.0;
        double offsideLine = 0.0;
        // Every attacking teammate's offside status AT THE PASS (the law) — judges an
        // UNINTENDED collector by his pass-time position, not where he chased the ball to.
        std::array<bool, 22> offsideAtPass{};
        // Pass-decision audit, carried to the interception site (FOOTY_PASSDEBUG).
        double auComp = 0.0; int auBlk = 0; int auPress = 0; double auFwd = 0.0;
        double auSafer = 0.0; int auSaferId = -1;
        // Suicide-pass audit (seed 111 1:13): own-third lateral/backward ball
        // released with an already-closing lane defender who wins the race.
        // Armed at release; the flag fires only if the ball is actually cut
        // within 800ms (spec confirmed on the Chiellini->Van Dijk turnover).
        bool suicideRisk = false;
        double releaseMs = 0.0;
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
    LooseOrigin lastLooseOrigin = LooseOrigin::None;
    int woodworkCooldown = 0;   // W1: ticks to skip the woodwork check after a hit so the rebound clears the band (no re-collision / stick)
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
    std::array<Config, 2> baseConfig;   // [0]=home, [1]=away base tactic dials (from the roster/manager)
    // Runtime dial deltas set by team-wide directives ("park the bus", "all out
    // attack", "high press" ...). [0]=home, [1]=away. Rebuilt every tick by
    // applyDirectives (pure clock+score function, no rng), added on top of the
    // base config in configFor and clamped. All-zero = no override.
    struct ConfigDelta { double aggression=0, passingDirectness=0, overlapFrequency=0, midfieldFreedom=0, defensiveLineHeight=0; };
    std::array<ConfigDelta, 2> dialOverride{};
    // Per-team directive hooks — extra tactical state set each tick by
    // applyDirectives, layered on top of the 5 base dials in Config. [0]=home,
    // [1]=away. All-zero = no directive, so the no-directive match is byte-
    // identical. Adding a plain-English directive is now ONE field here (+ its
    // set in applyDirectives and read at the relevant scorer).
    struct TeamTactics {
        double longBallBias = 0;        // play_it_long: long-ball gamble bias (pass scorer, NOT a dial)
        double slowTempo = 0;           // slow_it_down: safe-pass / anti-risk bias in scorePassToTarget
        double counterAttackBonus = 0;  // counter_attack: quick-transition through-ball + off-ball-run amplifier
        double shootDistBias = 0;       // shoot_from_distance / work_it_into_box: ± px on each shooter's max range
        bool   offsideTrapActive = false;   // offside_trap: hold the line high in the danger zone
        bool   allOutActive = false;        // all_out_attack: commit the overlap FB + a CM forward
        bool   defenseHoldingShape = false; // mid-block this tick — drop this team's forwards out of the build-up zone
    };
    std::array<TeamTactics, 2> teamTactics{};
    [[nodiscard]] Config configFor(Team team) const {
        Config c = baseConfig[teamIndex(team)];
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
        } else if (diff > 0 && minLeft < 22.0) {
            // E4 (game-state realism): a side protecting a lead drops off EARLIER and deeper as the
            // lead grows + the clock runs down — was a FLAT -8/-12 only inside 15min, so a 1-0 side
            // at 70' sat neutral and invited the comeback. Scaled like the chasing push but gentler
            // (a winning team manages the game, it doesn't panic). Pure score+clock, determinism holds.
            double protect = clamp((22.0 - minLeft) / 22.0, 0.0, 1.0) * (0.7 + 0.3 * clamp((double)(diff - 1), 0.0, 2.0));
            c.aggression -= 12.0 * protect;
            c.defensiveLineHeight -= 16.0 * protect;
            c.passingDirectness -= 7.0 * protect;
        }
        c.aggression = clamp(c.aggression, 0.0, 100.0);
        c.passingDirectness = clamp(c.passingDirectness, 0.0, 100.0);
        c.overlapFrequency = clamp(c.overlapFrequency, 0.0, 100.0);
        c.midfieldFreedom = clamp(c.midfieldFreedom, 0.0, 100.0);
        c.defensiveLineHeight = clamp(c.defensiveLineHeight, 0.0, 100.0);
        return c;
    }
    [[nodiscard]] double offsideLineFor(Team t) const;
    [[nodiscard]] double midlineFor(Team t) const;   // opp central-midfield avg x (top of the pocket; drift_into_pocket)
    [[nodiscard]] bool checkOffside(const Player& receiver, const Player& passer) const;
    void awardOffsideFreeKick(Team defTeam, const Player& offsidePlayer);
    [[nodiscard]] bool isOffsideTarget(const Player& passer, const Player& receiver) const;
    [[nodiscard]] bool isOffsideTargetPerceived(const Player& passer, const Player& receiver) const;
    // Per-player defensive marching order, rebuilt each tick by updateTeamAssignments
    // / assignDefensiveRoles and consumed by the agents: which task (press, mark,
    // lane-block, box-guard…), which opponent to mark, and where to stand.
    struct AgentTeamAssignment { DefensiveTask role = DefensiveTask::None; int opponentId=-1; double targetX=0, targetY=0; };
    std::array<AgentTeamAssignment, 22> assignmentByPlayer = {};
    // Marking hysteresis (seed 133 10:39 goal: one CB's assignment flip-flopped
    // SEVEN times in 8s between a corner decoy and the central cover zone —
    // per-tick wipe-and-rebuild lets near-equal candidates thrash, so he
    // covered neither and the scorer's zone sat empty). A held MAN-mark now
    // persists >=900ms; while held, the target is re-derived from the marked
    // opponent's CURRENT position (mark maintenance), so it never goes stale.
    struct AssignLock { DefensiveTask role = DefensiveTask::None; int oppId = -1; double changedMs = -1e9; };
    std::array<AssignLock, 22> assignLock = {};
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
    [[nodiscard]] bool isActiveShield(int playerId) const { return playerId>=0&&playerId<22&&state.clockMs<activeShieldUntil[playerId]; }
    void markActiveShield(int playerId){ if(playerId>=0&&playerId<22) activeShieldUntil[playerId]=state.clockMs+220.0; }
    bool canContestBall(Player& player);
    // True if an active outfield opponent is within `radius` of the keeper —
    // a crowded keeper is likelier to punch/parry than gather cleanly.
    [[nodiscard]] bool gkUnderPressure(const Player& gk, double radius) const;
    [[nodiscard]] bool canKnockBallAhead(int playerId) const {
        return !activeKnockAhead.active && knockAheadCooldownUntil[playerId] <= state.clockMs;
    }
    [[nodiscard]] bool isActiveKnockAheadRunner(int playerId) const { return activeKnockAhead.active&&activeKnockAhead.playerId==playerId; }

    // ── Actions ──

    bool knockBallAhead(Player&, double, double);
    void resolveKnockAhead(Player* collector, const std::string& stopped = "");
    void emitEvent(const std::string&, double, double, int=-1, int=-1, bool traceOnly=false);
    void blockReboundFor(int playerId, double ms);
    void recordBallImpulse();
    void beginTrackedPass(Player& from, Player& to, bool isCross = false, bool isThrough = false, bool isCutback = false);
    bool resolvePendingPass(Player& receiver);
    void auditStuckCarrier(double sdt);
    // FOOTY_BLOBDEBUG=1: stderr-log each 6+-players-in-50px knot with every
    // member's chosen action/purpose — the attribution the crowding ticket
    // needs (blob probe showed balanced 3v3 knots; WHY each man is there is
    // invisible in traces). Env-gated; default off = byte-identical.
    void auditBlobPurposes();
    double blobLogNextMs = 0;
    // Carry-glue convergence bookkeeping: updateControlledBall runs 2-3x per
    // tick (phase glue + intra-move re-anchors) — the capped step toward the
    // control offset must apply ONCE per tick or receptions double-step.
    double glueStepDoneMs = -1;
    double lineDepthNextMs = 0;   // 1s sampler for the line-too-deep quality flag
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
    void applyWhipDelivery(double dist, double speed, double goalX, double curlMin, double curlRange, const Player* crosser = nullptr);
    bool passBallTo(Player& f, Player& t, bool throughBall, bool lob, const PassSelectionAudit* selectionAudit, bool secure = false);
    void forcePassTo(Player& f, Player& t, const PassSelectionAudit*);
    bool attemptTackle(Player& tackler, Player& carrier, double extraReach = 0.0);
    void resolveTackleFoul(Player& tackler, Player& carrier, bool fromBehind, bool cynical, double boxFoulScale);
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
        std::array<int, 11> feet{ 1,1,1,1,1,1,1,1,1,1,1 };   // +1 R / -1 L / 0 both ("foot" spec key)
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
        StayWide, ComeInside, CutInside, OverlapRun, StayCentral,
        CrossEarly, SwitchPlay, PlaySimple, Cutback,
        RunInBehind, MakeRuns, ComeShort, DriftIntoPocket, DribbleMore, StayBack,
        TargetManHoldup, BallPlaying,
        PressHard, TackleHard, StayOnFeet, Contain,
        // ── set-piece taker designations (per-player; playerId = the designated taker) ──
        FkTaker, CornerTaker, PenTaker, LongThrowTaker,
        // ── team-wide dial commands (teamScope >= 0, playerId unused) ──
        AllOutAttack, ParkTheBus, HighPress, DropOff, PlayItLong,
        KeepItOnGround, GetItWide, PlayNarrow, PushUp, SlowItDown,
        CounterAttack, OffsideTrap, ShootFromDistance, WorkItIntoBox,
        // ── tactical-depth continuous dials (team-wide; intensity is the slider 0-1, 0.5=neutral) ──
        PressIntensity, Mentality, LineHeight,
    };
    enum class CondScore : uint8_t { Any, Winning, Drawing, Losing };
    enum class CondPhase : uint8_t { Any, InPossession, OutOfPossession, Transition };
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
        CondPhase phase = CondPhase::Any;           // active only in this possession phase (in/out/transition)
    };
    std::vector<Directive> directives;
    // Per-player score nudges the scorers read THIS tick; rebuilt every tick by
    // applyDirectives() (stateless, so deterministic).
    struct DirectiveBias { bool shootOnSight=false; int passTargetId=-1; double passTargetBias=0.0; double overlapBias=0.0;
        bool crossEarly=false; double switchBias=0.0; double simplifyBias=0.0; double cutbackBias=0.0;
        double runAheadBias=0.0; double comeShortBias=0.0; double pocketBias=0.0; double cutInsideBias=0.0; double dribbleBonus=0.0; double stayBackBias=0.0;
        double holdUpBias=0.0;
        bool   ballPlaying=false;   // "ball-playing CB": step out + carry/progress the ball from the back
        // gk_up_for_corners: 1.0 = keeper joins every late attacking corner;
        // 0.5 = only late AND behind. 0 = never (default).
        double gkUpForCorners = 0.0;
        double pressTightness=0.0; double tackleAggression=0.0; double stayOnFeet=0.0; double containBias=0.0; };
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
        int team = -1;   // §1.3/§4: which side this entry replaces (0=home, 1=away); -1 = both (back-compat)
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
    std::vector<TimelineEntry> liveCommandQueue;   // §1.3b: live inject overlay (stdin/scheduler), drained by applyLiveCommands at atMs<=clock
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
    void applyDirectiveEntry(const TimelineEntry& e);   // §1.3: shared timeline+live-inject entry apply (team-scoped)
    void applyLiveCommands();   // §1.3b: drain liveCommandQueue (atMs<=clock) via applyDirectiveEntry (per-team)

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
    // holdMs: how long the teams stand in formation before the tap. Opening /
    // second-half kickoffs use the short default; a post-goal kickoff passes a
    // longer hold (the celebration-and-reset breather).
    void kickoff(Team t, double holdMs = 1500.0);
    void update(double dM);
    bool step();   // §1.4 LIVE: one fixed tick, returns false at full-time (while(step()) loop + runner-ready)
    void fixedUpdate(double sdt);
    void tickAgents(double sdt, bool ic);
private:
    bool initialized_ = false;   // one-shot guard: GameEngine is one-match-per-instance (initWithSeed)
    void cacheBallState();
    void updatePlayerAnimations(double sdt);
    void updatePossessionTracking(double sdt);
    void trackCarrierPossession(Player* c, double sdt);
    void detectSimulationFreeze(double sdt);
    void updateSetPiecePhase(double sdt, double sec);
    void populateThrowInSupport(Team spTeam);
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
    // Chase aid: forward-simulate the ball (drag/gravity/bounce, no bodies) to
    // where it will actually be tAhead seconds out — see engine_physics.cpp.
    void predictBallPos(double tAhead, double& outX, double& outY) const;
    bool checkGoal();
    bool checkWoodwork();
    bool checkOutOfPlay();
    bool tryCutbackFirstTimeFinish(double bs);
    bool tryKeeperLooseGather(double bs);
    bool tryKeeperCrossClaim();
    Player* findBallContact(double sec, double& contactRadius);
    void resolveBallContact(double sec);
    bool tryIntendedReceiverMeet(double bs);
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

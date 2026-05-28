#pragma once

#include "types.h"
#include "constants.h"
#include "rng.h"
#include <vector>
#include <string>
#include <algorithm>
#include <cmath>
#include <optional>

// ── Forward declare GameEngine ────────────────────────────────────────────────
class GameEngine;

// ── Former chase collection envelope (counts now-rejected stale steals) ──────
inline constexpr double PRE_CONTACT_CHASE_REACH = 36.4;

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
    std::string type;
    double      score   = 0;
    Player*     target  = nullptr;
    double      posX    = 0;
    double      posY    = 0;
    std::string purpose;
    ActionAudit audit;
};

struct GameContext {
    int    scoreDiff = 0;
    double timeLeft  = 0;
    int    half      = 1;
    double urgency   = 0;
};

struct Perception {
    double              ballDist      = 0;
    bool                ballIsLoose   = false;
    std::string         ballControllerTeam;   // empty = null
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
    std::string purpose;
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
        facing = (player.team == "home") ? 0.0 : 3.141592653589793;
    }

    virtual ~PlayerAI() = default;
    virtual void tick(double sdt);
    double dizzyRotationAccum = 0;
    double dizzyWindowStartMs = 0;

private:
    int    stunLockTicks = 0;
    int    shotCooldown = 0;
    int    perceptionAge = 0;
    std::optional<Perception> cachedPerception;

    int    holdTicks = 0;
    double lastPosX = 0, lastPosY = 0;

    std::string lastActionType;
    std::string lastPurpose;
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
    Action                scoreShot(const Perception& per, const GameContext& ctx);
    Action                scoreDribble(const Perception& per, const GameContext& ctx);
    Action                scoreTackle(const Perception& per, const GameContext& ctx);
    Action                scoreMark(const Perception& per, const GameContext& ctx);
    Action                scoreChase(const Perception& per);
    std::vector<Action>   scorePositioning(const Perception& per, const GameContext& ctx);
    Action                resolveChoice(std::vector<Action>& actions);
    void                  executeAction(Action& action, double sdt, std::vector<Action>& actions);
    Perception            getCachedPerception();
    Perception            perceive();
    void                  applyMovement(double sdt);
    void                  tryCollectAfterChase();
    void                  auditDefensiveMovement(const Action& choice);
    PassSelectionAudit    passSelectionAudit(const Action& choice, const std::vector<Action>& actions);
    ShotSelectionAudit    shotSelectionAudit(const Action& choice, const std::vector<Action>& actions);
};

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

struct AgentManagerConfig {
    double aggression        = 50.0;
    double passingDirectness = 50.0;
};

struct AgentTeamAssignment {
    std::string role;
    double targetX = 0;
    double targetY = 0;
    int    opponentId = -1;
};

struct AgentCommitRun {
    double targetX = 0;
    double targetY = 0;
};

struct AgentRecentPass {
    double bx = 0, by = 0;
    double vx = 0, vy = 0;
    std::string team;
    double clockMs = 0;
};

// ══════════════════════════════════════════════════════════════════════════════
// PlayerAgent class
// ══════════════════════════════════════════════════════════════════════════════

class PlayerAgent {
public:
    Player&     player;
    GameEngine& engine;

    PlayerAgent(Player& p, GameEngine& e)
        : player(p), engine(e)
    {
        facing = (player.team == "home") ? 0.0 : 3.141592653589793;
    }

    void tick(double sdt);
    double dizzyRotationAccum = 0;
    double dizzyWindowStartMs = 0;

private:
    int    sl = 0;
    int    sc = 0;
    int    pa = 0;
    std::optional<Perception> ch;

    int    ht = 0;
    double lx = 0, ly = 0;

    std::string la;
    std::string lastPurpose;
    int    lt = -1;
    int    lp = -1;

    double facing = 0;

    int    recentPassTarget = -1;
    double recentPassTime   = 0;

    double ballMemX   = 0;
    double ballMemY   = 0;
    int    ballMemAge = 0;

    GameContext           ctx();
    std::vector<Action>   ev(const Perception& per, bool ic, const GameContext& ctx);
    std::vector<Action>   cp(const Perception& per, const GameContext& ctx);
    Action                cs(const Perception& per, const GameContext& ctx);
    Action                cd(const Perception& per, const GameContext& ctx);
    Action                ct(const Perception& per, const GameContext& ctx);
    Action                cm(const Perception& per, const GameContext& ctx);
    Action                cc(const Perception& per);
    std::vector<Action>   bp(const Perception& per, const GameContext& ctx);
    Action                rc(std::vector<Action>& a);
    void                  ex(Action& a, double sdt, std::vector<Action>& actions);
    Perception            gp();
    Perception            pr();
    void                  am(double sdt);
    void                  tryCollectAfterChase();
    void                  auditDefensiveMovement(const Action& choice);
    PassSelectionAudit    passSelectionAudit(const Action& choice, const std::vector<Action>& actions);
    ShotSelectionAudit    shotSelectionAudit(const Action& choice, const std::vector<Action>& actions);
};

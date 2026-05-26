#pragma once
#include <string>
#include <string_view>
#include <vector>
#include <optional>
#include <unordered_map>

using Team = std::string_view;

struct PlayerAttributes {
    double speed       = 50.0;
    double passing     = 50.0;
    double creativity  = 50.0;
    double shooting    = 50.0;
    double tackling    = 50.0;
    double positioning = 50.0;
    double stamina     = 95.0;
};

struct Player {
    int id;
    std::string name;
    std::string team;
    std::string role;
    double x, y;
    double vx = 0, vy = 0;
    double targetX, targetY;
    double homeX, homeY;
    double stamina = 100.0;
    PlayerAttributes attrs;
    double facing      = 0.0;
    double tackleAnim  = 0.0;
    double headingAnim = 0.0;
    double crossCollected = 0.0;
    int    dribbleType = 0;
    int    lastPassTarget = -1;
    double lastPassTime = 0;
    int    actionCooldown = 0;
};

struct Ball {
    double x = 525.0, y = 340.0;
    double vx = 0.0, vy = 0.0, z = 0.0, vz = 0.0;
    int    controllerId    = -1;
    int    intendedReceiverId = -1;
    std::string lastTouchTeam;
    int    lastToucherId = -1;
};

struct TeamBlackboard {
    int pressingPlayerId  = -1;
    int pressingPlayerId2 = -1;
    std::unordered_map<int, int> markedOpponents;
    struct OneTwo { int from, to; double expires; };
    std::optional<OneTwo> oneTwo;
};

struct EngineState {
    std::vector<Player> players;
    Ball ball;
    double clockMs    = 0.0;
    std::string matchState = "not_started";
    double speed      = 1.0;
    int homeScore = 0, awayScore = 0;
    int homeShots = 0, awayShots = 0;
    double possessionPct = 50.0;
    int half = 1;
    std::string version;
};

struct MatchResult {
    double clockMs;
    int homeScore, awayScore;
    int homeShots, awayShots;
    int passes;
    double passCompletion;
    double goalsPerMatch;
    double shotsPerMatch;
    double shotsOnTargetPct;
    double goalsPerShotPct;
};

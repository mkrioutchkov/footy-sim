#pragma once
#include <string>
#include <string_view>
#include <vector>
#include <optional>
#include <unordered_map>
#include <cstdint>

// ── Enum types ──

enum class Team : uint8_t { Home = 0, Away = 1 };
enum class Role : uint8_t { GK = 0, CB, FB, CM, WM, CF };
enum class MatchState : uint8_t { NotStarted, Running, Finished };
enum class ActionType : uint8_t { Pass, Shoot, Dribble, Tackle, Mark, Chase, Position, Hold };
enum class SetPieceType : uint8_t { None, FreeKick, ThrowIn, GoalKick };
enum class ActionPurpose : uint8_t { Keep, Build, Cross, Cutback, Through, Clear, Switch, Space, Offer, Cover };

// ── Conversion functions ──

inline constexpr std::string_view to_string(Team t) { return t == Team::Home ? "home" : "away"; }
inline constexpr std::string_view to_string(Role r) {
    switch (r) {
        case Role::GK: return "GK"; case Role::CB: return "CB"; case Role::FB: return "FB";
        case Role::CM: return "CM"; case Role::WM: return "WM"; case Role::CF: return "CF";
    }
    return "CM";
}
inline constexpr std::string_view to_string(MatchState s) {
    switch (s) {
        case MatchState::NotStarted: return "not_started";
        case MatchState::Running: return "running";
        case MatchState::Finished: return "finished";
    }
    return "not_started";
}
inline constexpr std::string_view to_string(ActionType a) {
    switch (a) {
        case ActionType::Pass: return "pass"; case ActionType::Shoot: return "shoot";
        case ActionType::Dribble: return "dribble"; case ActionType::Tackle: return "tackle";
        case ActionType::Mark: return "mark"; case ActionType::Chase: return "chase";
        case ActionType::Position: return "position"; case ActionType::Hold: return "hold";
    }
    return "hold";
}
inline constexpr std::string_view to_string(SetPieceType s) {
    switch (s) {
        case SetPieceType::None: return ""; case SetPieceType::FreeKick: return "free_kick";
        case SetPieceType::ThrowIn: return "throw_in"; case SetPieceType::GoalKick: return "goal_kick";
    }
    return "";
}
inline constexpr std::string_view to_string(ActionPurpose p) {
    switch (p) {
        case ActionPurpose::Keep: return "keep"; case ActionPurpose::Build: return "build";
        case ActionPurpose::Cross: return "cross"; case ActionPurpose::Cutback: return "cutback";
        case ActionPurpose::Through: return "through"; case ActionPurpose::Clear: return "clear";
        case ActionPurpose::Switch: return "switch"; case ActionPurpose::Space: return "space";
        case ActionPurpose::Offer: return "offer"; case ActionPurpose::Cover: return "cover";
    }
    return "keep";
}

inline Team teamFromString(std::string_view s) { return s == "home" ? Team::Home : Team::Away; }
inline Role roleFromString(std::string_view s) {
    if (s == "GK") return Role::GK; if (s == "CB") return Role::CB; if (s == "FB") return Role::FB;
    if (s == "CM") return Role::CM; if (s == "WM") return Role::WM; return Role::CF;
}
inline MatchState matchStateFromString(std::string_view s) {
    if (s == "running") return MatchState::Running;
    if (s == "finished") return MatchState::Finished;
    return MatchState::NotStarted;
}

inline constexpr int teamIndex(Team t) { return static_cast<int>(t); }
inline constexpr Team teamFromIndex(int i) { return static_cast<Team>(i); }

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

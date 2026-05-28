#pragma once
#include <string>
#include <string_view>
#include <vector>
#include <optional>
#include <unordered_map>
#include <cstdint>

// ── Enums ──

enum class Team : uint8_t { Home = 0, Away = 1 };
enum class Role : uint8_t { GK = 0, CB, FB, CM, WM, CF };
enum class ActionType : uint8_t { Pass, Shoot, Dribble, Tackle, Mark, Chase, Position, Hold };
enum class ActionPurpose : uint8_t { Keep, Build, Cross, Cutback, Through, Clear, Switch, Space, Offer, Cover };

inline constexpr std::string_view to_string(Team t) { return t == Team::Home ? "home" : "away"; }
inline constexpr std::string_view to_string(Role r) {
    switch (r) {
        case Role::GK: return "GK"; case Role::CB: return "CB"; case Role::FB: return "FB";
        case Role::CM: return "CM"; case Role::WM: return "WM"; case Role::CF: return "CF";
    }
    return "CM";
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
inline Team teamFromStr(std::string_view s) { return s == "home" ? Team::Home : Team::Away; }
inline Role roleFromStr(std::string_view s) {
    if (s == "GK") return Role::GK; if (s == "CB") return Role::CB; if (s == "FB") return Role::FB;
    if (s == "CM") return Role::CM; if (s == "WM") return Role::WM; return Role::CF;
}
inline constexpr int teamIndex(Team t) { return static_cast<int>(t); }
inline int teamIndex(const std::string& team) { return team == "home" ? 0 : 1; }

// ── Data structs ──

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
    Team  team = Team::Home;
    Role  role = Role::CM;
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
};

struct Ball {
    double x = 525.0, y = 340.0;
    double vx = 0.0, vy = 0.0, z = 0.0, vz = 0.0;
    int    controllerId    = -1;
    int    intendedReceiverId = -1;
    Team   lastTouchTeam = Team::Home;
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
};

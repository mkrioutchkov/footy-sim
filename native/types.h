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
enum class ActionPurpose : uint8_t { Keep=0, Build, Cross, Cutback, Through, Clear, Switch, Space, Offer, Cover, KeeperBackpass, RecoverLoose, RecoverOwnTouch, MeetIncoming, Receive, CounterOutlet, RestForward, Observe, RunAhead, InsideRun, HoldWidth, Overlap, CrossLane, EmergCloseDown, LocalCloseDown, Task };

// ── Defensive task role (was string) ──
enum class DefensiveTask : uint8_t {
    None = 0, PrimaryPress, SecondaryPress, ShotLane, Cover,
    CrossLane, LaneBlock, BoxGuard, FarPostGuard, NearPostGuard,
    CutbackGuard, DefensiveLine, WideCover, MidfieldScreen, BoxScreen,
    SupportOutlet, AdvanceMidfield, RunAhead, InsideRun, HoldWidth,
    Overlap, RestDefence, CloseDown, LocalCloseDown, EmergencyCloseDown
};

// ── Set piece type (was string) ──
enum class SetPiece : uint8_t { None = 0, Corner, Penalty, FreeKick, ThrowIn, GoalKick };

// ── Pitch area for position-aware behavior ──  
enum class PitchArea : uint8_t {
    OwnBox, OwnThird, MidThird, FinalThird, OppBox,
    WideLeft, WideRight, Central
};

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
        case ActionPurpose::KeeperBackpass: return "keeper_backpass";
        case ActionPurpose::RecoverLoose: return "recover_loose_ball";
        case ActionPurpose::RecoverOwnTouch: return "recover_own_touch";
        case ActionPurpose::MeetIncoming: return "meet_incoming_ball";
        case ActionPurpose::Receive: return "receive_ball";
        case ActionPurpose::CounterOutlet: return "counter_outlet";
        case ActionPurpose::RestForward: return "rest_forward";
        case ActionPurpose::Observe: return "observe";
        case ActionPurpose::RunAhead: return "run_ahead";
        case ActionPurpose::InsideRun: return "inside_run";
        case ActionPurpose::HoldWidth: return "hold_width";
        case ActionPurpose::Overlap: return "overlap";
        case ActionPurpose::CrossLane: return "cross_lane";
        case ActionPurpose::EmergCloseDown: return "emergency_close_down";
        case ActionPurpose::LocalCloseDown: return "local_close_down";
        case ActionPurpose::Task: return "task";
    }
    return "keep";
}
inline constexpr std::string_view to_string(DefensiveTask dt) {
    switch (dt) {
        case DefensiveTask::None: return "none";
        case DefensiveTask::PrimaryPress: return "primary_press";
        case DefensiveTask::SecondaryPress: return "secondary_press";
        case DefensiveTask::ShotLane: return "shot_lane";
        case DefensiveTask::Cover: return "cover";
        case DefensiveTask::CrossLane: return "cross_lane";
        case DefensiveTask::LaneBlock: return "lane_block";
        case DefensiveTask::BoxGuard: return "box_guard";
        case DefensiveTask::FarPostGuard: return "far_post_guard";
        case DefensiveTask::NearPostGuard: return "near_post_guard";
        case DefensiveTask::CutbackGuard: return "cutback_guard";
        case DefensiveTask::DefensiveLine: return "defensive_line";
        case DefensiveTask::WideCover: return "wide_cover";
        case DefensiveTask::MidfieldScreen: return "midfield_screen";
        case DefensiveTask::BoxScreen: return "box_screen";
        case DefensiveTask::SupportOutlet: return "support_outlet";
        case DefensiveTask::AdvanceMidfield: return "advance_midfield";
        case DefensiveTask::RunAhead: return "run_ahead";
        case DefensiveTask::InsideRun: return "inside_run";
        case DefensiveTask::HoldWidth: return "hold_width";
        case DefensiveTask::Overlap: return "overlap";
        case DefensiveTask::RestDefence: return "rest_defence";
        case DefensiveTask::CloseDown: return "close_down";
        case DefensiveTask::LocalCloseDown: return "local_close_down";
        case DefensiveTask::EmergencyCloseDown: return "emergency_close_down";
    }
    return "none";
}
inline constexpr std::string_view to_string(SetPiece sp) {
    switch (sp) {
        case SetPiece::None: return "none";
        case SetPiece::Corner: return "corner";
        case SetPiece::Penalty: return "penalty";
        case SetPiece::FreeKick: return "free_kick";
        case SetPiece::ThrowIn: return "throw_in";
        case SetPiece::GoalKick: return "goal_kick";
    }
    return "none";
}
inline DefensiveTask defensiveTaskFromStr(std::string_view s) {
    if (s == "primary_press") return DefensiveTask::PrimaryPress;
    if (s == "secondary_press") return DefensiveTask::SecondaryPress;
    if (s == "shot_lane") return DefensiveTask::ShotLane;
    if (s == "cover") return DefensiveTask::Cover;
    if (s == "cross_lane") return DefensiveTask::CrossLane;
    if (s == "lane_block") return DefensiveTask::LaneBlock;
    if (s == "box_guard") return DefensiveTask::BoxGuard;
    if (s == "far_post_guard") return DefensiveTask::FarPostGuard;
    if (s == "near_post_guard") return DefensiveTask::NearPostGuard;
    if (s == "cutback_guard") return DefensiveTask::CutbackGuard;
    if (s == "defensive_line") return DefensiveTask::DefensiveLine;
    if (s == "wide_cover") return DefensiveTask::WideCover;
    if (s == "midfield_screen") return DefensiveTask::MidfieldScreen;
    if (s == "box_screen") return DefensiveTask::BoxScreen;
    if (s == "support_outlet") return DefensiveTask::SupportOutlet;
    if (s == "advance_midfield") return DefensiveTask::AdvanceMidfield;
    if (s == "run_ahead") return DefensiveTask::RunAhead;
    if (s == "inside_run") return DefensiveTask::InsideRun;
    if (s == "hold_width") return DefensiveTask::HoldWidth;
    if (s == "overlap") return DefensiveTask::Overlap;
    if (s == "rest_defence") return DefensiveTask::RestDefence;
    if (s == "close_down") return DefensiveTask::CloseDown;
    return DefensiveTask::None;
}
inline SetPiece setPieceFromStr(std::string_view s) {
    if (s == "corner") return SetPiece::Corner;
    if (s == "penalty") return SetPiece::Penalty;
    if (s == "free_kick") return SetPiece::FreeKick;
    if (s == "throw_in") return SetPiece::ThrowIn;
    if (s == "goal_kick") return SetPiece::GoalKick;
    return SetPiece::None;
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

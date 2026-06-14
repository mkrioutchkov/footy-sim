#include "types.h"

DefensiveTask defensiveTaskFromStr(std::string_view s) {
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

SetPiece setPieceFromStr(std::string_view s) {
    if (s == "corner") return SetPiece::Corner;
    if (s == "penalty") return SetPiece::Penalty;
    if (s == "free_kick") return SetPiece::FreeKick;
    if (s == "throw_in") return SetPiece::ThrowIn;
    if (s == "goal_kick") return SetPiece::GoalKick;
    return SetPiece::None;
}

QualityFlag qualityFlagFromStr(std::string_view s) {
    if (s == "why_no_shoot") return QualityFlag::WhyNoShoot;
    if (s == "questionable_backpass") return QualityFlag::QuestionableBackpass;
    if (s == "clear_path_shoot") return QualityFlag::ClearPathShoot;
    if (s == "clear_path_drive") return QualityFlag::ClearPathDrive;
    if (s == "time_wasting_dribble") return QualityFlag::TimeWastingDribble;
    if (s == "backward_dribble") return QualityFlag::BackwardDribble;
    if (s == "why_player_running_direction") return QualityFlag::WhyPlayerRunningDirection;
    if (s == "stationary_hold_500ms") return QualityFlag::StationaryHold500ms;
    return QualityFlag::Unknown;
}

Team teamFromStr(std::string_view s) { return s == "home" ? Team::Home : Team::Away; }

Role roleFromStr(std::string_view s) {
    if (s == "GK") return Role::GK; if (s == "CB") return Role::CB; if (s == "FB") return Role::FB;
    if (s == "CM") return Role::CM; if (s == "WM") return Role::WM; return Role::CF;
}

int teamIndex(const std::string& team) { return team == "home" ? 0 : 1; }

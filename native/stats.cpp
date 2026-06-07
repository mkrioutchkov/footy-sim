#include "stats.h"
#include "nlohmann/json.hpp"

namespace {
void countRole(Role role, int& gk, int& cb, int& fb, int& cm, int& wm, int& cf) {
    switch (role) {
        case Role::GK: gk++; break;
        case Role::CB: cb++; break;
        case Role::FB: fb++; break;
        case Role::CM: cm++; break;
        case Role::WM: wm++; break;
        case Role::CF: cf++; break;
    }
}
}

void StatsCollector::recordGoal(Team team, const std::string& source, double distance, double speed, std::optional<Role> scorerRole, bool headedGoal) {
    if(team==Team::Home) goalsHome++; else goalsAway++;
    if(headedGoal) headedGoals++;
    if(scorerRole.has_value()) countRole(*scorerRole, goalsGK, goalsCB, goalsFB, goalsCM, goalsWM, goalsCF);
    else goalsUnknownRole++;
    if(source=="direct_cross") directCrossGoals++;
    else if(source=="direct_delivery") directDeliveryGoals++;
    else if(source=="shot") /* tracked shot goal */;
    else if(source=="tackle_deflection") tackleDeflectionGoals++;
    else if(source=="goalkeeper_parry") goalkeeperParryGoals++;
    else if(source=="shot_deflection") shotDeflectionGoals++;
    else if(source=="own_pass") ownPassGoals++;
    else if(source=="lost_shot"||source=="shot_state_lost") lostShotGoals++;
    else if(source=="unknown_loose"||source=="loose_unclassified") unknownLooseGoals++;
    else if(source=="knock_ahead") knockAheadGoals++;
    else untrackedGoals++;
    if(distance<100) goalDistClose++; else if(distance<200) goalDistMedium++; else goalDistLong++;
}

void StatsCollector::recordShot(Team team, bool onTarget, Role shooterRole) {
    if(team==Team::Home) shotsHome++; else shotsAway++;
    countRole(shooterRole, shotsGK, shotsCB, shotsFB, shotsCM, shotsWM, shotsCF);
    if(onTarget) shotsOnTarget++;
}

void StatsCollector::recordShotOnTarget() {
    shotsOnTarget++;
}

void StatsCollector::recordQualityFlag(QualityFlag flag) {
    switch (flag) {
        case QualityFlag::WhyNoShoot: recordWhyNoShoot(); break;
        case QualityFlag::QuestionableBackpass: recordQuestionableBackpass(); break;
        case QualityFlag::ClearPathShoot: recordClearPathShoot(); break;
        case QualityFlag::ClearPathDrive: recordClearPathDrive(); break;
        case QualityFlag::TimeWastingDribble: recordTimeWastingDribble(); break;
        case QualityFlag::BackwardDribble: recordBackwardDribble(); break;
        case QualityFlag::WhyPlayerRunningDirection: recordWhyPlayerRunningDir(); break;
        case QualityFlag::StationaryHold500ms: recordStationaryHold500ms(); break;
        case QualityFlag::Unknown: recordUnknownQualityFlag(); break;
    }
}

void StatsCollector::recordTaskSelection(DefensiveTask role) {
    taskSelectionsTotal++;
    if(role==DefensiveTask::PrimaryPress) taskSelectionsPrimary++;
    else if(role==DefensiveTask::SecondaryPress) taskSelectionsSecondary++;
    else if(role==DefensiveTask::Cover) taskSelectionsCover++;
    else if(role==DefensiveTask::DefensiveLine) taskSelectionsLine++;
    else if(role==DefensiveTask::MidfieldScreen) taskSelectionsScreen++;
}

void StatsCollector::recordControlledTouch(Role role) {
    countRole(role, touchesGK, touchesCB, touchesFB, touchesCM, touchesWM, touchesCF);
}

std::string StatsCollector::summaryJSON() const {
    int totalShots = shotsHome + shotsAway;
    int totalGoals = goalsHome + goalsAway;
    double completionPct = passesAttempted > 0 ? passesCompleted * 100.0 / passesAttempted : 0;
    double possessionTotal = possessionHome + possessionAway;
    double posPct = possessionTotal > 0 ? possessionHome * 100.0 / possessionTotal : 50;
    double looseAvg = ballSpeedSamples > 0 ? ballSpeedTotal / ballSpeedSamples : 0;
    double passAvg = passLaunchCount > 0 ? passLaunchTotal / passLaunchCount : 0;
    double shotAvg = shotLaunchCount > 0 ? shotLaunchTotal / shotLaunchCount : 0;

    nlohmann::json j;
    j["passes"] = passesAttempted;
    j["passesCompleted"] = passesCompleted;
    j["passesIntercepted"] = passesIntercepted;
    j["passesIntendedReceived"] = passesIntended;
    j["wrongTeammate"] = wrongTeammate;
    j["throughBallsAttempted"] = throughBallsAttempted;
    j["throughBallsCompleted"] = throughBallsCompleted;
    j["crossesAttempted"] = crossesAttempted;
    j["crossesCompleted"] = crossesCompleted;
    j["headers"] = headers;
    j["headedShots"] = headedShots;
    j["forwardPasses"] = forwardPasses;
    j["backwardPasses"] = backwardPasses;
    j["sidewaysPasses"] = sidewaysPasses;
    j["longBackwardPasses"] = longBackwardPasses;
    j["keeperBackpasses"] = keeperBackpasses;
    j["passCompletionPct"] = std::round(completionPct * 10) / 10;
    j["offsides"] = offsidesTotal;
    j["homeShots"] = shotsHome;
    j["awayShots"] = shotsAway;
    j["shots"] = totalShots;
    j["shotsOnTarget"] = shotsOnTarget;
    j["saves"] = saves;

    j["stuckCarrierAlerts"] = stuckAlerts;
    j["simulationFreezes"] = simFreezes;
    j["dizzySpins"] = dizzySpins;
    j["ballJumps"] = ballJumps;
    j["teammatePingPongs"] = teammatePingPongs;
    j["slideTackleDistanceAlerts"] = slideTackleDistance;
    j["slideTackleOobAlerts"] = slideTackleOob;
    j["ownPassGoals"] = ownPassGoals;
    j["unknownLooseGoals"] = unknownLooseGoals;

    j["shotsByDistance"] = {
        {"close", shotDistClose}, {"medium", shotDistMedium}, {"long", shotDistLong},
        {"average", totalShots > 0 ? std::round(shotDistTotal / totalShots * 10) / 10 : 0},
        {"questionable", questionableShots}
    };
    j["shotsByRole"] = {
        {"GK", shotsGK}, {"CB", shotsCB}, {"FB", shotsFB},
        {"CM", shotsCM}, {"WM", shotsWM}, {"CF", shotsCF}, {"unknown", shotsUnknownRole}
    };
    j["controlledTouchesByRole"] = {
        {"GK", touchesGK}, {"CB", touchesCB}, {"FB", touchesFB},
        {"CM", touchesCM}, {"WM", touchesWM}, {"CF", touchesCF}, {"unknown", touchesUnknownRole}
    };
    j["goalsByDistance"] = {{"close", goalDistClose}, {"medium", goalDistMedium}, {"long", goalDistLong}};
    j["goalsByRole"] = {
        {"GK", goalsGK}, {"CB", goalsCB}, {"FB", goalsFB},
        {"CM", goalsCM}, {"WM", goalsWM}, {"CF", goalsCF}, {"unknown", goalsUnknownRole}
    };

    j["untrackedGoals"] = untrackedGoals;
    j["directDeliveryGoals"] = directDeliveryGoals;
    j["directCrossGoals"] = directCrossGoals;
    j["headedGoals"] = headedGoals;
    j["tackleDeflectionGoals"] = tackleDeflectionGoals;
    j["goalkeeperParryGoals"] = goalkeeperParryGoals;
    j["shotDeflectionGoals"] = shotDeflectionGoals;
    j["ownPassGoals"] = ownPassGoals;
    j["lostShotGoals"] = lostShotGoals;
    j["unknownLooseGoals"] = unknownLooseGoals;
    j["knockAheadGoals"] = knockAheadGoals;

    j["goalkeeping"] = {{"assessedShots", gkAssessed}, {"unlikelySaves", unlikelySaves}, {"preventableGoals", preventableGoals}};
    j["tackles"] = {{"attempts", tackleAttempts}, {"wins", tackleWins}, {"cleanControls", tackleClean}, {"looseDeflections", tackleLoose}, {"fouls", tackleFouls}};

    j["dribbleTypes"] = {
        {"fast", dribbleFast}, {"medium", dribbleMedium}, {"close", dribbleClose},
        {"dribble20mShots", dribble20mShots}, {"dribble20mGoals", dribble20mGoals},
        {"knockAheads", knockAheads}, {"recovered", knockAheadRecovered}, {"retainedByTeammate", knockAheadRetained},
        {"turnovers", knockAheadTurnovers}, {"outOfPlay", knockAheadOutOfPlay},
        {"risky", riskyKnockAheads}, {"riskyTurnovers", riskyKnockAheadTurnovers},
        {"launchSpeedAvg", std::round((knockAheads > 0 ? knockAheadSpeedTotal / knockAheads : 0) * 10) / 10},
        {"pending", 0}
    };

    j["carrierTurns"] = {
        {"samples", carrierSamples}, {"requestedSharp", carrierSharp}, {"appliedSharp", 0},
        {"limitedFrames", carrierLimited}, {"over15", carrierOver15}, {"over30", carrierOver30},
        {"longBackwardCarries", longBackwardCarries},
        {"avgAppliedDeg", std::round((carrierSamples > 0 ? carrierDegTotal / carrierSamples : 0) * 10) / 10}
    };

    j["passSelection"] = {
        {"audited", passAudits}, {"risky", riskyPassChoices}, {"saferIgnored", saferPassIgnored},
        {"avgDistance", std::round(passAudits > 0 ? passDistTotal / passAudits : 0)},
        {"avgExpectedCompletionPct", std::round((passAudits > 0 ? passExpectedTotal / passAudits * 100 : 0) * 10) / 10},
        {"pressuredReceptions", pressuredReceptions}, {"pressuredReceptionFailures", pressuredReceptionFails}
    };

    j["setPieces"] = {
        {"goalKickAttempts", goalKickAttempts}, {"goalKickExitedOwnThird", goalKickExited},
        {"goalKickTrappedShots", goalKickTrappedShots}, {"goalKickPending", goalKickActive},
        {"penaltiesAwarded", penaltiesAwarded}, {"penaltiesTaken", penaltiesTaken},
        {"penaltiesScored", penaltiesScored}
    };

    j["shotSelection"] = {
        {"audited", shotAudits}, {"betterPassAvailable", betterPassShots}, {"tightAngle", tightAngleShots},
        {"avgAngleDeg", std::round((shotAudits > 0 ? shotAngleTotal / shotAudits : 0) * 10) / 10},
        {"avgPressure", std::round((shotAudits > 0 ? shotPressureTotal / shotAudits : 0) * 100) / 100},
        {"cfCredibleWindowSamples", cfCredibleWindows}, {"cfDeferredSamples", cfDeferred},
        {"cfDeferredForPass", cfDeferredPass}, {"cfDeferredForDribble", cfDeferredDribble},
        {"cfCloseWindowSamples", cfCloseWindows}, {"cfCloseDeferredSamples", cfCloseDeferred}
    };

    j["marking"] = {
        {"pressSamples", pressSamples}, {"questionablePress", questionPress},
        {"avgPrimaryPressDistance", std::round(pressSamples > 0 ? pressDistTotal / pressSamples : 0)},
        {"backLineSamples", backLineSamples}, {"singleDropSamples", backLineSingleDrop},
        {"singleDropPct", std::round((backLineSamples > 0 ? backLineSingleDrop * 100.0 / backLineSamples : 0) * 10) / 10},
        {"avgBackLineGap", std::round(backLineSamples > 0 ? backLineGapTotal / backLineSamples : 0)},
        {"avgSingleDropGap", std::round(backLineSingleDrop > 0 ? backLineSingleDropGapTotal / backLineSingleDrop : 0)},
        {"maxBackLineGap", std::round(backLineGapMax)},
        {"laneBlockSingleDrops", backLineLaneBlockSingleDrop},
        {"finalThirdSamples", finalThirdSamples}, {"unmarkedFinalThird", finalThirdUnmarked},
        {"unmarkedPct", std::round((finalThirdSamples > 0 ? finalThirdUnmarked * 100.0 / finalThirdSamples : 0) * 10) / 10},
        {"avgNearestCb", std::round(finalThirdSamples > 0 ? finalThirdCbTotal / finalThirdSamples : 0)},
        {"avgNearestDefender", std::round(finalThirdSamples > 0 ? finalThirdDefTotal / finalThirdSamples : 0)}
    };

    j["qualityFlags"] = {
        {"player_stuck", stuckAlerts}, {"simulation_freeze", simFreezes}, {"dizzy_spin", dizzySpins},
        {"ball_jump", ballJumps},
        {"slide_tackle_distance", slideTackleDistance}, {"slide_tackle_oob", slideTackleOob},
        {"own_pass_goal", ownPassGoals}, {"unknown_loose_goal", unknownLooseGoals},
        {"questionable_shot_choice", questionableShots}, {"questionable_press_assignment", questionPress},
        {"unmarked_final_third", finalThirdUnmarked}, {"risky_pass_choice", riskyPassChoices},
        {"teammate_pingpong", teammatePingPongs},
        {"why_no_shoot", whyNoShoots}, {"questionable_backpass", questionableBackpasses},
        {"clear_path_shoot", clearPathShoots}, {"clear_path_drive", clearPathDrives},
        {"time_wasting_dribble", timeWastingDribbles}, {"backward_dribble", backwardDribbles},
        {"stationary_hold_500ms", stationaryHold500ms},
        {"why_player_running_dir", whyPlayerRunningDir}, {"decision_moments", decisionMoments},
        {"player_decisions", playerDecisions}, {"stale_grabs_prevented", staleGrabs},
        {"unknown_quality_flag", unknownQualityFlags},
        {"task_selections_total", taskSelectionsTotal}, {"task_primary_press", taskSelectionsPrimary},
        {"task_secondary_press", taskSelectionsSecondary}
    };

    j["ballSpeed"] = {
        {"peak", std::round(ballSpeedPeak)}, {"looseSampleAvg", std::round(looseAvg)},
        {"looseSamples", ballSpeedSamples}, {"passLaunchAvg", std::round(passAvg)},
        {"passLaunches", passLaunchCount}, {"shotLaunchAvg", std::round(shotAvg)}, {"shotLaunches", shotLaunchCount}
    };

    j["events"] = nlohmann::json::array();
    j["possessionPct"] = std::round(posPct * 10) / 10;

    return j.dump();
}

#include "stats.h"
#include "nlohmann/json.hpp"
#include <cstdlib>

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
} // namespace

void StatsCollector::recordGoal(Team team, GoalSource source, double distance, double speed, std::optional<Role> scorerRole, bool headedGoal) {
    if (team == Team::Home)
        goalsHome++;
    else
        goalsAway++;
    if (headedGoal) headedGoals++;
    if (scorerRole.has_value())
        countRole(*scorerRole, goalsGK, goalsCB, goalsFB, goalsCM, goalsWM, goalsCF);
    else
        goalsUnknownRole++;
    switch (source) {
    case GoalSource::DirectCross: directCrossGoals++; break;
    case GoalSource::DirectDelivery: directDeliveryGoals++; break;
    case GoalSource::Shot: /* tracked shot goal */ break;
    case GoalSource::Penalty: /* counted via recordPenaltyGoal */ break;
    case GoalSource::TackleDeflection: tackleDeflectionGoals++; break;
    case GoalSource::GoalkeeperParry: goalkeeperParryGoals++; break;
    case GoalSource::ShotDeflection: shotDeflectionGoals++; break;
    case GoalSource::OwnPass: ownPassGoals++; break;
    case GoalSource::LostShot:
    case GoalSource::ShotStateLost: lostShotGoals++; break;
    case GoalSource::UnknownLoose:
    case GoalSource::LooseUnclassified: unknownLooseGoals++; break;
    case GoalSource::KnockAhead: knockAheadGoals++; break;
    default: untrackedGoals++; break; // None / unmapped
    }
    // distance == 0 means "not from a tracked shot" (deflection, direct cross,
    // loose ball) — those have no shot origin, so they belong in no band. The
    // banded goals therefore sum to LESS than total goals, by design: the bands
    // are a conversion denominator/numerator pair with recordShotDistance.
    if (distance > 1.0) goalBand[distanceBandIndex(distance)]++;
    if (distance < 100)
        goalDistClose++;
    else if (distance < 200)
        goalDistMedium++;
    else
        goalDistLong++;
}

void StatsCollector::recordShot(Team team, bool onTarget, Role shooterRole) {
    if (team == Team::Home)
        shotsHome++;
    else
        shotsAway++;
    countRole(shooterRole, shotsGK, shotsCB, shotsFB, shotsCM, shotsWM, shotsCF);
    if (onTarget) shotsOnTarget++;
}

void StatsCollector::recordShotOnTarget() {
    shotsOnTarget++;
}

void StatsCollector::recordOffsidePosition(Role role, double ms) {
    switch (role) {
    case Role::GK: offsidePositionMsGK += ms; break;
    case Role::CB: offsidePositionMsCB += ms; break;
    case Role::FB: offsidePositionMsFB += ms; break;
    case Role::CM: offsidePositionMsCM += ms; break;
    case Role::WM: offsidePositionMsWM += ms; break;
    case Role::CF: offsidePositionMsCF += ms; break;
    }
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
    case QualityFlag::GhostHeader: recordGhostHeader(); break;
    case QualityFlag::BlindPass: recordBlindPass(); break;
    case QualityFlag::SuicidePass: recordSuicidePass(); break;
    case QualityFlag::OffBallOverspeed: recordOffBallOverspeed(); break;
    case QualityFlag::EarlyKickoffGiveaway: recordEarlyKickoffGiveaway(); break;
    case QualityFlag::CarriedBallOverspeed: recordCarriedBallOverspeed(); break;
    case QualityFlag::CarrierOverspeed: recordCarrierOverspeed(); break;
    case QualityFlag::GiftedPass: recordGiftedPass(); break;
    case QualityFlag::BallTeleport: recordBallTeleport(); break;
    case QualityFlag::OffsideBallRelocation: recordOffsideBallRelocation(); break;
    case QualityFlag::OwnCornerConcession: recordOwnCornerConcession(); break;
    case QualityFlag::Unknown: recordUnknownQualityFlag(); break;
    }
}

void StatsCollector::recordTaskSelection(DefensiveTask role) {
    taskSelectionsTotal++;
    if (role == DefensiveTask::PrimaryPress)
        taskSelectionsPrimary++;
    else if (role == DefensiveTask::SecondaryPress)
        taskSelectionsSecondary++;
    else if (role == DefensiveTask::Cover)
        taskSelectionsCover++;
    else if (role == DefensiveTask::DefensiveLine)
        taskSelectionsLine++;
    else if (role == DefensiveTask::MidfieldScreen)
        taskSelectionsScreen++;
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
    j["openPlayCrossesAttempted"] = openPlayCrossesAttempted;
    j["cutbacksAttempted"] = cutbacksAttempted;
    j["passDwell"] = {
        {"u250ms", dwellPassU250ms}, {"u1s", dwellPassU1s}, {"u1800ms", dwellPassU1800ms}, {"u2800ms", dwellPassU2800ms}, {"longer", dwellPassLong}};
    j["homeCrossesAttempted"] = homeCrossesAttempted;
    j["awayCrossesAttempted"] = awayCrossesAttempted;
    j["crossesCompleted"] = crossesCompleted;
    j["headers"] = headers;
    j["headerClearances"] = headerClearances;
    j["headerLayoffs"] = headerLayoffs;
    j["headerControls"] = headerControls;
    j["headedShots"] = headedShots;
    j["headerAudit"] = {
        {"avgIncomingZ", headers > 0 ? std::round((headerZTotal / headers) * 10) / 10 : 0.0},
        {"minIncomingZ", headers > 0 ? std::round(headerZMin * 10) / 10 : 0.0},
        {"maxIncomingZ", headers > 0 ? std::round(headerZMax * 10) / 10 : 0.0},
        {"avgDeliveryDistance", headers > 0 ? std::round((headerDistTotal / headers) * 10) / 10 : 0.0},
        {"minDeliveryDistance", headers > 0 ? std::round(headerDistMin * 10) / 10 : 0.0},
        {"maxDeliveryDistance", headers > 0 ? std::round(headerDistMax * 10) / 10 : 0.0},
        {"avgIncomingSpeed", headers > 0 ? std::round((headerSpeedTotal / headers) * 10) / 10 : 0.0},
        {"unrealistic", unrealisticHeaders}};
    j["forwardPasses"] = forwardPasses;
    j["backwardPasses"] = backwardPasses;
    j["sidewaysPasses"] = sidewaysPasses;
    j["longBackwardPasses"] = longBackwardPasses;
    j["keeperBackpasses"] = keeperBackpasses;
    j["passCompletionPct"] = std::round(completionPct * 10) / 10;
    j["offsides"] = offsidesTotal;
    j["yellowCards"] = yellowCardsTotal;
    j["redCards"] = redCardsTotal;
    j["cornersAwarded"] = cornersTotal;
    j["substitutions"] = substitutionsTotal;
    j["injuries"] = injuriesTotal;
    j["offsidePositionMsByRole"] = {
        {"GK", std::round(offsidePositionMsGK)}, {"CB", std::round(offsidePositionMsCB)}, {"FB", std::round(offsidePositionMsFB)}, {"CM", std::round(offsidePositionMsCM)}, {"WM", std::round(offsidePositionMsWM)}, {"CF", std::round(offsidePositionMsCF)}};
    j["homeShots"] = shotsHome;
    j["awayShots"] = shotsAway;
    j["shots"] = totalShots;
    j["shotsOnTarget"] = shotsOnTarget;
    j["saves"] = saves;
    j["keeperClaimCatch"] = keeperClaimCatch;
    j["keeperClaimPunch"] = keeperClaimPunch;
    j["keeperClaimTip"] = keeperClaimTip;
    j["tacticalFouls"] = tacticalFouls;

    j["stuckCarrierAlerts"] = stuckAlerts;
    j["simulationFreezes"] = simFreezes;
    j["skillMoves"] = skillMoves;
    j["takeOnAttempts"] = takeOnAttempts;
    j["takeOnWins"] = takeOnWins;
    j["shotsBlocked"] = shotsBlocked;
    j["dizzySpins"] = dizzySpins;
    j["woodworkHits"] = woodworkHits;
    j["woodworkBar"] = woodworkBar;
    j["woodworkPost"] = woodworkPost;
    j["clearances"] = clearances;
    j["blobMoments"] = blobMoments;
    j["marathonCarries"] = marathonCarries;
    j["shuttleCarries"] = shuttleCarries;
    j["lineTooDeepSamples"] = lineTooDeepSamples;
    j["longestCarryMs"] = std::round(longestCarryMs);
    j["ballJumps"] = ballJumps;
    j["teammatePingPongs"] = teammatePingPongs;
    j["slideTackleDistanceAlerts"] = slideTackleDistance;
    j["slideTackleOobAlerts"] = slideTackleOob;
    j["ownPassGoals"] = ownPassGoals;
    j["unknownLooseGoals"] = unknownLooseGoals;

    j["shotsByDistance"] = {
        {"close", shotDistClose}, {"medium", shotDistMedium}, {"long", shotDistLong}, {"long200_260", shotDistLong200_260}, {"veryLong260", shotDistVeryLong260}, {"inBox", shotsInBox}, {"u6m", shotBand[0]}, {"u11m", shotBand[1]}, {"u16m", shotBand[2]}, {"u25m", shotBand[3]}, {"o25m", shotBand[4]}, {"average", totalShots > 0 ? std::round(shotDistTotal / totalShots * 10) / 10 : 0}, {"questionable", questionableShots}};
    j["shotsByRole"] = {
        {"GK", shotsGK}, {"CB", shotsCB}, {"FB", shotsFB}, {"CM", shotsCM}, {"WM", shotsWM}, {"CF", shotsCF}, {"unknown", shotsUnknownRole}};
    j["controlledTouchesByRole"] = {
        {"GK", touchesGK}, {"CB", touchesCB}, {"FB", touchesFB}, {"CM", touchesCM}, {"WM", touchesWM}, {"CF", touchesCF}, {"unknown", touchesUnknownRole}};
    j["goalsByDistance"] = {{"close", goalDistClose}, {"medium", goalDistMedium}, {"long", goalDistLong}, {"inBox", goalsInBox}, {"u6m", goalBand[0]}, {"u11m", goalBand[1]}, {"u16m", goalBand[2]}, {"u25m", goalBand[3]}, {"o25m", goalBand[4]}};
    j["goalsByRole"] = {
        {"GK", goalsGK}, {"CB", goalsCB}, {"FB", goalsFB}, {"CM", goalsCM}, {"WM", goalsWM}, {"CF", goalsCF}, {"unknown", goalsUnknownRole}};

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
    j["bodyBlock"] = {{"steals", bodyBlockSteals}, {"slides", bodyBlockSlides}};

    j["dribbleTypes"] = {
        {"fast", dribbleFast}, {"medium", dribbleMedium}, {"close", dribbleClose}, {"dribble20mShots", dribble20mShots}, {"dribble20mGoals", dribble20mGoals}, {"knockAheads", knockAheads}, {"recovered", knockAheadRecovered}, {"retainedByTeammate", knockAheadRetained}, {"turnovers", knockAheadTurnovers}, {"outOfPlay", knockAheadOutOfPlay}, {"risky", riskyKnockAheads}, {"riskyTurnovers", riskyKnockAheadTurnovers}, {"launchSpeedAvg", std::round((knockAheads > 0 ? knockAheadSpeedTotal / knockAheads : 0) * 10) / 10}, {"pending", 0}};

    j["carrierTurns"] = {
        {"samples", carrierSamples}, {"requestedSharp", carrierSharp}, {"appliedSharp", 0}, {"limitedFrames", carrierLimited}, {"over15", carrierOver15}, {"over30", carrierOver30}, {"longBackwardCarries", longBackwardCarries}, {"avgAppliedDeg", std::round((carrierSamples > 0 ? carrierDegTotal / carrierSamples : 0) * 10) / 10}};

    j["passSelection"] = {
        {"audited", passAudits}, {"risky", riskyPassChoices}, {"saferIgnored", saferPassIgnored}, {"avgDistance", std::round(passAudits > 0 ? passDistTotal / passAudits : 0)}, {"avgExpectedCompletionPct", std::round((passAudits > 0 ? passExpectedTotal / passAudits * 100 : 0) * 10) / 10}, {"pressuredReceptions", pressuredReceptions}, {"pressuredReceptionFailures", pressuredReceptionFails}};

    j["setPieces"] = {
        {"goalKickAttempts", goalKickAttempts}, {"goalKickExitedOwnThird", goalKickExited}, {"goalKickTrappedShots", goalKickTrappedShots}, {"goalKickPending", goalKickActive}, {"penaltiesAwarded", penaltiesAwarded}, {"penaltiesTaken", penaltiesTaken}, {"penaltiesScored", penaltiesScored}};

    j["invariantViolations"] = invariantViolations(); // §F: 0 = internally consistent; >0 trips the golden hash

    j["shotSelection"] = {
        {"audited", shotAudits}, {"betterPassAvailable", betterPassShots}, {"tightAngle", tightAngleShots}, {"avgAngleDeg", std::round((shotAudits > 0 ? shotAngleTotal / shotAudits : 0) * 10) / 10}, {"avgPressure", std::round((shotAudits > 0 ? shotPressureTotal / shotAudits : 0) * 100) / 100}, {"cfCredibleWindowSamples", cfCredibleWindows}, {"cfDeferredSamples", cfDeferred}, {"cfDeferredForPass", cfDeferredPass}, {"cfDeferredForDribble", cfDeferredDribble}, {"cfCloseWindowSamples", cfCloseWindows}, {"cfCloseDeferredSamples", cfCloseDeferred}};

    j["marking"] = {
        {"pressSamples", pressSamples}, {"questionablePress", questionPress}, {"avgPrimaryPressDistance", std::round(pressSamples > 0 ? pressDistTotal / pressSamples : 0)}, {"backLineSamples", backLineSamples}, {"singleDropSamples", backLineSingleDrop}, {"singleDropPct", std::round((backLineSamples > 0 ? backLineSingleDrop * 100.0 / backLineSamples : 0) * 10) / 10}, {"avgBackLineGap", std::round(backLineSamples > 0 ? backLineGapTotal / backLineSamples : 0)}, {"avgSingleDropGap", std::round(backLineSingleDrop > 0 ? backLineSingleDropGapTotal / backLineSingleDrop : 0)}, {"maxBackLineGap", std::round(backLineGapMax)}, {"laneBlockSingleDrops", backLineLaneBlockSingleDrop}, {"finalThirdSamples", finalThirdSamples}, {"unmarkedFinalThird", finalThirdUnmarked}, {"unmarkedPct", std::round((finalThirdSamples > 0 ? finalThirdUnmarked * 100.0 / finalThirdSamples : 0) * 10) / 10}, {"avgNearestCb", std::round(finalThirdSamples > 0 ? finalThirdCbTotal / finalThirdSamples : 0)}, {"avgNearestDefender", std::round(finalThirdSamples > 0 ? finalThirdDefTotal / finalThirdSamples : 0)}, {"offsidePositionMsByRole", j["offsidePositionMsByRole"]}};

    j["qualityFlags"] = {
        {"player_stuck", stuckAlerts}, {"simulation_freeze", simFreezes}, {"dizzy_spin", dizzySpins}, {"ball_jump", ballJumps}, {"slide_tackle_distance", slideTackleDistance}, {"slide_tackle_oob", slideTackleOob}, {"own_pass_goal", ownPassGoals}, {"unknown_loose_goal", unknownLooseGoals}, {"questionable_shot_choice", questionableShots}, {"questionable_press_assignment", questionPress}, {"unmarked_final_third", finalThirdUnmarked}, {"risky_pass_choice", riskyPassChoices}, {"teammate_pingpong", teammatePingPongs}, {"why_no_shoot", whyNoShoots}, {"questionable_backpass", questionableBackpasses}, {"clear_path_shoot", clearPathShoots}, {"clear_path_drive", clearPathDrives}, {"time_wasting_dribble", timeWastingDribbles}, {"backward_dribble", backwardDribbles}, {"stationary_hold_500ms", stationaryHold500ms}, {"why_player_running_dir", whyPlayerRunningDir}, {"decision_moments", decisionMoments}, {"player_decisions", playerDecisions}, {"stale_grabs_prevented", staleGrabs}, {"ghost_header", ghostHeaders}, {"blind_pass", blindPasses}, {"suicide_pass", suicidePasses}, {"off_ball_overspeed", offBallOverspeed}, {"pass_giveaway_first_5s", earlyKickoffGiveaways}, {"carried_ball_overspeed", carriedBallOverspeed}, {"carrier_overspeed", carrierOverspeed}, {"gifted_pass", giftedPasses}, {"ball_teleport", ballTeleports}, {"offside_ball_relocation", offsideBallRelocations}, {"own_corner_concession", ownCornerConcessions}, {"unknown_quality_flag", unknownQualityFlags}, {"restart_law_violation", restartLawViolations}, {"nonsense_pass", nonsensePasses}, {"senseless_out_of_play", senselessOutOfPlay}, {"senseless_giveaway", senselessGiveaways}, {"task_selections_total", taskSelectionsTotal}, {"task_primary_press", taskSelectionsPrimary}, {"task_secondary_press", taskSelectionsSecondary}};

    j["goalSources"] = {
        {"freeKick", goalsFromFreeKick}, {"corner", goalsFromCorner},
        {"throwIn", goalsFromThrowIn}, {"penaltyPhase", goalsFromPenaltyPhase},
        {"openPlay", goalsOpenPlay}};

    j["ballSpeed"] = {
        {"peak", std::round(ballSpeedPeak)}, {"looseSampleAvg", std::round(looseAvg)}, {"looseSamples", ballSpeedSamples}, {"passLaunchAvg", std::round(passAvg)}, {"passLaunches", passLaunchCount}, {"shotLaunchAvg", std::round(shotAvg)}, {"shotLaunches", shotLaunchCount}};

    j["events"] = nlohmann::json::array();
    j["possessionPct"] = std::round(posPct * 10) / 10;

    // Round-34 census. Serialised ONLY under FOOTY_CENSUS=1 so the default
    // summary — and therefore tools/golden/fingerprint.sha256 — is byte-identical
    // with the probe compiled in. Read once (static), no per-call getenv cost.
    static const bool censusOn = [] {
        const char* e = std::getenv("FOOTY_CENSUS");
        return e && (e[0] == '1' || e[0] == 't' || e[0] == 'y');
    }();
    if (censusOn) {
        const Census& c = census;
        auto arr = [](const long* v, int n) {
            nlohmann::json a = nlohmann::json::array();
            for (int i = 0; i < n; i++) a.push_back(v[i]);
            return a;
        };
        nlohmann::json cj;
        cj["carry"] = {
            {"ticks", c.carryTicks}, {"anomaly", c.carryAnom}, {"frozen", c.carryFrozen},
            {"backward", c.carryBackward}, {"band35_230", c.carryBand35_230},
            {"band50_180", c.carryBand50_180}, {"tightTicks", c.carryTight},
            {"ratioHist", arr(c.carryRatioHist, 32)}, {"offsetHist", arr(c.carryOffsetHist, 32)},
            {"touches", c.carryTouches}, {"touchesTight", c.carryTouchesTight},
            {"ms", std::round(c.carryMs)}, {"tightMs", std::round(c.carryTightMs)}};
        cj["collect"] = {
            {"grants", c.grants}, {"grantsIntended", c.grantsIntended},
            {"avgDistPx", c.grants > 0 ? std::round(c.grantDistSum / c.grants * 100) / 100 : 0.0},
            {"avgIntendedDistPx", c.grantsIntended > 0 ? std::round(c.grantIntendedDistSum / c.grantsIntended * 100) / 100 : 0.0},
            {"maxDistPx", std::round(c.grantDistMax * 100) / 100},
            {"distHist", arr(c.grantHist, 10)}, {"glueSnaps60", c.glueSnaps}};
        cj["gk"] = nlohmann::json::array();
        for (int k = 0; k < 2; k++) {
            double mins = c.gkMs[k] / 60000.0;
            cj["gk"].push_back({{"bands", arr(c.gkBand[k], 5)},
                                {"pathMPerMin", mins > 0 ? std::round(c.gkPathPx[k] / 10.0 / mins * 10) / 10 : 0.0},
                                {"ticks", (long) std::llround(c.gkMs[k] / 16.6666666667)},
                                {"depth96", c.gkDepth96[k]}, {"depthFar", c.gkDepthFar[k]},
                                {"dip96to68", c.gkDip96to68[k]},
                                {"liveMin", std::round(mins * 100) / 100}});
        }
        cj["speedBands"] = {{"open", arr(c.openBand, 6)}, {"reset", arr(c.resetBand, 6)}};
        cj["restartWalk"] = {
            {"arms", c.walkArms}, {"snaps", c.walkSnaps},
            {"avgStartDistPx", c.walkArms > 0 ? std::round(c.walkStartDistSum / c.walkArms * 10) / 10 : 0.0},
            {"maxStartDistPx", std::round(c.walkStartDistMax * 10) / 10},
            {"avgSnapDistPx", c.walkSnaps > 0 ? std::round(c.walkSnapDistSum / c.walkSnaps * 100) / 100 : 0.0},
            {"maxSnapDistPx", std::round(c.walkSnapDistMax * 100) / 100},
            {"snapsOver8", c.walkSnapOver8}, {"snapsOver20", c.walkSnapOver20}, {"snapsOver80", c.walkSnapOver80},
            {"startDistHist50", arr(c.walkStartHist, 20)},
            {"htArms", c.htWalkArms},
            {"htAvgStartDistPx", c.htWalkArms > 0 ? std::round(c.htWalkStartDistSum / c.htWalkArms * 10) / 10 : 0.0},
            {"htMaxStartDistPx", std::round(c.htWalkStartDistMax * 10) / 10}};
        cj["gears"] = nlohmann::json::array();
        for (int g = 0; g < 4; g++) cj["gears"].push_back(arr(c.gearHist[g], 64));
        cj["passProximity"] = {
            {"releases", c.passReleases}, {"releasesNearPress70", c.passReleasesNearPress},
            {"intercepts", c.passIntercepts}, {"interceptsNearPress70", c.passInterceptsNearPress}};
        cj["anticipate"] = {
            {"ticks", c.gaTicks}, {"arms", c.gaArms},
            {"looseChaserMean", c.looseChaserTicks > 0
                ? std::round((double) c.looseChaserSum / c.looseChaserTicks * 1000) / 1000 : 0.0},
            {"looseChaserMax", c.looseChaserMax},
            {"looseChaserTicks", c.looseChaserTicks}};
        cj["loose"] = {
            {"openTicks", c.openTicks}, {"looseTicks", c.looseTicks}, {"deadUncontrolledTicks", c.looseDeadTicks},
            {"episodes", c.looseEpisodes}, {"episodesOver1s", c.looseEpisodesOver1s},
            {"episodesOver1500ms", c.looseEpisodesOver1500ms},
            {"totalSec", std::round(c.looseMsTotal / 1000.0 * 10) / 10},
            {"maxSec", std::round(c.looseMsMax / 1000.0 * 100) / 100},
            {"msHist250", arr(c.looseMsHist, 24)}};
        j["census"] = cj;
    }

    return j.dump();
}

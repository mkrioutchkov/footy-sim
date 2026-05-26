#pragma once
#include <string>
#include <format>

// ── Event-driven stats collector ──
// Every game event calls a typed method. At match end, summaryJSON() provides benchmark output.

class StatsCollector {
public:
    // ── Pass events ──
    void recordPassAttempt()           { passesAttempted++; }
    void recordPassComplete()          { passesCompleted++; }
    void recordPassIntercepted()       { passesIntercepted++; }
    void recordPassSelection(double dist, double expectedCompletion, int blockers, double pressure, bool risky, int saferId) {
        passAudits++; passDistTotal+=dist; passExpectedTotal+=expectedCompletion;
        if(risky) riskyPassChoices++;
        if(saferId>=0) saferPassIgnored++;
    }
    void recordPressuredReception(bool failed) {
        pressuredReceptions++;
        if(failed) pressuredReceptionFails++;
    }

    // ── Shot events ──
    void recordShot(const std::string& team, bool onTarget);
    void recordShotOnTarget();
    void recordSave() { saves++; }
    void recordGoal(const std::string& team, const std::string& source, double distance, double speed);
    void recordGkAssessment(bool unlikely, bool preventable) { gkAssessed++; if(unlikely) unlikelySaves++; if(preventable) preventableGoals++; }
    void recordShotSelection(double angle, double pressure, int credibleWindows, int deferred, int deferredPass, int deferredDribble, int closeWindows, int closeDeferred, bool betterPass, bool tightAngle) {
        shotAudits++; shotAngleTotal+=angle; shotPressureTotal+=pressure;
        cfCredibleWindows+=credibleWindows; cfDeferred+=deferred;
        cfDeferredPass+=deferredPass; cfDeferredDribble+=deferredDribble;
        cfCloseWindows+=closeWindows; cfCloseDeferred+=closeDeferred;
        if(betterPass) betterPassShots++;
        if(tightAngle) tightAngleShots++;
    }

    // ── Tackle events ──
    void recordTackleAttempt()               { tackleAttempts++; }
    void recordTackleWin(bool cleanControl)   { tackleWins++; if(cleanControl) tackleClean++; else tackleLoose++; }
    void recordTackleFoul()                  { tackleFouls++; }
    void recordSlideTackleDistance()         { slideTackleDistance++; }
    void recordSlideTackleOob()              { slideTackleOob++; }

    // ── Collection events ──
    void recordCollection(bool sameTeamRecent) { if(sameTeamRecent) teammatePingPongs++; }

    // ── Dribble / knock-ahead ──
    void recordDribble(int type) { if(type==1) dribbleClose++; else if(type==2) dribbleMedium++; else if(type==3) dribbleFast++; }
    void recordKnockAhead(double speed) { knockAheads++; knockAheadSpeedTotal+=speed; }
    void recordKnockAheadRecovered()    { knockAheadRecovered++; }
    void recordKnockAheadRetained()     { knockAheadRetained++; }
    void recordKnockAheadTurnover(bool risky) { knockAheadTurnovers++; if(risky) riskyKnockAheadTurnovers++; }
    void recordKnockAheadOutOfPlay()    { knockAheadOutOfPlay++; }
    void recordRiskyKnockAhead()        { riskyKnockAheads++; }

    // ── Quality / alerts ──
    void recordStuckCarrier()           { stuckAlerts++; }
    void recordSimulationFreeze()       { simFreezes++; }
    void recordDizzySpin()              { dizzySpins++; }
    void recordQuestionableShot()       { questionableShots++; }
    void recordQuestionablePress(double dist) { questionPress++; pressDistTotal+=dist; }

    // ── Marking / defensive ──
    void recordPressSample()            { pressSamples++; }
    void recordBackLineSample(double gap, bool singleDrop, bool laneBlock) {
        backLineSamples++; backLineGapTotal+=gap; backLineGapMax=std::max(backLineGapMax,gap);
        if(singleDrop){backLineSingleDrop++;backLineSingleDropGapTotal+=gap;if(laneBlock)backLineLaneBlockSingleDrop++;}
    }
    void recordFinalThirdMarking(double cbDist, double defDist, bool unmarked) {
        finalThirdSamples++;
        if(unmarked) finalThirdUnmarked++;
        finalThirdCbTotal+=cbDist; finalThirdDefTotal+=defDist;
    }

    // ── Carrier turns ──
    void recordCarrierTurn(bool sharp, double deg, bool limited) {
        carrierSamples++; if(sharp) carrierSharp++; if(limited) carrierLimited++;
        carrierDegTotal+=deg; if(deg>15) carrierOver15++; if(deg>30) carrierOver30++;
    }

    // ── Ball speed ──
    void recordBallSpeedSample(double speed) { if(speed>ballSpeedPeak) ballSpeedPeak=speed; ballSpeedTotal+=speed; ballSpeedSamples++; }
    void recordPassLaunch(double speed)      { passLaunchTotal+=speed; passLaunchCount++; }
    void recordShotLaunch(double speed)      { shotLaunchTotal+=speed; shotLaunchCount++; }
    void recordPossession(double homeMs, double awayMs) { possessionHome=homeMs; possessionAway=awayMs; }
    void recordScore(int home, int away)     { homeScore=home; awayScore=away; }

    // ── Summary JSON output (benchmark-compatible) ──
    std::string summaryJSON() const;

private:
    int passesAttempted=0, passesCompleted=0, passesIntercepted=0;
    int offsidesTotal=0;
    int shotsHome=0, shotsAway=0, shotsOnTarget=0, saves=0;
    int goalsHome=0, goalsAway=0;
    int homeScore=0, awayScore=0;
    int untrackedGoals=0, directDeliveryGoals=0, directCrossGoals=0;
    int tackleDeflectionGoals=0, goalkeeperParryGoals=0, shotDeflectionGoals=0;
    int ownPassGoals=0, lostShotGoals=0, unknownLooseGoals=0, knockAheadGoals=0;
    int tackleAttempts=0, tackleWins=0, tackleClean=0, tackleLoose=0, tackleFouls=0;
    int slideTackleDistance=0, slideTackleOob=0;
    int stuckAlerts=0;
    int simFreezes=0;
    int dizzySpins=0;
    int teammatePingPongs=0;
    int questionableShots=0;
    int gkAssessed=0, unlikelySaves=0, preventableGoals=0;
    int pressSamples=0, questionPress=0;
    double pressDistTotal=0;
    int finalThirdSamples=0, finalThirdUnmarked=0;
    double finalThirdCbTotal=0, finalThirdDefTotal=0;
    int backLineSamples=0, backLineSingleDrop=0, backLineLaneBlockSingleDrop=0;
    double backLineGapTotal=0, backLineSingleDropGapTotal=0, backLineGapMax=0;
    int shotDistClose=0, shotDistMedium=0, shotDistLong=0;
    double shotDistTotal=0;
    int goalDistClose=0, goalDistMedium=0, goalDistLong=0;
    int dribbleClose=0, dribbleMedium=0, dribbleFast=0;
    int knockAheads=0, knockAheadRecovered=0, knockAheadRetained=0;
    int knockAheadTurnovers=0, knockAheadOutOfPlay=0;
    int riskyKnockAheads=0, riskyKnockAheadTurnovers=0;
    double knockAheadSpeedTotal=0;
    int carrierSamples=0, carrierSharp=0, carrierLimited=0, carrierOver15=0, carrierOver30=0;
    double carrierDegTotal=0;
    int passAudits=0, riskyPassChoices=0, saferPassIgnored=0;
    double passDistTotal=0, passExpectedTotal=0;
    int pressuredReceptions=0, pressuredReceptionFails=0;
    int shotAudits=0, betterPassShots=0, tightAngleShots=0;
    double shotAngleTotal=0, shotPressureTotal=0;
    int cfCredibleWindows=0, cfDeferred=0, cfDeferredPass=0, cfDeferredDribble=0;
    int cfCloseWindows=0, cfCloseDeferred=0;
    double possessionHome=0, possessionAway=0;
    double ballSpeedPeak=0, ballSpeedTotal=0;
    int ballSpeedSamples=0;
    double passLaunchTotal=0, shotLaunchTotal=0;
    int passLaunchCount=0, shotLaunchCount=0;
};

inline void StatsCollector::recordGoal(const std::string& team, const std::string& source, double distance, double speed) {
    if(team=="home") goalsHome++; else goalsAway++;
    if(source=="direct_cross") directCrossGoals++;
    else if(source=="direct_delivery") directDeliveryGoals++;
    else if(source=="tackle_deflection") tackleDeflectionGoals++;
    else if(source=="goalkeeper_parry") goalkeeperParryGoals++;
    else if(source=="shot_deflection") shotDeflectionGoals++;
    else if(source=="own_pass") ownPassGoals++;
    else if(source=="lost_shot") lostShotGoals++;
    else if(source=="unknown_loose") unknownLooseGoals++;
    else if(source=="knock_ahead") knockAheadGoals++;
    else untrackedGoals++;
    if(distance<100) goalDistClose++; else if(distance<200) goalDistMedium++; else goalDistLong++;
}

inline void StatsCollector::recordShot(const std::string& team, bool onTarget) {
    if(team=="home") shotsHome++; else shotsAway++;
    if(onTarget) shotsOnTarget++;
}

inline void StatsCollector::recordShotOnTarget() {
    shotsOnTarget++;
}

inline std::string StatsCollector::summaryJSON() const {
    int totalShots=shotsHome+shotsAway;
    int totalGoals=goalsHome+goalsAway;
    double completionPct=passesAttempted>0?passesCompleted*100.0/passesAttempted:0;
    double possessionTotal=possessionHome+possessionAway;
    double posPct=possessionTotal>0?possessionHome*100.0/possessionTotal:50;
    double looseAvg=ballSpeedSamples>0?ballSpeedTotal/ballSpeedSamples:0;
    double passAvg=passLaunchCount>0?passLaunchTotal/passLaunchCount:0;
    double shotAvg=shotLaunchCount>0?shotLaunchTotal/shotLaunchCount:0;
    return std::format(
        R"({{"passes":{},"passesCompleted":{},"passesIntercepted":{},"passCompletionPct":{:.1f},"offsides":{},"shots":{},"shotsOnTarget":{},"saves":{},)"
        R"("stuckCarrierAlerts":{},"simulationFreezes":{},"dizzySpins":{},"teammatePingPongs":{},)"
        R"("slideTackleDistanceAlerts":{},"slideTackleOobAlerts":{},"ownPassGoals":{},"unknownLooseGoals":{},)"
        R"("shotsByDistance":{{"close":{},"medium":{},"long":{},"average":{},"questionable":{}}},)"
        R"("goalsByDistance":{{"close":{},"medium":{},"long":{}}},)"
        R"("untrackedGoals":{},"directDeliveryGoals":{},"directCrossGoals":{},)"
        R"("tackleDeflectionGoals":{},"goalkeeperParryGoals":{},"shotDeflectionGoals":{},"ownPassGoals":{},"lostShotGoals":{},"unknownLooseGoals":{},"knockAheadGoals":{},)"
        R"("goalkeeping":{{"assessedShots":{},"unlikelySaves":{},"preventableGoals":{}}},)"
        R"("tackles":{{"attempts":{},"wins":{},"cleanControls":{},"looseDeflections":{},"fouls":{}}},)"
        R"("dribbleTypes":{{"fast":{},"medium":{},"close":{},"knockAheads":{},"recovered":{},"retainedByTeammate":{},"turnovers":{},"outOfPlay":{},"risky":{},"riskyTurnovers":{},"launchSpeedAvg":{:.1f},"pending":{}}},)"
        R"("carrierTurns":{{"samples":{},"requestedSharp":{},"appliedSharp":{},"limitedFrames":{},"over15":{},"over30":{},"avgAppliedDeg":{:.1f}}},)"
        R"("passSelection":{{"audited":{},"risky":{},"saferIgnored":{},"avgDistance":{:.0f},"avgExpectedCompletionPct":{:.1f},"pressuredReceptions":{},"pressuredReceptionFailures":{}}},)"
        R"("shotSelection":{{"audited":{},"betterPassAvailable":{},"tightAngle":{},"avgAngleDeg":{:.1f},"avgPressure":{:.2f},"cfCredibleWindowSamples":{},"cfDeferredSamples":{},"cfDeferredForPass":{},"cfDeferredForDribble":{},"cfCloseWindowSamples":{},"cfCloseDeferredSamples":{}}},)"
        R"("marking":{{"pressSamples":{},"questionablePress":{},"avgPrimaryPressDistance":{:.0f},"backLineSamples":{},"singleDropSamples":{},"singleDropPct":{:.1f},"avgBackLineGap":{:.0f},"avgSingleDropGap":{:.0f},"maxBackLineGap":{:.0f},"laneBlockSingleDrops":{},"finalThirdSamples":{},"unmarkedFinalThird":{},"unmarkedPct":{:.1f},"avgNearestCb":{:.0f},"avgNearestDefender":{:.0f}}})"
        R"(,"qualityFlags":{{"player_stuck":{},"simulation_freeze":{},"dizzy_spin":{},"slide_tackle_distance":{},"slide_tackle_oob":{},"own_pass_goal":{},"unknown_loose_goal":{},"questionable_shot_choice":{},"questionable_press_assignment":{},"unmarked_final_third":{},"risky_pass_choice":{},"teammate_pingpong":{}}})"
        R"(,"ballSpeed":{{"peak":{:.0f},"looseSampleAvg":{:.0f},"looseSamples":{},"passLaunchAvg":{:.0f},"passLaunches":{},"shotLaunchAvg":{:.0f},"shotLaunches":{}}})"
        R"(,"possessionPct":{:.1f}}})",
        passesAttempted,passesCompleted,passesIntercepted,completionPct,offsidesTotal,totalShots,shotsOnTarget,saves,
        stuckAlerts,simFreezes,dizzySpins,teammatePingPongs,
        slideTackleDistance,slideTackleOob,ownPassGoals,unknownLooseGoals,
        shotDistClose,shotDistMedium,shotDistLong,totalShots>0?shotDistTotal/totalShots:0,questionableShots,
        goalDistClose,goalDistMedium,goalDistLong,
        untrackedGoals,directDeliveryGoals,directCrossGoals,
        tackleDeflectionGoals,goalkeeperParryGoals,shotDeflectionGoals,ownPassGoals,lostShotGoals,unknownLooseGoals,knockAheadGoals,
        gkAssessed,unlikelySaves,preventableGoals,
        tackleAttempts,tackleWins,tackleClean,tackleLoose,tackleFouls,
        dribbleFast,dribbleMedium,dribbleClose,knockAheads,knockAheadRecovered,knockAheadRetained,knockAheadTurnovers,knockAheadOutOfPlay,riskyKnockAheads,riskyKnockAheadTurnovers,
        knockAheads>0?knockAheadSpeedTotal/knockAheads:0,0,
        carrierSamples,carrierSharp,0,carrierLimited,carrierOver15,carrierOver30,
        carrierSamples>0?carrierDegTotal/carrierSamples:0,
        passAudits,riskyPassChoices,saferPassIgnored,
        passAudits>0?passDistTotal/passAudits:0,
        passAudits>0?passExpectedTotal/passAudits*100:0,
        pressuredReceptions,pressuredReceptionFails,
        shotAudits,betterPassShots,tightAngleShots,
        shotAudits>0?shotAngleTotal/shotAudits:0,
        shotAudits>0?shotPressureTotal/shotAudits:0,
        cfCredibleWindows,cfDeferred,cfDeferredPass,cfDeferredDribble,
        cfCloseWindows,cfCloseDeferred,
        pressSamples,questionPress,
        pressSamples>0?pressDistTotal/pressSamples:0,
        backLineSamples,backLineSingleDrop,
        backLineSamples>0?backLineSingleDrop*100.0/backLineSamples:0,
        backLineSamples>0?backLineGapTotal/backLineSamples:0,
        backLineSingleDrop>0?backLineSingleDropGapTotal/backLineSingleDrop:0,
        backLineGapMax,backLineLaneBlockSingleDrop,
        finalThirdSamples,finalThirdUnmarked,
        finalThirdSamples>0?finalThirdUnmarked*100.0/finalThirdSamples:0,
        finalThirdSamples>0?finalThirdCbTotal/finalThirdSamples:0,
        finalThirdSamples>0?finalThirdDefTotal/finalThirdSamples:0,
        stuckAlerts,simFreezes,dizzySpins,slideTackleDistance,slideTackleOob,
        ownPassGoals,unknownLooseGoals,questionableShots,questionPress,finalThirdUnmarked,riskyPassChoices,teammatePingPongs,
        ballSpeedPeak,looseAvg,ballSpeedSamples,passAvg,passLaunchCount,shotAvg,shotLaunchCount,
        posPct
    );
}

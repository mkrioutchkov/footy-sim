#pragma once
#include <string>
#include <format>
#include "json.h"

// ── Event-driven stats collector ──
// Every game event calls a typed method. At match end, summaryJSON() provides benchmark output.

class StatsCollector {
public:
    // ── Pass events ──
    void recordPassAttempt()           { passesAttempted++; }
    void recordPassComplete()          { passesCompleted++; }
    void recordPassIntercepted()      { passesIntercepted++; }
    void recordPassIntendedReceived() { passesIntended++; }
    void recordPassWrongTeammate()    { wrongTeammate++; }
    void recordPassDirection(double forwardProgress) {
        if(forwardProgress > 30.0) forwardPasses++;
        else if(forwardProgress < -30.0) backwardPasses++;
        else sidewaysPasses++;
    }
    void recordOffside()              { offsidesTotal++; }
    void recordPassSelection(double dist, double expectedCompletion, int blockers, double pressure, bool risky, int saferId) {
        passAudits++; passDistTotal+=dist; passExpectedTotal+=expectedCompletion;
        if(risky) riskyPassChoices++;
        if(saferId>=0) saferPassIgnored++;
    }
    void recordPressuredReception(bool failed) {
        pressuredReceptions++;
        if(failed) pressuredReceptionFails++;
    }
    void recordGoalKickAttempt()       { goalKickAttempts++; goalKickActive++; }
    void recordGoalKickExit()          { goalKickExited++; if(goalKickActive>0) goalKickActive--; }
    void recordGoalKickTrappedShot()   { goalKickTrappedShots++; if(goalKickActive>0) goalKickActive--; }

    // ── Shot events ──
    void recordShot(const std::string& team, bool onTarget);
    void recordShotDistance(double distance) { shotDistTotal+=distance; if(distance<100)shotDistClose++; else if(distance<200)shotDistMedium++; else shotDistLong++; }
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
    void recordBallJump()               { ballJumps++; }
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
    int passesAttempted=0, passesCompleted=0, passesIntercepted=0, passesIntended=0, wrongTeammate=0;
    int forwardPasses=0, backwardPasses=0, sidewaysPasses=0;
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
    int ballJumps=0;
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
    int goalKickAttempts=0, goalKickExited=0, goalKickTrappedShots=0, goalKickActive=0;
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

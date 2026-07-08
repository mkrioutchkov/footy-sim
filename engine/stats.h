#pragma once
#include <string>
#include <optional>
#include "types.h"

// ── Event-driven stats collector ──
// Every game event calls a typed method. At match end, summaryJSON() provides benchmark output.

class StatsCollector {
  public:
    // ── Pass events ──
    void recordPassAttempt() { passesAttempted++; }
    void recordPassComplete() { passesCompleted++; }
    void recordPassIntercepted() { passesIntercepted++; }
    void recordPassIntendedReceived() { passesIntended++; }
    void recordPassWrongTeammate() { wrongTeammate++; }
    // §F stats-hardening (BORIS_STATS_ARCH #3): count violated counting-INVARIANTS at full-time.
    // 0 = internally consistent; any miscount that breaks a subset-relationship bumps this, and
    // since it's emitted in the summary the golden HASH trips => the bug becomes impossible to SHIP.
    // Catches gross over-counts by construction (onTarget double-count #1c, save>onTarget #1b class).
    int invariantViolations() const {
        int v = 0;
        if (saves > shotsOnTarget) v++;                                 // a save implies an on-target shot
        if (passesCompleted > passesAttempted) v++;                     // can't complete more than attempted
        if (passesCompleted + passesIntercepted > passesAttempted) v++; // the rest go loose/out of play
        if (shotsOnTarget > shotsHome + shotsAway) v++;                 // on-target is a subset of all shots
        return v;
    }
    void recordPassDirection(double forwardProgress) {
        if (forwardProgress > 30.0)
            forwardPasses++;
        else if (forwardProgress < -30.0)
            backwardPasses++;
        else
            sidewaysPasses++;
        if (forwardProgress < -200.0) longBackwardPasses++;
    }
    void recordKeeperBackpass() { keeperBackpasses++; }
    void recordYellowCard() { yellowCardsTotal++; }
    void recordRedCard() { redCardsTotal++; }
    int cornersTotal = 0;
    void recordCorner() { cornersTotal++; }
    int substitutionsTotal = 0;
    int injuriesTotal = 0;
    void recordSubstitution() { substitutionsTotal++; }
    void recordInjury() { injuriesTotal++; }
    void recordOffside() { offsidesTotal++; }
    void recordOffsidePosition(Role role, double ms);
    void recordPassSelection(double dist, double expectedCompletion, int blockers, double pressure, bool risky, int saferId) {
        passAudits++;
        passDistTotal += dist;
        passExpectedTotal += expectedCompletion;
        if (risky) riskyPassChoices++;
        if (saferId >= 0) saferPassIgnored++;
    }
    void recordThroughBallAttempt() { throughBallsAttempted++; }
    void recordThroughBallComplete() { throughBallsCompleted++; }
    void recordCrossAttempt(bool home) {
        crossesAttempted++;
        (home ? homeCrossesAttempted : awayCrossesAttempted)++;
    }
    void recordCrossComplete() { crossesCompleted++; }
    // Taxonomy (2026-07-02 audit): crossesAttempted lumps open-play whips with
    // set-piece deliveries, and cutbacks were counted NOWHERE — every future
    // calibration pass needs the split to compare against real benchmarks
    // (aerial-cross completion 18-25% ≠ cutback completion).
    void recordOpenPlayCross() { openPlayCrossesAttempted++; }
    void recordCutbackAttempt() { cutbacksAttempted++; }
    // Dwell histogram (2026-07-02 audit, tempo Stage 1): how long did the carrier
    // hold before a deliberate pass released? Real football ~2x slower than the
    // engine (1787 passes/match vs ~900) — before any dwell-gate tuning, this
    // splits decision tempo from micro-touch inflation. Ticks are 16.667ms.
    void recordPassDwell(int ticks) {
        if (ticks <= 15)
            dwellPassU250ms++;
        else if (ticks <= 60)
            dwellPassU1s++;
        else if (ticks <= 110)
            dwellPassU1800ms++;
        else if (ticks <= 170)
            dwellPassU2800ms++;
        else
            dwellPassLong++;
    }
    void recordHeader(double incomingZ, double deliveryDist, double speed, bool unrealistic) {
        headers++;
        headerZTotal += incomingZ;
        headerDistTotal += deliveryDist;
        headerSpeedTotal += speed;
        if (headers == 1) {
            headerZMin = headerZMax = incomingZ;
            headerDistMin = headerDistMax = deliveryDist;
        } else {
            headerZMin = std::min(headerZMin, incomingZ);
            headerZMax = std::max(headerZMax, incomingZ);
            headerDistMin = std::min(headerDistMin, deliveryDist);
            headerDistMax = std::max(headerDistMax, deliveryDist);
        }
        if (unrealistic) unrealisticHeaders++;
    }
    void recordHeaderClearance() { headerClearances++; }
    void recordHeaderLayoff() { headerLayoffs++; }
    void recordHeaderControl() { headerControls++; }
    void recordHeadedShot() { headedShots++; }
    void recordPressuredReception(bool failed) {
        pressuredReceptions++;
        if (failed) pressuredReceptionFails++;
    }
    void recordGoalKickAttempt() {
        goalKickAttempts++;
        goalKickActive++;
    }
    void recordGoalKickExit() {
        goalKickExited++;
        if (goalKickActive > 0) goalKickActive--;
    }
    void recordGoalKickTrappedShot() {
        goalKickTrappedShots++;
        if (goalKickActive > 0) goalKickActive--;
    }
    void recordPenaltyAwarded() { penaltiesAwarded++; }
    void recordPenaltyTaken() { penaltiesTaken++; }
    void recordPenaltyGoal() { penaltiesScored++; }

    // ── Shot events ──
    void recordShot(Team team, bool onTarget, Role shooterRole);
    void recordShotDistance(double distance) {
        shotDistTotal += distance;
        if (distance < 100)
            shotDistClose++;
        else if (distance < 200)
            shotDistMedium++;
        else
            shotDistLong++;
    }
    void recordShotOnTarget();
    void recordSave() { saves++; }
    // Keeper cross-claims (separate from shot saves so the save ledger stays clean).
    void recordClaimCatch() { keeperClaimCatch++; }
    void recordClaimPunch() { keeperClaimPunch++; }
    void recordClaimTip() { keeperClaimTip++; }
    void recordGoal(Team team, GoalSource source, double distance, double speed, std::optional<Role> scorerRole, bool headedGoal);
    void recordGkAssessment(bool unlikely, bool preventable) {
        gkAssessed++;
        if (unlikely) unlikelySaves++;
        if (preventable) preventableGoals++;
    }
    void recordShotSelection(double angle, double pressure, int credibleWindows, int deferred, int deferredPass, int deferredDribble, int closeWindows, int closeDeferred, bool betterPass, bool tightAngle) {
        shotAudits++;
        shotAngleTotal += angle;
        shotPressureTotal += pressure;
        cfCredibleWindows += credibleWindows;
        cfDeferred += deferred;
        cfDeferredPass += deferredPass;
        cfDeferredDribble += deferredDribble;
        cfCloseWindows += closeWindows;
        cfCloseDeferred += closeDeferred;
        if (betterPass) betterPassShots++;
        if (tightAngle) tightAngleShots++;
    }

    // ── Tackle events ──
    void recordTackleAttempt() { tackleAttempts++; }
    void recordTackleWin(bool cleanControl) {
        tackleWins++;
        if (cleanControl)
            tackleClean++;
        else
            tackleLoose++;
    }
    void recordTackleFoul() { tackleFouls++; }
    void recordTacticalFoul() { tacticalFouls++; } // deliberate cynical foul (subset of fouls)
    void recordSlideTackleDistance() { slideTackleDistance++; }
    void recordSlideTackleOob() { slideTackleOob++; }

    // ── Collection events ──
    void recordCollection(bool sameTeamRecent) {
        if (sameTeamRecent) teammatePingPongs++;
    }
    void recordControlledTouch(Role role);

    // ── Dribble / knock-ahead ──
    void recordDribble(int type) {
        if (type == 1)
            dribbleClose++;
        else if (type == 2)
            dribbleMedium++;
        else if (type == 3)
            dribbleFast++;
    }
    void recordDribble20mShot() { dribble20mShots++; }
    void recordDribble20mGoal() { dribble20mGoals++; }
    void recordKnockAhead(double speed) {
        knockAheads++;
        knockAheadSpeedTotal += speed;
    }
    void recordKnockAheadRecovered() { knockAheadRecovered++; }
    void recordKnockAheadRetained() { knockAheadRetained++; }
    void recordKnockAheadTurnover(bool risky) {
        knockAheadTurnovers++;
        if (risky) riskyKnockAheadTurnovers++;
    }
    void recordKnockAheadOutOfPlay() { knockAheadOutOfPlay++; }
    void recordRiskyKnockAhead() { riskyKnockAheads++; }

    // ── Quality / alerts ──
    void recordStuckCarrier() { stuckAlerts++; }
    void recordSimulationFreeze() { simFreezes++; }
    void recordDizzySpin() { dizzySpins++; }
    void recordWoodwork() { woodworkHits++; }
    void recordClearance() { clearances++; }           // Clear-purpose releases (both the hoof gate and relabeled candidates); real ~30-40/match both teams
    void recordBlobMoment() { blobMoments++; }         // 6+ players within 50px, open play, 1.5s throttle
    void recordMarathonCarry() { marathonCarries++; }  // outfield single-possession carry >= 8s
    void recordShuttleCarry() { shuttleCarries++; }    // >= 6s carry with >= 3 lateral reversals
    void recordLineTooDeep() { lineTooDeepSamples++; } // 1s samples: back line <110px, ball far, no deep threat
    void noteLongestCarry(double ms) {
        if (ms > longestCarryMs) longestCarryMs = ms;
    }
    void recordBallJump() { ballJumps++; }
    void recordQuestionableShot() { questionableShots++; }
    void recordQuestionablePress() { questionPress++; }
    void recordWhyNoShoot() { whyNoShoots++; }
    void recordQuestionableBackpass() { questionableBackpasses++; }
    void recordClearPathShoot() { clearPathShoots++; }
    void recordClearPathDrive() { clearPathDrives++; }
    void recordTimeWastingDribble() { timeWastingDribbles++; }
    void recordBackwardDribble() { backwardDribbles++; }
    void recordWhyPlayerRunningDir() { whyPlayerRunningDir++; }
    void recordStationaryHold500ms() { stationaryHold500ms++; }
    void recordUnknownQualityFlag() { unknownQualityFlags++; }
    // Restart-law audit (Law 14/16): a player standing illegally (inside the
    // box / arc at a penalty kick, opponent inside the box at a goal kick) AT
    // THE MOMENT of release. Guarded to 0 by the scenario suite.
    void recordRestartLawViolation() { restartLawViolations++; }
    // "Retard pass" census (owner ask): a low-completion ball released under
    // little/no pressure while a clearly safer, comparable option existed.
    void recordNonsensePass() { nonsensePasses++; }
    // Senseless loss of possession census (owner ask): a ball put OUT OF PLAY, or
    // handed straight to an opponent, by an UNPRESSURED player who had a safe
    // option — the "just kicked it out of play" / "senseless giveaway" moments.
    void recordSenselessOutOfPlay() { senselessOutOfPlay++; }
    void recordSenselessGiveaway() { senselessGiveaways++; }
    void recordQualityFlag(QualityFlag flag);
    void recordDecisionMoment() { decisionMoments++; }
    void recordPlayerDecision() { playerDecisions++; }
    void recordStaleGrabPrevented() { staleGrabs++; }
    void recordSkillMove() { skillMoves++; }
    void recordShotBlocked() { shotsBlocked++; }
    void recordTaskSelection(DefensiveTask role);

    // ── Marking / defensive ──
    // dist = presser-to-carrier distance; previously only questionable presses
    // contributed distance, making avgPrimaryPressDistance meaningless.
    void recordPressSample(double dist) {
        pressSamples++;
        pressDistTotal += dist;
    }
    void recordBackLineSample(double gap, bool singleDrop, bool laneBlock) {
        backLineSamples++;
        backLineGapTotal += gap;
        backLineGapMax = std::max(backLineGapMax, gap);
        if (singleDrop) {
            backLineSingleDrop++;
            backLineSingleDropGapTotal += gap;
            if (laneBlock) backLineLaneBlockSingleDrop++;
        }
    }
    void recordFinalThirdMarking(double cbDist, double defDist, bool unmarked) {
        finalThirdSamples++;
        if (unmarked) finalThirdUnmarked++;
        finalThirdCbTotal += cbDist;
        finalThirdDefTotal += defDist;
    }

    // ── Carrier turns ──
    void recordCarrierTurn(bool sharp, double deg, bool limited) {
        carrierSamples++;
        if (sharp) carrierSharp++;
        if (limited) carrierLimited++;
        carrierDegTotal += deg;
        if (deg > 15) carrierOver15++;
        if (deg > 30) carrierOver30++;
    }
    void recordLongBackwardCarry() { longBackwardCarries++; }

    // ── Ball speed ──
    void recordBallSpeedSample(double speed) {
        if (speed > ballSpeedPeak) ballSpeedPeak = speed;
        ballSpeedTotal += speed;
        ballSpeedSamples++;
    }
    void recordPassLaunch(double speed) {
        passLaunchTotal += speed;
        passLaunchCount++;
    }
    void recordShotLaunch(double speed) {
        shotLaunchTotal += speed;
        shotLaunchCount++;
    }
    void recordPossession(double homeMs, double awayMs) {
        possessionHome = homeMs;
        possessionAway = awayMs;
    }
    void recordScore(int home, int away) {
        homeScore = home;
        awayScore = away;
    }

    // ── Summary JSON output (benchmark-compatible) ──
    std::string summaryJSON() const;

  private:
    int passesAttempted = 0, passesCompleted = 0, passesIntercepted = 0, passesIntended = 0, wrongTeammate = 0;
    int throughBallsAttempted = 0, throughBallsCompleted = 0;
    int crossesAttempted = 0, crossesCompleted = 0, headers = 0, headedShots = 0;
    int openPlayCrossesAttempted = 0, cutbacksAttempted = 0;
    int dwellPassU250ms = 0, dwellPassU1s = 0, dwellPassU1800ms = 0, dwellPassU2800ms = 0, dwellPassLong = 0;
    int homeCrossesAttempted = 0, awayCrossesAttempted = 0; // per-team (the combined total is possession-confounded for benchmarks)
    int headerClearances = 0, headerLayoffs = 0, headerControls = 0;
    int unrealisticHeaders = 0;
    double headerZTotal = 0, headerZMin = 0, headerZMax = 0;
    double headerDistTotal = 0, headerDistMin = 0, headerDistMax = 0;
    double headerSpeedTotal = 0;
    int forwardPasses = 0, backwardPasses = 0, sidewaysPasses = 0;
    int longBackwardPasses = 0, keeperBackpasses = 0;
    int offsidesTotal = 0;
    int yellowCardsTotal = 0;
    int redCardsTotal = 0;
    double offsidePositionMsGK = 0, offsidePositionMsCB = 0, offsidePositionMsFB = 0;
    double offsidePositionMsCM = 0, offsidePositionMsWM = 0, offsidePositionMsCF = 0;
    int shotsHome = 0, shotsAway = 0, shotsOnTarget = 0, saves = 0;
    int keeperClaimCatch = 0, keeperClaimPunch = 0, keeperClaimTip = 0;
    int tacticalFouls = 0;
    int shotsGK = 0, shotsCB = 0, shotsFB = 0, shotsCM = 0, shotsWM = 0, shotsCF = 0, shotsUnknownRole = 0;
    int touchesGK = 0, touchesCB = 0, touchesFB = 0, touchesCM = 0, touchesWM = 0, touchesCF = 0, touchesUnknownRole = 0;
    int goalsHome = 0, goalsAway = 0;
    int homeScore = 0, awayScore = 0;
    int untrackedGoals = 0, directDeliveryGoals = 0, directCrossGoals = 0;
    int headedGoals = 0;
    int tackleDeflectionGoals = 0, goalkeeperParryGoals = 0, shotDeflectionGoals = 0;
    int ownPassGoals = 0, lostShotGoals = 0, unknownLooseGoals = 0, knockAheadGoals = 0;
    int goalsGK = 0, goalsCB = 0, goalsFB = 0, goalsCM = 0, goalsWM = 0, goalsCF = 0, goalsUnknownRole = 0;
    int tackleAttempts = 0, tackleWins = 0, tackleClean = 0, tackleLoose = 0, tackleFouls = 0;
    int penaltiesAwarded = 0, penaltiesTaken = 0, penaltiesScored = 0;
    int slideTackleDistance = 0, slideTackleOob = 0;
    int stuckAlerts = 0;
    int simFreezes = 0;
    int dizzySpins = 0;
    int woodworkHits = 0; // frame (post/bar) contacts — real ~0.5-1/match; audit 2026-07-02 measured 8
    int clearances = 0;
    int blobMoments = 0;
    int marathonCarries = 0, shuttleCarries = 0, lineTooDeepSamples = 0;
    double longestCarryMs = 0;
    int ballJumps = 0;
    int teammatePingPongs = 0;
    int questionableShots = 0;
    int whyNoShoots = 0, questionableBackpasses = 0, clearPathShoots = 0, clearPathDrives = 0;
    int timeWastingDribbles = 0, backwardDribbles = 0, whyPlayerRunningDir = 0;
    int stationaryHold500ms = 0;
    int senselessOutOfPlay = 0, senselessGiveaways = 0;
    int unknownQualityFlags = 0;
    int restartLawViolations = 0;
    int nonsensePasses = 0;
    int decisionMoments = 0, playerDecisions = 0, staleGrabs = 0, skillMoves = 0, shotsBlocked = 0;
    int taskSelectionsTotal = 0, taskSelectionsPrimary = 0, taskSelectionsSecondary = 0;
    int taskSelectionsCover = 0, taskSelectionsLine = 0, taskSelectionsScreen = 0;
    int gkAssessed = 0, unlikelySaves = 0, preventableGoals = 0;
    int pressSamples = 0, questionPress = 0;
    double pressDistTotal = 0;
    int finalThirdSamples = 0, finalThirdUnmarked = 0;
    double finalThirdCbTotal = 0, finalThirdDefTotal = 0;
    int backLineSamples = 0, backLineSingleDrop = 0, backLineLaneBlockSingleDrop = 0;
    double backLineGapTotal = 0, backLineSingleDropGapTotal = 0, backLineGapMax = 0;
    int shotDistClose = 0, shotDistMedium = 0, shotDistLong = 0;
    double shotDistTotal = 0;
    int goalDistClose = 0, goalDistMedium = 0, goalDistLong = 0;
    int dribbleClose = 0, dribbleMedium = 0, dribbleFast = 0;
    int dribble20mShots = 0, dribble20mGoals = 0;
    int knockAheads = 0, knockAheadRecovered = 0, knockAheadRetained = 0;
    int knockAheadTurnovers = 0, knockAheadOutOfPlay = 0;
    int riskyKnockAheads = 0, riskyKnockAheadTurnovers = 0;
    double knockAheadSpeedTotal = 0;
    int carrierSamples = 0, carrierSharp = 0, carrierLimited = 0, carrierOver15 = 0, carrierOver30 = 0;
    int longBackwardCarries = 0;
    double carrierDegTotal = 0;
    int passAudits = 0, riskyPassChoices = 0, saferPassIgnored = 0;
    double passDistTotal = 0, passExpectedTotal = 0;
    int pressuredReceptions = 0, pressuredReceptionFails = 0;
    int goalKickAttempts = 0, goalKickExited = 0, goalKickTrappedShots = 0, goalKickActive = 0;
    int shotAudits = 0, betterPassShots = 0, tightAngleShots = 0;
    double shotAngleTotal = 0, shotPressureTotal = 0;
    int cfCredibleWindows = 0, cfDeferred = 0, cfDeferredPass = 0, cfDeferredDribble = 0;
    int cfCloseWindows = 0, cfCloseDeferred = 0;
    double possessionHome = 0, possessionAway = 0;
    double ballSpeedPeak = 0, ballSpeedTotal = 0;
    int ballSpeedSamples = 0;
    double passLaunchTotal = 0, shotLaunchTotal = 0;
    int passLaunchCount = 0, shotLaunchCount = 0;
};

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
    // NOT WIRED: nothing calls this, so summary["headerControls"] is structurally
    // always 0 — a gap in the measurement, not a measurement of zero. The other two
    // header outcomes (clearance, layoff) are recorded; "controlled it" is the third
    // and the engine never classifies it. Left in place as the seam to wire, rather
    // than deleted, so the reported field and its setter go missing together.
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
    // Round-31: the <100/<200/>=200 bands straddle every interesting boundary —
    // the six-yard box, the penalty spot and the box edge all live inside one
    // bucket, which is why an inverted 6-11m vs 11-16.5m conversion curve was
    // invisible for thirty rounds. Band on the ANALYST's boundaries instead
    // (0-6m, 6-11m, 11-16.5m, 16.5-25m, 25m+) for shots and goals alike.
    static int distanceBandIndex(double distance) {
        if (distance < 60.0) return 0;
        if (distance < 110.0) return 1;
        if (distance < 165.0) return 2;
        if (distance < 250.0) return 3;
        return 4;
    }
    void recordShotDistance(double distance) {
        shotBand[distanceBandIndex(distance)]++;
        shotDistTotal += distance;
        if (distance < 100)
            shotDistClose++;
        else if (distance < 200)
            shotDistMedium++;
        else {
            shotDistLong++;   // kept as the total >=200 band (JSON-stable)
            // Round-23 (11v11 0:32/33): the flat <100/<200/>=200 bands couldn't see
            // the 22.5m+ cliff — split the long band so the new mid-long tail shows.
            if (distance < 260) shotDistLong200_260++;
            else shotDistVeryLong260++;
        }
    }
    void recordShotInBox(bool inBox) { if (inBox) shotsInBox++; }
    void recordGoalInBox(bool inBox) { if (inBox) goalsInBox++; }
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
    void recordWoodworkBar() { woodworkBar++; }
    void recordWoodworkPost() { woodworkPost++; }
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
    // Tripwire: a header resolved above any plausible leap reach (contact gates
    // should make this impossible — nonzero means the ghost-header class is back).
    void recordGhostHeader() { ghostHeaders++; }
    // Tripwire: a pass launched >150° off the passer's facing (selection vetoes
    // these — nonzero means a forced path is leaking no-look bombs).
    void recordBlindPass() { blindPasses++; }
    void recordSuicidePass() { suicidePasses++; }   // own-third lateral ball cut by a closing lane defender <800ms
    void recordOffBallOverspeed() { offBallOverspeed++; }   // teleport-grade single-tick displacement (seed 305 0:09)
    void recordEarlyKickoffGiveaway() { earlyKickoffGiveaways++; }   // pass within 5s of kickoff, cut out (seed 437 0:03)
    void recordCarriedBallOverspeed() { carriedBallOverspeed++; }   // glued ball stepped beyond carrier + allowance (seed 437 0:59)
    void recordCarrierOverspeed() { carrierOverspeed++; }   // carrier BODY stepped beyond the ramped dash peak (round-23 arena 0:05)
    void recordGiftedPass() { giftedPasses++; }   // unforced ball threaded into an opponent already in the lane (round-23 "retard pass")
    void recordBallTeleport() { ballTeleports++; }   // loose ball's one-tick position jumped beyond any legal flight (seed 629 0:48)
    // Round-30: an offside award that RELOCATED the ball to the flagged player's
    // feet. awardOffsideFreeKick arms the set piece in the same tick, which
    // suppresses the ball_teleport tripwire — so a pre-arrival offside call could
    // (and did) fling the ball 265px in one frame with nothing recording it.
    void recordOffsideBallRelocation() { offsideBallRelocations++; }
    // A corner conceded by the defender's own deliberate kick (not a save,
    // duel or deflection) — the "player kicks it out of his own end" class.
    void recordOwnCornerConcession() { ownCornerConcessions++; }
    void recordSetPieceGoal(SetPiece t) {
        if (t == SetPiece::FreeKick) goalsFromFreeKick++;
        else if (t == SetPiece::Corner) goalsFromCorner++;
        else if (t == SetPiece::ThrowIn) goalsFromThrowIn++;
        else if (t == SetPiece::Penalty) goalsFromPenaltyPhase++;
        else goalsOpenPlay++;   // goal kicks / none: build-up, count as open play
    }
    void recordOpenPlayGoal() { goalsOpenPlay++; }
    void recordSkillMove() { skillMoves++; }
    // Round-21 (arena 1v1): a genuine take-on — a jockey-locked carrier committing
    // to beat his man with a feint + explosive burst. Counted separately from the
    // ambient skill-move flourish so duel quality is measurable.
    void recordTakeOn(bool won) { takeOnAttempts++; if (won) takeOnWins++; }
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

    // ── Round-34 census (opt-in: FOOTY_CENSUS=1) ──────────────────────────────
    // Three round-34 verifiers independently found that the engine has NO
    // detector for the defects this round fixes: the carried-ball touch cadence
    // (CarriedBallOverspeed at engine_carry.cpp fires at carrierSpeed+320 while
    // the glue cap clamps every converging tick to carrierSpeed+220, so it is
    // structurally blind to the class), the keeper's pace profile, the restart
    // walk-in, the passer-proximity interception and the loose-ball episode.
    //
    // These are PURE counters. They are accumulated unconditionally — no branch
    // in the simulation reads them, none draws rng, none early-returns, none
    // reorders a player loop — but they are only SERIALISED when FOOTY_CENSUS is
    // set. summaryJSON() is therefore byte-identical with the probe compiled in,
    // which is what keeps tools/golden/fingerprint.sha256 valid.
    struct Census {
        // (1) carried-ball world advance vs the carrier's own advance, on ticks
        //     where the carrier is genuinely moving (>15px/s). ratio<0.35 is the
        //     "frozen" ball the owner watched; the anomaly flag (<0.25 or >2.5)
        //     is round-34 commit 4's guard.
        long carryTicks = 0, carryAnom = 0, carryFrozen = 0, carryBackward = 0;
        long carryBand35_230 = 0, carryBand50_180 = 0, carryTight = 0;
        long carryRatioHist[32] = {};    // 0.1-wide buckets; [31] = >=3.0
        long carryOffsetHist[32] = {};   // 1px-wide buckets of the ball's per-tick
                                         // world step; [31] = >=31px
        long carryTouches = 0, carryTouchesTight = 0;   // stride resets (cadence)
        double carryTightMs = 0.0, carryMs = 0.0;
        // Owner complaint 4 (2:03 "unnatural collect radius") — never measured
        // before. Distance from the collector to the ball at the instant control
        // is granted, split by whether he was the intended receiver (who gets
        // INTENDED_COLLECT_DIST 26px against everyone else's COLLECT_DIST 8px),
        // plus the count of >=60px outright offset writes (the glue's snap
        // branch, engine_carry.cpp).
        long grants = 0, grantsIntended = 0;
        double grantDistSum = 0.0, grantDistMax = 0.0;
        double grantIntendedDistSum = 0.0;
        long grantHist[10] = {};         // 4px buckets; [9] = >=36px
        long glueSnaps = 0;

        // (2) goalkeeper pace, per keeper (0 = home, 1 = away)
        long gkBand[2][5] = {};          // 0 | (0,1) | [1,2) | [2,4) | >=4 m/s
        double gkPathPx[2] = {}, gkMs[2] = {};
        long gkDepth96[2] = {}, gkDepthFar[2] = {};
        long gkDip96to68[2] = {};        // spurious "own pass in flight" collapses

        // (3) phase-filtered outfield speed bands. Without the phase filter the
        //     post-goal walk-in alone moves the squad >5.5m/s share 2.46 -> 3.02%.
        long openBand[6] = {};           // <0.3 | 0.3-2 | 2-4 | 4-5.5 | 5.5-7 | >7 m/s
        long resetBand[6] = {};          // same bands, inside the restart hold

        // restart walk-in geometry (round-34 commit 3's stated mitigation:
        // size the jog cap so the 99th percentile still arrives before the snap)
        long walkArms = 0, walkSnaps = 0, walkSnapOver8 = 0, walkSnapOver20 = 0, walkSnapOver80 = 0;
        double walkStartDistSum = 0.0, walkStartDistMax = 0.0;
        double walkSnapDistSum = 0.0, walkSnapDistMax = 0.0;
        long walkStartHist[20] = {};     // 50px buckets; [19] = >=950px
        // the half-time interval runs the SAME lerp over a 5s hold, so its pace
        // ceiling is worse still. Measured here, not changed this round.
        long htWalkArms = 0;
        double htWalkStartDistSum = 0.0, htWalkStartDistMax = 0.0;

        // (4) pass releases made with an opponent within 70px (7m) of the passer,
        //     and how many of those were the ones cut out.
        long passReleases = 0, passReleasesNearPress = 0;
        long passIntercepts = 0, passInterceptsNearPress = 0;

        // (4b) Round-34 commit 5: the COMMANDED speed of each movement gear, so
        //      the gear ordering is a measured fact and not an assumption. The
        //      gear inversion (committed pursuit pinned at df = 1.0 while an
        //      off-ball run earned df = 1.5) was invisible for exactly as long
        //      as nobody histogrammed this. Gears: 0 fast-dribble, 1 observing
        //      cruise, 2 run, 3 sprint. 2px/s buckets; [63] = >=126px/s.
        long gearHist[4][64] = {};

        // (4c) Round-34 commit 6: the grounded intercept solve. gaArms counts
        //      distinct pursuits it redirects; looseChaser* is the pile-on guard
        //      — the mean number of committed chasers while the ball is loose
        //      must NOT rise (the converger-cap tombstone, agent_defend.cpp
        //      :552-580, measured that loosening who may contest a free ball is
        //      worse at every arena size).
        long gaTicks = 0, gaArms = 0;
        long looseChaserSum = 0, looseChaserTicks = 0, looseChaserMax = 0;

        // (5) loose-ball episodes and the dead-and-uncontrolled share
        long openTicks = 0, looseTicks = 0, looseDeadTicks = 0;
        long looseEpisodes = 0, looseEpisodesOver1s = 0, looseEpisodesOver1500ms = 0;
        double looseMsTotal = 0.0, looseMsMax = 0.0;
        long looseMsHist[24] = {};       // 250ms buckets; [23] = >=5.75s
    };
    Census census;

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
    int woodworkBar = 0;  // bar/post split (round-5 queued instrument: which band drives the 4x rate)
    int woodworkPost = 0;
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
    int offsideBallRelocations = 0;
    int nonsensePasses = 0;
    int decisionMoments = 0, playerDecisions = 0, staleGrabs = 0, skillMoves = 0, shotsBlocked = 0;
    int takeOnAttempts = 0, takeOnWins = 0;
    int ghostHeaders = 0;
    int blindPasses = 0;
    int suicidePasses = 0;
    int offBallOverspeed = 0;
    int earlyKickoffGiveaways = 0;
    int carriedBallOverspeed = 0;
    int carrierOverspeed = 0;
    int giftedPasses = 0;
    int ballTeleports = 0;
    int ownCornerConcessions = 0;
    int goalsFromFreeKick = 0, goalsFromCorner = 0, goalsFromThrowIn = 0,
        goalsFromPenaltyPhase = 0, goalsOpenPlay = 0;
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
    int shotDistLong200_260 = 0, shotDistVeryLong260 = 0;
    double shotDistTotal = 0;
    int goalDistClose = 0, goalDistMedium = 0, goalDistLong = 0;
    // Penalty-area POLYGON census (the radial bands above straddle the box edge).
    // Real football: ~68% of shots and ~85% of goals come from inside the area.
    int shotsInBox = 0, goalsInBox = 0;
    int shotBand[5] = {0, 0, 0, 0, 0}, goalBand[5] = {0, 0, 0, 0, 0};
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

// engine_ball_bounds.cpp — the ball reaches a line, or the frame
//
// Split out of engine_physics.cpp (1739 lines, four subsystems). Every way a
// live ball stops being live by running out of pitch. updateOpenPlayPhase calls
// these three in this order on a ball with no controller, each returning true to
// end the tick's ball step:
//   checkWoodwork    post/crossbar ricochet — first, so a ball off the bar can
//                    never be read as having crossed the line
//   checkGoal        the goal itself: Law 15's no-goal-from-a-throw-in, own-goal
//                    attribution, and the source/credit bookkeeping
//   checkOutOfPlay   goal line and touchline: corner, goal kick or throw-in,
//                    plus the senseless-out quality flag
// The awardCorner / awardSetPiece / awardThrowIn calls at the end of each branch
// are engine_setpiece_award.cpp's — this file decides WHAT happened, that one
// arms the restart.

#include "engine.h"
#include "agent.h"
#include <cmath>
#include <cstdio>

bool GameEngine::checkGoal() {
    auto& b = state.ball;
    bool inOpening = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H;
    if (!inOpening) return false;
    // Law 15: a goal cannot be scored directly from a throw-in. Untouched
    // since the throw (the taker is still retouch-blocked -> nobody else has
    // touched), the ball crossing the line is a goal kick (opponent's goal)
    // or a corner (own goal) — handled by the normal out-of-play award once
    // we refuse the goal here.
    if (lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
        && b.lastToucherId == restartRetouchBlockedId)
        return false;
    auto recordGoalSource = [&](Team scoringTeam) {
        lastGoal.scoringTeam = scoringTeam;
        lastGoal.touchTeam = b.lastTouchTeam;
        lastGoal.toucherId = b.lastToucherId;
        lastGoal.ballSpeed = std::hypot(b.vx, b.vy);
        if (!shot.tracked) {
            if (pendingPass.active && pendingPass.team == scoringTeam) {
                if (pendingPass.isCross) {
                    lastGoal.source = GoalSource::DirectCross;
                } else
                    lastGoal.source = GoalSource::DirectDelivery;
            } else if (pendingPass.active) {
                lastGoal.source = GoalSource::TackleDeflection;
            } else if (lastLooseOrigin == LooseOrigin::TackleDeflection) {
                lastGoal.source = GoalSource::TackleDeflection;
            } else if (lastLooseOrigin == LooseOrigin::GoalkeeperParry) {
                lastGoal.source = GoalSource::GoalkeeperParry;
            } else if (lastLooseOrigin == LooseOrigin::Shot) {
                lastGoal.source = GoalSource::ShotStateLost;
            } else if (lastLooseOrigin == LooseOrigin::ShotBlock) {
                // A blocked shot whose ricochet rolls in (usually off the
                // blocker, an own-goal deflection). The block site sets
                // ShotBlock, but no branch here consumed it — the goal fell
                // through to LooseUnclassified and tripped the scenario guard.
                lastGoal.source = GoalSource::ShotDeflection;
            } else if (lastLooseOrigin == LooseOrigin::KnockAhead) {
                resolveKnockAhead(nullptr, "goal");
                lastGoal.source = GoalSource::KnockAhead;
            } else if (b.lastTouchTeam == scoringTeam && b.lastToucherId >= 0) {
                lastGoal.source = GoalSource::ShotStateLost;
            } else {
                lastGoal.source = GoalSource::LooseUnclassified;
            }
            return;
        }
        if (b.lastTouchTeam != shot.team) {
            lastGoal.source = GoalSource::ShotDeflection;
        } else {
            lastGoal.source = shot.penalty ? GoalSource::Penalty : GoalSource::Shot;
        }
    };
    // A goal: identical bookkeeping for either end — only the scoring team, the goal
    // line, the score counter, and who restarts differ. (Conceding side kicks off.)
    auto finishGoal = [&](Team scoringTeam, double goalLineX) {
        recordGoalSource(scoringTeam);
        double goalDist = 0;
        if (shot.tracked) goalDist = dist(shot.originX, shot.originY, goalLineX, PITCH_H / 2);
        Player* scorer = playerById(lastGoal.toucherId);
        // OWN GOAL: the last toucher is a defender of the CONCEDING team (a deflection
        // into his own net). Don't credit HIM a personal goal/assist or attribute the
        // goal to his role/header — the scoreline is authoritative. (report.ts already
        // filters pGoals via legitGoals but NOT assists/goalsByRole, so this leaked.)
        bool ownGoal = lastGoal.touchTeam != scoringTeam;
        std::optional<Role> scorerRole = (scorer && !ownGoal) ? std::optional<Role>(scorer->role) : std::nullopt;
        if (lastGoal.source == GoalSource::Penalty) stats.recordPenaltyGoal();
        if (shot.dribble20m && lastGoal.source == GoalSource::Shot) stats.recordDribble20mGoal();
        stats.recordGoal(scoringTeam, lastGoal.source, goalDist, lastGoal.ballSpeed, scorerRole, ownGoal ? false : shot.header);
        if (shot.tracked)
            stats.recordGoalInBox(std::abs(shot.originX - goalLineX) < PENALTY_AREA_W
                                  && pitch::lateralFromCenter(shot.originY) < PENALTY_AREA_H / 2.0);
        // A goal from a tracked shot never hit the shotsOnTarget ledger (only SAVED
        // shots did) — count it so shotsOnTarget includes scored shots. Only raises it,
        // so saves<=shotsOnTarget still holds.
        if (lastGoal.source == GoalSource::Shot || lastGoal.source == GoalSource::Penalty) stats.recordShotOnTarget();
        if (passDebug && shot.tracked) fprintf(stderr, "GOALSCORED type=%d src=%d\n", shot.type, (int) lastGoal.source);
        if (!ownGoal) creditGoal(lastGoal.toucherId);
        // Round-30: carry the own-goal truth OUT of the engine. The event's
        // player id is the toucher (a defender of the conceding side on an own
        // goal), and every consumer synthesises the team from that id — so the
        // flag is the only thing that tells them the goal belongs to the other
        // team. Payload only; play is unchanged.
        emitEvent("goal", goalLineX, b.y, lastGoal.toucherId, -1, /*traceOnly=*/false, ownGoal);
        if (scoringTeam == Team::Home)
            state.homeScore++;
        else
            state.awayScore++;
        shot.active = false;
        shot.clearFlags();
        // goal celebration (owner: "have delays after goal") — stoppage accrues via kickoffPhase, so it feeds real added time.
        // Round-23 (arena reaudit): players WALK to the reset over the hold (walkIn)
        // instead of teleporting; the arena hold grows 3s -> 6s to fit the scorer's
        // celebration + the stroll back (11v11 keeps its 9s, already ample). The
        // hold snaps to the exact formation at the end, so the tap is unchanged.
        // Round-30 (arena audit D11): the post-goal walk-in is the ONE restart
        // budget arenaMode never scaled — 6s of dead ball on the centre spot at
        // arena scoring rates costs a real slice of a 10-minute match. Put it on
        // the same ARENA_RESTART_SCALE the free kick / corner / throw budgets
        // already use. 11v11 keeps its 9s exactly.
        // Round-34: 9s -> POST_GOAL_HOLD_MS (16s). The walk-in is now capped at a
        // run (KICKOFF_WALK_SPEED), and 9s x that cap only reaches 468px against a
        // measured p99 distance-to-spot of 750px — every dot beyond it would have
        // re-created the terminal teleport the walk-in exists to remove.
        kickoff(scoringTeam == Team::Home ? Team::Away : Team::Home,
                POST_GOAL_HOLD_MS * (arenaMode ? ARENA_RESTART_SCALE : 1.0), /*walkIn=*/true);
    };
    if (b.x + BALL_R < HOME_GOAL_X) {
        finishGoal(Team::Away, HOME_GOAL_X);
        return true;
    }
    if (b.x - BALL_R > AWAY_GOAL_X) {
        finishGoal(Team::Home, AWAY_GOAL_X);
        return true;
    }
    return false;
}

// Posts and crossbar. A ball arriving at the goal-frame plane that catches an
// upright or the bar ricochets back into play (or down off the bar) instead of
// passing cleanly — the rebound is then live for a follow-up. Runs each tick
// before the goal/out checks; emits a "woodwork" event for the renderer.
bool GameEngine::checkWoodwork() {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    // W1 (user "completely broken hitting of the woodwork"): after a hit, the rebound could still
    // satisfy the same height/x band next tick → re-collide, bounce repeatedly, or STICK at the bar.
    // Hold a few ticks so the rebound clears the band before we re-check. Clock-driven, no rng.
    if (woodworkCooldown > 0) {
        woodworkCooldown--;
        return false;
    }
    double goalX, inSign;
    if (b.vx < -1.0 && b.x <= HOME_GOAL_X + BALL_R + 2.0 && b.x > HOME_GOAL_X - 28.0) {
        goalX = HOME_GOAL_X;
        inSign = 1.0;
    } else if (b.vx > 1.0 && b.x >= AWAY_GOAL_X - BALL_R - 2.0 && b.x < AWAY_GOAL_X + 28.0) {
        goalX = AWAY_GOAL_X;
        inSign = -1.0;
    } else
        return false;
    double center = PITCH_H / 2.0, half = GOAL_W / 2.0;
    double dyPost = std::abs(b.y - center);
    double topOfBall = b.z + BALL_R;
    bool withinPosts = dyPost <= half;
    // ── Crossbar ── arriving at the bar height, between the uprights.
    // NOTE (2026-07-02 audit): shrinking this band + the post band to physical
    // contact was A/B'd and made almost no dent in woodworkHits (3.19->3.0)
    // while costing rebound scrambles — the hit rate is driven by shot AIM
    // (postFrac puts a typical credible finesse at ~36.1px vs the post at
    // 36.5), not by hitbox slack. Fix the aim distribution, not this.
    if (withinPosts && topOfBall >= GOAL_H - 1.0 && b.z <= GOAL_H + BALL_R + 4.0) {
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.32;
        b.vz = -b.vz * 0.45 - 12.0; // W3: reflect the vertical (preserves a ball grazing the bar from above) + a small downward nudge — was -abs()*0.45-30, a forced dead-stick drop
        b.vy *= 0.70;
        b.curl = 0.0;
        woodworkCooldown = 4; // W1: don't re-collide with the bar next tick
        lastLooseOrigin = LooseOrigin::Woodwork;
        stats.recordWoodwork();
        stats.recordWoodworkBar();
        emitEvent("woodwork", goalX, b.y, b.lastToucherId);
        return true;
    }
    // ── Post ── catching an upright (a sliver inside to just outside it), under
    // the bar. Mostly turns near-misses into rattles; rebounds back into play.
    // (See the crossbar NOTE: band-tightening A/B'd 2026-07-02, ineffective —
    // the woodwork rate lives in the aim distribution.)
    if (topOfBall <= GOAL_H + 2.0 && dyPost >= half - 1.5 && dyPost <= half + BALL_R + 3.0) {
        double postSide = (b.y >= center) ? 1.0 : -1.0;
        b.x = goalX + inSign * (BALL_R + 2.0);
        b.vx = -b.vx * 0.45;
        b.vy = postSide * std::abs(b.vy) * 0.55; // shove back off the upright (away from goal-center)
        b.vz *= 0.6;
        b.curl = 0.0;
        woodworkCooldown = 4; // W1: don't re-collide with the post next tick
        lastLooseOrigin = LooseOrigin::Woodwork;
        stats.recordWoodwork();
        stats.recordWoodworkPost();
        emitEvent("woodwork", goalX, center + postSide * half, b.lastToucherId);
        return true;
    }
    return false;
}

bool GameEngine::checkOutOfPlay() {
    auto& b = state.ball;
    Team lt = b.lastTouchTeam;
    // Census (owner ask): a ball put OUT OF PLAY by an UNPRESSURED outfielder who
    // wasn't shooting or crossing — the "just kicked it out of play for no reason"
    // moment. A shot going wide, a cross that runs out, a GK's long ball, or a
    // genuine clearance under pressure are all legitimate and excluded. Detection
    // only — changes no restart, so it can't perturb determinism beyond the counter.
    auto flagSenselessOut = [&]() {
        // Through balls are DELIBERATE-RISK balls like crosses: an overhit led
        // ball running dead past its runner is normal football, not the aimless
        // "just kicked it out" this census measures.
        if (shot.active || (pendingPass.active && (pendingPass.isCross || pendingPass.isThrough))) return;
        // ...including one whose pass tracker already resolved: the sticky
        // risky-launch marker survives the failure so the overhit killer ball
        // rolling dead isn't miscounted as an aimless hoof.
        if (b.lastToucherId == lastRiskyBallToucher && state.clockMs - lastRiskyBallMs < 4000.0) return;
        Player* toucher = playerById(b.lastToucherId);
        if (!toucher || toucher->role == Role::GK || toucher->sentOff) return;
        double nearestOpp = 1e9;
        for (auto& o : state.players)
            if (o.team != toucher->team && o.role != Role::GK && !o.sentOff)
                nearestOpp = std::min(nearestOpp, dist(o.x, o.y, toucher->x, toucher->y));
        if (nearestOpp < 60.0) return;   // pressured — a ball hacked clear is fine
        stats.recordSenselessOutOfPlay();
    };
    auto clearState = [&]() {
        resolveKnockAhead(nullptr, "out_of_play");
        pendingPass.active = false;
        shot.clearFlags();
        lastLooseOrigin = LooseOrigin::None;
    };
    if (b.y < 0 || b.y > PITCH_H) {
        flagSenselessOut();
        clearState();
        // Law 15: the body-block knock-off (ricochet) returns before stamping
        // lastTouchTeam, so a ball rolled dead off a defender's shins was thrown
        // in by the WRONG side. Genuine touches clear the ricochet memory, so a
        // live stamp here means the ricochet IS the last contact — exactly the
        // corner/goal-kick logic above, applied to the touchline.
        Team outTeam = (lastRicochetMs > -1e8) ? lastRicochetTeam : lt;
        awardThrowIn(outTeam, b.y < 0 ? 0 : PITCH_H);
        return true;
    }
    if (b.x < HOME_GOAL_X) {
        // Centre-crossing (not whole-ball `b.x + BALL_R < ...`): a slow ball can
        // rest with its centre behind the goal line — out, but the whole-ball test
        // never fired, so no goal-kick/corner was awarded. The touchline test above
        // is already centre-based (b.y < 0); match it here.
        // A ball over the bar (or wide) is out — only one passing UNDER the bar
        // between the posts was a goal (already taken by checkGoal).
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H
            // Law 15: an untouched throw-in is never a goal — fall through to
            // the corner/goal-kick award (mirrors the checkGoal refusal).
            && !(lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
                 && b.lastToucherId == restartRetouchBlockedId);
        if (!inGoal) {
            if (lt != Team::Home) flagSenselessOut();   // away attacker put it behind for a goal kick
            clearState();
            if (lt == Team::Home
                // Validity, not a 700ms stopwatch (seed 437 1:04: a charged-down
                // cross hung ~2.1s before crossing the line and the window
                // expired — goal kick instead of the corner off the defender's
                // body). Every GENUINE touch now clears the ricochet memory, so
                // a live stamp here means the ricochet IS the last thing that
                // touched the ball, however long it flew.
                || (lastRicochetMs > -1e8 && lastRicochetTeam == Team::Home))
                awardCorner(Team::Away, true, b.y);
            else
                awardSetPiece(SetPiece::GoalKick, Team::Home);
            return true;
        }
    }
    if (b.x > AWAY_GOAL_X) { // centre-crossing (see HOME_GOAL_X note above)
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2 && b.z + BALL_R <= GOAL_H
            // Law 15: an untouched throw-in is never a goal — fall through to
            // the corner/goal-kick award (mirrors the checkGoal refusal).
            && !(lastRestartReleaseType == SetPiece::ThrowIn && restartRetouchBlockedId >= 0
                 && b.lastToucherId == restartRetouchBlockedId);
        if (!inGoal) {
            if (lt != Team::Away) flagSenselessOut();   // home attacker put it behind for a goal kick
            clearState();
            if (lt == Team::Away
                || (lastRicochetMs > -1e8 && lastRicochetTeam == Team::Away))   // validity, not a stopwatch — see the Home mirror above
                awardCorner(Team::Home, false, b.y);
            else
                awardSetPiece(SetPiece::GoalKick, Team::Away);
            return true;
        }
    }
    return false;
}

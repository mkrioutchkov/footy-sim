#include "engine.h"
#include "agent.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Goalkeeper — positioning and save logic
// ══════════════════════════════════════════════════════════════

void GameEngine::updateGK(double sdt) {
    double secs = sdt / 1000.0;
    Player* gk = findGK(Team::Home);
    if (gk && !gk->sentOff) {
        updateOneGK(*gk, secs);
    }
    gk = findGK(Team::Away);
    if (gk && !gk->sentOff) {
        updateOneGK(*gk, secs);
    }
}

bool GameEngine::gkUnderPressure(const Player& gk, double radius) const {
    for (auto& o : state.players)
        if (o.team != gk.team && o.role != Role::GK && !o.sentOff && dist(o.x, o.y, gk.x, gk.y) < radius)
            return true;
    return false;
}

// USERWATCH B: real keepers vary distribution tempo by game state — rush when chasing or late,
// hold when protecting a lead / seeing out time / unpressured. Returns the hold time before the
// keeper distributes (replaces the old uniform GK_DISTRIBUTE_MS at the catch/claim sites).
double GameEngine::gkDistributeMs(const Player& gk) const {
    double mul = 1.0;
    int diff = (gk.team == Team::Home) ? state.homeScore - state.awayScore
                                       : state.awayScore - state.homeScore;
    int minute = static_cast<int>(state.clockMs / 60000.0);
    if (diff > 0)      mul += 0.40;   // leading: slow it down, manage the game
    else if (diff < 0) mul -= 0.30;   // chasing: get it back in play quickly
    if (minute >= 70) {               // late: amplify the game-state intent
        if (diff > 0)      mul += 0.45;   // protecting a lead late: take your time
        else if (diff < 0) mul -= 0.30;   // chasing late: hurry
    }
    if (gkUnderPressure(gk, 95.0)) mul -= 0.40;   // a forward closing in: release quicker
    return clamp(GK_DISTRIBUTE_MS * mul, GK_DISTRIBUTE_MS * 0.45, GK_DISTRIBUTE_MS * 2.1);
}

void GameEngine::updateOneGK(Player& gk, double secs) {
    // Mid-save: dive at the predicted intercept point, nothing else matters.
    if (pendingSave.active && pendingSave.gkId == gk.id) {
        gk.targetX = gk.x;
        gk.targetY = clamp(pendingSave.crossY, 18.0, PITCH_H - 18.0);
        double dy = gk.targetY - gk.y;
        double diveSpeed = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 2.2;
        double step = std::min(diveSpeed * secs, std::abs(dy));
        gk.y += (dy > 0 ? 1.0 : -1.0) * step;
        gk.facing = std::atan2(state.ball.y - gk.y, state.ball.x - gk.x);
        // Held high while committed to the save so the renderer shows the full
        // stretch through the dive, then lingers ~420ms after he lands. Bigger
        // reach = bigger stretch (render-only field, no rng, no logic reads it).
        gk.diveAnim = std::max(gk.diveAnim, clamp(260.0 + std::abs(dy) * 6.0, 260.0, 600.0));
        return;
    }
    double goalX = ownGoalXFor(gk.team);
    double fd = fdFor(gk.team);
    double bdg = std::abs(state.ball.x - goalX);
    double rushFactor = agentFor(gk)->rushAggression();
    // A live shot is bearing on goal: set the feet, get on the line, track the
    // ball's lateral line — do NOT sweep upfield into the shot's path (a
    // failed reflex roll used to drop the keeper to a 43px/s positional walk
    // and even send him forward, so stoppable shots rolled past a flat keeper).
    {
        double bspd = std::hypot(state.ball.vx, state.ball.vy);
        bool shotToGoal = lastLooseOrigin == LooseOrigin::Shot && bspd > 150.0
            && (gk.team == Team::Home ? state.ball.vx < 0 : state.ball.vx > 0)
            && bdg < 320.0;
        if (shotToGoal) {
            double toLine = std::max(std::abs(state.ball.vx), 1.0);
            double projY = state.ball.y + state.ball.vy * (bdg / toLine);
            gk.targetX = goalX + fd * 10.0;
            gk.targetY = clamp(projY, PITCH_H / 2.0 - GOAL_W / 2.0 - 8.0, PITCH_H / 2.0 + GOAL_W / 2.0 + 8.0);
            double mvx = gk.targetX - gk.x, mvy = gk.targetY - gk.y, md = std::hypot(mvx, mvy);
            // A first-touch / fresh cross or through-ball finish gives the keeper no
            // time to set: he reacts late, so cut his tracking burst. This is the
            // real "beat the keeper" lever — the save-roll ceiling barely matters
            // because he otherwise collects almost everything.
            double trackMul = (shot.active && shot.freshFinish) ? 0.95 : 1.05;
            double sp = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * trackMul;
            if (md > 1.0) { double st = std::min(sp * secs, md); gk.x += mvx / md * st; gk.y += mvy / md * st; }
            gk.facing = std::atan2(state.ball.y - gk.y, state.ball.x - gk.x);
            return;
        }
    }
    // Cross hanging into his box: come and ATTACK it — command the box. Without
    // this he claims <1 cross/match (he's never within the 34px commit reach
    // when the ball drops). He sprints to the ball's near-future point; the
    // claim gate in updateBallCollection then resolves catch/punch/tip. The
    // striker still gets first refusal (the intended-receiver block runs before
    // the claim gate), and coming out then NOT claiming is a real risk — that's
    // goalkeeping. Pure positioning, no rng.
    {
        double cbdg = std::abs(state.ball.x - goalX);
        double cdy  = std::abs(state.ball.y - PITCH_H / 2.0);
        bool crossComing = pendingSave.active == false
            && pendingPass.active && pendingPass.isCross && state.ball.controllerId < 0
            && state.ball.z > 12.0                        // a genuine aerial ball
            && cbdg < GK_CLAIM_DEPTH + 46.0 && cdy < GK_CLAIM_HALF_W + 28.0;
        if (crossComing) {
            double lead = 0.14;
            gk.targetX = clamp(state.ball.x + state.ball.vx * lead, goalX + fd * 4.0, goalX + fd * 150.0);
            gk.targetY = clamp(state.ball.y + state.ball.vy * lead, PITCH_H * 0.10, PITCH_H * 0.90);
            double sp = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 1.85;
            double mvx = gk.targetX - gk.x, mvy = gk.targetY - gk.y, md = std::hypot(mvx, mvy);
            if (md > 1.0) { double st = std::min(sp * secs, md); gk.x += mvx / md * st; gk.y += mvy / md * st; }
            gk.facing = std::atan2(state.ball.y - gk.y, state.ball.x - gk.x);
            return;
        }
    }
    bool ballInOurHalf = gk.team == Team::Home ? state.ball.x < PITCH_W * 0.55 : state.ball.x > PITCH_W * 0.45;
    bool towardGoal = gk.team == Team::Home ? state.ball.vx < 0 : state.ball.vx > 0;
    double ballSpeed = std::hypot(state.ball.vx, state.ball.vy);
    bool throughBall = state.ball.intendedReceiverId >= 0 && state.ball.controllerId < 0
        && (fd == 1.0 ? state.ball.vx < 0 : state.ball.vx > 0);
    bool inArea = bdg < PENALTY_AREA_W && std::abs(state.ball.y - gk.homeY) < PENALTY_AREA_H / 2;
    Player* carrier = playerById(state.ball.controllerId);
    bool opponentCarrier = carrier && carrier->team != gk.team;
    bool ballLoose = state.ball.controllerId < 0;
    Player* intendedReceiver = playerById(state.ball.intendedReceiverId);
    bool teammateOutfieldRecovery = ballLoose && intendedReceiver && intendedReceiver->team == gk.team
        && intendedReceiver->role != Role::GK;
    bool keeperEmergency = inArea && (towardGoal || ballSpeed > 160.0)
        && bdg < 115.0 && std::abs(state.ball.y - gk.homeY) < 145.0;
    bool deferToTeammate = teammateOutfieldRecovery && !keeperEmergency;

    // Sweeper-keeper: an opponent has broken clean through — carrying the ball
    // AT GOAL WITH REAL PACE, central, with no covering defender goal-side in his
    // lane. Come off the line and smother the angle instead of waiting on the
    // 6-yard box for a tap-in. Confident keepers (positioning + pace) commit;
    // nervous ones hold. Coming out can be chipped or rounded — that's the trade,
    // and that's goalkeeping. (rushFactor = positioning*0.6 + speed*0.4, 0..1.)
    // Gates are deliberately tight: only a genuine forward break (not a shielding
    // /stationary/lateral carrier — real carries run -39..-65 px/s at goal) inside
    // ~25m triggers it, and the reach is capped at the box edge so the keeper
    // never strands himself where he cannot legally gather a loose ball.
    bool smother1v1 = false;
    if (opponentCarrier && carrier) {
        double cbdg = std::abs(carrier->x - goalX);            // carrier → our goal
        bool headingIn = carrier->vx * fd < -20.0;             // genuinely driving at our goal
        bool central = std::abs(carrier->y - PITCH_H / 2.0) < 185.0;
        if (headingIn && central && cbdg > 70.0 && cbdg < 250.0 && rushFactor > 0.50) {
            int coverGoalSide = 0;
            for (auto& o : state.players) {
                if (o.team != gk.team || o.role == Role::GK || o.sentOff) continue;
                if (std::abs(o.x - goalX) < cbdg - 6.0 && std::abs(o.y - carrier->y) < 100.0)
                    coverGoalSide++;
            }
            smother1v1 = coverGoalSide == 0;
        }
    }

    // A teammate has deliberately played the ball BACK to me. Treat collecting it
    // as top priority: come off the line and MEET it on its line — don't sit back
    // doing angle play, which lets the ball stop short and roll loose for the
    // passer to re-collect (the "pass to self" that looked broken). Capped at the
    // box edge so I never strand myself chasing a wild backpass toward halfway.
    bool backpassToMe = ballLoose && intendedReceiver && intendedReceiver->id == gk.id
        && ballInOurHalf;
    if (backpassToMe) {
        double meetX = state.ball.x - fd * 12.0;            // a touch goal-side of the ball
        gk.targetX = clampRange(meetX, goalX + fd * 6.0, goalX + fd * 175.0);
        gk.targetY = clamp(lerp(gk.y, state.ball.y, 0.6), PITCH_H * 0.10, PITCH_H * 0.90);
    } else if (deferToTeammate) {
        double supportDepth = clamp(bdg * 0.24, 24.0, 76.0);
        gk.targetX = goalX + fd * supportDepth;
        gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.16), gk.homeY - 120.0, gk.homeY + 120.0);
    } else if (inArea && ballLoose && (towardGoal || ballSpeed < 180)) {
        double projectedY = towardGoal
            ? state.ball.y + state.ball.vy * (bdg / std::max(std::abs(state.ball.vx), 1.0))
            : state.ball.y;
        double stepOut = ballSpeed > 260 ? 28.0 : clamp(bdg * (0.45 + rushFactor * 0.25), 34.0, 145.0 + rushFactor * 35.0);
        gk.targetX = goalX + fd * stepOut;
        gk.targetY = clamp(lerp(state.ball.y, projectedY, 0.45), PITCH_H * 0.13, PITCH_H * 0.87);
    } else if (opponentCarrier && inArea) {
        gk.targetX = goalX + fd * clamp(bdg * 0.52, 34.0, 135.0);
        gk.targetY = clamp(lerp(gk.y, state.ball.y, 0.55), PITCH_H * 0.14, PITCH_H * 0.86);
    } else if (bdg < GK_RUSH_DIST && ballLoose) {
        gk.targetX = goalX + fd * clamp(bdg * 0.55, 24.0, 155.0);
        gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.38), PITCH_H * 0.16, PITCH_H * 0.84);
    } else if (ballInOurHalf) {
        // Angle play: stand ON the ball-goal line, stepping out with threat —
        // narrowing the angle is most of goalkeeping. The old Y-lerp toward
        // the ball left near-post gaps off the line.
        double standDepth = clamp(14.0 + (PITCH_W * 0.55 - bdg) * 0.10 + agentFor(gk)->rushAggression() * 16.0, 12.0, 64.0);
        double lineT = clamp(standDepth / std::max(bdg, 1.0), 0.0, 1.0);
        gk.targetX = goalX + fd * standDepth;
        gk.targetY = clamp(gk.homeY + (state.ball.y - gk.homeY) * lineT,
                           gk.homeY - GOAL_W * 0.55, gk.homeY + GOAL_W * 0.55);
    }

    // Rush-out: charge a loose ball / through ball behind the defense, or
    // smother an opponent who's broken clean through (smother1v1, above).
    double rushDist = std::abs(gk.x - state.ball.x);
    bool rushing = !deferToTeammate && !backpassToMe
        && (smother1v1 || (ballLoose && agentFor(gk)->shouldRushOut(rushDist, ballSpeed, throughBall)));
    if (rushing) {
        // clampRange (not clamp) so the off-line bounds stay valid for the Away
        // keeper too — goalX+fd*45 > goalX+fd*175 when fd=-1, which the bare
        // clamp() collapsed into a binary near/far snap.
        // Smother is capped at the box edge (150 < PENALTY_AREA_W 165): on a
        // CARRIED ball the keeper can't win it out there and would only strand
        // himself unable to gather a loose touch. The loose/through-ball rush
        // keeps the full 175 reach — there he's chasing a ball he can collect.
        double rushReach = smother1v1 ? 150.0 : 175.0;
        double rushTargetX = clampRange(state.ball.x - fd * ((throughBall || smother1v1) ? 18.0 : 28.0),
            goalX + fd * 45.0, goalX + fd * rushReach);
        double rushTargetY = clamp(lerp(gk.y, state.ball.y, 0.7), PITCH_H * 0.12, PITCH_H * 0.88);
        gk.targetX = rushTargetX;
        gk.targetY = rushTargetY;
    } else if (!ballLoose || !ballInOurHalf) {
        bool ownTeamHasBall = carrier && carrier->team == gk.team;
        // Sweep high when play is in the far half — standing 2m off the line
        // 80m from the ball reads as a statue, and the space behind the
        // (retreating) defense is the keeper's to cover.
        bool ballFar = !ballInOurHalf;
        double depth = ballFar ? (ownTeamHasBall ? 96.0 : 68.0) : (ownTeamHasBall ? 48.0 : 24.0);
        gk.targetX = gk.homeX + fd * depth;
        gk.targetY = ballFar ? lerp(gk.homeY, state.ball.y, 0.10) : gk.homeY;
    }

    double moveSpeed = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 0.86;
    if (rushing || backpassToMe) moveSpeed += agentFor(gk)->rushOutSpeed();

    double dx = gk.targetX - gk.x, dy = gk.targetY - gk.y, d = std::hypot(dx, dy);
    if (d > 1) { double step = std::min(moveSpeed * secs, d); gk.x += dx / d * step; gk.y += dy / d * step; }
    gk.x = clamp(gk.x, std::min(goalX + fd * 6.0, goalX + fd * 175.0), std::max(goalX + fd * 6.0, goalX + fd * 175.0));
    gk.y = clamp(gk.y, 5.0, PITCH_H - 5.0);

    // G2 (user live-watch: keeper facing the wrong way during normal play). Only the
    // three early-return branches above (save / shot-to-goal / cross-coming) set facing;
    // this default positioning chain moved him but left a STALE facing, so the keeper
    // visibly faced sideways/backward while tracking. He should watch the ball — unless
    // he is the one holding it, where the distribution logic aims him. Pure geometry.
    if (state.ball.controllerId != gk.id) {
        double fdx = state.ball.x - gk.x, fdy = state.ball.y - gk.y;
        if (fdx * fdx + fdy * fdy > 1.0) gk.facing = std::atan2(fdy, fdx);
    } else {
        // F5 (facing audit): while HOLDING the ball pre-distribution, look UP THE PITCH
        // (toward where he'll release) instead of holding a stale facing. The distribution
        // logic still aims the actual throw/kick; this only orients his body upfield.
        gk.facing = std::atan2(PITCH_H / 2.0 - gk.y, fd * (PITCH_W * 0.5));
    }
}

void GameEngine::tryGKSave() {
    if (pendingSave.active) { resolvePendingSave(); return; }
    if (!shot.active) return;
    auto& b = state.ball;
    int shooterId = shot.tracked ? shot.shooterId : b.lastToucherId;
    Team attacking = shot.tracked ? shot.team : b.lastTouchTeam;
    Team defending = attacking == Team::Home ? Team::Away : Team::Home;
    Player* gk = findGK(defending);
    if (!gk || gk->sentOff) return;
    double speed = std::hypot(b.vx, b.vy);
    if (speed < 130) return;
    double goalX = ownGoalXFor(gk->team);
    bool towardGoal = gk->team == Team::Home ? b.vx < 0 : b.vx > 0;
    if (!towardGoal) return;
    bool crossed = gk->team == Team::Home ? b.x + BALL_R < goalX : b.x - BALL_R > goalX;
    if (crossed) return;
    double dToGoal = std::abs(b.x - goalX);
    if (dToGoal > 250) return;
    double crossY = b.y + b.vy * (dToGoal / std::max(std::abs(b.vx), 1.0));
    if (std::abs(crossY - PITCH_H / 2) > GOAL_W / 2) { shot.active = false; return; }
    double trajectoryOffset = std::abs(crossY - gk->y);
    double timeToLineMs = dToGoal / std::max(std::abs(b.vx), 1.0) * 1000;
    double positioning = attrFactor(gk->attrs.positioning);
    double speedSkill = attrFactor(gk->attrs.speed);
    // Realistic reach envelope: a STANDING arm reach the keeper always has, plus
    // a lateral DIVE that's rationed by the time the ball gives him (fast shots
    // far from his set line beat him), plus a HEIGHT cost so a lofted top-corner
    // ball is harder than a flat one. `need` is the (lateral, height) miss the
    // keeper must cover; `reach` is what he can cover. Handling proxy = 0.6 pos +
    // 0.4 speed today; Step 3 swaps in a real attrs.handling.
    double hand = 0.6 * positioning + 0.4 * speedSkill;
    double tAvail = timeToLineMs / 1000.0;                                   // seconds of flight
    double diveCover = (GK_MAX_DIVE_BASE + hand * GK_MAX_DIVE_SKILL) * clamp(tAvail / GK_DIVE_FULL_T, 0.0, 1.0);
    double reach = GK_STAND_REACH + diveCover;
    double zCost = std::max(0.0, b.z - GK_STAND_Z) * GK_Z_WEIGHT;            // top-corner tax
    // A curling ball keeps bending after the keeper has read its line: the
    // lateral he never accounts for (~v·ω·t²/2) adds to what he must cover.
    double curlBend = std::min(std::abs(b.curl) * tAvail * tAvail * speed * 0.5, 30.0);
    double need = std::hypot(trajectoryOffset + curlBend, zCost);
    double reachCover = clamp((reach - need) / reach, 0.0, 1.0);
    double reactTime = clamp(timeToLineMs / 1025.0, 0.18, 1.0);
    double power = clamp((speed - 180.0) / 195.0, 0.0, 0.30);
    double saveChance = clamp(reachCover * (0.38 + 0.42 * reactTime) + positioning * 0.125 - power,   // 0.41->0.38: revert the buff now that shot-selection (a07aeab) cut on-frame volume — let placement/selection carry it, not the keeper
                              GK_SAVE_MIN, GK_SAVE_MAX);
    // Penalties: from 12 yards the keeper is guessing — real save rate is
    // ~17-25%. The reach model overrates him (short flight, centered start).
    if (shot.penalty) saveChance = std::min(saveChance, PENALTY_SAVE_BASE + positioning * PENALTY_SAVE_SKILL);
    if (passDebug) fprintf(stderr, "SAVEROLL type=%d sc=%.3f off=%d z=%d spd=%d t=%d\n",
                           shot.type, saveChance, (int)trajectoryOffset, (int)b.z, (int)speed, (int)timeToLineMs);
    shot.active = false;   // #1b: KEEP this (removing it re-rolls the save 20-30×/shot)
    if (rng.random() >= saveChance) {
        shot.preventable = saveChance >= 0.90 && trajectoryOffset < PLAYER_R + BALL_R && timeToLineMs > 420 && speed < 240;
        stats.recordGkAssessment(false, shot.preventable);
        return;
    }
    // Rolled a save — but the ball still has to GET there. Arm the pending
    // save and let the flight render; the dive resolves on physical contact.
    bool unlikelyCond = saveChance < 0.12 || (timeToLineMs < 130 && trajectoryOffset > reach + 18.0 && speed > 310);
    stats.recordGkAssessment(unlikelyCond, false);
    shot.clearFlags();
    pendingSave = {true, gk->id, shooterId, crossY, reach, true};
}

// The ball is in flight toward a keeper who has already won the save roll.
// Resolve when the segment the ball swept this tick comes within reach, or
// when it crosses the keeper's depth (a 520px/s shot moves ~9px/tick — a
// point check could pass keeper AND goal line in one tick).
void GameEngine::resolvePendingSave() {
    auto& b = state.ball;
    Player* gk = playerById(pendingSave.gkId);
    double bs = std::hypot(b.vx, b.vy);
    // Invalidate: someone touched it, it stopped being a live shot, or died.
    if (!gk || b.controllerId >= 0 || lastLooseOrigin != LooseOrigin::Shot || bs < 40.0) {
        pendingSave.active = false;
        return;
    }
    double s = FIXED_DT / 1000.0;
    double px = b.x - b.vx * s, py = b.y - b.vy * s;
    // Point-to-segment distance from the keeper to this tick's ball path.
    double sx = b.x - px, sy = b.y - py;
    double len2 = sx * sx + sy * sy;
    double t = len2 > 1e-6 ? clamp(((gk->x - px) * sx + (gk->y - py) * sy) / len2, 0.0, 1.0) : 0.0;
    double segDist = dist(gk->x, gk->y, px + sx * t, py + sy * t);
    bool passedDepth = (px - gk->x) * (b.x - gk->x) <= 0.0
        || (b.x - gk->x) * fdFor(gk->team) < 0.0;
    if (segDist > PLAYER_R + BALL_R + 14.0 && !passedDepth) return;
    pendingSave.active = false;
    // Beaten dive: he committed but the ball's past him — no save, let it run.
    if (!pendingSave.willSave) return;
    // #1b: count on-target + save only for a ball actually going IN — under the
    // bar at contact. The 2D save model is z-blind, so a laterally-on-frame but
    // OVER-bar shot reaches here; it is neither on target nor a real save.
    if (b.z + BALL_R <= GOAL_H) {
        stats.recordShotOnTarget();
        stats.recordSave();
    }
    emitEvent("save", gk->x, gk->y, gk->id);
    applySaveOutcome(*gk, pendingSave.shooterId, pendingSave.reach);
}

void GameEngine::applySaveOutcome(Player& gk, int shooterId, double reach) {
    auto& b = state.ball;
    double speed = std::hypot(b.vx, b.vy);
    gk.diveAnim = std::max(gk.diveAnim, 480.0);   // the save itself: full stretch (render-only)
    double positioning = attrFactor(gk.attrs.positioning);
    bool canHandle = agentFor(gk)->canUseHands();
    // Natural handling decision: hold it only when comfortable — ball near
    // the body, pace manageable, nobody breathing down your neck. Under
    // pressure or against heat, get a fist on it instead of gambling.
    bool gkPressured = gkUnderPressure(gk, 52.0);
    double contactOffset = dist(b.x, b.y, gk.x, gk.y);
    bool comfortable = contactOffset < reach * 0.45 && speed < 265.0;
    // Handling now governs catch confidence (was positioning). Keep the SAME
    // short-circuit as before — rng.random() must only be drawn when the first
    // three gates pass, or the extra draw shifts the whole deterministic stream.
    double hf = attrFactor(gk.attrs.handling);
    double catchChance = clamp(0.42 + hf * 0.42 - std::max(0.0, speed - 185.0) / 370.0, 0.12, 0.86);
    bool caught = canHandle && comfortable && !gkPressured && rng.random() < catchChance;
    double fieldDir = fdFor(gk.team);
    double diveSide = (b.y >= gk.y) ? 1.0 : -1.0;
    if (caught) {
        b.x = clamp(gk.x + fieldDir * 6.0, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk.y + diveSide * 4.0, 18.0, PITCH_H - 18.0);
        b.vx = b.vy = b.vz = b.z = 0;
        b.curl = 0;
        b.controllerId = gk.id;
        b.intendedReceiverId = -1;
        blockReboundFor(shooterId, 250);
        b.lastTouchTeam = gk.team; b.lastToucherId = gk.id;
        goalKickMonitor.distributeTimer = gkDistributeMs(gk);
        lastLooseOrigin = LooseOrigin::GoalkeeperCatch;
        recordBallImpulse();
        return;
    }
    // Low handling lowers catchChance above → more shots fall through to the
    // parry below (a LIVE wide rebound), which is the real "couldn't hold it"
    // drama. A central spill-in-front was tried and reverted: defenders mopped
    // it up, so it scored LESS than the wide parry it replaced.
    // Tipped behind: a stretched keeper turning a hard shot around the post or
    // over the bar concedes a corner — the iconic save the engine never made,
    // so corners were near-extinct. More likely the further he had to reach
    // and the harder the shot.
    double tipChance = clamp(0.25 + (contactOffset - reach * 0.3) / reach * 0.5 + (speed - 185.0) / 430.0, 0.0, 0.65);   // BORIS_GK_TIP_AUDIT: floor 0.18->0.25 lifts corners toward ~10
    if (!caught && rng.random() < tipChance) {
        // (no "save" emit here — resolvePendingSave already emitted it before
        // calling us; a second emit double-counted the visual on a tip.)
        // BORIS_GK_TIP_AUDIT: count the tip (was uncounted -> keeperClaimTip read 0) + emit a
        // dedicated 'tip' event so reports/commentary/viewer see the iconic over-the-bar save.
        stats.recordClaimTip();
        emitEvent("tip", gk.x, gk.y, gk.id, shooterId);
        Team attackingTeam = gk.team == Team::Home ? Team::Away : Team::Home;
        awardCorner(attackingTeam, gk.team == Team::Home, b.y);
        return;
    }
    // Punch when hands are unavailable, when pressured, or against real heat:
    // a confident punch sends it long and wide. Otherwise it's a parry — the
    // ball continues PAST the keeper on the side he dove, deadened, a live
    // rebound in the box.
    bool punch = !canHandle || gkPressured || speed > 320.0;
    if (punch) emitEvent("punch", gk.x, gk.y, gk.id);
    double clearSpeed = punch
        ? speed * agentFor(gk)->punchPower()
        : speed * (0.20 + rng.random() * 0.25);
    if (punch) {
        double punchDir = 0.9 + (rng.random() - 0.5) * 0.5;
        b.x = clamp(gk.x + fieldDir * 28, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk.y + diveSide * 20, 18.0, PITCH_H - 18.0);
        b.vx = fieldDir * std::cos(punchDir) * clearSpeed;
        // Always punched to the dive side — the old formula sent left-side
        // dives back ACROSS the goal mouth.
        b.vy = diveSide * std::abs(std::sin(punchDir)) * clearSpeed * 0.9;
        b.z = 6; b.vz = clearSpeed * 0.30;
    } else {
        // Parry continues the shot's journey, pushed wide on the dive side.
        double inAng = std::atan2(b.vy, b.vx);
        double parryAng = inAng + diveSide * (0.55 + rng.random() * 0.5);
        b.x = clamp(gk.x + fieldDir * 16, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk.y + diveSide * (PLAYER_R + BALL_R + 4.0), 18.0, PITCH_H - 18.0);
        b.vx = std::cos(parryAng) * clearSpeed;
        b.vy = std::sin(parryAng) * clearSpeed;
        // never parry INTO the goal: kill any goalward component
        if ((gk.team == Team::Home && b.vx < 0) || (gk.team == Team::Away && b.vx > 0)) b.vx = fieldDir * std::abs(b.vx) * 0.4;
        b.z = 0; b.vz = 0;
        // The parry is a LIVE rebound: the keeper does not get to casually
        // scoop his own spill — strikers crash it first.
        blockReboundFor(gk.id, 1100);
    }
    b.curl = 0;
    b.intendedReceiverId = -1;
    blockReboundFor(shooterId, punch ? 900 : 1400);
    b.lastTouchTeam = gk.team; b.lastToucherId = gk.id;
    lastLooseOrigin = punch ? LooseOrigin::GoalkeeperPunch : LooseOrigin::GoalkeeperParry;
    recordBallImpulse();
}

// The keeper claims an aerial cross hanging in his box (committed by the
// deterministic gate in updateBallCollection). Mirrors applySaveOutcome's
// branch PHYSICS but is self-contained: catch (possession), or — never holding
// it — punch (long + WIDE, never goalward) or tip behind for a corner. There is
// deliberately NO central live drop: a reverted "spill" scored less than the
// wide parry it replaced, because defenders mop up central drops.
void GameEngine::resolveCrossClaim(Player& gk, double claimD) {
    auto& b = state.ball;
    double speed = std::hypot(b.vx, b.vy);
    double hf = attrFactor(gk.attrs.handling);
    double fieldDir = fdFor(gk.team);
    double diveSide = (b.y >= gk.y) ? 1.0 : -1.0;
    gk.diveAnim = std::max(gk.diveAnim, 480.0);   // render-only stretch

    // Crowd: an attacker contesting the keeper's airspace makes a clean claim
    // harder — he's more likely to punch/flap than gather.
    bool gkPressured = gkUnderPressure(gk, GK_CLAIM_CROWD_DIST);

    double reachMargin = clamp((GK_CLAIM_RADIUS - claimD) / GK_CLAIM_RADIUS, 0.0, 1.0);
    double paceCost    = std::max(0.0, speed - 260.0) / GK_CLAIM_PACE_FALL;
    double claimChance = clamp(GK_CLAIM_BASE + hf * GK_CLAIM_SKILL
                               + reachMargin * GK_CLAIM_REACH_BONUS
                               - (gkPressured ? GK_CLAIM_CROWD_PEN : 0.0)
                               - paceCost, GK_CLAIM_MIN, GK_CLAIM_MAX);

    // DRAW #1 — caught. The committed gate IS the short-circuit (exactly like
    // the save roll), so this unconditional draw inside the block is safe.
    if (rng.random() < claimChance) {                          // CATCH → possession
        b.x = clamp(gk.x + fieldDir * 6.0, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk.y + diveSide * 4.0, 18.0, PITCH_H - 18.0);
        b.vx = b.vy = b.vz = b.z = 0; b.curl = 0;
        b.controllerId = gk.id;
        b.intendedReceiverId = -1;
        b.lastTouchTeam = gk.team; b.lastToucherId = gk.id;
        goalKickMonitor.distributeTimer = gkDistributeMs(gk);
        lastLooseOrigin = LooseOrigin::GoalkeeperClaim;
        stats.recordClaimCatch();
        emitEvent("claim", gk.x, gk.y, gk.id);
        blockReboundFor(pendingPass.fromId, 250);
        recordBallImpulse();
        pendingPass.active = false;
        return;
    }

    // NOT caught — no central live drop. Punch (clear with authority) or tip.
    double punchConfidence = clamp(0.30 + hf * 0.55
                                   - (gkPressured ? 0.25 : 0.0)
                                   - paceCost, 0.05, 0.85);
    bool forcePunch = speed > GK_CLAIM_PACE_PUNCH;             // a hard whip gets fisted, not finessed

    // DRAW #2 — punch vs tip (only on the not-caught branch).
    bool doPunch = forcePunch || (rng.random() < punchConfidence);
    if (doPunch) {                                             // PUNCH → long + WIDE, dive-side
        emitEvent("punch", gk.x, gk.y, gk.id);
        stats.recordClaimPunch();
        double clearSpeed = std::max(speed, 260.0) * agentFor(gk)->punchPower();
        // DRAW #3 — punch direction (only inside the punch branch).
        double punchDir = 0.9 + (rng.random() - 0.5) * 0.5;
        b.x = clamp(gk.x + fieldDir * 28, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk.y + diveSide * 20, 18.0, PITCH_H - 18.0);
        b.vx = fieldDir * std::cos(punchDir) * clearSpeed;     // up the pitch, never goalward
        b.vy = diveSide * std::abs(std::sin(punchDir)) * clearSpeed * 0.9;  // to the dive side
        b.z = 6; b.vz = clearSpeed * 0.30;
        b.curl = 0;
        b.intendedReceiverId = -1;
        b.lastTouchTeam = gk.team; b.lastToucherId = gk.id;
        lastLooseOrigin = LooseOrigin::GoalkeeperPunch;
        blockReboundFor(gk.id, 900);
        blockReboundFor(pendingPass.fromId, 900);
        recordBallImpulse();
        pendingPass.active = false;
        return;
    }
    // TIP → corner (clean, dramatic; no live central ball). awardCorner draws nothing.
    emitEvent("save", gk.x, gk.y, gk.id);
    awardCorner(pendingPass.team, gk.team == Team::Home, b.y);
    stats.recordClaimTip();
    pendingPass.active = false;
}


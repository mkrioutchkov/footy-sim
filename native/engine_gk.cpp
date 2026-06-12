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
    if (gk) {
        updateOneGK(*gk, secs);
    }
    gk = findGK(Team::Away);
    if (gk) {
        updateOneGK(*gk, secs);
    }
}

void GameEngine::updateOneGK(Player& gk, double secs) {
    double goalX = ownGoalXFor(gk.team);
    double fd = fdFor(gk.team);
    double bdg = std::abs(state.ball.x - goalX);
    double rushFactor = agentFor(gk)->rushAggression();
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

    if (deferToTeammate) {
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

    // Rush-out: charge at loose ball or through ball behind defense
    double rushDist = std::abs(gk.x - state.ball.x);
    bool rushing = ballLoose && !deferToTeammate && agentFor(gk)->shouldRushOut(rushDist, ballSpeed, throughBall);
    if (rushing) {
        double rushTargetX = clamp(state.ball.x - fd * (throughBall ? 18.0 : 28.0),
            goalX + fd * 45.0, goalX + fd * 175.0);
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
    if (rushing) moveSpeed += agentFor(gk)->rushOutSpeed();

    double dx = gk.targetX - gk.x, dy = gk.targetY - gk.y, d = std::hypot(dx, dy);
    if (d > 1) { double step = std::min(moveSpeed * secs, d); gk.x += dx / d * step; gk.y += dy / d * step; }
    gk.x = clamp(gk.x, std::min(goalX + fd * 6.0, goalX + fd * 175.0), std::max(goalX + fd * 6.0, goalX + fd * 175.0));
    gk.y = clamp(gk.y, 5.0, PITCH_H - 5.0);
}

void GameEngine::tryGKSave() {
    if (!shot.active) return;
    auto& b = state.ball;
    int shooterId = shot.tracked ? shot.shooterId : b.lastToucherId;
    Team attacking = shot.tracked ? shot.team : b.lastTouchTeam;
    Team defending = attacking == Team::Home ? Team::Away : Team::Home;
    Player* gk = findGK(defending);
    if (!gk) return;
    double speed = std::hypot(b.vx, b.vy);
    if (speed < 200) return;
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
    // Natural save model: a save is the body getting there in the time
    // available — reach coverage of the trajectory, scaled by reaction time,
    // taxed by shot power. No abstract bonus stack.
    double reach = PLAYER_R + BALL_R + 22.0 + positioning * 28.0
        + speedSkill * clamp(timeToLineMs / 1000.0, 0.0, 0.50) * 80.0;
    double reachCover = clamp((reach - trajectoryOffset) / reach, 0.0, 1.0);
    double reactTime = clamp(timeToLineMs / 520.0, 0.18, 1.0);
    double power = clamp((speed - 240.0) / 420.0, 0.0, 0.30);
    double saveChance = clamp(reachCover * (0.50 + 0.42 * reactTime) + positioning * 0.16 - power,
                              GK_SAVE_MIN, 0.84);
    // Penalties: from 12 yards the keeper is guessing — real save rate is
    // ~17-25%. The reach model overrates him (short flight, centered start).
    if (shot.penalty) saveChance = std::min(saveChance, PENALTY_SAVE_BASE + positioning * PENALTY_SAVE_SKILL);
    stats.recordShotOnTarget();
    shot.active = false;
    if (rng.random() >= saveChance) {
        shot.preventable = saveChance >= 0.90 && trajectoryOffset < PLAYER_R + BALL_R && timeToLineMs > 420 && speed < 390;
        stats.recordGkAssessment(false, shot.preventable);
        return;
    }
    stats.recordSave();
    emitEvent("save", gk->x, gk->y, gk->id);
    bool unlikelyCond = saveChance < 0.12 || (timeToLineMs < 130 && trajectoryOffset > reach + 18.0 && speed > 500);
    stats.recordGkAssessment(unlikelyCond, false);
    shot.clearFlags();
    bool canHandle = agentFor(*gk)->canUseHands();
    // Natural handling decision: hold it only when comfortable — ball near
    // the body, pace manageable, nobody breathing down your neck. Under
    // pressure or against heat, get a fist on it instead of gambling.
    bool gkPressured = false;
    for (auto& o : state.players) {
        if (o.team != gk->team && o.role != Role::GK && dist(o.x, o.y, gk->x, gk->y) < 52.0) { gkPressured = true; break; }
    }
    bool comfortable = trajectoryOffset < reach * 0.45 && speed < 430.0;
    double catchChance = clamp(0.42 + positioning * 0.42 - std::max(0.0, speed - 300.0) / 600.0, 0.12, 0.86);
    bool caught = canHandle && comfortable && !gkPressured && rng.random() < catchChance;
    double fieldDir = fdFor(gk->team);
    double side = gk->y - shot.originY < 0 ? -1.0 : 1.0;
    double diveSide = (crossY >= gk->y) ? 1.0 : -1.0;
    if (caught) {
        b.x = clamp(gk->x + fieldDir * 6.0, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk->y + side * 4.0, 18.0, PITCH_H - 18.0);
        b.vx = b.vy = b.vz = b.z = 0;
        b.curl = 0;
        b.controllerId = gk->id;
        b.intendedReceiverId = -1;
        blockReboundFor(shooterId, 250);
        b.lastTouchTeam = gk->team; b.lastToucherId = gk->id;
        goalKickMonitor.distributeTimer = GK_DISTRIBUTE_MS;
        lastLooseOrigin = "goalkeeper_catch";
        recordBallImpulse();
        return;
    }
    // Punch when hands are unavailable, when pressured, or against real heat:
    // a confident punch sends it long and wide. Otherwise it's a parry — the
    // ball continues PAST the keeper on the side he dove, deadened, a live
    // rebound in the box.
    bool punch = !canHandle || gkPressured || speed > 520.0;
    if (punch) emitEvent("punch", gk->x, gk->y, gk->id);
    double clearSpeed = punch
        ? speed * agentFor(*gk)->punchPower()
        : speed * (0.20 + rng.random() * 0.25);
    if (punch) {
        double punchDir = (diveSide > 0 ? 0.9 : -0.9) + (rng.random() - 0.5) * 0.5;
        b.x = clamp(gk->x + fieldDir * 28, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk->y + diveSide * 20, 18.0, PITCH_H - 18.0);
        b.vx = fieldDir * std::cos(punchDir) * clearSpeed;
        b.vy = std::sin(punchDir) * clearSpeed * (diveSide > 0 ? 1.0 : -1.0) * 0.6 + diveSide * clearSpeed * 0.3;
        b.z = 6; b.vz = clearSpeed * 0.30;
    } else {
        // Parry continues the shot's journey, pushed wide on the dive side.
        double inAng = std::atan2(b.vy, b.vx);
        double parryAng = inAng + diveSide * (0.55 + rng.random() * 0.5);
        b.x = clamp(gk->x + fieldDir * 16, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk->y + diveSide * (PLAYER_R + BALL_R + 4.0), 18.0, PITCH_H - 18.0);
        b.vx = std::cos(parryAng) * clearSpeed;
        b.vy = std::sin(parryAng) * clearSpeed;
        // never parry INTO the goal: kill any goalward component
        if ((gk->team == Team::Home && b.vx < 0) || (gk->team == Team::Away && b.vx > 0)) b.vx = fieldDir * std::abs(b.vx) * 0.4;
        b.z = 0; b.vz = 0;
    }
    b.curl = 0;
    b.intendedReceiverId = -1;
    blockReboundFor(shooterId, punch ? 900 : 1400);
    b.lastTouchTeam = gk->team; b.lastToucherId = gk->id;
    lastLooseOrigin = punch ? "goalkeeper_punch" : "goalkeeper_parry";
    recordBallImpulse();
}


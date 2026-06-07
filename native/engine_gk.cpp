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

    if (inArea && ballLoose && (towardGoal || ballSpeed < 180)) {
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
        double sweepBase = agentFor(gk)->sweepDepth();
        double sweepDist = clamp(sweepBase * (PITCH_W * 0.55 - bdg) / (PITCH_W * 0.55), 0.0, sweepBase);
        gk.targetX = gk.homeX + fd * sweepDist;
        gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.22), PITCH_H * 0.18, PITCH_H * 0.82);
    }

    // Rush-out: charge at loose ball or through ball behind defense
    double rushDist = std::abs(gk.x - state.ball.x);
    bool rushing = ballLoose && agentFor(gk)->shouldRushOut(rushDist, ballSpeed, throughBall);
    if (rushing) {
        double rushTargetX = clamp(state.ball.x - fd * (throughBall ? 18.0 : 28.0),
            goalX + fd * 45.0, goalX + fd * 175.0);
        double rushTargetY = clamp(lerp(gk.y, state.ball.y, 0.7), PITCH_H * 0.12, PITCH_H * 0.88);
        gk.targetX = rushTargetX;
        gk.targetY = rushTargetY;
    } else if (!ballLoose || !ballInOurHalf) {
        bool ownTeamHasBall = carrier && carrier->team == gk.team;
        gk.targetX = gk.homeX + fd * (ownTeamHasBall ? 48.0 : 24.0);
        gk.targetY = gk.homeY;
    }

    double moveSpeed = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 0.86;
    if (rushing) moveSpeed += agentFor(gk)->rushOutSpeed();

    double dx = gk.targetX - gk.x, dy = gk.targetY - gk.y, d = std::hypot(dx, dy);
    if (d > 1) { double step = std::min(moveSpeed * secs, d); gk.x += dx / d * step; gk.y += dy / d * step; }
    gk.x = clamp(gk.x, std::min(goalX + fd * 6.0, goalX + fd * 175.0), std::max(goalX + fd * 6.0, goalX + fd * 175.0));
    gk.y = clamp(gk.y, 5.0, PITCH_H - 5.0);
}

void GameEngine::tryGKSave() {
    if (!shotActive) return;
    auto& b = state.ball;
    int shooterId = trackedShot ? trackedShooterId : b.lastToucherId;
    Team attacking = trackedShot ? trackedShotTeam : b.lastTouchTeam;
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
    if (std::abs(crossY - PITCH_H / 2) > GOAL_W / 2) { shotActive = false; return; }
    double originDistance = std::hypot(shotOriginX - goalX, shotOriginY - PITCH_H / 2);
    double trajectoryOffset = std::abs(crossY - gk->y);
    double timeToLineMs = dToGoal / std::max(std::abs(b.vx), 1.0) * 1000;
    double positioning = attrFactor(gk->attrs.positioning);
    double speedSkill = attrFactor(gk->attrs.speed);
    double reactionBonus = clamp((originDistance - 55.0) / 330.0, 0.0, 0.30);
    double timePressure = clamp((260.0 - timeToLineMs) / 240.0, 0.0, 0.42);
    double speedPenalty = clamp((speed - 430.0) / 380.0, 0.0, 0.20);
    double reach = PLAYER_R + BALL_R + 18.0 + positioning * 30.0 + speedSkill * clamp(timeToLineMs / 1000.0, 0.0, 0.55) * 78.0;
    double reachPenalty = clamp((trajectoryOffset - reach) / 92.0, 0.0, 1.0) * 0.46;
    double bodyBlockBonus = trajectoryOffset < PLAYER_R + BALL_R + 4.0 ? 0.20 : 0.0;
    double keeperSkill = positioning * 0.42 + speedSkill * 0.22;
    double saveChance = clamp(0.18 + keeperSkill + reactionBonus + bodyBlockBonus - reachPenalty - timePressure - speedPenalty, 0.05, 0.91);
    stats.recordShotOnTarget();
    shotActive = false;
    if (rng.random() >= saveChance) {
        trackedShotPreventable = saveChance >= 0.90 && trajectoryOffset < PLAYER_R + BALL_R && timeToLineMs > 420 && speed < 390;
        stats.recordGkAssessment(false, trackedShotPreventable);
        return;
    }
    stats.recordSave();
    emitEvent("save", gk->x, gk->y, gk->id);
    bool unlikelyCond = saveChance < 0.12 || (timeToLineMs < 130 && trajectoryOffset > reach + 18.0 && speed > 500);
    stats.recordGkAssessment(unlikelyCond, false);
    trackedShot = false;
    trackedShotPreventable = false;
    trackedShotHeader = false;
    trackedPenaltyShot = false;
    trackedShotDribble20m = false;
    bool canHandle = agentFor(*gk)->canUseHands();
    double catchChance = clamp(agentFor(*gk)->catchThreshold() - std::max(0.0, speed - 520) / 900, 0.12, 0.58);
    bool caught = canHandle && rng.random() < catchChance;
    double fieldDir = fdFor(gk->team);
    double side = gk->y - shotOriginY < 0 ? -1.0 : 1.0;
    if (caught) {
        b.x = clamp(gk->x + fieldDir * 6.0, 10.0, PITCH_W - 10.0);
        b.y = clamp(gk->y + side * 4.0, 18.0, PITCH_H - 18.0);
        b.vx = b.vy = b.vz = b.z = 0;
        b.controllerId = gk->id;
        b.intendedReceiverId = -1;
        blockReboundFor(shooterId, 250);
        b.lastTouchTeam = gk->team; b.lastToucherId = gk->id;
        gkDistributeTimer = 250;
        lastLooseOrigin = "goalkeeper_catch";
        recordBallImpulse();
        return;
    }
    // Parry or punch: punch when outside area (cannot use hands) or when GK prefers to fist
    bool punch = !canHandle;
    if (punch) emitEvent("punch", gk->x, gk->y, gk->id);
    double clearSpeed = punch
        ? speed * agentFor(*gk)->punchPower()
        : speed * (0.50 + rng.random() * 0.40);
    double clearDir = punch
        ? (gk->y < PITCH_H / 2.0 ? -1.4 : 1.4) + (rng.random() - 0.5) * 0.4
        : (-0.8 + rng.random() * 1.6);
    double cornerY = (gk->y < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
    if (!punch) clearDir += (cornerY - gk->y) * 0.003;
    b.x = clamp(gk->x + fieldDir * 28, 10.0, PITCH_W - 10.0);
    b.y = clamp(gk->y - side * 24, 18.0, PITCH_H - 18.0);
    b.vx = fieldDir * std::cos(clearDir) * clearSpeed;
    b.vy = -side * std::abs(std::sin(clearDir)) * clearSpeed;
    b.z = 0; b.vz = punch ? clearSpeed * 0.25 : 0;
    b.intendedReceiverId = -1;
    blockReboundFor(shooterId, punch ? 900 : 1400);
    b.lastTouchTeam = gk->team; b.lastToucherId = gk->id;
    lastLooseOrigin = punch ? "goalkeeper_punch" : "goalkeeper_parry";
    recordBallImpulse();
}


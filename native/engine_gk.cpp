#include "engine.h"
#include "agent.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Goalkeeper — positioning and save logic
// ══════════════════════════════════════════════════════════════

void GameEngine::separateTeammates(double sdt) {
    double secs = sdt / 1000.0;
    double maxPush = 18.0 * secs;
    for (size_t i = 0; i < state.players.size(); ++i) {
        for (size_t j = i + 1; j < state.players.size(); ++j) {
            Player& a = state.players[i];
            Player& b = state.players[j];
            if (a.team != b.team || a.role == Role::GK || b.role == Role::GK) continue;
            double dx = b.x - a.x, dy = b.y - a.y;
            double d = std::hypot(dx, dy);
            if (d < 0.1 || d >= SEPARATION_DIST) continue;
            double nx = dx / d, ny = dy / d;
            double push = std::min(maxPush, (SEPARATION_DIST - d) * 0.18);
            bool aFixed = state.ball.controllerId == a.id || isActiveKnockAheadRunner(a.id);
            bool bFixed = state.ball.controllerId == b.id || isActiveKnockAheadRunner(b.id);
            if (aFixed && bFixed) continue;
            if (aFixed) {
                b.x = clamp(b.x + nx * push * 2.0, 5.0, PITCH_W - 5.0);
                b.y = clamp(b.y + ny * push * 2.0, 5.0, PITCH_H - 5.0);
            } else if (bFixed) {
                a.x = clamp(a.x - nx * push * 2.0, 5.0, PITCH_W - 5.0);
                a.y = clamp(a.y - ny * push * 2.0, 5.0, PITCH_H - 5.0);
            } else {
                a.x = clamp(a.x - nx * push, 5.0, PITCH_W - 5.0);
                a.y = clamp(a.y - ny * push, 5.0, PITCH_H - 5.0);
                b.x = clamp(b.x + nx * push, 5.0, PITCH_W - 5.0);
                b.y = clamp(b.y + ny * push, 5.0, PITCH_H - 5.0);
            }
        }
    }
}

void GameEngine::updateGK(double sdt) {
    double secs = sdt / 1000.0;
    for (auto& gk : state.players) {
        if (gk.role != Role::GK) continue;
        double goalX = ownGoalXFor(gk.team);
        double fd = gk.team == Team::Home ? 1.0 : -1.0;
        double bdg = std::abs(state.ball.x - goalX);
        bool ballInOurHalf = gk.team == Team::Home ? state.ball.x < PITCH_W * 0.55 : state.ball.x > PITCH_W * 0.45;
        bool towardGoal = gk.team == Team::Home ? state.ball.vx < 0 : state.ball.vx > 0;
        double ballSpeed = std::hypot(state.ball.vx, state.ball.vy);
        bool inArea = bdg < PENALTY_AREA_W && std::abs(state.ball.y - gk.homeY) < PENALTY_AREA_H / 2;
        Player* carrier=playerById(state.ball.controllerId);
        bool opponentCarrier=carrier&&carrier->team!=gk.team;
        if (inArea && state.ball.controllerId < 0 && (towardGoal || ballSpeed < 180)) {
            double projectedY = towardGoal
                ? state.ball.y + state.ball.vy * (bdg / std::max(std::abs(state.ball.vx), 1.0))
                : state.ball.y;
            double stepOut = ballSpeed > 260 ? 28.0 : clamp(bdg * 0.45, 34.0, 145.0);
            gk.targetX = goalX + fd * stepOut;
            gk.targetY = clamp(lerp(state.ball.y, projectedY, 0.45), PITCH_H * 0.13, PITCH_H * 0.87);
        } else if (opponentCarrier && inArea) {
            gk.targetX = goalX + fd * clamp(bdg * 0.52, 34.0, 135.0);
            gk.targetY = clamp(lerp(gk.y, state.ball.y, 0.55), PITCH_H * 0.14, PITCH_H * 0.86);
        } else if (bdg < GK_RUSH_DIST && state.ball.controllerId < 0) {
            gk.targetX = goalX + fd * clamp(bdg * 0.55, 24.0, 155.0);
            gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.38), PITCH_H * 0.16, PITCH_H * 0.84);
        } else if (ballInOurHalf) {
            double sweepDepth = clamp((PITCH_W * 0.55 - bdg) * 0.22, 0.0, 82.0);
            gk.targetX = gk.homeX + fd * sweepDepth;
            gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.22), PITCH_H * 0.18, PITCH_H * 0.82);
        } else {
            bool ownTeamHasBall=carrier&&carrier->team==gk.team;
            gk.targetX = gk.homeX + fd * (ownTeamHasBall ? 48.0 : 24.0);
            gk.targetY = gk.homeY;
        }
        double moveSpeed = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 0.86;
        double dx = gk.targetX - gk.x, dy = gk.targetY - gk.y, d = std::hypot(dx, dy);
        if (d > 1) { double step = std::min(moveSpeed * secs, d); gk.x += dx / d * step; gk.y += dy / d * step; }
        gk.x = clamp(gk.x, std::min(goalX + fd * 6.0, goalX + fd * 175.0), std::max(goalX + fd * 6.0, goalX + fd * 175.0));
        gk.y = clamp(gk.y, 5.0, PITCH_H - 5.0);
    }
}

void GameEngine::tryGKSave() {
    if (!shotActive) return;
    auto& b = state.ball;
    int shooterId = trackedShot ? trackedShooterId : b.lastToucherId;
    Player* gk = nullptr;
    Team attacking = trackedShot ? trackedShotTeam : b.lastTouchTeam;
    Team defending = attacking == Team::Home ? Team::Away : Team::Home;
    for (auto& p : state.players) if (p.team == defending && p.role == Role::GK) { gk = &p; break; }
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
    bool unlikelyCond = saveChance < 0.12 || (timeToLineMs < 130 && trajectoryOffset > reach + 18.0 && speed > 500);
    stats.recordGkAssessment(unlikelyCond, false);
    trackedShot = false;
    trackedShotPreventable = false;
    trackedShotHeader = false;
    trackedPenaltyShot = false;
    double handling = attrFactor(gk->attrs.positioning);
    double catchChance = clamp(0.22 + handling * 0.38 - std::max(0.0, speed - 520) / 900, 0.12, 0.58);
    bool caught = rng.random() < catchChance;
    double fieldDir = gk->team == Team::Home ? 1.0 : -1.0;
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
    double parryDampen = 0.50 + rng.random() * 0.40;
    double parrySpeed = speed * (1.0 - parryDampen);
    double parryAngle = -0.8 + rng.random() * 1.6;
    double cornerY = (gk->y < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
    parryAngle += (cornerY - gk->y) * 0.003;
    b.x = clamp(gk->x + fieldDir * 28, 10.0, PITCH_W - 10.0);
    b.y = clamp(gk->y - side * 24, 18.0, PITCH_H - 18.0);
    b.vx = fieldDir * std::cos(parryAngle) * parrySpeed;
    b.vy = -side * std::abs(std::sin(parryAngle)) * parrySpeed;
    b.z = b.vz = 0;
    b.intendedReceiverId = -1;
    blockReboundFor(shooterId, 1400);
    b.lastTouchTeam = gk->team; b.lastToucherId = gk->id;
    lastLooseOrigin = "goalkeeper_parry";
    recordBallImpulse();
}


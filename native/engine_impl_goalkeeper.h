#pragma once
// engine_impl_goalkeeper.h — GK positioning and save logic

inline void GameEngine::updateGK(double sdt) {
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
        if (inArea && towardGoal && ballSpeed > 100 && state.ball.controllerId < 0) {
            gk.targetX = clamp(state.ball.x + state.ball.vx * 0.4, std::min(goalX, goalX + fd * 180), std::max(goalX, goalX + fd * 180));
            gk.targetY = clamp(state.ball.y + state.ball.vy * 0.4, PITCH_H * 0.15, PITCH_H * 0.85);
        } else if (bdg < GK_RUSH_DIST) {
            gk.targetX = goalX + fd * std::min(bdg * 0.5, 150.0);
            gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.3), PITCH_H * 0.2, PITCH_H * 0.8);
        } else if (ballInOurHalf) {
            gk.targetX = gk.homeX;
            gk.targetY = clamp(lerp(gk.homeY, state.ball.y, 0.15), PITCH_H * 0.2, PITCH_H * 0.8);
        } else {
            gk.targetX = gk.homeX;
            gk.targetY = gk.homeY;
        }
        double moveSpeed = attrFactor(gk.attrs.speed) * MAX_PLAYER_SPEED * 0.55;
        double dx = gk.targetX - gk.x, dy = gk.targetY - gk.y, d = std::hypot(dx, dy);
        if (d > 1) { double step = std::min(moveSpeed * secs, d); gk.x += dx / d * step; gk.y += dy / d * step; }
        gk.x = clamp(gk.x, 5.0, PITCH_W - 5.0);
        gk.y = clamp(gk.y, 5.0, PITCH_H - 5.0);
    }
}

inline void GameEngine::tryGKSave() {
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
    double keeperSkill = attrFactor(gk->attrs.positioning) * 0.58 + attrFactor(gk->attrs.speed) * 0.19;
    double reactionBonus = clamp((originDistance - 65) / 300, 0.0, 0.25);
    double placementPenalty = clamp(std::abs(crossY - gk->y) / 70, 0.0, 1.0) * 0.30;
    double speedPenalty = clamp((speed - 450) / 350, 0.0, 0.15);
    double saveChance = clamp(0.11 + keeperSkill + reactionBonus - placementPenalty - speedPenalty, 0.08, 0.86);
    double trajectoryOffset = std::abs(crossY - gk->y);
    double timeToLineMs = dToGoal / std::max(std::abs(b.vx), 1.0) * 1000;
    stats.recordShotOnTarget();
    shotActive = false;
    if (rng.random() >= saveChance) {
        trackedShotPreventable = saveChance >= 0.84 || (trajectoryOffset < 10 && timeToLineMs > 360 && speed < 410);
        stats.recordGkAssessment(false, trackedShotPreventable);
        return;
    }
    stats.recordSave();
    bool unlikelyCond = saveChance < 0.18 || (timeToLineMs < 150 && trajectoryOffset > 40 && speed > 450);
    stats.recordGkAssessment(unlikelyCond, false);
    trackedShot = false;
    trackedShotPreventable = false;
    double handling = attrFactor(gk->attrs.positioning);
    double catchChance = clamp(0.22 + handling * 0.38 - std::max(0.0, speed - 520) / 900, 0.12, 0.58);
    if (rng.random() < catchChance) {
        b.x = gk->x;
        b.y = gk->y;
        collectBall(*gk);
        gkDistributeTimer = 400;
        return;
    }
    double fieldDir = gk->team == Team::Home ? 1.0 : -1.0;
    double side = gk->y - shotOriginY < 0 ? -1.0 : 1.0;
    double parrySpeedX = 155 + speed * 0.10;
    double parrySpeedY = 140 + rng.random() * 90;
    b.x = clamp(gk->x + fieldDir * 28, 10.0, PITCH_W - 10.0);
    b.y = clamp(gk->y + side * 24, 18.0, PITCH_H - 18.0);
    b.vx = fieldDir * parrySpeedX;
    b.vy = side * parrySpeedY;
    b.z = b.vz = 0;
    b.intendedReceiverId = -1;
    blockReboundFor(shooterId, 1400);
    b.lastTouchTeam = gk->team;
    b.lastToucherId = gk->id;
    lastLooseOrigin = "goalkeeper_parry";
    recordBallImpulse();
}

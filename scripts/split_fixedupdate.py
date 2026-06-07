with open('native/engine.cpp', 'r', encoding='utf-8') as f:
    content = f.read()

old = 'void GameEngine::tickAgents(double sdt, bool ic) {'
new_methods = '''void GameEngine::updatePlayerAnimations(double sdt) {
    for (auto& p : state.players) {
        if (p.tackleAnim > 0) p.tackleAnim = std::max(0., p.tackleAnim - sdt);
        if (p.headingAnim > 0) p.headingAnim = std::max(0., p.headingAnim - sdt);
        if (p.crossCollected > 0) p.crossCollected = std::max(0., p.crossCollected - sdt);
    }
}

void GameEngine::updatePossessionTracking(double sdt) {
    auto* c = playerById(state.ball.controllerId);
    if (c) {
        if (c->team == Team::Home) possessionHome += sdt;
        else possessionAway += sdt;
        double fd = c->team == Team::Home ? 1.0 : -1.0;
        if (c->id != backwardCarryCarrierId) {
            backwardCarryCarrierId = c->id;
            backwardCarryStartX = c->x;
            backwardCarryRecorded = false;
        } else if (!backwardCarryRecorded && (c->x - backwardCarryStartX) * fd < -200.0) {
            stats.recordLongBackwardCarry();
            backwardCarryRecorded = true;
        }
    } else {
        backwardCarryCarrierId = -1;
        backwardCarryRecorded = false;
    }
    stats.recordPossession(possessionHome, possessionAway);
    auditStuckCarrier(sdt);
}

void GameEngine::detectSimulationFreeze(double sdt) {
    if (setPieceArmed || kickoffPhase) return;
    auto& fb = state.ball;
    int cid = fb.controllerId;
    if (cid < 0) {
        freezeWatchMs = 0;
        freezeLastController = -1;
    } else if (cid != freezeLastController) {
        freezeWatchMs = 0;
        freezeBallX = fb.x;
        freezeBallY = fb.y;
        freezeLastController = cid;
    } else {
        freezeWatchMs += sdt;
        if (dist(fb.x, fb.y, freezeBallX, freezeBallY) >= 5) {
            freezeWatchMs = 0;
            freezeBallX = fb.x;
            freezeBallY = fb.y;
        } else if (freezeWatchMs > 1500 && state.clockMs - lastFreezeAlertMs > 5000) {
            Player* frozen=playerById(cid);
            Player* best=nullptr; double bestD=1e9;
            if(frozen&&frozen->role!=Role::GK){
                for(auto&p:state.players){
                    if(p.team!=frozen->team||p.id==frozen->id||p.role==Role::GK)continue;
                    double d=dist(frozen->x,frozen->y,p.x,p.y);
                    if(d<bestD){bestD=d;best=&p;}
                }
            }
            if(frozen&&best){
                forcePassTo(*frozen,*best,nullptr);
            }else if(frozen){
                double fd=frozen->team==Team::Home?1.0:-1.0;
                frozen->targetX=clamp(frozen->x+fd*90.0,35.0,PITCH_W-35.0);
                frozen->targetY=clamp(frozen->y+(frozen->y<PITCH_H/2?-45.0:45.0),35.0,PITCH_H-35.0);
            }else{
                simulationFreezes++;
                stats.recordSimulationFreeze();
                lastFreezeAlertMs = state.clockMs;
            }
            freezeWatchMs = 0;
            freezeBallX = fb.x;
            freezeBallY = fb.y;
        }
    }
}

void GameEngine::updateSetPiecePhase(double sdt, double sec) {
    actionTimer -= sdt;
    Team spTeam = setPieceTeamEnum;
    for (auto& a : agents) {
        a->setPiecePositioning(setPieceTypeEnum, spTeam);
    }
    auto placeTakerForRestart = [&](Player& taker, bool releaseSpot) {
        double fd = taker.team == Team::Home ? 1.0 : -1.0;
        double standBack = setPieceTypeEnum == SetPiece::ThrowIn ? 0.0 : setPieceTypeEnum == SetPiece::Corner ? 7.0 : setPieceTypeEnum == SetPiece::Penalty ? 18.0 : 14.0;
        double px = releaseSpot ? setPieceSpotX : setPieceSpotX - fd * standBack;
        double py = setPieceSpotY;
        taker.x = clamp(px, 5.0, PITCH_W - 5.0);
        taker.y = clamp(py, 5.0, PITCH_H - 5.0);
        taker.targetX = setPieceSpotX;
        taker.targetY = setPieceSpotY;
        taker.vx = taker.vy = 0;
        taker.facing = std::atan2(setPieceSpotY - taker.y, setPieceSpotX - taker.x);
    };
    auto enforceRestartDistance = [&]() {
        double minDist = setPieceTypeEnum == SetPiece::ThrowIn ? 42.0 : setPieceTypeEnum == SetPiece::Corner ? 58.0 : setPieceTypeEnum == SetPiece::Penalty ? 96.0 : 78.0;
        Team restartTeam = setPieceTeamEnum;
        for (auto& p : state.players) {
            if (p.team == restartTeam || p.role == Role::GK) continue;
            double dx = p.x - setPieceSpotX;
            double dy = p.y - setPieceSpotY;
            double d = std::hypot(dx, dy);
            if (d >= minDist) continue;
            if (d < 1.0) {
                double fd = p.team == Team::Home ? 1.0 : -1.0;
                dx = -fd; dy = p.homeY < PITCH_H / 2.0 ? -0.35 : 0.35;
                d = std::hypot(dx, dy);
            }
            p.x = clamp(setPieceSpotX + dx / d * minDist, 5.0, PITCH_W - 5.0);
            p.y = clamp(setPieceSpotY + dy / d * minDist, 5.0, PITCH_H - 5.0);
            p.targetX = p.x;
            p.targetY = p.y;
            p.vx = p.vy = 0;
        }
    };

    if (setPieceTakerId >= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPieceTakerId) {
                a->setPieceHold = true;
                break;
            }
        }
    }

    tickAgents(sdt, false);
    moveBallCarrier(sdt);
    separateTeammates(sdt);
    enforceRestartDistance();

    if (setPieceTypeEnum == SetPiece::GoalKick && actionTimer <= 0) {
        setPieceArmed = false;
        setPieceReason.clear();
        releaseSetPiece();
        cacheBallState();
        return;
    }

    if (setPieceTakerId >= 0 && !setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) {
            double dx = state.ball.x - taker->x;
            double dy = state.ball.y - taker->y;
            double d = std::hypot(dx, dy);
            if (d > 1.0) {
                double speed = attrFactor(taker->attrs.speed) * SPEED_SPRINT;
                double step = std::min(speed * (sdt / 1000.0), d);
                taker->x += (dx / d) * step;
                taker->y += (dy / d) * step;
                taker->facing = std::atan2(dy, dx);
            }
            taker->targetX = state.ball.x;
            taker->targetY = state.ball.y;
        }
    }

    if (setPieceTakerId >= 0 && !setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) {
            double d = dist(taker->x, taker->y, state.ball.x, state.ball.y);
            if (d < 15.0) {
                setPieceTakerArrived = true;
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                actionTimer = setPieceTypeEnum == SetPiece::ThrowIn ? 650 : setPieceTypeEnum == SetPiece::Penalty ? 1800 : 1500;
            }
        }
    }

    if (setPieceTakerArrived && actionTimer <= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPieceTakerId) { a->setPieceHold = false; break; }
        }
        Player* taker = playerById(setPieceTakerId);
        if (taker) placeTakerForRestart(*taker, true);
        enforceRestartDistance();
        state.ball.x = setPieceSpotX;
        state.ball.y = setPieceSpotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
        setPieceArmed = false;
        setPieceReason.clear();
        setPieceTakerId = -1;
        setPieceTakerArrived = false;
        releaseSetPiece();
    } else if (!setPieceTakerArrived && actionTimer <= 0) {
        if (setPieceTakerId >= 0) {
            Player* taker = playerById(setPieceTakerId);
            if (taker) {
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                taker->x = state.ball.x;
                taker->y = state.ball.y;
                taker->targetX = state.ball.x;
                taker->targetY = state.ball.y;
                setPieceTakerArrived = true;
                actionTimer = setPieceTypeEnum == SetPiece::ThrowIn ? 650 : setPieceTypeEnum == SetPiece::Penalty ? 1800 : 1500;
            }
        }
    }
    updateControlledBall(sec);
    if (setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) placeTakerForRestart(*taker, false);
        state.ball.x = setPieceSpotX;
        state.ball.y = setPieceSpotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
    }
    cacheBallState();
}

void GameEngine::updateKickoffPhase(double sdt) {
    actionTimer -= sdt;
    if (actionTimer <= 0) { kickoffPhase = false; kickoffTap(); }
    cacheBallState();
}

void GameEngine::updateOpenPlayPhase(double sdt, double sec) {
    auto& b = state.ball;
    if (b.controllerId >= 0) contestBlockedUntil.erase(b.controllerId);
    if (b.controllerId < 0) {
        applyBallPhysics(sec);
        clampBallPosition();
        tryGKSave();
        if (checkGoal()) { cacheBallState(); return; }
        if (checkOutOfPlay()) { cacheBallState(); return; }
        checkBallPlayerCollision(sec);
    }
    for (auto& bb : blackboards) { bb.pressingPlayerId = bb.pressingPlayerId2 = -1; }
    updateTeamAssignments();
    tickAgents(sdt, true);
    if (gkDistributeTimer > 0) {
        gkDistributeTimer -= sdt;
        if (gkDistributeTimer <= 0) releaseSetPiece();
    }
    if (b.intendedReceiverId >= 0 && b.controllerId < 0) {
        Player* receiver = playerById(b.intendedReceiverId);
        if (receiver) {
            receiver->targetX = b.x;
            receiver->targetY = b.y;
        }
    }
    updateControlledBall(sec);
    moveBallCarrier(sdt);
    updateGK(sdt);
    separateTeammates(sdt);
    updateControlledBall(sec);
    updateGoalKickMonitor();
    tryGKSave();
    if(state.ball.controllerId<0){
        double speed=std::hypot(state.ball.vx,state.ball.vy);
        peakBallSpeed=std::max(peakBallSpeed,speed);
        looseBallSpeedTotal+=speed;
        looseBallSpeedSamples++;
        stats.recordBallSpeedSample(speed);
    }
    double jumpDx = state.ball.x - prevBallX;
    double jumpDy = state.ball.y - prevBallY;
    double jumpDist = std::hypot(jumpDx, jumpDy);
    double expectedMax = std::hypot(state.ball.vx, state.ball.vy) * sec + 20.0
        + (activeKnockAhead.active ? DRIBBLE_KNOCK_OFFSET : 0.0);
    if (jumpDist > expectedMax && jumpDist > 50.0 && !setPieceArmed && !kickoffPhase
        && prevControllerId < 0 && state.ball.controllerId < 0) {
        stats.recordBallJump();
    }
    cacheBallState();
}

void GameEngine::tickAgents(double sdt, bool ic) {'''

if old in content:
    content = content.replace(old, new_methods, 1)
    print('Inserted all extracted methods')
else:
    print('WARNING: tickAgents not found')

with open('native/engine.cpp', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done')

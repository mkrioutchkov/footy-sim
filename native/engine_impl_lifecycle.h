#pragma once
// engine_impl_lifecycle.h — kickoff, update, fixedUpdate, tickAgents, auditStuckCarrier

inline void GameEngine::kickoff(Team t){
    nextKickoffTeam=(t==Team::Home)?Team::Away:Team::Home;
    contestBlockedUntil.clear();
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    pendingPass.active=false;
    activeKnockAhead.active=false;
    knockAheadCooldownUntil.clear();
    trackedShot=false;
    trackedShotPreventable=false;
    lastLooseOrigin.clear();
    for(auto&p:state.players){
        double margin=(p.team==t)?30.0:45.0;
        p.x=p.team==Team::Home
            ? clamp(p.homeX,25.0,HALF_X-margin)
            : clamp(p.homeX,HALF_X+margin,PITCH_W-25.0);
        p.y=p.homeY;
        p.targetX=p.x; p.targetY=p.y;
        p.vx=p.vy=0;
    }
    auto&b=state.ball;
    b.x=HALF_X; b.y=PITCH_H/2;
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1; b.intendedReceiverId=-1;
    for(auto&p:state.players){
        if(p.team==t&&p.role==Role::CF){
            p.x=HALF_X; p.y=PITCH_H/2;
            p.targetX=p.x; p.targetY=p.y;
            b.controllerId=p.id;
            b.lastTouchTeam=t; b.lastToucherId=p.id;
            break;
        }
    }
    kickoffPhase=true;
    actionTimer=600;
    lastKickoffMs=state.clockMs;
    setPieceArmed=false;
}
inline void GameEngine::update(double dM) {
    accumulator += dM * state.speed;
    int steps = 0;
    while (accumulator >= FIXED_DT && steps < 3) {
        accumulator -= FIXED_DT;
        fixedUpdate(FIXED_DT);
        steps++;
    }
}
inline void GameEngine::fixedUpdate(double sdt) {
    state.clockMs += sdt;
    if (state.clockMs >= MATCH_DURATION) {
        state.matchState = "finished";
        stats.recordScore(state.homeScore, state.awayScore);
        return;
    }
    if (half == 1 && state.clockMs >= 45 * 60 * 1000) { half = 2; halfTimePause = 2000; }
    if (halfTimePause > 0) {
        halfTimePause -= sdt;
        if (halfTimePause <= 0) kickoff(nextKickoffTeam);
        tickAgents(sdt, false);
        return;
    }
    double sec = sdt / 1000;
    for (auto& p : state.players) {
        if (p.tackleAnim > 0) p.tackleAnim = std::max(0., p.tackleAnim - sdt);
        if (p.headingAnim > 0) p.headingAnim = std::max(0., p.headingAnim - sdt);
        if (p.crossCollected > 0) p.crossCollected = std::max(0., p.crossCollected - sdt);
    }
    auto* c = playerById(state.ball.controllerId);
    if (c) {
        if (c->team == Team::Home) possessionHome += sdt;
        else possessionAway += sdt;
    }
    stats.recordPossession(possessionHome, possessionAway);
    auditStuckCarrier(sdt);
    // freeze detection: ball hasn't moved >5px in 1500ms with same controller (skip set pieces & loose balls)
    if (!setPieceArmed && !kickoffPhase) {
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
                simulationFreezes++;
                stats.recordSimulationFreeze();
                lastFreezeAlertMs = state.clockMs;
                freezeWatchMs = 0;
                freezeBallX = fb.x;
                freezeBallY = fb.y;
            }
        }
    }
    if (setPieceArmed) {
        actionTimer -= sdt;
        updateControlledBall(sec);
        if (actionTimer <= 0) { setPieceArmed = false; releaseSetPiece(); }
        return;
    }
    if (kickoffPhase) {
        actionTimer -= sdt;
        if (actionTimer <= 0) { kickoffPhase = false; kickoffTap(); }
        return;
    }
    auto& b = state.ball;
    if (b.controllerId < 0) {
        applyBallPhysics(sec);
        clampBallPosition();
        if (checkGoal()) return;
        if (checkOutOfPlay()) return;
        checkBallPlayerCollision(sec);
    }
    for (auto& bb : blackboards) { bb.pressingPlayerId = bb.pressingPlayerId2 = -1; }
    updateTeamAssignments();
    tickAgents(sdt, true);
    if (gkDistributeTimer > 0) {
        gkDistributeTimer -= sdt;
        if (gkDistributeTimer <= 0) releaseSetPiece();
    }
    updateControlledBall(sec);
    moveBallCarrier(sdt);
    updateGK(sdt);
    tryGKSave();
    if(state.ball.controllerId<0){
        double speed=std::hypot(state.ball.vx,state.ball.vy);
        peakBallSpeed=std::max(peakBallSpeed,speed);
        looseBallSpeedTotal+=speed;
        looseBallSpeedSamples++;
        stats.recordBallSpeedSample(speed);
    }
    // Ball jump detection: flag if loose ball moved further than velocity could account for
    double jumpDx = state.ball.x - prevBallX;
    double jumpDy = state.ball.y - prevBallY;
    double jumpDist = std::hypot(jumpDx, jumpDy);
    double expectedMax = std::hypot(state.ball.vx, state.ball.vy) * sec + 20.0;
    if (jumpDist > expectedMax && jumpDist > 50.0 && !setPieceArmed && !kickoffPhase
        && prevControllerId < 0 && state.ball.controllerId < 0) {
        stats.recordBallJump();
    }
    prevBallX = state.ball.x;
    prevBallY = state.ball.y;
    prevControllerId = state.ball.controllerId;
}
inline void GameEngine::tickAgents(double sdt, bool ic) {
    for (auto& a : agents) {
        int id = a->player.id;
        if (id == state.ball.controllerId && !ic) continue;
        a->tick(sdt);
        if (a->dizzyRotationAccum > 720.0) {
            dizzySpins++;
            stats.recordDizzySpin();
            a->dizzyRotationAccum = 0;
            a->dizzyWindowStartMs = state.clockMs;
        }
    }
}
inline void GameEngine::auditStuckCarrier(double sdt){
    Player* carrier=playerById(state.ball.controllerId);
    if(!carrier){
        watchedCarrierId=-1;
        watchedCarrierMs=0;
        return;
    }
    if(carrier->id!=watchedCarrierId){
        watchedCarrierId=carrier->id;
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    watchedCarrierMs+=sdt;
    double moved=dist(carrier->x,carrier->y,watchedCarrierX,watchedCarrierY);
    if(moved>STUCK_CARRIER_MOVE_THRESHOLD){
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    double fd=carrier->team==Team::Home?1.0:-1.0;
    double forwardProgress=(carrier->x-watchedCarrierX)*fd;
    if(forwardProgress>30.0){
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    int nearbyOpponents=0;
    for(auto& p:state.players){
        if(p.team!=carrier->team&&p.role!=Role::GK&&dist(p.x,p.y,carrier->x,carrier->y)<PRESSURE_RANGE)nearbyOpponents++;
    }
    bool deep=carrier->team==Team::Home?carrier->x<PITCH_W*0.28:carrier->x>PITCH_W*0.72;
    if(watchedCarrierMs>STUCK_CARRIER_TIMEOUT_MS){
        Player* best=nullptr; double bestD=1e9;
        for(auto&p:state.players){
            if(p.team!=carrier->team||p.id==carrier->id||p.role==Role::GK)continue;
            double d=dist(carrier->x,carrier->y,p.x,p.y);
            if(d<bestD){bestD=d; best=&p;}
        }
        if(best)forcePassTo(*carrier,*best,nullptr);
        else{auto&b=state.ball;b.controllerId=-1;b.vx=carrier->team==Team::Home?300:-300;b.vy=0;b.vz=80;b.z=0;}
        setPieceArmed=false;setPieceType.clear();setPieceTeam.clear();
        watchedCarrierMs=0;watchedCarrierX=carrier->x;watchedCarrierY=carrier->y;
        if(state.clockMs-lastStuckAlertMs>8000){
            stuckCarrierAlerts++;
            stats.recordStuckCarrier();
            lastStuckAlertMs=state.clockMs;
        }
    }
}

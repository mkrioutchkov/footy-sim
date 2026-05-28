#include "engine.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Offside helpers
// ══════════════════════════════════════════════════════════════

double GameEngine::offsideLineFor(Team t) const {
    const double fd = t==Team::Home ? 1.0 : -1.0;
    const Player* d1=nullptr,*d2=nullptr;
    double v1=fd==1?-1e9:1e9, v2=v1;
    for(auto&p:state.players){
        if(p.team==t)continue;
        double v=fd==1?-p.x:p.x;
        if(v<v1){if(v1!=v2)v2=v1;else v2=v;v1=v;d2=d1;d1=&p;}
        else if(v<v2){v2=v;d2=&p;}
    }
    return d2 ? d2->x : (t==Team::Home?0.0:PITCH_W);
}

bool GameEngine::checkOffside(const Player& receiver, const Player& passer) const {
    const double fd = passer.team==Team::Home ? 1.0 : -1.0;
    if(fd==1){if(receiver.x<=HALF_X||receiver.x<=passer.x+OFFSIDE_TOLERANCE)return false;}
    else{if(receiver.x>=HALF_X||receiver.x>=passer.x-OFFSIDE_TOLERANCE)return false;}
    const Player* d1=nullptr,*d2=nullptr;
    double v1=fd==1?-1e9:1e9, v2=v1;
    for(auto&p:state.players){
        if(p.team==passer.team)continue;
        double v=fd==1?-p.x:p.x;
        if(v<v1){if(v1!=v2)v2=v1;else v2=v;v1=v;d2=d1;d1=&p;}
        else if(v<v2){v2=v;d2=&p;}
    }
    if(!d2)return false;
    const double line=d2->x;
    return fd==1 ? receiver.x>line+OFFSIDE_TOLERANCE : receiver.x<line-OFFSIDE_TOLERANCE;
}

void GameEngine::awardOffsideFreeKick(const std::string& defendingTeam, const Player& offsidePlayer) {
    auto& b=state.ball;
    b.x=clamp(offsidePlayer.x,20.0,PITCH_W-20);
    b.y=clamp(offsidePlayer.y,20.0,PITCH_H-20);
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1; b.intendedReceiverId=-1;
    receiverShieldTargetId=-1;
    setPieceType="free_kick"; setPieceTeam=defendingTeam; setPieceArmed=true;
}

bool GameEngine::isOffsideTarget(const Player& passer, const Player& receiver) const {
    return rng.random() < 0.20 && checkOffside(receiver, passer);
}

// ══════════════════════════════════════════════════════════════
// Player lookups
// ══════════════════════════════════════════════════════════════

Player* GameEngine::playerById(int id) {
    if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
    for(auto&p:state.players)if(p.id==id)return &p;
    return nullptr;
}

const Player* GameEngine::playerById(int id) const {
    if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
    for(auto&p:state.players)if(p.id==id)return &p;
    return nullptr;
}

std::vector<Player*> GameEngine::nearPlayers(Player& p, double range) {
    std::vector<Player*> r;
    for(auto& o:state.players) if(&o!=&p && dist(p.x,p.y,o.x,o.y)<range) r.push_back(&o);
    return r;
}

bool GameEngine::canContestBall(Player& player) {
    if(setPieceArmed&&state.ball.controllerId<0)return false;
    auto it=contestBlockedUntil.find(player.id);
    if(it==contestBlockedUntil.end())return true;
    if(it->second>state.clockMs)return false;
    contestBlockedUntil.erase(it);
    return true;
}

// ══════════════════════════════════════════════════════════════
// Actions
// ══════════════════════════════════════════════════════════════

void GameEngine::blockReboundFor(int playerId,double ms) {
    if(playerId<0)return;
    contestBlockedUntil[playerId]=std::max(contestBlockedUntil[playerId],state.clockMs+ms);
}

void GameEngine::recordBallImpulse() {
    double spd=std::hypot(state.ball.vx,state.ball.vy);
    peakBallSpeed=std::max(peakBallSpeed,spd);
    stats.recordBallSpeedSample(spd);
}

void GameEngine::beginTrackedPass(Player& from,Player& to,bool isCross) {
    stats.recordPassAttempt();
    lastLooseOrigin.clear();
    double speed=std::hypot(state.ball.vx,state.ball.vy);
    passLaunchSpeedTotal+=speed; passLaunchCount++;
    stats.recordPassLaunch(speed);
    recordBallImpulse();
    pendingPass={true,from.id,to.id,from.team,isCross};
}

void GameEngine::resolvePendingPass(Player& receiver) {
    if(!pendingPass.active)return;
    if(receiver.team==pendingPass.team){stats.recordPassComplete();}
    else {stats.recordPassIntercepted();}
    pendingPass.active=false;
}

double GameEngine::goalOpeningAngleDeg(double x, double y, double gx) const {
    double dx=gx-x;
    double top=std::atan2(PITCH_H/2.0-GOAL_W/2.0-y,dx);
    double bottom=std::atan2(PITCH_H/2.0+GOAL_W/2.0-y,dx);
    double opening=std::abs(std::atan2(std::sin(bottom-top),std::cos(bottom-top)));
    return opening*180.0/3.141592653589793;
}

void GameEngine::placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset) {
    double d=std::hypot(dx,dy);
    if(d<0.001){
        double fd=kicker.team==Team::Home?1.0:-1.0;
        state.ball.x=clamp(kicker.x+fd*maxOffset,5.0,PITCH_W-5.0);
        state.ball.y=kicker.y;
        return;
    }
    state.ball.x=clamp(kicker.x+dx/d*maxOffset,5.0,PITCH_W-5.0);
    state.ball.y=clamp(kicker.y+dy/d*maxOffset,5.0,PITCH_H-5.0);
}

void GameEngine::passBallTo(Player& f,Player& t) { passBallTo(f,t,false,false,nullptr); }

bool GameEngine::passBallTo(Player& f,Player& t,bool throughBall,bool lob,const PassSelectionAudit* selectionAudit) {
    double rawDx=t.x-f.x,rawDy=t.y-f.y,rawDist=std::hypot(rawDx,rawDy);
    if(rawDist<1)return false;
    double speed=(PASS_SPEED_BASE+rawDist*PASS_SPEED_DIST)*(0.92+rng.random()*0.16);
    double travelTime=rawDist/std::max(speed,1.0);
    double receiverSpeed=std::hypot(t.vx,t.vy);
    double fd=f.team==Team::Home?1.0:-1.0;
    bool movingForward=t.vx*fd>5;
    double leadFactor=movingForward&&receiverSpeed>20?0.80:0.45;
    double throughLead=throughBall?fd*(32+attrFactor(f.attrs.creativity)*62):0;
    double predX=t.x+t.vx*travelTime*leadFactor+throughLead;
    double predY=t.y+t.vy*travelTime*leadFactor;
    double dx=predX-f.x,dy=predY-f.y,adjDist=std::hypot(dx,dy);
    if(adjDist<1)return false;
    double passSkill=attrFactor(f.attrs.passing);
    double inacc=(1-passSkill)*rawDist*0.12;
    double tdx=dx+(rng.random()-0.5)*inacc;
    double tdy=dy+(rng.random()-0.5)*inacc;
    double tDist=std::hypot(tdx,tdy);
    double ownGoalX=ownGoalXFor(f.team);
    bool towardOwnGoal=f.team==Team::Home?tdx<0:tdx>0;
    bool defendingOwnBox=std::abs(f.x-ownGoalX)<PITCH_W/3.0;
    if(towardOwnGoal&&defendingOwnBox){
        double travel=(ownGoalX-f.x)/tdx;
        double crossingY=f.y+tdy*travel;
        if(travel>0&&std::abs(crossingY-PITCH_H/2)<GOAL_W/2+BALL_R+8)return false;
    }
    auto&b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(f,tdx,tdy);
    blockReboundFor(f.id,900);
    b.lastTouchTeam=f.team; b.lastToucherId=f.id;
    b.vx=tdx/tDist*speed; b.vy=tdy/tDist*speed;
    b.intendedReceiverId=t.id;
    receiverShieldTargetId=t.id;
    b.z=0; b.vz=0;
    int blockers=0;
    for(auto&o:state.players){
        if(o.team==f.team||o.role==Role::GK)continue;
        double along=clamp(((o.x-f.x)*dx+(o.y-f.y)*dy)/(adjDist*adjDist),0.0,1.0);
        double perp=std::hypot(o.x-f.x-along*dx,o.y-f.y-along*dy);
        if(perp<35&&along>0.1&&along<0.9)blockers++;
    }
    if(rawDist>240)b.vz=speed*0.55;
    if(blockers>0&&rawDist>120)b.vz=std::max(b.vz,speed*0.70);
    if(rawDist>350)b.vz=std::max(b.vz,speed);
    const auto* audit=selectionAudit;
    double goalX=goalXFor(f.team);
    bool fromWide=std::abs(f.y-PITCH_H/2)>180;
    bool intoBox=std::abs(predX-goalX)<200&&std::abs(predY-PITCH_H/2)<140;
    bool selectedCross=audit&&audit->purpose=="cross"&&fromWide&&(f.role==Role::WM||f.role==Role::FB)&&!throughBall;
    bool whippedCross=fromWide&&intoBox&&(f.role==Role::WM||f.role==Role::FB)&&!throughBall
        &&(!audit||(audit->purpose!="cutback"&&audit->purpose!="through"&&audit->purpose!="cross"));
    if(whippedCross){
        b.vx*=1.30; b.vy*=1.30;
        b.vz=std::max(b.vz,speed*1.30*1.15);
    }
    if(audit){
        bool riskyFlag=audit->blockers>0||audit->receiverPressure>0||audit->expectedCompletion<0.58;
        stats.recordPassSelection(audit->distance,audit->expectedCompletion,audit->blockers,audit->receiverPressure,riskyFlag,audit->saferOptionTargetId);
    }
    beginTrackedPass(f,t,selectedCross||whippedCross);
    if(checkOffside(t,f)){
        stats.recordOffside();
        awardOffsideFreeKick(std::string(to_string(f.team==Team::Home?Team::Away:Team::Home)),t);
        return true;
    }
    return true;
}

void GameEngine::forcePassTo(Player&f,Player&t,const PassSelectionAudit*) {
    double dx=t.x-f.x,dy=t.y-f.y,rawDist=std::hypot(dx,dy);
    if(rawDist<1)return;
    double tdx=dx+(rng.random()-0.5)*rawDist*0.2;
    double tdy=dy+(rng.random()-0.5)*rawDist*0.2;
    double tDist=std::hypot(tdx,tdy);
    double speed=PASS_SPEED_BASE+35+rawDist*(PASS_SPEED_DIST+0.05);
    auto&b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(f,tdx,tdy);
    blockReboundFor(f.id,900);
    b.lastTouchTeam=f.team; b.lastToucherId=f.id;
    b.vx=tdx/tDist*speed; b.vy=tdy/tDist*speed;
    b.intendedReceiverId=t.id;
    receiverShieldTargetId=t.id;
    b.z=0; b.vz=speed*0.40;
    beginTrackedPass(f,t);
    if(checkOffside(t,f)){
        stats.recordOffside();
        awardOffsideFreeKick(std::string(to_string(f.team==Team::Home?Team::Away:Team::Home)),t);
    }
}

bool GameEngine::attemptTackle(Player& tackler,Player& carrier){
    double contactDist=dist(tackler.x,tackler.y,carrier.x,carrier.y);
    auto& b=state.ball;
    if(b.controllerId!=carrier.id||tackler.team==carrier.team||contactDist>TACKLE_RANGE)return false;
    if(!canContestBall(tackler))return false;
    stats.recordTackleAttempt();
    double tackleSkill=attrFactor(tackler.attrs.tackling);
    double carrierControl=attrFactor(carrier.attrs.positioning)*0.35+attrFactor(carrier.attrs.speed)*0.15;
    double facingBonus=(tackler.team==Team::Home?tackler.vx>0:tackler.vx<0)?0.08:-0.05;
    double carrierSpeed=std::hypot(carrier.vx,carrier.vy);
    double forwardX=carrierSpeed>8?carrier.vx/carrierSpeed:(carrier.team==Team::Home?1.0:-1.0);
    double forwardY=carrierSpeed>8?carrier.vy/carrierSpeed:0;
    double approachDot=contactDist>0
        ? ((tackler.x-carrier.x)*forwardX+(tackler.y-carrier.y)*forwardY)/contactDist
        : 0;
    bool fromBehind=approachDot<-0.30;
    bool carrierShielded=isCarrierShielded(carrier.id);
    double dribbleBonus=carrier.dribbleType==3?0.10:carrier.dribbleType==1?-0.10:0;

    // Carrier facing vs tackler position: shielding detection
    double carrierFacingX=std::cos(carrier.facing);
    double carrierFacingY=std::sin(carrier.facing);
    double toTacklerX=contactDist>0?(tackler.x-carrier.x)/contactDist:0;
    double toTacklerY=contactDist>0?(tackler.y-carrier.y)/contactDist:0;
    double facingDot=carrierFacingX*toTacklerX+carrierFacingY*toTacklerY;

    // Shielding: carrier has back turned to tackler → harder to tackle
    // Front exposed: carrier facing tackler → easier to tackle
    double shieldingBonus=0.0;
    if(facingDot<-0.5) shieldingBonus=-0.10;       // back turned: shield (reduced from -0.15)
    else if(facingDot>0.5) shieldingBonus=0.08;     // front exposed: vulnerable (reduced from 0.10)

    double chance=clamp(0.18+tackleSkill*0.35-carrierControl*0.15+facingBonus
        -(carrierShielded?0.20:0)-(fromBehind?0.14:0)
        +(approachDot>0.3&&approachDot<0.85?0.06:0)+dribbleBonus+shieldingBonus,0.06,0.72);
    if(rng.random()>=chance){
        double foulChance=fromBehind?0.34:0.10;
        if(rng.random()<foulChance){
            stats.recordTackleFoul();
            b.vx=b.vy=b.z=b.vz=0;
            b.controllerId=carrier.id;
            b.intendedReceiverId=-1;
            b.lastTouchTeam=carrier.team; b.lastToucherId=carrier.id;
            lastLooseOrigin.clear();
            blockReboundFor(tackler.id,650);
            receiverShieldUntil=state.clockMs+300;
            receiverShieldedPlayerId=carrier.id;
        }else{
            blockReboundFor(tackler.id,650);
        }
        return false;
    }
    pendingPass.active=false;
    trackedShot=false;
    trackedShotPreventable=false;
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    double angle=std::atan2(b.y-tackler.y,b.x-tackler.x)+(rng.random()-0.5)*0.9;
    double outcomeRoll=rng.random();
    double controlChance=clamp(0.28+tackleSkill*0.35-carrierControl*0.18
        -(fromBehind?0.20:0)+(approachDot>0.15?0.12:0)
        -(carrier.dribbleType==3?0.08:0),0.12,0.72);
    if(outcomeRoll<controlChance){
        stats.recordTackleWin(true);
        b.controllerId=tackler.id;
        b.vx=b.vy=b.z=b.vz=0;
        b.lastTouchTeam=tackler.team; b.lastToucherId=tackler.id;
        b.intendedReceiverId=-1;
        receiverShieldUntil=state.clockMs+260;
        receiverShieldedPlayerId=tackler.id;
        lastLooseOrigin.clear();
        blockReboundFor(carrier.id,450);
        carrier.vx=carrier.vy=0;
        return true;
    }
    stats.recordTackleWin(false);
    b.controllerId=-1;
    double kickSpeed=38+outcomeRoll*72+(carrier.dribbleType==3?30:0)+(carrierSpeed>DRIBBLE_MEDIUM_SPEED?16:0);
    b.vx=std::cos(angle)*kickSpeed; b.vy=std::sin(angle)*kickSpeed;
    b.x=clamp(b.x,5.0,PITCH_W-5.0); b.y=clamp(b.y,5.0,PITCH_H-5.0);
    if(kickSpeed>180){stats.recordSlideTackleDistance();}
    if(b.x<10||b.x>PITCH_W-10||b.y<10||b.y>PITCH_H-10){stats.recordSlideTackleOob();}
    b.lastTouchTeam=tackler.team; b.lastToucherId=tackler.id;
    b.intendedReceiverId=-1; b.z=b.vz=0;
    lastLooseOrigin="tackle_deflection";
    recordBallImpulse();
    blockReboundFor(tackler.id,250);
    blockReboundFor(carrier.id,450);
    carrier.vx=carrier.vy=0;
    return true;
}

void GameEngine::shootBall(Player&s,const ShotSelectionAudit* selectionAudit){
    stats.recordShot(std::string(to_string(s.team)),false);
    double gx=goalXFor(s.team);
    double accuracy=attrFactor(s.attrs.shooting);
    double goalCenterY=PITCH_H/2.0;
    double shotDistance=std::hypot(gx-s.x,goalCenterY-s.y);
    stats.recordShotDistance(shotDistance);
    int pressureCount=0;
    for(auto&o:state.players)if(o.team!=s.team&&o.role!=Role::GK&&dist(o.x,o.y,s.x,s.y)<PRESSURE_RANGE)pressureCount++;
    double angleDeg=goalOpeningAngleDeg(s.x,s.y,gx);
    bool outsideGoalLane=std::abs(s.y-goalCenterY)>GOAL_W/2+20;
    bool acuteGeometry=outsideGoalLane&&angleDeg<7.5&&shotDistance>150;
    const auto* audit=selectionAudit;
    if(audit){
        bool betterPassFlag=audit->bestPassTargetId>=0&&audit->bestPassScore>audit->score+0.12;
        bool tightAngleFlag=audit->angleDeg<8.0&&audit->distance>120.0;
        stats.recordShotSelection(audit->angleDeg,audit->pressureCount,0,0,0,0,0,0,betterPassFlag,tightAngleFlag);
    }
    if(shotDistance>210||acuteGeometry||(audit&&audit->bestPassScore>audit->score+0.12)){stats.recordQuestionableShot();}
    double anglePenalty=clamp(std::abs(s.y-goalCenterY)/230,0.0,1.0);
    double distancePenalty=clamp((shotDistance-70)/270,0.0,1.0);
    double longRangePenalty=clamp((shotDistance-120)/130,0.0,1.0);
    double executionError=16+(1-accuracy)*75+pressureCount*18+anglePenalty*32+distancePenalty*30+longRangePenalty*65;
    double aimedPost=(rng.random()<0.5?-1.0:1.0)*GOAL_W*(0.18+accuracy*0.13);
    double goalY=goalCenterY+aimedPost+(rng.random()+rng.random()-1.0)*executionError;
    if(acuteGeometry){
        double nearPostSide=s.y<goalCenterY?-1.0:1.0;
        double nearPostY=goalCenterY+nearPostSide*GOAL_W/2;
        goalY=s.y+(nearPostY-s.y)*(0.30+rng.random()*0.10);
    }
    double dx=gx-s.x, dy=goalY-s.y;
    double d=std::hypot(dx,dy);
    double speed=SHOT_SPEED_BASE+accuracy*180.0-pressureCount*10;
    auto& b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(s,dx,dy);
    blockReboundFor(s.id,850);
    b.vx=dx/d*speed; b.vy=dy/d*speed;
    b.intendedReceiverId=-1; b.z=b.vz=0;
    b.lastTouchTeam=s.team; b.lastToucherId=s.id;
    shotLaunchSpeedTotal+=speed; shotLaunchCount++;
    stats.recordShotLaunch(speed);
    recordBallImpulse();
    pendingPass.active=false;
    lastLooseOrigin="shot";
    receiverShieldTargetId=-1;
    shotActive=true; trackedShot=true; trackedShotPreventable=false; trackedShotTeam=s.team; trackedShooterId=s.id; shotOriginX=s.x; shotOriginY=s.y;
}

// ══════════════════════════════════════════════════════════════
// Dribble — knock-ahead logic
// ══════════════════════════════════════════════════════════════

bool GameEngine::knockBallAhead(Player& carrier, double targetX, double targetY) {
    auto& b = state.ball;
    if (b.controllerId != carrier.id || !canKnockBallAhead(carrier.id)) return false;
    double dx = targetX - carrier.x, dy = targetY - carrier.y, directionDist = std::hypot(dx, dy);
    if (directionDist < 1) return false;
    int nearestId = -1;
    double nearestDist = 1e9;
    for (auto& opponent : state.players) {
        if (opponent.team == carrier.team || opponent.role == Role::GK) continue;
        double d = dist(opponent.x, opponent.y, carrier.x, carrier.y);
        if (d < nearestDist) { nearestDist = d; nearestId = opponent.id; }
    }
    bool risky = nearestId >= 0 && nearestDist < 125;
    double nx = dx / directionDist, ny = dy / directionDist;
    double launchSpeed = attrFactor(carrier.attrs.speed) * DRIBBLE_FAST_SPEED + DRIBBLE_KNOCK_SPEED_ADVANTAGE;
    b.controllerId = -1;
    b.intendedReceiverId = -1;
    receiverShieldUntil = 0;
    receiverShieldedPlayerId = -1;
    receiverShieldTargetId = -1;
    placeBallForRelease(carrier, dx, dy, DRIBBLE_KNOCK_OFFSET);
    b.vx = nx * launchSpeed;
    b.vy = ny * launchSpeed;
    b.z = b.vz = 0;
    b.lastTouchTeam = carrier.team;
    b.lastToucherId = carrier.id;
    lastLooseOrigin = "knock_ahead";
    recordBallImpulse();
    stats.recordKnockAhead(launchSpeed);
    if (risky) { stats.recordRiskyKnockAhead(); }
    activeKnockAhead = {true, carrier.id, carrier.team, state.clockMs, nearestId, nearestDist, risky};
    return true;
}

void GameEngine::resolveKnockAhead(Player* collector, const std::string& stopped) {
    if (!activeKnockAhead.active) return;
    if (stopped == "out_of_play") {
        stats.recordKnockAheadOutOfPlay();
    } else if (stopped == "goal") {
    } else if (collector && collector->id == activeKnockAhead.playerId) {
        stats.recordKnockAheadRecovered();
        knockAheadCooldownUntil[collector->id] = state.clockMs + 2600;
    } else if (collector && collector->team == activeKnockAhead.team) {
        stats.recordKnockAheadRetained();
    } else {
        stats.recordKnockAheadTurnover(activeKnockAhead.risky);
    }
    activeKnockAhead.active = false;
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — kickoff, update, fixedUpdate, tickAgents, auditStuckCarrier
// ══════════════════════════════════════════════════════════════

void GameEngine::kickoff(Team t){
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

void GameEngine::update(double dM) {
    accumulator += dM * state.speed;
    int steps = 0;
    while (accumulator >= FIXED_DT && steps < 3) {
        accumulator -= FIXED_DT;
        fixedUpdate(FIXED_DT);
        steps++;
    }
}

void GameEngine::fixedUpdate(double sdt) {
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

void GameEngine::tickAgents(double sdt, bool ic) {
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

void GameEngine::auditStuckCarrier(double sdt){
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

// ══════════════════════════════════════════════════════════════
// Tactical — assignments, defensive roles, tactical audit
// ══════════════════════════════════════════════════════════════

void GameEngine::setAssignment(Player& player, const std::string& role, double x, double y, int opponentId) {
    assignmentByPlayer[player.id] = {role, opponentId, clamp(x, 35.0, PITCH_W - 35.0), clamp(y, 35.0, PITCH_H - 35.0)};
}

void GameEngine::updateTeamAssignments() {
    assignmentByPlayer.clear();
    Player* carrier = playerById(state.ball.controllerId);
    if (!carrier || carrier->role == Role::GK) return;
    Team defending = carrier->team == Team::Home ? Team::Away : Team::Home;
    assignDefensiveRoles(defending, *carrier);
    auditTacticalCoverage(*carrier);
}

void GameEngine::auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                                int pressureCount, const std::string& choiceType) {
    if (player.role != Role::CF || distance >= 190.0 || angleDeg <= 9.0 || pressureCount > 1) return;
    bool closeChance = distance < 120.0;
    stats.recordShotSelection(0, 0, 1, choiceType == "shoot" ? 0 : 1, choiceType == "pass" ? 1 : 0, choiceType == "dribble" ? 1 : 0, closeChance ? 1 : 0, closeChance && choiceType != "shoot" ? 1 : 0, false, false);
    if (choiceType == "shoot") return;
}

void GameEngine::assignDefensiveRoles(Team team, Player& carrier) {
    double fd = team == Team::Home ? 1.0 : -1.0;
    double ownGoalX = ownGoalXFor(team);
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Config tactics = configFor(team);
    struct Rated { Player* player; double distance; double eta; double score; };
    std::vector<Rated> ranked;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK) continue;
        double distance = dist(p.x, p.y, carrier.x, carrier.y);
        double speed = std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
        double roleCost = p.role == Role::CB ? (danger ? 8.0 : 70.0) : p.role == Role::CF ? 28.0 : p.role == Role::CM ? 0.0 : p.role == Role::WM ? 6.0 : 14.0;
        ranked.push_back({&p, distance, distance / speed, distance - attrFactor(p.attrs.speed) * 45.0 - attrFactor(p.attrs.tackling) * 35.0 + roleCost});
    }
    if (ranked.empty()) return;
    std::sort(ranked.begin(), ranked.end(), [](const Rated& a, const Rated& b) { return a.score < b.score; });
    auto quickest = std::min_element(ranked.begin(), ranked.end(), [](const Rated& a, const Rated& b) { return a.eta < b.eta; });
    if (quickest != ranked.end() && ranked.front().eta > quickest->eta + (danger ? 0.40 : 0.52)) {
        Rated urgent = *quickest;
        ranked.erase(quickest);
        ranked.insert(ranked.begin(), urgent);
    }
    std::unordered_set<int> assigned;
    auto used = [&](const Player* p) { return assigned.contains(p->id); };
    Player* primary = ranked.front().player;
    setAssignment(*primary, "primary_press", carrier.x - fd * 16.0, carrier.y, carrier.id);
    assigned.insert(primary->id);
    if (tactics.aggression >= 62.0) {
        for (const auto& option : ranked) {
            Player* p = option.player;
            if (used(p) || p->role == Role::CB || option.distance >= 260.0) continue;
            setAssignment(*p, "secondary_press", carrier.x - fd * 42.0,
                carrier.y + (p->homeY < carrier.y ? -38.0 : 38.0), carrier.id);
            assigned.insert(p->id);
            break;
        }
    }
    for (const auto& option : ranked) {
        Player* p = option.player;
        if (used(p) || (p->role != Role::CB && p->role != Role::CM)) continue;
        setAssignment(*p, "cover", lerp(carrier.x, ownGoalX + fd * 115.0, 0.58),
            lerp(carrier.y, PITCH_H / 2.0, 0.4), carrier.id);
        assigned.insert(p->id);
        break;
    }
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::CM && !used(&p)) {
            setAssignment(p, "midfield_screen", lerp(carrier.x, ownGoalX + fd * 175.0, 0.4),
                lerp(carrier.y, PITCH_H / 2.0, 0.65));
            assigned.insert(p.id);
            break;
        }
    }
    struct Threat { Player* player; double depth; };
    std::vector<Threat> threats;
    for (auto& attacker : state.players) {
        if (attacker.team == team || attacker.role == Role::GK || attacker.id == carrier.id) continue;
        double depth = std::abs(attacker.x - ownGoalX);
        bool threatens = (attacker.role == Role::CF && depth < (danger ? 300.0 : 245.0))
            || (attacker.role == Role::WM && depth < (danger ? 250.0 : 205.0) && std::abs(attacker.y - PITCH_H / 2.0) < 200.0)
            || (attacker.role == Role::CM && depth < 180.0);
        if (threatens) threats.push_back({&attacker, depth});
    }
    std::sort(threats.begin(), threats.end(), [](const Threat& a, const Threat& b) { return a.depth < b.depth; });
    if (threats.size() > (danger ? 2u : 1u)) threats.resize(danger ? 2u : 1u);
    for (const auto& threat : threats) {
        Player* marker = nullptr;
        double best = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender) || (defender.role != Role::CB && defender.role != Role::FB)) continue;
            if (threat.player->role == Role::WM && defender.role != Role::CB
                && std::abs(defender.homeY - threat.player->y) >= PITCH_H * 0.42) continue;
            double roleBonus = (threat.player->role == Role::CF && defender.role == Role::CB)
                || (threat.player->role == Role::WM && defender.role == Role::FB) ? -35.0 : 0.0;
            double score = dist(defender.x, defender.y, threat.player->x, threat.player->y) + roleBonus;
            if (score < best) { best = score; marker = &defender; }
        }
        if (marker) {
            setAssignment(*marker, "lane_block", lerp(threat.player->x, ownGoalX + fd * 36.0, 0.20),
                lerp(threat.player->y, PITCH_H / 2.0, 0.08), threat.player->id);
            assigned.insert(marker->id);
        }
    }
    for (auto& defender : state.players) {
        if (defender.team != team || used(&defender) || (defender.role != Role::CB && defender.role != Role::FB)) continue;
        double linePush = (tactics.defensiveLineHeight - 50.0) * 0.9;
        double targetX = danger
            ? ownGoalX + fd * (defender.role == Role::CB ? 92.0 : 118.0)
            : lerp(defender.homeX, carrier.x - fd * 120.0, 0.32) + fd * linePush;
        double targetY = defender.role == Role::FB
            ? lerp(defender.homeY, carrier.y, 0.20)
            : lerp(defender.homeY, PITCH_H / 2.0, 0.08);
        setAssignment(defender, defender.role == Role::FB ? "wide_cover" : "defensive_line", targetX, targetY);
    }
}

void GameEngine::auditTacticalCoverage(Player& carrier) {
    if (state.clockMs < nextTacticalAuditMs) return;
    nextTacticalAuditMs = state.clockMs + 500.0;
    Team defending = carrier.team == Team::Home ? Team::Away : Team::Home;
    double ownGoalX = ownGoalXFor(defending);
    double fd = defending == Team::Home ? 1.0 : -1.0;
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Player* primary = nullptr;
    for (const auto& [id, task] : assignmentByPlayer) {
        if (task.role == "primary_press") { primary = playerById(id); break; }
    }
    if (primary) {
        stats.recordPressSample();
        double selectedDistance = dist(primary->x, primary->y, carrier.x, carrier.y);
        double selectedEta = selectedDistance / std::max(18.0, attrFactor(primary->attrs.speed) * SPEED_SPRINT);
        double fastestEta = 1e9;
        for (auto& p : state.players) {
            if (p.team != defending || p.role == Role::GK) continue;
            double eta = dist(p.x, p.y, carrier.x, carrier.y) / std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
            fastestEta = std::min(fastestEta, eta);
        }
        if (selectedEta > fastestEta + 0.45) { stats.recordQuestionablePress(selectedDistance); }
    }
    struct LineMember { const Player* player; double progress; };
    std::vector<LineMember> line;
    for (const auto& defender : state.players) {
        if (defender.team != defending) continue;
        if (defender.role != Role::CB && defender.role != Role::FB) continue;
        line.push_back({&defender, (defender.x - ownGoalX) * fd});
    }
    if (line.size() >= 3) {
        std::sort(line.begin(), line.end(), [](const LineMember& a, const LineMember& b) { return a.progress < b.progress; });
        double gap = line[1].progress - line[0].progress;
        bool singleDrop = false, laneBlock = false;
        if (!danger && gap > 85.0) {
            singleDrop = true;
            const auto* task = assignmentFor(line[0].player->id);
            if (task && task->role == "lane_block") { laneBlock = true; }
        }
        stats.recordBackLineSample(gap, singleDrop, laneBlock);
    }
    bool finalThird = carrier.team == Team::Home ? carrier.x > PITCH_W * 2.0 / 3.0 : carrier.x < PITCH_W / 3.0;
    if (!finalThird) return;
    double nearestCb = 1e9, nearestDefender = 1e9;
    for (auto& defender : state.players) {
        if (defender.team != defending || defender.role == Role::GK) continue;
        double distance = dist(defender.x, defender.y, carrier.x, carrier.y);
        nearestDefender = std::min(nearestDefender, distance);
        if (defender.role == Role::CB) nearestCb = std::min(nearestCb, distance);
    }
    bool unmarked = nearestCb > 100.0;
    stats.recordFinalThirdMarking(nearestCb, nearestDefender, unmarked);
}

// ══════════════════════════════════════════════════════════════
// Set pieces — kickoff tap, release, throw-in, goal kick
// ══════════════════════════════════════════════════════════════

void GameEngine::kickoffTap(){
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    std::vector<Player*> mids;
    for(auto&p:state.players)if(p.team==holder->team&&p.id!=holder->id&&p.role==Role::CM)mids.push_back(&p);
    if(mids.empty())return;
    size_t pick=static_cast<size_t>(rng.random()*mids.size());
    if(pick>=mids.size())pick=mids.size()-1;
    Player& target=*mids[pick];
    double dx=target.x-holder->x,dy=target.y-holder->y,rawDist=std::hypot(dx,dy);
    if(rawDist<1)return;
    double speed=180+rawDist*0.2;
    auto&b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(*holder,dx,dy);
    b.lastTouchTeam=holder->team; b.lastToucherId=holder->id;
    b.vx=dx/rawDist*speed; b.vy=dy/rawDist*speed;
    b.intendedReceiverId=target.id;
    receiverShieldTargetId=target.id;
    blockReboundFor(holder->id,650);
    b.z=0; b.vz=0;
    beginTrackedPass(*holder,target);
}

void GameEngine::releaseSetPiece(){
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    std::vector<Player*> targets;
    for(auto&p:state.players){
        if(p.team!=holder->team||p.id==holder->id||p.role==Role::GK)continue;
        targets.push_back(&p);
    }
    std::sort(targets.begin(),targets.end(),[&](const Player* a,const Player* b){
        return dist(holder->x,holder->y,a->x,a->y)<dist(holder->x,holder->y,b->x,b->y);
    });
    for(Player* target:targets){
        if(passBallTo(*holder,*target,false,false,nullptr))return;
    }
    setPieceArmed=true;
    actionTimer=250;
}

void GameEngine::awardThrowIn(std::string lt, double y) {
    auto& b = state.ball;
    Team atTeam;
    if (lt == "home") atTeam = Team::Away;
    else if (lt == "away") atTeam = Team::Home;
    else atTeam = (b.x < PITCH_W / 2) ? Team::Away : Team::Home;
    std::string at = std::string(to_string(atTeam));
    b.x = clamp(b.x, 10., PITCH_W - 10);
    b.y = clamp(y, 10., PITCH_H - 10);
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPieceType = "throw_in";
    setPieceTeam = at;
    setPieceArmed = true;
    actionTimer = 900;
    Player* best = nullptr;
    double bd = 1e9;
    for (auto& p : state.players) {
        if (p.team != atTeam || p.role == Role::GK) continue;
        double d = dist(p.x, p.y, b.x, b.y);
        if (d < bd) { bd = d; best = &p; }
    }
    if (best) {
        b.controllerId = best->id;
        b.lastTouchTeam = best->team;
        b.lastToucherId = best->id;
        best->x = b.x;
        best->y = b.y;
        best->targetX = b.x;
        best->targetY = b.y;
        best->vx = 0;
        best->vy = 0;
    }
}

void GameEngine::awardSetPiece(std::string t, std::string tm) {
    auto& b = state.ball;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPieceType = t;
    setPieceTeam = tm;
    setPieceArmed = true;
    actionTimer = 900;
    Team tmTeam = teamFromStr(tm);
    for (auto& p : state.players) {
        if (p.team == tmTeam && p.role == Role::GK) {
            b.controllerId = p.id;
            b.lastTouchTeam = tmTeam;
            b.lastToucherId = p.id;
            b.x = p.x + ((tmTeam == Team::Home) ? CONTROL_DIST : -CONTROL_DIST);
            b.y = p.y;
            break;
        }
    }
}

// ══════════════════════════════════════════════════════════════
// Physics — ball physics, collision, collection, movement
// ══════════════════════════════════════════════════════════════

void GameEngine::applyBallPhysics(double s) {
    auto& b = state.ball;
    double friction = std::pow(BALL_FRICTION, s);
    b.vx *= friction;
    b.vy *= friction;
    if (std::hypot(b.vx, b.vy) < 3) { b.vx = b.vy = 0; }
    b.x += b.vx * s;
    b.y += b.vy * s;
    if (b.vz || b.z > 0) {
        b.vz -= 500 * s;
        b.z += b.vz * s;
        if (b.z < 0) { b.z = 0; b.vz *= -0.2; }
    }
}

void GameEngine::clampBallPosition() {
    state.ball.x = clamp(state.ball.x, -40., PITCH_W + 40);
    state.ball.y = clamp(state.ball.y, -40., PITCH_H + 40);
}

bool GameEngine::checkGoal(){
    auto&b=state.ball;
    bool inOpening=std::abs(b.y-PITCH_H/2)<=GOAL_W/2&&b.z+BALL_R<=GOAL_H;
    if(!inOpening)return false;
    auto recordGoalSource=[&](Team scoringTeam){
        lastGoalScoringTeam=scoringTeam;
        lastGoalTouchTeam=b.lastTouchTeam;
        lastGoalToucherId=b.lastToucherId;
        lastGoalBallSpeed=std::hypot(b.vx,b.vy);
        if(!trackedShot){
            if(pendingPass.active&&pendingPass.team==scoringTeam){
                if(pendingPass.isCross){lastGoalSource="direct_cross";}
                else lastGoalSource="direct_delivery";
            }else if(pendingPass.active){
                lastGoalSource="own_pass";
            }else if(lastLooseOrigin=="tackle_deflection"){
                lastGoalSource="tackle_deflection";
            }else if(lastLooseOrigin=="goalkeeper_parry"){
                lastGoalSource="goalkeeper_parry";
            }else if(lastLooseOrigin=="shot"){
                lastGoalSource="shot_state_lost";
            }else if(lastLooseOrigin=="knock_ahead"){
                resolveKnockAhead(nullptr,"goal");
                lastGoalSource="knock_ahead";
            }else{
                lastGoalSource="loose_unclassified";
            }
            return;
        }
        if(b.lastTouchTeam!=trackedShotTeam){
            lastGoalSource="shot_deflection";
        }else{
            lastGoalSource="shot";
        }
    };
    if(b.x+BALL_R<HOME_GOAL_X){
        recordGoalSource(Team::Away);
        double goalDist=0;
        if(trackedShot)goalDist=dist(shotOriginX,shotOriginY,HOME_GOAL_X,PITCH_H/2);
        stats.recordGoal("away",lastGoalSource,goalDist,lastGoalBallSpeed);
        state.awayScore++; shotActive=false; trackedShot=false; kickoff(Team::Home); return true;
    }
    if(b.x-BALL_R>AWAY_GOAL_X){
        recordGoalSource(Team::Home);
        double goalDist=0;
        if(trackedShot)goalDist=dist(shotOriginX,shotOriginY,AWAY_GOAL_X,PITCH_H/2);
        stats.recordGoal("home",lastGoalSource,goalDist,lastGoalBallSpeed);
        state.homeScore++; shotActive=false; trackedShot=false; kickoff(Team::Away); return true;
    }
    return false;
}

bool GameEngine::checkOutOfPlay() {
    auto& b = state.ball;
    Team lt = b.lastTouchTeam;
    auto clearState = [&]() {
        resolveKnockAhead(nullptr, "out_of_play");
        pendingPass.active = false;
        trackedShot = false;
        trackedShotPreventable = false;
        lastLooseOrigin.clear();
    };
    if (b.y + BALL_R < 0 || b.y - BALL_R > PITCH_H) {
        clearState();
        awardThrowIn(std::string(to_string(lt)), b.y < 0 ? 0 : PITCH_H);
        return true;
    }
    if (b.x + BALL_R < HOME_GOAL_X) {
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2;
        if (!inGoal) {
            clearState();
            awardSetPiece("goal_kick", std::string(to_string(lt == Team::Away ? Team::Home : Team::Away)));
            return true;
        }
    }
    if (b.x - BALL_R > AWAY_GOAL_X) {
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2;
        if (!inGoal) {
            clearState();
            awardSetPiece("goal_kick", std::string(to_string(lt == Team::Home ? Team::Away : Team::Home)));
            return true;
        }
    }
    return false;
}

void GameEngine::checkBallPlayerCollision(double){
    auto&b=state.ball;
    double bs=std::hypot(b.vx,b.vy);
    const double r=COLLECT_DIST;
    for(auto&p:state.players){
        if(!canContestBall(p))continue;
        double d=dist(p.x,p.y,b.x,b.y);
        if(d>r)continue;
        if(b.z>20&&p.id!=b.intendedReceiverId)continue;
        if(p.role==Role::GK){
            double ownGoalX=ownGoalXFor(p.team);
            bool inArea=std::abs(b.x-ownGoalX)<PENALTY_AREA_W&&std::abs(b.y-PITCH_H/2)<PENALTY_AREA_H/2;
            if(bs<220&&inArea){collectBall(p);gkDistributeTimer=400;return;}
            continue;
        }
        bool failedPressuredReception=false;
        if(p.id==b.intendedReceiverId&&bs<220){
            bool underPressure=false;
            for(auto& opponent:state.players){
                if(opponent.team!=p.team&&opponent.role!=Role::GK
                    &&dist(opponent.x,opponent.y,p.x,p.y)<38.0){underPressure=true;break;}
            }
            if(!underPressure){collectBall(p);return;}
            double trapChance=clamp(0.34+attrFactor(p.attrs.positioning)*0.30
                +attrFactor(p.attrs.passing)*0.14-clamp((bs-80.0)/300.0,0.0,0.25),0.18,0.82);
            if(rng.random()<trapChance){stats.recordPressuredReception(false);collectBall(p);return;}
            stats.recordPressuredReception(true);
            b.intendedReceiverId=-1;
            receiverShieldTargetId=-1;
            blockReboundFor(p.id,150);
            failedPressuredReception=true;
        }
        if(bs<130){
            if(failedPressuredReception){b.vx*=0.72;b.vy*=0.72;continue;}
            collectBall(p);
            return;
        }
        if(bs>130){
            if(b.z>20)continue;
            double dx=b.x-p.x,dy=b.y-p.y,d2=std::hypot(dx,dy);
            if(d2<1)continue;
            double nx=dx/d2,ny=dy/d2;
            b.x=p.x+nx*r;b.y=p.y+ny*r;
            double dot=b.vx*nx+b.vy*ny;
            if(dot<0){b.vx-=1.3*dot*nx;b.vy-=1.3*dot*ny;}
            double damp=(b.lastTouchTeam==p.team)?0.18:0.25;
            b.vx*=damp;b.vy*=damp;
            b.vx+=ny*bs*.02;b.vy+=-nx*bs*.02;
            b.lastTouchTeam=p.team;b.lastToucherId=p.id;
            if(p.team==lastCollectionTeam)lastSameTeamCollectionMs=state.clockMs-500;
            blockReboundFor(p.id,600);
        }
    }
}

void GameEngine::collectBall(Player& c) {
    auto& b = state.ball;
    if (!canContestBall(c)) return;
    bool intended = receiverShieldTargetId == c.id;
    bool teammateTarget = receiverShieldTargetId >= 0 && b.lastTouchTeam == c.team;
    resolveKnockAhead(&c);
    resolvePendingPass(c);
    if (c.role != Role::GK) {
        double fdx = b.x - c.x, fdy = b.y - c.y;
        double fd = std::hypot(fdx, fdy);
        if (fd > 0.1) c.facing = std::atan2(fdy, fdx);
    }
    if (lastCollectionTeam.has_value() && c.team == *lastCollectionTeam && state.clockMs - lastSameTeamCollectionMs < 300) {
        teammatePingPongs++;
        stats.recordCollection(true);
    }
    lastCollectionTeam = c.team;
    lastSameTeamCollectionMs = state.clockMs;
    trackedShot = false;
    trackedShotPreventable = false;
    lastLooseOrigin.clear();
    b.controllerId = c.id;
    b.intendedReceiverId = -1;
    b.vx *= .3;
    b.vy *= .3;
    b.z = b.vz = 0;
    b.lastTouchTeam = c.team;
    b.lastToucherId = c.id;
    c.dribbleType = 0;
    if (intended) {
        receiverShieldUntil = state.clockMs + 300;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    } else if (teammateTarget) {
        receiverShieldUntil = state.clockMs + 150;
        receiverShieldedPlayerId = c.id;
    } else {
        receiverShieldUntil = 0;
        receiverShieldedPlayerId = -1;
        receiverShieldTargetId = -1;
    }
}

bool GameEngine::collectBall(Player& c, const std::string&, double allowedDist) {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    if (!canContestBall(c)) return false;
    if (dist(c.x, c.y, b.x, b.y) > allowedDist + 0.001) return false;
    collectBall(c);
    return true;
}

void GameEngine::updateControlledBall(double) {
    Player* c = playerById(state.ball.controllerId);
    if (!c || kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    state.ball.x = clamp(c->x + dx * CONTROL_DIST, 5.0, PITCH_W - 5.0);
    state.ball.y = clamp(c->y + dy * CONTROL_DIST, 5.0, PITCH_H - 5.0);
    state.ball.lastTouchTeam = c->team;
    state.ball.lastToucherId = c->id;
}

void GameEngine::moveBallCarrier(double sdt){
    Player*c=playerById(state.ball.controllerId);
    if(!c)return;
    double limit=c->dribbleType==1?DRIBBLE_CLOSE_SPEED:c->dribbleType==3?DRIBBLE_FAST_SPEED:DRIBBLE_MEDIUM_SPEED;
    double speed=attrFactor(c->attrs.speed)*limit;
    double dx=c->targetX-c->x,dy=c->targetY-c->y,d=std::hypot(dx,dy);
    double secs=sdt/1000.0,px=c->x,py=c->y;
    double previousSpeed=std::hypot(c->vx,c->vy);
    double previousAngle=previousSpeed>5?std::atan2(c->vy,c->vx):0;
    double moveAngle=d>1?std::atan2(dy,dx):previousAngle;
    bool turnWasLimited=false;
    if(d>1&&previousSpeed>5){
        double requestedTurn=std::atan2(std::sin(moveAngle-previousAngle),std::cos(moveAngle-previousAngle));
        double turnRate=c->dribbleType==1?17.0:c->dribbleType==3?10.0:14.0;
        double maxTurn=turnRate*secs;
        if(std::abs(requestedTurn)>maxTurn){
            moveAngle=previousAngle+clamp(requestedTurn,-maxTurn,maxTurn);
            turnWasLimited=true;
        }
    }
    if(d>1){
        double step=std::min(speed*secs,d);
        if(step>=d){c->x=c->targetX;c->y=c->targetY;}
        else{c->x+=std::cos(moveAngle)*step;c->y+=std::sin(moveAngle)*step;}
    }
    c->x=clamp(c->x,5.0,PITCH_W-5.0);c->y=clamp(c->y,5.0,PITCH_H-5.0);
    c->vx=(c->x-px)/secs;c->vy=(c->y-py)/secs;
    double actualSpeed=std::hypot(c->vx,c->vy);
    if(previousSpeed>5&&actualSpeed>5){
        double actualTurn=std::abs(std::atan2(
            std::sin(std::atan2(c->vy,c->vx)-previousAngle),
            std::cos(std::atan2(c->vy,c->vx)-previousAngle)));
        double actualTurnDeg=actualTurn*180.0/3.141592653589793;
        stats.recordCarrierTurn(actualTurn>3.141592653589793/2,actualTurnDeg,turnWasLimited);
    }
    if(actualSpeed>5){
        double desiredFacing=std::atan2(c->vy,c->vx);
        c->facing+=std::atan2(std::sin(desiredFacing-c->facing),std::cos(desiredFacing-c->facing))*0.28;
    }
    updateControlledBall(0);
}

// ══════════════════════════════════════════════════════════════
// Goalkeeper — positioning and save logic
// ══════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════
// JSON serialization
// ══════════════════════════════════════════════════════════════

std::string GameEngine::getJSON() const {
    auto& b = state.ball;
    nlohmann::json j;
    j["clockMs"] = std::round(state.clockMs);
    j["matchState"] = state.matchState;
    j["half"] = half;
    j["version"] = std::format("{} {}", "cpp", __TIME__);
    j["speed"] = state.speed;
    j["homeScore"] = state.homeScore;
    j["awayScore"] = state.awayScore;

    j["ball"] = {
        {"x", std::round(b.x * 10) / 10}, {"y", std::round(b.y * 10) / 10},
        {"vx", std::round(b.vx * 10) / 10}, {"vy", std::round(b.vy * 10) / 10},
        {"z", std::round(b.z * 10) / 10},
        {"controllerId", b.controllerId >= 0 ? nlohmann::json(b.controllerId) : nlohmann::json(nullptr)},
        {"intendedReceiverId", b.intendedReceiverId >= 0 ? nlohmann::json(b.intendedReceiverId) : nlohmann::json(nullptr)},
        {"lastTouchTeam", std::string(to_string(b.lastTouchTeam))},
        {"lastToucherId", b.lastToucherId >= 0 ? nlohmann::json(b.lastToucherId) : nlohmann::json(nullptr)}
    };

    j["players"] = nlohmann::json::array();
    for (auto& p : state.players) {
        j["players"].push_back({
            {"id", p.id}, {"name", p.name}, {"team", std::string(to_string(p.team))}, {"role", std::string(to_string(p.role))},
            {"x", std::round(p.x * 10) / 10}, {"y", std::round(p.y * 10) / 10},
            {"vx", std::round(p.vx * 10) / 10}, {"vy", std::round(p.vy * 10) / 10},
            {"targetX", std::round(p.targetX * 10) / 10}, {"targetY", std::round(p.targetY * 10) / 10},
            {"stamina", std::round(p.stamina)}, {"facing", std::round(p.facing * 1000) / 1000},
            {"dribbleType", p.dribbleType},
            {"tackleAnim", std::round(p.tackleAnim)}, {"headingAnim", std::round(p.headingAnim)}
        });
    }

    nlohmann::json summary = nlohmann::json::parse(stats.summaryJSON());
    j["passes"] = summary["passes"];
    j["passesCompleted"] = summary["passesCompleted"];
    j["passesIntercepted"] = summary["passesIntercepted"];
    j["passCompletionPct"] = summary["passCompletionPct"];
    j["offsides"] = summary["offsides"];
    j["homeShots"] = summary["homeShots"];
    j["awayShots"] = summary["awayShots"];
    j["shots"] = summary["shots"];
    j["shotsOnTarget"] = summary["shotsOnTarget"];
    j["saves"] = summary["saves"];
    j["stuckCarrierAlerts"] = summary["stuckCarrierAlerts"];
    j["simulationFreezes"] = summary["simulationFreezes"];
    j["dizzySpins"] = summary["dizzySpins"];
    j["ballJumps"] = summary["ballJumps"];
    j["teammatePingPongs"] = summary["teammatePingPongs"];
    j["slideTackleDistanceAlerts"] = summary["slideTackleDistanceAlerts"];
    j["slideTackleOobAlerts"] = summary["slideTackleOobAlerts"];
    j["ownPassGoals"] = summary["ownPassGoals"];
    j["unknownLooseGoals"] = summary["unknownLooseGoals"];
    j["shotsByDistance"] = summary["shotsByDistance"];
    j["goalsByDistance"] = summary["goalsByDistance"];
    j["untrackedGoals"] = summary["untrackedGoals"];
    j["directDeliveryGoals"] = summary["directDeliveryGoals"];
    j["directCrossGoals"] = summary["directCrossGoals"];
    j["tackleDeflectionGoals"] = summary["tackleDeflectionGoals"];
    j["goalkeeperParryGoals"] = summary["goalkeeperParryGoals"];
    j["shotDeflectionGoals"] = summary["shotDeflectionGoals"];
    j["lostShotGoals"] = summary["lostShotGoals"];
    j["knockAheadGoals"] = summary["knockAheadGoals"];
    j["goalkeeping"] = summary["goalkeeping"];
    j["tackles"] = summary["tackles"];
    j["dribbleTypes"] = summary["dribbleTypes"];
    j["carrierTurns"] = summary["carrierTurns"];
    j["passSelection"] = summary["passSelection"];
    j["shotSelection"] = summary["shotSelection"];
    j["marking"] = summary["marking"];
    j["qualityFlags"] = summary["qualityFlags"];
    j["ballSpeed"] = summary["ballSpeed"];
    j["events"] = summary["events"];
    j["possessionPct"] = summary["possessionPct"];

    return j.dump();
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — constructor, initWithSeed, createHomeTeam, createAwayTeam
// ══════════════════════════════════════════════════════════════

GameEngine::GameEngine() {
    blackboards[0]={}; blackboards[1]={};
}

void GameEngine::initWithSeed(int seed) {
    rng.setSeed(seed);
    auto manager=[&](){
        return Config{40+rng.random()*40,30+rng.random()*40,25+rng.random()*60,
                      30+rng.random()*55,25+rng.random()*55};
    };
    homeConfig=manager();
    awayConfig=manager();
    for(int i=0;i<23;i++) rng.random();
    createHomeTeam();
    for(int i=0;i<23;i++) rng.random();
    createAwayTeam();
    for(auto&p:state.players){
        if(p.id>=0&&p.id<22)playerLookup[p.id]=&p;
    }
    for(auto&p:state.players) {
        if (p.role == Role::GK)
            agents.push_back(std::make_unique<GKPlayerAI>(p, *this));
        else if (p.role == Role::CF)
            agents.push_back(std::make_unique<CFPlayerAI>(p, *this));
        else if (p.role == Role::WM)
            agents.push_back(std::make_unique<WMPlayerAI>(p, *this));
        else if (p.role == Role::CM)
            agents.push_back(std::make_unique<CMPlayerAI>(p, *this));
        else if (p.role == Role::CB)
            agents.push_back(std::make_unique<CBPlayerAI>(p, *this));
        else if (p.role == Role::FB)
            agents.push_back(std::make_unique<FBPlayerAI>(p, *this));
        else
            agents.push_back(std::make_unique<PlayerAI>(p, *this));
    }
}

void GameEngine::createHomeTeam() {
    auto mk=[&](int id,Team t,Role r,double hx,double hy){return Player{id,std::format("{}{}",to_string(t),id),t,r,hx,hy,0,0,hx,hy,hx,hy,100.0,{static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(60,95))},t==Team::Home?0.0:3.141592653589793};};
    std::vector<Player> home = {
        mk(0,Team::Home,Role::GK,31.5,340),mk(1,Team::Home,Role::FB,157.5,81.6),
        mk(2,Team::Home,Role::CB,189,226.6667),mk(3,Team::Home,Role::CB,189,453.3333),
        mk(4,Team::Home,Role::FB,157.5,598.4),mk(5,Team::Home,Role::CM,420,170),
        mk(6,Team::Home,Role::CM,420,340),mk(7,Team::Home,Role::CM,420,510),
        mk(8,Team::Home,Role::WM,441,81.6),mk(9,Team::Home,Role::CF,756,340),
        mk(10,Team::Home,Role::WM,441,598.4)
    };
    state.players.insert(state.players.end(), home.begin(), home.end());
}

void GameEngine::createAwayTeam() {
    auto mk=[&](int id,Team t,Role r,double hx,double hy){return Player{id,std::format("{}{}",to_string(t),id),t,r,hx,hy,0,0,hx,hy,hx,hy,100.0,{static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(60,95))},t==Team::Home?0.0:3.141592653589793};};
    std::vector<Player> away = {
        mk(11,Team::Away,Role::GK,1018.5,340),mk(12,Team::Away,Role::FB,892.5,81.6),
        mk(13,Team::Away,Role::CB,861,226.6667),mk(14,Team::Away,Role::CB,861,453.3333),
        mk(15,Team::Away,Role::FB,892.5,598.4),mk(16,Team::Away,Role::CM,630,170),
        mk(17,Team::Away,Role::CM,630,340),mk(18,Team::Away,Role::CM,630,510),
        mk(19,Team::Away,Role::WM,609,81.6),mk(20,Team::Away,Role::CF,294,340),
        mk(21,Team::Away,Role::WM,609,598.4)
    };
    state.players.insert(state.players.end(), away.begin(), away.end());
}

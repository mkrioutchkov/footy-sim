#pragma once
// engine_impl_physics.h — ball physics, collision, collection, movement

inline void GameEngine::applyBallPhysics(double s) {
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
inline void GameEngine::clampBallPosition() {
    state.ball.x = clamp(state.ball.x, -40., PITCH_W + 40);
    state.ball.y = clamp(state.ball.y, -40., PITCH_H + 40);
}
inline bool GameEngine::checkGoal(){
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
inline bool GameEngine::checkOutOfPlay() {
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
inline void GameEngine::checkBallPlayerCollision(double){
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
inline void GameEngine::collectBall(Player& c) {
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
inline bool GameEngine::collectBall(Player& c, const std::string&, double allowedDist) {
    auto& b = state.ball;
    if (b.controllerId >= 0) return false;
    if (!canContestBall(c)) return false;
    if (dist(c.x, c.y, b.x, b.y) > allowedDist + 0.001) return false;
    collectBall(c);
    return true;
}
inline void GameEngine::updateControlledBall(double) {
    Player* c = playerById(state.ball.controllerId);
    if (!c || kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    state.ball.x = clamp(c->x + dx * CONTROL_DIST, 5.0, PITCH_W - 5.0);
    state.ball.y = clamp(c->y + dy * CONTROL_DIST, 5.0, PITCH_H - 5.0);
    state.ball.lastTouchTeam = c->team;
    state.ball.lastToucherId = c->id;
}
inline void GameEngine::moveBallCarrier(double sdt){
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

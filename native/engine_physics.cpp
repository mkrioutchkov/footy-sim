#include "engine.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Physics — ball physics, collision, collection, movement
// ══════════════════════════════════════════════════════════════

void GameEngine::separateTeammates(double sdt) {
    double secs = sdt / 1000.0;
    double maxPush = 32.0 * secs;
    for (size_t i = 0; i < state.players.size(); ++i) {
        for (size_t j = i + 1; j < state.players.size(); ++j) {
            Player& a = state.players[i];
            Player& b = state.players[j];
            if (a.role == Role::GK || b.role == Role::GK) continue;
            double dx = b.x - a.x, dy = b.y - a.y;
            double d = std::hypot(dx, dy);
            double minDist = a.team == b.team ? SEPARATION_DIST : 24.0;
            if (d < 0.1 || d >= minDist) continue;
            double nx = dx / d, ny = dy / d;
            double pushScale = a.team == b.team ? 0.24 : 0.10;
            double push = std::min(maxPush, (minDist - d) * pushScale);
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
                lastGoalSource="tackle_deflection";
            }else if(lastLooseOrigin=="tackle_deflection"){
                lastGoalSource="tackle_deflection";
            }else if(lastLooseOrigin=="goalkeeper_parry"){
                lastGoalSource="goalkeeper_parry";
            }else if(lastLooseOrigin=="shot"){
                lastGoalSource="shot_state_lost";
            }else if(lastLooseOrigin=="knock_ahead"){
                resolveKnockAhead(nullptr,"goal");
                lastGoalSource="knock_ahead";
            }else if(b.lastTouchTeam==scoringTeam&&b.lastToucherId>=0){
                lastGoalSource="shot_state_lost";
            }else{
                lastGoalSource="loose_unclassified";
            }
            return;
        }
        if(b.lastTouchTeam!=trackedShotTeam){
            lastGoalSource="shot_deflection";
        }else{
            lastGoalSource=trackedPenaltyShot ? "penalty" : "shot";
        }
    };
    if(b.x+BALL_R<HOME_GOAL_X){
        recordGoalSource(Team::Away);
        double goalDist=0;
        if(trackedShot)goalDist=dist(shotOriginX,shotOriginY,HOME_GOAL_X,PITCH_H/2);
        Player* scorer=playerById(lastGoalToucherId);
        std::optional<Role> scorerRole=scorer?std::optional<Role>(scorer->role):std::nullopt;
        if(lastGoalSource=="penalty")stats.recordPenaltyGoal();
        if(trackedShotDribble20m&&lastGoalSource=="shot")stats.recordDribble20mGoal();
        stats.recordGoal(Team::Away,lastGoalSource,goalDist,lastGoalBallSpeed,scorerRole,trackedShotHeader);
        state.awayScore++; shotActive=false; trackedShot=false; trackedShotHeader=false; trackedPenaltyShot=false; trackedShotDribble20m=false; kickoff(Team::Home); return true;
    }
    if(b.x-BALL_R>AWAY_GOAL_X){
        recordGoalSource(Team::Home);
        double goalDist=0;
        if(trackedShot)goalDist=dist(shotOriginX,shotOriginY,AWAY_GOAL_X,PITCH_H/2);
        Player* scorer=playerById(lastGoalToucherId);
        std::optional<Role> scorerRole=scorer?std::optional<Role>(scorer->role):std::nullopt;
        if(lastGoalSource=="penalty")stats.recordPenaltyGoal();
        if(trackedShotDribble20m&&lastGoalSource=="shot")stats.recordDribble20mGoal();
        stats.recordGoal(Team::Home,lastGoalSource,goalDist,lastGoalBallSpeed,scorerRole,trackedShotHeader);
        state.homeScore++; shotActive=false; trackedShot=false; trackedShotHeader=false; trackedPenaltyShot=false; trackedShotDribble20m=false; kickoff(Team::Away); return true;
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
        trackedShotHeader = false;
        trackedPenaltyShot = false;
        trackedShotDribble20m = false;
        lastLooseOrigin.clear();
    };
    if (b.y < 0 || b.y > PITCH_H || b.y + BALL_R < 0 || b.y - BALL_R > PITCH_H) {
        clearState();
        awardThrowIn(lt, b.y < 0 ? 0 : PITCH_H);
        return true;
    }
    if (b.x + BALL_R < HOME_GOAL_X) {
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2;
        if (!inGoal) {
            clearState();
            if(lt==Team::Home) awardCorner(Team::Away,true,b.y);
            else awardSetPiece(SetPiece::GoalKick, Team::Home);
            return true;
        }
    }
    if (b.x - BALL_R > AWAY_GOAL_X) {
        bool inGoal = std::abs(b.y - PITCH_H / 2) <= GOAL_W / 2;
        if (!inGoal) {
            clearState();
            if(lt==Team::Away) awardCorner(Team::Home,false,b.y);
            else awardSetPiece(SetPiece::GoalKick, Team::Away);
            return true;
        }
    }
    return false;
}

void GameEngine::checkBallPlayerCollision(double){
    auto&b=state.ball;
    double bs=std::hypot(b.vx,b.vy);
    const double collectRadius=COLLECT_DIST;
    const double fastContactRadius=PLAYER_R+BALL_R-3.0;

    if (b.controllerId < 0 && b.z <= AERIAL_HEIGHT) {
        Player* keeperContact = nullptr;
        double bestKeeperScore = 1e9;
        for (auto& p : state.players) {
            if (p.role != Role::GK || !canContestBall(p)) continue;
            double goalX = ownGoalXFor(p.team);
            bool ballInOwnArea = std::abs(b.x - goalX) < PENALTY_AREA_W
                && std::abs(b.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (!ballInOwnArea) continue;
            double d = dist(p.x, p.y, b.x, b.y);
            double reach = bs > 120.0 ? GK_LOOSE_COLLECT_FAST_DIST : GK_LOOSE_COLLECT_DIST;
            if (d > reach) continue;
            double score = d / reach;
            if (b.lastTouchTeam != p.team) score -= 0.18;
            if (score < bestKeeperScore) {
                bestKeeperScore = score;
                keeperContact = &p;
            }
        }
        if (keeperContact) {
            collectBall(*keeperContact);
            return;
        }
    }

    // Intended receiver gets priority with larger collection radius
    if(b.intendedReceiverId>=0&&bs<250){
        Player* intended=playerById(b.intendedReceiverId);
        if(intended){
            double d=dist(intended->x,intended->y,b.x,b.y);
            double zLimit = pendingPass.active && pendingPass.isCross ? HEADER_MAX_HEIGHT : AERIAL_HEIGHT;
            if(d<=INTENDED_COLLECT_DIST&&b.z<=zLimit){
                if(canContestBall(*intended)){
                    bool underPressure=false;
                    for(auto& opponent:state.players){
                        if(opponent.team!=intended->team&&opponent.role!=Role::GK
                            &&dist(opponent.x,opponent.y,intended->x,intended->y)<38.0){underPressure=true;break;}
                    }
                    if(!underPressure){collectBall(*intended);return;}
                    double trapChance=clamp(0.56+attrFactor(intended->attrs.positioning)*0.30
                        +attrFactor(intended->attrs.passing)*0.16-clamp((bs-95.0)/360.0,0.0,0.20),0.28,0.90);
                    if(rng.random()<trapChance){stats.recordPressuredReception(false);collectBall(*intended);return;}
                    stats.recordPressuredReception(true);
                    b.intendedReceiverId=-1;
                    receiverShieldTargetId=-1;
                    blockReboundFor(intended->id,150);
                }
            }
        }
    }

    Player* contact = nullptr;
    double contactRadius = collectRadius;
    double bestContactScore = 1e9;
    bool intendedNearby = false;
    if (pendingPass.active && b.intendedReceiverId >= 0) {
        if (Player* intended = playerById(b.intendedReceiverId)) {
            intendedNearby = dist(intended->x, intended->y, b.x, b.y) < INTENDED_NEARBY_DIST;
        }
    }

    for(auto&p:state.players){
        if(!canContestBall(p))continue;
        double d=dist(p.x,p.y,b.x,b.y);
        double r=(bs>COLLISION_FAST_CONTACT&&p.team!=b.lastTouchTeam)?fastContactRadius:collectRadius;
        if(d>r)continue;
        double zLimit = pendingPass.active && pendingPass.isCross ? HEADER_MAX_HEIGHT : AERIAL_HEIGHT;
        if(b.z>zLimit)continue;
        if(p.role==Role::GK){
            continue;
        }
        // Intended receiver already handled above — skip them here
        if(p.id==b.intendedReceiverId)continue;
        if(pendingPass.active && intendedNearby && p.team==pendingPass.team && bs<INTENDED_PASS_SPEED_LIMIT)continue;
        double score=d/std::max(1.0,r);
        if(p.team!=b.lastTouchTeam)score-=0.10;
        if(score<bestContactScore){
            bestContactScore=score;
            contact=&p;
            contactRadius=r;
        }
    }

    if(!contact)return;
    if(pendingPass.active && pendingPass.isCross && b.z >= HEADER_MIN_HEIGHT && b.z <= HEADER_MAX_HEIGHT){
        collectBall(*contact);
        return;
    }
    if(bs<COLLISION_SPEED_THRESH){
        collectBall(*contact);
        return;
    }
    if(bs>COLLISION_SPEED_THRESH){
        double dx=b.x-contact->x,dy=b.y-contact->y,d2=std::hypot(dx,dy);
        if(d2<1)return;
        double nx=dx/d2,ny=dy/d2;
        b.x=contact->x+nx*contactRadius;b.y=contact->y+ny*contactRadius;
        double dot=b.vx*nx+b.vy*ny;
        if(dot<0){b.vx-=COLLISION_REFLECT_FACTOR*dot*nx;b.vy-=COLLISION_REFLECT_FACTOR*dot*ny;}
        double damp=(b.lastTouchTeam==contact->team)?COLLISION_DAMP_SAME_TEAM:COLLISION_DAMP_OPPONENT;
        b.vx*=damp;b.vy*=damp;
        double glance=(b.lastTouchTeam==contact->team)?COLLISION_GLANCE_SAME:COLLISION_GLANCE_OPPONENT;
        b.vx+=ny*bs*glance;b.vy+=-nx*bs*glance;
        b.lastTouchTeam=contact->team;b.lastToucherId=contact->id;
        if(contact->team==lastCollectionTeam)lastSameTeamCollectionMs=state.clockMs-500;
        blockReboundFor(contact->id,600);
    }
}

void GameEngine::collectBall(Player& c) {
    auto& b = state.ball;
    if (!canContestBall(c)) return;
    contestBlockedUntil.erase(c.id);
    bool intended = receiverShieldTargetId == c.id;
    bool teammateTarget = receiverShieldTargetId >= 0 && b.lastTouchTeam == c.team;
    resolveKnockAhead(&c);
    if (resolvePendingPass(c)) return;
    if (c.role != Role::GK) {
        double fdx = b.x - c.x, fdy = b.y - c.y;
        double fd = std::hypot(fdx, fdy);
        if (fd > 0.1) c.facing = std::atan2(fdy, fdx);
    }
    if (lastCollectionTeam.has_value() && c.team == *lastCollectionTeam && state.clockMs - lastSameTeamCollectionMs < PING_PONG_WINDOW_MS) {
        teammatePingPongs++;
        stats.recordCollection(true);
    }
    stats.recordControlledTouch(c.role);
    lastCollectionTeam = c.team;
    lastSameTeamCollectionMs = state.clockMs;
    trackedShot = false;
    trackedShotPreventable = false;
    trackedShotHeader = false;
    trackedPenaltyShot = false;
    trackedShotDribble20m = false;
    lastLooseOrigin.clear();
    b.controllerId = c.id;
    b.intendedReceiverId = -1;
    b.vx *= .3;
    b.vy *= .3;
    b.z = b.vz = 0;
    b.lastTouchTeam = c.team;
    b.lastToucherId = c.id;
    c.dribbleType = 0;
    double fd = fdFor(c.team);
    c.targetX = clamp(c.x + fd * 28.0, 35.0, PITCH_W - 35.0);
    c.targetY = clamp(c.y, 35.0, PITCH_H - 35.0);
    if (intended) {
        receiverShieldUntil = state.clockMs + 300;
        receiverShieldedPlayerId = c.id;
        receiverShieldTargetId = -1;
    } else if (teammateTarget) {
        receiverShieldUntil = state.clockMs + 150;
        receiverShieldedPlayerId = c.id;
    } else {
        receiverShieldUntil = state.clockMs + 220;
        receiverShieldedPlayerId = c.id;
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
    double speed = std::hypot(c->vx, c->vy);
    if (c->role != Role::GK && speed > 18.0) {
        double mx = c->vx / speed, my = c->vy / speed;
        double facingMoveDot = dx * mx + dy * my;
        double moveBlend = facingMoveDot < 0.15 ? 0.75 : 0.35;
        dx = dx * (1.0 - moveBlend) + mx * moveBlend;
        dy = dy * (1.0 - moveBlend) + my * moveBlend;
        double len = std::hypot(dx, dy);
        if (len > 0.001) { dx /= len; dy /= len; }
    }
    state.ball.x = clamp(c->x + dx * CONTROL_DIST, 5.0, PITCH_W - 5.0);
    state.ball.y = clamp(c->y + dy * CONTROL_DIST, 5.0, PITCH_H - 5.0);
    state.ball.lastTouchTeam = c->team;
    state.ball.lastToucherId = c->id;
}

void GameEngine::moveBallCarrier(double sdt){
    Player*c=playerById(state.ball.controllerId);
    if(!c)return;
    if(c->dribbleType==0){
        c->targetX=c->x;
        c->targetY=c->y;
        c->vx=0;
        c->vy=0;
        updateControlledBall(0);
        return;
    }
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


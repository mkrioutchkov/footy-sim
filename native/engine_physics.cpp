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
                b.x = clampToPitchX(b.x + nx * push * 2.0);
                b.y = clampToPitchY(b.y + ny * push * 2.0);
            } else if (bFixed) {
                a.x = clampToPitchX(a.x - nx * push * 2.0);
                a.y = clampToPitchY(a.y - ny * push * 2.0);
            } else {
                a.x = clampToPitchX(a.x - nx * push);
                a.y = clampToPitchY(a.y - ny * push);
                b.x = clampToPitchX(b.x + nx * push);
                b.y = clampToPitchY(b.y + ny * push);
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
        lastGoal.scoringTeam=scoringTeam;
        lastGoal.touchTeam=b.lastTouchTeam;
        lastGoal.toucherId=b.lastToucherId;
        lastGoal.ballSpeed=std::hypot(b.vx,b.vy);
        if(!shot.tracked){
            if(pendingPass.active&&pendingPass.team==scoringTeam){
                if(pendingPass.isCross){lastGoal.source="direct_cross";}
                else lastGoal.source="direct_delivery";
            }else if(pendingPass.active){
                lastGoal.source="tackle_deflection";
            }else if(lastLooseOrigin=="tackle_deflection"){
                lastGoal.source="tackle_deflection";
            }else if(lastLooseOrigin=="goalkeeper_parry"){
                lastGoal.source="goalkeeper_parry";
            }else if(lastLooseOrigin=="shot"){
                lastGoal.source="shot_state_lost";
            }else if(lastLooseOrigin=="knock_ahead"){
                resolveKnockAhead(nullptr,"goal");
                lastGoal.source="knock_ahead";
            }else if(b.lastTouchTeam==scoringTeam&&b.lastToucherId>=0){
                lastGoal.source="shot_state_lost";
            }else{
                lastGoal.source="loose_unclassified";
            }
            return;
        }
        if(b.lastTouchTeam!=shot.team){
            lastGoal.source="shot_deflection";
        }else{
            lastGoal.source=shot.penalty ? "penalty" : "shot";
        }
    };
    if(b.x+BALL_R<HOME_GOAL_X){
        recordGoalSource(Team::Away);
        double goalDist=0;
        if(shot.tracked)goalDist=dist(shot.originX,shot.originY,HOME_GOAL_X,PITCH_H/2);
        Player* scorer=playerById(lastGoal.toucherId);
        std::optional<Role> scorerRole=scorer?std::optional<Role>(scorer->role):std::nullopt;
        if(lastGoal.source=="penalty")stats.recordPenaltyGoal();
        if(shot.dribble20m&&lastGoal.source=="shot")stats.recordDribble20mGoal();
        stats.recordGoal(Team::Away,lastGoal.source,goalDist,lastGoal.ballSpeed,scorerRole,shot.header);
        emitEvent("goal", HOME_GOAL_X, b.y, lastGoal.toucherId);
        state.awayScore++; shot.active=false; shot.tracked=false; shot.header=false; shot.penalty=false; shot.dribble20m=false; kickoff(Team::Home); return true;
    }
    if(b.x-BALL_R>AWAY_GOAL_X){
        recordGoalSource(Team::Home);
        double goalDist=0;
        if(shot.tracked)goalDist=dist(shot.originX,shot.originY,AWAY_GOAL_X,PITCH_H/2);
        Player* scorer=playerById(lastGoal.toucherId);
        std::optional<Role> scorerRole=scorer?std::optional<Role>(scorer->role):std::nullopt;
        if(lastGoal.source=="penalty")stats.recordPenaltyGoal();
        if(shot.dribble20m&&lastGoal.source=="shot")stats.recordDribble20mGoal();
        stats.recordGoal(Team::Home,lastGoal.source,goalDist,lastGoal.ballSpeed,scorerRole,shot.header);
        emitEvent("goal", AWAY_GOAL_X, b.y, lastGoal.toucherId);
        state.homeScore++; shot.active=false; shot.tracked=false; shot.header=false; shot.penalty=false; shot.dribble20m=false; kickoff(Team::Away); return true;
    }
    return false;
}

bool GameEngine::checkOutOfPlay() {
    auto& b = state.ball;
    Team lt = b.lastTouchTeam;
    auto clearState = [&]() {
        resolveKnockAhead(nullptr, "out_of_play");
        pendingPass.active = false;
        shot.tracked = false;
        shot.preventable = false;
        shot.header = false;
        shot.penalty = false;
        shot.dribble20m = false;
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
        // Medium-pace balls are blockable with a stretched leg (bigger radius);
        // a full-blooded strike (>300) zips past unless the body is dead in
        // line — beaten-keeper shots were being eaten by incidental bodies.
        double r=(bs>COLLISION_FAST_CONTACT&&bs<210.0&&p.team!=b.lastTouchTeam)?fastContactRadius:collectRadius;
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
        double dot=b.vx*nx+b.vy*ny;
        // A ball moving AWAY from the player isn't a touch: phantom grazes
        // applied damp, flipped last-touch, and rebound-blocked bystanders
        // (600ms, re-applied per tick) just for standing near a pass lane.
        if(dot>=0)return;
        b.x=contact->x+nx*contactRadius;b.y=contact->y+ny*contactRadius;
        b.vx-=COLLISION_REFLECT_FACTOR*dot*nx;b.vy-=COLLISION_REFLECT_FACTOR*dot*ny;
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
    contestBlockedUntil[c.id] = 0;
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
    shot.tracked = false;
    shot.preventable = false;
    shot.header = false;
    shot.penalty = false;
    shot.dribble20m = false;
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
    c.targetX = clampToPitchX(c.x + fd * 28.0, 35.0);
    c.targetY = clampToPitchY(c.y, 35.0);
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
    if (!c || phase.kickoffPhase) return;
    double dx = std::cos(c->facing), dy = std::sin(c->facing);
    double speed = std::hypot(c->vx, c->vy);
    double nearestOppDist = 1e9;
    double nearestOppX = 0.0, nearestOppY = 0.0;
    if (c->role != Role::GK) {
        for (const auto& o : state.players) {
            if (o.team == c->team || o.role == Role::GK) continue;
            double od = dist(c->x, c->y, o.x, o.y);
            if (od < nearestOppDist) {
                nearestOppDist = od;
                nearestOppX = o.x;
                nearestOppY = o.y;
            }
        }
    }
    if (c->role != Role::GK && speed > 18.0) {
        double mx = c->vx / speed, my = c->vy / speed;
        double facingMoveDot = dx * mx + dy * my;
        double moveBlend = facingMoveDot < 0.15 ? 0.75 : 0.35;
        if (nearestOppDist < 68.0) {
            double pressure = clamp((68.0 - nearestOppDist) / 68.0, 0.0, 1.0);
            double toOppX = (nearestOppX - c->x) / std::max(1.0, nearestOppDist);
            double toOppY = (nearestOppY - c->y) / std::max(1.0, nearestOppDist);
            double exposure = dx * toOppX + dy * toOppY;
            double shielded = exposure < -0.25 ? 1.0 : 0.0;
            moveBlend *= lerp(0.65, 0.86, shielded) - pressure * 0.08;
            moveBlend = clamp(moveBlend, 0.12, 0.75);
        }
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
        // Path turn caps: a carrier carving 17 rad/s zigzagged on every target
        // jitter and read as spinning. Smooth arcs instead.
        double turnRate=c->dribbleType==1?9.0:c->dribbleType==3?5.5:7.5;
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
        double nearestOppDist=1e9;
        double nearestOppX=0.0,nearestOppY=0.0;
        if(c->role!=Role::GK){
            for(const auto& o:state.players){
                if(o.team==c->team||o.role==Role::GK)continue;
                double od=dist(c->x,c->y,o.x,o.y);
                if(od<nearestOppDist){nearestOppDist=od;nearestOppX=o.x;nearestOppY=o.y;}
            }
        }
        if(nearestOppDist<68.0){
            double awayAngle=std::atan2(c->y-nearestOppY,c->x-nearestOppX);
            double pressure=clamp((68.0-nearestOppDist)/68.0,0.0,1.0);
            double shieldBlend=lerp(0.14,0.38,pressure);
            desiredFacing+=std::atan2(std::sin(awayAngle-desiredFacing),std::cos(awayAngle-desiredFacing))*shieldBlend;
        }
        double desiredStep=std::atan2(std::sin(desiredFacing-c->facing),std::cos(desiredFacing-c->facing))*0.28;
        double speedBlend=clamp((actualSpeed-12.0)/58.0,0.0,1.0);
        // Carrier-only cap: 0.24 rad/tick let body facing whirl after every
        // velocity jitter (the chaser-perception deadlock doesn't apply here).
        double maxFacingTurn=lerp(0.11,0.055,speedBlend);
        c->facing+=clamp(desiredStep,-maxFacingTurn,maxFacingTurn);
    }
    updateControlledBall(0);
}


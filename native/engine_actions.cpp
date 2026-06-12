#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Actions
// ══════════════════════════════════════════════════════════════

void GameEngine::blockReboundFor(int playerId,double ms) {
    if(playerId<0)return;
    contestBlockedUntil[playerId]=std::max(contestBlockedUntil[playerId],state.clockMs+ms);
}

void GameEngine::recordBallImpulse() {
    double spd=std::hypot(state.ball.vx,state.ball.vy);
    metrics.peakBallSpeed=std::max(metrics.peakBallSpeed,spd);
    stats.recordBallSpeedSample(spd);
    prevBallX=state.ball.x;
    prevBallY=state.ball.y;
    prevBallVx=state.ball.vx;
    prevBallVy=state.ball.vy;
    prevControllerId=state.ball.controllerId;
    ballImpulseGraceTicks=2;
}

void GameEngine::emitEvent(const std::string& type,double x,double y,int playerId,int targetId) {
    visualEvents.push_back({type,x,y,state.clockMs,playerId,targetId});
    while(visualEvents.size()>32)visualEvents.erase(visualEvents.begin());
}

void GameEngine::beginTrackedPass(Player& from,Player& to,bool isCross,bool isThrough) {
    stats.recordPassAttempt();
    if(isThrough) stats.recordThroughBallAttempt();
    lastLooseOrigin.clear();
    double speed=std::hypot(state.ball.vx,state.ball.vy);
    metrics.passLaunchSpeedTotal+=speed; metrics.passLaunchCount++;
    stats.recordPassLaunch(speed);
    recordBallImpulse();
    double fd = fdFor(from.team);
    double forwardProgress = (to.x - from.x) * fd;
    stats.recordPassDirection(forwardProgress);
    if(to.role==Role::GK && forwardProgress < -30.0) stats.recordKeeperBackpass();
    bool offsideExempt = setPiece.type == SetPiece::Corner || setPiece.type == SetPiece::ThrowIn || setPiece.type == SetPiece::GoalKick;
    double line = offsideLineFor(from.team);
    bool beyondHalf = fd > 0.0 ? to.x > HALF_X : to.x < HALF_X;
    bool beyondPasser = fd > 0.0 ? to.x > from.x + OFFSIDE_TOLERANCE : to.x < from.x - OFFSIDE_TOLERANCE;
    bool beyondLine = fd > 0.0 ? to.x > line + OFFSIDE_TOLERANCE : to.x < line - OFFSIDE_TOLERANCE;
    bool receiverOffsideAtPass = beyondHalf && beyondPasser && beyondLine;
    pendingPass={true,from.id,to.id,from.team,isCross,isThrough,offsideExempt,receiverOffsideAtPass,from.x,from.y,line};
}

bool GameEngine::resolvePendingPass(Player& receiver) {
    if(!pendingPass.active)return false;
    if(receiver.team==pendingPass.team&&!pendingPass.offsideExempt){
        double fd = fdFor(pendingPass.team);
        // Intended receiver: judged by his position when the ball was played
        // (stored at launch). Judging at collection flagged every legal run
        // in behind. Unintended teammates keep the collection-time check.
        bool offside;
        if (receiver.id == pendingPass.toId) {
            offside = pendingPass.receiverOffsideAtPass;
        } else {
            bool beyondHalf = fd>0.0 ? receiver.x>HALF_X : receiver.x<HALF_X;
            bool beyondPasser = fd>0.0 ? receiver.x>pendingPass.passerX+OFFSIDE_TOLERANCE : receiver.x<pendingPass.passerX-OFFSIDE_TOLERANCE;
            bool beyondLine = fd>0.0 ? receiver.x>pendingPass.offsideLine+OFFSIDE_TOLERANCE : receiver.x<pendingPass.offsideLine-OFFSIDE_TOLERANCE;
            offside = beyondHalf&&beyondPasser&&beyondLine;
        }
        if(offside){
            stats.recordOffside();
            Team defendingTeam=receiver.team==Team::Home?Team::Away:Team::Home;
            pendingPass.active=false;
            emitEvent("offside", receiver.x, receiver.y, receiver.id, pendingPass.fromId);
            awardOffsideFreeKick(defendingTeam, receiver);
            return true;
        }
    }
    auto& b = state.ball;
    double deliveryDist = dist(pendingPass.passerX, pendingPass.passerY, receiver.x, receiver.y);
    double deliverySpeed = std::hypot(b.vx, b.vy);
    bool plausibleHeader = pendingPass.isCross
        && b.z >= HEADER_MIN_HEIGHT
        && b.z <= HEADER_MAX_HEIGHT
        && deliveryDist >= HEADER_MIN_DELIVERY_DIST
        && deliverySpeed >= HEADER_MIN_SPEED;
    if (plausibleHeader) {
        stats.recordHeader(b.z, deliveryDist, deliverySpeed, !plausibleHeader);
        receiver.headingAnim = 520.0;
        emitEvent("header", receiver.x, receiver.y, receiver.id, pendingPass.fromId);
        double fd = fdFor(receiver.team);
        double gx = goalXFor(receiver.team);
        double shotDistance = std::hypot(receiver.x - gx, receiver.y - PITCH_H / 2.0);
        if (receiver.team != pendingPass.team) {
            stats.recordHeaderClearance();
            double clearFd = fdFor(receiver.team);
            b.controllerId = -1;
            b.intendedReceiverId = -1;
            b.x = receiver.x;
            b.y = receiver.y;
            b.vx = clearFd * 210.0;
            b.vy = (receiver.y < PITCH_H / 2.0 ? -1.0 : 1.0) * 55.0;
            b.z = 18.0;
            b.vz = 95.0;
            b.lastTouchTeam = receiver.team;
            b.lastToucherId = receiver.id;
            lastLooseOrigin = "header_clearance";
            pendingPass.active = false;
            recordBallImpulse();
            return true;
        }
        if (receiver.team == pendingPass.team) {
            stats.recordPassComplete();
            if(receiver.id == pendingPass.toId) stats.recordPassIntendedReceived();
            else stats.recordPassWrongTeammate();
            stats.recordCrossComplete();
            double angleDeg = goalOpeningAngleDeg(receiver.x, receiver.y, gx);
            int pressure = countPressure(state.players, receiver.x, receiver.y, receiver.team, PRESSURE_RANGE);
            int laneBlockers = countLaneBlockers(state.players, receiver.x, receiver.y, gx, PITCH_H / 2.0, receiver.team, 32.0, 0.08, 0.88);
            double roleShotMax = receiver.role == Role::CM ? 235.0 : 285.0;
            // Pressure degrades the chance, not eligibility — strikers attack
            // headers in crowded boxes; a pressure veto turned them all into layoffs.
            bool headerShot = (receiver.role == Role::CF || receiver.role == Role::WM || receiver.role == Role::CM)
                && shotDistance < roleShotMax && angleDeg > 4.0 && laneBlockers <= 3;
            bool mustAttackHeader = shotDistance < 185.0 && angleDeg > 6.0 && pressure <= 2 && laneBlockers <= 1;
            double shotChance = clamp(0.32 + (roleShotMax - shotDistance) / 260.0 + angleDeg / 82.0 - pressure * 0.06 - laneBlockers * 0.08, 0.0, 0.85);
            if (headerShot && (mustAttackHeader || rng.random() < shotChance)) {
                receiver.crossCollected = 900.0;
                pendingPass.active = false;
                shootBall(receiver, nullptr);
                return true;
            }

            stats.recordHeaderLayoff();
            Player* outlet = nullptr;
            double bestScore = -1e9;
            for (auto& t : state.players) {
                if (t.team != receiver.team || t.id == receiver.id || t.role == Role::GK) continue;
                double d = dist(receiver.x, receiver.y, t.x, t.y);
                if (d < 28.0 || d > 285.0) continue;
                double progress = (t.x - receiver.x) * fd;
                double targetGoalDist = std::abs(t.x - gx);
                bool central = std::abs(t.y - PITCH_H / 2.0) < 180.0;
                double score = progress * 0.28 - std::abs(t.y - receiver.y) * 0.12 - d * 0.06;
                if (t.role == Role::CF || t.role == Role::WM) score += 28.0;
                if (t.role == Role::CM && central && targetGoalDist < 260.0) score += 34.0;
                if (targetGoalDist < shotDistance + 25.0 && central) score += 22.0;
                if (pressure >= 2 && progress < -15.0) score += 18.0;
                if (score > bestScore) { bestScore = score; outlet = &t; }
            }
            double tx = outlet ? outlet->x : clamp(receiver.x + fd * 95.0, 25.0, PITCH_W - 25.0);
            double ty = outlet ? outlet->y : lerp(receiver.y, PITCH_H / 2.0, 0.25);
            double dx = tx - receiver.x, dy = ty - receiver.y;
            double len = std::max(1.0, std::hypot(dx, dy));
            b.controllerId = -1;
            b.intendedReceiverId = outlet ? outlet->id : -1;
            receiverShieldTargetId = b.intendedReceiverId;
            b.x = receiver.x;
            b.y = receiver.y;
            b.vx = dx / len * 135.0;
            b.vy = dy / len * 135.0;
            b.z = 12.0;
            b.vz = 45.0;
            b.lastTouchTeam = receiver.team;
            b.lastToucherId = receiver.id;
            lastLooseOrigin = "header_layoff";
            pendingPass.active = false;
            recordBallImpulse();
            return true;
        }
    }
    if(receiver.team==pendingPass.team){
        stats.recordPassComplete();
        if(pendingPass.isThrough) stats.recordThroughBallComplete();
        if(receiver.id == pendingPass.toId) stats.recordPassIntendedReceived();
        else stats.recordPassWrongTeammate();
    }
    else {
        stats.recordPassIntercepted();
        emitEvent("intercept", receiver.x, receiver.y, receiver.id, pendingPass.toId);
    }
    if (pendingPass.isCross && receiver.team == pendingPass.team) {
        stats.recordCrossComplete();
        if (plausibleHeader) receiver.crossCollected = 1500.0;
    }
    if (pendingPass.isThrough && receiver.team == pendingPass.team) {
        receiver.throughCollected = 1400.0;
    }
    pendingPass.active=false;
    return false;
}

double GameEngine::goalOpeningAngleDeg(double x, double y, double gx) const {
    double dx=gx-x;
    double top=std::atan2(PITCH_H/2.0-GOAL_W/2.0-y,dx);
    double bottom=std::atan2(PITCH_H/2.0+GOAL_W/2.0-y,dx);
    double opening=std::abs(std::atan2(std::sin(bottom-top),std::cos(bottom-top)));
    return opening*180.0/PI;
}

void GameEngine::placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset) {
    double d=std::hypot(dx,dy);
    double tx,ty;
    if(d<0.001){
        double fd = fdFor(kicker.team);
        tx=clamp(kicker.x+fd*maxOffset,5.0,PITCH_W-5.0);
        ty=kicker.y;
    } else {
        tx=clamp(kicker.x+dx/d*maxOffset,5.0,PITCH_W-5.0);
        ty=clamp(kicker.y+dy/d*maxOffset,5.0,PITCH_H-5.0);
    }
    // Step toward the release point instead of snapping: a snap moved the ball
    // up to ~2*maxOffset across the kicker's body in one tick, and the launch
    // velocity covers the remainder within a tick or two anyway.
    double mx=tx-state.ball.x, my=ty-state.ball.y;
    double md=std::hypot(mx,my);
    if(md>BALL_RELEASE_MAX_STEP&&md<60.0){
        state.ball.x+=mx/md*BALL_RELEASE_MAX_STEP;
        state.ball.y+=my/md*BALL_RELEASE_MAX_STEP;
    } else {
        state.ball.x=tx;
        state.ball.y=ty;
    }
}

void GameEngine::passBallTo(Player& f,Player& t) { passBallTo(f,t,false,false,nullptr); }

bool GameEngine::passBallTo(Player& f,Player& t,bool throughBall,bool lob,const PassSelectionAudit* selectionAudit) {
    double rawDx=t.x-f.x,rawDy=t.y-f.y,rawDist=std::hypot(rawDx,rawDy);
    if(rawDist<1)return false;
    double speed=(PASS_SPEED_BASE+rawDist*PASS_SPEED_DIST)*(0.92+rng.random()*0.16);
    double travelTime=rawDist/std::max(speed,1.0);
    double receiverSpeed=std::hypot(t.vx,t.vy);
    double fd = fdFor(f.team);
    bool movingForward=t.vx*fd>5;
    double leadFactor=throughBall ? (movingForward&&receiverSpeed>14?1.12:0.72) : (movingForward&&receiverSpeed>20?0.90:0.55);
    double throughLead=throughBall?fd*(46+attrFactor(f.attrs.creativity)*78):0;
    double predX=t.x+t.vx*travelTime*leadFactor+throughLead;
    double predY=t.y+t.vy*travelTime*leadFactor;
    double dx=predX-f.x,dy=predY-f.y,adjDist=std::hypot(dx,dy);
    if(adjDist<1)return false;
    double passSkill=attrFactor(f.attrs.passing);
    double inacc=(1-passSkill)*rawDist*0.06;
    double tdx=dx+(rng.random()-0.5)*inacc;
    double tdy=dy+(rng.random()-0.5)*inacc;
    double tDist=std::hypot(tdx,tdy);
    double ownGoalX=ownGoalXFor(f.team);
    bool towardOwnGoal=f.team==Team::Home?tdx<0:tdx>0;
    bool defendingOwnBox=std::abs(f.x-ownGoalX)<PITCH_W/3.0;
    if(towardOwnGoal&&defendingOwnBox){
        double travel=(ownGoalX-f.x)/tdx;
        double crossingY=f.y+tdy*travel;
        if(travel>0&&travel<=1.0&&std::abs(crossingY-PITCH_H/2)<GOAL_W/2+BALL_R+8)return false;
    }
    auto&b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(f,tdx,tdy);
    // 450ms: long enough to stop instant re-grabs, short enough that a passer
    // whose ball deflected dead nearby reclaims it instead of jogging beside it.
    blockReboundFor(f.id,450);
    b.lastTouchTeam=f.team; b.lastToucherId=f.id;
    b.vx=tdx/tDist*speed; b.vy=tdy/tDist*speed;
    b.intendedReceiverId=t.id;
    receiverShieldTargetId=t.id;
    b.z=0; b.vz=0;
    int blockers = countLaneBlockers(state.players, f.x, f.y, predX, predY, f.team, 35.0, 0.03, 0.9);
    if(rawDist>240)b.vz=speed*0.55;
    if(blockers>0&&rawDist>120)b.vz=std::max(b.vz,speed*0.70);
    if(rawDist>350)b.vz=std::max(b.vz,speed);
    const auto* audit=selectionAudit;
    double goalX=goalXFor(f.team);
    bool fromWide=std::abs(f.y-PITCH_H/2)>130;
    bool intoBox=std::abs(predX-goalX)<270&&std::abs(predY-PITCH_H/2)<190;
    bool selectedCross=audit&&audit->purpose==ActionPurpose::Cross&&fromWide&&(f.role==Role::WM||f.role==Role::FB)&&!throughBall;
    bool whippedCross=fromWide&&intoBox&&(f.role==Role::WM||f.role==Role::FB)&&!throughBall
        &&(!audit||(audit->purpose!=ActionPurpose::Cutback&&audit->purpose!=ActionPurpose::Through&&audit->purpose!=ActionPurpose::Cross));
    // Only deliberate (selected) crosses count as crosses — counting every
    // incidental lofted wide ball reported ~350 "crosses" per match.
    if(selectedCross)stats.recordCrossAttempt();
    if(selectedCross){
        // Lead the runner goalward and slightly central instead of to feet —
        // headed chances need the ball met closer to goal, but a fixed box-zone
        // aim just found the retreated defenders (18% completion, all cleared).
        double ax=predX+fd*(34.0+rng.random()*36.0);
        ax=fd>0.0?std::min(ax,goalX-60.0):std::max(ax,goalX+60.0);
        double ay=lerp(predY,PITCH_H/2.0,0.25);
        double adx=ax-f.x+(rng.random()-0.5)*inacc, ady=ay-f.y+(rng.random()-0.5)*inacc;
        double aDist=std::max(1.0,std::hypot(adx,ady));
        double aSpeed=(PASS_SPEED_BASE+aDist*PASS_SPEED_DIST)*(0.92+rng.random()*0.16);
        b.vx=adx/aDist*aSpeed*1.15; b.vy=ady/aDist*aSpeed*1.15;
        // High arc: clear the heads near the crosser so the ball only dips back
        // into header height around the runner in the box.
        b.vz=std::max(b.vz,aSpeed*1.80);
    }
    if(whippedCross){
        b.vx*=1.30; b.vy*=1.30;
        b.vz=std::max(b.vz,speed*1.30*1.55);
    }
    if(audit){
        bool riskyFlag=audit->blockers>0||audit->receiverPressure>0||audit->expectedCompletion<0.58;
        stats.recordPassSelection(audit->distance,audit->expectedCompletion,audit->blockers,audit->receiverPressure,riskyFlag,audit->saferOptionTargetId);
    }
    beginTrackedPass(f,t,selectedCross,throughBall);
    return true;
}

void GameEngine::forcePassTo(Player&f,Player&t,const PassSelectionAudit*) {
    double dx=t.x-f.x,dy=t.y-f.y,rawDist=std::hypot(dx,dy);
    if(rawDist<1)return;
    double tdx=dx+(rng.random()-0.5)*rawDist*0.2;
    double tdy=dy+(rng.random()-0.5)*rawDist*0.2;
    double tDist=std::hypot(tdx,tdy);
    double ownGoalX=ownGoalXFor(f.team);
    bool towardOwnGoal=f.team==Team::Home?tdx<0:tdx>0;
    if(towardOwnGoal){
        double travel=(ownGoalX-f.x)/tdx;
        double crossingY=f.y+tdy*travel;
        if(travel>0&&travel<=1.0&&std::abs(crossingY-PITCH_H/2)<GOAL_W/2+BALL_R+14.0){
            tdy += (crossingY<PITCH_H/2 ? -1.0 : 1.0) * (GOAL_W/2+BALL_R+24.0);
            tDist=std::hypot(tdx,tdy);
        }
    }
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
}

bool GameEngine::attemptTackle(Player& tackler,Player& carrier){
    double contactDist=dist(tackler.x,tackler.y,carrier.x,carrier.y);
    auto& b=state.ball;
    if(setPiece.armed)return false;
    if(b.controllerId!=carrier.id||tackler.team==carrier.team||contactDist>TACKLE_RANGE)return false;
    if(carrier.role==Role::GK)return false;
    if(!canContestBall(tackler))return false;
    if(isCarrierShielded(carrier.id))return false;
    stats.recordTackleAttempt();
    double tackleSkill=attrFactor(tackler.attrs.tackling);
    double carrierControl=attrFactor(carrier.attrs.positioning)*0.35+attrFactor(carrier.attrs.speed)*0.15;
    double facingBonus=(tackler.team==Team::Home?tackler.vx>0:tackler.vx<0)?0.08:-0.05;
    double carrierSpeed=std::hypot(carrier.vx,carrier.vy);
    double forwardX=carrierSpeed>8?carrier.vx/carrierSpeed:fdFor(carrier.team);
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
    double ballSideX=b.x-carrier.x;
    double ballSideY=b.y-carrier.y;
    double ballSideLen=std::hypot(ballSideX,ballSideY);
    double ballExposureDot=ballSideLen>0.5
        ? (ballSideX/ballSideLen)*toTacklerX+(ballSideY/ballSideLen)*toTacklerY
        : facingDot;
    double tacklerFacingX=std::cos(tackler.facing);
    double tacklerFacingY=std::sin(tackler.facing);
    double tacklerFacingCarrierDot=contactDist>0
        ? tacklerFacingX*(-toTacklerX)+tacklerFacingY*(-toTacklerY)
        : 0;
    bool tacklerSquaredUp=tacklerFacingCarrierDot>std::cos(50.0*PI/180.0);
    bool exposedToFacingTackler=ballExposureDot>0.25&&tacklerSquaredUp;

    // Shielding: carrier has back turned to tackler → harder to tackle
    // Front exposed: carrier facing tackler → easier to tackle
    double shieldingBonus=0.0;
    if(ballExposureDot<-0.45) shieldingBonus=-0.10;
    else if(ballExposureDot>0.45) shieldingBonus=0.10;
    else if(facingDot>0.55) shieldingBonus=0.05;
    if(exposedToFacingTackler) shieldingBonus+=0.04;

    double chance=clamp(0.18+tackleSkill*0.35-carrierControl*0.15+facingBonus
        -(carrierShielded?0.20:0)-(fromBehind?0.14:0)
        +(approachDot>0.3&&approachDot<0.85?0.06:0)+dribbleBonus+shieldingBonus,0.06,0.72);
    if(rng.random()>=chance){
        // Per-failure foul odds must be low because duel volume is high —
        // 0.34/0.10 produced ~190 fouls per match (real: ~22).
        double foulChance=fromBehind?0.06:0.015;
        if(rng.random()<foulChance){
            stats.recordTackleFoul();
            double foulX = carrier.x;
            double foulY = carrier.y;
            emitEvent("foul", foulX, foulY, tackler.id, carrier.id);
            b.vx=b.vy=b.z=b.vz=0;
            b.controllerId=-1;
            b.intendedReceiverId=-1;
            b.lastTouchTeam=carrier.team; b.lastToucherId=carrier.id;
            lastLooseOrigin.clear();
            blockReboundFor(tackler.id,650);
            double defendingGoalX = ownGoalXFor(tackler.team);
            double defendingFd = fdFor(tackler.team);
            bool foulInBox = std::abs(foulX - defendingGoalX) < PENALTY_AREA_W
                && std::abs(foulY - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (foulInBox) {
                b.x = defendingGoalX + defendingFd * 110.0;
                b.y = PITCH_H / 2.0;
                stats.recordPenaltyAwarded();
                awardSetPiece(SetPiece::Penalty, carrier.team);
                setPiece.reason = "penalty";
            } else {
                b.x = clamp(foulX, 20.0, PITCH_W - 20.0);
                b.y = clamp(foulY, 20.0, PITCH_H - 20.0);
                awardSetPiece(SetPiece::FreeKick, carrier.team);
            }
            setPiece.spotX = b.x;
            setPiece.spotY = b.y;
        }else{
            blockReboundFor(tackler.id,650);
        }
        return false;
    }
    pendingPass.active=false;
    shot.tracked=false;
    shot.preventable=false;
    shot.header=false;
    shot.penalty=false;
    shot.dribble20m=false;
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    double angle=std::atan2(b.y-tackler.y,b.x-tackler.x)+(rng.random()-0.5)*0.9;
    double outcomeRoll=rng.random();
    double controlChance=clamp(0.28+tackleSkill*0.35-carrierControl*0.18
        -(fromBehind?0.20:0)+(approachDot>0.15?0.12:0)
        -(carrier.dribbleType==3?0.08:0)+(exposedToFacingTackler?0.04:0),0.12,0.74);
    if(outcomeRoll<controlChance){
        stats.recordTackleWin(true);
        emitEvent("tackle_won", (tackler.x+carrier.x)/2.0, (tackler.y+carrier.y)/2.0, tackler.id, carrier.id);
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
    emitEvent("tackle_loose", (tackler.x+carrier.x)/2.0, (tackler.y+carrier.y)/2.0, tackler.id, carrier.id);
    b.controllerId=-1;
    // A poke-away travels a few meters, not 12+ — high speeds here sent every
    // contested ball pinging across the pitch.
    double kickSpeed=30+outcomeRoll*42+(carrier.dribbleType==3?16:0)+(carrierSpeed>DRIBBLE_MEDIUM_SPEED?10:0);
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
    if(goalKickMonitor.active&&s.team!=goalKickMonitor.team){
        stats.recordGoalKickTrappedShot();
        goalKickMonitor.active=false;
    }
    stats.recordShot(s.team, false, s.role);
    bool dribble20mShot = carrierTracker.carryTrackerId == s.id && carrierTracker.carryPathDistance >= 200.0;
    if (dribble20mShot) stats.recordDribble20mShot();
    double gx=goalXFor(s.team);
    double accuracy=attrFactor(s.attrs.shooting);
    double goalCenterY=PITCH_H/2.0;
    double shotDistance=std::hypot(gx-s.x,goalCenterY-s.y);
    double freshCrossMax=s.role==Role::CF?285.0:(s.role==Role::WM?270.0:250.0);
    bool freshCross=s.crossCollected>0.0&&shotDistance<freshCrossMax;
    if(freshCross)stats.recordHeadedShot();
    stats.recordShotDistance(shotDistance);
    int pressureCount=0;
    pressureCount = countPressure(state.players, s.x, s.y, s.team, PRESSURE_RANGE);
    double angleDeg=goalOpeningAngleDeg(s.x,s.y,gx);
    int laneBlockers=0;
    double dxGoal=gx-s.x, dyGoal=goalCenterY-s.y, laneLenSq=dxGoal*dxGoal+dyGoal*dyGoal;
    if(laneLenSq>1.0){
        for(auto&o:state.players){
            if(o.team==s.team||o.role==Role::GK)continue;
            double along=((o.x-s.x)*dxGoal+(o.y-s.y)*dyGoal)/laneLenSq;
            if(along<=0.06||along>=0.92)continue;
            double perp=std::hypot(o.x-s.x-along*dxGoal,o.y-s.y-along*dyGoal);
            double bodyWidth=shotDistance>180.0?38.0:30.0;
            if(perp<bodyWidth)laneBlockers++;
        }
    }
    bool outsideGoalLane=std::abs(s.y-goalCenterY)>GOAL_W/2+20;
    bool acuteGeometry=outsideGoalLane&&angleDeg<7.5&&shotDistance>150;
    const auto* audit=selectionAudit;
    if(audit){
        bool betterPassFlag=audit->bestPassTargetId>=0&&audit->bestPassScore>audit->score+0.12;
        bool tightAngleFlag=audit->angleDeg<8.0&&audit->distance>120.0;
        stats.recordShotSelection(audit->angleDeg,audit->pressureCount,0,0,0,0,0,0,betterPassFlag,tightAngleFlag);
    } else {
        bool tightAngleFlag=angleDeg<8.0&&shotDistance>120.0;
        stats.recordShotSelection(angleDeg,pressureCount,0,0,0,0,0,0,false,tightAngleFlag);
    }
    if(shotDistance>210||acuteGeometry||(audit&&audit->bestPassScore>audit->score+0.12)){stats.recordQuestionableShot();}
    double anglePenalty=clamp(std::abs(s.y-goalCenterY)/230,0.0,1.0);
    double distancePenalty=clamp((shotDistance-70)/270,0.0,1.0);
    double longRangePenalty=clamp((shotDistance-120)/130,0.0,1.0);
    double closePressure = shotDistance < 130.0 ? pressureCount * (freshCross?SHOT_ERROR_CLOSE_PRESSURE_CROSS:SHOT_ERROR_CLOSE_PRESSURE_NORMAL) : 0.0;
    double roleError = s.role==Role::CF ? -42.0
        : (s.role==Role::WM ? (freshCross ? -8.0 : 0.0)
        : (s.role==Role::CM ? (freshCross?58.0:(shotDistance>130.0?30.0:0.0)) : 0.0));
    double executionError=SHOT_ERROR_BASE+(1-accuracy)*SHOT_ERROR_SKILL+pressureCount*(freshCross?SHOT_ERROR_PRESSURE_CROSS:SHOT_ERROR_PRESSURE_NORMAL)+closePressure+laneBlockers*(freshCross?SHOT_ERROR_LANE_CROSS:SHOT_ERROR_LANE_NORMAL)
        +anglePenalty*SHOT_ERROR_ANGLE+distancePenalty*SHOT_ERROR_DISTANCE+longRangePenalty*SHOT_ERROR_LONG_RANGE;
    executionError=std::max(SHOT_ERROR_FLOOR,executionError+roleError);
    bool credibleFinish=angleDeg>12.0&&shotDistance<185.0&&pressureCount<=1&&laneBlockers<=1;
    bool freshThrough=s.throughCollected>0.0&&shotDistance<245.0;
    bool directFreeKickShot=setPiece.type==SetPiece::FreeKick;
    if(credibleFinish)executionError*=shotDistance<95.0?0.60:0.70;
    if(directFreeKickShot)executionError*=0.48;
    if(freshThrough&&angleDeg>8.0&&pressureCount<=1)executionError*=shotDistance<170.0?0.84:0.92;
    if(freshCross)executionError*=s.role==Role::CF?0.54:(s.role==Role::WM?0.72:0.90);
    double postAimScale=credibleFinish?0.92:1.0;
    double aimedPost=(rng.random()<0.5?-1.0:1.0)*GOAL_W*(0.12+accuracy*0.11)*postAimScale;
    double goalY=goalCenterY+aimedPost+(rng.random()+rng.random()-1.0)*executionError;
    if(acuteGeometry){
        double nearPostSide=s.y<goalCenterY?-1.0:1.0;
        double nearPostY=goalCenterY+nearPostSide*GOAL_W/2;
        goalY=nearPostY - nearPostSide * (BALL_R + 7.0 + rng.random() * 16.0);
    }
    double missMargin = directFreeKickShot
        ? clamp(5.0 + shotDistance * 0.012 + laneBlockers * 2.0, 7.0, 12.0)
        : clamp(9.0 + shotDistance * 0.030 + pressureCount * 3.0 + laneBlockers * 3.0, 14.0, 24.0);
    goalY = clamp(goalY, goalCenterY - GOAL_W / 2.0 - missMargin, goalCenterY + GOAL_W / 2.0 + missMargin);
    double dx=gx-s.x, dy=goalY-s.y;
    double d=std::hypot(dx,dy);
    // Headers redirect the cross's pace — box pressure costs them far less
    // power than it costs a wound-up foot shot.
    double speed=SHOT_SPEED_BASE+accuracy*128.0-pressureCount*(freshCross?12.0:28.0)
        -laneBlockers*(freshCross?16.0:34.0)-longRangePenalty*52+(credibleFinish?34.0:0.0);
    speed=std::max(230.0,speed);
    auto& b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(s,dx,dy);
    blockReboundFor(s.id,850);
    b.vx=dx/d*speed; b.vy=dy/d*speed;
    b.intendedReceiverId=-1; b.z=b.vz=0;
    // Direct free kick with a wall: lift the strike over it.
    if(directFreeKickShot&&laneBlockers>=1){ b.vz=speed*0.50; }
    b.lastTouchTeam=s.team; b.lastToucherId=s.id;
    metrics.shotLaunchSpeedTotal+=speed; metrics.shotLaunchCount++;
    stats.recordShotLaunch(speed);
    recordBallImpulse();
    pendingPass.active=false;
    lastLooseOrigin="shot";
    receiverShieldTargetId=-1;
    shot.active=true; shot.tracked=true; shot.preventable=false; shot.header=freshCross; shot.dribble20m=dribble20mShot; shot.team=s.team; shot.shooterId=s.id; shot.originX=s.x; shot.originY=s.y;
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
    contestBlockedUntil[carrier.id] = 0;
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
        knockAheadCooldownUntil[collector->id] = state.clockMs + 1400;
    } else if (collector && collector->team == activeKnockAhead.team) {
        stats.recordKnockAheadRetained();
    } else {
        stats.recordKnockAheadTurnover(activeKnockAhead.risky);
    }
    activeKnockAhead.active = false;
}


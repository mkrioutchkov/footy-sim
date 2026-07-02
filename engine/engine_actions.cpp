#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>
#include <cstdio>

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

void GameEngine::emitEvent(const std::string& type,double x,double y,int playerId,int targetId,bool traceOnly) {
    VisualEvent ev{type,x,y,state.clockMs,playerId,targetId};
    traceEventQueue.push_back(ev);
    // traceOnly events (e.g. kickoff/restart markers) go to the trace log but NOT
    // the capped renderer ticker — so they can't perturb the getJSON events[] the
    // golden guard hashes, and don't spam the live ticker with restart lines.
    if(traceOnly)return;
    visualEvents.push_back(ev);
    while(visualEvents.size()>32)visualEvents.erase(visualEvents.begin());
}

void GameEngine::beginTrackedPass(Player& from,Player& to,bool isCross,bool isThrough,bool isCutback) {
    stats.recordPassAttempt();
    if (from.id >= 0 && from.id < 22) pPasses[from.id]++;   // per-player rating input
    if(isThrough) stats.recordThroughBallAttempt();
    lastLooseOrigin = LooseOrigin::None;
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
    pendingPass={true,from.id,to.id,from.team,isCross,isThrough,isCutback,offsideExempt,receiverOffsideAtPass,from.x,from.y,line};
    // Snapshot EVERY attacking teammate's offside status now (the law judges position when the ball is played).
    pendingPass.offsideAtPass = {};
    for(auto& tm : state.players){
        if(tm.team!=from.team || tm.id==from.id || tm.role==Role::GK) continue;
        bool bh = fd>0.0 ? tm.x>HALF_X : tm.x<HALF_X;
        bool bp = fd>0.0 ? tm.x>from.x+OFFSIDE_TOLERANCE : tm.x<from.x-OFFSIDE_TOLERANCE;
        bool bl = fd>0.0 ? tm.x>line+OFFSIDE_TOLERANCE : tm.x<line-OFFSIDE_TOLERANCE;
        pendingPass.offsideAtPass[tm.id] = bh&&bp&&bl;
    }
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
            // Unintended teammate: judged by HIS position when the ball was PLAYED (the law),
            // not at collection — collection-time flagged onside players who chased a long ball
            // 20m+ past the line (diagnosed: 63% of calls, median 164px past the line, all false).
            offside = pendingPass.offsideAtPass[receiver.id];
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
            stats.recordPassIntercepted();   // the cross was cut out — close the pass ledger
            // A defender heading clear under the cross near his own line often
            // can only put it behind — a common corner source.
            double ownLineX = ownGoalXFor(receiver.team);
            if (std::abs(receiver.x - ownLineX) < 165.0 && rng.random() < 0.62) {   // corner boost (was 0.45/130)
                pendingPass.active = false;
                Team att = receiver.team == Team::Home ? Team::Away : Team::Home;
                awardCorner(att, receiver.team == Team::Home, receiver.y);
                return true;
            }
            double clearFd = fdFor(receiver.team);
            b.controllerId = -1;
            b.intendedReceiverId = -1;
            // Launch from the BALL's flight position — snapping it to the
            // header-winner's body popped it up to 90px in one tick.
            b.vx = clearFd * 210.0;
            b.vy = (receiver.y < PITCH_H / 2.0 ? -1.0 : 1.0) * 55.0;
            b.z = 18.0;
            b.vz = 95.0;
            b.lastTouchTeam = receiver.team;
            b.lastToucherId = receiver.id;
            lastLooseOrigin = LooseOrigin::HeaderClearance;
            pendingPass.active = false;
            recordBallImpulse();
            return true;
        }
        if (receiver.team == pendingPass.team) {
            stats.recordPassComplete();
            if (pendingPass.fromId >= 0 && pendingPass.fromId < 22) pPassesCompleted[pendingPass.fromId]++;
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
                if(receiver.id>=0&&receiver.id<22&&pendingPass.fromId!=receiver.id){
                    lastReceiveFrom[receiver.id]=pendingPass.fromId;
                    lastReceiveMs[receiver.id]=state.clockMs;
                }
                pendingPass.active = false;
                shootBall(receiver, nullptr);
                return true;
            }

            stats.recordHeaderLayoff();
            Player* outlet = nullptr;
            double bestScore = -1e9;
            for (auto& t : state.players) {
                if (t.team != receiver.team || t.id == receiver.id || t.role == Role::GK || t.sentOff) continue;
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
            b.vx = dx / len * 135.0;
            b.vy = dy / len * 135.0;
            b.z = 12.0;
            b.vz = 45.0;
            b.lastTouchTeam = receiver.team;
            b.lastToucherId = receiver.id;
            lastLooseOrigin = LooseOrigin::HeaderLayoff;
            pendingPass.active = false;
            recordBallImpulse();
            return true;
        }
    }
    bool passOk=receiver.team==pendingPass.team;
    if(passDebug){
        // PASSRES: one line per resolved pass (complete/fail) with match-clock
        // seconds + passer stamina — lets a probe bucket completion% by window
        // (early vs late) to confirm decision-level fatigue. Measurement-only.
        const Player* fromP=playerById(pendingPass.fromId);
        fprintf(stderr,"PASSRES t=%d ok=%d sf=%d\n",(int)(state.clockMs/1000),passOk?1:0,
                fromP?(int)fromP->stamina:-1);
    }
    if(passOk){
        if(receiver.id>=0&&receiver.id<22&&pendingPass.fromId!=receiver.id){
            lastReceiveFrom[receiver.id]=pendingPass.fromId;
            lastReceiveMs[receiver.id]=state.clockMs;
        }
        stats.recordPassComplete();
        if (pendingPass.fromId >= 0 && pendingPass.fromId < 22) pPassesCompleted[pendingPass.fromId]++;
        if(pendingPass.isThrough) stats.recordThroughBallComplete();
        if(receiver.id == pendingPass.toId) stats.recordPassIntendedReceived();
        else stats.recordPassWrongTeammate();
    }
    else {
        stats.recordPassIntercepted();
        emitEvent("intercept", receiver.x, receiver.y, receiver.id, pendingPass.toId);
        if (passDebug) {
            const Player* intended = playerById(pendingPass.toId);
            double laneFrac = -1.0, passDist = 0.0;
            if (intended) {
                double dx = intended->x - pendingPass.passerX, dy = intended->y - pendingPass.passerY, ls = dx*dx + dy*dy;
                if (ls > 1.0) laneFrac = clamp(((receiver.x - pendingPass.passerX)*dx + (receiver.y - pendingPass.passerY)*dy)/ls, 0.0, 1.0);
                passDist = std::hypot(dx, dy);
            }
            // lane% = where along the passer->receiver line it was cut (0=at passer, 100=at receiver).
            fprintf(stderr, "INTCPT t=%d comp=%d blk=%d press=%d fwd=%d dist=%d lane=%d cross=%d thru=%d saferComp=%d\n",
                    (int)(state.clockMs/1000), (int)(pendingPass.auComp*100), pendingPass.auBlk, pendingPass.auPress,
                    (int)pendingPass.auFwd, (int)passDist, (int)(laneFrac*100), (int)pendingPass.isCross,
                    (int)pendingPass.isThrough, (int)(pendingPass.auSafer*100));
        }
    }
    if (pendingPass.isCross && receiver.team == pendingPass.team) {
        stats.recordCrossComplete();
        // (removed dead `if (plausibleHeader) receiver.crossCollected = 1500.0;`
        //  — every plausibleHeader path above returns, so it was unreachable.)
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

// Shared whip math for driven deliveries. Assumes ball velocity already
// points at the target with magnitude `speed`. Adds the dip (the ball
// arrives at header height as it reaches the aim point), the inswinging
// curl toward the goal mouth, and pre-rotates the launch wide so the bent
// path still lands on the target.
void GameEngine::applyWhipDelivery(double dist, double speed, double goalX, double curlMin, double curlRange) {
    auto& b = state.ball;
    double flightT = clamp(dist / speed, 0.25, 1.1);
    b.vz = clamp((CROSS_DIP_TARGET_Z + 0.5 * GRAVITY * flightT * flightT) / flightT, 150.0, 280.0);
    double toGoalCross = b.vx * (PITCH_H / 2.0 - b.y) - b.vy * (goalX - b.x);
    b.curl = (toGoalCross >= 0 ? 1.0 : -1.0) * (curlMin + rng.random() * curlRange);
    double preRot = -b.curl * flightT * 0.45;
    double cs = std::cos(preRot), sn = std::sin(preRot);
    double nvx = b.vx * cs - b.vy * sn;
    b.vy = b.vx * sn + b.vy * cs;
    b.vx = nvx;
}

void GameEngine::placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset) {
    state.ball.curl=0.0;
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

bool GameEngine::passBallTo(Player& f,Player& t,bool throughBall,bool lob,const PassSelectionAudit* selectionAudit,bool secure) {
    double rawDx=t.x-f.x,rawDy=t.y-f.y,rawDist=std::hypot(rawDx,rawDy);
    if(rawDist<1)return false;
    // `secure`: a deliberate, unpressured short roll (keeper distribution to an
    // already-clear man). Drive it faster and flatter so a defender can't drift
    // into the lane before it arrives — an open keeper roll isn't getting nicked.
    double speed=(PASS_SPEED_BASE+rawDist*PASS_SPEED_DIST)*(0.92+rng.random()*0.16);
    if(secure)speed*=1.45;
    double travelTime=rawDist/std::max(speed,1.0);
    double receiverSpeed=std::hypot(t.vx,t.vy);
    double fd = fdFor(f.team);
    bool movingForward=t.vx*fd>5;
    double leadFactor=throughBall ? (movingForward&&receiverSpeed>14?1.32:0.80) : (movingForward&&receiverSpeed>20?0.90:0.55);
    double throughLead=throughBall?fd*(90+attrFactor(f.attrs.creativity)*120):0;
    double predX=t.x+t.vx*travelTime*leadFactor+throughLead;
    double predY=t.y+t.vy*travelTime*leadFactor;
    double dx=predX-f.x,dy=predY-f.y,adjDist=std::hypot(dx,dy);
    if(adjDist<1)return false;
    double passSkill=attrFactor(f.attrs.passing);
    double skillMiss=std::pow(1.0-passSkill,1.4);
    double inacc=skillMiss*(rawDist*0.085+(rawDist/200.0)*(rawDist/200.0)*7.0);
    // Fatigue: a tired passer sprays it — error grows as the tank empties
    // (up to +80% at empty). No-op at full stamina, so early passes are clean.
    inacc*=1.0+(1.0-staminaFrac(f.stamina))*0.8;
    if(secure)inacc*=0.12;   // rolled accurately to feet
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
    bool selectedCutback=audit&&audit->purpose==ActionPurpose::Cutback;   // render-hint + first-time-finish arm (engine_physics.cpp)
    bool whippedCross=fromWide&&intoBox&&(f.role==Role::WM||f.role==Role::FB)&&!throughBall
        &&(!audit||(audit->purpose!=ActionPurpose::Cutback&&audit->purpose!=ActionPurpose::Through&&audit->purpose!=ActionPurpose::Cross));
    // Only deliberate (selected) crosses count as crosses — counting every
    // incidental lofted wide ball reported ~350 "crosses" per match.
    if(selectedCross)stats.recordCrossAttempt(f.team==Team::Home);
    if(selectedCross){
        // Lead the runner goalward and slightly central instead of to feet —
        // headed chances need the ball met closer to goal, but a fixed box-zone
        // aim just found the retreated defenders (18% completion, all cleared).
        // Small lead only — the whip itself supplies the attacking momentum;
        // a 34-70px lead had the ball arriving before the runner ever could.
        double ax=predX+fd*(10.0+rng.random()*24.0);
        ax=fd>0.0?std::min(ax,goalX-60.0):std::max(ax,goalX+60.0);
        double ay=lerp(predY,PITCH_H/2.0,0.25);
        double adx=ax-f.x+(rng.random()-0.5)*inacc, ady=ay-f.y+(rng.random()-0.5)*inacc;
        double aDist=std::max(1.0,std::hypot(adx,ady));
        // A cross is a driven delivery, not a pass with a multiplier — the
        // pass formula tops out ~220px/s, a floaty lob. Drive it near shot
        // speed and let applyWhipDelivery supply the dip and the bend.
        double aSpeed=clamp(CROSS_DRIVE_SPEED_BASE+aDist*CROSS_DRIVE_SPEED_PER_PX,
                            CROSS_DRIVE_SPEED_MIN,CROSS_DRIVE_SPEED_MAX)*(0.95+rng.random()*0.12);
        // Nothing kicked should leave the boot faster than the hardest shot
        // (~38 m/s). A "cross" aimed OUTSIDE the box (intoBox false) is really a
        // wide diagonal / switch — cap it lower (~34 m/s); those over-hit
        // switches were wasted, so slowing them lets teammates RETAIN wide
        // possession (the +1.6-goal effect, paired). A genuine box delivery
        // stays DRIVEN but is capped at the hardest-shot ceiling (~38 m/s) so it
        // no longer launches at the measured 44-56 m/s.
        aSpeed=std::min(aSpeed, intoBox ? 380.0 : 340.0);
        b.vx=adx/aDist*aSpeed; b.vy=ady/aDist*aSpeed;
        // Low driven cross vs whipped loft. A runner attacking the near post or
        // the 6-yard box gets the ball SKIDDED low and hard across the face —
        // too quick for the keeper to claim, a tap-in if it's met. The runner
        // now sweeps it FIRST-TIME (see the first-time-finish branch in
        // checkBallPlayerCollision), so it's driven hard — no longer throttled
        // to stay trappable. Deeper / far-post / aerial targets keep the
        // whipped, dipping loft.
        double tgdCross=std::abs(predX-goalX);
        bool lowDriven=tgdCross<112.0 && std::abs(predY-PITCH_H/2.0)<120.0;
        if(lowDriven){
            double lowSpeed=clamp(aDist*0.95,250.0,330.0);
            b.vx=adx/aDist*lowSpeed; b.vy=ady/aDist*lowSpeed;
            b.z=0; b.vz=std::min(lowSpeed*0.12,24.0);
            double cz=adx*(PITCH_H/2.0-f.y)-ady*(goalX-f.x);
            b.curl=(cz>=0?1.0:-1.0)*CROSS_CURL_MIN*0.6;
        } else {
            applyWhipDelivery(aDist,aSpeed,goalX,CROSS_CURL_MIN,CROSS_CURL_RANGE);
        }
    }
    if(whippedCross){
        // Incidental lofted wide balls keep the high floaty arc (they're just
        // passes); only deliberate crosses above get the driven whip. Making
        // these driven too turned ~350 routine deliveries/match into header
        // duels and halved chance creation. Mild curl kept for looks.
        b.vx*=1.30; b.vy*=1.30;
        b.vz=std::max(b.vz,speed*1.30*1.55);
        double crossz=b.vx*(PITCH_H/2.0-b.y)-b.vy*(goalX-b.x);
        b.curl=(crossz>=0?1.0:-1.0)*(0.18+rng.random()*0.12);
    }
    if(audit){
        bool riskyFlag=audit->blockers>0||audit->receiverPressure>0||audit->expectedCompletion<0.58;
        stats.recordPassSelection(audit->distance,audit->expectedCompletion,audit->blockers,audit->receiverPressure,riskyFlag,audit->saferOptionTargetId);
    }
    beginTrackedPass(f,t,selectedCross,throughBall,selectedCutback);
    if(audit){ pendingPass.auComp=audit->expectedCompletion; pendingPass.auBlk=audit->blockers; pendingPass.auPress=(int)audit->receiverPressure; pendingPass.auFwd=audit->forwardProgress; pendingPass.auSafer=audit->saferOptionCompletion; pendingPass.auSaferId=audit->saferOptionTargetId; }
    return true;
}

void GameEngine::forcePassTo(Player&f,Player&t,const PassSelectionAudit*) {
    double dx=t.x-f.x,dy=t.y-f.y,rawDist=std::hypot(dx,dy);
    if(rawDist<1)return;
    // Kicked-clearance behind: forcePassTo IS the desperate-clearance path (only Clear-purpose
    // passes reach it, agent.cpp:341). A clearance hacked away near the own goal line sometimes
    // slices/hooks OUT for a corner — the engine had no kicked-clearance corner source, so corners
    // capped ~5 vs real 9-11. Gated low + in-box only (genuinely last-ditch).
    {
        double clrLine=ownGoalXFor(f.team);
        if(std::abs(f.x-clrLine)<PENALTY_AREA_W && rng.random()<0.18){
            emitEvent("clearance", f.x, f.y, f.id);
            awardCorner(f.team==Team::Home?Team::Away:Team::Home, f.team==Team::Home, f.y);
            return;
        }
    }
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
    bool carrierShielded=isCarrierShielded(carrier.id)||isActiveShield(carrier.id);
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

    // Shielding vs exposure is the heart of a duel and was barely weighted.
    // Back turned, ball tucked away from the tackler → very hard to win.
    // Ball shown front-to-front → it should be there for the taking.
    double shieldingBonus=0.0;
    if(ballExposureDot<-0.45) shieldingBonus=-0.22;       // well shielded
    else if(ballExposureDot<-0.10) shieldingBonus=-0.12;  // mostly shielded
    else if(ballExposureDot>0.45) shieldingBonus=0.24;    // ball exposed at him
    else if(ballExposureDot>0.10) shieldingBonus=0.12;    // partly exposed
    if(exposedToFacingTackler) shieldingBonus+=0.10;      // and he's squared up

    double chance=clamp(0.20+tackleSkill*0.38-carrierControl*0.15+facingBonus
        -(carrierShielded?0.20:0)-(fromBehind?0.14:0)
        +(approachDot>0.3&&approachDot<0.85?0.06:0)+dribbleBonus+shieldingBonus,0.06,0.75);
    // Contain by default: a defender only COMMITS to a challenge when he has a
    // real chance of winning it (or it's an emergency, or the carrier has
    // stopped and exposed the ball). Otherwise he stays on his feet and
    // jockeys — the agent's containment keeps him goal-side. This converts the
    // flood of low-percentage lunges-and-misses (~70% of all challenges) into
    // the contain-first defending real players actually do, without a recorded
    // attempt or a wild swing.
    double carrierGoalDist = std::abs(carrier.x - ownGoalXFor(tackler.team));
    bool inPenaltyBox = carrierGoalDist < PENALTY_AREA_W
        && std::abs(carrier.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
    // Emergency lunges are forced only in the APPROACH band (box edge to
    // EMERGENCY_BOX_DIST) — NOT inside the box itself. A defender who dives in
    // the box gives a penalty; real defenders jockey and force the shot. Inside
    // the box he commits only to a genuinely winnable tackle (chance>=0.30) or
    // a clearly exposed loose touch. This was the engine's penalty factory:
    // forced low-% box lunges fouled ~2-3x/match (~10x real).
    bool boxEmergency = carrierGoalDist < EMERGENCY_BOX_DIST - directiveBias[tackler.id].stayOnFeet * 60.0 && !inPenaltyBox
        && std::abs(carrier.y - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
    bool ballPushedAhead = carrier.dribbleType == 2 || carrier.dribbleType == 3;
    // aggression lowers the commit bar: a high-press side dives in on lower-%
    // challenges (wins it back higher, but is beaten more); a contain side
    // only commits to a clear chance. Centred at dial 50 = the old 0.30.
    // tackle_hard lowers the commit bar (dives in on lower-% challenges);
    // stay_on_feet raises it (jockey, only commit to a clear chance).
    double commitBar = clamp(0.30 - (configFor(tackler.team).aggression - 50.0) / 50.0 * 0.13
        - directiveBias[tackler.id].tackleAggression * 0.13 + directiveBias[tackler.id].stayOnFeet * 0.15, 0.10, 0.50);
    // Deliberate (cynical) foul: the last man, genuinely beaten on a transition
    // break OUTSIDE the box, brings the carrier down to stop the counter. Pure
    // state (no rng); it forces commitment so the challenge reaches the existing
    // failed-tackle foul branch, where the foul/card thresholds are re-weighted.
    int goalSideCover = 0;
    for (auto& d : state.players)
        if (d.team == tackler.team && d.role != Role::GK && d.id != tackler.id && !d.sentOff
            && (d.x - carrier.x) * fdFor(tackler.team) < 0.0          // goal-side of the carrier
            && std::abs(d.y - carrier.y) < CYNICAL_LASTMAN_LATERAL) goalSideCover++;
    // The classic professional foul: a genuine last-man break (no cover goal-
    // side) with the carrier driving at me in the approach band, where I can't
    // win the ball. Not gated on the transition flag — a beaten last man is a
    // beaten last man whenever it happens (that gate made it fire ~0/match).
    // A beaten last man has the carrier breaking PAST him toward goal (not
    // driving into him — that's a winnable front challenge). Key off the
    // carrier's forward velocity toward our goal, not approachDot.
    double carrierToGoal = carrierSpeed > 8.0 ? forwardX * fdFor(carrier.team) : 0.0;
    bool cynical = !inPenaltyBox
        && carrierGoalDist > CYNICAL_BAND_NEAR && carrierGoalDist < CYNICAL_BAND_FAR
        && carrierToGoal > CYNICAL_FOUL_DRIVE                         // carrier breaking toward my goal
        && carrierSpeed > CYNICAL_MIN_SPEED                          // a real sprint break
        && goalSideCover == 0                                        // I am the last man
        && chance < commitBar                                        // the tackle is genuinely unwinnable
        && state.ball.controllerId == carrier.id                     // he's in control (a real break, not a loose 50/50)
        && directiveBias[tackler.id].stayOnFeet < 0.5;               // a stay_on_feet order suppresses it
    bool committed = chance >= commitBar || boxEmergency || cynical
        || (carrier.dribbleType == 0 && ballExposureDot > 0.0)
        || (ballPushedAhead && ballExposureDot > 0.15)   // nick the loose touch off an open carry
        || (ballExposureDot > 0.40);  // ball shown front-to-front at me — go, whatever the carry type
    if (!committed) return false;
    // Even a committed challenge inside the box is careful — half the foul risk
    // of an open-field lunge (a clumsy one is still a penalty, just far rarer).
    double boxFoulScale = inPenaltyBox ? 0.54 : 1.0;   // 0.5 -> 0.54: penalties ~0.14 -> ~0.3/match (still careful in the box)
    stats.recordTackleAttempt();
    if(rng.random()>=chance){
        // Per-failure foul odds must be low because duel volume is high —
        double foulChance=(fromBehind?TACKLE_FOUL_FROM_BEHIND:TACKLE_FOUL_NORMAL)*boxFoulScale
            *(1.0 + directiveBias[tackler.id].tackleAggression * 0.35)   // tackle_hard: more reckless
            *(1.0 - directiveBias[tackler.id].stayOnFeet * 0.45)         // stay_on_feet: cleaner
            *(1.0 + (1.0 - staminaFrac(tackler.stamina)) * 0.6);         // tired legs mistime the tackle (+60% at empty; no-op fresh)
        // A deliberate cynical foul IS the foul — he means to bring the man down.
        if(cynical) foulChance = CYNICAL_FOUL_PROB;
        // A booked player plays it safe — fewer reckless AND cynical fouls, so second
        // yellows (and the resulting reds) drop toward real rates. A booked last man
        // knows a second foul = off, so he's far more careful even when tempted to
        // cynically pull the man down. (SysArch 2026-06-30: reds measured ~0.60/match
        // ≈ 2.4× real ~0.25 — the booked-CYNICAL path was bypassing this damping.)
        if(yellowCards[tackler.id]>=1)foulChance*=0.38;   // booked → VERY careful (now incl. cynical: trims second-yellow reds)
        if(rng.random()<foulChance){
            stats.recordTackleFoul();
            if(cynical) stats.recordTacticalFoul();
            double foulX = carrier.x;
            double foulY = carrier.y;
            emitEvent("foul", foulX, foulY, tackler.id, carrier.id);
            // Bookings: reckless (from-behind) fouls risk a card. A second
            // yellow — or a straight red for a wild challenge — sends him off.
            // Tuned for ~3-4 yellows and ~0.25 reds per match (real-world).
            // Card-per-foul was ~32% (≈2× real ~17%): a foul fired a card far too
            // often, so raising fouls toward real exploded yellows/reds. Lowered to
            // calibrate cards to the higher foul volume (cynical fouls stay bookable).
            double cardChance = cynical ? CYNICAL_CARD : (fromBehind ? 0.20 : 0.055);   // SysArch 2026-06-30: yellows measured ~5.5/match (≈1.5× real 3-4) → trim 0.28/0.075 → 0.20/0.055
            // A booked player's borderline SECOND foul: a real ref usually warns
            // rather than firing the automatic second yellow. Second-yellow reds were
            // measured ~0.62/match (≈2.5× real ~0.25), piled up in chippy high-yellow
            // games — trimming the average never tamed that tail; this does. (A cynical
            // second foul stays bookable — he meant it.)
            if (yellowCards[tackler.id] >= 1 && !cynical) cardChance *= 0.45;
            bool straightRed = fromBehind && rng.random() < 0.0032;   // reds measured ~0.60 ≈ 2.4× real → 0.005->0.0032
            if (straightRed || rng.random() < cardChance) {
                if (!straightRed) {
                    yellowCards[tackler.id]++;
                    stats.recordYellowCard();
                    emitEvent("yellow", foulX, foulY, tackler.id, carrier.id);
                }
                if (straightRed || yellowCards[tackler.id] >= 2) {
                    sendOff(tackler);
                    emitEvent("red", foulX, foulY, tackler.id, carrier.id);
                }
            }
            // A hard (from-behind) foul can leave the fouled player hurt — a
            // knock that scales down his pace until it fades, and makes him a
            // substitution candidate.
            // Injuries ran ~1.8/match (real ~0.3-0.6); trimmed to land mid-band ~0.4.
            double injChance = fromBehind ? 0.030 : 0.009;
            if (rng.random() < injChance) {
                carrier.injurySeverity = std::max(carrier.injurySeverity, 0.30 + rng.random() * 0.45);
                stats.recordInjury();
                emitEvent("injury", carrier.x, carrier.y, carrier.id);
            }
            // Advantage: if the fouled team is going forward in open play and
            // the carrier kept his feet, wave play on — the foul and any card
            // still count (shown now; banked till the next stoppage in reality).
            double attFd = fdFor(carrier.team);
            bool inAttackingHalf = attFd > 0 ? carrier.x > HALF_X : carrier.x < HALF_X;
            double defGoalX0 = ownGoalXFor(tackler.team);
            bool nearOppBox = std::abs(carrier.x - defGoalX0) < PENALTY_AREA_W * 1.4;
            if (inAttackingHalf && !nearOppBox && carrier.injurySeverity < 0.18 && rng.random() < 0.35) {
                emitEvent("advantage", foulX, foulY, carrier.id, tackler.id);
                advantage = {true, carrier.team, foulX, foulY, state.clockMs};   // recall if it fizzles
                blockReboundFor(tackler.id, 500);   // fouler can't re-lunge instantly
                return false;                         // carrier plays on
            }
            b.vx=b.vy=b.z=b.vz=0;
            b.controllerId=-1;
            b.intendedReceiverId=-1;
            b.lastTouchTeam=carrier.team; b.lastToucherId=carrier.id;
            lastLooseOrigin = LooseOrigin::None;
            blockReboundFor(tackler.id,650);
            double defendingGoalX = ownGoalXFor(tackler.team);
            double defendingFd = fdFor(tackler.team);
            bool foulInBox = std::abs(foulX - defendingGoalX) < PENALTY_AREA_W
                && std::abs(foulY - PITCH_H / 2.0) < PENALTY_AREA_H / 2.0;
            if (foulInBox) {
                b.x = defendingGoalX + defendingFd * PENALTY_SPOT_FROM_GOAL;
                b.y = PITCH_H / 2.0;
                stats.recordPenaltyAwarded();
                emitEvent("penalty", b.x, b.y, carrier.id);
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
    shot.clearFlags();
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    double angle=std::atan2(b.y-tackler.y,b.x-tackler.x)+(rng.random()-0.5)*0.9;
    double outcomeRoll=rng.random();
    double controlChance=clamp(0.28+tackleSkill*0.35-carrierControl*0.18
        -(fromBehind?0.20:0)+(approachDot>0.15?0.12:0)
        -(carrier.dribbleType==3?0.08:0)+(exposedToFacingTackler?0.04:0),0.12,0.74);
    if(outcomeRoll<controlChance){
        stats.recordTackleWin(true);
        if(tackler.id>=0&&tackler.id<22)pTackles[tackler.id]++;
        emitEvent("tackle_won", (tackler.x+carrier.x)/2.0, (tackler.y+carrier.y)/2.0, tackler.id, carrier.id);
        b.controllerId=tackler.id;
        b.vx=b.vy=b.z=b.vz=0;
        b.curl=0;
        b.lastTouchTeam=tackler.team; b.lastToucherId=tackler.id;
        b.intendedReceiverId=-1;
        receiverShieldUntil=state.clockMs+260;
        receiverShieldedPlayerId=tackler.id;
        lastLooseOrigin = LooseOrigin::None;
        blockReboundFor(carrier.id,450);
        carrier.vx=carrier.vy=0;
        return true;
    }
    // Carry security — the carrier BEATS the man and keeps it. This outcome was
    // MISSING: every committed challenge used to dispossess (won OR spilled loose),
    // so possession churned ~2.4x too often (~390 strips/match, no 20+ build-up).
    // A good carrier (control/dribble/shield, harder still from behind) rides the
    // tackle and plays on; the beaten defender is briefly off-balance.
    double retainChance=clamp(carrierControl*0.6+(carrier.dribbleType==3?0.12:0.0)
        +(carrierShielded?0.18:0.0)+(fromBehind?0.10:0.0)-tackleSkill*0.15,0.0,0.60);
    if(rng.random()<retainChance){
        emitEvent("skill",carrier.x,carrier.y,carrier.id,tackler.id);
        blockReboundFor(tackler.id,520);
        agentFor(tackler)->stunLock(12);
        return false;
    }
    stats.recordTackleWin(false);
    if(tackler.id>=0&&tackler.id<22)pTackles[tackler.id]++;   // a loose-deflection win is still a tackle won by this player (mirrors the clean-win branch); was omitted, under-counting per-player tackles ~46%
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
    lastLooseOrigin = LooseOrigin::TackleDeflection;
    recordBallImpulse();
    blockReboundFor(tackler.id,250);
    blockReboundFor(carrier.id,450);
    carrier.vx=carrier.vy=0;
    return true;
}

void GameEngine::shootBall(Player&s,const ShotSelectionAudit* selectionAudit){
    emitEvent("shot", s.x, s.y, s.id);
    if(s.id>=0&&s.id<22)pShots[s.id]++;
    if(goalKickMonitor.active&&s.team!=goalKickMonitor.team){
        stats.recordGoalKickTrappedShot();
        goalKickMonitor.active=false;
    }
    stats.recordShot(s.team, false, s.role);
    bool dribble20mShot = carrierTracker.carryTrackerId == s.id && carrierTracker.carryPathDistance >= 200.0;
    if (dribble20mShot) stats.recordDribble20mShot();
    double gx=goalXFor(s.team);
    // Fatigue: a tired finish is less accurate — accuracy scales with the tank.
    // Feeds executionError via (1-accuracy)*SHOT_ERROR_SKILL below, so a tired
    // shooter sprays more. No-op at full stamina.
    double accuracy=attrFactor(s.attrs.shooting)*staminaFrac(s.stamina);
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
            if(o.team==s.team||o.role==Role::GK||o.sentOff)continue;
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
    double roleError = agentFor(s)->shotRoleError(freshCross, shotDistance);
    double executionError=SHOT_ERROR_BASE+(1-accuracy)*SHOT_ERROR_SKILL+pressureCount*(freshCross?SHOT_ERROR_PRESSURE_CROSS:SHOT_ERROR_PRESSURE_NORMAL)+closePressure+laneBlockers*(freshCross?SHOT_ERROR_LANE_CROSS:SHOT_ERROR_LANE_NORMAL)
        +anglePenalty*SHOT_ERROR_ANGLE+distancePenalty*SHOT_ERROR_DISTANCE+longRangePenalty*SHOT_ERROR_LONG_RANGE;
    executionError=std::max(SHOT_ERROR_FLOOR,executionError+roleError);
    bool credibleFinish=angleDeg>9.0&&shotDistance<200.0&&pressureCount<=2&&laneBlockers<=1;
    bool freshThrough=s.throughCollected>0.0&&shotDistance<245.0;
    // First-time foot finish off a low cross: struck clean and FLAT (not a
    // header, so shot.header stays false), with a tight error band — the whole
    // point is to turn a swept low cross into an on-target chance.
    bool firstTouch=s.firstTouchFinish>0.0&&shotDistance<235.0;
    bool directFreeKickShot=setPiece.type==SetPiece::FreeKick;
    // Dead ball, no pressure, twelve yards: penalty execution is near-pure
    // placement. Without this the open-play error model sprayed pens wide.
    bool penaltyKick=setPiece.type==SetPiece::Penalty;
    if(credibleFinish)executionError*=shotDistance<95.0?0.46:0.56;
    if(directFreeKickShot)executionError*=0.62;   // §FK: less clinical than the old 0.48 — the curl-around-wall + open-corner aim were over-converting (goal-inflation); target ~1-in-12-15
    if(penaltyKick)executionError*=0.30;
    if(freshThrough&&angleDeg>8.0&&pressureCount<=1)executionError*=shotDistance<170.0?0.72:0.82;
    if(freshCross)executionError*=s.role==Role::CF?0.46:(s.role==Role::WM?0.62:0.82);
    if(firstTouch)executionError*=shotDistance<120.0?0.50:0.62;
    // ── Shot type — pick HOW to beat the keeper and route to the physics.
    // 0 normal · 1 finesse (placement) · 2 power (pace) · 3 curl (bend round
    // him) · 4 chip (loop over an onrushing keeper). Set pieces, headers and
    // first-touch finishes keep their bespoke models untouched.
    Player* dgk=findGK(s.team==Team::Home?Team::Away:Team::Home);
    double gkY=dgk?dgk->y:goalCenterY;
    double gkAdvance=dgk?std::abs(dgk->x-gx):0.0;   // how far the keeper has come off his line
    int shotType=0;
    bool clearSight=pressureCount<=1&&laneBlockers==0;
    bool bespoke=penaltyKick||directFreeKickShot||freshCross||firstTouch||acuteGeometry;
    if(!bespoke){
        bool wideAngle=outsideGoalLane&&angleDeg>=7.0&&angleDeg<=22.0;
        // Keeper has rushed well off his line and the shooter is behind him with
        // a clear sight: dink it over his head into the empty net.
        bool keeperRushed=gkAdvance>72.0&&shotDistance>gkAdvance+50.0&&shotDistance<340.0&&angleDeg>10.0;
        if(keeperRushed&&clearSight) shotType=4;                                                    // chip
        else if(credibleFinish&&shotDistance<175.0&&pressureCount<=1&&accuracy>0.50) shotType=1;    // finesse
        else if(wideAngle&&shotDistance>=110.0&&shotDistance<=235.0&&clearSight) shotType=3;        // curl
        else if(clearSight&&shotDistance>=120.0&&shotDistance<=250.0&&accuracy>0.45) shotType=2;    // power
    }
    if(passDebug)fprintf(stderr,"SHOTTYPE t=%d dist=%d ang=%d pr=%d fk=%d lb=%d\n",shotType,(int)shotDistance,(int)angleDeg,pressureCount,directFreeKickShot?1:0,laneBlockers);
    // Placed shots (finesse/curl) aim for the corner the keeper is NOT shading;
    // the random side stays for instinctive/power strikes (keep the rng draw so
    // the deterministic stream count is unchanged — only the value moves).
    double openSide=(gkY>=goalCenterY?-1.0:1.0);
    double postAimScale=credibleFinish?0.92:1.0;
    // Aim composed open-play shots NEARER the post (over-conversion fix, audit #1:
    // onTarget ~4x real). The cause wasn't the keeper — the aim sat ~29px inside a
    // 36.5px frame, so the symmetric error spread could only stray wide on the post
    // side while the inner half always found the frame (~97% on-frame for a clean
    // finesse). Aiming to the post EDGE puts the post-ward half of the spread
    // genuinely wide — the only lateral lever that moves on-frame toward the real
    // ~34% (raising the spread alone saturates, since the aim is inside the frame).
    // LATERAL ONLY: loft is untouched, so the old beat-keeper-then-sail-over bug
    // can't revive. Penalty operand kept byte-identical — pens must stay clinical.
    double postFrac=penaltyKick?0.36+accuracy*0.07:(0.42+accuracy*0.18)*postAimScale;
    if(shotType==1) postFrac=0.47+accuracy*0.07;       // finesse: aim to the post edge so the spread starts straying wide
    else if(shotType==2) postFrac=0.42+accuracy*0.09;  // power: nearer the post (its larger *0.88 residual spread makes the shift bite)
    else if(shotType==3) postFrac=0.30+accuracy*0.06;  // curl: small nudge — the bend already carries it out toward the corner
    else if(shotType==4) postFrac=0.18+accuracy*0.06;  // chip: net is open with the keeper out — aim safely inside
    double postRoll=(rng.random()<0.5?-1.0:1.0);
    double postSide=(shotType||directFreeKickShot)?openSide:postRoll;  // deliberate types + a direct FK aim off the keeper (open corner), not a random post
    double aimedPost=postSide*GOAL_W*postFrac;
    // Composed strikes are struck cleaner than a snatched effort — tighten the
    // spread a little so they keep finding the frame, but not so far that the
    // off-centre aim starts spraying wide (that cost on-target last iteration).
    if(shotType) executionError*=(shotType==2?0.88:0.80);
    double goalY=goalCenterY+aimedPost+(rng.random()+rng.random()-1.0)*executionError;
    if(acuteGeometry){
        double nearPostSide=s.y<goalCenterY?-1.0:1.0;
        double nearPostY=goalCenterY+nearPostSide*GOAL_W/2;
        goalY=nearPostY - nearPostSide * (BALL_R + 7.0 + rng.random() * 16.0);
    }
    double missMargin = (directFreeKickShot || penaltyKick)
        ? clamp(5.0 + shotDistance * 0.012 + laneBlockers * 2.0, 7.0, 12.0)
        : clamp(9.0 + shotDistance * 0.030 + pressureCount * 3.0 + laneBlockers * 3.0, 14.0, 24.0);
    goalY = clamp(goalY, goalCenterY - GOAL_W / 2.0 - missMargin, goalCenterY + GOAL_W / 2.0 + missMargin);
    double dx=gx-s.x, dy=goalY-s.y;
    double d=std::hypot(dx,dy);
    // Headers redirect the cross's pace — box pressure costs them far less
    // power than it costs a wound-up foot shot.
    double speed=SHOT_SPEED_BASE+accuracy*118.0-pressureCount*(freshCross?10.0:24.0)
        -laneBlockers*(freshCross?13.0:28.0)-longRangePenalty*44+(credibleFinish?28.0:0.0);
    speed=std::max(185.0,speed);
    if(shotType==1) speed*=0.94;        // finesse: a touch off pace, mostly placement
    else if(shotType==2) speed*=1.15;   // power: blast it past him
    else if(shotType==3) speed*=0.96;   // curl: enough pace to hold the bend
    else if(shotType==4) speed=clamp(shotDistance*1.25,205.0,300.0);  // chip: gentle, judged pace
    speed=clamp(speed,185.0,455.0);     // stay inside the keeper-model's anchored band
    auto& b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(s,dx,dy);
    blockReboundFor(s.id,850);
    b.vx=dx/d*speed; b.vy=dy/d*speed;
    // Elevation. A clean chance is struck down and flat; a rushed, long, or
    // poorly-hit one leans back and rises — sometimes onto the bar, sometimes
    // sailing over. Clean credible finishes stay essentially on the deck.
    double loft=0.0;
    if(!penaltyKick&&!directFreeKickShot&&!freshCross&&!firstTouch){
        if(!credibleFinish)loft+=26.0;
        loft+=pressureCount*20.0;
        loft+=longRangePenalty*55.0;
        loft+=(1.0-accuracy)*70.0;
        loft*=0.5+rng.random();   // 0.5x..1.5x: some balloon over, some kept down
        loft=std::min(loft,240.0);
    }
    // Finesse and power are struck DOWN — a placed side-foot or a driven laces
    // shot stays under the bar. Without this the loft model floated them over
    // the frame, so they beat the keeper's save roll yet sailed the goal (the
    // conversion gap the save-roll probe exposed). On the deck = on frame.
    if(shotType==1||shotType==2) loft=std::min(loft,10.0);
    // Curl: give it just enough air to keep the spin alive (curl dies fast on
    // the deck) and bend it toward the open corner — a bent flight the keeper,
    // who reads a straight line, mis-sets for (see engine_gk deception term).
    if(shotType==3){
        loft=clamp(loft,45.0,85.0);   // a little air so the spin lives, but down by the line
        double vxSign=(dx>=0.0?1.0:-1.0);
        b.curl=openSide*vxSign*(0.12+accuracy*0.08);   // bend enough to round the keeper, not so far it sails the post
    }
    // Chip: loft sized so the parabola loops OVER the advanced keeper and is just
    // descending through the frame at the line. vz≈0.5·g·t (lands at the line)
    // ×1.08 so it crosses a hair above the deck, not bouncing short of it.
    if(shotType==4) loft=clamp(0.5*GRAVITY*(d/std::max(speed,1.0))*1.08,150.0,340.0);
    b.intendedReceiverId=-1; b.z=0; b.vz=loft;
    // Direct free kick with a wall: CHIP it over, don't blast it through.
    // The old vz=speed*0.50 was tuned for ~470px/s shots; with realistic
    // ~210px/s shot pace the lift only reached ~1m (z=10), BELOW the 20px
    // aerial-clearance height, so the ball flew flat THROUGH the wall. Cap the
    // pace to a chippable speed and loft it so the peak clears the wall
    // (>AERIAL_HEIGHT) yet dips back under the bar by the goal line.
    if(directFreeKickShot&&laneBlockers>=1){
        double fkSpeed=std::min(speed,250.0);
        b.vx=dx/d*fkSpeed; b.vy=dy/d*fkSpeed;
        double vxSign=(dx>=0.0?1.0:-1.0);
        // §FK variety (Commit 2): ~30% a FLOATED DIPPER — lobbed higher over the wall (parabola peaks
        // well clear, distance-sized loft so it dips under the bar by the line) with LESS curl; else the
        // §FK curl-around-the-wall default (Commit 1, Beckham): the chip lofts it (z>2 so the spin
        // SUSTAINS, curl decays slow airborne per engine_physics:57) and bends it toward the open corner.
        // Choice via a deterministic shooter+clock HASH (NOT a main-rng draw) so it doesn't shift the
        // match's rng sequence -> a CLEAN paired comparison vs the curl-only baseline + replay-stable.
        bool fkDipper = ((static_cast<uint32_t>(s.id) * 48271u + static_cast<uint32_t>(state.clockMs)) % 100u < 18u) && shotDistance < 235.0;   // ~18% (a special occasional shot, not a third of FKs — the floated dipper over-converts vs the curler, +0.29 at 30%; keep it a small variety)
        if(fkDipper){
            b.vz=clamp(0.5*GRAVITY*(d/std::max(fkSpeed,1.0))*1.05,170.0,330.0);
            b.curl=openSide*vxSign*(0.10+accuracy*0.07);
        } else {
            b.vz=std::max(fkSpeed*0.72,150.0);
            b.curl=openSide*vxSign*(0.20+accuracy*0.15);
        }
    }
    b.lastTouchTeam=s.team; b.lastToucherId=s.id;
    metrics.shotLaunchSpeedTotal+=speed; metrics.shotLaunchCount++;
    stats.recordShotLaunch(speed);
    recordBallImpulse();
    pendingPass.active=false;
    lastLooseOrigin = LooseOrigin::Shot;
    pendingSave.active=false;   // a fresh shot supersedes any in-flight save
    receiverShieldTargetId=-1;
    shot.active=true; shot.tracked=true; shot.preventable=false; shot.header=freshCross; shot.dribble20m=dribble20mShot; shot.team=s.team; shot.shooterId=s.id; shot.originX=s.x; shot.originY=s.y;
    shot.freshFinish = firstTouch || freshCross || freshThrough;   // snap finish — wrong-foots the keeper (engine_gk reaction)
    shot.type = shotType;   // carried to the save roll for the per-type probe (debug only)
    // ── Explicit shot-block roll: each defender in the lane gets ONE
    // deliberate, skill-based chance (squareness in lane x reaction time x
    // tackling). The winner is the only body allowed to touch the flight;
    // a shot that survives every roll is committed past the crowd.
    shot.blockerId=-1;
    // A penalty beaten by the dive shouldn't be casually scooped on the line.
    shot.scoopAllowed=rng.random()<(penaltyKick?PENALTY_SCOOP_CHANCE:SHOT_SCOOP_CHANCE);
    if(!penaltyKick){
        double ndx=dx/d, ndy=dy/d;
        for(auto& o:state.players){
            if(o.team==s.team||o.role==Role::GK||o.sentOff)continue;
            double ox=o.x-s.x, oy=o.y-s.y;
            double along=ox*ndx+oy*ndy;
            if(along<14.0||along>d*0.94)continue;
            double perp=std::abs(ox*ndy-oy*ndx);
            double reachR=PLAYER_R+BALL_R+11.0;   // throw a body/leg across the lane
            if(perp>reachR)continue;
            double inLine=1.0-perp/reachR;
            double reactFactor=clamp(along/90.0,0.25,1.0);
            double chance=clamp((0.21+attrFactor(o.attrs.tackling)*0.36)*inLine*reactFactor,0.03,0.62);
            if(rng.random()<chance){shot.blockerId=o.id;break;}
        }
    }
    // Consume the first-time-finish flags now the shot has used them: they otherwise
    // decay over 900-1400ms, so a SAME-player rebound shot inside that window would
    // wrongly re-apply the header/first-touch error reduction (and re-count the shot).
    s.crossCollected = 0.0; s.firstTouchFinish = 0.0; s.throughCollected = 0.0;
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
        if (opponent.team == carrier.team || opponent.role == Role::GK || opponent.sentOff) continue;
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
    lastLooseOrigin = LooseOrigin::KnockAhead;
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


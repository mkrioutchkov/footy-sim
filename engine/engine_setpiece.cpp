#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Offside helpers
// ══════════════════════════════════════════════════════════════

// Offside line: the second-last opponent INCLUDING the goalkeeper (the law).
// With the keeper home this is the deepest outfield defender; excluding the GK
// here made the line one defender too tight and ruled out legal deep runs.
double GameEngine::offsideLineFor(Team t) const {
    const double fd = fdFor(t);
    const Player* d1=nullptr,*d2=nullptr;
    double v1=-1e9, v2=-1e9;
    for(auto&p:state.players){
        if(p.team==t||p.sentOff)continue;   // a parked sent-off defender must not set the offside line
        double v=p.x*fd;
        if(v>v1){v2=v1;d2=d1;v1=v;d1=&p;}
        else if(v>v2){v2=v;d2=&p;}
    }
    if(d2)return d2->x;
    return d1 ? d1->x : (t==Team::Home?0.0:PITCH_W);
}

// Opponent midfield line: the average x of the opponent's central midfielders (the top of the pocket
// for drift_into_pocket). Mirrors offsideLineFor's skip-t (we read the OPPONENT's CMs, not our own).
double GameEngine::midlineFor(Team t) const {
    double sum=0.0; int n=0;
    for(auto&p:state.players){
        if(p.team==t||p.sentOff||p.role!=Role::CM)continue;
        sum+=p.x; n++;
    }
    return n>0 ? sum/n : HALF_X;   // fallback: opp has no central midfielders
}

bool GameEngine::checkOffside(const Player& receiver, const Player& passer) const {
    const double fd = fdFor(passer.team);
    if(fd==1){if(receiver.x<=HALF_X||receiver.x<=passer.x+OFFSIDE_TOLERANCE)return false;}
    else{if(receiver.x>=HALF_X||receiver.x>=passer.x-OFFSIDE_TOLERANCE)return false;}
    const double line=offsideLineFor(passer.team);
    return fd==1 ? receiver.x>line+OFFSIDE_TOLERANCE : receiver.x<line-OFFSIDE_TOLERANCE;
}

void GameEngine::awardOffsideFreeKick(Team defTeam, const Player& offsidePlayer) {
    auto& b=state.ball;
    b.x=clamp(offsidePlayer.x,20.0,PITCH_W-20);
    b.y=clamp(offsidePlayer.y,20.0,PITCH_H-20);
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1; b.intendedReceiverId=-1;
    receiverShieldTargetId=-1;
    setPiece.type=SetPiece::FreeKick; setPiece.team = defTeam; setPiece.armed=true;
    setPiece.reason="offside";
    phase.actionTimer=5000;
    setPiece.spotX=b.x; setPiece.spotY=b.y;
    setPiece.takerArrived=false;
    Player* best = findNearestOutfieldPlayer(defTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;
}

bool GameEngine::isOffsideTarget(const Player& passer, const Player& receiver) const {
    return checkOffside(receiver, passer);
}

// Passers don't carry a linesman's flag: they reject only CLEARLY offside
// targets (a ~6px margin beyond the line). Marginal runs get played — and
// the whistle, judged exactly, sometimes catches them. Without this the AI
// filter was rule-perfect and zero offsides occurred in six hours of play.
bool GameEngine::isOffsideTargetPerceived(const Player& passer, const Player& receiver) const {
    const double fd = fdFor(passer.team);
    if (fd == 1) { if (receiver.x <= HALF_X || receiver.x <= passer.x + OFFSIDE_TOLERANCE) return false; }
    else { if (receiver.x >= HALF_X || receiver.x >= passer.x - OFFSIDE_TOLERANCE) return false; }
    const double line = offsideLineFor(passer.team);
    // The passer judges by eye, not a linesman's flag — he'll thread a ball
    // to a runner up to ~18px beyond the line believing him onside, so a
    // mistimed run (6-18px offside) actually gets flagged. An 11px margin left
    // only a 5px window above the 6px whistle tolerance, so offsides never
    // happened despite attackers logging ~50s/match in offside positions.
    const double margin = 18.0;
    return fd == 1 ? receiver.x > line + margin : receiver.x < line - margin;
}

// ══════════════════════════════════════════════════════════════
// Set pieces — kickoff tap, release, throw-in, goal kick
// ══════════════════════════════════════════════════════════════

void GameEngine::kickoffTap(){
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    double fd=fdFor(holder->team);
    // Pick the SAFEST outlet, not a random CM fired into the congested centre
    // circle: a clear lane (no opponent to cut it out) + an open receiver,
    // preferring a short ball backward/sideways into space. A kickoff should
    // retain possession — the old random-CM ball was intercepted ~90% of the
    // time and looked awful. (Deterministic: the rng draw it replaced is gone.)
    Player* best=nullptr; double bestScore=-1e9;
    for(auto&t:state.players){
        if(t.team!=holder->team||t.id==holder->id||t.role==Role::GK||t.sentOff)continue;
        double dx=t.x-holder->x,dy=t.y-holder->y,d=std::hypot(dx,dy);
        if(d<28.0||d>320.0)continue;
        double ls=dx*dx+dy*dy; if(ls<1.0)continue;
        double nearOpp=1e9; bool laneBlocked=false;
        for(auto&o:state.players){
            if(o.team==holder->team||o.role==Role::GK||o.sentOff)continue;
            nearOpp=std::min(nearOpp,dist(o.x,o.y,t.x,t.y));
            double tt=clamp(((o.x-holder->x)*dx+(o.y-holder->y)*dy)/ls,0.0,1.0);
            double perp=std::hypot(o.x-holder->x-tt*dx,o.y-holder->y-tt*dy);
            if(perp<34.0&&tt>0.05)laneBlocked=true;
        }
        if(laneBlocked||nearOpp<40.0)continue;          // never thread it past a marker / to a marked man
        double backward=(holder->x-t.x)*fd;             // + = toward own goal (the safe ball)
        double score=nearOpp+std::max(0.0,backward)*0.5-d*0.25;
        if(score>bestScore){bestScore=score;best=&t;}
    }
    if(!best)for(auto&p:state.players)if(p.team==holder->team&&p.id!=holder->id&&p.role==Role::CM){best=&p;break;}
    if(!best)return;
    Player& target=*best;
    double dx=target.x-holder->x,dy=target.y-holder->y,rawDist=std::hypot(dx,dy);
    if(rawDist<1)return;
    double speed=clamp(140.0+rawDist*0.35,150.0,235.0);  // firm, flat, controllable
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
    // Clear throw-in support coordination
    for (auto& bb : blackboards) bb.throwInSupport = {};
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    auto clearReleasedSetPiece=[&](){
        if(!setPiece.armed){setPiece.type = SetPiece::None;setPiece.team = Team::Home;setPiece.reason.clear();}
    };
    // Clear setPieceHold for all agents
    for(auto&a:agents) a->setPieceHold=false;
    if(setPiece.type == SetPiece::Corner){
        releaseCornerKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPiece.type == SetPiece::ThrowIn){
        releaseThrowIn(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPiece.type == SetPiece::GoalKick){
        releaseGoalKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPiece.type == SetPiece::Penalty){
        stats.recordPenaltyTaken();
        shot.penalty=true;
        shootBall(*holder,nullptr);
        clearReleasedSetPiece();
        return;
    }
    if(holder->role==Role::GK){
        releaseGoalkeeperDistribution(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPiece.type == SetPiece::FreeKick){
        double gx=goalXFor(holder->team);
        double gy=PITCH_H/2.0;
        double shotDist=std::hypot(gx-holder->x,gy-holder->y);
        double angleDeg=goalOpeningAngleDeg(holder->x,holder->y,gx);
        int laneBlockers = countLaneBlockers(state.players, holder->x, holder->y, gx, gy, holder->team, BLOCKER_PERP_FREEKICK, 0.06, 0.90);
        bool central=std::abs(holder->y-gy)<170.0;
        // A defensive wall is normal for a direct free kick — don't veto on it.
        // §FK: a defensive WALL is EXPECTED on a central direct free kick — it must NOT veto the
        // shot (that left FKs "too few"). The curl-around-the-wall shot (shootBall) beats it, so only
        // EXCESS blockers beyond the ~3-man wall suppress; base chance raised so 10-28m central FKs fire.
        bool credibleShot=shotDist>105.0&&shotDist<300.0&&central&&angleDeg>5.5;
        double shotChance=clamp(0.40+(300.0-shotDist)/300.0+angleDeg/95.0-std::max(0.0,laneBlockers-3.0)*0.12,0.22,0.72);
        if(credibleShot&&rng.random()<shotChance){
            shootBall(*holder,nullptr);
            clearReleasedSetPiece();
            return;
        }
    }
    // §FK Commit 3: a WIDE/DEEP direct FK that wasn't shot is a CROSS, not a CM/FB reset — whip it
    // to the TALLEST attacker in the box for a header. Mirrors the corner cross (~570 this file):
    // applyWhipDelivery + beginTrackedPass(isCross=true) arms the freshCross header (the isCross flag
    // is load-bearing; leave lastLooseOrigin alone). Target = max attrs.height in the box (deterministic
    // argmax, no rng in the choice). Likely the CF — a tall CB isn't in the box (positioning stays back).
    if(setPiece.type == SetPiece::FreeKick){
        double gx2=goalXFor(holder->team), gy2=PITCH_H/2.0;
        double fkDist=std::hypot(gx2-holder->x, gy2-holder->y);
        bool wideFK=std::abs(holder->y-gy2)>120.0;
        if(wideFK && fkDist>250.0 && fkDist<560.0){
            Player* tgt=nullptr; double best=-1e9;
            for(auto&p:state.players){
                if(p.team!=holder->team||p.id==holder->id||p.role==Role::GK||p.sentOff)continue;
                if(std::abs(p.x-gx2)>180.0||std::abs(p.y-gy2)>200.0)continue;   // in the box
                double sc=p.attrs.height+(180.0-std::abs(p.y-gy2))*0.02;        // tallest, central tiebreak
                if(sc>best){best=sc; tgt=&p;}
            }
            if(tgt){
                double tx=gx2+(holder->team==Team::Home?-1.0:1.0)*85.0;
                double ty=lerp(tgt->y,gy2,0.55);
                double dx=tx-holder->x, dy=ty-holder->y, d=std::hypot(dx,dy);
                if(d>1.0){
                    double speed=clamp(300.0+d*0.30,330.0,380.0);
                    auto&b=state.ball;
                    b.controllerId=-1;
                    placeBallForRelease(*holder,dx,dy);
                    blockReboundFor(holder->id,900);
                    b.lastTouchTeam=holder->team; b.lastToucherId=holder->id;
                    b.vx=dx/d*speed; b.vy=dy/d*speed; b.z=0;
                    applyWhipDelivery(d,speed,gx2,CROSS_CURL_MIN,CROSS_CURL_RANGE);
                    b.intendedReceiverId=tgt->id;
                    receiverShieldTargetId=tgt->id;
                    stats.recordCrossAttempt(holder->team==Team::Home);
                    beginTrackedPass(*holder,*tgt,true);
                    clearReleasedSetPiece();
                    return;
                }
            }
        }
    }
    SmallVector<Player*, 11> targets;
    for(auto&p:state.players){
        if(p.team!=holder->team||p.id==holder->id||p.role==Role::GK)continue;
        if(setPiece.type == SetPiece::FreeKick&&dist(holder->x,holder->y,p.x,p.y)<55.0)continue;
        targets.push_back(&p);
    }
    std::sort(targets.begin(),targets.end(),[&](const Player* a,const Player* b){
        auto scoreTarget=[&](const Player* p){
            double fd = fdFor(holder->team);
            double d=dist(holder->x,holder->y,p->x,p->y);
            double progress=(p->x-holder->x)*fd;
            double width=std::abs(p->y-PITCH_H/2.0);
            double closestOpp = 1e9;
            for(auto& o:state.players){
                if(o.team==holder->team||o.role==Role::GK)continue;
                closestOpp=std::min(closestOpp,dist(o.x,o.y,p->x,p->y));
            }
            int laneBlockers = countLaneBlockers(state.players, holder->x, holder->y, p->x, p->y, holder->team, PASS_BLOCKER_PERP_OUTLET, 0.12, 0.92);
            if(setPiece.type == SetPiece::FreeKick){
                double holderShotDist=std::hypot(goalXFor(holder->team)-holder->x,PITCH_H/2.0-holder->y);
                double distanceFit=1.0-std::abs(d-145.0)/210.0;
                double pressureScore=clamp((closestOpp-35.0)/95.0,-0.60,0.75);
                double resetBonus=progress<-25.0?0.55:std::abs(progress)<45.0?0.30:-0.18;
                // In shooting range, recycling backward wastes the set piece.
                if(holderShotDist<320.0&&resetBonus>0.0)resetBonus*=0.25;
                double roleBonus=p->role==Role::CM?0.24:p->role==Role::FB?0.20:p->role==Role::CB?0.16:p->role==Role::WM?0.06:p->role==Role::CF?-0.16:0.0;
                double centerSupport=1.0-std::abs(p->y-PITCH_H/2.0)/PITCH_H;
                return distanceFit+pressureScore+resetBonus+roleBonus+centerSupport*0.22-laneBlockers*0.70;
            }
            double distanceFit=1.0-std::abs(d-210.0)/260.0;
            double roleBonus=p->role==Role::WM?0.22:p->role==Role::CF?0.16:p->role==Role::CM?0.08:p->role==Role::FB?0.04:-0.08;
            return distanceFit+clamp(progress/260.0,-0.25,0.42)+width/520.0+roleBonus-laneBlockers*0.30;
        };
        return scoreTarget(a)>scoreTarget(b);
    });
    for(Player* target:targets){
        if(passBallTo(*holder,*target,false,false,nullptr)){clearReleasedSetPiece();return;}
    }
    setPiece.armed=true;
    phase.actionTimer=250;
}

void GameEngine::releaseGoalKick(Player& holder){
    if(holder.role!=Role::GK)return;
    double fd = fdFor(holder.team);
    double ownGoalX=ownGoalXFor(holder.team);
    // Modern short goal kick: if a defender is open with a clean lane, roll it to
    // him (secure — fast, accurate) instead of hoofing it 50/50. The 2019 rule
    // lets the ball be received inside the area. Falls through to the long kick
    // below when no safe short option exists. A play-it-long team skips this and
    // launches it (distribution tactic).
    double gkLongBias=longBallBias[holder.team==Team::Home?0:1];
    if(!(gkLongBias>0.0&&rng.random()<gkLongBias)){
        Player* sp=nullptr; double bestSafe=-1e9;
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
            double d=dist(holder.x,holder.y,p.x,p.y);
            if(d<60.0||d>300.0)continue;
            double nearestOpp=1e9;
            for(auto& o:state.players){
                if(o.team==holder.team||o.role==Role::GK||o.sentOff)continue;
                nearestOpp=std::min(nearestOpp,dist(o.x,o.y,p.x,p.y));
            }
            if(nearestOpp<=42.0)continue;
            if(countLaneBlockers(state.players,holder.x,holder.y,p.x,p.y,holder.team,BLOCKER_PERP_GK_DIST,0.12,0.92)!=0)continue;
            double progress=(p.x-ownGoalX)*fd;
            double score=progress*0.30-d*0.20+(p.role==Role::FB?40.0:p.role==Role::CB?22.0:0.0);
            if(score>bestSafe){bestSafe=score;sp=&p;}
        }
        if(sp&&passBallTo(holder,*sp,false,false,nullptr,/*secure=*/true)){
            goalKickMonitor.active=true;goalKickMonitor.team=holder.team;goalKickMonitor.startedMs=state.clockMs;
            stats.recordGoalKickAttempt();goalKickMonitor.distributeTimer=0;
            return;
        }
    }
    Player* outlet=nullptr;
    double best=-1e9;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
        double progress=(p.x-ownGoalX)*fd;
        if(progress<430.0)continue;
        double lane=std::abs(p.y-PITCH_H/2.0);
        double roleBonus=p.role==Role::CF?150.0:p.role==Role::WM?125.0:p.role==Role::FB?25.0:0.0;
        double pressurePenalty=0.0;
        for(auto& o:state.players){
            if(o.team==holder.team||o.role==Role::GK||o.sentOff)continue;
            double od=dist(o.x,o.y,p.x,p.y);
            if(od<90.0)pressurePenalty+=(90.0-od)*0.65;
        }
        double score=progress*0.32+lane*0.20+roleBonus-pressurePenalty;
        if(score>best){best=score;outlet=&p;}
    }
    if(!outlet){
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
            double progress=(p.x-ownGoalX)*fd;
            double score=progress+(p.role==Role::CF?100.0:p.role==Role::WM?80.0:0.0);
            if(score>best){best=score;outlet=&p;}
        }
    }

    double targetX=outlet?outlet->x:clamp(holder.x+fd*575.0,45.0,PITCH_W-45.0);
    double targetY=outlet?outlet->y:clamp(PITCH_H/2.0+(rng.random()<0.5?-170.0:170.0),55.0,PITCH_H-55.0);
    targetX=clamp(targetX+fd*(35.0+rng.random()*55.0),45.0,PITCH_W-45.0);
    targetY=clamp(targetY+(rng.random()-0.5)*55.0,55.0,PITCH_H-55.0);

    double dx=targetX-holder.x,dy=targetY-holder.y;
    double d=std::max(1.0,std::hypot(dx,dy));
    if(d<500.0){
        targetX=clamp(holder.x+fd*560.0,45.0,PITCH_W-45.0);
        dx=targetX-holder.x; dy=targetY-holder.y; d=std::max(1.0,std::hypot(dx,dy));
    }
    auto& b=state.ball;
    b.controllerId=-1;
    placeBallForRelease(holder,dx,dy);
    b.lastTouchTeam=holder.team;
    b.lastToucherId=holder.id;
    double speed=315.0+clamp(d-500.0,0.0,180.0)*0.16;
    b.vx=dx/d*speed;
    b.vy=dy/d*speed;
    b.vz=315.0;
    b.z=30.0;
    b.intendedReceiverId=outlet?outlet->id:-1;
    receiverShieldTargetId=b.intendedReceiverId;
    blockReboundFor(holder.id,900);
    pendingPass.active=false;
    if(outlet)beginTrackedPass(holder,*outlet,false);
    emitEvent("pass", holder.x, holder.y, holder.id, outlet?outlet->id:-1);
    goalKickMonitor.active=true;
    goalKickMonitor.team=holder.team;
    goalKickMonitor.startedMs=state.clockMs;
    stats.recordGoalKickAttempt();
    goalKickMonitor.distributeTimer=0;
}

void GameEngine::releaseGoalkeeperDistribution(Player& holder){
    double fd = fdFor(holder.team);
    double ownGoalX=ownGoalXFor(holder.team);
    bool wasGoalKick=setPiece.type == SetPiece::GoalKick;
    double nearestKeeperPressure=1e9;
    int closeKeeperPressure=0;
    Player* nearestPress=nullptr;
    for(auto& o:state.players){
        if(o.team==holder.team||o.role==Role::GK||o.sentOff)continue;
        double od=dist(holder.x,holder.y,o.x,o.y);
        if(od<nearestKeeperPressure){nearestKeeperPressure=od;nearestPress=&o;}
        if(od<112.0)closeKeeperPressure++;
    }

    auto puntLong=[&](){
        Player* outlet=nullptr;
        double best=-1e9;
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
            double progress=(p.x-ownGoalX)*fd;
            double wide=std::abs(p.y-PITCH_H/2.0);
            double roleBonus=p.role==Role::WM?85.0:p.role==Role::CF?70.0:p.role==Role::FB?35.0:0.0;
            double score=progress+wide*0.28+roleBonus;
            if(score>best){best=score;outlet=&p;}
        }
        double targetX=clamp(holder.x+fd*575.0,45.0,PITCH_W-45.0);
        double targetY=outlet?outlet->y:(nearestPress?(nearestPress->y<PITCH_H/2.0?PITCH_H*0.72:PITCH_H*0.28):holder.y);
        targetY=clamp(targetY,55.0,PITCH_H-55.0);
        double dx=targetX-holder.x,dy=targetY-holder.y;
        double d=std::max(1.0,std::hypot(dx,dy));
        auto& b=state.ball;
        b.controllerId=-1;
        placeBallForRelease(holder,dx,dy);
        b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
        b.vx=dx/d*330.0; b.vy=dy/d*330.0; b.vz=300.0; b.z=28.0;
        b.intendedReceiverId=-1;
        emitEvent("pass", holder.x, holder.y, holder.id, outlet?outlet->id:-1);   // tag the GK long distribution (audit #6)
        blockReboundFor(holder.id,750);
        if(wasGoalKick){
            goalKickMonitor.active=true;
            goalKickMonitor.team=holder.team;
            goalKickMonitor.startedMs=state.clockMs;
            stats.recordGoalKickAttempt();
        }
        goalKickMonitor.distributeTimer=0;
    };

    // Distribution tactic: a team told to play it long sends its keeper long too
    // (probabilistic by the bias). Possession sides (bias 0 — the default) skip
    // this entirely and play out short-safe below.
    double gkLongBias=longBallBias[holder.team==Team::Home?0:1];
    if(gkLongBias>0.0&&rng.random()<gkLongBias){puntLong();return;}

    // ── Safety-first distribution: a keeper should keep the ball, not gift it.
    // Find the safest open outlet (clear passing lane, sensible range) and roll
    // it there; only hoof long when genuinely swarmed with no clear lane at all.
    // The old code punted on the faintest pressure (<115px / 2 close) and rated
    // short passes by PROGRESS, so distribution completed only ~60%. This defaults
    // to a short, safe ball — targeting 95%+ completion. Short goal kicks to an
    // open defender are allowed (the 2019 rule lets the ball be received in-area).
    struct GkOutlet { Player* p; double score; bool safe; };
    SmallVector<GkOutlet, 11> outs;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<60.0||d>520.0)continue;
        double progress=(p.x-ownGoalX)*fd;
        if(progress<-30.0)continue;                       // never play it back across your own line
        double nearestOpp=1e9;
        for(auto& o:state.players){
            if(o.team==holder.team||o.role==Role::GK||o.sentOff)continue;
            nearestOpp=std::min(nearestOpp,dist(o.x,o.y,p.x,p.y));
        }
        int laneBlockers=countLaneBlockers(state.players,holder.x,holder.y,p.x,p.y,holder.team,BLOCKER_PERP_GK_DIST,0.12,0.92);
        bool clearLane=laneBlockers==0;
        // "Safe" = near-certain to complete: a clean lane, a reasonably open
        // receiver, a short-to-mid ball. The keeper releases only on these and
        // otherwise HOLDS (he can't be tackled — attemptTackle bails on a GK
        // carrier — so waiting for a lane costs nothing and never gifts it).
        bool safe=clearLane&&nearestOpp>40.0&&d<320.0;
        double roleBonus=p.role==Role::FB?0.30:p.role==Role::WM?0.20:p.role==Role::CM?0.16:p.role==Role::CB?0.10:0.0;
        double openness=clamp(nearestOpp/90.0,0.0,1.0);
        double prox=1.0-clamp(d/520.0,0.0,1.0);           // shorter = safer
        double score=(clearLane?1.5:0.0)+openness*0.9+prox*0.5+roleBonus+progress/900.0*0.3;
        outs.push_back({&p,score,safe});
    }
    std::sort(outs.begin(),outs.end(),[](const GkOutlet& a,const GkOutlet& b){return a.score>b.score;});
    auto onRelease=[&](int toId){
        // Tag GK open-play distribution as a pass EVENT (audit #6: both keepers logged
        // 0 pass events because distribution calls passBallTo directly, bypassing the
        // agent path's emit at agent.cpp). Trace/probe only — the pass STAT is already
        // recorded inside passBallTo, so this changes no summary metric.
        emitEvent("pass", holder.x, holder.y, holder.id, toId);
        if(wasGoalKick){goalKickMonitor.active=true;goalKickMonitor.team=holder.team;goalKickMonitor.startedMs=state.clockMs;stats.recordGoalKickAttempt();}
        goalKickMonitor.distributeTimer=0;
    };
    // 1) Safest open outlet — a secure (fast, accurate) short roll that completes
    //    almost always.
    for(auto& o:outs){
        if(!o.safe)continue;
        if(passBallTo(holder,*o.p,false,false,nullptr,/*secure=*/true)){onRelease(o.p->id);return;}
    }
    // 2) No clean lane, and he's genuinely swarmed (a real high press, 3+ bodies
    //    on him) — holding achieves nothing, so clear it long. Prefer the best
    //    short outlet over a blind hoof; punt only if there's no one at all.
    if(closeKeeperPressure>=3){
        for(auto& o:outs){if(passBallTo(holder,*o.p,false,false,nullptr)){onRelease(o.p->id);return;}}
        puntLong();return;
    }
    // 3) Otherwise HOLD and wait for a lane to open rather than passing into
    //    traffic. The keeper can't be tackled while holding, so this costs nothing
    //    and is what lifts completion into the high-90s — he simply never gifts it.
    setPiece.armed=true;phase.actionTimer=250;            // hold the ball and retry shortly
    goalKickMonitor.distributeTimer=0;
}

void GameEngine::releaseThrowIn(Player& holder){
    SmallVector<RatedTarget, 11> targets;
    double fd = fdFor(holder.team);
    // USERWATCH C: a designated LONG-THROW taker in the attacking half hurls it INTO the box
    // (a flat, fast aerial delivery like a corner) instead of a short throw — the big-throw weapon.
    // Opt-in via the long_throw_taker directive => default teams (no taker) keep short throws => golden unchanged.
    bool attackingHalf = (fd > 0.0) ? holder.x > PITCH_W * 0.5 : holder.x < PITCH_W * 0.5;
    if (attackingHalf && holder.id == designatedTakerFor(SetPiece::ThrowIn, holder.team)) {
        double oppGoalX = goalXFor(holder.team);
        double targetX = oppGoalX - fd * 95.0;                                       // ~the 6-yard area
        double targetY = PITCH_H / 2.0 + (holder.y < PITCH_H / 2.0 ? -55.0 : 55.0);  // near post, throw side
        double dx = targetX - holder.x, dy = targetY - holder.y, d = std::max(1.0, std::hypot(dx, dy));
        auto& b = state.ball;
        b.controllerId = -1;
        placeBallForRelease(holder, dx, dy);
        blockReboundFor(holder.id, 600);
        b.lastTouchTeam = holder.team; b.lastToucherId = holder.id;
        double speed = clamp(160.0 + d * 0.15, 160.0, 290.0);                        // a powerful long throw
        b.vx = dx / d * speed; b.vy = dy / d * speed; b.vz = speed * 0.9; b.z = 0;    // flat-fast aerial into the box
        b.intendedReceiverId = -1;
        receiverShieldTargetId = -1;
        pendingPass.active = false;
        return;
    }
    for(auto&p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<30.0||d>400.0)continue;
        double nearestOpp=1e9;
        for(auto&o:state.players){
            if(o.team==holder.team||o.role==Role::GK||o.sentOff)continue;
            nearestOpp=std::min(nearestOpp,dist(o.x,o.y,p.x,p.y));
        }
        int laneBlockers = countLaneBlockers(state.players, holder.x, holder.y, p.x, p.y, holder.team, BLOCKER_PERP_THROWIN, 0.12, 0.92);
        double progress=(p.x-holder.x)*fd;
        double score=1.0-d/420.0+clamp(progress/180.0,-0.15,0.20);
        score-=laneBlockers*0.32+clamp((70.0-nearestOpp)/70.0,0.0,1.0)*0.35;
        targets.push_back({&p,score});
    }
    std::sort(targets.begin(),targets.end(),[](const RatedTarget& a,const RatedTarget& b){return a.score>b.score;});
    for(auto& target:targets){
        if(target.score < 0.05)continue;
        Player& t=*target.player;
        double dx=t.x-holder.x,dy=t.y-holder.y,d=std::hypot(dx,dy);
        if(d<30.0)continue;
        double speed=120.0+d*0.15;
        auto& b=state.ball;
        b.controllerId=-1;
        placeBallForRelease(holder,dx,dy);
        blockReboundFor(holder.id,600);
        b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
        b.vx=dx/d*speed; b.vy=dy/d*speed; b.vz=speed*1.4; b.z=0;
        b.intendedReceiverId=t.id;
        receiverShieldTargetId=t.id;
        beginTrackedPass(holder,t,false);
        return;
    }
    auto& b=state.ball;
    double side = holder.y < PITCH_H / 2.0 ? 1.0 : -1.0;
    double dx=fd*80.0, dy=side*130.0, d=std::hypot(dx,dy);
    double speed=155.0;
    b.controllerId=-1;
    placeBallForRelease(holder,dx,dy);
    blockReboundFor(holder.id,600);
    b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
    b.vx=dx/d*speed; b.vy=dy/d*speed; b.vz=speed*0.95; b.z=0;
    b.intendedReceiverId=-1;
    receiverShieldTargetId=-1;
    pendingPass.active=false;
}

void GameEngine::releaseCornerKick(Player& holder){
    double goalX=holder.x<HALF_X?HOME_GOAL_X:AWAY_GOAL_X;
    // Short corner: ~18% are worked SHORT to a nearby teammate (the short option who stayed near
    // the flag) instead of the whipped cross — set-piece variety. The receiver then plays on in
    // open play (cross/cutback/dribble). Falls through to the cross if no near option is present.
    if(rng.random()<0.18){
        Player* shortOpt=nullptr; double bestD=125.0;
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
            double d=dist(holder.x,holder.y,p.x,p.y);
            if(d>35.0&&d<bestD){bestD=d;shortOpt=&p;}
        }
        if(shortOpt){
            double dx=shortOpt->x-holder.x,dy=shortOpt->y-holder.y,d=std::max(1.0,std::hypot(dx,dy));
            auto& b=state.ball;
            b.controllerId=-1;
            placeBallForRelease(holder,dx,dy);
            blockReboundFor(holder.id,600);
            b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
            double speed=clamp(150.0+d*0.35,150.0,250.0);
            b.vx=dx/d*speed; b.vy=dy/d*speed; b.z=0; b.vz=0;
            b.intendedReceiverId=shortOpt->id;
            receiverShieldTargetId=shortOpt->id;
            emitEvent("corner_short",holder.x,holder.y,holder.id);
            beginTrackedPass(holder,*shortOpt,false);
            return;
        }
    }
    SmallVector<RatedTarget, 11> targets;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK||p.sentOff)continue;
        double goalDist=std::abs(p.x-goalX);
        double central=std::abs(p.y-PITCH_H/2.0);
        double roleBonus=p.role==Role::CF?0.35:p.role==Role::CM?0.18:p.role==Role::WM?0.10:p.role==Role::CB?0.06:-0.05;
        double score=(260.0-goalDist)/260.0*0.45+(180.0-central)/180.0*0.35+roleBonus;
        targets.push_back({&p,score});
    }
    std::sort(targets.begin(),targets.end(),[](const RatedTarget& a,const RatedTarget& b){return a.score>b.score;});
    if(!targets.empty()){
        Player& target=*targets.front().player;
        double tx=goalX+(holder.team==Team::Home?-1.0:1.0)*85.0;
        double ty=lerp(target.y,PITCH_H/2.0,0.55);
        double dx=tx-holder.x,dy=ty-holder.y,d=std::hypot(dx,dy);
        if(d>1.0){
            // Driven corner delivery — same whip treatment as open-play crosses,
            // capped at the hardest-shot ceiling (~38 m/s); was launching to 52.
            double speed=clamp(300.0+d*0.30,340.0,380.0);
            auto& b=state.ball;
            b.controllerId=-1;
            placeBallForRelease(holder,dx,dy);
            blockReboundFor(holder.id,900);
            b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
            b.vx=dx/d*speed; b.vy=dy/d*speed;
            b.z=0;
            applyWhipDelivery(d,speed,goalX,0.18,0.15);
            b.intendedReceiverId=target.id;
            receiverShieldTargetId=target.id;
            beginTrackedPass(holder,target,true);
            return;
        }
    }
    setPiece.armed=true;
    phase.actionTimer=450;
}

void GameEngine::awardThrowIn(Team lastTouchTeam, double y) {
    auto& b = state.ball;
    Team atTeam = (lastTouchTeam == Team::Home) ? Team::Away : Team::Home;
    b.x = clamp(b.x, 10., PITCH_W - 10);
    b.y = clamp(y, 3.0, PITCH_H - 3.0);
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPiece.type = SetPiece::ThrowIn;
    setPiece.team = atTeam;
    setPiece.armed = true;
    setPiece.reason = "throw_in";
    phase.actionTimer = 5000;
    setPiece.spotX = b.x;
    setPiece.spotY = b.y;
    setPiece.takerArrived = false;
    Player* best = findNearestOutfieldPlayer(atTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;
}

void GameEngine::awardSetPiece(SetPiece t, Team tm) {
    auto& b = state.ball;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPiece.type = t;
    setPiece.team = tm;
    setPiece.armed = true;
    setPiece.reason = std::string(to_string(t));
    setPiece.spotX = b.x;
    setPiece.spotY = b.y;
    setPiece.takerArrived = false;
    Team tmTeam = tm;

    if (t == SetPiece::GoalKick) {
        // Place the BALL at the goal-kick spot and let the keeper jog to it
        // via the generic taker walk — snapping him there teleported the GK
        // ~100px on every restart (the most frequent visual pop left).
        phase.actionTimer = 1550;
        setPiece.takerId = -1;
        for (auto& p : state.players) {
            if (p.team == tmTeam && p.role == Role::GK) {
                double fd = fdFor(tmTeam);
                double side = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                b.x = ownGoalXFor(tmTeam) + fd * (58.0 + CONTROL_DIST);
                b.y = clamp(PITCH_H / 2.0 + side * 78.0, 120.0, PITCH_H - 120.0);
                setPiece.spotX = b.x;
                setPiece.spotY = b.y;
                setPiece.takerId = p.id;
                break;
            }
        }
        return;
    }

    if (t == SetPiece::Penalty) {
        // Ball goes to the SPOT — without this, "penalties" were taken from
        // wherever the foul happened (tight angles, crowds) and barely scored.
        double fd = fdFor(tmTeam);
        b.x = goalXFor(tmTeam) - fd * PENALTY_SPOT_FROM_GOAL;
        b.y = PITCH_H / 2.0;
        setPiece.spotX = b.x;
        setPiece.spotY = b.y;
        phase.actionTimer = 5000;
        Player* best = nullptr;
        double bestScore = -1e9;
        for (auto& p : state.players) {
            if (p.team != tmTeam || p.role == Role::GK || p.sentOff) continue;
            double roleBonus = agentFor(p)->penaltyTakerBonus();
            double score = roleBonus + attrFactor(p.attrs.shooting) * 95.0 - dist(p.x, p.y, b.x, b.y) * 0.04;
            if (score > bestScore) { bestScore = score; best = &p; }
        }
        setPiece.takerId = best ? best->id : -1;
        return;
    }

    // Free kick: nearest outfield player runs to ball
    phase.actionTimer = 5000;
    Player* best = findNearestOutfieldPlayer(tmTeam, b.x, b.y);
    setPiece.takerId = best ? best->id : -1;
}

void GameEngine::awardCorner(Team attackingTeam, bool atHomeEnd, double y) {
    stats.recordCorner();
    auto& b=state.ball;
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1;
    setPiece.type=SetPiece::Corner;
    setPiece.team = attackingTeam;
    setPiece.armed=true;
    setPiece.reason="corner";
    phase.actionTimer=5000;
    setPiece.takerArrived=false;
    double cy=y<PITCH_H/2.0?0.0:PITCH_H;
    // Corner taken from the corner ARC, not 1.8m inside the field of play.
    double ix=atHomeEnd?6.0:PITCH_W-6.0;
    double iy=cy==0.0?6.0:PITCH_H-6.0;
    b.x=ix; b.y=iy;
    setPiece.spotX=ix; setPiece.spotY=iy;
    Player* taker=nullptr;
    double best=1e9;
    for(auto& p:state.players){
        if(p.team!=attackingTeam||p.role==Role::GK||p.sentOff)continue;
        double roleCost=(p.role==Role::WM?0.0:p.role==Role::FB?20.0:p.role==Role::CM?55.0:120.0);
        double d=dist(p.x,p.y,ix,iy)+roleCost;
        if(d<best){best=d;taker=&p;}
    }
    setPiece.takerId=taker?taker->id:-1;
}

void GameEngine::updateGoalKickMonitor() {
    if(!goalKickMonitor.active)return;
    double fd = fdFor(goalKickMonitor.team);
    double ownGoalX=ownGoalXFor(goalKickMonitor.team);
    double progress=(state.ball.x-ownGoalX)*fd;
    if(state.ball.lastTouchTeam==goalKickMonitor.team&&progress>PITCH_W/3.0){
        stats.recordGoalKickExit();
        goalKickMonitor.active=false;
    }else if(state.clockMs-goalKickMonitor.startedMs>18000.0){
        goalKickMonitor.active=false;
    }
}


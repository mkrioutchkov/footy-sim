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
        if(p.team==t)continue;
        double v=p.x*fd;
        if(v>v1){v2=v1;d2=d1;v1=v;d1=&p;}
        else if(v>v2){v2=v;d2=&p;}
    }
    if(d2)return d2->x;
    return d1 ? d1->x : (t==Team::Home?0.0:PITCH_W);
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
    SmallVector<Player*, 5> mids;
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
        bool credibleShot=shotDist>105.0&&shotDist<300.0&&central&&angleDeg>5.5&&laneBlockers<=3;
        double shotChance=clamp(0.48+(300.0-shotDist)/260.0+angleDeg/82.0-laneBlockers*0.10,0.25,0.85);
        if(credibleShot&&rng.random()<shotChance){
            shootBall(*holder,nullptr);
            clearReleasedSetPiece();
            return;
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
    Player* outlet=nullptr;
    double best=-1e9;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
        double progress=(p.x-ownGoalX)*fd;
        if(progress<430.0)continue;
        double lane=std::abs(p.y-PITCH_H/2.0);
        double roleBonus=p.role==Role::CF?150.0:p.role==Role::WM?125.0:p.role==Role::FB?25.0:0.0;
        double pressurePenalty=0.0;
        for(auto& o:state.players){
            if(o.team==holder.team||o.role==Role::GK)continue;
            double od=dist(o.x,o.y,p.x,p.y);
            if(od<90.0)pressurePenalty+=(90.0-od)*0.65;
        }
        double score=progress*0.32+lane*0.20+roleBonus-pressurePenalty;
        if(score>best){best=score;outlet=&p;}
    }
    if(!outlet){
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
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
        if(o.team==holder.team||o.role==Role::GK)continue;
        double od=dist(holder.x,holder.y,o.x,o.y);
        if(od<nearestKeeperPressure){nearestKeeperPressure=od;nearestPress=&o;}
        if(od<112.0)closeKeeperPressure++;
    }

    auto puntLong=[&](){
        Player* outlet=nullptr;
        double best=-1e9;
        for(auto& p:state.players){
            if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
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
        blockReboundFor(holder.id,750);
        if(wasGoalKick){
            goalKickMonitor.active=true;
            goalKickMonitor.team=holder.team;
            goalKickMonitor.startedMs=state.clockMs;
            stats.recordGoalKickAttempt();
        }
        goalKickMonitor.distributeTimer=0;
    };

    if(nearestKeeperPressure<115.0||closeKeeperPressure>=2){
        puntLong();
        return;
    }

    SmallVector<RatedTarget, 11> rated;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<(wasGoalKick?220.0:95.0)||d>590.0)continue;
        double progress=(p.x-ownGoalX)*fd;
        if(wasGoalKick&&progress<285.0)continue;
        int pressure=0;
        double nearestOpp=1e9;
        for(auto& o:state.players){
            if(o.team==holder.team||o.role==Role::GK)continue;
            double od=dist(o.x,o.y,p.x,p.y);
            nearestOpp=std::min(nearestOpp,od);
            if(od<62.0)pressure++;
        }
        int laneBlockers = countLaneBlockers(state.players, holder.x, holder.y, p.x, p.y, holder.team, BLOCKER_PERP_GK_DIST, 0.12, 0.92);
        double preferred=wasGoalKick?390.0:330.0;
        double distanceFit=1.0-std::abs(d-preferred)/preferred;
        double laneWidth=std::abs(p.y-PITCH_H/2.0);
        double roleBonus=p.role==Role::FB?0.30:p.role==Role::WM?0.26:p.role==Role::CM?0.12:p.role==Role::CB?-0.28:-0.36;
        double shortRisk=progress<260.0?0.55:progress<330.0?0.22:0.0;
        double centralOwnThird=(progress<345.0&&laneWidth<115.0)?0.42:0.0;
        double centralLongRisk=(d>440.0&&laneWidth<145.0)?0.38:0.0;
        double pressurePenalty=pressure*0.28+laneBlockers*0.23+clamp((75.0-nearestOpp)/75.0,0.0,1.0)*0.18;
        double score=distanceFit*0.42+progress/540.0*0.34+laneWidth/340.0*0.25+roleBonus-shortRisk-centralOwnThird-centralLongRisk-pressurePenalty;
        rated.push_back({&p,score});
    }
    std::sort(rated.begin(),rated.end(),[](const RatedTarget& a,const RatedTarget& b){return a.score>b.score;});
    for(auto& target:rated){
        if(passBallTo(holder,*target.player,false,false,nullptr)){
            if(wasGoalKick){
                goalKickMonitor.active=true;
                goalKickMonitor.team=holder.team;
                goalKickMonitor.startedMs=state.clockMs;
                stats.recordGoalKickAttempt();
            }
            goalKickMonitor.distributeTimer=0;
            return;
        }
    }
    SmallVector<Player*, 11> fallback;
    for(auto& p:state.players)if(p.team==holder.team&&p.id!=holder.id&&p.role!=Role::GK)fallback.push_back(&p);
    std::sort(fallback.begin(),fallback.end(),[&](const Player* a,const Player* b){
        return (a->x-ownGoalX)*fd>(b->x-ownGoalX)*fd;
    });
    // If a fallback pass actually RELEASED, we're done — the old code ignored
    // the result and re-armed a phantom set piece (takerId=-1, no controller)
    // with the ball already in flight: an unrecoverable frozen-ball state.
    if(!fallback.empty()){
        bool released=passBallTo(holder,*fallback.front(),false,false,nullptr);
        if(released){
            if(wasGoalKick){
                goalKickMonitor.active=true;
                goalKickMonitor.team=holder.team;
                goalKickMonitor.startedMs=state.clockMs;
                stats.recordGoalKickAttempt();
            }
            goalKickMonitor.distributeTimer=0;
            return;
        }
    }
    if(fallback.empty()){
        // Nobody to pass to at all: hold the ball and retry shortly.
        setPiece.armed=true;phase.actionTimer=250;
    } else {
        // Every pass vetoed — hoof it long rather than freeze.
        double fd = fdFor(holder.team);
        double speed=PASS_SPEED_BASE+60+350*(PASS_SPEED_DIST+0.07);
        auto& b=state.ball;
        b.controllerId=-1;
        placeBallForRelease(holder,fd*1.0,0.0);
        b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
        b.vx=fd*speed; b.vy=(rng.random()-0.5)*speed*0.25; b.vz=speed*0.85; b.z=0;
        b.intendedReceiverId=-1;
        blockReboundFor(holder.id,600);
        if(wasGoalKick){
            goalKickMonitor.active=true;
            goalKickMonitor.team=holder.team;
            goalKickMonitor.startedMs=state.clockMs;
            stats.recordGoalKickAttempt();
        }
    }
    goalKickMonitor.distributeTimer=0;
}

void GameEngine::releaseThrowIn(Player& holder){
    SmallVector<RatedTarget, 11> targets;
    double fd = fdFor(holder.team);
    for(auto&p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<30.0||d>400.0)continue;
        double nearestOpp=1e9;
        for(auto&o:state.players){
            if(o.team==holder.team||o.role==Role::GK)continue;
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
    SmallVector<RatedTarget, 11> targets;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
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
            // Driven corner delivery — same whip treatment as open-play crosses.
            double speed=clamp(300.0+d*0.30,340.0,520.0);
            auto& b=state.ball;
            b.controllerId=-1;
            placeBallForRelease(holder,dx,dy);
            blockReboundFor(holder.id,900);
            b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
            b.vx=dx/d*speed; b.vy=dy/d*speed;
            b.z=0;
            applyWhipDelivery(d,speed,goalX,0.75,0.45);
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


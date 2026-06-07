#include "engine.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Offside helpers
// ══════════════════════════════════════════════════════════════

double GameEngine::offsideLineFor(Team t) const {
    const double fd = t==Team::Home ? 1.0 : -1.0;
    const Player* d1=nullptr,*d2=nullptr,*gk=nullptr;
    double v1=-1e9, v2=-1e9;
    for(auto&p:state.players){
        if(p.team==t)continue;
        if(p.role==Role::GK){gk=&p;continue;}
        double v=p.x*fd;
        if(v>v1){v2=v1;d2=d1;v1=v;d1=&p;}
        else if(v>v2){v2=v;d2=&p;}
    }
    if(d2)return d2->x;
    if(d1&&gk){
        double dv=d1->x*fd, gv=gk->x*fd;
        return (dv<gv?d1:gk)->x;
    }
    return d1 ? d1->x : (t==Team::Home?0.0:PITCH_W);
}

bool GameEngine::checkOffside(const Player& receiver, const Player& passer) const {
    const double fd = passer.team==Team::Home ? 1.0 : -1.0;
    if(fd==1){if(receiver.x<=HALF_X||receiver.x<=passer.x+OFFSIDE_TOLERANCE)return false;}
    else{if(receiver.x>=HALF_X||receiver.x>=passer.x-OFFSIDE_TOLERANCE)return false;}
    const double line=offsideLineFor(passer.team);
    return fd==1 ? receiver.x>line+OFFSIDE_TOLERANCE : receiver.x<line-OFFSIDE_TOLERANCE;
}

void GameEngine::awardOffsideFreeKick(const std::string& defendingTeam, const Player& offsidePlayer) {
    auto& b=state.ball;
    b.x=clamp(offsidePlayer.x,20.0,PITCH_W-20);
    b.y=clamp(offsidePlayer.y,20.0,PITCH_H-20);
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1; b.intendedReceiverId=-1;
    receiverShieldTargetId=-1;
    Team defTeam = teamFromStr(defendingTeam);
    setPieceTypeEnum=SetPiece::FreeKick; setPieceTeamEnum = defTeam; setPieceArmed=true;
    setPieceReason="offside";
    actionTimer=5000;
    setPieceSpotX=b.x; setPieceSpotY=b.y;
    setPieceTakerArrived=false;
    Player* best = findNearestOutfieldPlayer(defTeam, b.x, b.y);
    setPieceTakerId = best ? best->id : -1;
}

bool GameEngine::isOffsideTarget(const Player& passer, const Player& receiver) const {
    return checkOffside(receiver, passer);
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
    auto clearReleasedSetPiece=[&](){
        if(!setPieceArmed){setPieceTypeEnum = SetPiece::None;setPieceTeamEnum = Team::Home;setPieceReason.clear();}
    };
    // Clear setPieceHold for all agents
    for(auto&a:agents) a->setPieceHold=false;
    if(setPieceTypeEnum == SetPiece::Corner){
        releaseCornerKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPieceTypeEnum == SetPiece::ThrowIn){
        releaseThrowIn(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPieceTypeEnum == SetPiece::GoalKick){
        releaseGoalKick(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPieceTypeEnum == SetPiece::Penalty){
        emitEvent("shot", holder->x, holder->y, holder->id);
        stats.recordPenaltyTaken();
        trackedPenaltyShot=true;
        shootBall(*holder,nullptr);
        clearReleasedSetPiece();
        return;
    }
    if(holder->role==Role::GK){
        releaseGoalkeeperDistribution(*holder);
        clearReleasedSetPiece();
        return;
    }
    if(setPieceTypeEnum == SetPiece::FreeKick){
        double gx=goalXFor(holder->team);
        double gy=PITCH_H/2.0;
        double shotDist=std::hypot(gx-holder->x,gy-holder->y);
        double angleDeg=goalOpeningAngleDeg(holder->x,holder->y,gx);
        int laneBlockers=0;
        double dxGoal=gx-holder->x,dyGoal=gy-holder->y,laneLenSq=dxGoal*dxGoal+dyGoal*dyGoal;
        if(laneLenSq>1.0){
            for(auto& o:state.players){
                if(o.team==holder->team||o.role==Role::GK)continue;
                double along=((o.x-holder->x)*dxGoal+(o.y-holder->y)*dyGoal)/laneLenSq;
                if(along<=0.06||along>=0.90)continue;
                double perp=std::hypot(o.x-holder->x-along*dxGoal,o.y-holder->y-along*dyGoal);
                if(perp<42.0)laneBlockers++;
            }
        }
        bool central=std::abs(holder->y-gy)<170.0;
        bool credibleShot=shotDist>115.0&&shotDist<390.0&&central&&angleDeg>6.0&&laneBlockers<=2;
        double shotChance=clamp(0.12+(390.0-shotDist)/520.0+angleDeg/90.0-laneBlockers*0.18,0.08,0.58);
        if(credibleShot&&rng.random()<shotChance){
            emitEvent("shot", holder->x, holder->y, holder->id);
            shootBall(*holder,nullptr);
            clearReleasedSetPiece();
            return;
        }
    }
    std::vector<Player*> targets;
    for(auto&p:state.players){
        if(p.team!=holder->team||p.id==holder->id||p.role==Role::GK)continue;
        if(setPieceTypeEnum == SetPiece::FreeKick&&dist(holder->x,holder->y,p.x,p.y)<55.0)continue;
        targets.push_back(&p);
    }
    std::sort(targets.begin(),targets.end(),[&](const Player* a,const Player* b){
        auto scoreTarget=[&](const Player* p){
            double fd=holder->team==Team::Home?1.0:-1.0;
            double d=dist(holder->x,holder->y,p->x,p->y);
            double progress=(p->x-holder->x)*fd;
            double width=std::abs(p->y-PITCH_H/2.0);
            int laneBlockers=0;
            double closestOpp=999.0;
            double dx=p->x-holder->x,dy=p->y-holder->y,ls=dx*dx+dy*dy;
            if(ls>1.0){
                for(auto& o:state.players){
                    if(o.team==holder->team||o.role==Role::GK)continue;
                    closestOpp=std::min(closestOpp,dist(o.x,o.y,p->x,p->y));
                    double along=clamp(((o.x-holder->x)*dx+(o.y-holder->y)*dy)/ls,0.0,1.0);
                    double perp=std::hypot(o.x-holder->x-along*dx,o.y-holder->y-along*dy);
                    if(along>0.12&&along<0.92&&perp<34.0)laneBlockers++;
                }
            }
            if(setPieceTypeEnum == SetPiece::FreeKick){
                double distanceFit=1.0-std::abs(d-145.0)/210.0;
                double pressureScore=clamp((closestOpp-35.0)/95.0,-0.60,0.75);
                double resetBonus=progress<-25.0?0.55:std::abs(progress)<45.0?0.30:-0.18;
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
    setPieceArmed=true;
    actionTimer=250;
}

void GameEngine::releaseGoalKick(Player& holder){
    if(holder.role!=Role::GK)return;
    double fd=holder.team==Team::Home?1.0:-1.0;
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
    goalKickMonitorActive=true;
    goalKickMonitorTeam=holder.team;
    goalKickMonitorStartedMs=state.clockMs;
    stats.recordGoalKickAttempt();
    gkDistributeTimer=0;
}

void GameEngine::releaseGoalkeeperDistribution(Player& holder){
    double fd=holder.team==Team::Home?1.0:-1.0;
    double ownGoalX=ownGoalXFor(holder.team);
    bool wasGoalKick=setPieceTypeEnum == SetPiece::GoalKick;
    double nearestKeeperPressure=1e9;
    int closeKeeperPressure=0;
    Player* nearestPress=nullptr;
    for(auto& o:state.players){
        if(o.team==holder.team||o.role==Role::GK)continue;
        double od=dist(holder.x,holder.y,o.x,o.y);
        if(od<nearestKeeperPressure){nearestKeeperPressure=od;nearestPress=&o;}
        if(od<92.0)closeKeeperPressure++;
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
            goalKickMonitorActive=true;
            goalKickMonitorTeam=holder.team;
            goalKickMonitorStartedMs=state.clockMs;
            stats.recordGoalKickAttempt();
        }
        gkDistributeTimer=0;
    };

    if(nearestKeeperPressure<70.0||closeKeeperPressure>=2){
        puntLong();
        return;
    }

    struct RatedTarget{Player* player;double score;};
    std::vector<RatedTarget> rated;
    for(auto& p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<(wasGoalKick?220.0:95.0)||d>590.0)continue;
        double progress=(p.x-ownGoalX)*fd;
        if(wasGoalKick&&progress<285.0)continue;
        int pressure=0;
        int laneBlockers=0;
        double nearestOpp=1e9;
        for(auto& o:state.players){
            if(o.team==holder.team||o.role==Role::GK)continue;
            double od=dist(o.x,o.y,p.x,p.y);
            nearestOpp=std::min(nearestOpp,od);
            if(od<62.0)pressure++;
            double dx=p.x-holder.x,dy=p.y-holder.y,ls=dx*dx+dy*dy;
            if(ls>1.0){
                double along=clamp(((o.x-holder.x)*dx+(o.y-holder.y)*dy)/ls,0.0,1.0);
                double perp=std::hypot(o.x-holder.x-along*dx,o.y-holder.y-along*dy);
                if(along>0.12&&along<0.92&&perp<44.0)laneBlockers++;
            }
        }
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
                goalKickMonitorActive=true;
                goalKickMonitorTeam=holder.team;
                goalKickMonitorStartedMs=state.clockMs;
                stats.recordGoalKickAttempt();
            }
            gkDistributeTimer=0;
            return;
        }
    }
    std::vector<Player*> fallback;
    for(auto& p:state.players)if(p.team==holder.team&&p.id!=holder.id&&p.role!=Role::GK)fallback.push_back(&p);
    std::sort(fallback.begin(),fallback.end(),[&](const Player* a,const Player* b){
        return (a->x-ownGoalX)*fd>(b->x-ownGoalX)*fd;
    });
    if(!fallback.empty()){
        bool released=passBallTo(holder,*fallback.front(),false,false,nullptr);
        if(released&&wasGoalKick){
            goalKickMonitorActive=true;
            goalKickMonitorTeam=holder.team;
            goalKickMonitorStartedMs=state.clockMs;
            stats.recordGoalKickAttempt();
        }
    }
    if(fallback.empty()||!wasGoalKick){
        setPieceArmed=true;actionTimer=250;
    } else if(wasGoalKick){
        double fd=holder.team==Team::Home?1.0:-1.0;
        double speed=PASS_SPEED_BASE+60+350*(PASS_SPEED_DIST+0.07);
        auto& b=state.ball;
        b.controllerId=-1;
        placeBallForRelease(holder,fd*1.0,0.0);
        b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
        b.vx=fd*speed; b.vy=(rng.random()-0.5)*speed*0.25; b.vz=speed*0.85; b.z=0;
        b.intendedReceiverId=-1;
        blockReboundFor(holder.id,600);
        goalKickMonitorActive=true;
        goalKickMonitorTeam=holder.team;
        goalKickMonitorStartedMs=state.clockMs;
        stats.recordGoalKickAttempt();
    }
    gkDistributeTimer=0;
}

void GameEngine::releaseThrowIn(Player& holder){
    struct RatedTarget{Player* player;double score;};
    std::vector<RatedTarget> targets;
    double fd=holder.team==Team::Home?1.0:-1.0;
    for(auto&p:state.players){
        if(p.team!=holder.team||p.id==holder.id||p.role==Role::GK)continue;
        double d=dist(holder.x,holder.y,p.x,p.y);
        if(d<30.0||d>400.0)continue;
        double nearestOpp=1e9;
        int laneBlockers=0;
        for(auto&o:state.players){
            if(o.team==holder.team||o.role==Role::GK)continue;
            nearestOpp=std::min(nearestOpp,dist(o.x,o.y,p.x,p.y));
            double dx=p.x-holder.x,dy=p.y-holder.y,ls=dx*dx+dy*dy;
            if(ls>1.0){
                double along=clamp(((o.x-holder.x)*dx+(o.y-holder.y)*dy)/ls,0.0,1.0);
                double perp=std::hypot(o.x-holder.x-along*dx,o.y-holder.y-along*dy);
                if(along>0.12&&along<0.92&&perp<32.0)laneBlockers++;
            }
        }
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
    struct RatedTarget{Player* player;double score;};
    std::vector<RatedTarget> targets;
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
            double speed=PASS_SPEED_BASE+42.0+d*(PASS_SPEED_DIST+0.07);
            auto& b=state.ball;
            b.controllerId=-1;
            placeBallForRelease(holder,dx,dy);
            blockReboundFor(holder.id,900);
            b.lastTouchTeam=holder.team; b.lastToucherId=holder.id;
            b.vx=dx/d*speed; b.vy=dy/d*speed; b.vz=speed*0.95; b.z=0;
            b.intendedReceiverId=target.id;
            receiverShieldTargetId=target.id;
            beginTrackedPass(holder,target,true);
            return;
        }
    }
    setPieceArmed=true;
    actionTimer=450;
}

void GameEngine::awardThrowIn(std::string lt, double y) {
    auto& b = state.ball;
    Team atTeam;
    if (lt == "home") atTeam = Team::Away;
    else if (lt == "away") atTeam = Team::Home;
    else atTeam = (b.x < PITCH_W / 2) ? Team::Away : Team::Home;
    b.x = clamp(b.x, 10., PITCH_W - 10);
    b.y = clamp(y, 10., PITCH_H - 10);
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPieceTypeEnum = SetPiece::ThrowIn;
    setPieceTeamEnum = atTeam;
    setPieceArmed = true;
    setPieceReason = "throw_in";
    actionTimer = 5000;
    setPieceSpotX = b.x;
    setPieceSpotY = b.y;
    setPieceTakerArrived = false;
    Player* best = findNearestOutfieldPlayer(atTeam, b.x, b.y);
    setPieceTakerId = best ? best->id : -1;
}

void GameEngine::awardSetPiece(SetPiece t, Team tm) {
    auto& b = state.ball;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPieceTypeEnum = t;
    setPieceTeamEnum = tm;
    setPieceArmed = true;
    setPieceReason = std::string(to_string(t));
    setPieceSpotX = b.x;
    setPieceSpotY = b.y;
    setPieceTakerArrived = false;
    Team tmTeam = tm;

    if (t == SetPiece::GoalKick) {
        actionTimer = 1550;
        setPieceTakerId = -1;
        for (auto& p : state.players) {
            if (p.team == tmTeam && p.role == Role::GK) {
                b.controllerId = p.id;
                b.lastTouchTeam = tmTeam;
                b.lastToucherId = p.id;
                double fd = tmTeam == Team::Home ? 1.0 : -1.0;
                double side = b.y < PITCH_H / 2.0 ? -1.0 : 1.0;
                p.x = ownGoalXFor(tmTeam) + fd * 58.0;
                p.y = clamp(PITCH_H / 2.0 + side * 78.0, 120.0, PITCH_H - 120.0);
                p.targetX = p.x; p.targetY = p.y; p.vx = p.vy = 0;
                b.x = p.x + fd * CONTROL_DIST;
                b.y = p.y;
                break;
            }
        }
        return;
    }

    if (t == SetPiece::Penalty) {
        actionTimer = 5000;
        Player* best = nullptr;
        double bestScore = -1e9;
        for (auto& p : state.players) {
            if (p.team != tmTeam || p.role == Role::GK) continue;
            double roleBonus = p.role == Role::CF ? 90.0 : p.role == Role::CM ? 45.0 : p.role == Role::WM ? 25.0 : 0.0;
            double score = roleBonus + attrFactor(p.attrs.shooting) * 80.0 - dist(p.x, p.y, b.x, b.y) * 0.15;
            if (score > bestScore) { bestScore = score; best = &p; }
        }
        setPieceTakerId = best ? best->id : -1;
        return;
    }

    // Free kick: nearest outfield player runs to ball
    actionTimer = 5000;
    Player* best = findNearestOutfieldPlayer(tmTeam, b.x, b.y);
    setPieceTakerId = best ? best->id : -1;
}

void GameEngine::awardCorner(Team attackingTeam, bool atHomeEnd, double y) {
    auto& b=state.ball;
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1;
    setPieceTypeEnum=SetPiece::Corner;
    setPieceTeamEnum = attackingTeam;
    setPieceArmed=true;
    setPieceReason="corner";
    actionTimer=5000;
    setPieceTakerArrived=false;
    double x=atHomeEnd?HOME_GOAL_X:AWAY_GOAL_X;
    double cy=y<PITCH_H/2.0?0.0:PITCH_H;
    double ix=atHomeEnd?18.0:PITCH_W-18.0;
    double iy=cy==0.0?18.0:PITCH_H-18.0;
    b.x=ix; b.y=iy;
    setPieceSpotX=ix; setPieceSpotY=iy;
    Player* taker=nullptr;
    double best=1e9;
    for(auto& p:state.players){
        if(p.team!=attackingTeam||p.role==Role::GK)continue;
        double roleCost=(p.role==Role::WM?0.0:p.role==Role::FB?20.0:p.role==Role::CM?55.0:120.0);
        double d=dist(p.x,p.y,ix,iy)+roleCost;
        if(d<best){best=d;taker=&p;}
    }
    setPieceTakerId=taker?taker->id:-1;
}

void GameEngine::updateGoalKickMonitor() {
    if(!goalKickMonitorActive)return;
    double fd=goalKickMonitorTeam==Team::Home?1.0:-1.0;
    double ownGoalX=ownGoalXFor(goalKickMonitorTeam);
    double progress=(state.ball.x-ownGoalX)*fd;
    if(state.ball.lastTouchTeam==goalKickMonitorTeam&&progress>PITCH_W/3.0){
        stats.recordGoalKickExit();
        goalKickMonitorActive=false;
    }else if(state.clockMs-goalKickMonitorStartedMs>18000.0){
        goalKickMonitorActive=false;
    }
}


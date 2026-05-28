#pragma once
// engine_impl_setpieces.h — kickoff tap, release, throw-in, goal kick

inline void GameEngine::kickoffTap(){
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    std::vector<Player*> mids;
    for(auto&p:state.players)if(p.team==holder->team&&p.id!=holder->id&&p.role=="CM")mids.push_back(&p);
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
inline void GameEngine::releaseSetPiece(){
    Player* holder=playerById(state.ball.controllerId);
    if(!holder)return;
    std::vector<Player*> targets;
    for(auto&p:state.players){
        if(p.team!=holder->team||p.id==holder->id||p.role=="GK")continue;
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
inline void GameEngine::awardThrowIn(std::string lt, double y) {
    auto& b = state.ball;
    std::string at;
    if (lt == "home") at = "away";
    else if (lt == "away") at = "home";
    else at = (b.x < PITCH_W / 2) ? "away" : "home";
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
        if (p.team != at || p.role == "GK") continue;
        double d = dist(p.x, p.y, b.x, b.y);
        if (d < bd) { bd = d; best = &p; }
    }
    if (best) {
        b.controllerId = best->id;
        b.lastTouchTeam = best->team;
        b.lastToucherId = best->id;
    }
}
inline void GameEngine::awardSetPiece(std::string t, std::string tm) {
    auto& b = state.ball;
    b.vx = b.vy = b.z = b.vz = 0;
    b.controllerId = -1;
    setPieceType = t;
    setPieceTeam = tm;
    setPieceArmed = true;
    actionTimer = 900;
    for (auto& p : state.players) {
        if (p.team == tm && p.role == "GK") {
            b.controllerId = p.id;
            b.lastTouchTeam = tm;
            b.lastToucherId = p.id;
            b.x = p.x + ((tm == "home") ? CONTROL_DIST : -CONTROL_DIST);
            b.y = p.y;
            break;
        }
    }
}

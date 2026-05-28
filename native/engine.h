#pragma once
#include "rng.h"
#include "constants.h"
#include "types.h"
#include "agent.h"
#include "gk_ai.h"
#include "stats.h"
#include "json.h"
#include <format>
#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <memory>

class GameEngine {
public:
    mutable SeededRNG rng;
    EngineState state;
    TeamBlackboard blackboards[2]; // [0]=home, [1]=away
    static int teamIndex(const std::string& team) { return team == "home" ? 0 : 1; }
    StatsCollector stats;
    std::vector<std::unique_ptr<PlayerAI>> agents;
    std::array<Player*, 22> playerLookup = {};
    double accumulator = 0.0;

    // per-frame state (not stats — used by game logic)
    double possessionHome = 0, possessionAway = 0;
    double peakBallSpeed = 0, looseBallSpeedTotal = 0;
    double passLaunchSpeedTotal = 0, shotLaunchSpeedTotal = 0;
    int looseBallSpeedSamples = 0, passLaunchCount = 0, shotLaunchCount = 0;
    std::string lastGoalSource = "none", lastGoalScoringTeam, lastGoalTouchTeam;
    int lastGoalToucherId = -1;
    double lastGoalBallSpeed = 0;
    int stuckCarrierAlerts = 0;
    int teammatePingPongs = 0;
    double lastSameTeamCollectionMs = 0;
    std::string lastCollectionTeam;
    int simulationFreezes = 0;
    double freezeWatchMs = 0;
    double freezeBallX = 0, freezeBallY = 0;
    int freezeLastController = -1;
    double lastFreezeAlertMs = -1e9;
    int dizzySpins = 0;
    double nextTacticalAuditMs = 0;
    int watchedCarrierId = -1;
    double watchedCarrierX = 0, watchedCarrierY = 0, watchedCarrierMs = 0, lastStuckAlertMs = -1e9;

    double lastKickoffMs = 0; bool kickoffPhase = false;
    double actionTimer = 0; bool setPieceArmed = false;
    std::string setPieceType, setPieceTeam;
    int half = 1; double halfTimePause = 0;
    std::string nextKickoffTeam = "home";
    bool shotActive = false;
    bool trackedShot = false;
    bool trackedShotPreventable = false;
    std::string trackedShotTeam;
    int trackedShooterId = -1;
    double shotOriginX = 0, shotOriginY = 0;
    double gkDistributeTimer = 0;
    std::unordered_map<int,double> contestBlockedUntil;
    int receiverShieldTargetId = -1, receiverShieldedPlayerId = -1;
    double receiverShieldUntil = 0;
    struct PendingPass {
        bool active = false;
        int fromId = -1, toId = -1;
        std::string team;
        bool isCross = false;
    } pendingPass;
    struct ActiveKnockAhead {
        bool active = false;
        int playerId = -1;
        std::string team;
        double launchedAt = 0;
        int nearestOpponentId = -1;
        double nearestOpponentDistance = 0;
        bool risky = false;
    } activeKnockAhead;
    std::unordered_map<int,double> knockAheadCooldownUntil;
    std::string lastLooseOrigin;

    // ── Agent-accessible state ──
    struct RecentPass { double bx=525,by=340,vx=0,vy=0; std::string team; double clockMs=0; };
    RecentPass qRecentPassVal;
    RecentPass* qRecentPass() { return &qRecentPassVal; }
    [[nodiscard]] int clockMs() const { return static_cast<int>(state.clockMs); }
    [[nodiscard]] std::string teamInPossession() const { return state.ball.lastTouchTeam.empty() ? "home" : state.ball.lastTouchTeam; }

    // ── Tactical callbacks ──
    struct Config {
        double aggression=50, passingDirectness=50, overlapFrequency=50;
        double midfieldFreedom=50, defensiveLineHeight=50;
    };
    Config homeConfig, awayConfig;
    [[nodiscard]] Config configFor(const std::string& team) const { return team=="home" ? homeConfig : awayConfig; }
    [[nodiscard]] std::string teamPhaseFor(const std::string&) const { return "possession"; }
    [[nodiscard]] double offsideLineFor(const std::string& t) const {
        const double fd = t=="home" ? 1.0 : -1.0;
        const Player* d1=nullptr,*d2=nullptr;
        double v1=fd==1?-1e9:1e9, v2=v1;
        for(auto&p:state.players){
            if(p.team==t)continue;
            double v=fd==1?-p.x:p.x;
            if(v<v1){if(v1!=v2)v2=v1;else v2=v;v1=v;d2=d1;d1=&p;}
            else if(v<v2){v2=v;d2=&p;}
        }
        return d2 ? d2->x : (t=="home"?0.0:PITCH_W);
    }
    [[nodiscard]] bool checkOffside(const Player& receiver, const Player& passer) const {
        const double fd = passer.team=="home" ? 1.0 : -1.0;
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
    void awardOffsideFreeKick(const std::string& defendingTeam, const Player& offsidePlayer) {
        auto& b=state.ball;
        b.x=clamp(offsidePlayer.x,20.0,PITCH_W-20);
        b.y=clamp(offsidePlayer.y,20.0,PITCH_H-20);
        b.vx=b.vy=b.z=b.vz=0;
        b.controllerId=-1; b.intendedReceiverId=-1;
        receiverShieldTargetId=-1;
        setPieceType="free_kick"; setPieceTeam=defendingTeam; setPieceArmed=true;
    }
    [[nodiscard]] bool isOffsideTarget(const Player& passer, const Player& receiver) const {
        return rng.random() < 0.20 && checkOffside(receiver, passer);
    }
    struct AgentTeamAssignment { std::string role; int opponentId=-1; double targetX=0, targetY=0; };
    std::unordered_map<int, AgentTeamAssignment> assignmentByPlayer;
    [[nodiscard]] AgentTeamAssignment* assignmentFor(int playerId) {
        auto it=assignmentByPlayer.find(playerId);
        return it==assignmentByPlayer.end()?nullptr:&it->second;
    }
    [[nodiscard]] const AgentTeamAssignment* assignmentFor(int playerId) const {
        auto it=assignmentByPlayer.find(playerId);
        return it==assignmentByPlayer.end()?nullptr:&it->second;
    }
    AgentTeamAssignment* committedRunFor(int) { return nullptr; }
    [[nodiscard]] Player* playerById(int id) {
        if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
        for(auto&p:state.players)if(p.id==id)return &p;
        return nullptr;
    }
    [[nodiscard]] double carrierHoldMs() const { return watchedCarrierMs; }
    [[nodiscard]] const Player* playerById(int id) const {
        if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
        for(auto&p:state.players)if(p.id==id)return &p;
        return nullptr;
    }
    [[nodiscard]] std::vector<Player*> nearPlayers(Player& p, double range) {
        std::vector<Player*> r;
        for(auto& o:state.players) if(&o!=&p && dist(p.x,p.y,o.x,o.y)<range) r.push_back(&o);
        return r;
    }
    [[nodiscard]] bool isCarrierShielded(int playerId) const { return receiverShieldedPlayerId==playerId&&state.clockMs<receiverShieldUntil; }
    bool canContestBall(Player& player) {
        if(setPieceArmed&&state.ball.controllerId<0)return false;
        auto it=contestBlockedUntil.find(player.id);
        if(it==contestBlockedUntil.end())return true;
        if(it->second>state.clockMs)return false;
        contestBlockedUntil.erase(it);
        return true;
    }
    [[nodiscard]] bool canKnockBallAhead(int playerId) const {
        auto it=knockAheadCooldownUntil.find(playerId);
        return !activeKnockAhead.active&&(it==knockAheadCooldownUntil.end()||it->second<=state.clockMs);
    }
    [[nodiscard]] bool isActiveKnockAheadRunner(int playerId) const { return activeKnockAhead.active&&activeKnockAhead.playerId==playerId; }

    // ── Actions ──
    void notePreventedStaleGrab(Player&) {}
    void noteTaskSelection(Player&, const std::string&) {}
    bool knockBallAhead(Player&, double, double);
    void resolveKnockAhead(Player* collector, const std::string& stopped = "");
    void emitEvent(const std::string&, double, double) {}
    void blockReboundFor(int playerId,double ms) {
        if(playerId<0)return;
        contestBlockedUntil[playerId]=std::max(contestBlockedUntil[playerId],state.clockMs+ms);
    }
    void recordBallImpulse() {
        double spd=std::hypot(state.ball.vx,state.ball.vy);
        peakBallSpeed=std::max(peakBallSpeed,spd);
        stats.recordBallSpeedSample(spd);
    }
    void beginTrackedPass(Player& from,Player& to,bool isCross=false) {
        stats.recordPassAttempt();
        lastLooseOrigin.clear();
        double speed=std::hypot(state.ball.vx,state.ball.vy);
        passLaunchSpeedTotal+=speed; passLaunchCount++;
        stats.recordPassLaunch(speed);
        recordBallImpulse();
        pendingPass={true,from.id,to.id,from.team,isCross};
    }
    void resolvePendingPass(Player& receiver) {
        if(!pendingPass.active)return;
        if(receiver.team==pendingPass.team){stats.recordPassComplete();}
        else {stats.recordPassIntercepted();}
        pendingPass.active=false;
    }
    void auditStuckCarrier(double sdt);
    void updateTeamAssignments();
    void assignDefensiveRoles(const std::string& team, Player& carrier);
    void setAssignment(Player& player, const std::string& role, double x, double y, int opponentId=-1);
    void auditTacticalCoverage(Player& carrier);
    void auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                 int pressureCount, const std::string& choiceType);

    [[nodiscard]] double goalOpeningAngleDeg(double x, double y, double gx) const {
        double dx=gx-x;
        double top=std::atan2(PITCH_H/2.0-GOAL_W/2.0-y,dx);
        double bottom=std::atan2(PITCH_H/2.0+GOAL_W/2.0-y,dx);
        double opening=std::abs(std::atan2(std::sin(bottom-top),std::cos(bottom-top)));
        return opening*180.0/3.141592653589793;
    }

    void placeBallForRelease(Player& kicker, double dx, double dy, double maxOffset=CONTROL_DIST+PLAYER_R+10) {
        double d=std::hypot(dx,dy);
        if(d<0.001){
            double fd=kicker.team=="home"?1.0:-1.0;
            state.ball.x=clamp(kicker.x+fd*maxOffset,5.0,PITCH_W-5.0);
            state.ball.y=kicker.y;
            return;
        }
        state.ball.x=clamp(kicker.x+dx/d*maxOffset,5.0,PITCH_W-5.0);
        state.ball.y=clamp(kicker.y+dy/d*maxOffset,5.0,PITCH_H-5.0);
    }
    void passBallTo(Player& f,Player& t) { passBallTo(f,t,false,false,nullptr); }
    bool passBallTo(Player& f,Player& t,bool throughBall,bool,void* selectionAudit) {
        double rawDx=t.x-f.x,rawDy=t.y-f.y,rawDist=std::hypot(rawDx,rawDy);
        if(rawDist<1)return false;
        double speed=(PASS_SPEED_BASE+rawDist*PASS_SPEED_DIST)*(0.92+rng.random()*0.16);
        double travelTime=rawDist/std::max(speed,1.0);
        double receiverSpeed=std::hypot(t.vx,t.vy);
        double fd=f.team=="home"?1.0:-1.0;
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
        double ownGoalX=f.team=="home"?HOME_GOAL_X:AWAY_GOAL_X;
        bool towardOwnGoal=f.team=="home"?tdx<0:tdx>0;
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
            if(o.team==f.team||o.role=="GK")continue;
            double along=clamp(((o.x-f.x)*dx+(o.y-f.y)*dy)/(adjDist*adjDist),0.0,1.0);
            double perp=std::hypot(o.x-f.x-along*dx,o.y-f.y-along*dy);
            if(perp<35&&along>0.1&&along<0.9)blockers++;
        }
        if(rawDist>240)b.vz=speed*0.55;
        if(blockers>0&&rawDist>120)b.vz=std::max(b.vz,speed*0.70);
        if(rawDist>350)b.vz=std::max(b.vz,speed);
        const auto* audit=static_cast<const PassSelectionAudit*>(selectionAudit);
        double goalX=f.team=="home"?AWAY_GOAL_X:HOME_GOAL_X;
        bool fromWide=std::abs(f.y-PITCH_H/2)>180;
        bool intoBox=std::abs(predX-goalX)<200&&std::abs(predY-PITCH_H/2)<140;
        bool selectedCross=audit&&audit->purpose=="cross"&&fromWide&&(f.role=="WM"||f.role=="FB")&&!throughBall;
        bool whippedCross=fromWide&&intoBox&&(f.role=="WM"||f.role=="FB")&&!throughBall
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
            awardOffsideFreeKick(f.team=="home"?"away":"home",t);
            return true;
        }
        return true;
    }
    void forcePassTo(Player&f,Player&t,void*) {
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
            awardOffsideFreeKick(f.team=="home"?"away":"home",t);
        }
    }
    bool attemptTackle(Player& tackler,Player& carrier){
        double contactDist=dist(tackler.x,tackler.y,carrier.x,carrier.y);
        auto& b=state.ball;
        if(b.controllerId!=carrier.id||tackler.team==carrier.team||contactDist>TACKLE_RANGE)return false;
        if(!canContestBall(tackler))return false;
        stats.recordTackleAttempt();
        double tackleSkill=attrFactor(tackler.attrs.tackling);
        double carrierControl=attrFactor(carrier.attrs.positioning)*0.35+attrFactor(carrier.attrs.speed)*0.15;
        double facingBonus=(tackler.team=="home"?tackler.vx>0:tackler.vx<0)?0.08:-0.05;
        double carrierSpeed=std::hypot(carrier.vx,carrier.vy);
        double forwardX=carrierSpeed>8?carrier.vx/carrierSpeed:(carrier.team=="home"?1.0:-1.0);
        double forwardY=carrierSpeed>8?carrier.vy/carrierSpeed:0;
        double approachDot=contactDist>0
            ? ((tackler.x-carrier.x)*forwardX+(tackler.y-carrier.y)*forwardY)/contactDist
            : 0;
        bool fromBehind=approachDot<-0.30;
        bool carrierShielded=isCarrierShielded(carrier.id);
        double dribbleBonus=carrier.dribbleType==3?0.10:carrier.dribbleType==1?-0.10:0;
        double chance=clamp(0.18+tackleSkill*0.35-carrierControl*0.15+facingBonus
            -(carrierShielded?0.20:0)-(fromBehind?0.14:0)
            +(approachDot>0.3&&approachDot<0.85?0.06:0)+dribbleBonus,0.06,0.72);
        if(rng.random()>=chance){
            double foulChance=fromBehind?0.34:0.10;
            if(rng.random()<foulChance){
                stats.recordTackleFoul();
                // Don't use setPieceArmed — it freezes the carrier for 900ms.
                // Just give the ball back to the carrier and let play continue.
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
    void shootBall(Player&s,void* selectionAudit){
        stats.recordShot(s.team,false);
        double gx=(s.team=="home")?AWAY_GOAL_X:HOME_GOAL_X;
        double accuracy=attrFactor(s.attrs.shooting);
        double goalCenterY=PITCH_H/2.0;
        double shotDistance=std::hypot(gx-s.x,goalCenterY-s.y);
        stats.recordShotDistance(shotDistance);
        int pressureCount=0;
        for(auto&o:state.players)if(o.team!=s.team&&o.role!="GK"&&dist(o.x,o.y,s.x,s.y)<PRESSURE_RANGE)pressureCount++;
        double angleDeg=goalOpeningAngleDeg(s.x,s.y,gx);
        bool outsideGoalLane=std::abs(s.y-goalCenterY)>GOAL_W/2+20;
        bool acuteGeometry=outsideGoalLane&&angleDeg<7.5&&shotDistance>150;
        const auto* audit=static_cast<const ShotSelectionAudit*>(selectionAudit);
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
    bool collectBall(Player& c, const std::string&, double allowedDist);

    // ── Logging (no-ops for C++) ──
    template<typename...A> void logPlayerDecision(A&&...){}
    template<typename...A> void logQualityFlag(A&&...){}
    template<typename...A> void captureDecisionMoment(A&&...){}
    template<typename...A> void auditDefensiveMovement(A&&...){}

    // ── Lifecycle ──
    GameEngine() {
        // JS order: homeMgr(6) → homeTeam(shuffle 29 + attrs 77) → awayMgr(6) → awayTeam(shuffle 29 + attrs 77)
        // We create all teams at once (154 randomInt calls). Need to interleave dummy calls.
        // Strategy: createTeams() does 154 randomInt. We split: 77 home then dummy then 77 away.
        blackboards[0]={}; blackboards[1]={};
    }

    void initWithSeed(int seed) {
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
            if (p.role == "GK")
                agents.push_back(std::make_unique<GKPlayerAI>(p, *this));
            else
                agents.push_back(std::make_unique<PlayerAI>(p, *this));
        }
    }

    void createHomeTeam() {
        auto mk=[&](int id,std::string t,std::string r,double hx,double hy){return Player{id,std::format("{}{}",t,id),t,r,hx,hy,0,0,hx,hy,hx,hy,100.0,{static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(60,95))},t=="home"?0.0:3.141592653589793};};
        std::vector<Player> home = {
            mk(0,"home","GK",31.5,340),mk(1,"home","FB",157.5,81.6),
            mk(2,"home","CB",189,226.6667),mk(3,"home","CB",189,453.3333),
            mk(4,"home","FB",157.5,598.4),mk(5,"home","CM",420,170),
            mk(6,"home","CM",420,340),mk(7,"home","CM",420,510),
            mk(8,"home","WM",441,81.6),mk(9,"home","CF",756,340),
            mk(10,"home","WM",441,598.4)
        };
        state.players.insert(state.players.end(), home.begin(), home.end());
    }
    void createAwayTeam() {
        auto mk=[&](int id,std::string t,std::string r,double hx,double hy){return Player{id,std::format("{}{}",t,id),t,r,hx,hy,0,0,hx,hy,hx,hy,100.0,{static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(35,90)),static_cast<double>(rng.randomInt(60,95))},t=="home"?0.0:3.141592653589793};};
        std::vector<Player> away = {
            mk(11,"away","GK",1018.5,340),mk(12,"away","FB",892.5,81.6),
            mk(13,"away","CB",861,226.6667),mk(14,"away","CB",861,453.3333),
            mk(15,"away","FB",892.5,598.4),mk(16,"away","CM",630,170),
            mk(17,"away","CM",630,340),mk(18,"away","CM",630,510),
            mk(19,"away","WM",609,81.6),mk(20,"away","CF",294,340),
            mk(21,"away","WM",609,598.4)
        };
        state.players.insert(state.players.end(), away.begin(), away.end());
    }
    void startMatch(){state.matchState="running";state.clockMs=0;kickoff("home");}
    void kickoff(std::string t);
    void update(double dM);
    void fixedUpdate(double sdt);
    void tickAgents(double sdt,bool ic);
    void kickoffTap();
    void releaseSetPiece();

    // ── Physics ──
    void applyBallPhysics(double s);
    void clampBallPosition();
    bool checkGoal();
    bool checkOutOfPlay();
    void checkBallPlayerCollision(double);
    void collectBall(Player&c);
    void updateControlledBall(double secs);
    void moveBallCarrier(double sdt);
    void updateGK(double sdt);
    void tryGKSave();
    void awardThrowIn(std::string lt,double y);
    void awardSetPiece(std::string t,std::string tm);

    std::string getSummaryJSON() const { return stats.summaryJSON(); }
    std::string getJSON() const;
};

// ── Engine method implementations (split by domain) ──
#include "engine_impl_dribble.h"
#include "engine_impl_lifecycle.h"
#include "engine_impl_tactical.h"
#include "engine_impl_setpieces.h"
#include "engine_impl_physics.h"
#include "engine_impl_goalkeeper.h"
#include "engine_impl_json.h"

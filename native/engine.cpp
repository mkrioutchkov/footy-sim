#include "engine.h"
#include "nlohmann/json.hpp"
#include "agent.h"
#include "role_ai.h"
#include "gk_ai.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Player lookups
// ══════════════════════════════════════════════════════════════

Player* GameEngine::playerById(int id) {
    if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
    for(auto&p:state.players)if(p.id==id)return &p;
    return nullptr;
}

const Player* GameEngine::playerById(int id) const {
    if(id>=0&&id<22&&playerLookup[id])return playerLookup[id];
    for(auto&p:state.players)if(p.id==id)return &p;
    return nullptr;
}

std::vector<Player*> GameEngine::nearPlayers(Player& p, double range) {
    std::vector<Player*> r;
    for(auto& o:state.players) if(&o!=&p && dist(p.x,p.y,o.x,o.y)<range) r.push_back(&o);
    return r;
}


Player* GameEngine::findNearestOutfieldPlayer(Team team, double x, double y) {
    Player* best = nullptr;
    double   bestDist = 1e9;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK) continue;
        double d = dist(p.x, p.y, x, y);
        if (d < bestDist) { bestDist = d; best = &p; }
    }
    return best;
}

PlayerAI* GameEngine::agentFor(const Player& p) {
    return agents[p.id].get();
}

const PlayerAI* GameEngine::agentFor(const Player& p) const {
    return agents[p.id].get();
}

Player* GameEngine::findGK(Team team) {
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::GK) return &p;
    }
    return nullptr;
}

const Player* GameEngine::findGK(Team team) const {
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::GK) return &p;
    }
    return nullptr;
}

bool GameEngine::canContestBall(Player& player) {
    if(setPieceArmed&&state.ball.controllerId<0)return false;
    if(activeKnockAhead.active&&activeKnockAhead.playerId==player.id)return true;
    auto it=contestBlockedUntil.find(player.id);
    if(it==contestBlockedUntil.end())return true;
    if(it->second>state.clockMs)return false;
    contestBlockedUntil.erase(it);
    return true;
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — kickoff, update, fixedUpdate, tickAgents, auditStuckCarrier
// ══════════════════════════════════════════════════════════════

void GameEngine::kickoff(Team t){
    nextKickoffTeam=(t==Team::Home)?Team::Away:Team::Home;
    contestBlockedUntil.clear();
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    pendingPass.active=false;
    activeKnockAhead.active=false;
    knockAheadCooldownUntil.clear();
    trackedShot=false;
    trackedShotPreventable=false;
    trackedShotHeader=false;
    lastLooseOrigin.clear();
    for(auto&p:state.players){
        double margin=(p.team==t)?30.0:45.0;
        p.x=p.team==Team::Home
            ? clamp(p.homeX,25.0,HALF_X-margin)
            : clamp(p.homeX,HALF_X+margin,PITCH_W-25.0);
        p.y=p.homeY;
        p.targetX=p.x; p.targetY=p.y;
        p.vx=p.vy=0;
    }
    auto&b=state.ball;
    b.x=HALF_X; b.y=PITCH_H/2;
    b.vx=b.vy=b.z=b.vz=0;
    b.controllerId=-1; b.intendedReceiverId=-1;
    for(auto&p:state.players){
        if(p.team==t&&p.role==Role::CF){
            p.x=HALF_X; p.y=PITCH_H/2;
            p.targetX=p.x; p.targetY=p.y;
            b.controllerId=p.id;
            b.lastTouchTeam=t; b.lastToucherId=p.id;
            break;
        }
    }
    kickoffPhase=true;
    actionTimer=600;
    lastKickoffMs=state.clockMs;
    setPieceArmed=false;
    setPieceReason.clear();
}

void GameEngine::update(double dM) {
    accumulator += dM * state.speed;
    int steps = 0;
    while (accumulator >= FIXED_DT && steps < 3) {
        accumulator -= FIXED_DT;
        fixedUpdate(FIXED_DT);
        steps++;
    }
}

void GameEngine::cacheBallState() {
    prevBallX = state.ball.x;
    prevBallY = state.ball.y;
    prevControllerId = state.ball.controllerId;
}

void GameEngine::fixedUpdate(double sdt) {
    state.clockMs += sdt;
    if (state.clockMs >= MATCH_DURATION) {
        state.matchState = "finished";
        stats.recordScore(state.homeScore, state.awayScore);
        return;
    }
    if (half == 1 && state.clockMs >= 45 * 60 * 1000) { half = 2; halfTimePause = 2000; }
    if (halfTimePause > 0) {
        halfTimePause -= sdt;
        if (halfTimePause <= 0) kickoff(nextKickoffTeam);
        tickAgents(sdt, false);
        cacheBallState();
        return;
    }
    double sec = sdt / 1000;
    updatePlayerAnimations(sdt);
    updatePossessionTracking(sdt);
    detectSimulationFreeze(sdt);

    if (setPieceArmed) { updateSetPiecePhase(sdt, sec); return; }
    if (kickoffPhase)   { updateKickoffPhase(sdt); return; }

    updateOpenPlayPhase(sdt, sec);
}
void GameEngine::updatePlayerAnimations(double sdt) {
    for (auto& p : state.players) {
        if (p.tackleAnim > 0) p.tackleAnim = std::max(0., p.tackleAnim - sdt);
        if (p.headingAnim > 0) p.headingAnim = std::max(0., p.headingAnim - sdt);
        if (p.crossCollected > 0) p.crossCollected = std::max(0., p.crossCollected - sdt);
    }
}

void GameEngine::updatePossessionTracking(double sdt) {
    auto* c = playerById(state.ball.controllerId);
    if (c) {
        if (c->team == Team::Home) possessionHome += sdt;
        else possessionAway += sdt;
        double fd = fdFor(c->team);
        if (c->id != backwardCarryCarrierId) {
            backwardCarryCarrierId = c->id;
            backwardCarryStartX = c->x;
            backwardCarryRecorded = false;
        } else if (!backwardCarryRecorded && (c->x - backwardCarryStartX) * fd < -200.0) {
            stats.recordLongBackwardCarry();
            backwardCarryRecorded = true;
        }
    } else {
        backwardCarryCarrierId = -1;
        backwardCarryRecorded = false;
    }
    stats.recordPossession(possessionHome, possessionAway);
    auditStuckCarrier(sdt);
}

void GameEngine::detectSimulationFreeze(double sdt) {
    if (setPieceArmed || kickoffPhase) return;
    auto& fb = state.ball;
    int cid = fb.controllerId;
    if (cid < 0) {
        freezeWatchMs = 0;
        freezeLastController = -1;
    } else if (cid != freezeLastController) {
        freezeWatchMs = 0;
        freezeBallX = fb.x;
        freezeBallY = fb.y;
        freezeLastController = cid;
    } else {
        freezeWatchMs += sdt;
        if (dist(fb.x, fb.y, freezeBallX, freezeBallY) >= 5) {
            freezeWatchMs = 0;
            freezeBallX = fb.x;
            freezeBallY = fb.y;
        } else if (freezeWatchMs > 1500 && state.clockMs - lastFreezeAlertMs > 5000) {
            Player* frozen=playerById(cid);
            Player* best=nullptr; double bestD=1e9;
            if(frozen&&frozen->role!=Role::GK){
                for(auto&p:state.players){
                    if(p.team!=frozen->team||p.id==frozen->id||p.role==Role::GK)continue;
                    double d=dist(frozen->x,frozen->y,p.x,p.y);
                    if(d<bestD){bestD=d;best=&p;}
                }
            }
            if(frozen&&best){
                forcePassTo(*frozen,*best,nullptr);
            }else if(frozen){
                double fd=fdFor(frozen->team);
                frozen->targetX=clamp(frozen->x+fd*90.0,35.0,PITCH_W-35.0);
                frozen->targetY=clamp(frozen->y+(frozen->y<PITCH_H/2?-45.0:45.0),35.0,PITCH_H-35.0);
            }else{
                simulationFreezes++;
                stats.recordSimulationFreeze();
                lastFreezeAlertMs = state.clockMs;
            }
            freezeWatchMs = 0;
            freezeBallX = fb.x;
            freezeBallY = fb.y;
        }
    }
}

// ── Set piece parameter helpers ──
static double standBackFor(SetPiece sp) {
    if (sp == SetPiece::ThrowIn) return 0.0;
    if (sp == SetPiece::Corner) return 7.0;
    if (sp == SetPiece::Penalty) return 18.0;
    return 14.0;
}
static double minDistFor(SetPiece sp) {
    if (sp == SetPiece::ThrowIn) return 42.0;
    if (sp == SetPiece::Corner) return 58.0;
    if (sp == SetPiece::Penalty) return 96.0;
    return 78.0;
}
static double actionTimerFor(SetPiece sp) {
    if (sp == SetPiece::ThrowIn) return 650.0;
    if (sp == SetPiece::Penalty) return 1800.0;
    return 1500.0;
}

void GameEngine::updateSetPiecePhase(double sdt, double sec) {
    actionTimer -= sdt;
    Team spTeam = setPieceTeamEnum;
    for (auto& a : agents) {
        a->setPiecePositioning(setPieceTypeEnum, spTeam);
    }
    auto placeTakerForRestart = [&](Player& taker, bool releaseSpot) {
        double fd = fdFor(taker.team);
        double standBack = standBackFor(setPieceTypeEnum);
        double px = releaseSpot ? setPieceSpotX : setPieceSpotX - fd * standBack;
        double py = setPieceSpotY;
        taker.x = clamp(px, 5.0, PITCH_W - 5.0);
        taker.y = clamp(py, 5.0, PITCH_H - 5.0);
        taker.targetX = setPieceSpotX;
        taker.targetY = setPieceSpotY;
        taker.vx = taker.vy = 0;
        taker.facing = std::atan2(setPieceSpotY - taker.y, setPieceSpotX - taker.x);
    };
    auto enforceRestartDistance = [&]() {
        double minDist = minDistFor(setPieceTypeEnum);
        Team restartTeam = setPieceTeamEnum;
        for (auto& p : state.players) {
            if (p.team == restartTeam || p.role == Role::GK) continue;
            double dx = p.x - setPieceSpotX;
            double dy = p.y - setPieceSpotY;
            double d = std::hypot(dx, dy);
            if (d >= minDist) continue;
            if (d < 1.0) {
                double fd = fdFor(p.team);
                dx = -fd; dy = p.homeY < PITCH_H / 2.0 ? -0.35 : 0.35;
                d = std::hypot(dx, dy);
            }
            p.x = clamp(setPieceSpotX + dx / d * minDist, 5.0, PITCH_W - 5.0);
            p.y = clamp(setPieceSpotY + dy / d * minDist, 5.0, PITCH_H - 5.0);
            p.targetX = p.x;
            p.targetY = p.y;
            p.vx = p.vy = 0;
        }
    };

    if (setPieceTakerId >= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPieceTakerId) {
                a->setPieceHold = true;
                break;
            }
        }
    }

    tickAgents(sdt, false);
    moveBallCarrier(sdt);
    separateTeammates(sdt);
    enforceRestartDistance();

    if (setPieceTypeEnum == SetPiece::GoalKick && actionTimer <= 0) {
        setPieceArmed = false;
        setPieceReason.clear();
        releaseSetPiece();
        cacheBallState();
        return;
    }

    if (setPieceTakerId >= 0 && !setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) {
            double dx = state.ball.x - taker->x;
            double dy = state.ball.y - taker->y;
            double d = std::hypot(dx, dy);
            if (d > 1.0) {
                double speed = attrFactor(taker->attrs.speed) * SPEED_SPRINT;
                double step = std::min(speed * (sdt / 1000.0), d);
                taker->x += (dx / d) * step;
                taker->y += (dy / d) * step;
                taker->facing = std::atan2(dy, dx);
            }
            taker->targetX = state.ball.x;
            taker->targetY = state.ball.y;
        }
    }

    if (setPieceTakerId >= 0 && !setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) {
            double d = dist(taker->x, taker->y, state.ball.x, state.ball.y);
            if (d < 15.0) {
                setPieceTakerArrived = true;
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                actionTimer = actionTimerFor(setPieceTypeEnum);
            }
        }
    }

    if (setPieceTakerArrived && actionTimer <= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPieceTakerId) { a->setPieceHold = false; break; }
        }
        Player* taker = playerById(setPieceTakerId);
        if (taker) placeTakerForRestart(*taker, true);
        enforceRestartDistance();
        state.ball.x = setPieceSpotX;
        state.ball.y = setPieceSpotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
        setPieceArmed = false;
        setPieceReason.clear();
        setPieceTakerId = -1;
        setPieceTakerArrived = false;
        releaseSetPiece();
    } else if (!setPieceTakerArrived && actionTimer <= 0) {
        if (setPieceTakerId >= 0) {
            Player* taker = playerById(setPieceTakerId);
            if (taker) {
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                taker->x = state.ball.x;
                taker->y = state.ball.y;
                taker->targetX = state.ball.x;
                taker->targetY = state.ball.y;
                setPieceTakerArrived = true;
                actionTimer = actionTimerFor(setPieceTypeEnum);
            }
        }
    }
    updateControlledBall(sec);
    if (setPieceTakerArrived) {
        Player* taker = playerById(setPieceTakerId);
        if (taker) placeTakerForRestart(*taker, false);
        state.ball.x = setPieceSpotX;
        state.ball.y = setPieceSpotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
    }
    cacheBallState();
}

void GameEngine::updateKickoffPhase(double sdt) {
    actionTimer -= sdt;
    if (actionTimer <= 0) { kickoffPhase = false; kickoffTap(); }
    cacheBallState();
}

void GameEngine::updateOpenPlayPhase(double sdt, double sec) {
    auto& b = state.ball;
    if (b.controllerId >= 0) contestBlockedUntil.erase(b.controllerId);
    if (b.controllerId < 0) {
        applyBallPhysics(sec);
        clampBallPosition();
        tryGKSave();
        if (checkGoal()) { cacheBallState(); return; }
        if (checkOutOfPlay()) { cacheBallState(); return; }
        checkBallPlayerCollision(sec);
    }
    for (auto& bb : blackboards) { bb.pressingPlayerId = bb.pressingPlayerId2 = -1; }
    updateTeamAssignments();
    tickAgents(sdt, true);
    if (gkDistributeTimer > 0) {
        gkDistributeTimer -= sdt;
        if (gkDistributeTimer <= 0) releaseSetPiece();
    }
    if (b.intendedReceiverId >= 0 && b.controllerId < 0) {
        Player* receiver = playerById(b.intendedReceiverId);
        if (receiver) {
            receiver->targetX = b.x;
            receiver->targetY = b.y;
        }
    }
    updateControlledBall(sec);
    moveBallCarrier(sdt);
    updateGK(sdt);
    separateTeammates(sdt);
    updateControlledBall(sec);
    updateGoalKickMonitor();
    tryGKSave();
    if(state.ball.controllerId<0){
        double speed=std::hypot(state.ball.vx,state.ball.vy);
        peakBallSpeed=std::max(peakBallSpeed,speed);
        looseBallSpeedTotal+=speed;
        looseBallSpeedSamples++;
        stats.recordBallSpeedSample(speed);
    }
    double jumpDx = state.ball.x - prevBallX;
    double jumpDy = state.ball.y - prevBallY;
    double jumpDist = std::hypot(jumpDx, jumpDy);
    double expectedMax = std::hypot(state.ball.vx, state.ball.vy) * sec + 20.0
        + (activeKnockAhead.active ? DRIBBLE_KNOCK_OFFSET : 0.0);
    if (jumpDist > expectedMax && jumpDist > 50.0 && !setPieceArmed && !kickoffPhase
        && prevControllerId < 0 && state.ball.controllerId < 0) {
        stats.recordBallJump();
    }
    cacheBallState();
}

void GameEngine::tickAgents(double sdt, bool ic) {
    for (auto& a : agents) {
        int id = a->player.id;
        if (id == state.ball.controllerId && !ic) continue;
        a->tick(sdt);
        if (a->dizzyRotationAccum > 1080.0) {
            dizzySpins++;
            stats.recordDizzySpin();
            a->dizzyRotationAccum = 0;
            a->dizzyWindowStartMs = state.clockMs;
        }
    }
}

void GameEngine::auditStuckCarrier(double sdt){
    Player* carrier=playerById(state.ball.controllerId);
    if(!carrier){
        watchedCarrierId=-1;
        watchedCarrierMs=0;
        return;
    }
    if(carrier->id!=watchedCarrierId){
        watchedCarrierId=carrier->id;
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    watchedCarrierMs+=sdt;
    double moved=dist(carrier->x,carrier->y,watchedCarrierX,watchedCarrierY);
    if(moved>STUCK_CARRIER_MOVE_THRESHOLD){
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    double fd=fdFor(carrier->team);
    double forwardProgress=(carrier->x-watchedCarrierX)*fd;
    if(forwardProgress>30.0){
        watchedCarrierX=carrier->x; watchedCarrierY=carrier->y;
        watchedCarrierMs=0;
        return;
    }
    int nearbyOpponents=0;
    for(auto& p:state.players){
        if(p.team!=carrier->team&&p.role!=Role::GK&&dist(p.x,p.y,carrier->x,carrier->y)<PRESSURE_RANGE)nearbyOpponents++;
    }
    bool deep=carrier->team==Team::Home?carrier->x<PITCH_W*0.28:carrier->x>PITCH_W*0.72;
    if(watchedCarrierMs>STUCK_CARRIER_TIMEOUT_MS*0.65){
        Player* best=nullptr; double bestD=1e9;
        for(auto&p:state.players){
            if(p.team!=carrier->team||p.id==carrier->id||p.role==Role::GK)continue;
            double d=dist(carrier->x,carrier->y,p.x,p.y);
            if(d<bestD){bestD=d; best=&p;}
        }
        if(best)forcePassTo(*carrier,*best,nullptr);
        else{auto&b=state.ball;b.controllerId=-1;b.vx=carrier->team==Team::Home?300:-300;b.vy=0;b.vz=80;b.z=0;}
        setPieceArmed=false;setPieceTypeEnum = SetPiece::None;setPieceTeamEnum = Team::Home;setPieceReason.clear();
        watchedCarrierMs=0;watchedCarrierX=carrier->x;watchedCarrierY=carrier->y;
    }
}

// ══════════════════════════════════════════════════════════════
// JSON serialization
// ══════════════════════════════════════════════════════════════

std::string GameEngine::getSummaryJSON() const { return stats.summaryJSON(); }

std::string GameEngine::getJSON() const {
    auto& b = state.ball;
    nlohmann::json j;
    j["clockMs"] = std::round(state.clockMs);
    j["matchState"] = state.matchState;
    j["half"] = half;
    j["version"] = std::format("{} {}", "cpp", __TIME__);
    j["speed"] = state.speed;
    j["homeScore"] = state.homeScore;
    j["awayScore"] = state.awayScore;

    j["ball"] = {
        {"x", std::round(b.x * 10) / 10}, {"y", std::round(b.y * 10) / 10},
        {"vx", std::round(b.vx * 10) / 10}, {"vy", std::round(b.vy * 10) / 10},
        {"z", std::round(b.z * 10) / 10},
        {"controllerId", b.controllerId >= 0 ? nlohmann::json(b.controllerId) : nlohmann::json(nullptr)},
        {"intendedReceiverId", b.intendedReceiverId >= 0 ? nlohmann::json(b.intendedReceiverId) : nlohmann::json(nullptr)},
        {"lastTouchTeam", std::string(to_string(b.lastTouchTeam))},
        {"lastToucherId", b.lastToucherId >= 0 ? nlohmann::json(b.lastToucherId) : nlohmann::json(nullptr)}
    };

    j["players"] = nlohmann::json::array();
    for (auto& p : state.players) {
        j["players"].push_back({
            {"id", p.id}, {"name", p.name}, {"team", std::string(to_string(p.team))}, {"role", std::string(to_string(p.role))},
            {"x", std::round(p.x * 10) / 10}, {"y", std::round(p.y * 10) / 10},
            {"vx", std::round(p.vx * 10) / 10}, {"vy", std::round(p.vy * 10) / 10},
            {"targetX", std::round(p.targetX * 10) / 10}, {"targetY", std::round(p.targetY * 10) / 10},
            {"stamina", std::round(p.stamina)}, {"facing", std::round(p.facing * 1000) / 1000},
            {"dribbleType", p.dribbleType},
            {"tackleAnim", std::round(p.tackleAnim)}, {"headingAnim", std::round(p.headingAnim)}
        });
    }

    nlohmann::json summary = nlohmann::json::parse(stats.summaryJSON());
    j["passes"] = summary["passes"];
    j["passesCompleted"] = summary["passesCompleted"];
    j["passesIntercepted"] = summary["passesIntercepted"];
    j["passesIntendedReceived"] = summary["passesIntendedReceived"];
    j["wrongTeammateTouches"] = summary["wrongTeammate"];
    j["throughBallsAttempted"] = summary["throughBallsAttempted"];
    j["throughBallsCompleted"] = summary["throughBallsCompleted"];
    j["crossesAttempted"] = summary["crossesAttempted"];
    j["crossesCompleted"] = summary["crossesCompleted"];
    j["headers"] = summary["headers"];
    j["headedShots"] = summary["headedShots"];
    j["forwardPasses"] = summary["forwardPasses"];
    j["backwardPasses"] = summary["backwardPasses"];
    j["sidewaysPasses"] = summary["sidewaysPasses"];
    j["longBackwardPasses"] = summary["longBackwardPasses"];
    j["keeperBackpasses"] = summary["keeperBackpasses"];
    j["passCompletionPct"] = summary["passCompletionPct"];
    j["offsides"] = summary["offsides"];
    j["homeShots"] = summary["homeShots"];
    j["awayShots"] = summary["awayShots"];
    j["shots"] = summary["shots"];
    j["shotsOnTarget"] = summary["shotsOnTarget"];
    j["saves"] = summary["saves"];
    j["stuckCarrierAlerts"] = summary["stuckCarrierAlerts"];
    j["simulationFreezes"] = summary["simulationFreezes"];
    j["dizzySpins"] = summary["dizzySpins"];
    j["ballJumps"] = summary["ballJumps"];
    j["teammatePingPongs"] = summary["teammatePingPongs"];
    j["slideTackleDistanceAlerts"] = summary["slideTackleDistanceAlerts"];
    j["slideTackleOobAlerts"] = summary["slideTackleOobAlerts"];
    j["ownPassGoals"] = summary["ownPassGoals"];
    j["unknownLooseGoals"] = summary["unknownLooseGoals"];
    j["shotsByDistance"] = summary["shotsByDistance"];
    j["shotsByRole"] = summary["shotsByRole"];
    j["controlledTouchesByRole"] = summary["controlledTouchesByRole"];
    j["goalsByDistance"] = summary["goalsByDistance"];
    j["goalsByRole"] = summary["goalsByRole"];
    j["untrackedGoals"] = summary["untrackedGoals"];
    j["directDeliveryGoals"] = summary["directDeliveryGoals"];
    j["directCrossGoals"] = summary["directCrossGoals"];
    j["headedGoals"] = summary["headedGoals"];
    j["tackleDeflectionGoals"] = summary["tackleDeflectionGoals"];
    j["goalkeeperParryGoals"] = summary["goalkeeperParryGoals"];
    j["shotDeflectionGoals"] = summary["shotDeflectionGoals"];
    j["lostShotGoals"] = summary["lostShotGoals"];
    j["knockAheadGoals"] = summary["knockAheadGoals"];
    j["goalkeeping"] = summary["goalkeeping"];
    j["tackles"] = summary["tackles"];
    j["dribbleTypes"] = summary["dribbleTypes"];
    j["carrierTurns"] = summary["carrierTurns"];
    j["passSelection"] = summary["passSelection"];
    j["setPieces"] = summary["setPieces"];
    j["penaltyGoals"] = summary["setPieces"]["penaltiesScored"];
    j["shotSelection"] = summary["shotSelection"];
    j["marking"] = summary["marking"];
    j["qualityFlags"] = summary["qualityFlags"];
    j["ballSpeed"] = summary["ballSpeed"];
    j["events"] = nlohmann::json::array();
    for(const auto& ev:visualEvents){
        double age=state.clockMs-ev.clockMs;
        if(age>2600.0)continue;
        j["events"].push_back({
            {"type", ev.type},
            {"x", std::round(ev.x*10)/10},
            {"y", std::round(ev.y*10)/10},
            {"age", std::round(age)},
            {"playerId", ev.playerId>=0?nlohmann::json(ev.playerId):nlohmann::json(nullptr)},
            {"targetId", ev.targetId>=0?nlohmann::json(ev.targetId):nlohmann::json(nullptr)}
        });
    }
    j["possessionPct"] = summary["possessionPct"];

    if (setPieceArmed) {
        j["setPieceState"] = {
            {"type", to_string(setPieceTypeEnum)},
            {"reason", setPieceReason.empty() ? to_string(setPieceTypeEnum) : setPieceReason},
            {"team", to_string(setPieceTeamEnum)},
            {"takerId", setPieceTakerId},
            {"takerArrived", setPieceTakerArrived},
            {"spotX", setPieceSpotX},
            {"spotY", setPieceSpotY},
            {"timerMs", actionTimer}
        };
    }

    return j.dump();
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — constructor, initWithSeed, createHomeTeam, createAwayTeam
// ══════════════════════════════════════════════════════════════

GameEngine::~GameEngine() = default;

GameEngine::GameEngine() {
    blackboards[0]={}; blackboards[1]={};
}

void GameEngine::initWithSeed(int seed) {
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
        switch (p.role) {
            case Role::GK: agents.push_back(std::make_unique<GKPlayerAI>(p, *this)); break;
            case Role::CF: agents.push_back(std::make_unique<CFPlayerAI>(p, *this)); break;
            case Role::WM: agents.push_back(std::make_unique<WMPlayerAI>(p, *this)); break;
            case Role::CM: agents.push_back(std::make_unique<CMPlayerAI>(p, *this)); break;
            case Role::CB: agents.push_back(std::make_unique<CBPlayerAI>(p, *this)); break;
            case Role::FB: agents.push_back(std::make_unique<FBPlayerAI>(p, *this)); break;
            default:       agents.push_back(std::make_unique<PlayerAI>(p, *this));  break;
        }
    }
}

void GameEngine::equalizeAttributes(int val) {
    for (auto& p : state.players) {
        p.attrs.speed = val;
        p.attrs.passing = val;
        p.attrs.shooting = val;
        p.attrs.tackling = val;
        p.attrs.positioning = val;
        p.attrs.creativity = val;
        p.attrs.stamina = val;
    }
}

Player GameEngine::mkPlayer(int id, Team t, Role r, double hx, double hy) {
    return Player{id, std::format("{}{}", to_string(t), id), t, r, hx, hy, 0, 0, hx, hy, hx, hy, 100.0,
        {static_cast<double>(rng.randomInt(35,90)), static_cast<double>(rng.randomInt(35,90)),
         static_cast<double>(rng.randomInt(35,90)), static_cast<double>(rng.randomInt(35,90)),
         static_cast<double>(rng.randomInt(35,90)), static_cast<double>(rng.randomInt(35,90)),
         static_cast<double>(rng.randomInt(60,95))},
        t == Team::Home ? 0.0 : PI};
}

void GameEngine::createHomeTeam() {
    std::vector<Player> home = {
        mkPlayer(0,Team::Home,Role::GK,31.5,340),mkPlayer(1,Team::Home,Role::FB,157.5,81.6),
        mkPlayer(2,Team::Home,Role::CB,189,226.6667),mkPlayer(3,Team::Home,Role::CB,189,453.3333),
        mkPlayer(4,Team::Home,Role::FB,157.5,598.4),mkPlayer(5,Team::Home,Role::CM,420,170),
        mkPlayer(6,Team::Home,Role::CM,420,340),mkPlayer(7,Team::Home,Role::CM,420,510),
        mkPlayer(8,Team::Home,Role::WM,441,81.6),mkPlayer(9,Team::Home,Role::CF,756,340),
        mkPlayer(10,Team::Home,Role::WM,441,598.4)
    };
    state.players.insert(state.players.end(), home.begin(), home.end());
}

void GameEngine::createAwayTeam() {
    std::vector<Player> away = {
        mkPlayer(11,Team::Away,Role::GK,1018.5,340),mkPlayer(12,Team::Away,Role::FB,892.5,81.6),
        mkPlayer(13,Team::Away,Role::CB,861,226.6667),mkPlayer(14,Team::Away,Role::CB,861,453.3333),
        mkPlayer(15,Team::Away,Role::FB,892.5,598.4),mkPlayer(16,Team::Away,Role::CM,630,170),
        mkPlayer(17,Team::Away,Role::CM,630,340),mkPlayer(18,Team::Away,Role::CM,630,510),
        mkPlayer(19,Team::Away,Role::WM,609,81.6),mkPlayer(20,Team::Away,Role::CF,294,340),
        mkPlayer(21,Team::Away,Role::WM,609,598.4)
    };
    state.players.insert(state.players.end(), away.begin(), away.end());
}

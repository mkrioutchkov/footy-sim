#include "engine.h"
#include "nlohmann/json.hpp"
#include "agent.h"
#include "role_ai.h"
#include "gk_ai.h"
#include "build_version.h"
#include <format>
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

SmallVector<Player*, 11> GameEngine::nearPlayers(Player& p, double range) {
    SmallVector<Player*, 11> r;
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
    if(setPiece.armed&&state.ball.controllerId<0)return false;
    if(activeKnockAhead.active&&activeKnockAhead.playerId==player.id)return true;
    if(state.ball.controllerId<0
        && state.ball.intendedReceiverId==player.id
        && state.ball.lastTouchTeam==player.team
        && state.ball.lastToucherId!=player.id)return true;
    if(contestBlockedUntil[player.id] > state.clockMs) return false;
    contestBlockedUntil[player.id] = 0;
    return true;
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — kickoff, update, fixedUpdate, tickAgents, auditStuckCarrier
// ══════════════════════════════════════════════════════════════

void GameEngine::startMatch() {
    state.matchState = "running";
    state.clockMs = 0;
    phase.addedTimeActive = false;
    phase.matchKickoffTeam = Team::Home;
    kickoff(Team::Home);
}

void GameEngine::kickoff(Team t){
    phase.nextKickoffTeam=(t==Team::Home)?Team::Away:Team::Home;
    contestBlockedUntil.fill(0);
    receiverShieldUntil=0; receiverShieldedPlayerId=-1; receiverShieldTargetId=-1;
    pendingPass.active=false;
    activeKnockAhead.active=false;
    knockAheadCooldownUntil.fill(0);
    shot.tracked=false;
    shot.preventable=false;
    shot.header=false;
    shot.penalty=false;
    shot.dribble20m=false;
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
    phase.kickoffPhase=true;
    phase.actionTimer=600;
    phase.lastKickoffMs=state.clockMs;
    setPiece.armed=false;
    setPiece.reason.clear();
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
    prevBallVx = state.ball.vx;
    prevBallVy = state.ball.vy;
    prevControllerId = state.ball.controllerId;
}

void GameEngine::fixedUpdate(double sdt) {
    state.clockMs += sdt;
    // Stoppage time accrues while the ball is dead — set pieces, kickoffs,
    // the halftime pause. The board announces a real +N at 45:00/90:00.
    if (setPiece.armed || phase.kickoffPhase || phase.halfTimePause > 0) phase.stoppageMs += sdt;

    // ── Added-time / end-of-phase.half whistle ──
    double halfEndMs = (phase.half == 1) ? halfDurationMs : matchDurationMs;
    if (state.clockMs >= halfEndMs) {
        if (!phase.addedTimeActive) {
            phase.announcedAddedMs = clamp(std::round(phase.stoppageMs * 0.35 / 60000.0), 1.0, 5.0) * 60000.0;
        }
        phase.addedTimeActive = true;
        double overtimeMs = state.clockMs - halfEndMs;
        double bx = state.ball.x;
        bool inFinalThird = (bx < THIRD_1 || bx > THIRD_2);
        if (overtimeMs >= phase.announcedAddedMs && !inFinalThird) {
            phase.addedTimeActive = false;
            phase.stoppageMs = 0;
            phase.announcedAddedMs = 0;
            if (phase.half == 1) {
                phase.half = 2;
                phase.halfTimePause = 2000;
                // Law: the team that did NOT kick off the match starts H2.
                phase.nextKickoffTeam = phase.matchKickoffTeam == Team::Home ? Team::Away : Team::Home;
            } else {
                state.matchState = "finished";
                stats.recordScore(state.homeScore, state.awayScore);
                return;
            }
        }
    }
    if (phase.halfTimePause > 0) {
        phase.halfTimePause -= sdt;
        if (phase.halfTimePause <= 0) kickoff(phase.nextKickoffTeam);
        tickAgents(sdt, false);
        cacheBallState();
        return;
    }
    double sec = sdt / 1000;
    updatePlayerAnimations(sdt);
    updatePossessionTracking(sdt);
    Player* possession = playerById(state.ball.controllerId);
    if (possession && possession->role != Role::GK) {
        Team team = possession->team;
        double fd = fdFor(team);
        double line = offsideLineFor(team);
        if (!std::isnan(line)) {
            for (auto& p : state.players) {
                if (p.team != team || p.id == possession->id || p.role == Role::GK) continue;
                bool beyondHalf = fd > 0.0 ? p.x > HALF_X : p.x < HALF_X;
                bool beyondBall = fd > 0.0 ? p.x > state.ball.x + OFFSIDE_TOLERANCE : p.x < state.ball.x - OFFSIDE_TOLERANCE;
                bool beyondLine = fd > 0.0 ? p.x > line + OFFSIDE_TOLERANCE : p.x < line - OFFSIDE_TOLERANCE;
                if (beyondHalf && beyondBall && beyondLine) stats.recordOffsidePosition(p.role, sdt);
            }
        }
    }
    if (pendingPass.active && !pendingPass.offsideExempt) {
        Player* receiver = playerById(pendingPass.toId);
        if (receiver && receiver->team == pendingPass.team) {
            double fd = fdFor(pendingPass.team);
            bool beyondHalf = fd > 0.0 ? receiver->x > HALF_X : receiver->x < HALF_X;
            bool beyondPasser = fd > 0.0 ? receiver->x > pendingPass.passerX + OFFSIDE_TOLERANCE : receiver->x < pendingPass.passerX - OFFSIDE_TOLERANCE;
            bool beyondLine = fd > 0.0 ? receiver->x > pendingPass.offsideLine + OFFSIDE_TOLERANCE : receiver->x < pendingPass.offsideLine - OFFSIDE_TOLERANCE;
            if (beyondHalf && beyondPasser && beyondLine) stats.recordOffsidePosition(receiver->role, sdt);
        }
    }
    detectSimulationFreeze(sdt);

    if (setPiece.armed) { updateSetPiecePhase(sdt, sec); return; }
    if (phase.kickoffPhase)   { updateKickoffPhase(sdt); return; }

    updateOpenPlayPhase(sdt, sec);
}
void GameEngine::updatePlayerAnimations(double sdt) {
    for (auto& p : state.players) {
        if (p.tackleAnim > 0) p.tackleAnim = std::max(0., p.tackleAnim - sdt);
        if (p.headingAnim > 0) p.headingAnim = std::max(0., p.headingAnim - sdt);
        if (p.crossCollected > 0) p.crossCollected = std::max(0., p.crossCollected - sdt);
        if (p.throughCollected > 0) p.throughCollected = std::max(0., p.throughCollected - sdt);
    }
}

void GameEngine::updatePossessionTracking(double sdt) {
    auto* c = playerById(state.ball.controllerId);
    if (c) {
        if (c->team == Team::Home) metrics.possessionHome += sdt;
        else metrics.possessionAway += sdt;
        double fd = fdFor(c->team);
        if (c->id != carrierTracker.carryTrackerId) {
            carrierTracker.carryTrackerId = c->id;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
            carrierTracker.carryPathDistance = 0;
        } else {
            double step = dist(c->x, c->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
            if (step < 45.0) carrierTracker.carryPathDistance += step;
            carrierTracker.carryLastX = c->x;
            carrierTracker.carryLastY = c->y;
        }
        if (c->id != carrierTracker.backwardCarryCarrierId) {
            carrierTracker.backwardCarryCarrierId = c->id;
            carrierTracker.backwardCarryStartX = c->x;
            carrierTracker.backwardCarryRecorded = false;
        } else if (!carrierTracker.backwardCarryRecorded && (c->x - carrierTracker.backwardCarryStartX) * fd < -200.0) {
            stats.recordLongBackwardCarry();
            carrierTracker.backwardCarryRecorded = true;
        }
        double carrierSpeed = std::hypot(c->vx, c->vy);
        double targetDistance = dist(c->x, c->y, c->targetX, c->targetY);
        bool stationaryOutfieldHold = !setPiece.armed && !phase.kickoffPhase && c->role != Role::GK
            && carrierSpeed < 8.0 && (targetDistance < 8.0 || c->dribbleType == 0);
        if (c->id != carrierTracker.stationaryHoldCarrierId || !stationaryOutfieldHold) {
            carrierTracker.stationaryHoldCarrierId = stationaryOutfieldHold ? c->id : -1;
            carrierTracker.stationaryHoldMs = 0;
            carrierTracker.stationaryHoldRecorded = false;
        } else if (!carrierTracker.stationaryHoldRecorded) {
            carrierTracker.stationaryHoldMs += sdt;
            if (carrierTracker.stationaryHoldMs >= 420.0) {
                carrierTracker.stationaryHoldRecorded = true;
                Player* best = nullptr;
                double bestD = 1e9;
                for (auto& p : state.players) {
                    if (p.team != c->team || p.id == c->id || p.role == Role::GK) continue;
                    double d = dist(c->x, c->y, p.x, p.y);
                    if (d < bestD) { bestD = d; best = &p; }
                }
                if (best && bestD < 360.0) {
                    forcePassTo(*c, *best, nullptr);
                } else {
                    double side = c->y < PITCH_H / 2.0 ? 1.0 : -1.0;
                    c->dribbleType = 2;
                    c->targetX = clamp(c->x + fd * 70.0, 35.0, PITCH_W - 35.0);
                    c->targetY = clamp(c->y + side * 42.0, 35.0, PITCH_H - 35.0);
                }
            }
        }
    } else {
        if (activeKnockAhead.active && activeKnockAhead.playerId >= 0) {
            Player* runner = playerById(activeKnockAhead.playerId);
            if (runner) {
                if (carrierTracker.carryTrackerId != runner->id) {
                    carrierTracker.carryTrackerId = runner->id;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                    carrierTracker.carryPathDistance = 0;
                } else {
                    double step = dist(runner->x, runner->y, carrierTracker.carryLastX, carrierTracker.carryLastY);
                    if (step < 45.0) carrierTracker.carryPathDistance += step;
                    carrierTracker.carryLastX = runner->x;
                    carrierTracker.carryLastY = runner->y;
                }
            }
        } else {
            carrierTracker.carryTrackerId = -1;
            carrierTracker.carryPathDistance = 0;
        }
        carrierTracker.backwardCarryCarrierId = -1;
        carrierTracker.backwardCarryRecorded = false;
        carrierTracker.stationaryHoldCarrierId = -1;
        carrierTracker.stationaryHoldMs = 0;
        carrierTracker.stationaryHoldRecorded = false;
    }
    stats.recordPossession(metrics.possessionHome, metrics.possessionAway);
    auditStuckCarrier(sdt);
}

void GameEngine::detectSimulationFreeze(double sdt) {
    if (setPiece.armed || phase.kickoffPhase) return;
    auto& fb = state.ball;
    int cid = fb.controllerId;
    if (cid < 0) {
        freezeDetector.freezeWatchMs = 0;
        freezeDetector.freezeLastController = -1;
    } else if (cid != freezeDetector.freezeLastController) {
        freezeDetector.freezeWatchMs = 0;
        freezeDetector.freezeBallX = fb.x;
        freezeDetector.freezeBallY = fb.y;
        freezeDetector.freezeLastController = cid;
    } else {
        freezeDetector.freezeWatchMs += sdt;
        Player* movingCarrier=playerById(cid);
        if(movingCarrier&&std::hypot(movingCarrier->vx,movingCarrier->vy)>12.0){
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
            return;
        }
        if (dist(fb.x, fb.y, freezeDetector.freezeBallX, freezeDetector.freezeBallY) >= 5) {
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
        } else if (freezeDetector.freezeWatchMs > 1500 && state.clockMs - freezeDetector.lastFreezeAlertMs > 5000) {
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
                stats.recordSimulationFreeze();
                forcePassTo(*frozen,*best,nullptr);
            }else if(frozen){
                stats.recordSimulationFreeze();
                double fd=fdFor(frozen->team);
                frozen->targetX=clamp(frozen->x+fd*90.0,35.0,PITCH_W-35.0);
                frozen->targetY=clamp(frozen->y+(frozen->y<PITCH_H/2?-45.0:45.0),35.0,PITCH_H-35.0);
            }else{
                freezeDetector.simulationFreezes++;
                stats.recordSimulationFreeze();
            }
            freezeDetector.lastFreezeAlertMs = state.clockMs;
            freezeDetector.freezeWatchMs = 0;
            freezeDetector.freezeBallX = fb.x;
            freezeDetector.freezeBallY = fb.y;
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
    phase.actionTimer -= sdt;
    Team spTeam = setPiece.team;

    // ── Populate throw-in support targets in blackboard (once per set piece) ──
    if (setPiece.type == SetPiece::ThrowIn) {
        auto& bb = blackboards[teamIndex(spTeam)];
        if (!bb.throwInSupport.active) {
            bb.throwInSupport.active = true;
            bb.throwInSupport.spotX = setPiece.spotX;
            bb.throwInSupport.spotY = setPiece.spotY;
            double fd = fdFor(spTeam);
            double bx = setPiece.spotX;
            double by = setPiece.spotY;
            for (auto& p : state.players) {
                if (p.team != spTeam || p.role == Role::GK) continue;
                if (p.id == setPiece.takerId) continue;
                double tx, ty;
                if (p.role == Role::CF) {
                    tx = bx + fd * 170.0;
                    ty = PITCH_H / 2.0 + std::cos(p.id * 2.3) * 60.0;
                } else if (p.role == Role::WM) {
                    if (std::abs(p.homeY - by) < PITCH_H * 0.35) {
                        tx = bx + fd * 85.0;
                        ty = by + (by < PITCH_H / 2.0 ? -50.0 : 50.0);
                    } else {
                        tx = bx + fd * 30.0;
                        ty = by < PITCH_H / 2.0 ? PITCH_H * 0.73 : PITCH_H * 0.27;
                    }
                } else if (p.role == Role::CM) {
                    double depth = 80.0 + std::abs(std::sin(p.id * 1.7)) * 80.0;
                    double lateral = std::sin(p.id * 2.1) * 110.0;
                    tx = bx + fd * depth;
                    ty = PITCH_H / 2.0 + lateral;
                } else if (p.role == Role::FB) {
                    tx = bx - fd * 25.0;
                    ty = p.homeY;
                } else {
                    tx = bx - fd * 55.0;
                    ty = p.homeY;
                }
                bb.throwInSupport.targetX[p.id] = clamp(tx, 35.0, PITCH_W - 35.0);
                bb.throwInSupport.targetY[p.id] = clamp(ty, 35.0, PITCH_H - 35.0);
            }
        }
    }

    for (auto& a : agents) {
        a->setPiecePositioning(setPiece.type, spTeam);
    }
    auto placeTakerForRestart = [&](Player& taker, bool releaseSpot) {
        double fd = fdFor(taker.team);
        double standBack = standBackFor(setPiece.type);
        double px = clamp(releaseSpot ? setPiece.spotX : setPiece.spotX - fd * standBack, 5.0, PITCH_W - 5.0);
        double py = clamp(setPiece.spotY, 5.0, PITCH_H - 5.0);
        if (releaseSpot) {
            taker.x = px;
            taker.y = py;
        } else {
            // Steer to the stand-back point; snapping every tick made the taker
            // vibrate against moveBallCarrier walking him toward the spot.
            double dx = px - taker.x, dy = py - taker.y;
            double d = std::hypot(dx, dy);
            double step = std::min(SPEED_SPRINT * (sdt / 1000.0), d);
            if (d > 0.5) { taker.x += dx / d * step; taker.y += dy / d * step; }
        }
        taker.targetX = px;
        taker.targetY = py;
        taker.vx = taker.vy = 0;
        if (dist(taker.x, taker.y, setPiece.spotX, setPiece.spotY) > 0.5) {
            taker.facing = std::atan2(setPiece.spotY - taker.y, setPiece.spotX - taker.x);
        }
    };
    auto enforceRestartDistance = [&]() {
        double minDist = minDistFor(setPiece.type);
        Team restartTeam = setPiece.team;
        double maxStep = SPEED_SPRINT * (sdt / 1000.0);
        bool pen = setPiece.type == SetPiece::Penalty;
        double fdAtt = fdFor(restartTeam);
        if (pen) {
            // The defending keeper belongs ON his line for a penalty — the
            // agent's GK early-return left him 6m off it.
            Team defTeam = restartTeam == Team::Home ? Team::Away : Team::Home;
            if (Player* dgk = findGK(defTeam)) {
                double gx = ownGoalXFor(defTeam);
                double lineX = gx + fdFor(defTeam) * 5.0;
                double mx = lineX - dgk->x, my = PITCH_H / 2.0 - dgk->y;
                double md = std::hypot(mx, my);
                double step = std::min(SPEED_SPRINT * 1.5 * (sdt / 1000.0), md);
                if (md > 0.5) { dgk->x += mx / md * step; dgk->y += my / md * step; }
            }
        }
        for (auto& p : state.players) {
            // For penalties EVERY outfielder obeys the law — attackers too.
            bool isTaker = p.id == setPiece.takerId;
            if (p.role == Role::GK || isTaker) continue;
            if (!pen && p.team == restartTeam) continue;
            double dx = p.x - setPiece.spotX;
            double dy = p.y - setPiece.spotY;
            double d = std::hypot(dx, dy);
            // Penalty law: everyone but taker and keeper must be BEHIND the
            // spot, not just 96px away — radial spacing let defenders stand
            // on the goal line and wall up the shot.
            bool goalSide = pen && (p.x - setPiece.spotX) * fdAtt > -12.0;
            if (d >= minDist && !goalSide) continue;
            if (d < 1.0) {
                double fd = fdFor(p.team);
                dx = -fd; dy = p.homeY < PITCH_H / 2.0 ? -0.35 : 0.35;
                d = std::hypot(dx, dy);
            }
            double tx = clamp(setPiece.spotX + dx / d * minDist, 5.0, PITCH_W - 5.0);
            double ty = clamp(setPiece.spotY + dy / d * minDist, 5.0, PITCH_H - 5.0);
            if (goalSide) {
                tx = clamp(setPiece.spotX - fdAtt * 40.0, 5.0, PITCH_W - 5.0);
                double sideOff = p.y >= setPiece.spotY ? 1.0 : -1.0;
                ty = clamp(setPiece.spotY + sideOff * std::max(std::abs(p.y - setPiece.spotY), 90.0), 5.0, PITCH_H - 5.0);
            }
            // Jog out of the restart radius rather than teleporting there.
            // Urgent pace: at walking speed the agents' own pull toward the
            // ball won the tug-of-war and FKs released with opponents at 5m.
            double mx = tx - p.x, my = ty - p.y;
            double md = std::hypot(mx, my);
            if (md > 0.1) {
                double step = std::min(maxStep * 1.9, md);
                p.x += mx / md * step;
                p.y += my / md * step;
                p.vx = mx / md * SPEED_SPRINT;
                p.vy = my / md * SPEED_SPRINT;
            } else {
                p.vx = p.vy = 0;
            }
            p.targetX = tx;
            p.targetY = ty;
        }
    };

    if (setPiece.takerId >= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPiece.takerId) {
                a->setPieceHold = true;
                break;
            }
        }
    }

    tickAgents(sdt, false);
    moveBallCarrier(sdt);
    separateTeammates(sdt);
    enforceRestartDistance();

    // Watchdog: a malformed arm (no taker, no controller) must never freeze
    // the match — disarm and let open play resume.
    if (setPiece.armed && setPiece.takerId < 0 && state.ball.controllerId < 0
        && setPiece.type != SetPiece::GoalKick && phase.actionTimer <= 0) {
        setPiece.armed = false;
        setPiece.type = SetPiece::None;
        setPiece.reason.clear();
        return;
    }
    if (setPiece.type == SetPiece::GoalKick && phase.actionTimer <= 0 && state.ball.controllerId >= 0) {
        setPiece.armed = false;
        setPiece.reason.clear();
        releaseSetPiece();
        cacheBallState();
        return;
    }

    if (setPiece.takerId >= 0 && !setPiece.takerArrived) {
        Player* taker = playerById(setPiece.takerId);
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

    if (setPiece.takerId >= 0 && !setPiece.takerArrived) {
        Player* taker = playerById(setPiece.takerId);
        if (taker) {
            double d = dist(taker->x, taker->y, state.ball.x, state.ball.y);
            if (d < 15.0) {
                setPiece.takerArrived = true;
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                phase.actionTimer = actionTimerFor(setPiece.type);
            }
        }
    }

    // Gate release on rough compliance: extend in 250ms steps (max ~1.2s)
    // while opponents are well inside the restraint distance.
    if (setPiece.takerArrived && phase.actionTimer <= 0 && phase.actionTimer > -1200.0
        && setPiece.type != SetPiece::ThrowIn) {
        double minDist = minDistFor(setPiece.type);
        for (auto& p : state.players) {
            if (p.team == setPiece.team || p.role == Role::GK) continue;
            if (dist(p.x, p.y, setPiece.spotX, setPiece.spotY) < minDist * 0.72) {
                phase.actionTimer -= sdt;   // keep counting the cap down
                cacheBallState();
                return;
            }
        }
    }
    if (setPiece.takerArrived && phase.actionTimer <= 0) {
        for (auto& a : agents) {
            if (a->player.id == setPiece.takerId) { a->setPieceHold = false; break; }
        }
        Player* taker = playerById(setPiece.takerId);
        if (taker) placeTakerForRestart(*taker, true);
        enforceRestartDistance();
        state.ball.x = setPiece.spotX;
        state.ball.y = setPiece.spotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
        setPiece.armed = false;
        setPiece.reason.clear();
        setPiece.takerId = -1;
        setPiece.takerArrived = false;
        releaseSetPiece();
    } else if (!setPiece.takerArrived && phase.actionTimer <= 0) {
        if (setPiece.takerId >= 0) {
            Player* taker = playerById(setPiece.takerId);
            // Still honestly walking and nearly there? Give him another stride
            // instead of teleporting (the 1550ms goal-kick budget was short).
            if (taker && dist(taker->x, taker->y, state.ball.x, state.ball.y) < 90.0
                && phase.actionTimer > -2500.0) {
                phase.actionTimer = 200.0;
                cacheBallState();
                return;
            }
            if (taker) {
                state.ball.controllerId = taker->id;
                state.ball.lastTouchTeam = taker->team;
                state.ball.lastToucherId = taker->id;
                taker->x = state.ball.x;
                taker->y = state.ball.y;
                taker->targetX = state.ball.x;
                taker->targetY = state.ball.y;
                setPiece.takerArrived = true;
                phase.actionTimer = actionTimerFor(setPiece.type);
            }
        }
    }
    updateControlledBall(sec);
    if (setPiece.takerArrived) {
        Player* taker = playerById(setPiece.takerId);
        if (taker) placeTakerForRestart(*taker, false);
        state.ball.x = setPiece.spotX;
        state.ball.y = setPiece.spotY;
        state.ball.vx = state.ball.vy = state.ball.z = state.ball.vz = 0;
    }
    cacheBallState();
}

void GameEngine::updateKickoffPhase(double sdt) {
    phase.actionTimer -= sdt;
    if (phase.actionTimer <= 0) { phase.kickoffPhase = false; kickoffTap(); }
    cacheBallState();
}

void GameEngine::updateOpenPlayPhase(double sdt, double sec) {
    updateSubstitutions();
    auto& b = state.ball;        if (b.controllerId >= 0) contestBlockedUntil[b.controllerId] = 0;
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
    if (goalKickMonitor.distributeTimer > 0) {
        goalKickMonitor.distributeTimer -= sdt;
        if (goalKickMonitor.distributeTimer <= 0) releaseSetPiece();
    }
    if (b.intendedReceiverId >= 0 && b.controllerId < 0) {
        Player* receiver = playerById(b.intendedReceiverId);
        if (receiver) {
            double ballSpeed = std::hypot(b.vx, b.vy);
            double rx = b.x - receiver->x;
            double ry = b.y - receiver->y;
            double receiverDist = std::hypot(rx, ry);
            double receiverSpeed = std::max(36.0, SPEED_SPRINT * attrFactor(receiver->attrs.speed));
            double leadTime = clamp(receiverDist / receiverSpeed, 0.14, 0.46);
            double maxLead = clamp(receiverDist * 0.72, 18.0, 74.0);
            double leadDist = std::min(ballSpeed * leadTime, maxLead);
            double targetX = b.x;
            double targetY = b.y;
            if (ballSpeed > 12.0) {
                targetX += (b.vx / ballSpeed) * leadDist;
                targetY += (b.vy / ballSpeed) * leadDist;
            }
            receiver->targetX = clamp(targetX, PLAYER_R, PITCH_W - PLAYER_R);
            receiver->targetY = clamp(targetY, PLAYER_R, PITCH_H - PLAYER_R);
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
        metrics.peakBallSpeed=std::max(metrics.peakBallSpeed,speed);
        metrics.looseBallSpeedTotal+=speed;
        metrics.looseBallSpeedSamples++;
        stats.recordBallSpeedSample(speed);
    }
    double jumpDx = state.ball.x - prevBallX;
    double jumpDy = state.ball.y - prevBallY;
    double jumpDist = std::hypot(jumpDx, jumpDy);
    double expectedSpeed = std::max(std::hypot(prevBallVx, prevBallVy), std::hypot(state.ball.vx, state.ball.vy));
    double expectedMax = expectedSpeed * sec + 20.0
        + (activeKnockAhead.active ? DRIBBLE_KNOCK_OFFSET : 0.0);
    bool recentImpulse = ballImpulseGraceTicks > 0;
    if (jumpDist > expectedMax && jumpDist > 25.0 && !recentImpulse && !setPiece.armed && !phase.kickoffPhase
        && state.ball.controllerId < 0) {
        stats.recordBallJump();
    }
    if (ballImpulseGraceTicks > 0) ballImpulseGraceTicks--;
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
        carrierTracker.watchedCarrierId=-1;
        carrierTracker.watchedCarrierMs=0;
        return;
    }
    if(carrier->id!=carrierTracker.watchedCarrierId){
        carrierTracker.watchedCarrierId=carrier->id;
        carrierTracker.watchedCarrierX=carrier->x; carrierTracker.watchedCarrierY=carrier->y;
        carrierTracker.watchedCarrierMs=0;
        return;
    }
    carrierTracker.watchedCarrierMs+=sdt;
    double moved=dist(carrier->x,carrier->y,carrierTracker.watchedCarrierX,carrierTracker.watchedCarrierY);
    double carrierSpeed=std::hypot(carrier->vx,carrier->vy);
    if(carrierSpeed>12.0){
        carrierTracker.watchedCarrierX=carrier->x; carrierTracker.watchedCarrierY=carrier->y;
        carrierTracker.watchedCarrierMs=0;
        return;
    }
    if(moved>STUCK_CARRIER_MOVE_THRESHOLD){
        carrierTracker.watchedCarrierX=carrier->x; carrierTracker.watchedCarrierY=carrier->y;
        carrierTracker.watchedCarrierMs=0;
        return;
    }
    double fd=fdFor(carrier->team);
    double forwardProgress=(carrier->x-carrierTracker.watchedCarrierX)*fd;
    if(forwardProgress>30.0){
        carrierTracker.watchedCarrierX=carrier->x; carrierTracker.watchedCarrierY=carrier->y;
        carrierTracker.watchedCarrierMs=0;
        return;
    }
    if(carrierTracker.watchedCarrierMs>STUCK_CARRIER_TIMEOUT_MS*0.65){
        stats.recordStuckCarrier();
        Player* best=nullptr; double bestD=1e9;
        for(auto&p:state.players){
            if(p.team!=carrier->team||p.id==carrier->id||p.role==Role::GK)continue;
            double d=dist(carrier->x,carrier->y,p.x,p.y);
            if(d<bestD){bestD=d; best=&p;}
        }
        if(best)forcePassTo(*carrier,*best,nullptr);
        else{auto&b=state.ball;b.controllerId=-1;b.vx=carrier->team==Team::Home?300:-300;b.vy=0;b.vz=80;b.z=0;}
        setPiece.armed=false;setPiece.type = SetPiece::None;setPiece.team = Team::Home;setPiece.reason.clear();
        carrierTracker.watchedCarrierMs=0;carrierTracker.watchedCarrierX=carrier->x;carrierTracker.watchedCarrierY=carrier->y;
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
    j["half"] = phase.half;
    j["addedTime"] = phase.addedTimeActive;
    j["addedTimeAnnouncedMin"] = static_cast<int>(phase.announcedAddedMs / 60000.0);
    j["version"] = nativeBuildVersion();
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
            {"tackleAnim", std::round(p.tackleAnim)}, {"headingAnim", std::round(p.headingAnim)},
            {"goals", pGoals[p.id]}, {"assists", pAssists[p.id]}, {"shots", pShots[p.id]},
            {"tackles", pTackles[p.id]}, {"yellow", yellowCards[p.id]},
            {"injured", p.injurySeverity > 0.05}
        });
    }

    // Forward every stats summary metric verbatim. getJSON builds its own
    // "events" array (from visualEvents) below, so drop the summary copy.
    // Two output keys differ from their produced names and are set explicitly:
    //   wrongTeammateTouches ← wrongTeammate (rename)
    //   penaltyGoals         ← setPieces.penaltiesScored (derived)
    nlohmann::json summary = nlohmann::json::parse(stats.summaryJSON());
    summary.erase("events");
    j.update(summary);
    j["wrongTeammateTouches"] = summary["wrongTeammate"];
    j.erase("wrongTeammate");
    j["penaltyGoals"] = summary["setPieces"]["penaltiesScored"];

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

    if (setPiece.armed) {
        j["setPieceState"] = {
            {"type", to_string(setPiece.type)},
            {"reason", setPiece.reason.empty() ? to_string(setPiece.type) : setPiece.reason},
            {"team", to_string(setPiece.team)},
            {"takerId", setPiece.takerId},
            {"takerArrived", setPiece.takerArrived},
            {"spotX", setPiece.spotX},
            {"spotY", setPiece.spotY},
            {"timerMs", phase.actionTimer}
        };
    }

    return j.dump();
}

// ══════════════════════════════════════════════════════════════
// Lifecycle — constructor, initWithSeed, createHomeTeam, createAwayTeam
// ══════════════════════════════════════════════════════════════

GameEngine::~GameEngine() = default;

GameEngine::GameEngine() {
    blackboards[0] = TeamBlackboard(); blackboards[1] = TeamBlackboard();
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
    initBench();
    lastReceiveFrom.fill(-1);
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

void GameEngine::creditGoal(int scorerId) {
    if (scorerId < 0 || scorerId >= 22) return;
    pGoals[scorerId]++;
    // Assist: the teammate who last fed the scorer, within ~12s of the goal.
    int passer = lastReceiveFrom[scorerId];
    if (passer >= 0 && passer < 22 && passer != scorerId
        && state.clockMs - lastReceiveMs[scorerId] < 12000.0) {
        Player* sc = playerById(scorerId);
        Player* as = playerById(passer);
        if (sc && as && sc->team == as->team) {
            pAssists[passer]++;
            emitEvent("assist", as->x, as->y, passer, scorerId);
        }
    }
}

void GameEngine::initBench() {
    // Reserve names per side — flavour only; attrs are a notch below the
    // starters (subs are squad players, not the legends they replace).
    static const char* homeRes[] = {"Pirlo","Casillas","Maldini","Zidane","Carlos","Puyol","Kaka","Villa"};
    static const char* awayRes[] = {"Cannavaro","Vidic","Pirlo","Toure","Sneijder","Silva","Aguero","Ferdinand"};
    for (int t = 0; t < 2; ++t) {
        bench[t].clear();
        for (int i = 0; i < 7; ++i) {
            PlayerAttributes a;
            auto roll = [&](double lo, double hi) { return lo + rng.random() * (hi - lo); };
            a.speed = roll(60, 84); a.passing = roll(58, 84); a.creativity = roll(55, 82);
            a.shooting = roll(50, 82); a.tackling = roll(55, 86); a.positioning = roll(60, 86);
            a.stamina = roll(74, 90);
            const char* nm = t == 0 ? homeRes[i % 8] : awayRes[i % 8];
            bench[t].push_back({nm, a, false});
        }
    }
    subsRemaining = {5, 5};
    nextSubCheckMs = 0;
}

void GameEngine::substituteSlot(Player& slot, BenchPlayer& in) {
    in.used = true;
    char prefix = slot.team == Team::Home ? 'H' : 'A';
    slot.name = std::format("{}{} {}", prefix, slot.id, in.name);
    slot.attrs = in.attrs;
    slot.stamina = 100.0;          // fresh legs
    slot.injurySeverity = 0.0;
    stats.recordSubstitution();
    emitEvent("sub", slot.x, slot.y, slot.id);
}

void GameEngine::updateSubstitutions() {
    // Manager check on a coarse cadence (deterministic — clock-driven). A team
    // brings someone on for an injured player immediately, or for a spent one
    // in the closing stretch, while subs remain.
    if (state.clockMs < nextSubCheckMs) return;
    nextSubCheckMs = state.clockMs + 8000.0;
    double minute = state.clockMs / 60000.0;
    for (int t = 0; t < 2; ++t) {
        if (subsRemaining[t] <= 0) continue;
        Team team = static_cast<Team>(t);
        Player* worst = nullptr;
        double worstScore = 0.0;
        bool injuredFound = false;
        for (auto& p : state.players) {
            if (p.team != team || p.role == Role::GK) continue;
            bool injured = p.injurySeverity > 0.18;
            // Spent: low stamina, and only once the game is worth burning a
            // sub on (after the hour, or any time if badly hurt).
            bool spent = p.stamina < 32.0 && minute > 58.0;
            if (!injured && !spent) continue;
            double score = (injured ? 100.0 + p.injurySeverity * 100.0 : 0.0) + (100.0 - p.stamina);
            if (score > worstScore) { worstScore = score; worst = &p; injuredFound = injured; }
        }
        if (!worst) continue;
        // Pick the freshest unused bench player.
        BenchPlayer* best = nullptr;
        double bestRating = -1.0;
        for (auto& b : bench[t]) {
            if (b.used) continue;
            double r = b.attrs.speed + b.attrs.passing + b.attrs.tackling + b.attrs.positioning;
            if (r > bestRating) { bestRating = r; best = &b; }
        }
        if (!best) continue;
        // A tired-but-not-injured swap only fires sometimes per window, so
        // teams don't empty the bench at minute 58 all at once.
        if (!injuredFound && rng.random() > 0.45) continue;
        substituteSlot(*worst, *best);
        subsRemaining[t]--;
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

namespace {
// Per-legend attribute identity: {speed, passing, creativity, shooting,
// tackling, positioning, stamina}. Random rolls made Messi play like
// Chiellini; these make the names mean something on the pitch.
PlayerAttributes legendAttrsFor(int id) {
    static const PlayerAttributes profiles[22] = {
        /* 0 Buffon      */ {50, 60, 55, 30, 45, 92, 70},
        /* 1 Dani Alves  */ {82, 78, 76, 60, 72, 74, 88},
        /* 2 Ramos       */ {74, 72, 60, 62, 90, 84, 84},
        /* 3 Pique       */ {62, 74, 62, 55, 86, 86, 78},
        /* 4 Marcelo     */ {84, 80, 82, 62, 65, 68, 84},
        /* 5 Iniesta     */ {70, 92, 94, 66, 55, 80, 80},
        /* 6 Xavi        */ {64, 96, 92, 60, 52, 86, 82},
        /* 7 Modric      */ {72, 92, 90, 70, 62, 82, 86},
        /* 8 Neymar      */ {90, 84, 95, 84, 40, 70, 80},
        /* 9 Messi       */ {91, 90, 97, 96, 38, 78, 82},
        /*10 Ronaldinho  */ {84, 88, 96, 82, 36, 68, 76},
        /*11 Neuer       */ {62, 75, 65, 35, 50, 94, 75},
        /*12 Lahm        */ {78, 84, 78, 58, 84, 88, 86},
        /*13 Van Dijk    */ {78, 76, 58, 60, 92, 90, 86},
        /*14 Chiellini   */ {68, 64, 50, 50, 94, 88, 82},
        /*15 Alba        */ {88, 78, 74, 60, 68, 72, 88},
        /*16 Kroos       */ {60, 95, 88, 78, 58, 84, 80},
        /*17 De Bruyne   */ {78, 95, 93, 86, 56, 80, 84},
        /*18 Busquets    */ {58, 90, 84, 50, 78, 90, 80},
        /*19 Robben      */ {88, 78, 86, 88, 40, 72, 76},
        /*20 Ronaldo     */ {92, 78, 84, 96, 40, 82, 90},
        /*21 Bale        */ {93, 76, 80, 88, 48, 70, 84},
    };
    if (id >= 0 && id < 22) return profiles[id];
    return PlayerAttributes{};
}

std::string legendNameFor(int id, Team team) {
    static const char* homeNames[] = {
        "Buffon", "Dani Alves", "Ramos", "Pique", "Marcelo", "Iniesta",
        "Xavi", "Modric", "Neymar", "Messi", "Ronaldinho"
    };
    static const char* awayNames[] = {
        "Neuer", "Lahm", "Van Dijk", "Chiellini", "Alba", "Kroos",
        "De Bruyne", "Busquets", "Robben", "Ronaldo", "Bale"
    };
    if (team == Team::Home && id >= 0 && id < 11) return std::format("H{} {}", id, homeNames[id]);
    if (team == Team::Away && id >= 11 && id < 22) return std::format("A{} {}", id, awayNames[id - 11]);
    return std::format("{}{}", to_string(team), id);
}
}

Player GameEngine::mkPlayer(int id, Team t, Role r, double hx, double hy) {
    // Legend profile with small per-match form variance (±4) so the same
    // names play recognizably while no two matches are identical.
    PlayerAttributes a = legendAttrsFor(id);
    auto form = [&](double v) { return clamp(v + rng.randomInt(-4, 4), 25.0, 99.0); };
    a.speed = form(a.speed); a.passing = form(a.passing); a.creativity = form(a.creativity);
    a.shooting = form(a.shooting); a.tackling = form(a.tackling); a.positioning = form(a.positioning);
    a.stamina = form(a.stamina);
    return Player{id, legendNameFor(id, t), t, r, hx, hy, 0, 0, hx, hy, hx, hy, 100.0,
        a, t == Team::Home ? 0.0 : PI};
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

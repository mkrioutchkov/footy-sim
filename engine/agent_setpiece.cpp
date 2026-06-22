#include "engine.h"
#include "agent.h"

void PlayerAI::setPiecePositioning(SetPiece spType, Team spTeam) {
    auto& p = player;
    if (isGoalkeeper()) return;
    bool attacking = (p.team == spTeam);
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    double ownGoalX = (p.team == Team::Home) ? 0.0 : PITCH_W;
    double oppGoalX = (p.team == Team::Home) ? PITCH_W : 0.0;
    double slotA = std::sin(p.id * 2.17);
    double slotB = std::cos(p.id * 1.61);

    if (attacking) {
        if (spType == SetPiece::Corner) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            bool nearPost = by < PITCH_H / 2.0;
            if (isCenterForward()) {
                p.targetX = oppGoalX - fd * (80.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + (nearPost ? -40.0 : 40.0) + slotB * 15.0;
            } else if (isWidePlayer()) {
                p.targetX = oppGoalX - fd * (50.0 + slotA * 15.0);
                p.targetY = nearPost ? PITCH_H * 0.25 : PITCH_H * 0.75;
            } else if (isCentralMidfielder()) {
                p.targetX = oppGoalX - fd * (120.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + slotB * 40.0;
            } else {
                p.targetX = lerp(p.x, oppGoalX - fd * 150.0, 0.6);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.3);
            }
        } else if (spType == SetPiece::Penalty) {
            if (isCenterForward() || isCentralMidfielder()) {
                p.targetX = engine.state.ball.x - fd * (45.0 + std::abs(slotA) * 55.0);
                p.targetY = PITCH_H / 2.0 + slotB * 110.0;
            } else {
                p.targetX = engine.state.ball.x - fd * (90.0 + std::abs(slotA) * 80.0);
                p.targetY = p.homeY;
            }
        } else if (spType == SetPiece::FreeKick) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            if (isCenterForward()) {
                p.targetX = oppGoalX - fd * (60.0 + slotA * 15.0);
                p.targetY = PITCH_H / 2.0 + slotB * 30.0;
            } else if (isCentralMidfielder()) {
                p.targetX = bx - fd * (35.0 + std::abs(slotA) * 55.0);
                p.targetY = by + slotB * 80.0;
            } else if (isWideMidfielder()) {
                p.targetX = bx + fd * (25.0 + slotA * 35.0);
                p.targetY = by + slotB * 115.0;
            } else if (isDefenderRole()) {
                p.targetX = bx - fd * (75.0 + std::abs(slotA) * 60.0);
                p.targetY = by + slotB * 95.0;
            } else {
                p.targetX = lerp(p.x, bx, 0.3);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.2);
            }
        } else if (spType == SetPiece::ThrowIn) {
            auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
            if (bb.throwInSupport.active && bb.throwInSupport.targetX[p.id] != 0.0) {
                p.targetX = bb.throwInSupport.targetX[p.id];
                p.targetY = bb.throwInSupport.targetY[p.id];
            } else {
                double bx = engine.state.ball.x;
                double by = engine.state.ball.y;
                p.targetX = bx + fd * (60.0 + slotA * 40.0);
                p.targetY = by + slotB * 80.0;
            }
        }
    } else {
        if (spType == SetPiece::Corner) {
            double by = engine.state.ball.y;
            bool nearTop = by < PITCH_H / 2.0;
            if (isDefenderRole()) {
                bool postGuard = isFullBack();
                p.targetX = ownGoalX + fd * (postGuard ? 42.0 : 68.0);
                if (postGuard) {
                    p.targetY = nearTop
                        ? (p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.25 : PITCH_H * 0.66)
                        : (p.homeY > PITCH_H / 2.0 ? PITCH_H * 0.75 : PITCH_H * 0.34);
                } else {
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -54.0 : 54.0);
                }
            } else if (isCentralMidfielder()) {
                p.targetX = ownGoalX + fd * (118.0 + std::abs(slotA) * 22.0);
                p.targetY = PITCH_H / 2.0 + (p.id % 3 - 1) * 58.0;
            } else {
                p.targetX = ownGoalX + fd * 185.0;
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.25);
            }
        } else if (spType == SetPiece::Penalty) {
            if (isGoalkeeper()) {
                p.targetX = ownGoalX;
                p.targetY = PITCH_H / 2.0;
            } else if (isDefenderRole()) {
                p.targetX = engine.state.ball.x + fd * (45.0 + std::abs(slotA) * 55.0);
                p.targetY = PITCH_H / 2.0 + slotB * 120.0;
            } else {
                p.targetX = engine.state.ball.x + fd * (75.0 + std::abs(slotA) * 75.0);
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.35);
            }
        } else if (spType == SetPiece::FreeKick) {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            double goalDist = std::abs(bx - ownGoalX);
            if (goalDist < 250.0) {
                if (isFullBack()) {
                    double wallY = lerp(by, PITCH_H / 2.0, 0.65) + (p.homeY < PITCH_H / 2.0 ? -18.0 : 18.0);
                    p.targetX = bx + fd * 32.0;
                    p.targetY = wallY;
                } else if (isCenterBack()) {
                    p.targetX = ownGoalX + fd * 72.0;
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -46.0 : 46.0);
                } else if (isCentralMidfielder()) {
                    p.targetX = ownGoalX + fd * 118.0;
                    p.targetY = PITCH_H / 2.0 + (p.id % 3 - 1) * 52.0;
                } else {
                    p.targetX = ownGoalX + fd * 185.0;
                    p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.2);
                }
            } else {
                p.targetX = lerp(p.x, ownGoalX + fd * 100.0, 0.4);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.2);
            }
        } else {
            p.targetX = lerp(p.x, ownGoalX + fd * 120.0, 0.3);
            p.targetY = lerp(p.y, PITCH_H / 2.0, 0.15);
        }
    }

    p.targetX = clamp(p.targetX, 35.0, PITCH_W - 35.0);
    p.targetY = clamp(p.targetY, 35.0, PITCH_H - 35.0);
}

// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════

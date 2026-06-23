#include "agent.h"
#include "engine.h"
#include <algorithm>

// ══════════════════════════════════════════════════════════════════════════════
// scorePositioning() helpers — each adds PositionCandidate entries to `c`
// ══════════════════════════════════════════════════════════════════════════════

// ── Base home-position candidates (always added) ─────────────────────────────
void PlayerAI::posBaseCandidates(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc) {
    const auto& p = player;
    auto& b = engine.state.ball;

    c = {
        { p.homeX + pc.pushUp + pc.widthPush, p.homeY, ActionPurpose::Cover },
        { p.homeX + pc.fd * 30.0 + pc.pushUp + pc.widthPush, p.homeY, ActionPurpose::Cover },
        { p.homeX - pc.fd * 20.0 + pc.pushUp + pc.widthPush, p.homeY, ActionPurpose::Cover },
        { p.homeX + pc.pushUp + pc.widthPush, p.homeY - 25.0, ActionPurpose::Cover },
        { p.homeX + pc.pushUp + pc.widthPush, p.homeY + 25.0, ActionPurpose::Cover },
        { lerp(p.homeX, b.x, 0.15) + pc.pushUp, lerp(p.homeY, b.y, 0.10), ActionPurpose::Cover },
    };

    int topCount = 0, botCount = 0;
    for (auto& o : engine.state.players) {
        if (dist(p.x, p.y, o.x, o.y) >= POS_OPPONENT_TRACK_DIST) continue;
        if (o.y < PITCH_H / 2.0) topCount++;
        else                      botCount++;
    }
    int openFlank = (topCount < botCount) ? -1 : 1;
    c.push_back({ p.homeX + pc.pushUp, clamp(p.homeY + openFlank * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
}

// ── Defensive retreat when out of possession and ball not loose ──────────────
void PlayerAI::posDefensiveCover(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per) {
    if (pc.myTeam || per.ballIsLoose) return;

    const auto& p = player;
    auto& b = engine.state.ball;

    double og = ownGoalXFor(p.team);
    double rx = clamp(lerp(p.x, og, 0.5), og, p.x);
    c.push_back({ rx, p.homeY, ActionPurpose::Cover });
    c.push_back({ rx, p.homeY - 30.0, ActionPurpose::Cover });
    c.push_back({ rx, p.homeY + 30.0, ActionPurpose::Cover });

    bool ballPastUs = (pc.fd == 1.0) ? b.x > p.x + 20.0 : b.x < p.x - 20.0;
    if (ballPastUs && isDefenderLike()) {
        c.push_back({ rx - pc.fd * 30.0, p.homeY, ActionPurpose::Cover });
        c.push_back({ rx - pc.fd * 30.0, p.homeY - 25.0, ActionPurpose::Cover });
    }

    double carrierDepth = (b.x - og) * pc.fd;
    bool immediateDanger = carrierDepth < 260.0;
    if (!immediateDanger && isCenterForward()) {
        c.push_back({ clamp(HALF_X + pc.fd * 95.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::CounterOutlet });
        c.push_back({ clamp(HALF_X + pc.fd * 70.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + ((b.y < PITCH_H / 2.0) ? 45.0 : -45.0), 80.0, PITCH_H - 80.0), ActionPurpose::CounterOutlet });
    }
    if (!immediateDanger && isWideMidfielder() && std::abs(p.homeY - b.y) > 190.0) {
        c.push_back({ clamp(HALF_X + pc.fd * 45.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::RestForward });
    }
}

// ── Ball-far and very-far distance offers ────────────────────────────────────
void PlayerAI::posBallFarOffers(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per) {
    const auto& p = player;
    auto& b = engine.state.ball;

    if (per.ballDist > POS_BALL_FAR_DIST) {
        if (pc.myTeam && pc.inPossession == p.team) {
            c.push_back({ p.homeX + pc.fd * 60.0 + pc.pushUp, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? 40.0 : -40.0), 50.0, PITCH_H - 50.0), ActionPurpose::Offer });
            if (isWideMidfielder() || isFullBack())
                c.push_back({ p.homeX + pc.fd * 40.0 + pc.pushUp, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        } else if (!pc.myTeam) {
            c.push_back({ p.homeX - pc.fd * 40.0, p.homeY, ActionPurpose::Cover });
            if (isCentralMidfielder() || isCenterForward())
                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), ActionPurpose::Cover });
        }
    }

    if (per.ballDist > POS_BALL_VERY_FAR_DIST && !per.iAmController) {
        c.push_back({ lerp(p.x, b.x, 0.15), lerp(p.y, b.y, 0.12), ActionPurpose::Observe });
        c.push_back({ lerp(p.x, b.x, 0.10), clamp(lerp(p.y, b.y, 0.08), 40.0, PITCH_H - 40.0), ActionPurpose::Observe });
    }
}

// Clamp an attacking run target to the legal (onside) shoulder. Deep candidates
// without this clamp left the CF loitering ~45s/match in offside positions.
double PlayerAI::clampToLegalX(double x, double fd) const {
    double line = engine.offsideLineFor(player.team);
    if (std::isnan(line)) return x;
    double shoulder = fd > 0.0
        ? std::max(line, engine.state.ball.x) - 12.0
        : std::min(line, engine.state.ball.x) + 12.0;
    return fd > 0.0 ? std::min(x, shoulder) : std::max(x, shoulder);
}

// ── All in-possession attacking support and role-specific runs ───────────────
void PlayerAI::posAttackingSupport(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per) {
    const auto& p = player;
    auto& b = engine.state.ball;

    // Carrier pressure support
    if (pc.myTeam && !per.iAmController) {
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team) {
            int carrierPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, carrier->x, carrier->y) < 60.0) carrierPressure++;
            }
            if (carrierPressure >= 2) {
                c.push_back({ lerp(p.x, carrier->x, 0.3), lerp(p.y, carrier->y, 0.25), ActionPurpose::Offer });
                c.push_back({ lerp(p.x, carrier->x, 0.2), clamp(lerp(p.y, carrier->y, 0.15), 40.0, PITCH_H - 40.0), ActionPurpose::Offer });
            }
            if (isWideMidfielder()) {
                bool sameSide = std::abs(carrier->y - p.homeY) < 190.0;
                double flankY = (p.homeY < PITCH_H / 2.0) ? 24.0 : PITCH_H - 24.0;
                double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.42, 65.0, PITCH_H - 65.0);
                double oppGoalX = goalXFor(p.team);
                if (sameSide && !engine.agentFor(*carrier)->isWideMidfielder()) {
                    c.push_back({ clamp(carrier->x + pc.fd * 150.0, 55.0, PITCH_W - 55.0), flankY, ActionPurpose::RunAhead });
                    c.push_back({ clamp(carrier->x + pc.fd * 120.0, 55.0, PITCH_W - 55.0), insideY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(oppGoalX - pc.fd * 175.0, 55.0, PITCH_W - 55.0), flankY, ActionPurpose::HoldWidth });
                } else if (!sameSide && pc.ballAdvance > 0.42) {
                    double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
                    c.push_back({ clamp(clampToLegalX(oppGoalX - pc.fd * 115.0, pc.fd), 55.0, PITCH_W - 55.0), farPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(clampToLegalX(oppGoalX - pc.fd * 185.0, pc.fd), 55.0, PITCH_W - 55.0), flankY, ActionPurpose::HoldWidth });
                }
            }
            if (isCenterForward()) {
                double oppGoalX = goalXFor(p.team);
                bool carrierWide = std::abs(carrier->y - PITCH_H / 2.0) > 130.0;
                bool carrierAdvanced = (carrier->x - ownGoalXFor(p.team)) * pc.fd > PITCH_W * 0.48;
                if (carrierWide && carrierAdvanced) {
                    double nearPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.35 : PITCH_H * 0.65;
                    double farPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.65 : PITCH_H * 0.35;
                    c.push_back({ clamp(clampToLegalX(oppGoalX - pc.fd * 58.0, pc.fd), 55.0, PITCH_W - 55.0), nearPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(clampToLegalX(oppGoalX - pc.fd * 86.0, pc.fd), 55.0, PITCH_W - 55.0), farPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(clampToLegalX(oppGoalX - pc.fd * 125.0, pc.fd), 55.0, PITCH_W - 55.0), PITCH_H / 2.0, ActionPurpose::Offer });
                }
                if (!carrierWide && carrierAdvanced) {
                    double side = p.homeY < PITCH_H / 2.0 ? -1.0 : 1.0;
                    c.push_back({ clamp(carrier->x + pc.fd * 104.0, 55.0, PITCH_W - 55.0),
                                  clamp(PITCH_H / 2.0 + side * 36.0, PITCH_H * 0.26, PITCH_H * 0.74),
                                  ActionPurpose::RunAhead });
                }
            }
        }
    }

    // Recent pass response
    auto* rp2 = engine.qRecentPass();
    if (rp2 && engine.state.clockMs - rp2->clockMs < 600.0) {
        if (rp2->team == p.team && dist(p.x, p.y, rp2->bx, rp2->by) < POS_RECENT_PASS_DIST) {
            c.push_back({ lerp(p.x, rp2->bx, 0.12), lerp(p.y, rp2->by, 0.10), ActionPurpose::Offer });
        }
    }

    // ── In-possession general + role-specific runs ──
    if (!pc.myTeam || pc.inPossession != p.team) return;

    c.push_back({ p.homeX + pc.fd * 80.0 + pc.pushUp, p.homeY, ActionPurpose::Offer });
    c.push_back({ p.homeX + pc.fd * 50.0 + pc.pushUp, p.homeY - 35.0, ActionPurpose::Space });
    c.push_back({ p.homeX + pc.fd * 50.0 + pc.pushUp, p.homeY + 35.0, ActionPurpose::Space });

    // CF/WM offside-aware runs
    if ((isCenterForward() || isWideMidfielder()) && !per.iAmController) {
        double line = engine.offsideLineFor(p.team);
        if (!std::isnan(line)) {
            double legalShoulder = pc.fd > 0.0 ? std::max(line, b.x) - 6.0 : std::min(line, b.x) + 6.0;
            double checkBackX = pc.fd > 0.0 ? std::min(p.x - 28.0, legalShoulder - 18.0) : std::max(p.x + 28.0, legalShoulder + 18.0);
            double insideY = clamp(lerp(p.y, PITCH_H / 2.0, isCenterForward() ? 0.28 : 0.18), 50.0, PITCH_H - 50.0);
            c.push_back({ clamp(legalShoulder, 55.0, PITCH_W - 55.0), p.y, ActionPurpose::Offer });
            c.push_back({ clamp(checkBackX, 55.0, PITCH_W - 55.0), insideY, ActionPurpose::Offer });
            if (pc.ballAdvance > 0.48) {
                double channelY = isCenterForward()
                    ? clamp(PITCH_H / 2.0 + ((p.homeY < PITCH_H / 2.0) ? -34.0 : 34.0), PITCH_H * 0.27, PITCH_H * 0.73)
                    : clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.54, PITCH_H * 0.18, PITCH_H * 0.82);
                double shoulderX = clamp(legalShoulder - pc.fd * 3.0, 55.0, PITCH_W - 55.0);
                c.push_back({ shoulderX, channelY, isCenterForward() ? ActionPurpose::RunAhead : ActionPurpose::InsideRun });
                if (pc.ballAdvance > 0.58) {
                    c.push_back({ clamp(legalShoulder + pc.fd * 32.0, 55.0, PITCH_W - 55.0),
                                  clamp(channelY + ((p.homeY < PITCH_H / 2.0) ? 28.0 : -28.0), PITCH_H * 0.2, PITCH_H * 0.8),
                                  ActionPurpose::RunAhead });
                }
            }
            if (isCenterForward() && pc.ballAdvance > 0.54) {
                double cutbackX = clamp(goalXFor(p.team) - pc.fd * 155.0, 55.0, PITCH_W - 55.0);
                bool cutbackOffside = pc.fd > 0.0 ? cutbackX > legalShoulder : cutbackX < legalShoulder;
                if (cutbackOffside) cutbackX = legalShoulder;
                c.push_back({ cutbackX, PITCH_H / 2.0, ActionPurpose::Offer });
                c.push_back({ cutbackX, clamp(PITCH_H / 2.0 + (p.homeY < PITCH_H / 2.0 ? -38.0 : 38.0), PITCH_H * 0.28, PITCH_H * 0.72), ActionPurpose::Space });
            }
        }
    }

    // One-two response
    auto& bb2 = engine.blackboards[GameEngine::teamIndex(p.team)];
    if (bb2.oneTwo.has_value() && bb2.oneTwo->from == p.id && engine.state.clockMs < bb2.oneTwo->expires) {
        double oppGoalX = goalXFor(p.team);
        c.push_back({ clampRange(p.x + pc.fd * 80.0, p.homeX + pc.fd * 40.0, oppGoalX), p.y, ActionPurpose::Space });
        c.push_back({ clampRange(p.x + pc.fd * 120.0, p.homeX + pc.fd * 60.0, oppGoalX), clamp(p.y - 30.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        c.push_back({ clampRange(p.x + pc.fd * 120.0, p.homeX + pc.fd * 60.0, oppGoalX), clamp(p.y + 30.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
    }

    // Random box entries by role
    if (pc.ballAdvance > 0.6 && isCenterForward()) {
        double bGoalX = goalXFor(p.team);
        c.push_back({ clampToLegalX(bGoalX - pc.fd * (35.0 + engine.rng.random() * 55.0), pc.fd),
                      clamp(PITCH_H / 2.0 + (engine.rng.random() - 0.5) * 90.0, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Space });
        c.push_back({ clampToLegalX(bGoalX - pc.fd * (70.0 + engine.rng.random() * 65.0), pc.fd),
                      clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.25, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Offer });
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team && (engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack())
            && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
            && std::abs(carrier->x - bGoalX) < 430.0) {
            double ballSide = carrier->y < PITCH_H / 2.0 ? -1.0 : 1.0;
            c.push_back({ clampToLegalX(bGoalX - pc.fd * 62.0, pc.fd), clamp(PITCH_H / 2.0 + ballSide * 34.0, PITCH_H * 0.28, PITCH_H * 0.72), ActionPurpose::Offer });
            c.push_back({ clampToLegalX(bGoalX - pc.fd * 105.0, pc.fd), clamp(PITCH_H / 2.0 - ballSide * 24.0, PITCH_H * 0.28, PITCH_H * 0.72), ActionPurpose::Space });
        }
    } else if (pc.ballAdvance > 0.6 && isWideMidfielder()) {
        double bGoalX = goalXFor(p.team);
        double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
        double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.32, PITCH_H * 0.24, PITCH_H * 0.76);
        c.push_back({ clampToLegalX(bGoalX - pc.fd * (70.0 + engine.rng.random() * 75.0), pc.fd), farPostY, ActionPurpose::Space });
        c.push_back({ clampToLegalX(bGoalX - pc.fd * (125.0 + engine.rng.random() * 85.0), pc.fd), insideY, ActionPurpose::Offer });
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team && (engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack())
            && std::abs(carrier->homeY - p.homeY) > 160.0
            && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
            && std::abs(carrier->x - bGoalX) < 430.0) {
            c.push_back({ clampToLegalX(bGoalX - pc.fd * 70.0, pc.fd), farPostY, ActionPurpose::Offer });
            c.push_back({ clampToLegalX(bGoalX - pc.fd * 120.0, pc.fd), insideY, ActionPurpose::Space });
        }
    } else if (pc.ballAdvance > 0.6 && isCentralMidfielder()) {
        double bGoalX = goalXFor(p.team);
        double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ bGoalX - pc.fd * (150.0 + engine.rng.random() * 85.0),
                      clamp(PITCH_H / 2.0 - bSide * 55.0, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Offer });
        c.push_back({ bGoalX - pc.fd * (180.0 + engine.rng.random() * 90.0),
                      clamp(PITCH_H / 2.0 + bSide * 70.0, PITCH_H * 0.24, PITCH_H * 0.76), ActionPurpose::Space });
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team && (engine.agentFor(*carrier)->isWideMidfielder() || engine.agentFor(*carrier)->isFullBack())
            && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
            && std::abs(carrier->x - bGoalX) < 450.0) {
            double ballSide = carrier->y < PITCH_H / 2.0 ? -1.0 : 1.0;
            c.push_back({ bGoalX - pc.fd * 165.0, PITCH_H / 2.0, ActionPurpose::Offer });
            c.push_back({ bGoalX - pc.fd * 135.0,
                          clamp(PITCH_H / 2.0 - ballSide * 46.0, PITCH_H * 0.27, PITCH_H * 0.73),
                          ActionPurpose::Space });
            c.push_back({ bGoalX - pc.fd * 210.0,
                          clamp(PITCH_H / 2.0 + ballSide * 58.0, PITCH_H * 0.24, PITCH_H * 0.76),
                          ActionPurpose::Offer });
        }
    }

    // CM gap positioning
    if (isCentralMidfielder()) {
        double midSum = 0, defSum = 0;
        int midCount = 0, defCount = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team) continue;
            if (engine.agentFor(o)->isCentralMidfielder() || engine.agentFor(o)->isWideMidfielder()) { midSum += o.x; midCount++; }
            if (engine.agentFor(o)->isDefenderRole()) { defSum += o.x; defCount++; }
        }
        if (midCount > 0 && defCount > 0) {
            double midLine = midSum / midCount;
            double defLine = defSum / defCount;
            double gapX = (midLine + defLine) / 2.0;
            c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), p.homeY, ActionPurpose::Offer });
            c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), clamp(p.homeY - 40.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        }
        if (pc.ballAdvance < 0.35 && pc.myTeam) {
            c.push_back({ clamp(p.homeX - pc.fd * 30.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::Offer });
            c.push_back({ clamp(p.homeX - pc.fd * 20.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + 35.0, 40.0, PITCH_H - 40.0), ActionPurpose::Offer });
        }
        double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ clamp(p.homeX + pc.fd * 30.0 + pc.pushUp, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        c.push_back({ clamp(p.homeX + pc.fd * 110.0 + pc.pushUp, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + bSide * 55.0, 50.0, PITCH_H - 50.0), ActionPurpose::Offer });
        c.push_back({ clamp(b.x + pc.fd * 90.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 35.0, 45.0, PITCH_H - 45.0), ActionPurpose::Space });
    }

    // WM flank/cross
    if (isWideMidfielder()) {
        double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
        ActionPurpose crossPur = pc.ballAdvance > 0.45 ? ActionPurpose::Offer : ActionPurpose::Space;
        c.push_back({ clamp(p.homeX + pc.fd * 80.0 + pc.pushUp, 60.0, PITCH_W - 60.0), flankY, crossPur });
        c.push_back({ clampRange(b.x + pc.fd * 115.0, p.homeX + pc.fd * 80.0, goalXFor(p.team) - pc.fd * 45.0), flankY, ActionPurpose::CrossLane });
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team && (engine.agentFor(*carrier)->isCentralMidfielder() || engine.agentFor(*carrier)->isCenterBack())
            && std::abs(carrier->y - PITCH_H / 2.0) < 215.0
            && std::abs(carrier->x - goalXFor(p.team)) > 260.0) {
            c.push_back({ clampRange(carrier->x + pc.fd * 210.0, p.homeX + pc.fd * 120.0, goalXFor(p.team) - pc.fd * 65.0),
                          flankY, ActionPurpose::HoldWidth });
            c.push_back({ clampRange(carrier->x + pc.fd * 255.0, p.homeX + pc.fd * 150.0, goalXFor(p.team) - pc.fd * 45.0),
                          clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), ActionPurpose::CrossLane });
        }
        double runBehindY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.3 : PITCH_H * 0.7;
        c.push_back({ clamp(p.homeX + pc.fd * 140.0 + pc.pushUp, 60.0, PITCH_W - 60.0), runBehindY, ActionPurpose::Space });
        if (std::abs(b.y - p.homeY) > 200.0) {
            c.push_back({ clamp(p.homeX + pc.fd * 100.0 + pc.pushUp, 60.0, PITCH_W - 60.0), clamp(lerp(p.y, PITCH_H / 2.0, 0.3), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            c.push_back({ clamp(p.homeX + pc.fd * 80.0 + pc.pushUp, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + ((p.homeY < PITCH_H / 2.0) ? 80.0 : -80.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        }
    }

    // Defender forward push
    if (isDefenderRole())
        c.push_back({ p.homeX + pc.fd * 150.0 + pc.pushUp, p.homeY, ActionPurpose::Cover });

    // General field positioning
    double fld = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
    c.push_back({ p.homeX + pc.fd * 55.0 + pc.pushUp, clamp(p.homeY + fld * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
    c.push_back({ p.homeX + pc.fd * 40.0 + pc.pushUp, clamp(p.homeY - fld * 70.0, 40.0, PITCH_H - 40.0), ActionPurpose::Switch });
    if (isWideMidfielder() || isFullBack())
        c.push_back({ p.homeX + pc.fd * 40.0 + pc.pushUp, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), ActionPurpose::Space });

    // FB overlap/support
    if (isFullBack() && pc.myTeam) {
        Player* wmOnMySide = nullptr;
        for (auto& o : engine.state.players) {
            if (o.team == p.team && engine.agentFor(o)->isWideMidfielder() && std::abs(o.homeY - p.homeY) < 100.0) {
                wmOnMySide = &o; break;
            }
        }
        bool wmHasBall = wmOnMySide && engine.state.ball.controllerId == wmOnMySide->id;
        if (wmHasBall) {
            c.push_back({ clampRange(wmOnMySide->x + pc.fd * 80.0, p.homeX + pc.fd * 80.0, goalXFor(p.team) - pc.fd * 20.0),
                          clamp((p.homeY < PITCH_H / 2.0) ? 35.0 : PITCH_H - 35.0, 35.0, PITCH_H - 35.0), ActionPurpose::Space });
            c.push_back({ clampRange(wmOnMySide->x + pc.fd * 50.0, p.homeX + pc.fd * 50.0, goalXFor(p.team)),
                          clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        } else if (Player* supportCarrier = engine.playerById(engine.state.ball.controllerId);
                   supportCarrier && supportCarrier->team == p.team
                   && (engine.agentFor(*supportCarrier)->isCentralMidfielder() || engine.agentFor(*supportCarrier)->isCenterBack())
                   && std::abs(supportCarrier->y - p.homeY) < 185.0 && pc.ballAdvance > 0.28) {
            double flankY = p.homeY < PITCH_H / 2.0 ? 36.0 : PITCH_H - 36.0;
            c.push_back({ clampRange(supportCarrier->x + pc.fd * 180.0, p.homeX + pc.fd * 95.0, goalXFor(p.team) - pc.fd * 45.0),
                          flankY, pc.ballAdvance > 0.48 ? ActionPurpose::CrossLane : ActionPurpose::Overlap });
            c.push_back({ clampRange(supportCarrier->x + pc.fd * 130.0, p.homeX + pc.fd * 75.0, goalXFor(p.team) - pc.fd * 80.0),
                          clamp((p.homeY < PITCH_H / 2.0) ? 58.0 : PITCH_H - 58.0, 40.0, PITCH_H - 40.0), ActionPurpose::Overlap });
        } else {
            double wmHomeY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.12 : PITCH_H * 0.88;
            c.push_back({ p.homeX + pc.fd * 120.0 + pc.pushUp, clamp(wmHomeY, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            c.push_back({ clamp(p.homeX + pc.fd * 185.0 + pc.pushUp, 60.0, PITCH_W - 60.0), clamp(wmHomeY, 40.0, PITCH_H - 40.0), ActionPurpose::Overlap });
        }
        // #2 penetration (overlap-run): in SETTLED final-third possession the FB pushes
        // proactively to the byline to join the attack — not only when a teammate carries
        // right alongside (the situational candidates above). Gated on an OPEN destination
        // so a turnover doesn't strand the FB. Post-#35 (realistic attrs) the extra close
        // chances this manufactures no longer re-inflate goals (that was why it was parked).
        if (pc.ballAdvance > 0.55) {
            double flankY = (p.homeY < PITCH_H / 2.0) ? 42.0 : PITCH_H - 42.0;
            double bylineX = clampRange(goalXFor(p.team) - pc.fd * 120.0,
                                        p.homeX + pc.fd * 110.0, goalXFor(p.team) - pc.fd * 55.0);
            bool destOpen = true;
            for (auto& o : engine.state.players) {
                if (o.team == p.team || o.role == Role::GK) continue;
                if (std::abs(o.x - bylineX) < 90.0 && std::abs(o.y - flankY) < 70.0) { destOpen = false; break; }
            }
            if (destOpen)
                c.push_back({ bylineX, clamp(flankY, 40.0, PITCH_H - 40.0), ActionPurpose::Overlap });
        }
    }

    // CF defender line
    if (isCenterForward()) {
        double oppGoalX = goalXFor(p.team);
        double ld = (pc.fd == 1.0) ? -1e9 : 1e9;
        bool anyDefenders = false;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK) {
                anyDefenders = true;
                ld = (pc.fd == 1.0) ? std::max(ld, o.x) : std::min(ld, o.x);
            }
        }
        if (anyDefenders) {
            double defLine = clampRange(ld, p.homeX - pc.fd * 40.0, oppGoalX + pc.fd * 20.0);
            double pushX = (pc.fd == 1.0) ? std::min(p.homeX + pc.fd * 100.0, ld - 15.0) : std::max(p.homeX + pc.fd * 100.0, ld + 15.0);
            c.push_back({ pushX, p.homeY, ActionPurpose::Offer });
            double runY = clamp(p.homeY + ((engine.rng.random() > 0.5) ? 40.0 : -40.0), PITCH_H * 0.2, PITCH_H * 0.8);
            c.push_back({ clampRange(defLine - pc.fd * 10.0, p.homeX + pc.fd * 40.0, oppGoalX), runY, ActionPurpose::Space });
        }
        if (pc.ballAdvance < 0.5 && pc.myTeam) {
            c.push_back({ clamp(p.homeX - pc.fd * 20.0, p.homeX - 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::Offer });
        }
        if (pc.ballAdvance > 0.58 && pc.myTeam) {
            double nearPost = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.35 : PITCH_H * 0.65;
            double farPost  = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.65 : PITCH_H * 0.35;
            c.push_back({ clamp(oppGoalX - pc.fd * 55.0, 60.0, PITCH_W - 60.0), nearPost, ActionPurpose::Space });
            c.push_back({ clamp(oppGoalX - pc.fd * 80.0, 60.0, PITCH_W - 60.0), farPost, ActionPurpose::Space });
        }
    }
}

// ── Defensive line management for defender roles ────────────────────────────
void PlayerAI::posDefensiveLine(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per) {
    if (pc.myTeam || !isDefenderRole()) return;

    const auto& p = player;
    auto& b = engine.state.ball;

    double sumX = 0;
    int count = 0;
    double deepestX = (p.team == Team::Home) ? 0.0 : PITCH_W;
    struct LineMate { double progress; int id; };
    SmallVector<LineMate, 5> lineMates;
    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.role == Role::GK) continue;
        if (engine.agentFor(t)->isDefenderRole()) {
            sumX += t.x; count++;
            lineMates.push_back({ (t.x - ownGoalXFor(p.team)) * pc.fd, t.id });
            double tx = (p.team == Team::Home) ? t.x : PITCH_W - t.x;
            double rev = (p.team == Team::Home) ? deepestX : PITCH_W - deepestX;
            if (tx < rev) deepestX = t.x;
        }
    }
    double meanLine = count > 0 ? sumX / count : p.homeX;
    double lineX = clamp(meanLine, p.homeX - 70.0, p.homeX + 70.0);
    if (isFullBack()) {
        double ownGx = ownGoalXFor(p.team);
        double lineProgress = (lineX - ownGx) * pc.fd;
        double minProgress = std::max(72.0, lineProgress - 12.0);
        double maxProgress = lineProgress + 34.0;
        lineX = clampRange(lineX, ownGx + pc.fd * minProgress, ownGx + pc.fd * maxProgress);
    }
    if (lineMates.size() >= 3) {
        std::sort(lineMates.begin(), lineMates.end(), [](const LineMate& a, const LineMate& b) { return a.progress < b.progress; });
        double myProgress = (p.x - ownGoalXFor(p.team)) * pc.fd;
        bool iAmDeepest = lineMates.front().id == p.id;
        double gapToLine = lineMates[1].progress - lineMates[0].progress;
        bool ballBeyondMe = (b.x - p.x) * pc.fd > 25.0;
        if (iAmDeepest && gapToLine > 75.0 && !ballBeyondMe) {
            double recoverProgress = clamp(lineMates[1].progress - 32.0, 70.0, 360.0);
            double recoverX = ownGoalXFor(p.team) + pc.fd * recoverProgress;
            c.push_back({ recoverX, p.homeY, ActionPurpose::Cover });
            if (myProgress < recoverProgress - 40.0)
                c.push_back({ ownGoalXFor(p.team) + pc.fd * (recoverProgress - 12.0), clamp(p.homeY + ((b.y < PITCH_H / 2.0) ? -18.0 : 18.0), 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
        }
    }
    c.push_back({ lineX, p.homeY, ActionPurpose::Cover });
    c.push_back({ lineX - pc.fd * (isFullBack() ? 6.0 : 15.0), p.homeY, ActionPurpose::Cover });
    if (pc.ballAdvance < 0.35)
        c.push_back({ clamp(p.homeX + pc.fd * 180.0, lineX + pc.fd * 40.0, PITCH_W - 50.0), p.homeY, ActionPurpose::Cover });

    bool ballPastUs = (pc.fd == 1.0) ? b.x > lineX + 20.0 : b.x < lineX - 20.0;
    if (ballPastUs) {
        double dropAmount = isFullBack() ? 10.0 : 20.0;
        double dropX = lineX - pc.fd * dropAmount;
        c.push_back({ dropX, p.homeY, ActionPurpose::Cover });
        if (isCenterBack()) c.push_back({ dropX - pc.fd * 20.0, p.homeY, ActionPurpose::Cover });
    }
    double bSide2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
    c.push_back({ lineX - pc.fd * 10.0, clamp(p.homeY + bSide2 * 25.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
    if (pc.ballAdvance < 0.4)
        c.push_back({ clampRange(p.homeX + pc.fd * 220.0, p.homeX + pc.fd * 50.0, goalXFor(p.team) - pc.fd * 50.0), p.homeY, ActionPurpose::Cover });
}

// ── General out-of-possession cover for non-defenders ───────────────────────
void PlayerAI::posGeneralCover(SmallVector<PositionCandidate, 32>& c, const PositioningContext& pc, const Perception& per) {
    if (pc.myTeam) return;

    const auto& p = player;
    auto& b = engine.state.ball;

    if (!isFullBack() && !isCenterBack()) {
        c.push_back({ clamp((b.x + (ownGoalXFor(p.team))) / 2.0, p.homeX - 80.0, p.homeX + 20.0), p.homeY, ActionPurpose::Cover });
    }
    double bf2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
    c.push_back({ clamp(p.homeX - pc.fd * (isFullBack() ? 4.0 : 30.0), 40.0, PITCH_W - 40.0), clamp(p.homeY + bf2 * 25.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
    if (isFullBack() && std::abs(b.y - p.homeY) > 200.0) {
        c.push_back({ clamp(p.homeX + pc.fd * 6.0, 40.0, PITCH_W - 40.0), clamp(lerp(p.homeY, PITCH_H / 2.0, 0.5), 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
    }
}

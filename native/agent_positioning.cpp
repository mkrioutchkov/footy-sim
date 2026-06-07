#include "engine.h"
#include "agent.h"
#include <map>

std::vector<Action> PlayerAI::scorePositioning(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    auto& b = engine.state.ball;
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    Team ip = engine.teamInPossession();
    bool my = (per.ballControllerTeam == p.team);
    double ba = (fd == 1.0) ? b.x / PITCH_W : 1.0 - b.x / PITCH_W;
    double pu = my ? fd * ba * 220.0 : 0.0;
    bool iw = (p.role == Role::FB || p.role == Role::WM);
    double wp = (iw && my) ? fd * ba * 85.0 : 0.0;

    struct Candidate { double x, y; ActionPurpose pur = ActionPurpose::Keep; };
    auto clampRange = [](double v, double a, double b) {
        return clamp(v, std::min(a, b), std::max(a, b));
    };
    std::vector<Candidate> c = {
        { p.homeX + pu + wp, p.homeY, ActionPurpose::Cover },
        { p.homeX + fd * 30.0 + pu + wp, p.homeY, ActionPurpose::Cover },
        { p.homeX - fd * 20.0 + pu + wp, p.homeY, ActionPurpose::Cover },
        { p.homeX + pu + wp, p.homeY - 25.0, ActionPurpose::Cover },
        { p.homeX + pu + wp, p.homeY + 25.0, ActionPurpose::Cover },
        { lerp(p.homeX, b.x, 0.15) + pu, lerp(p.homeY, b.y, 0.10), ActionPurpose::Cover },
    };

    int topCount = 0, botCount = 0;
    for (auto& o : engine.state.players) {
        if (dist(p.x, p.y, o.x, o.y) >= 200.0) continue;
        if (o.y < PITCH_H / 2.0) topCount++;
        else                      botCount++;
    }
    int openFlank = (topCount < botCount) ? -1 : 1;
    c.push_back({ p.homeX + pu, clamp(p.homeY + openFlank * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });

    if (!my && !per.ballIsLoose) {
        double og = ownGoalXFor(p.team);
        double rx = clamp(lerp(p.x, og, 0.5), og, p.x);
        c.push_back({ rx, p.homeY, ActionPurpose::Cover });
        c.push_back({ rx, p.homeY - 30.0, ActionPurpose::Cover });
        c.push_back({ rx, p.homeY + 30.0, ActionPurpose::Cover });

        bool ballPastUs = (fd == 1.0) ? b.x > p.x + 20.0 : b.x < p.x - 20.0;
        if (ballPastUs && (p.role == Role::CB || p.role == Role::FB || p.role == Role::CM)) {
            c.push_back({ rx - fd * 30.0, p.homeY, ActionPurpose::Cover });
            c.push_back({ rx - fd * 30.0, p.homeY - 25.0, ActionPurpose::Cover });
        }

        double carrierDepth = (b.x - og) * fd;
        bool immediateDanger = carrierDepth < 260.0;
        if (!immediateDanger && p.role == Role::CF) {
            c.push_back({ clamp(HALF_X + fd * 95.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::CounterOutlet });
            c.push_back({ clamp(HALF_X + fd * 70.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + ((b.y < PITCH_H / 2.0) ? 45.0 : -45.0), 80.0, PITCH_H - 80.0), ActionPurpose::CounterOutlet });
        }
        if (!immediateDanger && p.role == Role::WM && std::abs(p.homeY - b.y) > 190.0) {
            c.push_back({ clamp(HALF_X + fd * 45.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::RestForward });
        }
    }

    if (per.ballDist > 150.0) {
        if (my && ip == p.team) {
            c.push_back({ p.homeX + fd * 60.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? 40.0 : -40.0), 50.0, PITCH_H - 50.0), ActionPurpose::Offer });
            if (p.role == Role::WM || p.role == Role::FB)
                c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        } else if (!my) {
            c.push_back({ p.homeX - fd * 40.0, p.homeY, ActionPurpose::Cover });
            if (p.role == Role::CM || p.role == Role::CF)
                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), ActionPurpose::Cover });
        }
    }

    if (per.ballDist > 250.0 && !per.iAmController) {
        c.push_back({ lerp(p.x, b.x, 0.15), lerp(p.y, b.y, 0.12), ActionPurpose::Observe });
        c.push_back({ lerp(p.x, b.x, 0.10), clamp(lerp(p.y, b.y, 0.08), 40.0, PITCH_H - 40.0), ActionPurpose::Observe });
    }

    if (my && !per.iAmController) {
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
            if (p.role == Role::WM) {
                bool sameSide = std::abs(carrier->y - p.homeY) < 190.0;
                double flankY = (p.homeY < PITCH_H / 2.0) ? 24.0 : PITCH_H - 24.0;
                double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.42, 65.0, PITCH_H - 65.0);
                double oppGoalX = goalXFor(p.team);
                if (sameSide && carrier->role != Role::WM) {
                    c.push_back({ clamp(carrier->x + fd * 150.0, 55.0, PITCH_W - 55.0), flankY, ActionPurpose::RunAhead });
                    c.push_back({ clamp(carrier->x + fd * 120.0, 55.0, PITCH_W - 55.0), insideY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(oppGoalX - fd * 175.0, 55.0, PITCH_W - 55.0), flankY, ActionPurpose::HoldWidth });
                } else if (!sameSide && ba > 0.42) {
                    double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
                    c.push_back({ clamp(oppGoalX - fd * 115.0, 55.0, PITCH_W - 55.0), farPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(oppGoalX - fd * 185.0, 55.0, PITCH_W - 55.0), flankY, ActionPurpose::HoldWidth });
                }
            }
            if (p.role == Role::CF) {
                double oppGoalX = goalXFor(p.team);
                bool carrierWide = std::abs(carrier->y - PITCH_H / 2.0) > 130.0;
                bool carrierAdvanced = (carrier->x - ownGoalXFor(p.team)) * fd > PITCH_W * 0.48;
                if (carrierWide && carrierAdvanced) {
                    double nearPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.35 : PITCH_H * 0.65;
                    double farPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.65 : PITCH_H * 0.35;
                    c.push_back({ clamp(oppGoalX - fd * 58.0, 55.0, PITCH_W - 55.0), nearPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(oppGoalX - fd * 86.0, 55.0, PITCH_W - 55.0), farPostY, ActionPurpose::InsideRun });
                    c.push_back({ clamp(oppGoalX - fd * 125.0, 55.0, PITCH_W - 55.0), PITCH_H / 2.0, ActionPurpose::Offer });
                }
            }
        }
    }

    auto* rp2 = engine.qRecentPass();
    if (rp2 && engine.state.clockMs - rp2->clockMs < 600.0) {
        if (rp2->team == p.team && dist(p.x, p.y, rp2->bx, rp2->by) < 250.0) {
            c.push_back({ lerp(p.x, rp2->bx, 0.12), lerp(p.y, rp2->by, 0.10), ActionPurpose::Offer });
        }
    }

    if (my && ip == p.team) {
        c.push_back({ p.homeX + fd * 80.0 + pu, p.homeY, ActionPurpose::Offer });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY - 35.0, ActionPurpose::Space });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY + 35.0, ActionPurpose::Space });

        auto& bb2 = engine.blackboards[GameEngine::teamIndex(p.team)];
        if (bb2.oneTwo.has_value() && bb2.oneTwo->from == p.id && engine.state.clockMs < bb2.oneTwo->expires) {
            double oppGoalX = goalXFor(p.team);
            c.push_back({ clampRange(p.x + fd * 80.0, p.homeX + fd * 40.0, oppGoalX), p.y, ActionPurpose::Space });
            c.push_back({ clampRange(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y - 30.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            c.push_back({ clampRange(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y + 30.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        }

        if (ba > 0.6 && p.role == Role::CF) {
            double bGoalX = goalXFor(p.team);
            c.push_back({ bGoalX - fd * (35.0 + engine.rng.random() * 55.0),
                          clamp(PITCH_H / 2.0 + (engine.rng.random() - 0.5) * 90.0, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Space });
            c.push_back({ bGoalX - fd * (70.0 + engine.rng.random() * 65.0),
                          clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.25, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Offer });
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team == p.team && (carrier->role == Role::WM || carrier->role == Role::FB)
                && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
                && std::abs(carrier->x - bGoalX) < 430.0) {
                double ballSide = carrier->y < PITCH_H / 2.0 ? -1.0 : 1.0;
                c.push_back({ bGoalX - fd * 62.0, clamp(PITCH_H / 2.0 + ballSide * 34.0, PITCH_H * 0.28, PITCH_H * 0.72), ActionPurpose::Offer });
                c.push_back({ bGoalX - fd * 105.0, clamp(PITCH_H / 2.0 - ballSide * 24.0, PITCH_H * 0.28, PITCH_H * 0.72), ActionPurpose::Space });
            }
        } else if (ba > 0.6 && p.role == Role::WM) {
            double bGoalX = goalXFor(p.team);
            double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
            double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.32, PITCH_H * 0.24, PITCH_H * 0.76);
            c.push_back({ bGoalX - fd * (70.0 + engine.rng.random() * 75.0), farPostY, ActionPurpose::Space });
            c.push_back({ bGoalX - fd * (125.0 + engine.rng.random() * 85.0), insideY, ActionPurpose::Offer });
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team == p.team && (carrier->role == Role::WM || carrier->role == Role::FB)
                && std::abs(carrier->homeY - p.homeY) > 160.0
                && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
                && std::abs(carrier->x - bGoalX) < 430.0) {
                c.push_back({ bGoalX - fd * 70.0, farPostY, ActionPurpose::Offer });
                c.push_back({ bGoalX - fd * 120.0, insideY, ActionPurpose::Space });
            }
        } else if (ba > 0.6 && p.role == Role::CM) {
            double bGoalX = goalXFor(p.team);
            double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
            c.push_back({ bGoalX - fd * (150.0 + engine.rng.random() * 85.0),
                          clamp(PITCH_H / 2.0 - bSide * 55.0, PITCH_H * 0.25, PITCH_H * 0.75), ActionPurpose::Offer });
            c.push_back({ bGoalX - fd * (180.0 + engine.rng.random() * 90.0),
                          clamp(PITCH_H / 2.0 + bSide * 70.0, PITCH_H * 0.24, PITCH_H * 0.76), ActionPurpose::Space });
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team == p.team && (carrier->role == Role::WM || carrier->role == Role::FB)
                && std::abs(carrier->y - PITCH_H / 2.0) > 130.0
                && std::abs(carrier->x - bGoalX) < 450.0) {
                c.push_back({ bGoalX - fd * 165.0, PITCH_H / 2.0, ActionPurpose::Offer });
            }
        }

        if (p.role == Role::CM) {
            double midSum = 0, defSum = 0;
            int midCount = 0, defCount = 0;
            for (auto& o : engine.state.players) {
                if (o.team == p.team) continue;
                if (o.role == Role::CM || o.role == Role::WM) { midSum += o.x; midCount++; }
                if (o.role == Role::CB || o.role == Role::FB) { defSum += o.x; defCount++; }
            }
            if (midCount > 0 && defCount > 0) {
                double midLine = midSum / midCount;
                double defLine = defSum / defCount;
                double gapX = (midLine + defLine) / 2.0;
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), p.homeY, ActionPurpose::Offer });
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), clamp(p.homeY - 40.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            }
            if (ba < 0.35 && my) {
                c.push_back({ clamp(p.homeX - fd * 30.0, 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::Offer });
                c.push_back({ clamp(p.homeX - fd * 20.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + 35.0, 40.0, PITCH_H - 40.0), ActionPurpose::Offer });
            }
            double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
            c.push_back({ clamp(p.homeX + fd * 30.0 + pu, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            c.push_back({ clamp(p.homeX + fd * 110.0 + pu, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + bSide * 55.0, 50.0, PITCH_H - 50.0), ActionPurpose::Offer });
            c.push_back({ clamp(b.x + fd * 90.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 35.0, 45.0, PITCH_H - 45.0), ActionPurpose::Space });
        }

        if (p.role == Role::WM) {
            double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
            ActionPurpose crossPur = ba > 0.45 ? ActionPurpose::Offer : ActionPurpose::Space;
            c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), flankY, crossPur });
            c.push_back({ clampRange(b.x + fd * 115.0, p.homeX + fd * 80.0, goalXFor(p.team) - fd * 45.0), flankY, ActionPurpose::CrossLane });
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team == p.team && (carrier->role == Role::CM || carrier->role == Role::CB)
                && std::abs(carrier->y - PITCH_H / 2.0) < 215.0
                && std::abs(carrier->x - goalXFor(p.team)) > 260.0) {
                c.push_back({ clampRange(carrier->x + fd * 210.0, p.homeX + fd * 120.0, goalXFor(p.team) - fd * 65.0),
                              flankY, ActionPurpose::HoldWidth });
                c.push_back({ clampRange(carrier->x + fd * 255.0, p.homeX + fd * 150.0, goalXFor(p.team) - fd * 45.0),
                              clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), ActionPurpose::CrossLane });
            }
            double runBehindY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.3 : PITCH_H * 0.7;
            c.push_back({ clamp(p.homeX + fd * 140.0 + pu, 60.0, PITCH_W - 60.0), runBehindY, ActionPurpose::Space });
            if (std::abs(b.y - p.homeY) > 200.0) {
                c.push_back({ clamp(p.homeX + fd * 100.0 + pu, 60.0, PITCH_W - 60.0), clamp(lerp(p.y, PITCH_H / 2.0, 0.3), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
                c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + ((p.homeY < PITCH_H / 2.0) ? 80.0 : -80.0), 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            }
        }

        if (p.role == Role::CB || p.role == Role::FB)
            c.push_back({ p.homeX + fd * 150.0 + pu, p.homeY, ActionPurpose::Cover });

        double fld = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ p.homeX + fd * 55.0 + pu, clamp(p.homeY + fld * 50.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
        c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY - fld * 70.0, 40.0, PITCH_H - 40.0), ActionPurpose::Switch });
        if (p.role == Role::WM || p.role == Role::FB)
            c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), ActionPurpose::Space });

        if (p.role == Role::FB && my) {
            Player* wmOnMySide = nullptr;
            for (auto& o : engine.state.players) {
                if (o.team == p.team && o.role == Role::WM && std::abs(o.homeY - p.homeY) < 100.0) {
                    wmOnMySide = &o; break;
                }
            }
            bool wmHasBall = wmOnMySide && engine.state.ball.controllerId == wmOnMySide->id;
            if (wmHasBall) {
                c.push_back({ clampRange(wmOnMySide->x + fd * 80.0, p.homeX + fd * 80.0, goalXFor(p.team) - fd * 20.0),
                              clamp((p.homeY < PITCH_H / 2.0) ? 35.0 : PITCH_H - 35.0, 35.0, PITCH_H - 35.0), ActionPurpose::Space });
                c.push_back({ clampRange(wmOnMySide->x + fd * 50.0, p.homeX + fd * 50.0, goalXFor(p.team)),
                              clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
            } else if (Player* supportCarrier = engine.playerById(engine.state.ball.controllerId);
                       supportCarrier && supportCarrier->team == p.team
                       && (supportCarrier->role == Role::CM || supportCarrier->role == Role::CB)
                       && std::abs(supportCarrier->y - p.homeY) < 185.0 && ba > 0.28) {
                double flankY = p.homeY < PITCH_H / 2.0 ? 36.0 : PITCH_H - 36.0;
                c.push_back({ clampRange(supportCarrier->x + fd * 180.0, p.homeX + fd * 95.0, goalXFor(p.team) - fd * 45.0),
                              flankY, ba > 0.48 ? ActionPurpose::CrossLane : ActionPurpose::Overlap });
                c.push_back({ clampRange(supportCarrier->x + fd * 130.0, p.homeX + fd * 75.0, goalXFor(p.team) - fd * 80.0),
                              clamp((p.homeY < PITCH_H / 2.0) ? 58.0 : PITCH_H - 58.0, 40.0, PITCH_H - 40.0), ActionPurpose::Overlap });
            } else {
                double wmHomeY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.12 : PITCH_H * 0.88;
                c.push_back({ p.homeX + fd * 120.0 + pu, clamp(wmHomeY, 40.0, PITCH_H - 40.0), ActionPurpose::Space });
                c.push_back({ clamp(p.homeX + fd * 185.0 + pu, 60.0, PITCH_W - 60.0), clamp(wmHomeY, 40.0, PITCH_H - 40.0), ActionPurpose::Overlap });
            }
        }

        if (p.role == Role::CF) {
            double oppGoalX = goalXFor(p.team);
            double ld = (fd == 1.0) ? -1e9 : 1e9;
            bool anyDefenders = false;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK) {
                    anyDefenders = true;
                    ld = (fd == 1.0) ? std::max(ld, o.x) : std::min(ld, o.x);
                }
            }
            if (anyDefenders) {
                double defLine = clampRange(ld, p.homeX - fd * 40.0, oppGoalX + fd * 20.0);
                double pushX = (fd == 1.0) ? std::min(p.homeX + fd * 100.0, ld - 15.0) : std::max(p.homeX + fd * 100.0, ld + 15.0);
                c.push_back({ pushX, p.homeY, ActionPurpose::Offer });
                double runY = clamp(p.homeY + ((engine.rng.random() > 0.5) ? 40.0 : -40.0), PITCH_H * 0.2, PITCH_H * 0.8);
                c.push_back({ clampRange(defLine - fd * 10.0, p.homeX + fd * 40.0, oppGoalX), runY, ActionPurpose::Space });
            }
            if (ba < 0.5 && my) {
                c.push_back({ clamp(p.homeX - fd * 20.0, p.homeX - 60.0, PITCH_W - 60.0), p.homeY, ActionPurpose::Offer });
            }
            if (ba > 0.58 && my) {
                double nearPost = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.35 : PITCH_H * 0.65;
                double farPost  = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.65 : PITCH_H * 0.35;
                c.push_back({ clamp(oppGoalX - fd * 55.0, 60.0, PITCH_W - 60.0), nearPost, ActionPurpose::Space });
                c.push_back({ clamp(oppGoalX - fd * 80.0, 60.0, PITCH_W - 60.0), farPost, ActionPurpose::Space });
            }
        }
    }

    if (!my && (p.role == Role::CB || p.role == Role::FB)) {
        double sumX = 0;
        int count = 0;
        double deepestX = (p.team == Team::Home) ? 0.0 : PITCH_W;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.role == Role::GK) continue;
            if (t.role == Role::CB || t.role == Role::FB) {
                sumX += t.x; count++;
                double tx = (p.team == Team::Home) ? t.x : PITCH_W - t.x;
                double rev = (p.team == Team::Home) ? deepestX : PITCH_W - deepestX;
                if (tx < rev) deepestX = t.x;
            }
        }
        double meanLine = count > 0 ? sumX / count : p.homeX;
        double lineX = clamp(meanLine, p.homeX - 70.0, p.homeX + 70.0);
        if (p.role == Role::FB) {
            double ownGx = ownGoalXFor(p.team);
            double lineProgress = (lineX - ownGx) * fd;
            double minProgress = std::max(72.0, lineProgress - 12.0);
            double maxProgress = lineProgress + 34.0;
            lineX = clampRange(lineX, ownGx + fd * minProgress, ownGx + fd * maxProgress);
        }
        c.push_back({ lineX, p.homeY, ActionPurpose::Cover });
        c.push_back({ lineX - fd * (p.role == Role::FB ? 6.0 : 15.0), p.homeY, ActionPurpose::Cover });
        if (ba < 0.35)
            c.push_back({ clamp(p.homeX + fd * 180.0, lineX + fd * 40.0, PITCH_W - 50.0), p.homeY, ActionPurpose::Cover });

        bool ballPastUs = (fd == 1.0) ? b.x > lineX + 20.0 : b.x < lineX - 20.0;
        if (ballPastUs) {
            double dropAmount = p.role == Role::FB ? 10.0 : 20.0;
            double dropX = lineX - fd * dropAmount;
            c.push_back({ dropX, p.homeY, ActionPurpose::Cover });
            if (p.role == Role::CB) c.push_back({ dropX - fd * 20.0, p.homeY, ActionPurpose::Cover });
        }
        double bSide2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ lineX - fd * 10.0, clamp(p.homeY + bSide2 * 25.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
        if (ba < 0.4)
            c.push_back({ clampRange(p.homeX + fd * 220.0, p.homeX + fd * 50.0, goalXFor(p.team) - fd * 50.0), p.homeY, ActionPurpose::Cover });
    }

    if (!my) {
        if (p.role != Role::FB && p.role != Role::CB) {
            c.push_back({ clamp((b.x + (ownGoalXFor(p.team))) / 2.0, p.homeX - 80.0, p.homeX + 20.0), p.homeY, ActionPurpose::Cover });
        }
        double bf2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ clamp(p.homeX - fd * (p.role == Role::FB ? 4.0 : 30.0), 40.0, PITCH_W - 40.0), clamp(p.homeY + bf2 * 25.0, 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
        if (p.role == Role::FB && std::abs(b.y - p.homeY) > 200.0) {
            c.push_back({ clamp(p.homeX + fd * 6.0, 40.0, PITCH_W - 40.0), clamp(lerp(p.homeY, PITCH_H / 2.0, 0.5), 40.0, PITCH_H - 40.0), ActionPurpose::Cover });
        }
    }

    std::vector<Action> options;
    for (auto& cn : c) {
        double sf = 0;
        for (auto* o : per.nearbyOpponents) {
            double d2 = std::sqrt((cn.x - o->x) * (cn.x - o->x) + (cn.y - o->y) * (cn.y - o->y));
            if (d2 < 50.0) sf -= (50.0 - d2) / 50.0;
        }
        bool counterOutlet = cn.pur == ActionPurpose::CounterOutlet || cn.pur == ActionPurpose::RestForward;
        double tac = my ? (cn.x - p.homeX) * fd / PITCH_W * 0.5 : counterOutlet ? 0.0 : -(cn.x - p.homeX) * fd / PITCH_W * 0.25;
        double og2 = ownGoalXFor(p.team);
        double db = !my ? clamp(((b.x - cn.x) * fd) / (std::abs(b.x - og2) + 1.0), 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((cn.x - b.x) * (cn.x - b.x) + (cn.y - b.y) * (cn.y - b.y)) / 600.0 * 0.08;
        double ob = counterOutlet ? 0.44 :
                    (cn.pur == ActionPurpose::InsideRun && p.role == Role::WM && ba > 0.42) ? 0.20 :
                    (cn.pur == ActionPurpose::RunAhead && p.role == Role::WM) ? 0.14 :
                    (cn.pur == ActionPurpose::CrossLane || cn.pur == ActionPurpose::Overlap) ? 0.24 :
                    (cn.pur == ActionPurpose::HoldWidth && p.role == Role::WM && ba > 0.45) ? 0.10 :
                    (cn.pur == ActionPurpose::Observe) ? 0.10 :
                    (cn.pur == ActionPurpose::Space && p.role == Role::WM && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;

        double jx = std::sin(engine.state.clockMs * 0.007 + p.id * 1.3) * 6.0;
        double jy = std::cos(engine.state.clockMs * 0.009 + p.id * 1.9) * 6.0;

        options.push_back(Action{
            ActionType::Position,
            clamp(0.15 + sf * 0.3 + tac - bp2 + db + ob, 0.0, 1.0),
            nullptr,
            clamp(cn.x + jx, 40.0, PITCH_W - 40.0),
            clamp(cn.y + jy, 40.0, PITCH_H - 40.0),
            cn.pur
        });
    }

    auto* task = engine.assignmentFor(p.id);
    if (task) {
        static const std::map<DefensiveTask, double> taskScores = {
            {DefensiveTask::PrimaryPress, 0.86}, {DefensiveTask::SecondaryPress, 0.72}, {DefensiveTask::ShotLane, 0.88}, {DefensiveTask::Cover, 0.66},
            {DefensiveTask::CrossLane, 0.87}, {DefensiveTask::LaneBlock, 0.87}, {DefensiveTask::BoxGuard, 0.88}, {DefensiveTask::FarPostGuard, 0.84},
            {DefensiveTask::NearPostGuard, 0.86}, {DefensiveTask::CutbackGuard, 0.84}, {DefensiveTask::DefensiveLine, 0.72}, {DefensiveTask::WideCover, 0.70},
            {DefensiveTask::MidfieldScreen, 0.72}, {DefensiveTask::BoxScreen, 0.80}, {DefensiveTask::SupportOutlet, 0.47}, {DefensiveTask::AdvanceMidfield, 0.66},
            {DefensiveTask::RunAhead, 0.74}, {DefensiveTask::InsideRun, 0.72}, {DefensiveTask::HoldWidth, 0.64},
            {DefensiveTask::Overlap, 0.72}, {DefensiveTask::RestDefence, 0.56}, {DefensiveTask::CloseDown, 0.84},
        };
        double ts = 0.80;
        auto tit = taskScores.find(task->role);
        if (tit != taskScores.end()) ts = tit->second;
        options.push_back(Action{ActionType::Position, ts, nullptr, task->targetX, task->targetY,
                                 ActionPurpose::Task});
    }

    Player* carrier = engine.playerById(per.ballControllerId);
    if (!my && carrier && carrier->team != p.team && carrier->role != Role::GK) {
        double carrierDist = dist(p.x, p.y, carrier->x, carrier->y);
        double ownGx = ownGoalXFor(p.team);
        bool inOwnHalf = (p.team == Team::Home) ? carrier->x < HALF_X : carrier->x > HALF_X;
        bool inOwnThird = std::abs(carrier->x - ownGx) < PITCH_W * 0.36;
        auto* existingTask = engine.assignmentFor(p.id);
        bool mustHoldShape = existingTask
            && (existingTask->role == DefensiveTask::LaneBlock || existingTask->role == DefensiveTask::BoxGuard
                || existingTask->role == DefensiveTask::FarPostGuard
                || existingTask->role == DefensiveTask::NearPostGuard
                || existingTask->role == DefensiveTask::CutbackGuard
                || existingTask->role == DefensiveTask::ShotLane
                || existingTask->role == DefensiveTask::CrossLane
                || existingTask->role == DefensiveTask::DefensiveLine || existingTask->role == DefensiveTask::WideCover
                || existingTask->role == DefensiveTask::MidfieldScreen || existingTask->role == DefensiveTask::BoxScreen);
        bool emergencyCloseDown = mustHoldShape && inOwnThird
            && std::abs(carrier->y - PITCH_H / 2.0) < 215.0
            && carrierDist < 62.0;
        bool roleCanStep = p.role == Role::CM || p.role == Role::FB || p.role == Role::CB
            || (p.role == Role::WM && std::abs(carrier->y - p.y) < 170.0);
        bool localPressure = (!mustHoldShape || emergencyCloseDown) && roleCanStep && inOwnHalf
            && (carrierDist < (inOwnThird ? 118.0 : 86.0));
        if (localPressure) {
            bool tackleDistance = carrierDist < TACKLE_RANGE + 14.0;
            bool carrierBacktracking = (carrier->team == Team::Home) ? carrier->vx < -8.0 : carrier->vx > 8.0;
            if (!(tackleDistance && carrierBacktracking)) {
                double goalSide = (p.team == Team::Home) ? -1.0 : 1.0;
                double containX = clamp(carrier->x + goalSide * 18.0, 35.0, PITCH_W - 35.0);
                double side = (p.y < carrier->y) ? -1.0 : 1.0;
                double containY = clamp(carrier->y + side * 10.0, 35.0, PITCH_H - 35.0);
                double score = emergencyCloseDown
                    ? clamp(0.97 - carrierDist / 900.0, 0.90, 0.96)
                    : clamp(0.96 - carrierDist / 700.0, 0.72, 0.94);
                options.push_back(Action{ActionType::Position, score, carrier, containX, containY,
                                         emergencyCloseDown ? ActionPurpose::EmergCloseDown : ActionPurpose::LocalCloseDown});
            }
        }
    }

    return options;
}

// ══════════════════════════════════════════════════════════════════════════════
// rc() — resolve choice

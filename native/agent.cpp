#include "engine.h"
#include "agent.h"
#include <limits>

namespace {
struct CarrierPressure {
    int count = 0;
    double nearest = 1e9;
    double exposed = 0.0;
    double goalSide = 0.0;
    double score = 0.0;
    Player* nearestPlayer = nullptr;
};

CarrierPressure assessCarrierPressure(GameEngine& engine, const Player& p) {
    CarrierPressure cp;
    auto& b = engine.state.ball;
    double ballDx = b.x - p.x, ballDy = b.y - p.y;
    double ballD = std::hypot(ballDx, ballDy);
    double ballUx = ballD > 0.1 ? ballDx / ballD : std::cos(p.facing);
    double ballUy = ballD > 0.1 ? ballDy / ballD : std::sin(p.facing);
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role == Role::GK) continue;
        double dx = o.x - p.x, dy = o.y - p.y;
        double d = std::hypot(dx, dy);
        if (d > 70.0) continue;
        if (d < cp.nearest) { cp.nearest = d; cp.nearestPlayer = &o; }
        if (d < 48.0) cp.count++;
        double ux = d > 0.1 ? dx / d : 0.0;
        double uy = d > 0.1 ? dy / d : 0.0;
        cp.exposed = std::max(cp.exposed, ballUx * ux + ballUy * uy);
        double goalSideDir = p.team == Team::Home ? -1.0 : 1.0;
        if ((o.x - p.x) * goalSideDir > 0.0) cp.goalSide = std::max(cp.goalSide, 1.0 - d / 70.0);
    }
    cp.score = clamp((70.0 - cp.nearest) / 70.0, 0.0, 1.0)
        + std::max(0, cp.count - 1) * 0.18
        + clamp(cp.exposed, 0.0, 1.0) * 0.38
        + cp.goalSide * 0.22;
    return cp;
}
}

// ══════════════════════════════════════════════════════════════════════════════
// tick()
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::tick(double sdt) {
    if (player.role == Role::GK) return;
    facing = player.facing;

    stunLockTicks = std::max(0, stunLockTicks - 1);
    shotCooldown = std::max(0, shotCooldown - 1);

    if (ballMemoryAge == 0 && ballMemoryX == 0 && ballMemoryY == 0) {
        ballMemoryX = engine.state.ball.x;
        ballMemoryY = engine.state.ball.y;
    }

    bool ic = (engine.state.ball.controllerId == player.id);
    if (ic) holdTicks++;
    else    holdTicks = 0;

    if (cachedPerception.has_value() && cachedPerception->ballControllerId != engine.state.ball.controllerId) {
        if (cachedPerception->ballIsLoose
            && engine.state.ball.controllerId >= 0
            && dist(player.x, player.y, engine.state.ball.x, engine.state.ball.y) <= PRE_CONTACT_CHASE_REACH)
        {
            engine.notePreventedStaleGrab(player);
        }
        cachedPerception.reset();
    }

    if (engine.state.ball.intendedReceiverId == player.id) cachedPerception.reset();

    Perception per = getCachedPerception();

    GameContext gctx = buildContext();
    std::vector<Action> aff = evaluateActions(per, ic, gctx);
    Action choice = resolveChoice(aff);

    auditDefensiveMovement(choice);
    executeAction(choice, sdt, aff);

    if (std::fmod(engine.state.clockMs, 500.0) < 20.0) {
        std::vector<Action> top = aff;
        std::sort(top.begin(), top.end(),
                  [](const Action& x, const Action& y) { return x.score > y.score; });
        if (top.size() > 5) top.resize(5);
        engine.logPlayerDecision(player.id, choice.type, choice.score,
                                 top, player.x, player.y, choice.purpose);
        if (ic) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == ActionType::Shoot && x.score >= 0.0; });
            if (shootOpt != aff.end()) {
                engine.auditCredibleShotWindow(player, shootOpt->audit.distance,
                    shootOpt->audit.angleDeg, per.pressureCount, std::string(to_string(choice.type)));
            }
        }
    }

    if (ic && per.pressureCount == 0 && choice.type != ActionType::Shoot && choice.type != ActionType::Hold
        && std::fmod(engine.state.clockMs, 500.0) < 20.0)
    {
        double gx = goalXFor(player.team);
        if (std::abs(player.x - gx) < 120.0) {
            auto shootOpt = std::find_if(aff.begin(), aff.end(),
                                         [](const Action& x) { return x.type == ActionType::Shoot; });
            if (shootOpt != aff.end() && shootOpt->score > 0.20) {
                double distance = shootOpt->audit.distance;
                if (distance == 0.0) distance = std::hypot(player.x - gx, player.y - PITCH_H / 2.0);
                double angleDeg = shootOpt->audit.angleDeg;
                if (angleDeg == 0.0) angleDeg = engine.goalOpeningAngleDeg(player.x, player.y, gx);
                engine.logQualityFlag("why_no_shoot", player.id, player.role,
                    distance, angleDeg, shootOpt->score, choice.type, choice.score);
                engine.captureDecisionMoment("why_no_shoot", player,
                    choice.type, choice.score, shootOpt->score,
                    distance, angleDeg, per.pressureCount,
                    8000.0, std::string("why_no_shoot:") + std::string(to_string(player.team)));
            }
        }
    }

    lastPosX = player.x;
    lastPosY = player.y;
}

// ══════════════════════════════════════════════════════════════════════════════
// ctx() — game context
// ══════════════════════════════════════════════════════════════════════════════
GameContext PlayerAI::buildContext() {
    int ms = engine.state.homeScore, os = engine.state.awayScore;
    int my = (player.team == Team::Home) ? ms : os;
    int op = (player.team == Team::Home) ? os : ms;
    int d  = my - op;
    double tl = std::max(0.0, MATCH_DURATION - engine.state.clockMs);
    return { d, tl, (engine.state.clockMs < MATCH_DURATION / 2.0) ? 1 : 2 };
}

// ══════════════════════════════════════════════════════════════════════════════
// ev() — evaluate actions
// ══════════════════════════════════════════════════════════════════════════════
std::vector<Action> PlayerAI::evaluateActions(const Perception& per, bool ic, const GameContext& ctx) {
    std::vector<Action> a;
    if (ic) {
        if (stunLockTicks > 0) {
            double angle = engine.state.clockMs * 0.005 + player.id * 1.7;
            double tx = player.x + std::cos(angle) * 3.0;
            double ty = player.y + std::sin(angle) * 3.0;
            return { Action{ActionType::Dribble, 1.0, nullptr, tx, ty, "hold"} };
        }
        if (shotCooldown > 0) {
            double gx = goalXFor(player.team);
            if (std::abs(player.x - gx) < 150.0) {
                auto cpv = this->scorePass(per, ctx);
                auto csv = this->scoreShot(per, ctx);
                auto cdv = this->scoreDribble(per, ctx);
                a = cpv;
                a.push_back(csv);
                a.push_back(cdv);
            } else {
                Action d = this->scoreDribble(per, ctx);
                d.score = 0.6;
                return { d };
            }
        } else {
            auto cpv = this->scorePass(per, ctx);
            auto csv = this->scoreShot(per, ctx);
            auto cdv = this->scoreDribble(per, ctx);
            a = cpv;
            a.push_back(csv);
            a.push_back(cdv);
        }

        int pc = per.pressureCount;
        for (auto& x : a) {
            if (x.type == ActionType::Pass)    x.score += pc * 0.04;
            if (x.type == ActionType::Shoot)   x.score += pc * 0.03;
            if (x.type == ActionType::Dribble && pc == 1) x.score += 0.10;
            if (x.type == ActionType::Dribble && pc >= 3) x.score -= 0.10;
            if (pc == 0 && x.type == ActionType::Pass && x.purpose != "cross" && x.purpose != "through") {
                if (holdTicks < 12) x.score -= 0.18;
                else if (holdTicks < 24) x.score -= 0.10;
            }
        }

        Action* bestPass = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Pass) {
                if (!bestPass || x.score > bestPass->score) bestPass = &x;
            }
        }

        if (player.role == Role::CM) {
            Action* bestDribble = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Dribble) {
                    if (!bestDribble || x.score > bestDribble->score) bestDribble = &x;
                }
            }
            if (bestDribble && bestDribble->score > 0.25) bestDribble->score += 0.08;
        }

        if (pc == 0) {
            for (auto& x : a) { if (x.type == ActionType::Dribble) x.score += 0.10; }
            if (player.role == Role::CM) {
                for (auto& x : a) { if (x.type == ActionType::Dribble) x.score += 0.08; if (x.type == ActionType::Pass) x.score += 0.02; }
            }
            if (player.role == Role::WM) {
                for (auto& x : a) { if (x.type == ActionType::Dribble) x.score += 0.12; if (x.type == ActionType::Pass) x.score += 0.04; }
            }
        }
    } else {
        a.push_back(this->scoreTackle(per, ctx));
        a.push_back(this->scoreMark(per, ctx));
        a.push_back(this->scoreChase(per));
        auto bpv = this->scorePositioning(per, ctx);
        a.insert(a.end(), bpv.begin(), bpv.end());
    }

    double gx = goalXFor(player.team);
    if (std::abs(player.x - gx) < 280.0) {
        for (auto& x : a) {
            if (x.type == ActionType::Shoot)                                  x.score += 0.06;
            if (x.type == ActionType::Pass && x.purpose == "through")        x.score += 0.04;
            if (x.type == ActionType::Dribble && x.purpose == "space")       x.score += 0.04;
        }
    }

    for (auto& x : a) {
        if (x.type == lastActionType && x.target && x.target->id == lastTargetId) x.score += ic ? 0.12 : 0.05;

        if (x.type == ActionType::Position && x.posX != 0 && x.posY != 0) {
            double td = std::sqrt((x.posX - player.targetX) * (x.posX - player.targetX)
                                + (x.posY - player.targetY) * (x.posY - player.targetY));
            if (td < 50.0) x.score += 0.07;
        }

        x.score += (engine.rng.random() - 0.5) * 0.03;
    }

    adjustActionScores(a, ic);
    return a;
}

void PlayerAI::adjustActionScores(std::vector<Action>&, bool) {
    // Default: no role-specific adjustments. Subclasses override.
}

void PlayerAI::setPiecePositioning(const std::string& spType, Team spTeam) {
    auto& p = player;
    if (p.role == Role::GK) return;
    bool attacking = (p.team == spTeam);
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    double ownGoalX = (p.team == Team::Home) ? 0.0 : PITCH_W;
    double oppGoalX = (p.team == Team::Home) ? PITCH_W : 0.0;
    double slotA = std::sin(p.id * 2.17);
    double slotB = std::cos(p.id * 1.61);

    if (attacking) {
        if (spType == "corner") {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            bool nearPost = by < PITCH_H / 2.0;
            if (p.role == Role::CF) {
                p.targetX = oppGoalX - fd * (80.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + (nearPost ? -40.0 : 40.0) + slotB * 15.0;
            } else if (p.role == Role::WM || p.role == Role::FB) {
                p.targetX = oppGoalX - fd * (50.0 + slotA * 15.0);
                p.targetY = nearPost ? PITCH_H * 0.25 : PITCH_H * 0.75;
            } else if (p.role == Role::CM) {
                p.targetX = oppGoalX - fd * (120.0 + slotA * 20.0);
                p.targetY = PITCH_H / 2.0 + slotB * 40.0;
            } else {
                p.targetX = lerp(p.x, oppGoalX - fd * 150.0, 0.6);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.3);
            }
        } else if (spType == "free_kick") {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            if (p.role == Role::CF) {
                p.targetX = oppGoalX - fd * (60.0 + slotA * 15.0);
                p.targetY = PITCH_H / 2.0 + slotB * 30.0;
            } else if (p.role == Role::CM) {
                p.targetX = bx - fd * (35.0 + std::abs(slotA) * 55.0);
                p.targetY = by + slotB * 80.0;
            } else if (p.role == Role::WM) {
                p.targetX = bx + fd * (25.0 + slotA * 35.0);
                p.targetY = by + slotB * 115.0;
            } else if (p.role == Role::FB || p.role == Role::CB) {
                p.targetX = bx - fd * (75.0 + std::abs(slotA) * 60.0);
                p.targetY = by + slotB * 95.0;
            } else {
                p.targetX = lerp(p.x, bx, 0.3);
                p.targetY = lerp(p.y, PITCH_H / 2.0, 0.2);
            }
        } else if (spType == "throw_in") {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            p.targetX = bx + fd * (50.0 + slotA * 30.0);
            p.targetY = by + slotB * 50.0;
        }
    } else {
        if (spType == "corner") {
            double by = engine.state.ball.y;
            bool nearTop = by < PITCH_H / 2.0;
            if (p.role == Role::CB || p.role == Role::FB) {
                bool postGuard = p.role == Role::FB;
                p.targetX = ownGoalX + fd * (postGuard ? 42.0 : 68.0);
                if (postGuard) {
                    p.targetY = nearTop
                        ? (p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.25 : PITCH_H * 0.66)
                        : (p.homeY > PITCH_H / 2.0 ? PITCH_H * 0.75 : PITCH_H * 0.34);
                } else {
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -54.0 : 54.0);
                }
            } else if (p.role == Role::CM) {
                p.targetX = ownGoalX + fd * (118.0 + std::abs(slotA) * 22.0);
                p.targetY = PITCH_H / 2.0 + (p.id % 3 - 1) * 58.0;
            } else {
                p.targetX = ownGoalX + fd * 185.0;
                p.targetY = lerp(p.homeY, PITCH_H / 2.0, 0.25);
            }
        } else if (spType == "free_kick") {
            double bx = engine.state.ball.x;
            double by = engine.state.ball.y;
            double goalDist = std::abs(bx - ownGoalX);
            if (goalDist < 250.0) {
                if (p.role == Role::FB) {
                    double wallY = lerp(by, PITCH_H / 2.0, 0.65) + (p.homeY < PITCH_H / 2.0 ? -18.0 : 18.0);
                    p.targetX = bx + fd * 32.0;
                    p.targetY = wallY;
                } else if (p.role == Role::CB) {
                    p.targetX = ownGoalX + fd * 72.0;
                    p.targetY = PITCH_H / 2.0 + (p.id % 2 == 0 ? -46.0 : 46.0);
                } else if (p.role == Role::CM) {
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
// cp() — can-pass
// ══════════════════════════════════════════════════════════════════════════════
std::vector<Action> PlayerAI::scorePass(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    std::vector<Action> r;

    for (auto& t : engine.state.players) {
        if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
        double d = dist(p.x, p.y, t.x, t.y);
        if (d < 42.0 || d > 550.0) continue;
        if (engine.isOffsideTarget(p, t)) continue;

        if (d > 40.0) {
            double angleTo = std::atan2(t.y - p.y, t.x - p.x);
            double aDiff = std::abs(angleTo - facing);
            double na = (aDiff > 3.141592653589793) ? 2.0 * 3.141592653589793 - aDiff : aDiff;
            if (na > 3.141592653589793 / 3.0) continue;
        }

        int bl = 0;
        double dx = t.x - p.x, dy = t.y - p.y, ls = dx * dx + dy * dy;
        if (ls < 1.0) continue;

        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK) continue;
            double t2 = clamp(((o.x - p.x) * dx + (o.y - p.y) * dy) / ls, 0.0, 1.0);
            double perp = std::sqrt((o.x - p.x - t2 * dx) * (o.x - p.x - t2 * dx)
                                  + (o.y - p.y - t2 * dy) * (o.y - p.y - t2 * dy));
            if (perp < 36.0) bl++;
        }
        if (bl >= 3) continue;

        double fp = (t.x - p.x) * fd;
        double rs = attrFactor(p.attrs.passing);
        double rr = attrFactor(t.attrs.positioning);

        int receiverPressure = 0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 45.0) receiverPressure++;
        }
        if (receiverPressure >= 3) continue;

        double completion = clamp(
            0.89 + rs * 0.10 + rr * 0.06 - d / 850.0 * 0.28 - bl * 0.23
                - receiverPressure * 0.15 - (fp > 130.0 ? 0.05 : 0.0),
            0.08, 0.98);
        if (completion < 0.44) continue;

        double progression = clamp(fp / 240.0, -0.5, 1.0);
        double turnoverCost = ((p.team == Team::Home) ? p.x < PITCH_W * 0.38 : p.x > PITCH_W * 0.62) ? 0.42 : 0.25;
        double sc = completion * (0.34 + std::max(0.0, progression) * 0.34) - (1.0 - completion) * turnoverCost;
        if (t.id == lastPassTargetId) sc -= 0.18;

        if (recentPassTarget == t.id && engine.state.clockMs - recentPassTime < 3000.0) sc -= 0.10;

        if (bl == 0 && fp > 80.0) sc += 0.08;
        bool carrierFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        if (fp < -30.0) sc -= carrierFinalThird ? 0.28 : 0.16;
        if (fp < -90.0) sc -= carrierFinalThird ? 0.30 : 0.18;
        if (carrierFinalThird && per.pressureCount == 0 && fp < 0.0) sc -= 0.12;

        double dg2 = std::abs(p.x - (goalXFor(p.team)));
        if (dg2 < 200.0 && fp > 0.0 && d < 150.0) sc += 0.10;

        double dgW = dg2;
        bool isWideDelivery = (p.role == Role::WM || p.role == Role::FB)
            && dgW < 430.0
            && std::abs(p.y - PITCH_H / 2.0) > 75.0
            && std::abs(t.x - (goalXFor(p.team))) < 310.0
            && std::abs(t.y - PITCH_H / 2.0) < 210.0
            && fp > -120.0;

        bool isCross   = isWideDelivery && std::abs(p.y - PITCH_H / 2.0) > 120.0 && fp > -45.0;
        bool isCutback = isWideDelivery && !isCross;

        if (isCross) {
            sc += 0.48;
            if (t.role == Role::CF) sc += 0.30;
            else if (t.role == Role::WM) sc += 0.10;
            else if (t.role == Role::CM) sc -= 0.34;
        }
        if (isCutback) sc += 0.18;
        if (p.role == Role::WM && dgW < 450.0 && t.role == Role::CF && std::abs(t.y - PITCH_H / 2.0) < 230.0) sc += 0.42;
        if (p.role == Role::WM && fp > 10.0 && std::abs(p.y - PITCH_H / 2.0) > 100.0 && bl <= 2) sc += 0.32;
        if (p.role == Role::FB && fp > 0.0 && std::abs(p.y - PITCH_H / 2.0) > 75.0 && dgW < 430.0) sc += 0.30;

        if (completion < 0.62) sc -= (0.62 - completion) * 0.55;
        sc -= bl * 0.12;
        if (fp > 0.0) {
            sc += 0.08 + (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.20;
        } else {
            sc -= (engine.configFor(p.team).passingDirectness - 50.0) / 100.0 * 0.15;
        }

        std::string pur = "keep";
        if (fp > 120.0 && bl == 0)          pur = "build";
        else if (fp > 40.0 && bl <= 1)      pur = "build";
        else if (std::abs(t.y - p.y) > 150.0) pur = "switch";
        else if (bl >= 2 && fp < -30.0)      pur = "clear";
        if (isCross)                          pur = "cross";
        else if (isCutback)                   pur = "cutback";

        if (pur == "switch") {
            std::string carrierSide = (p.y < PITCH_H / 2.0) ? "top" : "bottom";
            std::string targetSide  = (t.y < PITCH_H / 2.0) ? "top" : "bottom";
            if (carrierSide != targetSide) {
                int oppsNearCarrier = 0;
                int oppsNearTarget  = 0;
                for (auto& o : engine.state.players) {
                    if (o.team == p.team || o.role == Role::GK) continue;
                    bool onCarrierSide = (carrierSide == "top") ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onCarrierSide && dist(p.x, p.y, o.x, o.y) < 250.0) oppsNearCarrier++;
                    bool onTargetSide = (targetSide == "top") ? o.y < PITCH_H / 2.0 : o.y >= PITCH_H / 2.0;
                    if (onTargetSide && dist(o.x, o.y, t.x, t.y) < 200.0) oppsNearTarget++;
                }
                if (oppsNearCarrier >= 3 && oppsNearTarget <= 1)      sc += 0.18;
                else if (oppsNearCarrier >= 2 && oppsNearTarget <= 2) sc += 0.10;
            }
        }

        double cr = attrFactor(p.attrs.creativity);
        if (pur == "build" && bl > 0) sc += cr * 0.12;
        if (pur == "clear")           sc -= cr * 0.10;

        using RoleList = std::vector<Role>;
        static const std::unordered_map<Role, RoleList> rcMap = {
            {Role::GK, {}},
            {Role::CB, {Role::CM, Role::FB, Role::WM, Role::CF}},
            {Role::FB, {Role::CM, Role::WM, Role::CB}},
            {Role::CM, {Role::CF, Role::WM, Role::FB}},
            {Role::WM, {Role::CF, Role::CM}},
            {Role::CF, {Role::CM, Role::WM}},
        };
        auto it = rcMap.find(p.role);
        const RoleList& pref = (it != rcMap.end()) ? it->second : RoleList{};
        auto rii = std::find(pref.begin(), pref.end(), t.role);
        if (rii == pref.begin())           sc += 0.12;
        else if (rii == pref.begin() + 1)  sc += 0.06;
        if (t.role == p.role) sc -= (p.role == Role::CB || p.role == Role::FB) ? 0.30 : 0.20;

        if ((p.role == Role::CB || p.role == Role::FB) && (t.role == Role::CM || t.role == Role::WM) && fp > 0.0) sc += 0.08;

        bool passerFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        double targetGoalDist = std::abs(t.x - goalXFor(p.team));
        if (passerFinalThird && targetGoalDist < 230.0) {
            if (t.role == Role::CF) sc += 0.24;
            else if (t.role == Role::WM && std::abs(t.y - PITCH_H / 2.0) < 210.0) sc += 0.10;
            else if (t.role == Role::CM) sc -= 0.16;
        }

        auto* assignment = engine.assignmentFor(t.id);
        if (assignment) {
            if (assignment->role == "run_ahead")        sc += 0.12;
            if (assignment->role == "overlap" && p.role != Role::CB) sc += 0.11;
            if (assignment->role == "advance_midfield") sc += 0.09;
            if (assignment->role == "hold_width" && std::abs(t.y - p.y) > 120.0) sc += 0.08;
        }

        double offsideLine = engine.offsideLineFor(p.team);
        double onsideGap = std::isnan(offsideLine) ? 1e9 : (offsideLine - t.x) * fd;

        bool releasedRunner = (assignment && (assignment->role == "run_ahead" || assignment->role == "overlap"))
                              || (p.role == Role::CM && (t.role == Role::CF || t.role == Role::WM));
        if (!isWideDelivery && releasedRunner && fp > 30.0 && onsideGap > -25.0 && onsideGap < 170.0 && bl <= 2) {
            pur = "through";
            sc += 0.18 + attrFactor(p.attrs.creativity) * 0.12;
            if (onsideGap < 8.0) sc += engine.rng.random() * 0.04;
        }

        sc += std::min(holdTicks / 260.0, 0.20);

        if (receiverPressure >= 2) sc -= 0.25;
        if (per.pressureCount >= 2 && bl == 0) sc += 0.10;
        if (per.pressureCount >= 2 && bl >= 2) sc -= 0.15;

        if (p.role == Role::CM && t.role == Role::CF && receiverPressure >= 1 && bl <= 1)
            sc += attrFactor(p.attrs.creativity) * 0.10;

        auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
        if (bb.oneTwo.has_value()
            && bb.oneTwo->from == t.id
            && bb.oneTwo->to == p.id
            && engine.state.clockMs < bb.oneTwo->expires)
            sc += 0.25;

        if (sc > 0.0) {
            r.push_back(Action{
                ActionType::Pass,
                clamp(sc, 0.0, 1.0),
                &t,
                0, 0,
                pur,
                ActionAudit{ d, fp, completion, bl, receiverPressure, 0, 0 }
            });
        }
    }
    double goalX = goalXFor(p.team);
    bool crossingCarrier = (p.role == Role::WM || p.role == Role::FB)
        && std::abs(p.y - PITCH_H / 2.0) > 75.0
        && std::abs(p.x - goalX) < 520.0;
    if (crossingCarrier) {
        Player* bestRunner = nullptr;
        double bestScore = -1e9;
        for (auto& t : engine.state.players) {
            if (t.team != p.team || t.id == p.id || t.role == Role::GK) continue;
            if (engine.isOffsideTarget(p, t)) continue;
            double targetGoalDist = std::abs(t.x - goalX);
            if (targetGoalDist > 430.0 || std::abs(t.y - PITCH_H / 2.0) > 255.0) continue;
            double d = dist(p.x, p.y, t.x, t.y);
            if (d < 65.0 || d > 520.0) continue;
            int pressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, t.x, t.y) < 48.0) pressure++;
            }
            double central = 1.0 - std::abs(t.y - PITCH_H / 2.0) / 230.0;
            double roleBonus = t.role == Role::CF ? 0.52 : t.role == Role::WM ? 0.20 : t.role == Role::CM ? 0.06 : 0.0;
            double score = central + roleBonus + (320.0 - targetGoalDist) / 420.0 - pressure * 0.25 - d / 900.0;
            if (score > bestScore) { bestScore = score; bestRunner = &t; }
        }
        if (bestRunner && bestScore > -0.05) {
            double d = dist(p.x, p.y, bestRunner->x, bestRunner->y);
            double fp = (bestRunner->x - p.x) * fd;
            r.push_back(Action{ActionType::Pass, clamp(0.78 + bestScore * 0.20, 0.0, 0.98), bestRunner, 0, 0,
                               "cross", ActionAudit{d, fp, 0.72, 0, 0, 0, 0}});
        }
    }
    return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// cs() — can-shoot
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreShot(const Perception& per, const GameContext& ctx) {
    const auto& p = player;
    double gx = goalXFor(p.team);
    double shotDistance = std::hypot(p.x - gx, p.y - PITCH_H / 2.0);
    double angleDeg = engine.goalOpeningAngleDeg(p.x, p.y, gx);

    ActionAudit audit;
    audit.distance = shotDistance;
    audit.angleDeg = angleDeg;
    audit.pressureCount = per.pressureCount;
    CarrierPressure cp = assessCarrierPressure(engine, p);
    bool freshCross = p.crossCollected > 0.0 && shotDistance < 230.0;

    bool outsideGoalLane = std::abs(p.y - PITCH_H / 2.0) > GOAL_W / 2.0 - BALL_R + 20.0;
    bool acuteGeometry = outsideGoalLane && angleDeg < 7.5 && shotDistance > 150.0;

    if (!freshCross && angleDeg < 8.0 && shotDistance > 120.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    if (shotDistance > 260.0 || (!freshCross && acuteGeometry))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    if (!freshCross && shotDistance > 240.0 && angleDeg < 7.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    static const std::unordered_map<Role, double> roleMax = {
        {Role::CF, 265.0}, {Role::CM, 245.0}, {Role::WM, 240.0}, {Role::FB, 205.0}, {Role::CB, 180.0}
    };
    double hardMax = 260.0;
    auto rit = roleMax.find(p.role);
    if (rit != roleMax.end()) hardMax = rit->second;
    if (shotDistance > hardMax)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};
    if (p.role == Role::CM && shotDistance > 205.0 && (angleDeg < 10.0 || per.pressureCount > 1))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};
    if (p.role == Role::WM && std::abs(p.y - PITCH_H / 2.0) > 180.0 && shotDistance > 155.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    double mr = SHOOT_MIN_DIST + attrFactor(p.attrs.shooting) * (SHOOT_MAX_DIST - SHOOT_MIN_DIST);
    if (shotDistance > std::min(mr, hardMax))
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    double toGoalX = gx - p.x;
    double toGoalY = PITCH_H / 2.0 - p.y;
    double toGoalDist = std::hypot(toGoalX, toGoalY);
    if (toGoalDist < 1.0) toGoalDist = 1.0;
    double facingDot = (std::cos(p.facing) * toGoalX + std::sin(p.facing) * toGoalY) / toGoalDist;
    if (!freshCross && facingDot < 0.05 && shotDistance > 70.0) return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};
    if (!freshCross && facingDot < 0.35 && shotDistance > 135.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};
    if (!freshCross && cp.score > 1.15 && cp.exposed > 0.45 && shotDistance > 105.0)
        return Action{ActionType::Shoot, -1.0, nullptr, 0, 0, "", audit};

    double sc = attrFactor(p.attrs.shooting) * (1.0 - shotDistance / mr) * 0.55;
    if (shotDistance < 140.0 && per.pressureCount == 0 && angleDeg > 10.0) sc = std::max(sc, 0.38);
    if (shotDistance < 120.0 && per.pressureCount == 0) sc = std::max(sc, 0.30);
    if (shotDistance < 90.0 && per.pressureCount == 0)  sc = std::max(sc, 0.45);
    if (shotDistance < 50.0 && per.pressureCount <= 1)  sc = std::max(sc, 0.50);
    if (shotDistance < 30.0 && per.pressureCount <= 1)  sc = std::max(sc, 0.68);

    Player* gk = nullptr;
    for (auto& o : engine.state.players) {
        if (o.team != p.team && o.role == Role::GK) { gk = &o; break; }
    }
    if (gk) {
        double gkOffCenter = std::abs(p.y - gk->y);
        if (gkOffCenter > 60.0)      sc += 0.12;
        else if (gkOffCenter < 25.0) sc -= 0.08;
        if (std::abs(gk->x - gx) > 50.0) sc += 0.08;
    }

    if (shotDistance < 100.0) sc += 0.14;
    if (shotDistance < 60.0)  sc += 0.12;
    if (p.role == Role::CF) sc += 0.20;
    if (p.role == Role::CM) sc -= shotDistance > 110.0 ? 0.12 : 0.07;
    if (p.role == Role::WM && std::abs(p.y - PITCH_H / 2.0) < 140.0) sc += 0.08;
    if (std::abs(p.y - PITCH_H / 2.0) > 100.0) sc -= p.role == Role::WM ? 0.04 : 0.08;
    sc -= std::min(0.42, per.pressureCount * 0.16);
    sc -= clamp(cp.score - 0.55, 0.0, 0.75) * 0.18;
    if (cp.exposed > 0.45 && shotDistance > 85.0) sc -= 0.12;

    bool credibleOpening = angleDeg >= 7.5 || shotDistance < 115.0;
    if (shotDistance < 200.0 && credibleOpening) sc += per.pressureCount == 0 ? 0.30 : 0.12;
    if (shotDistance < 120.0 && credibleOpening) sc += per.pressureCount == 0 ? 0.38 : 0.12;
    if (shotDistance < 70.0  && credibleOpening) sc += per.pressureCount <= 1 ? 0.22 : 0.05;
    if (shotDistance < 40.0)  sc += per.pressureCount <= 1 ? 0.18 : 0.04;

    if (freshCross) sc += p.role == Role::CF ? 0.62 : 0.42;

    return Action{ActionType::Shoot, clamp(sc, 0.0, 1.0), nullptr, 0, 0, "", audit};
}

// ══════════════════════════════════════════════════════════════════════════════
// cd() — can-dribble
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreDribble(const Perception& per, const GameContext& /*ctx*/) {
    const auto& p = player;
    double gx = goalXFor(p.team);
    double fd = (p.team == Team::Home) ? 1.0 : -1.0;
    double tx = gx, ty = p.y;
    CarrierPressure cp = assessCarrierPressure(engine, p);

    // Evade nearest opponent if close
    if (per.nearestOpponentDist < 50.0 && !per.nearbyOpponents.empty()) {
        Player* n = nullptr;
        double nd = 1e9;
        for (auto* o : per.nearbyOpponents) {
            double d = dist(p.x, p.y, o->x, o->y);
            if (d < nd) { nd = d; n = o; }
        }
        if (n) {
            double ax = p.x - n->x, ay = p.y - n->y;
            double ad = std::sqrt(ax * ax + ay * ay);
            if (ad > 1.0) { tx = p.x + (ax / ad) * 70.0; ty = p.y + (ay / ad) * 70.0; }
        }
    }

    // Keep away from pitch edges
    if (p.y < 60.0)           ty = std::max(ty, p.y + 40.0);
    if (p.y > PITCH_H - 60.0) ty = std::min(ty, p.y - 40.0);
    if (p.x < 60.0)           tx = std::max(tx, p.x + 40.0);
    if (p.x > PITCH_W - 60.0) tx = std::min(tx, p.x - 40.0);

    // Target selection: prefer space over goal
    double distToGoal = std::abs(p.x - gx);
    bool inOwnHalf = (fd > 0 && p.x < HALF_X) || (fd < 0 && p.x > HALF_X);
    bool finalThird = (fd > 0 && p.x > PITCH_W * 2.0 / 3.0) || (fd < 0 && p.x < PITCH_W / 3.0);
    bool nearGoal = distToGoal < 200.0;

    // Find open space: check density around potential targets
    auto densityAt = [&](double cx, double cy) {
        int count = 0;
        for (auto& o : engine.state.players) {
            if (o.team == p.team || o.role == Role::GK) continue;
            if (dist(cx, cy, o.x, o.y) < 80.0) count++;
        }
        return count;
    };

    // Consider flank targets for CM/FB
    if (p.role == Role::CM || p.role == Role::FB) {
        double topFlank = std::max(80.0, p.y - 100.0);
        double botFlank = std::min(PITCH_H - 80.0, p.y + 100.0);
        double topDensity = densityAt(p.x + fd * 60.0, topFlank);
        double botDensity = densityAt(p.x + fd * 60.0, botFlank);
        double centerDensity = densityAt(p.x + fd * 60.0, p.y);

        // Pick the least congested direction
        if (topDensity < centerDensity && topDensity < botDensity) {
            ty = topFlank;
            tx = p.x + fd * 80.0;
        } else if (botDensity < centerDensity) {
            ty = botFlank;
            tx = p.x + fd * 80.0;
        } else {
            tx = p.x + fd * 80.0;
        }
    }

    // Blend toward goal only when close
    if (nearGoal) {
        tx = lerp(tx, gx, 0.4);
    } else {
        tx = lerp(tx, gx, 0.15);
    }

    // Scoring
    double sc = 0.30;

    // Space bonus: more space = more dribble
    if (per.nearestOpponentDist > 100.0) sc += 0.15;
    else if (per.nearestOpponentDist > 60.0) sc += 0.05;
    else if (per.nearestOpponentDist < 30.0) sc -= 0.20;
    if (cp.score > 0.70) sc -= 0.16;
    if (cp.score > 1.05) sc -= 0.18;
    if (cp.exposed > 0.35 && per.nearestOpponentDist < 42.0) sc -= 0.12;

    // Traffic penalty: crowded area = don't dribble
    int oppsInPath = 0;
    for (auto& o : engine.state.players) {
        if (o.team == p.team || o.role == Role::GK) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d < 80.0) oppsInPath++;
    }
    if (oppsInPath >= 3) sc -= 0.20;
    if (oppsInPath >= 5) sc -= 0.30;

    // Field position: prefer passing in own half
    if (inOwnHalf) sc -= 0.10;
    if (inOwnHalf && p.role != Role::WM) sc -= 0.05; // CM/CB/FB: extra penalty in own half

    // Near goal bonus
    if (nearGoal) sc += 0.10;

    // Stuck detection
    double m = std::sqrt((p.x - lastPosX) * (p.x - lastPosX) + (p.y - lastPosY) * (p.y - lastPosY));
    if (holdTicks > 60 && m < 3.0)  sc -= 0.20;
    if (holdTicks > 180)            sc -= 0.30;

    // Open space ahead bonus: check if target area is clear
    int densityAtTarget = densityAt(tx, ty);
    if (densityAtTarget == 0) sc += 0.15;
    else if (densityAtTarget == 1) sc += 0.05;
    else if (densityAtTarget >= 3) sc -= 0.10;

    double aheadX = clamp(p.x + fd * 130.0, 35.0, PITCH_W - 35.0);
    int densityAhead = densityAt(aheadX, p.y);
    if (finalThird && per.nearestOpponentDist > 70.0 && densityAhead == 0) {
        sc += 0.22;
        tx = p.x + fd * 165.0;
        ty = lerp(p.y, PITCH_H / 2.0, 0.18);
    } else if (!inOwnHalf && per.nearestOpponentDist > 115.0 && densityAhead <= 1) {
        sc += 0.12;
        tx = p.x + fd * 130.0;
    }

    // Role-specific
    if (p.role == Role::WM) {
        bool inWide = std::abs(p.y - PITCH_H / 2.0) > 140.0;
        bool nearOppBox = distToGoal < 350.0;
        if (inWide) {
            sc += 0.15;
            if (per.nearestOpponentDist < 60.0) sc += 0.08;
        }
        if (nearOppBox && per.nearestOpponentDist > 50.0) sc += 0.10;
        if (inWide && nearOppBox) {
            tx = lerp(tx, gx, 0.5);
            ty = lerp(ty, PITCH_H / 2.0, 0.3);
        }
    }
    if (p.role == Role::CM && per.nearestOpponentDist > 80.0) sc += 0.08;
    if (p.role == Role::CF && nearGoal) sc += 0.10;

    if (cp.score > 0.70 && cp.nearestPlayer) {
        double ax = p.x - cp.nearestPlayer->x;
        double ay = p.y - cp.nearestPlayer->y;
        double ad = std::hypot(ax, ay);
        if (ad > 1.0) {
            double side = ay >= 0.0 ? 1.0 : -1.0;
            double retreat = cp.exposed > 0.35 ? -fd * 34.0 : 0.0;
            tx = p.x + ax / ad * 44.0 + retreat;
            ty = p.y + side * 48.0;
        }
    }

    return Action{ActionType::Dribble, clamp(sc, 0.0, 1.0), nullptr,
                  clamp(tx, 35.0, PITCH_W - 35.0),
                  clamp(ty, 35.0, PITCH_H - 35.0),
                  "space"};
}

// ══════════════════════════════════════════════════════════════════════════════
// ct() — can-tackle
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreTackle(const Perception& per, const GameContext& /*ctx*/) {
    if (engine.setPieceArmed) return Action{ActionType::Tackle, 0.0};
    if (per.ballIsLoose || per.ballControllerTeam == player.team)
        return Action{ActionType::Tackle, 0.0};

    Player* ctrl = engine.playerById(per.ballControllerId);
    if (!ctrl) return Action{ActionType::Tackle, 0.0};
    if (ctrl->role == Role::GK) return Action{ActionType::Tackle, 0.0};

    double d = dist(player.x, player.y, ctrl->x, ctrl->y);
    if (d > TACKLE_RANGE + 30.0) return Action{ActionType::Tackle, 0.0};

    bool isDef = (player.role == Role::CB || player.role == Role::FB);
    if (isDef) {
        if (player.role == Role::CB) {
            double fd = (player.team == Team::Home) ? 1.0 : -1.0;
            bool inOwnHalf = (fd == 1.0) ? ctrl->x < PITCH_W * 0.5 : ctrl->x > PITCH_W * 0.5;
            if (!inOwnHalf) return Action{ActionType::Tackle, 0.0};
        }
        if (player.role == Role::FB) {
            bool onMyFlank = std::abs(ctrl->y - player.homeY) < 250.0;
            bool isAttacker = ctrl->role == Role::WM || ctrl->role == Role::CF || ctrl->role == Role::CM;
            if (!onMyFlank || !isAttacker) return Action{ActionType::Tackle, 0.0};
        }
    }

    double sc;
    if (player.role == Role::FB) {
        sc = 0.50 - (d / 60.0) * 0.35 + attrFactor(player.attrs.tackling) * 0.18;
    } else if (player.role == Role::CB) {
        sc = 0.68 - (d / 60.0) * 0.35 + attrFactor(player.attrs.tackling) * 0.22;
    } else {
        sc = 0.60 - (d / 60.0) * 0.40 + attrFactor(player.attrs.tackling) * 0.20;
    }

    if (player.role == Role::CM) sc += 0.06;
    if (player.role == Role::CF) sc -= 0.15;
    if (player.role == Role::WM) sc -= 0.04;
    if (d < TACKLE_RANGE + 10.0) sc += 0.15;

    auto* defensiveTask = engine.assignmentFor(player.id);
    if (defensiveTask) {
        bool shapeTask = defensiveTask->role != "primary_press" && defensiveTask->role != "secondary_press"
            && defensiveTask->role != "close_down";
        if (shapeTask && d > TACKLE_RANGE * 0.75) return Action{ActionType::Tackle, 0.0};
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == "primary_press")   sc += 0.20;
        if (defensiveTask->opponentId == ctrl->id && defensiveTask->role == "secondary_press") sc += 0.10;
        if (shapeTask)
            sc -= 0.58;
        if (defensiveTask->role != "primary_press" && defensiveTask->role != "secondary_press"
            && std::abs(ctrl->x - (ownGoalXFor(player.team))) > 170.0)
            sc -= 0.20;
    }

    if (engine.isCarrierShielded(ctrl->id)) sc -= 0.20;

    double ownGoalX = ownGoalXFor(player.team);
    if (std::abs(ctrl->x - ownGoalX) < 220.0) sc += 0.18;
    if (std::abs(ctrl->x - ownGoalX) < 120.0) sc += 0.12;

    int oppsClose = 0;
    for (auto* o : per.nearbyOpponents) {
        if (dist(o->x, o->y, ctrl->x, ctrl->y) < 60.0) oppsClose++;
    }
    if (std::abs(ctrl->x - ownGoalX) < 300.0 && oppsClose < 2) sc += 0.08;

    bool oppFacingAway = (ctrl->team == Team::Home) ? ctrl->vx < 0.0 : ctrl->vx > 0.0;
    if (oppFacingAway && d < TACKLE_RANGE + 20.0) sc += 0.10;

    sc += (engine.configFor(player.team).aggression / 100.0) * 0.10;

    return Action{ActionType::Tackle, clamp(sc, 0.0, 1.0), ctrl};
}

// ══════════════════════════════════════════════════════════════════════════════
// cm() — can-mark
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreMark(const Perception& per, const GameContext& /*ctx*/) {
    if (player.role != Role::CB && player.role != Role::FB) return Action{ActionType::Mark, 0.0};
    if (per.ballControllerTeam == player.team && !per.ballIsLoose) return Action{ActionType::Mark, 0.0};

    if (per.ballIsLoose && per.intendedId >= 0) {
        Player* t = engine.playerById(per.intendedId);
        if (t && t->team != player.team && (t->role == Role::CF || t->role == Role::WM)) {
            double d = dist(player.x, player.y, t->x, t->y);
            if (d < 340.0) return Action{ActionType::Mark, clamp(0.80 - (d / 340.0) * 0.25, 0.0, 1.0), t};
        }
    }

    Player* best = nullptr;
    double bd = 1e9;
    double ownGx = ownGoalXFor(player.team);
    bool isFb = (player.role == Role::FB);

    for (auto& o : engine.state.players) {
        if (o.team == player.team || o.role == Role::GK) continue;
        if (isFb && o.role != Role::WM && (o.role != Role::CM || std::abs(o.y - player.homeY) > 200.0)) continue;
        if (!isFb && o.role != Role::CF && o.role != Role::CM) continue;

        double d = dist(player.x, player.y, o.x, o.y);
        double danger = std::abs(o.x - ownGx);
        double score = d * 0.6 + danger * 0.4;

        if (isFb) {
            bool onFlank = std::abs(o.y - player.homeY) < 220.0;
            if (onFlank && o.role == Role::WM)      score -= 80.0;
            else if (!onFlank && o.role == Role::WM) score += 20.0;
            else if (o.role == Role::CM)             score -= 15.0;
        }
        if (!isFb) {
            if (o.role == Role::CF)      score -= 60.0;
            else if (o.role == Role::CM) score -= 20.0;
        }

        if (score < bd && d < 300.0) { bd = score; best = &o; }
    }

    if (!best) return Action{ActionType::Mark, 0.0};

    double dangerDist = dist(player.x, player.y, best->x, best->y);
    double baseScore = isFb ? 0.68 : 0.66;
    return Action{ActionType::Mark, clamp(baseScore + attrFactor(player.attrs.positioning) * 0.25 - (dangerDist / 300.0) * 0.25, 0.0, 1.0), best};
}

// ══════════════════════════════════════════════════════════════════════════════
// cc() — can-chase
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::scoreChase(const Perception& per) {
    auto& b = engine.state.ball;
    bool isIntendedReceiver = (player.id == b.intendedReceiverId);
    double ballSpeed = std::sqrt(b.vx * b.vx + b.vy * b.vy);
    bool needsRecovery = b.z <= 20.0 && ballSpeed < 30.0 && per.amClosestToBall;

    bool canContest = engine.canContestBall(player);
    double toPlayerDist = std::max(per.ballDist, 1.0);
    double approachDot = ballSpeed > 1.0
        ? (b.vx * (player.x - b.x) + b.vy * (player.y - b.y)) / (ballSpeed * toPlayerDist)
        : 0.0;
    double arrivalTime = per.ballDist / std::max(ballSpeed, 1.0);
    bool incomingLooseBall = b.z <= 20.0 && ballSpeed > 20.0 && per.ballDist < 100.0
        && approachDot > 0.35 && arrivalTime < 1.25;
    bool deadBallRecoveryRun = !canContest && b.z <= 20.0 && ballSpeed < 35.0 && per.ballDist < 70.0;
    bool closeLooseBall = canContest && b.z <= 20.0 && per.ballDist < 45.0;
    bool urgentLooseBallRun = incomingLooseBall || deadBallRecoveryRun || closeLooseBall;

    if (!per.ballIsLoose || (!canContest && !urgentLooseBallRun)
        || (!isIntendedReceiver && per.ballDist > 180.0 && !needsRecovery && !urgentLooseBallRun))
        return Action{ActionType::Chase, 0.0};

    if (urgentLooseBallRun) {
        double lead = incomingLooseBall ? std::min(arrivalTime * 0.35, 0.22) : 0.0;
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      incomingLooseBall ? "meet_incoming_ball" : "recover_loose_ball"};
    }

    if (isIntendedReceiver) {
        double lead = ballSpeed > 30.0 ? 0.2 + std::min(ballSpeed / 300.0, 0.5) : 0.0;
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x + b.vx * lead, 10.0, PITCH_W - 10.0),
                      clamp(b.y + b.vy * lead, 10.0, PITCH_H - 10.0),
                      "receive_ball"};
    }

    if (needsRecovery) {
        return Action{ActionType::Chase, 1.0, nullptr,
                      clamp(b.x, 10.0, PITCH_W - 10.0),
                      clamp(b.y, 10.0, PITCH_H - 10.0),
                      "recover_loose_ball"};
    }

    bool isDef = (player.role == Role::CB || player.role == Role::FB);
    if (isDef) {
        if (player.role == Role::FB) {
            bool onMyFlank = (player.homeY < PITCH_H / 2.0)
                ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
            if (per.ballDist > 100.0 && !onMyFlank) return Action{ActionType::Chase, 0.0};
        }
        if (player.role == Role::CB) {
            bool ballInOwnHalf = (player.team == Team::Home)
                ? b.x < PITCH_W * 0.6 : b.x > PITCH_W * 0.4;
            if (per.ballDist > 120.0 && !ballInOwnHalf) return Action{ActionType::Chase, 0.0};
        }
    }

    if (player.role == Role::CM && per.ballDist > 100.0) {
        bool ballInMiddle = b.x > PITCH_W * 0.25 && b.x < PITCH_W * 0.75;
        if (!ballInMiddle) return Action{ActionType::Chase, 0.0};
    }

    if (player.role == Role::WM && per.ballDist > 80.0) {
        bool onMyFlank = (player.homeY < PITCH_H / 2.0)
            ? b.y < PITCH_H * 0.55 : b.y > PITCH_H * 0.45;
        if (!onMyFlank) return Action{ActionType::Chase, 0.0};
    }

    if (player.role == Role::CF && per.ballDist > 80.0) {
        double oppGx = goalXFor(player.team);
        bool ballNearOppGoal = std::abs(b.x - oppGx) < 200.0;
        if (!ballNearOppGoal) return Action{ActionType::Chase, 0.0};
    }

    double sc = per.ballDist < 50.0 ? 0.90 : per.ballDist < 100.0 ? 0.75 : 0.55;
    sc -= per.ballDist / 180.0 * 0.3;

    if (per.amClosestToBall) sc += 0.12;
    if (per.anyOpponentCloserToBall) {
        double ms = attrFactor(player.attrs.speed) * SPEED_SPRINT;
        if (per.ballDist / std::max(ms, 1.0) < 1.5) sc += 0.10;
    }

    double bs = ballSpeed;
    double la = bs > 30.0 ? 0.3 + std::min(bs / 200.0, 0.8) : 0.0;

    if (bs > 15.0 && per.ballDist > 20.0) {
        double toMeX = player.x - b.x, toMeY = player.y - b.y;
        double toMeDist = std::sqrt(toMeX * toMeX + toMeY * toMeY);
        if (toMeDist > 1.0) {
            double dot = (b.vx * toMeX + b.vy * toMeY) / (bs * toMeDist);
            if (dot > 0.4) sc += 0.12;
            if (dot > 0.7) sc += 0.10;
        }
    }

    auto* rp = engine.qRecentPass();
    if (rp && engine.state.clockMs - rp->clockMs < 800.0) {
        if (rp->team != player.team) {
            double rdx = rp->vx, rdy = rp->vy;
            double rd = std::sqrt(rdx * rdx + rdy * rdy);
            if (rd > 1.0) {
                double toLine = ((player.x - rp->bx) * rdx + (player.y - rp->by) * rdy) / (rd * rd);
                double perp = std::sqrt(
                    (player.x - rp->bx - toLine * rdx) * (player.x - rp->bx - toLine * rdx)
                  + (player.y - rp->by - toLine * rdy) * (player.y - rp->by - toLine * rdy));
                if (perp < 60.0 && toLine > 0.1 && toLine < 1.2) sc += 0.12;
            }
        }
    }

    if (isDef) {
        double ownGoalX = ownGoalXFor(player.team);
        if (std::abs(b.x - ownGoalX) < 250.0) sc += 0.20;
        if (std::abs(b.x - ownGoalX) < 150.0) sc += 0.15;
    }

    return Action{ActionType::Chase, clamp(sc, 0.0, 1.0), nullptr,
                  clamp(b.x + b.vx * la, 10.0, PITCH_W - 10.0),
                  clamp(b.y + b.vy * la, 10.0, PITCH_H - 10.0)};
}

// ══════════════════════════════════════════════════════════════════════════════
// bp() — best-position (off-ball positioning)
// ══════════════════════════════════════════════════════════════════════════════
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

    struct Candidate { double x, y; std::string pur; };
    auto clampRange = [](double v, double a, double b) {
        return clamp(v, std::min(a, b), std::max(a, b));
    };
    std::vector<Candidate> c = {
        { p.homeX + pu + wp, p.homeY, "cover" },
        { p.homeX + fd * 30.0 + pu + wp, p.homeY, "cover" },
        { p.homeX - fd * 20.0 + pu + wp, p.homeY, "cover" },
        { p.homeX + pu + wp, p.homeY - 25.0, "cover" },
        { p.homeX + pu + wp, p.homeY + 25.0, "cover" },
        { lerp(p.homeX, b.x, 0.15) + pu, lerp(p.homeY, b.y, 0.10), "cover" },
    };

    int topCount = 0, botCount = 0;
    for (auto& o : engine.state.players) {
        if (dist(p.x, p.y, o.x, o.y) >= 200.0) continue;
        if (o.y < PITCH_H / 2.0) topCount++;
        else                      botCount++;
    }
    int openFlank = (topCount < botCount) ? -1 : 1;
    c.push_back({ p.homeX + pu, clamp(p.homeY + openFlank * 50.0, 40.0, PITCH_H - 40.0), "cover" });

    if (!my && !per.ballIsLoose) {
        double og = ownGoalXFor(p.team);
        double rx = clamp(lerp(p.x, og, 0.5), og, p.x);
        c.push_back({ rx, p.homeY, "cover" });
        c.push_back({ rx, p.homeY - 30.0, "cover" });
        c.push_back({ rx, p.homeY + 30.0, "cover" });

        bool ballPastUs = (fd == 1.0) ? b.x > p.x + 20.0 : b.x < p.x - 20.0;
        if (ballPastUs && (p.role == Role::CB || p.role == Role::FB || p.role == Role::CM)) {
            c.push_back({ rx - fd * 30.0, p.homeY, "cover" });
            c.push_back({ rx - fd * 30.0, p.homeY - 25.0, "cover" });
        }

        double carrierDepth = (b.x - og) * fd;
        bool immediateDanger = carrierDepth < 260.0;
        if (!immediateDanger && p.role == Role::CF) {
            c.push_back({ clamp(HALF_X + fd * 95.0, 60.0, PITCH_W - 60.0), p.homeY, "counter_outlet" });
            c.push_back({ clamp(HALF_X + fd * 70.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + ((b.y < PITCH_H / 2.0) ? 45.0 : -45.0), 80.0, PITCH_H - 80.0), "counter_outlet" });
        }
        if (!immediateDanger && p.role == Role::WM && std::abs(p.homeY - b.y) > 190.0) {
            c.push_back({ clamp(HALF_X + fd * 45.0, 60.0, PITCH_W - 60.0), p.homeY, "rest_forward" });
        }
    }

    if (per.ballDist > 150.0) {
        if (my && ip == p.team) {
            c.push_back({ p.homeX + fd * 60.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? 40.0 : -40.0), 50.0, PITCH_H - 50.0), "offer" });
            if (p.role == Role::WM || p.role == Role::FB)
                c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -50.0 : 50.0), 40.0, PITCH_H - 40.0), "space" });
        } else if (!my) {
            c.push_back({ p.homeX - fd * 40.0, p.homeY, "cover" });
            if (p.role == Role::CM || p.role == Role::CF)
                c.push_back({ lerp(p.homeX, b.x, 0.3), lerp(p.homeY, b.y, 0.2), "cover" });
        }
    }

    if (per.ballDist > 250.0 && !per.iAmController) {
        c.push_back({ lerp(p.x, b.x, 0.15), lerp(p.y, b.y, 0.12), "observe" });
        c.push_back({ lerp(p.x, b.x, 0.10), clamp(lerp(p.y, b.y, 0.08), 40.0, PITCH_H - 40.0), "observe" });
    }

    if (my && !per.iAmController) {
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team == p.team) {
            int carrierPressure = 0;
            for (auto& o : engine.state.players) {
                if (o.team != p.team && o.role != Role::GK && dist(o.x, o.y, carrier->x, carrier->y) < 60.0) carrierPressure++;
            }
            if (carrierPressure >= 2) {
                c.push_back({ lerp(p.x, carrier->x, 0.3), lerp(p.y, carrier->y, 0.25), "offer" });
                c.push_back({ lerp(p.x, carrier->x, 0.2), clamp(lerp(p.y, carrier->y, 0.15), 40.0, PITCH_H - 40.0), "offer" });
            }
            if (p.role == Role::WM) {
                bool sameSide = std::abs(carrier->y - p.homeY) < 190.0;
                double flankY = (p.homeY < PITCH_H / 2.0) ? 24.0 : PITCH_H - 24.0;
                double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.42, 65.0, PITCH_H - 65.0);
                double oppGoalX = goalXFor(p.team);
                if (sameSide && carrier->role != Role::WM) {
                    c.push_back({ clamp(carrier->x + fd * 150.0, 55.0, PITCH_W - 55.0), flankY, "run_ahead" });
                    c.push_back({ clamp(carrier->x + fd * 120.0, 55.0, PITCH_W - 55.0), insideY, "inside_run" });
                    c.push_back({ clamp(oppGoalX - fd * 175.0, 55.0, PITCH_W - 55.0), flankY, "hold_width" });
                } else if (!sameSide && ba > 0.42) {
                    double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
                    c.push_back({ clamp(oppGoalX - fd * 115.0, 55.0, PITCH_W - 55.0), farPostY, "inside_run" });
                    c.push_back({ clamp(oppGoalX - fd * 185.0, 55.0, PITCH_W - 55.0), flankY, "hold_width" });
                }
            }
            if (p.role == Role::CF) {
                double oppGoalX = goalXFor(p.team);
                bool carrierWide = std::abs(carrier->y - PITCH_H / 2.0) > 130.0;
                bool carrierAdvanced = (carrier->x - ownGoalXFor(p.team)) * fd > PITCH_W * 0.48;
                if (carrierWide && carrierAdvanced) {
                    double nearPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.35 : PITCH_H * 0.65;
                    double farPostY = carrier->y < PITCH_H / 2.0 ? PITCH_H * 0.65 : PITCH_H * 0.35;
                    c.push_back({ clamp(oppGoalX - fd * 58.0, 55.0, PITCH_W - 55.0), nearPostY, "inside_run" });
                    c.push_back({ clamp(oppGoalX - fd * 86.0, 55.0, PITCH_W - 55.0), farPostY, "inside_run" });
                    c.push_back({ clamp(oppGoalX - fd * 125.0, 55.0, PITCH_W - 55.0), PITCH_H / 2.0, "offer" });
                }
            }
        }
    }

    auto* rp2 = engine.qRecentPass();
    if (rp2 && engine.state.clockMs - rp2->clockMs < 600.0) {
        if (rp2->team == p.team && dist(p.x, p.y, rp2->bx, rp2->by) < 250.0) {
            c.push_back({ lerp(p.x, rp2->bx, 0.12), lerp(p.y, rp2->by, 0.10), "offer" });
        }
    }

    if (my && ip == p.team) {
        c.push_back({ p.homeX + fd * 80.0 + pu, p.homeY, "offer" });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY - 35.0, "space" });
        c.push_back({ p.homeX + fd * 50.0 + pu, p.homeY + 35.0, "space" });

        auto& bb2 = engine.blackboards[GameEngine::teamIndex(p.team)];
        if (bb2.oneTwo.has_value() && bb2.oneTwo->from == p.id && engine.state.clockMs < bb2.oneTwo->expires) {
            double oppGoalX = goalXFor(p.team);
            c.push_back({ clampRange(p.x + fd * 80.0, p.homeX + fd * 40.0, oppGoalX), p.y, "space" });
            c.push_back({ clampRange(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y - 30.0, 40.0, PITCH_H - 40.0), "space" });
            c.push_back({ clampRange(p.x + fd * 120.0, p.homeX + fd * 60.0, oppGoalX), clamp(p.y + 30.0, 40.0, PITCH_H - 40.0), "space" });
        }

        if (ba > 0.6 && p.role == Role::CF) {
            double bGoalX = goalXFor(p.team);
            c.push_back({ bGoalX - fd * (35.0 + engine.rng.random() * 55.0),
                          clamp(PITCH_H / 2.0 + (engine.rng.random() - 0.5) * 90.0, PITCH_H * 0.25, PITCH_H * 0.75), "space" });
            c.push_back({ bGoalX - fd * (70.0 + engine.rng.random() * 65.0),
                          clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.25, PITCH_H * 0.25, PITCH_H * 0.75), "offer" });
        } else if (ba > 0.6 && p.role == Role::WM) {
            double bGoalX = goalXFor(p.team);
            double farPostY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
            double insideY = clamp(PITCH_H / 2.0 + (p.homeY - PITCH_H / 2.0) * 0.32, PITCH_H * 0.24, PITCH_H * 0.76);
            c.push_back({ bGoalX - fd * (70.0 + engine.rng.random() * 75.0), farPostY, "space" });
            c.push_back({ bGoalX - fd * (125.0 + engine.rng.random() * 85.0), insideY, "offer" });
        } else if (ba > 0.6 && p.role == Role::CM) {
            double bGoalX = goalXFor(p.team);
            double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
            c.push_back({ bGoalX - fd * (150.0 + engine.rng.random() * 85.0),
                          clamp(PITCH_H / 2.0 - bSide * 55.0, PITCH_H * 0.25, PITCH_H * 0.75), "offer" });
            c.push_back({ bGoalX - fd * (180.0 + engine.rng.random() * 90.0),
                          clamp(PITCH_H / 2.0 + bSide * 70.0, PITCH_H * 0.24, PITCH_H * 0.76), "space" });
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
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), p.homeY, "offer" });
                c.push_back({ clamp(gapX, p.homeX - 40.0, p.homeX + 120.0), clamp(p.homeY - 40.0, 40.0, PITCH_H - 40.0), "space" });
            }
            if (ba < 0.35 && my) {
                c.push_back({ clamp(p.homeX - fd * 30.0, 60.0, PITCH_W - 60.0), p.homeY, "offer" });
                c.push_back({ clamp(p.homeX - fd * 20.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + 35.0, 40.0, PITCH_H - 40.0), "offer" });
            }
            double bSide = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
            c.push_back({ clamp(p.homeX + fd * 30.0 + pu, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 50.0, 40.0, PITCH_H - 40.0), "space" });
            c.push_back({ clamp(p.homeX + fd * 110.0 + pu, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + bSide * 55.0, 50.0, PITCH_H - 50.0), "offer" });
            c.push_back({ clamp(b.x + fd * 90.0, 60.0, PITCH_W - 60.0), clamp(p.homeY + bSide * 35.0, 45.0, PITCH_H - 45.0), "space" });
        }

        if (p.role == Role::WM) {
            double flankY = (p.homeY < PITCH_H / 2.0) ? 18.0 : PITCH_H - 18.0;
            std::string crossPur = ba > 0.45 ? "offer" : "space";
            c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), flankY, crossPur });
            c.push_back({ clampRange(b.x + fd * 115.0, p.homeX + fd * 80.0, goalXFor(p.team) - fd * 45.0), flankY, "cross_lane" });
            double runBehindY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.3 : PITCH_H * 0.7;
            c.push_back({ clamp(p.homeX + fd * 140.0 + pu, 60.0, PITCH_W - 60.0), runBehindY, "space" });
            if (std::abs(b.y - p.homeY) > 200.0) {
                c.push_back({ clamp(p.homeX + fd * 100.0 + pu, 60.0, PITCH_W - 60.0), clamp(lerp(p.y, PITCH_H / 2.0, 0.3), 40.0, PITCH_H - 40.0), "space" });
                c.push_back({ clamp(p.homeX + fd * 80.0 + pu, 60.0, PITCH_W - 60.0), clamp(PITCH_H / 2.0 + ((p.homeY < PITCH_H / 2.0) ? 80.0 : -80.0), 40.0, PITCH_H - 40.0), "space" });
            }
        }

        if (p.role == Role::CB || p.role == Role::FB)
            c.push_back({ p.homeX + fd * 150.0 + pu, p.homeY, "cover" });

        double fld = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ p.homeX + fd * 55.0 + pu, clamp(p.homeY + fld * 50.0, 40.0, PITCH_H - 40.0), "space" });
        c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY - fld * 70.0, 40.0, PITCH_H - 40.0), "switch" });
        if (p.role == Role::WM || p.role == Role::FB)
            c.push_back({ p.homeX + fd * 40.0 + pu, clamp(p.homeY + ((p.homeY < PITCH_H / 2.0) ? -80.0 : 80.0), 30.0, PITCH_H - 30.0), "space" });

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
                              clamp((p.homeY < PITCH_H / 2.0) ? 35.0 : PITCH_H - 35.0, 35.0, PITCH_H - 35.0), "space" });
                c.push_back({ clampRange(wmOnMySide->x + fd * 50.0, p.homeX + fd * 50.0, goalXFor(p.team)),
                              clamp((p.homeY < PITCH_H / 2.0) ? 55.0 : PITCH_H - 55.0, 40.0, PITCH_H - 40.0), "space" });
            } else {
                double wmHomeY = (p.homeY < PITCH_H / 2.0) ? PITCH_H * 0.12 : PITCH_H * 0.88;
                c.push_back({ p.homeX + fd * 120.0 + pu, clamp(wmHomeY, 40.0, PITCH_H - 40.0), "space" });
                c.push_back({ clamp(p.homeX + fd * 185.0 + pu, 60.0, PITCH_W - 60.0), clamp(wmHomeY, 40.0, PITCH_H - 40.0), "overlap" });
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
                c.push_back({ pushX, p.homeY, "offer" });
                double runY = clamp(p.homeY + ((engine.rng.random() > 0.5) ? 40.0 : -40.0), PITCH_H * 0.2, PITCH_H * 0.8);
                c.push_back({ clampRange(defLine - fd * 10.0, p.homeX + fd * 40.0, oppGoalX), runY, "space" });
            }
            if (ba < 0.5 && my) {
                c.push_back({ clamp(p.homeX - fd * 20.0, p.homeX - 60.0, PITCH_W - 60.0), p.homeY, "offer" });
            }
            if (ba > 0.58 && my) {
                double nearPost = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.35 : PITCH_H * 0.65;
                double farPost  = (p.y < PITCH_H / 2.0) ? PITCH_H * 0.65 : PITCH_H * 0.35;
                c.push_back({ clamp(oppGoalX - fd * 55.0, 60.0, PITCH_W - 60.0), nearPost, "space" });
                c.push_back({ clamp(oppGoalX - fd * 80.0, 60.0, PITCH_W - 60.0), farPost, "space" });
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
        c.push_back({ lineX, p.homeY, "cover" });
        c.push_back({ lineX - fd * (p.role == Role::FB ? 6.0 : 15.0), p.homeY, "cover" });
        if (ba < 0.35)
            c.push_back({ clamp(p.homeX + fd * 180.0, lineX + fd * 40.0, PITCH_W - 50.0), p.homeY, "cover" });

        bool ballPastUs = (fd == 1.0) ? b.x > lineX + 20.0 : b.x < lineX - 20.0;
        if (ballPastUs) {
            double dropAmount = p.role == Role::FB ? 10.0 : 20.0;
            double dropX = lineX - fd * dropAmount;
            c.push_back({ dropX, p.homeY, "cover" });
            if (p.role == Role::CB) c.push_back({ dropX - fd * 20.0, p.homeY, "cover" });
        }
        double bSide2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ lineX - fd * 10.0, clamp(p.homeY + bSide2 * 25.0, 40.0, PITCH_H - 40.0), "cover" });
        if (ba < 0.4)
            c.push_back({ clampRange(p.homeX + fd * 220.0, p.homeX + fd * 50.0, goalXFor(p.team) - fd * 50.0), p.homeY, "cover" });
    }

    if (!my) {
        if (p.role != Role::FB && p.role != Role::CB) {
            c.push_back({ clamp((b.x + (ownGoalXFor(p.team))) / 2.0, p.homeX - 80.0, p.homeX + 20.0), p.homeY, "cover" });
        }
        double bf2 = (b.y < PITCH_H / 2.0) ? -1.0 : 1.0;
        c.push_back({ clamp(p.homeX - fd * (p.role == Role::FB ? 4.0 : 30.0), 40.0, PITCH_W - 40.0), clamp(p.homeY + bf2 * 25.0, 40.0, PITCH_H - 40.0), "cover" });
        if (p.role == Role::FB && std::abs(b.y - p.homeY) > 200.0) {
            c.push_back({ clamp(p.homeX + fd * 6.0, 40.0, PITCH_W - 40.0), clamp(lerp(p.homeY, PITCH_H / 2.0, 0.5), 40.0, PITCH_H - 40.0), "cover" });
        }
    }

    std::vector<Action> options;
    for (auto& cn : c) {
        double sf = 0;
        for (auto* o : per.nearbyOpponents) {
            double d2 = std::sqrt((cn.x - o->x) * (cn.x - o->x) + (cn.y - o->y) * (cn.y - o->y));
            if (d2 < 50.0) sf -= (50.0 - d2) / 50.0;
        }
        bool counterOutlet = cn.pur == "counter_outlet" || cn.pur == "rest_forward";
        double tac = my ? (cn.x - p.homeX) * fd / PITCH_W * 0.5 : counterOutlet ? 0.0 : -(cn.x - p.homeX) * fd / PITCH_W * 0.25;
        double og2 = ownGoalXFor(p.team);
        double db = !my ? clamp(((b.x - cn.x) * fd) / (std::abs(b.x - og2) + 1.0), 0.0, 0.30) : 0.0;
        double bp2 = std::sqrt((cn.x - b.x) * (cn.x - b.x) + (cn.y - b.y) * (cn.y - b.y)) / 600.0 * 0.08;
        double ob = counterOutlet ? 0.44 :
                    (cn.pur == "inside_run" && p.role == Role::WM && ba > 0.55) ? 0.17 :
                    (cn.pur == "run_ahead" && p.role == Role::WM) ? 0.14 :
                    (cn.pur == "cross_lane" || cn.pur == "overlap") ? 0.24 :
                    (cn.pur == "hold_width" && p.role == Role::WM && ba > 0.45) ? 0.10 :
                    (cn.pur == "observe") ? 0.10 :
                    (cn.pur == "space" && p.role == Role::WM && std::abs(cn.y - PITCH_H / 2.0) > 150.0 && ba > 0.4) ? 0.12 : 0.0;

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
        static const std::unordered_map<std::string, double> taskScores = {
            {"primary_press", 0.86}, {"secondary_press", 0.72}, {"shot_lane", 0.84}, {"cover", 0.66},
            {"lane_block", 0.86}, {"box_guard", 0.86}, {"far_post_guard", 0.80}, {"defensive_line", 0.72}, {"wide_cover", 0.70},
            {"midfield_screen", 0.72}, {"box_screen", 0.80}, {"support_outlet", 0.47}, {"advance_midfield", 0.60},
            {"run_ahead", 0.64}, {"inside_run", 0.62}, {"hold_width", 0.56},
            {"overlap", 0.66}, {"rest_defence", 0.56}, {"close_down", 0.84},
        };
        double ts = 0.80;
        auto tit = taskScores.find(task->role);
        if (tit != taskScores.end()) ts = tit->second;
        options.push_back(Action{ActionType::Position, ts, nullptr, task->targetX, task->targetY,
                                 "task:" + task->role});
    }

    Player* carrier = engine.playerById(per.ballControllerId);
    if (!my && carrier && carrier->team != p.team && carrier->role != Role::GK) {
        double carrierDist = dist(p.x, p.y, carrier->x, carrier->y);
        double ownGx = ownGoalXFor(p.team);
        bool inOwnHalf = (p.team == Team::Home) ? carrier->x < HALF_X : carrier->x > HALF_X;
        bool inOwnThird = std::abs(carrier->x - ownGx) < PITCH_W * 0.36;
        auto* existingTask = engine.assignmentFor(p.id);
        bool mustHoldShape = existingTask
            && (existingTask->role == "lane_block" || existingTask->role == "box_guard"
                || existingTask->role == "far_post_guard"
                || existingTask->role == "shot_lane"
                || existingTask->role == "defensive_line" || existingTask->role == "wide_cover"
                || existingTask->role == "midfield_screen" || existingTask->role == "box_screen");
        bool roleCanStep = p.role == Role::CM || p.role == Role::FB || p.role == Role::CB
            || (p.role == Role::WM && std::abs(carrier->y - p.y) < 170.0);
        bool localPressure = !mustHoldShape && roleCanStep && inOwnHalf
            && (carrierDist < (inOwnThird ? 118.0 : 86.0));
        if (localPressure) {
            double goalSide = (p.team == Team::Home) ? -1.0 : 1.0;
            double containX = clamp(carrier->x + goalSide * 18.0, 35.0, PITCH_W - 35.0);
            double side = (p.y < carrier->y) ? -1.0 : 1.0;
            double containY = clamp(carrier->y + side * 10.0, 35.0, PITCH_H - 35.0);
            double score = clamp(0.96 - carrierDist / 700.0, 0.72, 0.94);
            options.push_back(Action{ActionType::Position, score, carrier, containX, containY,
                                     "local_close_down"});
        }
    }

    return options;
}

// ══════════════════════════════════════════════════════════════════════════════
// rc() — resolve choice
// ══════════════════════════════════════════════════════════════════════════════
Action PlayerAI::resolveChoice(std::vector<Action>& a) {
    std::sort(a.begin(), a.end(),
              [](const Action& x, const Action& y) { return x.score > y.score; });

    if (a.empty()) return Action{ActionType::Hold, 1.0};

    Action& best = a[0];
    bool ic = (engine.state.ball.controllerId == player.id);
    double gx = goalXFor(player.team);
    bool nearGoal = std::abs(player.x - gx) < 220.0;
    bool inBox    = std::abs(player.x - gx) < 150.0;

    if (ic && best.score < (inBox ? 0.05 : nearGoal ? 0.10 : 0.22))
        return Action{ActionType::Hold, 1.0};

    auto& bb = engine.blackboards[GameEngine::teamIndex(player.team)];

    if (best.type == ActionType::Tackle && best.target) {
        bool isSelf = (bb.pressingPlayerId == player.id || bb.pressingPlayerId2 == player.id);
        bool slot1Free = (bb.pressingPlayerId < 0);
        bool slot2Free = (bb.pressingPlayerId2 < 0);

        if (!isSelf && !slot1Free && !slot2Free) {
            for (auto& x : a) {
                if (x.type != ActionType::Tackle && x.score > 0.15) return x;
            }
            return Action{ActionType::Hold, 1.0};
        }

        if (!isSelf) {
            if (slot1Free)      bb.pressingPlayerId  = player.id;
            else if (slot2Free) bb.pressingPlayerId2 = player.id;
        }
    }

    if (best.type == ActionType::Mark && best.target) {
        auto it = bb.markedOpponents.find(best.target->id);
        if (it != bb.markedOpponents.end() && it->second != player.id) {
            for (auto& x : a) {
                if (x.type != ActionType::Mark && x.type != ActionType::Tackle && x.score > 0.15) return x;
            }
            return Action{ActionType::Hold, 1.0};
        }
        bb.markedOpponents[best.target->id] = player.id;
    }

    if (ic && best.type == ActionType::Pass && best.audit.forwardProgress < -40.0) {
        Action* fwdOpt = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Pass && x.audit.forwardProgress > 30.0 && x.score > best.score - 0.15) {
                fwdOpt = &x; break;
            }
        }
        if (fwdOpt) engine.logQualityFlag("questionable_backpass", player.id, player.role,
                                          best.audit.forwardProgress, true,
                                          fwdOpt->score, best.score,
                                          8000.0, "backpass:" + std::to_string(player.id));
    }

    if (ic) {
        CarrierPressure cp = assessCarrierPressure(engine, player);
        if (cp.score > 0.85) {
            Action* safePass = nullptr;
            for (auto& x : a) {
                if (x.type != ActionType::Pass || !x.target) continue;
                bool safe = x.audit.expectedCompletion > 0.66 && x.audit.blockers <= 1
                    && x.audit.receiverPressure <= 1 && x.audit.distance < 300.0;
                if (!safe) continue;
                if (!safePass || x.score > safePass->score) safePass = &x;
            }
            if (safePass && (best.type == ActionType::Shoot || best.type == ActionType::Dribble)
                && safePass->score > best.score - (cp.exposed > 0.35 ? 0.22 : 0.14)) {
                return *safePass;
            }
        }
    }

    if (ic) {
        double fd = player.team == Team::Home ? 1.0 : -1.0;
        bool finalThird = fd > 0.0 ? player.x > PITCH_W * 2.0 / 3.0 : player.x < PITCH_W / 3.0;
        if (finalThird && player.role == Role::CM && best.type == ActionType::Shoot) {
            Action* frontLinePass = nullptr;
            for (auto& x : a) {
                if (x.type != ActionType::Pass || !x.target) continue;
                if (x.target->role != Role::CF && x.target->role != Role::WM) continue;
                if (x.audit.expectedCompletion < 0.66 || x.audit.blockers > 1 || x.audit.receiverPressure > 1) continue;
                double targetGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                if (targetGoalDist > 230.0 && x.audit.forwardProgress < 40.0) continue;
                if (!frontLinePass || x.score > frontLinePass->score) frontLinePass = &x;
            }
            if (frontLinePass && frontLinePass->score > best.score - 0.22) return *frontLinePass;
        }
        if (finalThird && best.type == ActionType::Pass && best.audit.forwardProgress < 0.0) {
            Action* driveOpt = nullptr;
            Action* shootOpt = nullptr;
            for (auto& x : a) {
                if (x.type == ActionType::Dribble && x.purpose == "space") driveOpt = &x;
                if (x.type == ActionType::Shoot) shootOpt = &x;
            }
            if (shootOpt && shootOpt->score > best.score - 0.12) return *shootOpt;
            if (driveOpt && driveOpt->score > best.score - 0.16) return *driveOpt;
        }
    }

    // CF near goal: bias toward shooting unless teammate has a clear tap-in
    if (ic && player.role == Role::CF && nearGoal && best.type != ActionType::Shoot) {
        Action* shotOpt = nullptr;
        Action* passToTapIn = nullptr;
        for (auto& x : a) {
            if (x.type == ActionType::Shoot) shotOpt = &x;
            if (x.type == ActionType::Pass && x.target) {
                double tGoalDist = std::abs(goalXFor(player.team) - x.target->x);
                if (tGoalDist < 80.0) passToTapIn = &x;
            }
        }
        // If shot exists and passes don't go to a tap-in, prefer shot
        if (shotOpt && !passToTapIn && shotOpt->score > best.score - 0.16) {
            return *shotOpt;
        }
    }

    return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// ex() — execute chosen action
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::executeAction(Action& a, double sdt, std::vector<Action>& actions) {
    auto& p = player;
    auto& b = engine.state.ball;

    lastActionType = a.type;
    lastPurpose = a.purpose;
    lastTargetId = a.target ? a.target->id : -1;

    if (a.type != ActionType::Dribble) p.dribbleType = 0;

    if (a.type == ActionType::Pass && a.target) {
        PassSelectionAudit audit = passSelectionAudit(a, actions);
        bool released;
        if (a.purpose == "clear") {
            engine.forcePassTo(p, *a.target, &audit);
            released = true;
        } else {
            released = engine.passBallTo(p, *a.target, a.purpose == "through", false, &audit);
        }
        if (released) {
            lastPassTargetId = a.target->id;
            recentPassTarget = a.target->id;
            recentPassTime = engine.state.clockMs;
            engine.emitEvent("pass", p.x, p.y, p.id, a.target->id);
            auto& bb = engine.blackboards[GameEngine::teamIndex(p.team)];
            bb.oneTwo = TeamBlackboard::OneTwo{ p.id, a.target->id, engine.state.clockMs + 2000.0 };
            stunLockTicks = 50 + static_cast<int>(engine.rng.random() * 21);
        } else {
            stunLockTicks = 4;
        }
    }
    else if (a.type == ActionType::Shoot) {
        ShotSelectionAudit audit = shotSelectionAudit(a, actions);
        engine.shootBall(p, &audit);
        engine.emitEvent("shot", p.x, p.y, p.id);
        stunLockTicks = 20;
    }
    else if (a.type == ActionType::Dribble) {
        p.targetX = (a.posX != 0) ? a.posX : (goalXFor(p.team));
        p.targetY = (a.posY != 0) ? a.posY : p.y;

        // Count nearby opponents first to decide wobble/shielding
        int nearbyOpps = 0;
        double nearestOppDist = 1e9;
        CarrierPressure cp = assessCarrierPressure(engine, p);
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK) {
                double d = dist(p.x, p.y, o.x, o.y);
                nearestOppDist = std::min(nearestOppDist, d);
                if (d < 55.0) nearbyOpps++;
            }
        }
        if (cp.score > 0.80) nearbyOpps = std::max(nearbyOpps, 2);

        // Wobble only in open space — suppress under pressure
        if (nearestOppDist > 80.0) {
            double wobbleAngle = std::sin(engine.state.clockMs * 0.008 + p.id * 1.7) * 0.3;
            double wobbleDist  = std::sin(engine.state.clockMs * 0.012 + p.id * 2.3) * 12.0;
            p.targetX += std::cos(wobbleAngle) * wobbleDist;
            p.targetY += std::sin(wobbleAngle) * wobbleDist;
        }

        double distToTarget = std::sqrt((p.targetX - p.x) * (p.targetX - p.x)
                                      + (p.targetY - p.y) * (p.targetY - p.y));

        int oppsInPath = 0;
        double fd = (p.team == Team::Home) ? 1.0 : -1.0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK) {
                double pathDist = std::abs(o.x - p.x);
                double lateralDist = std::abs(o.y - p.y);
                if (pathDist < 200.0 && lateralDist < 40.0 && ((fd > 0 && o.x > p.x) || (fd < 0 && o.x < p.x)))
                    oppsInPath++;
            }
        }

        // Knock-ahead: clear lanes with enough grass to run into.
        bool advancedEnough = (fd > 0 && p.x > HALF_X - 100.0) || (fd < 0 && p.x < HALF_X + 100.0);
        bool clearPath = oppsInPath == 0;
        bool spaceAhead = nearestOppDist > 180.0;
        bool openGrass = nearestOppDist > 220.0;
        bool longDistToTarget = distToTarget > 90.0;

        // Check if a teammate can collect (within ~175px of launch point)
        bool teammateSupport = false;
        double launchX = p.x + fd * DRIBBLE_KNOCK_OFFSET;
        double launchY = p.y;
        for (auto& o : engine.state.players) {
            if (o.team == p.team && o.id != p.id && o.role != Role::GK) {
                double d = dist(launchX, launchY, o.x, o.y);
                if (d < 175.0) { teammateSupport = true; break; }
            }
        }

        // Flank bonus: knock-aheads on the flank are safer (less central traffic)
        bool onFlank = std::abs(p.y - PITCH_H / 2.0) > 120.0;
        bool finalThird = (fd > 0.0) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
        bool finalThirdBurst = finalThird && distToTarget > 110.0 && nearestOppDist > 180.0 && clearPath;

        // Open burst: clear path with support, flank safety, or very obvious space.
        bool openBurst = longDistToTarget && spaceAhead && clearPath && advancedEnough
                        && (teammateSupport || onFlank || openGrass || finalThirdBurst);

        // Speculative burst: creative player with some space, advanced enough.
        bool speculativeBurst = distToTarget > 150.0 && nearestOppDist > 75.0 && clearPath
                               && advancedEnough && p.attrs.creativity >= 65.0
                               && (teammateSupport || onFlank || openGrass);

        bool mayBurst = engine.canKnockBallAhead(p.id) && cp.score < 0.65 && (openBurst || speculativeBurst || finalThirdBurst);
        int dribbleType = mayBurst ? 3 : (nearbyOpps >= 2 ? 1 : 2);

        bool newEpisode = (p.dribbleType != dribbleType);
        if (newEpisode) {
            engine.stats.recordDribble(dribbleType);
        }
        p.dribbleType = dribbleType;
        if (dribbleType == 3 && newEpisode) engine.knockBallAhead(p, p.targetX, p.targetY);

        double oppGoalX = goalXFor(p.team);
        if ((fd == 1.0 && p.targetX < p.x - 10.0) || (fd == -1.0 && p.targetX > p.x + 10.0)) {
            if (std::abs(p.x - oppGoalX) < 300.0) {
                int closeOpps = 0;
                for (auto& o : engine.state.players) {
                    if (o.team != p.team && o.role != Role::GK && dist(p.x, p.y, o.x, o.y) < 60.0) closeOpps++;
                }
                if (closeOpps == 0) {
                    int myScore  = (p.team == Team::Home) ? engine.state.homeScore : engine.state.awayScore;
                    int oppScore = (p.team == Team::Home) ? engine.state.awayScore : engine.state.homeScore;
                    bool isTimeWasting = (myScore <= oppScore && engine.state.clockMs > 60000.0);
                    if (isTimeWasting) engine.logQualityFlag(isTimeWasting ? "time_wasting_dribble" : "backward_dribble",
                                          p.id, p.role, (double)p.targetX, 0.0, 0.0, "", 0.0);
                }
            }
        }
    }
    else if (a.type == ActionType::Tackle) {
        if (a.target && dist(p.x, p.y, a.target->x, a.target->y) <= TACKLE_RANGE
            && engine.attemptTackle(p, *a.target))
        {
            engine.emitEvent("tackle", (p.x + a.target->x) / 2.0, (p.y + a.target->y) / 2.0, p.id, a.target->id);
            p.tackleAnim = engine.state.ball.controllerId == p.id ? 220.0 : 800.0;
        } else {
            p.targetX = a.target ? a.target->x : p.x;
            p.targetY = a.target ? a.target->y : p.y;
        }
    }
    else if (a.type == ActionType::Mark && a.target) {
        double leadX = a.target->x + a.target->vx * 0.45;
        double leadY = a.target->y + a.target->vy * 0.45;
        double ownGx = ownGoalXFor(p.team);
        double goalSide = p.team == Team::Home ? -1.0 : 1.0;
        p.targetX = clamp(leadX + goalSide * 18.0, leadX - 45.0, leadX + 45.0);
        p.targetY = clamp(leadY, 30.0, PITCH_H - 30.0);
    }
    else if (a.type == ActionType::Chase) {
        double tx = (a.posX != 0) ? a.posX : b.x;
        double ty = (a.posY != 0) ? a.posY : b.y;
        p.targetX = tx;
        p.targetY = ty;
        double ms = attrFactor(p.attrs.speed) * SPEED_SPRINT;
        double cdx = tx - p.x, cdy = ty - p.y;
        double cd = std::sqrt(cdx * cdx + cdy * cdy);
        if (cd > 1.0) {
            p.vx = lerp(p.vx, (cdx / cd) * ms, 0.15);
            p.vy = lerp(p.vy, (cdy / cd) * ms, 0.15);
        }
    }
    else if (a.type == ActionType::Position) {
        p.targetX = (a.posX != 0) ? a.posX : p.homeX;
        p.targetY = (a.posY != 0) ? a.posY : p.homeY;
        if (!a.purpose.empty() && a.purpose.rfind("task:", 0) == 0)
            engine.noteTaskSelection(p, a.purpose.substr(5));
    }
    else if (a.type == ActionType::Hold) {
        if (b.controllerId == p.id) {
            auto near = engine.nearPlayers(p, 60.0);
            Player* closestOpp = nullptr;
            double closestD = 1e9;
            for (auto* o : near) {
                if (o->team != p.team) {
                    double d = dist(p.x, p.y, o->x, o->y);
                    if (d < closestD) { closestD = d; closestOpp = o; }
                }
            }
            if (closestOpp) {
                p.targetX = clamp(p.x + (p.x - closestOpp->x) * 0.5, 35.0, PITCH_W - 35.0);
                p.targetY = clamp(p.y + (p.y - closestOpp->y) * 0.5, 35.0, PITCH_H - 35.0);
            } else {
                p.targetX = clamp(goalXFor(p.team), 40.0, PITCH_W - 40.0);
                p.targetY = clamp(p.y + (engine.rng.random() - 0.5) * 20.0, 40.0, PITCH_H - 40.0);
            }
        }
    }

    if (engine.state.ball.controllerId != p.id) {
        applyMovement(sdt);
        if (a.type == ActionType::Chase) tryCollectAfterChase();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// gp() — get perception (cached)
// ══════════════════════════════════════════════════════════════════════════════
Perception PlayerAI::getCachedPerception() {
    perceptionAge++;
    if (cachedPerception.has_value() && perceptionAge < 3) return cachedPerception.value();
    cachedPerception = perceive();
    perceptionAge = 0;
    return cachedPerception.value();
}

// ══════════════════════════════════════════════════════════════════════════════
// pr() — perceive surroundings
// ══════════════════════════════════════════════════════════════════════════════
Perception PlayerAI::perceive() {
    const auto& p = player;
    auto& b = engine.state.ball;
    double dx = b.x - p.x, dy = b.y - p.y, bd = std::sqrt(dx * dx + dy * dy);

    Perception per;
    per.ballDist = bd;
    per.ballIsLoose = (b.controllerId < 0);
    per.iAmController = (b.controllerId == p.id);
    per.intendedId = b.intendedReceiverId;
    per.nearestOpponentDist = 1e9;

    int pc = 0;

    for (auto& o : engine.state.players) {
        if (o.id == p.id) continue;
        double d = dist(p.x, p.y, o.x, o.y);
        if (d > PLAYER_AWARE_RANGE) continue;

        bool inCone = false;
        if (d < 40.0) {
            inCone = true;
        } else {
            double angleTo = std::atan2(o.y - p.y, o.x - p.x);
            double diff = std::abs(angleTo - facing);
            double nd = (diff > 3.141592653589793) ? 2.0 * 3.141592653589793 - diff : diff;
            bool isOwnThird = (p.team == Team::Home) ? b.x < PITCH_W / 3.0 : b.x > PITCH_W * 2.0 / 3.0;
            bool defenderWide = (p.role == Role::CB || p.role == Role::FB) && isOwnThird;
            inCone = nd < (defenderWide ? 3.141592653589793 / 2.0 : 3.141592653589793 / 3.0);
        }
        if (!inCone) continue;

        if (o.team == p.team) {
            per.nearbyTeammates.push_back(&o);
        } else {
            per.nearbyOpponents.push_back(&o);
            if (d < per.nearestOpponentDist) per.nearestOpponentDist = d;
            if (d < 60.0) pc++;
        }
    }

    per.pressureCount = pc;

    Player* ctrl = engine.playerById(b.controllerId);
    if (ctrl) {
        per.ballControllerId = ctrl->id;
        per.ballControllerTeam = ctrl->team;
    } else {
        per.ballControllerTeam = engine.teamInPossession();
    }

    bool ac = true, ao = false;
    int cc = 0;
    double ctd = 1e9;

    for (auto& o : engine.state.players) {
        if (o.id == p.id || o.role == Role::GK) continue;
        double d = dist(o.x, o.y, b.x, b.y);
        if (o.team == p.team && d < bd) { cc++; if (d < ctd) ctd = d; }
        if (o.team != p.team && d < bd) ao = true;
    }
    if (cc > 0 && ctd < bd - 30.0) ac = false;

    per.amClosestToBall = ac;
    per.chasingTeammatesCount = cc;
    per.anyOpponentCloserToBall = ao;

    return per;
}

// ══════════════════════════════════════════════════════════════════════════════
// am() — apply movement
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::applyMovement(double sdt) {
    auto& p = player;
    if (p.role == Role::GK) return;
    if (setPieceHold) return;

    double secs = sdt / 1000.0;
    double spd = std::sqrt(p.vx * p.vx + p.vy * p.vy);

    if (spd > SPEED_SPRINT * 0.5)
        p.stamina = std::max(0.0, p.stamina - STAMINA_DRAIN_SPRINT);
    else if (spd < 15.0)
        p.stamina = std::min(100.0, p.stamina + STAMINA_RECOVER);

    double sf = (p.stamina < STAMINA_SLOW_THRESHOLD * 100.0) ? p.stamina / 100.0 : 1.0;

    double dx = p.targetX - p.x, dy = p.targetY - p.y;
    double d = std::sqrt(dx * dx + dy * dy);

    bool pressTask      = (lastPurpose == "task:primary_press");
    bool secondaryPress = (lastPurpose == "task:secondary_press");
    bool committedChase = (lastActionType == ActionType::Chase && engine.state.ball.controllerId < 0)
                       || (lastActionType == ActionType::Chase && lastPurpose == "receive_ball")
                       || (lastActionType == ActionType::Chase && lastPurpose == "recover_loose_ball");

    double bdx = engine.state.ball.x - p.x, bdy = engine.state.ball.y - p.y;
    double bd  = std::sqrt(bdx * bdx + bdy * bdy);
    double ownGoalX = ownGoalXFor(p.team);

    bool carrierCornered = (engine.state.ball.x < 80.0 || engine.state.ball.x > PITCH_W - 80.0)
                        && (engine.state.ball.y < 80.0 || engine.state.ball.y > PITCH_H - 80.0);
    bool predatorial = (pressTask || secondaryPress) && carrierCornered;

    bool committedPress = (pressTask && bd > 45.0 && (bd < PRESS_COMMIT_MAX_DIST || std::abs(engine.state.ball.x - ownGoalX) < DANGER_ZONE_DIST))
                        || predatorial;

    bool isObserving = !committedChase && !committedPress && bd > 300.0 && bd > PLAYER_AWARE_RANGE * 0.5;

    // Defenders sprint when carrier is in their half
    bool defendSprint = false;
    if ((p.role == Role::CB || p.role == Role::FB || p.role == Role::CM) && !isObserving) {
        auto* task = engine.assignmentFor(p.id);
        if (task && task->role == "close_down") defendSprint = true;
        else if (task && (task->role == "lane_block" || task->role == "box_guard" || task->role == "far_post_guard"
            || task->role == "shot_lane"
            || task->role == "midfield_screen" || task->role == "box_screen" || task->role == "defensive_line"
            || task->role == "wide_cover")) {
            Player* carrier = engine.state.ball.controllerId >= 0 ? engine.playerById(engine.state.ball.controllerId) : nullptr;
            double tdist = dist(p.x, p.y, task->targetX, task->targetY);
            if (carrier && carrier->team != p.team && std::abs(carrier->x - ownGoalX) < PITCH_W * 0.45 && tdist > 32.0) {
                defendSprint = true;
            }
        }
        else if (engine.state.ball.controllerId >= 0) {
            Player* carrier = engine.playerById(engine.state.ball.controllerId);
            if (carrier && carrier->team != p.team && bd < 200.0) defendSprint = true;
        }
    }

    double cruiseMul = isObserving
        ? (p.role == Role::CF ? 0.45 : p.role == Role::CB || p.role == Role::FB ? 0.65 : p.role == Role::WM ? 0.55 : 0.50)
        : 1.0;

    double baseSpeed = (engine.isActiveKnockAheadRunner(p.id) || p.dribbleType == 3)
        ? DRIBBLE_FAST_SPEED
        : (lastActionType == ActionType::Chase || committedPress || defendSprint ? SPEED_SPRINT : SPEED_RUN);

    // Shielding: slow down when near opponents with ball
    bool isController = (engine.state.ball.controllerId == p.id);
    if (isController && bd < 60.0) {
        baseSpeed *= 0.80; // 20% slower when shielding
    }

    double df = (committedChase || committedPress || defendSprint) ? 1.0 : std::min(d / 120.0, 1.5);
    double ms = attrFactor(p.attrs.speed) * baseSpeed * sf * df * cruiseMul;

    double px = p.x, py = p.y;
    if (d > 1.0) {
        double sp = std::min(ms * secs, d);
        p.x += (dx / d) * sp;
        p.y += (dy / d) * sp;
    }

    if (secs > 0.001) {
        p.vx = (p.x - px) / secs;
        p.vy = (p.y - py) / secs;
    }

    double bAngle = std::atan2(engine.state.ball.y - p.y, engine.state.ball.x - p.x);
    double bDiff  = std::abs(bAngle - facing);
    double bNorm  = (bDiff > 3.141592653589793) ? 2.0 * 3.141592653589793 - bDiff : bDiff;
    if (bNorm < 3.141592653589793 / 3.0) {
        ballMemoryX = engine.state.ball.x;
        ballMemoryY = engine.state.ball.y;
        ballMemoryAge = 0;
    } else {
        ballMemoryAge++;
    }

    double spdAfter = std::sqrt(p.vx * p.vx + p.vy * p.vy);
    bool ic = (engine.state.ball.controllerId == p.id);
    if (ic) {
        // Find nearest opponent for shielding
        double nearOppDist = 1e9;
        double nearOppX = 0, nearOppY = 0;
        for (auto& o : engine.state.players) {
            if (o.team != p.team && o.role != Role::GK) {
                double d = dist(p.x, p.y, o.x, o.y);
                if (d < nearOppDist) { nearOppDist = d; nearOppX = o.x; nearOppY = o.y; }
            }
        }

        if (nearOppDist < 60.0) {
            // Shielding: face AWAY from nearest opponent (slow lerp to avoid spinning)
            double awayAngle = std::atan2(p.y - nearOppY, p.x - nearOppX);
            facing = facing + std::atan2(std::sin(awayAngle - facing), std::cos(awayAngle - facing)) * 0.04;
        } else {
            // Open field: face toward ball velocity (movement direction)
            auto& b = engine.state.ball;
            double bs = std::hypot(b.vx, b.vy);
            if(bs > 0.5) facing = facing + std::atan2(std::sin(std::atan2(-b.vy, -b.vx) - facing), std::cos(std::atan2(-b.vy, -b.vx) - facing)) * 0.05;
        }
    } else if (engine.state.ball.controllerId >= 0) {
        Player* carrier = engine.playerById(engine.state.ball.controllerId);
        if (carrier && carrier->team != p.team && bd < 170.0) {
            double ballAngle = std::atan2(bdy, bdx);
            facing = facing + std::atan2(std::sin(ballAngle - facing), std::cos(ballAngle - facing)) * 0.18;
        } else if (spdAfter > 5.0) {
            double moveAngle = std::atan2(p.vy, p.vx);
            facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * 0.06;
        }
    } else if (engine.state.ball.controllerId < 0 && bd < 80.0) {
        double ballAngle = std::atan2(bdy, bdx);
        facing = facing + std::atan2(std::sin(ballAngle - facing), std::cos(ballAngle - facing)) * 0.15;
    } else if (spdAfter > 5.0) {
        double moveAngle = std::atan2(p.vy, p.vx);
        facing = facing + std::atan2(std::sin(moveAngle - facing), std::cos(moveAngle - facing)) * 0.06;
    } else if (ballMemoryAge > 30) {
        double memAngle = std::atan2(ballMemoryY - p.y, ballMemoryX - p.x);
        facing = facing + std::atan2(std::sin(memAngle - facing), std::cos(memAngle - facing)) * 0.02;
    }

    double prevFacing = p.facing;
    double facingDelta = std::abs(std::atan2(std::sin(facing - prevFacing), std::cos(facing - prevFacing)));
    dizzyRotationAccum += facingDelta * 180.0 / 3.141592653589793;
    if(engine.state.clockMs - dizzyWindowStartMs > 2000){
        dizzyWindowStartMs = engine.state.clockMs;
        dizzyRotationAccum = facingDelta * 180.0 / 3.141592653589793;
    }
    facing = std::atan2(std::sin(facing), std::cos(facing));
    p.facing = facing;
}

// ══════════════════════════════════════════════════════════════════════════════
// tryCollectAfterChase()
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::tryCollectAfterChase() {
    auto& p = player;
    auto& b = engine.state.ball;

    if (b.controllerId >= 0) return;

    double distance = dist(p.x, p.y, b.x, b.y);
    bool intended = (p.id == b.intendedReceiverId);
    double reach = intended ? INTENDED_COLLECT_DIST : COLLECT_DIST;

    if (b.z >= 20.0 || distance > reach) return;

    double speed = std::hypot(b.vx, b.vy);
    double speedLimit = intended ? COLLECT_SPEED_MAX * INTENDED_COLLECT_BONUS : COLLECT_SPEED_MAX;

    if (speed >= speedLimit) return;

    if (!engine.collectBall(p, intended ? "intended_chase_reception" : "chase_collection", reach)) return;

    // Position-based stun lock: short in opponent's final third, long elsewhere
    double gx = goalXFor(p.team);
    bool inFinalThird = (p.team == Team::Home) ? p.x > PITCH_W * 2.0 / 3.0 : p.x < PITCH_W / 3.0;
    if (inFinalThird) {
        stunLockTicks = 12;  // ~200ms — react quickly near goal
        shotCooldown = 0;    // can shoot immediately in the box
    } else {
        stunLockTicks = 45;  // ~750ms — settle time in midfield
        shotCooldown = 15;   // ~250ms — brief cooldown after collect
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// passSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
PassSelectionAudit PlayerAI::passSelectionAudit(const Action& choice,
                                                   const std::vector<Action>& actions)
{
    const auto& chosen = choice.audit;
    if (!choice.target) return {};

    const Action* safer = nullptr;
    double saferComp = 0;
    for (auto& a : actions) {
        if (a.type != ActionType::Pass || !a.target || a.target->id == choice.target->id) continue;
        if (!a.audit.expectedCompletion || !a.audit.forwardProgress) continue;
        if (a.audit.expectedCompletion >= chosen.expectedCompletion + 0.12
            && a.audit.forwardProgress >= chosen.forwardProgress - 35.0
            && a.score >= choice.score - 0.04)
        {
            if (!safer || a.audit.expectedCompletion > saferComp) {
                safer = &a;
                saferComp = a.audit.expectedCompletion;
            }
        }
    }

    PassSelectionAudit out;
    out.score             = choice.score;
    out.distance          = chosen.distance;
    out.forwardProgress   = chosen.forwardProgress;
    out.expectedCompletion = chosen.expectedCompletion;
    out.blockers          = chosen.blockers;
    out.receiverPressure  = chosen.receiverPressure;
    out.purpose           = choice.purpose.empty() ? "keep" : choice.purpose;
    out.saferOptionTargetId  = safer ? safer->target->id : -1;
    out.saferOptionScore      = safer ? safer->score : 0;
    out.saferOptionCompletion = safer ? safer->audit.expectedCompletion : 0;
    out.saferOptionProgress   = safer ? safer->audit.forwardProgress : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// shotSelectionAudit()
// ══════════════════════════════════════════════════════════════════════════════
ShotSelectionAudit PlayerAI::shotSelectionAudit(const Action& choice,
                                                    const std::vector<Action>& actions)
{
    const auto& shot = choice.audit;
    if (choice.score < 0) return {};

    const Action* bestPass = nullptr;
    for (auto& a : actions) {
        if (a.type == ActionType::Pass && a.target) {
            if (!bestPass || a.score > bestPass->score) bestPass = &a;
        }
    }

    ShotSelectionAudit out;
    out.score             = choice.score;
    out.distance          = shot.distance;
    out.angleDeg          = shot.angleDeg;
    out.pressureCount     = shot.pressureCount;
    out.bestPassTargetId  = bestPass ? bestPass->target->id : -1;
    out.bestPassScore     = bestPass ? bestPass->score : 0;
    out.bestPassCompletion = bestPass ? bestPass->audit.expectedCompletion : 0;
    return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// auditDefensiveMovement()
// ══════════════════════════════════════════════════════════════════════════════
void PlayerAI::auditDefensiveMovement(const Action& choice) {
    auto* task = engine.assignmentFor(player.id);
    Player* controller = engine.playerById(engine.state.ball.controllerId);
    if (!task || !controller || controller->team == player.team) return;
    if (task->role != "primary_press" && task->role != "secondary_press") return;
    if (choice.type == ActionType::Tackle || choice.type == ActionType::Chase
        || (!choice.purpose.empty() && choice.purpose.rfind("task:", 0) == 0))
        return;

    double targetX = choice.target ? choice.target->x : (choice.posX != 0 ? choice.posX : player.targetX);
    double targetY = choice.target ? choice.target->y : (choice.posY != 0 ? choice.posY : player.targetY);

    double currentDistance = dist(player.x, player.y, controller->x, controller->y);
    double targetDistance = std::hypot(targetX - controller->x, targetY - controller->y);

    double ownGoalX = ownGoalXFor(player.team);
    bool danger = std::abs(controller->x - ownGoalX) < 240.0;

    if (!danger && targetDistance <= currentDistance + 12.0) return;

    engine.logQualityFlag("why_player_running_direction", player.id, task->role,
                          controller->id, choice.type, choice.purpose,
                          currentDistance, targetDistance, danger ? 1.0 : 0.0,
                          8000.0, std::string("why_player_running_direction:") + std::string(to_string(player.team)));
    engine.captureDecisionMoment("why_player_running_direction", player,
                                 choice.type,
                                 choice.score, 0.0, currentDistance, targetDistance,
                                 danger ? 1 : 0,
                                 8000.0, std::string("why_player_running_direction:") + std::string(to_string(player.team)));
}

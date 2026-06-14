#include "engine.h"
#include "agent.h"
#include "agent_helpers.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Defense pipeline helpers — extracted from assignDefensiveRoles()
// ══════════════════════════════════════════════════════════════

// ── Phase 1: Rank defenders by proximity and suitability ──

SmallVector<GameEngine::DefenseContext::Rated, 12> GameEngine::rankDefenders(Team team, Player& carrier) {
    SmallVector<DefenseContext::Rated, 12> ranked;
    bool danger = std::abs(carrier.x - ownGoalXFor(team)) < DANGER_ZONE_DIST;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK) continue;
        double distance = dist(p.x, p.y, carrier.x, carrier.y);
        double speed = std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
        double roleCost = agentFor(p)->defensivePressCost(danger);
        ranked.push_back({&p, distance, distance / speed,
            distance - attrFactor(p.attrs.speed) * 45.0 - attrFactor(p.attrs.tackling) * 35.0 + roleCost});
    }
    if (ranked.empty()) return ranked;
    std::sort(ranked.begin(), ranked.end(), [](const DefenseContext::Rated& a, const DefenseContext::Rated& b) { return a.score < b.score; });
    auto quickest = std::min_element(ranked.begin(), ranked.end(),
        [](const DefenseContext::Rated& a, const DefenseContext::Rated& b) { return a.eta < b.eta; });
    if (quickest != ranked.end() && ranked.front().eta > quickest->eta + (danger ? 0.40 : 0.52)) {
        DefenseContext::Rated urgent = *quickest;
        ranked.erase(quickest);
        ranked.insert(ranked.begin(), urgent);
    }
    return ranked;
}

// ── Phase 2: Primary press ──

void GameEngine::assignPrimaryPress(DefenseContext& ctx, Player& carrier) {
    Player* primary = ctx.ranked.front().player;
    if (ctx.danger) {
        for (const auto& option : ctx.ranked) {
            Player* p = option.player;
            if (agentFor(*p)->isCenterBack()) continue;
            if (option.distance > 190.0 || option.eta > ctx.ranked.front().eta + 0.18) continue;
            primary = p;
            break;
        }
    }
    setAssignment(*primary, DefensiveTask::PrimaryPress, carrier.x - ctx.fd * 16.0, carrier.y, carrier.id);
    ctx.assigned[primary->id] = true;
}

// ── Phase 3: Secondary press ──

void GameEngine::assignSecondaryPress(DefenseContext& ctx, Player& carrier) {
    // A carrier in shooting range always draws the second man — pressure on
    // the shooter is the defense's answer to clean long-range sight.
    if (ctx.tactics.aggression < 62.0 && !ctx.danger && !ctx.shootingRange) return;
    for (const auto& option : ctx.ranked) {
        Player* p = option.player;
        if (ctx.used(p) || agentFor(*p)->isCenterBack()
            || (ctx.danger && agentFor(*p)->isFullBack() && std::abs(p->homeY - carrier.y) > 210.0)
            || option.distance >= (ctx.danger ? 285.0 : 250.0)) continue;
        setAssignment(*p, DefensiveTask::SecondaryPress, carrier.x - ctx.fd * 42.0,
            carrier.y + (p->homeY < carrier.y ? -38.0 : 38.0), carrier.id);
        ctx.assigned[p->id] = true;
        break;
    }
}

// ── Phase 4: Shot lane ──

void GameEngine::assignShotLane(DefenseContext& ctx, Player& carrier) {
    if (!ctx.shootingRange) return;
    Player* lane = nullptr;
    double bestLane = 1e9;
    double laneX = lerp(carrier.x, ctx.ownGoalX + ctx.fd * 24.0, ctx.danger ? 0.34 : 0.26);
    double laneY = lerp(carrier.y, PITCH_H / 2.0, ctx.danger ? 0.34 : 0.24);
    for (auto& p : state.players) {
        if (p.team != ctx.team || ctx.used(&p) || p.role == Role::GK || p.role == Role::CF || p.role == Role::WM) continue;
        double roleCost = agentFor(p)->shotLaneCost();
        double score = dist(p.x, p.y, laneX, laneY) + roleCost;
        if (score < bestLane) { bestLane = score; lane = &p; }
    }
    if (lane) {
        setAssignment(*lane, DefensiveTask::ShotLane, laneX, laneY, carrier.id);
        ctx.assigned[lane->id] = true;
    }
    // Second body DEEP in the lane, near where the aim lines to either post
    // converge — the mid-lane blocker is stepped around or misses the post-
    // bound line by a body width; the deep cover can't be.
    Player* lane2 = nullptr;
    double bestLane2 = 1e9;
    double lane2X = lerp(carrier.x, ctx.ownGoalX + ctx.fd * 24.0, ctx.danger ? 0.55 : 0.46);
    double lane2Y = lerp(carrier.y, PITCH_H / 2.0, ctx.danger ? 0.50 : 0.40);
    for (auto& p : state.players) {
        if (p.team != ctx.team || ctx.used(&p) || p.role == Role::GK || p.role == Role::CF || p.role == Role::WM) continue;
        double score = dist(p.x, p.y, lane2X, lane2Y) + agentFor(p)->shotLaneCost();
        if (score < bestLane2) { bestLane2 = score; lane2 = &p; }
    }
    if (lane2) {
        setAssignment(*lane2, DefensiveTask::ShotLane, lane2X, lane2Y, carrier.id);
        ctx.assigned[lane2->id] = true;
    }
}

// ── Phase 5: Cross lane ──

void GameEngine::assignCrossLane(DefenseContext& ctx, Player& carrier) {
    if (!ctx.wideDanger) return;
    Player* crossLane = nullptr;
    double bestCrossLane = 1e9;
    // Stand IN the delivery path, halfway to the goal mouth — a body on
    // the flight line gets the cut-out roll on every whip that comes through.
    double crossX = lerp(carrier.x, ctx.ownGoalX + ctx.fd * 62.0, 0.50);
    double crossY = lerp(carrier.y, PITCH_H / 2.0, 0.50);
    for (auto& p : state.players) {
        if (p.team != ctx.team || ctx.used(&p) || p.role == Role::GK || p.role == Role::CF) continue;
        double roleCost = agentFor(p)->crossLaneCost();
        double score = dist(p.x, p.y, crossX, crossY) + roleCost;
        if (score < bestCrossLane) { bestCrossLane = score; crossLane = &p; }
    }
    if (crossLane) {
        setAssignment(*crossLane, DefensiveTask::CrossLane, crossX, crossY, carrier.id);
        ctx.assigned[crossLane->id] = true;
    }
}

// ── Phase 6: Cover roles (CM + danger CB) ──

void GameEngine::assignCoverRoles(DefenseContext& ctx, Player& carrier) {
    for (const auto& option : ctx.ranked) {
        Player* p = option.player;
        if (ctx.used(p) || p->role != Role::CM) continue;
        setAssignment(*p, DefensiveTask::Cover, lerp(carrier.x, ctx.ownGoalX + ctx.fd * 115.0, 0.58),
            lerp(carrier.y, PITCH_H / 2.0, 0.4), carrier.id);
        ctx.assigned[p->id] = true;
        break;
    }
    if (ctx.danger) {
        for (const auto& option : ctx.ranked) {
            Player* p = option.player;
            if (ctx.used(p) || p->role != Role::CB) continue;
            setAssignment(*p, DefensiveTask::Cover, ctx.ownGoalX + ctx.fd * 112.0,
                lerp(carrier.y, PITCH_H / 2.0, 0.35), carrier.id);
            ctx.assigned[p->id] = true;
            break;
        }
    }
}

// ── Phase 7: Midfield screen ──

void GameEngine::assignMidfieldScreen(DefenseContext& ctx, Player& carrier) {
    // The first screen stands ON the most dangerous passing lane (carrier to
    // the deepest central threat), not just in space — a body in the lane is
    // an interception, a body near it is scenery.
    const Player* laneThreat = nullptr;
    double bestDepth = 1e9;
    for (auto& opp : state.players) {
        if (opp.team == ctx.team || opp.role == Role::GK || opp.id == carrier.id) continue;
        if (std::abs(opp.y - PITCH_H / 2.0) > 190.0) continue;
        double depth = std::abs(opp.x - ctx.ownGoalX);
        if (depth < bestDepth) { bestDepth = depth; laneThreat = &opp; }
    }
    int screenCount = 0;
    for (auto& p : state.players) {
        if (p.team == ctx.team && agentFor(p)->isCentralMidfielder() && !ctx.used(&p)) {
            double screenDepth = ctx.danger ? 122.0 + screenCount * 26.0 : 175.0 + screenCount * 22.0;
            double screenX, screenY;
            if (screenCount == 0 && laneThreat) {
                screenX = lerp(carrier.x, laneThreat->x, 0.55);
                screenY = lerp(carrier.y, laneThreat->y, 0.55);
            } else {
                screenX = lerp(carrier.x, ctx.ownGoalX + ctx.fd * screenDepth, ctx.danger ? 0.58 : 0.4);
                screenY = screenCount == 0
                    ? lerp(carrier.y, PITCH_H / 2.0, ctx.danger ? 0.78 : 0.65)
                    : clamp(PITCH_H / 2.0 + (carrier.y < PITCH_H / 2.0 ? 74.0 : -74.0), 70.0, PITCH_H - 70.0);
            }
            setAssignment(p, DefensiveTask::MidfieldScreen, screenX, screenY);
            ctx.assigned[p.id] = true;
            if (++screenCount >= (ctx.danger ? 2 : 1)) break;
        }
    }
    // In danger the striker drops onto the same screen duty — eleven men
    // defend a lead-threatening attack, not nine.
    if (ctx.danger) {
        for (auto& p : state.players) {
            if (p.team != ctx.team || ctx.used(&p) || p.role != Role::CF) continue;
            setAssignment(p, DefensiveTask::MidfieldScreen,
                ctx.ownGoalX + ctx.fd * 215.0, lerp(carrier.y, PITCH_H / 2.0, 0.6));
            ctx.assigned[p.id] = true;
            break;
        }
    }
}

// ── Phase 8: Close-down CB ──

void GameEngine::assignCloseDown(DefenseContext& ctx, Player& carrier) {
    if (ctx.danger) return;
    bool carrierInHalf = (ctx.fd == 1.0) ? carrier.x < HALF_X : carrier.x > HALF_X;
    if (!carrierInHalf) return;
    Player* closeCb = nullptr;
    double closeCbDist = 1e9;
    for (auto& defender : state.players) {
        if (defender.team != ctx.team || !agentFor(defender)->isCenterBack() || ctx.used(&defender)) continue;
        double cbDist = dist(defender.x, defender.y, carrier.x, carrier.y);
        if (cbDist < 190.0 && cbDist < closeCbDist) { closeCbDist = cbDist; closeCb = &defender; }
    }
    if (closeCb) {
        double goalCenterY = PITCH_H / 2.0;
        double cutX = lerp(carrier.x, ctx.ownGoalX + ctx.fd * 40.0, 0.25);
        double cutY = lerp(carrier.y, goalCenterY, 0.20);
        double side = (closeCb->y < carrier.y) ? -1.0 : 1.0;
        cutY = clamp(cutY + side * 30.0, 40.0, PITCH_H - 40.0);
        setAssignment(*closeCb, DefensiveTask::CloseDown, cutX, cutY);
        ctx.assigned[closeCb->id] = true;
    }
}

// ── Phase 9: Threat identification ──

SmallVector<GameEngine::DefenseContext::Threat, 12> GameEngine::identifyThreats(DefenseContext& ctx, Player& carrier) {
    SmallVector<DefenseContext::Threat, 12> threats;
    for (auto& attacker : state.players) {
        if (attacker.team == ctx.team || attacker.role == Role::GK || attacker.id == carrier.id) continue;
        double depth = std::abs(attacker.x - ctx.ownGoalX);
        double yDist = std::abs(attacker.y - PITCH_H / 2.0);
        bool threatens = agentFor(attacker)->isOffensiveThreat(depth, ctx.danger, yDist);
        if (threatens) threats.push_back({&attacker, depth});
    }
    std::sort(threats.begin(), threats.end(), [](const DefenseContext::Threat& a, const DefenseContext::Threat& b) { return a.depth < b.depth; });
    // The ball's intended receiver is ALWAYS a threat, however shallow — the
    // depth sort dropped him whenever deeper runners existed, leaving the one
    // man actually getting the ball unmarked.
    if (Player* rcv = playerById(state.ball.intendedReceiverId)) {
        if (rcv->team != ctx.team && rcv->role != Role::GK && rcv->id != carrier.id) {
            bool present = false;
            for (auto& t : threats) if (t.player->id == rcv->id) { present = true; break; }
            if (!present) threats.push_back({rcv, std::abs(rcv->x - ctx.ownGoalX)});
        }
    }
    if (threats.size() > (ctx.danger ? 6u : 4u)) threats.resize(ctx.danger ? 6u : 4u);
    return threats;
}

// ── Phase 10: Mark offensive threats ──

void GameEngine::assignThreatMarking(DefenseContext& ctx, Player& carrier) {
    for (const auto& threat : ctx.threats) {
        Player* marker = nullptr;
        double best = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != ctx.team || ctx.used(&defender)) continue;
            double roleBonus = agentFor(*threat.player)->markerRoleBonus(*agentFor(defender), ctx.danger);
            if (roleBonus >= 1e8) continue;
            if (threat.player->role == Role::WM && !agentFor(defender)->isCenterBack()
                && std::abs(defender.homeY - threat.player->y) >= PITCH_H * 0.42) continue;
            double score = dist(defender.x, defender.y, threat.player->x, threat.player->y) + roleBonus;
            if (score < best) { best = score; marker = &defender; }
        }
        if (marker) {
            // Sag off the man when the ball is far — gluing the marker to a
            // static attacker for minutes reads as two players waiting at a
            // bus stop. Tight when the ball threatens, zonal when it doesn't.
            double ballDist = dist(state.ball.x, state.ball.y, threat.player->x, threat.player->y);
            double sag = clamp((ballDist - 180.0) / 420.0, 0.0, 1.0);
            // Never sag off a threat already near our goal — box runners must
            // stay marked even when the ball is on the other flank.
            if (std::abs(threat.player->x - ctx.ownGoalX) < 280.0) sag *= 0.12;
            bool receiverThreat = state.ball.intendedReceiverId == threat.player->id;
            // The man the ball is traveling to gets touch-tight goal-side
            // marking, no sag — pressure at the reception point turns a
            // delivery into a contested duel instead of a free meet.
            if (receiverThreat) sag = 0.0;
            double towardGoal = receiverThreat ? 0.10 : lerp(ctx.danger ? 0.18 : 0.20, 0.48, sag);
            double targetX = lerp(threat.player->x, ctx.ownGoalX + ctx.fd * 36.0, towardGoal);
            double threatDistanceToGoal = std::abs(threat.player->x - ctx.ownGoalX);
            if (ctx.danger && agentFor(*marker)->isCenterBack() && threat.player->role == Role::CF) {
                targetX = ctx.ownGoalX + ctx.fd * clamp((targetX - ctx.ownGoalX) * ctx.fd, 58.0, 116.0);
            }
            if (!ctx.danger && agentFor(*marker)->isCenterBack() && !receiverThreat && threatDistanceToGoal > 170.0) {
                targetX = ctx.ownGoalX + ctx.fd * std::max(70.0, ctx.lineProgress - 18.0);
            }
            if (!ctx.danger && agentFor(*marker)->isFullBack() && !receiverThreat && threatDistanceToGoal > 150.0) {
                targetX = ctx.ownGoalX + ctx.fd * (ctx.lineProgress + 18.0);
            }
            double markTightness = ctx.danger || receiverThreat || threatDistanceToGoal < 170.0 ? 0.015 : 0.08;
            markTightness = lerp(markTightness, 0.34, sag);
            if (receiverThreat) markTightness = 0.0;
            setAssignment(*marker, DefensiveTask::LaneBlock, targetX,
                lerp(threat.player->y, PITCH_H / 2.0, markTightness), threat.player->id);
            ctx.assigned[marker->id] = true;
        }
    }
}

// ── Phase 11: Box protection (guard + cutback + post guards) ──

void GameEngine::assignBoxProtection(DefenseContext& ctx, Player& carrier) {
    // Box guard
    if (ctx.danger || std::abs(carrier.x - ctx.ownGoalX) < PITCH_W * 0.42) {
        Player* guard = nullptr;
        double bestGuard = 1e9;
        double guardY = PITCH_H / 2.0;
        for (const auto& threat : ctx.threats) {
            if (threat.player->role == Role::CF) { guardY = lerp(threat.player->y, PITCH_H / 2.0, 0.45); break; }
        }
        for (auto& defender : state.players) {
            if (defender.team != ctx.team || ctx.used(&defender)
                || (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isCentralMidfielder()
                    && !agentFor(defender)->isFullBack())) continue;
            if (!ctx.danger && !agentFor(defender)->isCentralMidfielder()) continue;
            double roleCost = agentFor(defender)->boxGuardCost();
            double score = dist(defender.x, defender.y, ctx.ownGoalX + ctx.fd * 96.0, guardY) + roleCost;
            if (score < bestGuard) { bestGuard = score; guard = &defender; }
        }
        if (guard) {
            setAssignment(*guard, DefensiveTask::BoxGuard, ctx.ownGoalX + ctx.fd * (ctx.danger ? 78.0 : 104.0), guardY);
            ctx.assigned[guard->id] = true;
        }
    }
    // Cutback guard
    if (ctx.danger || ctx.shootingRange) {
        Player* cutbackGuard = nullptr;
        double bestCutback = 1e9;
        double cutbackY = lerp(carrier.y, PITCH_H / 2.0, ctx.danger ? 0.72 : 0.62);
        double cutbackX = ctx.ownGoalX + ctx.fd * (ctx.danger ? 132.0 : 155.0);
        for (auto& defender : state.players) {
            if (defender.team != ctx.team || ctx.used(&defender)
                || (!agentFor(defender)->isCentralMidfielder() && !agentFor(defender)->isFullBack()
                    && !agentFor(defender)->isCenterBack())) continue;
            if (!ctx.danger && !agentFor(defender)->isCentralMidfielder()) continue;
            double roleCost = agentFor(defender)->cutbackGuardCost();
            double score = dist(defender.x, defender.y, cutbackX, cutbackY) + roleCost;
            if (score < bestCutback) { bestCutback = score; cutbackGuard = &defender; }
        }
        if (cutbackGuard) {
            setAssignment(*cutbackGuard, DefensiveTask::CutbackGuard, cutbackX, cutbackY, carrier.id);
            ctx.assigned[cutbackGuard->id] = true;
        }
    }
    // Post guards (danger only, wide carrier)
    if (ctx.danger && std::abs(carrier.y - PITCH_H / 2.0) > 125.0) {
        double farY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.66 : PITCH_H * 0.34;
        double nearY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.34 : PITCH_H * 0.66;
        Player* farGuard = nullptr;
        double bestFar = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != ctx.team || ctx.used(&defender)
                || (!agentFor(defender)->isFullBack() && !agentFor(defender)->isCentralMidfielder())) continue;
            double score = dist(defender.x, defender.y, ctx.ownGoalX + ctx.fd * 108.0, farY);
            if (score < bestFar) { bestFar = score; farGuard = &defender; }
        }
        if (farGuard) {
            setAssignment(*farGuard, DefensiveTask::FarPostGuard, ctx.ownGoalX + ctx.fd * 108.0, farY);
            ctx.assigned[farGuard->id] = true;
        }
        Player* nearGuard = nullptr;
        double bestNear = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != ctx.team || ctx.used(&defender)
                || (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isFullBack())) continue;
            double score = dist(defender.x, defender.y, ctx.ownGoalX + ctx.fd * 64.0, nearY);
            if (score < bestNear) { bestNear = score; nearGuard = &defender; }
        }
        if (nearGuard) {
            setAssignment(*nearGuard, DefensiveTask::NearPostGuard, ctx.ownGoalX + ctx.fd * 64.0, nearY);
            ctx.assigned[nearGuard->id] = true;
        }
    }
    // Box screen
    if (ctx.danger) {
        for (auto& p : state.players) {
            if (p.team != ctx.team || ctx.used(&p) || !agentFor(p)->isCentralMidfielder()) continue;
            double sideY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
            setAssignment(p, DefensiveTask::BoxScreen, ctx.ownGoalX + ctx.fd * 142.0, sideY);
            ctx.assigned[p.id] = true;
            break;
        }
    }
}

// ── Phase 12: Defensive line ──

void GameEngine::assignDefensiveLine(DefenseContext& ctx, Player& carrier) {
    for (auto& defender : state.players) {
        if (defender.team != ctx.team || ctx.used(&defender)
            || (defender.role != Role::CB && defender.role != Role::FB)) continue;
        double targetX = ctx.danger
            ? ctx.ownGoalX + ctx.fd * agentFor(defender)->defensiveLineOffsetX(true, ctx.lineProgress)
            : ctx.ownGoalX + ctx.fd * agentFor(defender)->defensiveLineOffsetX(false, ctx.lineProgress);
        double targetY = agentFor(defender)->defensiveLineTargetY(defender.homeY, PITCH_H / 2.0, carrier.y);
        setAssignment(defender, agentFor(defender)->defensiveLineRoleTask(), targetX, targetY);
    }
}

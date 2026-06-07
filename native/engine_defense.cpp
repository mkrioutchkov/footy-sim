#include "engine.h"
#include "agent.h"
#include <cmath>
#include <numbers>

// ══════════════════════════════════════════════════════════════
// Tactical — assignments, defensive roles, tactical audit
// ══════════════════════════════════════════════════════════════

void GameEngine::setAssignment(Player& player, DefensiveTask role, double x, double y, int opponentId) {
    assignmentByPlayer[player.id] = {role, opponentId, clamp(x, 35.0, PITCH_W - 35.0), clamp(y, 35.0, PITCH_H - 35.0)};
}

void GameEngine::updateTeamAssignments() {
    assignmentByPlayer.clear();
    Player* carrier = playerById(state.ball.controllerId);
    if (!carrier || carrier->role == Role::GK) return;
    Team defending = carrier->team == Team::Home ? Team::Away : Team::Home;
    assignDefensiveRoles(defending, *carrier);
    auditTacticalCoverage(*carrier);
}

void GameEngine::auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                                int pressureCount, const std::string& choiceType) {
    if (player.role != Role::CF || distance >= 190.0 || angleDeg <= 9.0 || pressureCount > 1) return;
    bool closeChance = distance < 120.0;
    stats.recordShotSelection(0, 0, 1, choiceType == "shoot" ? 0 : 1, choiceType == "pass" ? 1 : 0, choiceType == "dribble" ? 1 : 0, closeChance ? 1 : 0, closeChance && choiceType != "shoot" ? 1 : 0, false, false);
    if (choiceType == "shoot") return;
}

void GameEngine::assignDefensiveRoles(Team team, Player& carrier) {
    double fd = fdFor(team);
    double ownGoalX = ownGoalXFor(team);
    auto progressX = [&](double x) { return (x - ownGoalX) * fd; };
    auto clampedProgressX = [&](double x, double lo, double hi) {
        return ownGoalX + fd * clamp(progressX(x), lo, hi);
    };
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Config tactics = configFor(team);
    struct Rated { Player* player; double distance; double eta; double score; };
    std::vector<Rated> ranked;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK) continue;
        double distance = dist(p.x, p.y, carrier.x, carrier.y);
        double speed = std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
        double roleCost = agentFor(p)->defensivePressCost(danger);
        ranked.push_back({&p, distance, distance / speed, distance - attrFactor(p.attrs.speed) * 45.0 - attrFactor(p.attrs.tackling) * 35.0 + roleCost});
    }
    if (ranked.empty()) return;
    std::sort(ranked.begin(), ranked.end(), [](const Rated& a, const Rated& b) { return a.score < b.score; });
    auto quickest = std::min_element(ranked.begin(), ranked.end(), [](const Rated& a, const Rated& b) { return a.eta < b.eta; });
    if (quickest != ranked.end() && ranked.front().eta > quickest->eta + (danger ? 0.40 : 0.52)) {
        Rated urgent = *quickest;
        ranked.erase(quickest);
        ranked.insert(ranked.begin(), urgent);
    }
    std::unordered_set<int> assigned;
    auto used = [&](const Player* p) { return assigned.contains(p->id); };
    Player* primary = ranked.front().player;
    if (danger) {
        for (const auto& option : ranked) {
            Player* p = option.player;
            if (agentFor(*p)->isCenterBack()) continue;
            if (option.distance > 190.0 || option.eta > ranked.front().eta + 0.18) continue;
            primary = p;
            break;
        }
    }
    setAssignment(*primary, DefensiveTask::PrimaryPress, carrier.x - fd * 16.0, carrier.y, carrier.id);
    assigned.insert(primary->id);
    if (tactics.aggression >= 62.0 || danger) {
        for (const auto& option : ranked) {
            Player* p = option.player;
            if (used(p) || agentFor(*p)->isCenterBack() || (danger && agentFor(*p)->isFullBack() && std::abs(p->homeY - carrier.y) > 210.0)
                || option.distance >= (danger ? 285.0 : 250.0)) continue;
            setAssignment(*p, DefensiveTask::SecondaryPress, carrier.x - fd * 42.0,
                carrier.y + (p->homeY < carrier.y ? -38.0 : 38.0), carrier.id);
            assigned.insert(p->id);
            break;
        }
    }
    double carrierGoalDist = std::abs(carrier.x - ownGoalX);
    bool shootingRange = carrierGoalDist < 310.0 && std::abs(carrier.y - PITCH_H / 2.0) < 235.0;
    bool wideDanger = carrierGoalDist < 360.0 && std::abs(carrier.y - PITCH_H / 2.0) > 135.0;
    if (shootingRange) {
        Player* lane = nullptr;
        double bestLane = 1e9;
        double laneX = lerp(carrier.x, ownGoalX + fd * 24.0, danger ? 0.34 : 0.26);
        double laneY = lerp(carrier.y, PITCH_H / 2.0, danger ? 0.34 : 0.24);
        for (auto& p : state.players) {
            if (p.team != team || used(&p) || p.role == Role::GK || p.role == Role::CF || p.role == Role::WM) continue;
            double roleCost = agentFor(p)->shotLaneCost();
            double score = dist(p.x, p.y, laneX, laneY) + roleCost;
            if (score < bestLane) { bestLane = score; lane = &p; }
        }
        if (lane) {
            setAssignment(*lane, DefensiveTask::ShotLane, laneX, laneY, carrier.id);
            assigned.insert(lane->id);
        }
    }
    if (wideDanger) {
        Player* crossLane = nullptr;
        double bestCrossLane = 1e9;
        double crossX = lerp(carrier.x, ownGoalX + fd * 62.0, danger ? 0.42 : 0.34);
        double crossY = lerp(carrier.y, PITCH_H / 2.0, 0.44);
        for (auto& p : state.players) {
            if (p.team != team || used(&p) || p.role == Role::GK || p.role == Role::CF) continue;
            double roleCost = agentFor(p)->crossLaneCost();
            double score = dist(p.x, p.y, crossX, crossY) + roleCost;
            if (score < bestCrossLane) { bestCrossLane = score; crossLane = &p; }
        }
        if (crossLane) {
            setAssignment(*crossLane, DefensiveTask::CrossLane, crossX, crossY, carrier.id);
            assigned.insert(crossLane->id);
        }
    }
    for (const auto& option : ranked) {
        Player* p = option.player;
        if (used(p) || p->role != Role::CM) continue;
        setAssignment(*p, DefensiveTask::Cover, lerp(carrier.x, ownGoalX + fd * 115.0, 0.58),
            lerp(carrier.y, PITCH_H / 2.0, 0.4), carrier.id);
        assigned.insert(p->id);
        break;
    }
    if (danger) {
        for (const auto& option : ranked) {
            Player* p = option.player;
            if (used(p) || p->role != Role::CB) continue;
            setAssignment(*p, DefensiveTask::Cover, ownGoalX + fd * 112.0, lerp(carrier.y, PITCH_H / 2.0, 0.35), carrier.id);
            assigned.insert(p->id);
            break;
        }
    }
    int screenCount = 0;
    for (auto& p : state.players) {
        if (p.team == team && agentFor(p)->isCentralMidfielder() && !used(&p)) {
            double screenDepth = danger ? 122.0 + screenCount * 26.0 : 175.0 + screenCount * 22.0;
            double screenY = screenCount == 0
                ? lerp(carrier.y, PITCH_H / 2.0, danger ? 0.78 : 0.65)
                : clamp(PITCH_H / 2.0 + (carrier.y < PITCH_H / 2.0 ? 74.0 : -74.0), 70.0, PITCH_H - 70.0);
            setAssignment(p, DefensiveTask::MidfieldScreen, lerp(carrier.x, ownGoalX + fd * screenDepth, danger ? 0.58 : 0.4), screenY);
            assigned.insert(p.id);
            if (++screenCount >= (danger ? 2 : 1)) break;
        }
    }
    double linePush = (tactics.defensiveLineHeight - 50.0) * 0.9;
    double lineProgress = danger
        ? 92.0
        : ((lerp(team == Team::Home ? 245.0 : PITCH_W - 245.0, carrier.x - fd * 108.0, 0.38) - ownGoalX) * fd) + linePush;
    lineProgress = clamp(lineProgress, 70.0, 360.0);

    struct Threat { Player* player; double depth; };
    std::vector<Threat> threats;
    for (auto& attacker : state.players) {
        if (attacker.team == team || attacker.role == Role::GK || attacker.id == carrier.id) continue;
        double depth = std::abs(attacker.x - ownGoalX);
        double yDist = std::abs(attacker.y - PITCH_H / 2.0);
        bool threatens = agentFor(attacker)->isOffensiveThreat(depth, danger, yDist);
        if (threatens) threats.push_back({&attacker, depth});
    }
    std::sort(threats.begin(), threats.end(), [](const Threat& a, const Threat& b) { return a.depth < b.depth; });
    if (threats.size() > (danger ? 5u : 3u)) threats.resize(danger ? 5u : 3u);
    // Close-down: send one CB only; the partner must stay available for the CF lane.
    Player* closeCb = nullptr;
    double closeCbDist = 1e9;
    bool carrierInHalf = (fd == 1.0) ? carrier.x < HALF_X : carrier.x > HALF_X;
    if (!danger && carrierInHalf) {
        for (auto& defender : state.players) {
            if (defender.team != team || !agentFor(defender)->isCenterBack() || used(&defender)) continue;
            double cbDist = dist(defender.x, defender.y, carrier.x, carrier.y);
            if (cbDist < 190.0 && cbDist < closeCbDist) { closeCbDist = cbDist; closeCb = &defender; }
        }
    }
    if (closeCb) {
        double goalCenterY = PITCH_H / 2.0;
        double cutX = lerp(carrier.x, ownGoalX + fd * 40.0, 0.25);
        double cutY = lerp(carrier.y, goalCenterY, 0.20);
        double side = (closeCb->y < carrier.y) ? -1.0 : 1.0;
        cutY = clamp(cutY + side * 30.0, 40.0, PITCH_H - 40.0);
        setAssignment(*closeCb, DefensiveTask::CloseDown, cutX, cutY);
        assigned.insert(closeCb->id);
    }

    for (const auto& threat : threats) {
        Player* marker = nullptr;
        double best = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender)) continue;
            double roleBonus = agentFor(*threat.player)->markerRoleBonus(*agentFor(defender), danger);
            if (roleBonus >= 1e8) continue;
            if (threat.player->role == Role::WM && !agentFor(defender)->isCenterBack()
                && std::abs(defender.homeY - threat.player->y) >= PITCH_H * 0.42) continue;
            double score = dist(defender.x, defender.y, threat.player->x, threat.player->y) + roleBonus;
            if (score < best) { best = score; marker = &defender; }
        }
        if (marker) {
            double targetX = lerp(threat.player->x, ownGoalX + fd * 36.0, danger ? 0.18 : 0.20);
            double threatDistanceToGoal = std::abs(threat.player->x - ownGoalX);
            bool receiverThreat = state.ball.intendedReceiverId == threat.player->id;
            if (danger && agentFor(*marker)->isCenterBack() && threat.player->role == Role::CF) {
                targetX = clampedProgressX(targetX, 58.0, 116.0);
            }
            if (!danger && agentFor(*marker)->isCenterBack() && !receiverThreat && threatDistanceToGoal > 170.0) {
                targetX = ownGoalX + fd * std::max(70.0, lineProgress - 18.0);
            }
            if (!danger && agentFor(*marker)->isFullBack() && !receiverThreat && threatDistanceToGoal > 150.0) {
                targetX = ownGoalX + fd * (lineProgress + 18.0);
            }
            double markTightness = danger || receiverThreat || threatDistanceToGoal < 170.0 ? 0.015 : 0.08;
            setAssignment(*marker, DefensiveTask::LaneBlock, targetX, lerp(threat.player->y, PITCH_H / 2.0, markTightness), threat.player->id);
            assigned.insert(marker->id);
        }
    }
    if (danger || std::abs(carrier.x - ownGoalX) < PITCH_W * 0.42) {
        Player* guard = nullptr;
        double bestGuard = 1e9;
        double guardY = PITCH_H / 2.0;
        for (const auto& threat : threats) {
            if (threat.player->role == Role::CF) { guardY = lerp(threat.player->y, PITCH_H / 2.0, 0.45); break; }
        }
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender)
                || (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isCentralMidfielder() && !agentFor(defender)->isFullBack())) continue;
            double roleCost = agentFor(defender)->boxGuardCost();
            double score = dist(defender.x, defender.y, ownGoalX + fd * 96.0, guardY) + roleCost;
            if (score < bestGuard) { bestGuard = score; guard = &defender; }
        }
        if (guard) {
            setAssignment(*guard, DefensiveTask::BoxGuard, ownGoalX + fd * (danger ? 78.0 : 104.0), guardY);
            assigned.insert(guard->id);
        }
    }
    if (danger || shootingRange) {
        Player* cutbackGuard = nullptr;
        double bestCutback = 1e9;
        double cutbackY = lerp(carrier.y, PITCH_H / 2.0, danger ? 0.72 : 0.62);
        double cutbackX = ownGoalX + fd * (danger ? 132.0 : 155.0);
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender)
                || (!agentFor(defender)->isCentralMidfielder() && !agentFor(defender)->isFullBack() && !agentFor(defender)->isCenterBack())) continue;
            double roleCost = agentFor(defender)->cutbackGuardCost();
            double score = dist(defender.x, defender.y, cutbackX, cutbackY) + roleCost;
            if (score < bestCutback) { bestCutback = score; cutbackGuard = &defender; }
        }
        if (cutbackGuard) {
            setAssignment(*cutbackGuard, DefensiveTask::CutbackGuard, cutbackX, cutbackY, carrier.id);
            assigned.insert(cutbackGuard->id);
        }
    }
    if (danger && std::abs(carrier.y - PITCH_H / 2.0) > 125.0) {
        Player* farGuard = nullptr;
        Player* nearGuard = nullptr;
        double bestFar = 1e9;
        double bestNear = 1e9;
        double farY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.66 : PITCH_H * 0.34;
        double nearY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.34 : PITCH_H * 0.66;
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender) || (!agentFor(defender)->isFullBack() && !agentFor(defender)->isCentralMidfielder())) continue;
            double score = dist(defender.x, defender.y, ownGoalX + fd * 108.0, farY);
            if (score < bestFar) { bestFar = score; farGuard = &defender; }
        }
        if (farGuard) {
            setAssignment(*farGuard, DefensiveTask::FarPostGuard, ownGoalX + fd * 108.0, farY);
            assigned.insert(farGuard->id);
        }
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender) || (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isFullBack())) continue;
            double score = dist(defender.x, defender.y, ownGoalX + fd * 64.0, nearY);
            if (score < bestNear) { bestNear = score; nearGuard = &defender; }
        }
        if (nearGuard) {
            setAssignment(*nearGuard, DefensiveTask::NearPostGuard, ownGoalX + fd * 64.0, nearY);
            assigned.insert(nearGuard->id);
        }
    }
    if (danger) {
        for (auto& p : state.players) {
            if (p.team != team || used(&p) || !agentFor(p)->isCentralMidfielder()) continue;
            double sideY = carrier.y < PITCH_H / 2.0 ? PITCH_H * 0.62 : PITCH_H * 0.38;
            setAssignment(p, DefensiveTask::BoxScreen, ownGoalX + fd * 142.0, sideY);
            assigned.insert(p.id);
            break;
        }
    }
    for (auto& defender : state.players) {
        if (defender.team != team || used(&defender) || (defender.role != Role::CB && defender.role != Role::FB)) continue;
        double targetX = danger
            ? ownGoalX + fd * agentFor(defender)->defensiveLineOffsetX(true, lineProgress)
            : ownGoalX + fd * agentFor(defender)->defensiveLineOffsetX(false, lineProgress);
        double targetY = agentFor(defender)->defensiveLineTargetY(defender.homeY, PITCH_H / 2.0, carrier.y);
        setAssignment(defender, agentFor(defender)->defensiveLineRoleTask(), targetX, targetY);
    }
}

void GameEngine::auditTacticalCoverage(Player& carrier) {
    if (state.clockMs < nextTacticalAuditMs) return;
    nextTacticalAuditMs = state.clockMs + 500.0;
    Team defending = carrier.team == Team::Home ? Team::Away : Team::Home;
    double ownGoalX = ownGoalXFor(defending);
    double fd = defending == Team::Home ? 1.0 : -1.0;
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Player* primary = nullptr;
    for (const auto& [id, task] : assignmentByPlayer) {
        if (task.role == DefensiveTask::PrimaryPress) { primary = playerById(id); break; }
    }
    if (primary) {
        stats.recordPressSample();
        double selectedDistance = dist(primary->x, primary->y, carrier.x, carrier.y);
        double selectedEta = selectedDistance / std::max(18.0, attrFactor(primary->attrs.speed) * SPEED_SPRINT);
        double fastestEta = 1e9;
        for (auto& p : state.players) {
            if (p.team != defending || p.role == Role::GK) continue;
            double eta = dist(p.x, p.y, carrier.x, carrier.y) / std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
            fastestEta = std::min(fastestEta, eta);
        }
        if (selectedEta > fastestEta + 0.45) { stats.recordQuestionablePress(selectedDistance); }
    }
    struct LineMember { const Player* player; double progress; };
    std::vector<LineMember> line;
    for (const auto& defender : state.players) {
        if (defender.team != defending) continue;
        if (!agentFor(defender)->isCenterBack() && !agentFor(defender)->isFullBack()) continue;
        line.push_back({&defender, (defender.x - ownGoalX) * fd});
    }
    if (line.size() >= 3) {
        std::sort(line.begin(), line.end(), [](const LineMember& a, const LineMember& b) { return a.progress < b.progress; });
        double gap = line[1].progress - line[0].progress;
        bool singleDrop = false, laneBlock = false;
        if (!danger && gap > 85.0) {
            singleDrop = true;
            const auto* task = assignmentFor(line[0].player->id);
            if (task && task->role == DefensiveTask::LaneBlock) { laneBlock = true; }
        }
        stats.recordBackLineSample(gap, singleDrop, laneBlock);
    }
    bool finalThird = carrier.team == Team::Home ? carrier.x > PITCH_W * 2.0 / 3.0 : carrier.x < PITCH_W / 3.0;
    if (!finalThird) return;
    double nearestCb = 1e9, nearestDefender = 1e9;
    for (auto& defender : state.players) {
        if (defender.team != defending || defender.role == Role::GK) continue;
        double distance = dist(defender.x, defender.y, carrier.x, carrier.y);
        nearestDefender = std::min(nearestDefender, distance);
        if (agentFor(defender)->isCenterBack()) nearestCb = std::min(nearestCb, distance);
    }
    bool unmarked = nearestDefender > 55.0 && nearestCb > 90.0;
    stats.recordFinalThirdMarking(nearestCb, nearestDefender, unmarked);
}


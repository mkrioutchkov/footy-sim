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
    Player* carrier = playerById(state.ball.controllerId);
    if (!carrier || carrier->role == Role::GK) {
        // Pass in flight: defend the ARRIVAL, not the memory of the launch.
        // Anchoring on the intended receiver collapses markers and the press
        // onto the reception point while the ball travels — without this the
        // defense executed stale assignments for the whole flight of every
        // cross and through ball. Otherwise keep the previous shape while
        // the ball is loose (clearing it let the back line float).
        Player* receiver = playerById(state.ball.intendedReceiverId);
        if (receiver && receiver->role != Role::GK && state.ball.controllerId < 0) {
            assignmentByPlayer.fill({});
            Team defending = receiver->team == Team::Home ? Team::Away : Team::Home;
            assignDefensiveRoles(defending, *receiver);
        }
        return;
    }
    assignmentByPlayer.fill({});
    Team defending = carrier->team == Team::Home ? Team::Away : Team::Home;
    assignDefensiveRoles(defending, *carrier);
    auditTacticalCoverage(*carrier);
}

void GameEngine::auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                                int pressureCount, const std::string& choiceType) {
    if (player.role != Role::CF || distance >= 190.0 || angleDeg <= 9.0 || pressureCount > 1) return;
    bool closeChance = distance < 120.0;
    stats.recordShotSelection(0, 0, 1, choiceType == "shoot" ? 0 : 1, choiceType == "pass" ? 1 : 0, choiceType == "dribble" ? 1 : 0, closeChance ? 1 : 0, closeChance && choiceType != "shoot" ? 1 : 0, false, false);
}

void GameEngine::assignDefensiveRoles(Team team, Player& carrier) {
    double fd = fdFor(team);
    double ownGoalX = ownGoalXFor(team);
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Config tactics = configFor(team);

    // Phase 1: Rank defenders
    auto ranked = rankDefenders(team, carrier);
    if (ranked.empty()) return;

    // Build context — anchor on whichever is nearer our goal, carrier or ball,
    // so a ball played in behind pulls the line back even before it's collected.
    double carrierGoalDist = std::min(std::abs(carrier.x - ownGoalX), std::abs(state.ball.x - ownGoalX));
    danger = danger || carrierGoalDist < DANGER_ZONE_DIST;
    bool shootingRange = carrierGoalDist < 310.0 && std::abs(carrier.y - PITCH_H / 2.0) < 235.0;
    bool wideDanger = carrierGoalDist < 360.0 && std::abs(carrier.y - PITCH_H / 2.0) > 135.0;
    double linePush = (tactics.defensiveLineHeight - 50.0) * 0.9;
    double lineProgress = danger
        ? 92.0
        : ((lerp(team == Team::Home ? 245.0 : PITCH_W - 245.0, carrier.x - fd * 108.0, 0.38) - ownGoalX) * fd) + linePush;
    // Retreat with an advancing carrier: a fixed ~245px line left the box empty
    // behind it, and `danger` (carrier < 240) only triggered once that line was
    // already beaten. Stay ~115px goal-side until reaching box depth.
    if (!danger) lineProgress = std::min(lineProgress, carrierGoalDist - 230.0);
    // Track the deepest runner: a line that ignores attackers behind it hands
    // every through ball a free lane. Stay a stride goal-side of the most
    // advanced opponent (which also keeps him onside-marked, not played on).
    double deepestRunner = 1e9;
    for (auto& p : state.players) {
        if (p.team == team || p.role == Role::GK || p.id == carrier.id) continue;
        deepestRunner = std::min(deepestRunner, std::abs(p.x - ownGoalX));
    }
    if (deepestRunner < 1e9) lineProgress = std::min(lineProgress, std::max(70.0, deepestRunner - 26.0));
    lineProgress = clamp(lineProgress, 70.0, 360.0);

    DefenseContext ctx{team, fd, ownGoalX, danger, tactics, lineProgress, shootingRange, wideDanger,
                       carrierGoalDist, {}, std::move(ranked), {}};

    // Phase 2-3: Press
    assignPrimaryPress(ctx, carrier);
    assignSecondaryPress(ctx, carrier);

    // Phase 4-5: Lane blockers
    assignShotLane(ctx, carrier);
    assignCrossLane(ctx, carrier);

    // Phase 6-7: Cover & screen
    assignCoverRoles(ctx, carrier);
    assignMidfieldScreen(ctx, carrier);

    // Phase 8: Close-down
    assignCloseDown(ctx, carrier);

    // Phase 9-10: Threat identification & marking
    ctx.threats = identifyThreats(ctx, carrier);
    assignThreatMarking(ctx, carrier);

    // Phase 11: Box protection
    assignBoxProtection(ctx, carrier);

    // Phase 11b: wingers track back when the goal is under threat — a low
    // block defends with more than the back four plus screens. They take
    // the wide channels at box height, the lanes cutbacks travel through.
    if (ctx.danger) {
        for (auto& p : state.players) {
            if (p.team != ctx.team || ctx.used(&p) || p.role != Role::WM) continue;
            double sideY = p.homeY < PITCH_H / 2.0 ? PITCH_H * 0.26 : PITCH_H * 0.74;
            setAssignment(p, DefensiveTask::BoxScreen, ctx.ownGoalX + ctx.fd * 150.0, sideY);
            ctx.assigned[p.id] = true;
        }
    }

    // Phase 12: Defensive line
    assignDefensiveLine(ctx, carrier);
}

void GameEngine::auditTacticalCoverage(Player& carrier) {
    if (state.clockMs < nextTacticalAuditMs) return;
    nextTacticalAuditMs = state.clockMs + 500.0;
    Team defending = carrier.team == Team::Home ? Team::Away : Team::Home;
    double ownGoalX = ownGoalXFor(defending);
    double fd = fdFor(defending);
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Player* primary = nullptr;
    for (int id = 0; id < 22; id++) {
        if (assignmentByPlayer[id].role == DefensiveTask::PrimaryPress) { primary = playerById(id); break; }
    }
    if (primary) {
        double selectedDistance = dist(primary->x, primary->y, carrier.x, carrier.y);
        stats.recordPressSample(selectedDistance);
        double selectedEta = selectedDistance / std::max(18.0, attrFactor(primary->attrs.speed) * SPEED_SPRINT);
        double fastestEta = 1e9;
        for (auto& p : state.players) {
            if (p.team != defending || p.role == Role::GK) continue;
            double eta = dist(p.x, p.y, carrier.x, carrier.y) / std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
            fastestEta = std::min(fastestEta, eta);
        }
        if (selectedEta > fastestEta + 0.45) { stats.recordQuestionablePress(); }
    }
    struct LineMember { const Player* player; double progress; };
    SmallVector<LineMember, 6> line;
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


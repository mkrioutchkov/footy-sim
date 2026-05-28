#pragma once
// engine_impl_tactical.h — assignments, defensive roles, tactical audit

inline void GameEngine::setAssignment(Player& player, const std::string& role, double x, double y, int opponentId) {
    assignmentByPlayer[player.id] = {role, opponentId, clamp(x, 35.0, PITCH_W - 35.0), clamp(y, 35.0, PITCH_H - 35.0)};
}

inline void GameEngine::updateTeamAssignments() {
    assignmentByPlayer.clear();
    Player* carrier = playerById(state.ball.controllerId);
    if (!carrier || carrier->role == Role::GK) return;
    Team defending = carrier->team == Team::Home ? Team::Away : Team::Home;
    assignDefensiveRoles(defending, *carrier);
    auditTacticalCoverage(*carrier);
}

inline void GameEngine::auditCredibleShotWindow(const Player& player, double distance, double angleDeg,
                                                int pressureCount, const std::string& choiceType) {
    if (player.role != Role::CF || distance >= 190.0 || angleDeg <= 9.0 || pressureCount > 1) return;
    bool closeChance = distance < 120.0;
    stats.recordShotSelection(0, 0, 1, choiceType == "shoot" ? 0 : 1, choiceType == "pass" ? 1 : 0, choiceType == "dribble" ? 1 : 0, closeChance ? 1 : 0, closeChance && choiceType != "shoot" ? 1 : 0, false, false);
    if (choiceType == "shoot") return;
}

inline void GameEngine::assignDefensiveRoles(Team team, Player& carrier) {
    double fd = team == Team::Home ? 1.0 : -1.0;
    double ownGoalX = ownGoalXFor(team);
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Config tactics = configFor(team);
    struct Rated { Player* player; double distance; double eta; double score; };
    std::vector<Rated> ranked;
    for (auto& p : state.players) {
        if (p.team != team || p.role == Role::GK) continue;
        double distance = dist(p.x, p.y, carrier.x, carrier.y);
        double speed = std::max(18.0, attrFactor(p.attrs.speed) * SPEED_SPRINT);
        double roleCost = p.role == Role::CB ? (danger ? 8.0 : 70.0) : p.role == Role::CF ? 28.0 : p.role == Role::CM ? 0.0 : p.role == Role::WM ? 6.0 : 14.0;
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
    setAssignment(*primary, "primary_press", carrier.x - fd * 16.0, carrier.y, carrier.id);
    assigned.insert(primary->id);
    if (tactics.aggression >= 62.0) {
        for (const auto& option : ranked) {
            Player* p = option.player;
            if (used(p) || p->role == Role::CB || option.distance >= 260.0) continue;
            setAssignment(*p, "secondary_press", carrier.x - fd * 42.0,
                carrier.y + (p->homeY < carrier.y ? -38.0 : 38.0), carrier.id);
            assigned.insert(p->id);
            break;
        }
    }
    for (const auto& option : ranked) {
        Player* p = option.player;
        if (used(p) || (p->role != Role::CB && p->role != Role::CM)) continue;
        setAssignment(*p, "cover", lerp(carrier.x, ownGoalX + fd * 115.0, 0.58),
            lerp(carrier.y, PITCH_H / 2.0, 0.4), carrier.id);
        assigned.insert(p->id);
        break;
    }
    for (auto& p : state.players) {
        if (p.team == team && p.role == Role::CM && !used(&p)) {
            setAssignment(p, "midfield_screen", lerp(carrier.x, ownGoalX + fd * 175.0, 0.4),
                lerp(carrier.y, PITCH_H / 2.0, 0.65));
            assigned.insert(p.id);
            break;
        }
    }
    struct Threat { Player* player; double depth; };
    std::vector<Threat> threats;
    for (auto& attacker : state.players) {
        if (attacker.team == team || attacker.role == Role::GK || attacker.id == carrier.id) continue;
        double depth = std::abs(attacker.x - ownGoalX);
        bool threatens = (attacker.role == Role::CF && depth < (danger ? 300.0 : 245.0))
            || (attacker.role == Role::WM && depth < (danger ? 250.0 : 205.0) && std::abs(attacker.y - PITCH_H / 2.0) < 200.0)
            || (attacker.role == Role::CM && depth < 180.0);
        if (threatens) threats.push_back({&attacker, depth});
    }
    std::sort(threats.begin(), threats.end(), [](const Threat& a, const Threat& b) { return a.depth < b.depth; });
    if (threats.size() > (danger ? 2u : 1u)) threats.resize(danger ? 2u : 1u);
    for (const auto& threat : threats) {
        Player* marker = nullptr;
        double best = 1e9;
        for (auto& defender : state.players) {
            if (defender.team != team || used(&defender) || (defender.role != Role::CB && defender.role != Role::FB)) continue;
            if (threat.player->role == Role::WM && defender.role != Role::CB
                && std::abs(defender.homeY - threat.player->y) >= PITCH_H * 0.42) continue;
            double roleBonus = (threat.player->role == Role::CF && defender.role == Role::CB)
                || (threat.player->role == Role::WM && defender.role == Role::FB) ? -35.0 : 0.0;
            double score = dist(defender.x, defender.y, threat.player->x, threat.player->y) + roleBonus;
            if (score < best) { best = score; marker = &defender; }
        }
        if (marker) {
            setAssignment(*marker, "lane_block", lerp(threat.player->x, ownGoalX + fd * 36.0, 0.20),
                lerp(threat.player->y, PITCH_H / 2.0, 0.08), threat.player->id);
            assigned.insert(marker->id);
        }
    }
    for (auto& defender : state.players) {
        if (defender.team != team || used(&defender) || (defender.role != Role::CB && defender.role != Role::FB)) continue;
        double linePush = (tactics.defensiveLineHeight - 50.0) * 0.9;
        double targetX = danger
            ? ownGoalX + fd * (defender.role == Role::CB ? 92.0 : 118.0)
            : lerp(defender.homeX, carrier.x - fd * 120.0, 0.32) + fd * linePush;
        double targetY = defender.role == Role::FB
            ? lerp(defender.homeY, carrier.y, 0.20)
            : lerp(defender.homeY, PITCH_H / 2.0, 0.08);
        setAssignment(defender, defender.role == Role::FB ? "wide_cover" : "defensive_line", targetX, targetY);
    }
}

inline void GameEngine::auditTacticalCoverage(Player& carrier) {
    if (state.clockMs < nextTacticalAuditMs) return;
    nextTacticalAuditMs = state.clockMs + 500.0;
    Team defending = carrier.team == Team::Home ? Team::Away : Team::Home;
    double ownGoalX = ownGoalXFor(defending);
    double fd = defending == Team::Home ? 1.0 : -1.0;
    bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;
    Player* primary = nullptr;
    for (const auto& [id, task] : assignmentByPlayer) {
        if (task.role == "primary_press") { primary = playerById(id); break; }
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
        if (defender.role != Role::CB && defender.role != Role::FB) continue;
        line.push_back({&defender, (defender.x - ownGoalX) * fd});
    }
    if (line.size() >= 3) {
        std::sort(line.begin(), line.end(), [](const LineMember& a, const LineMember& b) { return a.progress < b.progress; });
        double gap = line[1].progress - line[0].progress;
        bool singleDrop = false, laneBlock = false;
        if (!danger && gap > 85.0) {
            singleDrop = true;
            const auto* task = assignmentFor(line[0].player->id);
            if (task && task->role == "lane_block") { laneBlock = true; }
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
        if (defender.role == Role::CB) nearestCb = std::min(nearestCb, distance);
    }
    bool unmarked = nearestCb > 100.0;
    stats.recordFinalThirdMarking(nearestCb, nearestDefender, unmarked);
}

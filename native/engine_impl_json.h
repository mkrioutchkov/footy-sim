#pragma once
// engine_impl_json.h — JSON serialization

inline std::string GameEngine::getJSON() const {
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
    j["teammatePingPongs"] = summary["teammatePingPongs"];
    j["slideTackleDistanceAlerts"] = summary["slideTackleDistanceAlerts"];
    j["slideTackleOobAlerts"] = summary["slideTackleOobAlerts"];
    j["ownPassGoals"] = summary["ownPassGoals"];
    j["unknownLooseGoals"] = summary["unknownLooseGoals"];
    j["shotsByDistance"] = summary["shotsByDistance"];
    j["goalsByDistance"] = summary["goalsByDistance"];
    j["untrackedGoals"] = summary["untrackedGoals"];
    j["directDeliveryGoals"] = summary["directDeliveryGoals"];
    j["directCrossGoals"] = summary["directCrossGoals"];
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
    j["shotSelection"] = summary["shotSelection"];
    j["marking"] = summary["marking"];
    j["qualityFlags"] = summary["qualityFlags"];
    j["ballSpeed"] = summary["ballSpeed"];
    j["events"] = summary["events"];
    j["possessionPct"] = summary["possessionPct"];

    return j.dump();
}

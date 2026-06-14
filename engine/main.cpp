#include "engine.h"
#include "trace.h"
#include "nlohmann/json.hpp"
#include <iostream>
#include <fstream>
#include <chrono>

namespace {
// Load one team from a match-spec JSON object into a roster override + Config.
// Shape: {"name":..,"tactics":{aggression,passingDirectness,overlapFrequency,
// midfieldFreedom,defensiveLineHeight}, "players":[{"name":..,"attrs":{speed,
// passing,creativity,shooting,tackling,positioning,stamina}} x11 in slot order]}.
void loadTeam(const nlohmann::json& t, GameEngine::RosterOverride& ro, GameEngine::Config& cfg) {
    auto num = [](const nlohmann::json& o, const char* k, double d) {
        return o.contains(k) && o[k].is_number() ? o[k].get<double>() : d;
    };
    if (t.contains("tactics")) {
        const auto& tac = t["tactics"];
        cfg.aggression        = num(tac, "aggression", 50);
        cfg.passingDirectness = num(tac, "passingDirectness", 50);
        cfg.overlapFrequency  = num(tac, "overlapFrequency", 50);
        cfg.midfieldFreedom   = num(tac, "midfieldFreedom", 50);
        cfg.defensiveLineHeight = num(tac, "defensiveLineHeight", 50);
    }
    const auto& players = t["players"];
    for (int i = 0; i < 11 && i < (int)players.size(); ++i) {
        const auto& p = players[i];
        ro.names[i] = p.contains("name") && p["name"].is_string()
            ? p["name"].get<std::string>() : ("P" + std::to_string(i));
        const auto& a = p.contains("attrs") ? p["attrs"] : p;
        PlayerAttributes& pa = ro.attrs[i];
        pa.speed       = num(a, "speed", 50);
        pa.passing     = num(a, "passing", 50);
        pa.creativity  = num(a, "creativity", 50);
        pa.shooting    = num(a, "shooting", 50);
        pa.tackling    = num(a, "tackling", 50);
        pa.positioning = num(a, "positioning", 50);
        pa.stamina     = num(a, "stamina", 90);
    }
    ro.active = true;
}
}

int main(int argc, char* argv[]) {
    int seed = 101;
    int minutes = 5;
    bool summaryOnly = false;
    bool debugMode = true;
    std::string tracePath;
    std::string matchPath;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--summary") summaryOnly = true;
        else if (arg == "--no-debug") debugMode = false;
        else if (arg == "--trace" && i + 1 < argc) tracePath = argv[++i];
        else if (arg == "--match" && i + 1 < argc) matchPath = argv[++i];
        else if (i == 1 && arg[0] != '-') seed = std::atoi(argv[i]);
        else if (i == 2 && arg[0] != '-') minutes = std::atoi(argv[i]);
    }
    const bool streamFrames = !summaryOnly;

    GameEngine engine;

    // Data-driven match: rosters + tactics from a JSON spec (the FM-style game).
    if (!matchPath.empty()) {
        std::ifstream f(matchPath);
        if (!f) { std::cerr << "Cannot open match spec: " << matchPath << "\n"; return 1; }
        nlohmann::json spec; f >> spec;
        if (spec.contains("seed") && spec["seed"].is_number()) seed = spec["seed"].get<int>();
        if (spec.contains("minutes") && spec["minutes"].is_number()) minutes = spec["minutes"].get<int>();
        loadTeam(spec["home"], engine.homeRoster, engine.homeConfig);
        loadTeam(spec["away"], engine.awayRoster, engine.awayConfig);
        engine.configOverride = true;
        debugMode = false;  // never equalize a real team's attributes
    }

    engine.initWithSeed(seed);
    engine.setMatchLengthMinutes(minutes);
    if (debugMode) engine.equalizeAttributes(65);
    engine.startMatch();

    TraceWriter trace;
    if (!tracePath.empty()) {
        trace.open(tracePath, seed, minutes * 60.0 * 1000.0);
        std::cerr << "Trace enabled: " << tracePath << "\n";
    }

    if (streamFrames) {
        auto& p1 = engine.state.players[0];
        std::cerr << "P1 attrs: spd=" << p1.attrs.speed << " pass=" << p1.attrs.passing
                  << " shoot=" << p1.attrs.shooting << " tack=" << p1.attrs.tackling
                  << " pos=" << p1.attrs.positioning << " cre=" << p1.attrs.creativity
                  << " sta=" << p1.attrs.stamina << "\n";
    }

    auto start = std::chrono::high_resolution_clock::now();

    double totalMs = minutes * 60.0 * 1000.0;
    double lastOutput = 0;

    while (engine.state.clockMs < totalMs + 300000 && engine.state.matchState != "finished") {
        engine.update(FIXED_DT);

        // Write trace frame every tick; drain the engine's event log with it
        if (trace.isOpen()) {
            trace.writeFrame(engine.state);
            for (const auto& e : engine.traceEventQueue) {
                int teamId = e.playerId < 0 ? -1 : (e.playerId < 11 ? 0 : 1);
                trace.writeEvent(e.type, e.clockMs, e.x, e.y, e.playerId, teamId);
            }
        }
        engine.traceEventQueue.clear();

        // Output JSON every ~33ms (30fps) for real-time display
        if (streamFrames && engine.state.clockMs - lastOutput >= 33.0) {
            lastOutput = engine.state.clockMs;
            std::cout << engine.getJSON() << std::endl;
        }
    }

    // Final state
    std::cout << engine.getJSON() << std::endl;

    if (trace.isOpen()) {
        trace.close();
        auto end = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double, std::milli>(end - start).count();
        std::cerr << "Trace written in " << elapsed << "ms\n";
    }

    return 0;
}

#include "engine.h"
#include "trace.h"
#include "nlohmann/json.hpp"
#include <iostream>
#include <fstream>
#include <chrono>
#include <algorithm>

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

// Parse the optional "directives" block (plain-English tactics, compiled to a
// structured form by the caller). Player ids are already resolved to 0..21.
// Shape: [{"playerId":3,"kind":"man_mark","targetId":19,"intensity":0.9,
//          "when":{"minuteMod":2,"minuteEq":1,"scoreState":"losing","scoreBy":1}}]
void parseDirectives(const nlohmann::json& arr, std::vector<GameEngine::Directive>& out) {
    auto num = [](const nlohmann::json& o, const char* k, double d) {
        return o.contains(k) && o[k].is_number() ? o[k].get<double>() : d;
    };
    for (const auto& d : arr) {
        GameEngine::Directive dir;
        dir.playerId = static_cast<int>(num(d, "playerId", -1));
        std::string k = d.contains("kind") && d["kind"].is_string() ? d["kind"].get<std::string>() : "";
        using DK = GameEngine::DirectiveKind;
        bool team = false;
        if (k == "man_mark")            dir.kind = DK::ManMark;
        else if (k == "shoot_on_sight") dir.kind = DK::ShootOnSight;
        else if (k == "get_forward")    dir.kind = DK::GetForward;
        else if (k == "sit_deep")       dir.kind = DK::SitDeep;
        else if (k == "target_player")  dir.kind = DK::TargetPlayer;
        else if (k == "stay_wide")      dir.kind = DK::StayWide;
        else if (k == "come_inside")    dir.kind = DK::ComeInside;
        else if (k == "stay_central")   dir.kind = DK::StayCentral;
        else if (k == "cross_early")    dir.kind = DK::CrossEarly;
        else if (k == "switch_play")    dir.kind = DK::SwitchPlay;
        else if (k == "play_simple")    dir.kind = DK::PlaySimple;
        else if (k == "all_out_attack")    { dir.kind = DK::AllOutAttack;   team = true; }
        else if (k == "park_the_bus")      { dir.kind = DK::ParkTheBus;     team = true; }
        else if (k == "high_press")        { dir.kind = DK::HighPress;      team = true; }
        else if (k == "drop_off")          { dir.kind = DK::DropOff;        team = true; }
        else if (k == "play_it_long")      { dir.kind = DK::PlayItLong;     team = true; }
        else if (k == "keep_it_on_ground") { dir.kind = DK::KeepItOnGround; team = true; }
        else if (k == "get_it_wide")       { dir.kind = DK::GetItWide;      team = true; }
        else if (k == "play_narrow")       { dir.kind = DK::PlayNarrow;     team = true; }
        else if (k == "push_up")           { dir.kind = DK::PushUp;         team = true; }
        else if (k == "slow_it_down")      { dir.kind = DK::SlowItDown;     team = true; }
        else continue;                  // unknown directive — ignore
        dir.teamScope = team ? static_cast<int>(num(d, "teamScope", 0)) : -1;
        dir.targetId = static_cast<int>(num(d, "targetId", -1));
        dir.intensity = num(d, "intensity", 1.0);
        if (d.contains("when")) {
            const auto& w = d["when"];
            dir.fromMin = static_cast<int>(num(w, "fromMin", 0));
            dir.toMin   = static_cast<int>(num(w, "toMin", 1000));
            dir.scoreBy = static_cast<int>(num(w, "scoreBy", 0));
            std::string s = w.contains("scoreState") && w["scoreState"].is_string() ? w["scoreState"].get<std::string>() : "";
            if (s == "winning")      dir.scoreState = GameEngine::CondScore::Winning;
            else if (s == "drawing") dir.scoreState = GameEngine::CondScore::Drawing;
            else if (s == "losing")  dir.scoreState = GameEngine::CondScore::Losing;
        }
        if (team) { if (dir.teamScope != 0 && dir.teamScope != 1) continue; }   // valid team
        else if (dir.playerId < 0 || dir.playerId >= 22) continue;              // fixed-22 guard
        out.push_back(dir);
    }
}
}

int main(int argc, char* argv[]) {
    int seed = 101;
    int minutes = 5;
    bool summaryOnly = false;
    bool debugMode = true;
    std::string tracePath;
    std::string matchPath;
    double streamFromMs = 0;   // suppress frame output before this clock (live re-sim resume)

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--summary") summaryOnly = true;
        else if (arg == "--no-debug") debugMode = false;
        else if (arg == "--trace" && i + 1 < argc) tracePath = argv[++i];
        else if (arg == "--match" && i + 1 < argc) matchPath = argv[++i];
        else if (arg == "--stream-from" && i + 1 < argc) streamFromMs = std::atof(argv[++i]);
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
        if (spec.contains("directives") && spec["directives"].is_array())
            parseDirectives(spec["directives"], engine.directives);
        // Timed plan changes (P2): [{atMs, directives:[...]}], applied when the
        // clock reaches atMs. The watch flow records the manager's mid-match
        // edits here so the match replays identically.
        if (spec.contains("timeline") && spec["timeline"].is_array()) {
            for (const auto& e : spec["timeline"]) {
                GameEngine::TimelineEntry te;
                te.atMs = e.contains("atMs") && e["atMs"].is_number() ? e["atMs"].get<double>() : 0.0;
                if (e.contains("directives") && e["directives"].is_array())
                    parseDirectives(e["directives"], te.directives);
                engine.directiveTimeline.push_back(std::move(te));
            }
            std::sort(engine.directiveTimeline.begin(), engine.directiveTimeline.end(),
                      [](const GameEngine::TimelineEntry& a, const GameEngine::TimelineEntry& b) { return a.atMs < b.atMs; });
        }
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
        if (streamFrames && engine.state.clockMs >= streamFromMs && engine.state.clockMs - lastOutput >= 33.0) {
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

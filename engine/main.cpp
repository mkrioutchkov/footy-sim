#include "engine.h"
#include "trace.h"
#include "nlohmann/json.hpp"
#include <iostream>
#include <fstream>
#include <chrono>
#include <thread>
#include <mutex>
#include <algorithm>
#include <cstdlib>

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
        pa.handling    = num(a, "handling", pa.positioning);   // keepers default handling to positioning
        pa.height      = num(a, "height", pa.positioning);     // defaults to positioning => aerial duel unchanged
        // Optional formation layout: per-slot role + home anchor (engine frame).
        // Any one present flips hasLayout; missing anchors fall back to the slot
        // default in createHome/AwayTeam (anchor <=0 = "use default").
        if (p.contains("role") && p["role"].is_string()) {
            ro.roles[i] = roleFromStr(p["role"].get<std::string>());
            ro.hasLayout = true;
        }
        if (p.contains("homeX") && p["homeX"].is_number()) { ro.homeX[i] = p["homeX"].get<double>(); ro.hasLayout = true; }
        if (p.contains("homeY") && p["homeY"].is_number()) { ro.homeY[i] = p["homeY"].get<double>(); ro.hasLayout = true; }
        // Optional pre-match morale shading (runtime state, not a static attribute).
        if (p.contains("moraleBoost") && p["moraleBoost"].is_number()) ro.moraleBoost[i] = p["moraleBoost"].get<double>();
    }
    ro.active = true;
}

// Parse the optional "directives" block (plain-English tactics, compiled to a
// structured form by the caller). Player ids are already resolved to 0..21.
// Shape: [{"playerId":3,"kind":"man_mark","targetId":19,"intensity":0.9,
//          "when":{"fromMin":0,"toMin":90,"scoreState":"losing","scoreBy":1,"phase":"transition"}}]
// (The `when` keys actually parsed are fromMin/toMin/scoreState/scoreBy/phase —
//  see the `when` block below; there is no minuteMod/minuteEq.)
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
        else if (k == "cut_inside" || k == "cut_in" || k == "cut_inside_to_shoot") dir.kind = DK::CutInside;
        else if (k == "overlap" || k == "overlap_runs" || k == "get_on_the_overlap") dir.kind = DK::OverlapRun;
        else if (k == "stay_central")   dir.kind = DK::StayCentral;
        else if (k == "cross_early")    dir.kind = DK::CrossEarly;
        else if (k == "switch_play")    dir.kind = DK::SwitchPlay;
        else if (k == "play_simple")    dir.kind = DK::PlaySimple;
        else if (k == "cutback")        dir.kind = DK::Cutback;
        else if (k == "contain")        dir.kind = DK::Contain;
        else if (k == "run_in_behind")  dir.kind = DK::RunInBehind;
        else if (k == "come_short" || k == "check_to_feet") dir.kind = DK::ComeShort;
        else if (k == "drift_into_pocket" || k == "play_between_lines" || k == "between_the_lines" || k == "drop_into_the_ten") dir.kind = DK::DriftIntoPocket;
        else if (k == "target_man_holdup" || k == "target_man" || k == "hold_it_up") dir.kind = DK::TargetManHoldup;
        else if (k == "make_runs")      dir.kind = DK::MakeRuns;
        else if (k == "dribble_more")   dir.kind = DK::DribbleMore;
        else if (k == "stay_back")      dir.kind = DK::StayBack;
        else if (k == "press_hard")     dir.kind = DK::PressHard;
        else if (k == "tackle_hard")    dir.kind = DK::TackleHard;
        else if (k == "stay_on_feet")   dir.kind = DK::StayOnFeet;
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
        else if (k == "counter_attack")    { dir.kind = DK::CounterAttack;  team = true; }
        else if (k == "offside_trap")      { dir.kind = DK::OffsideTrap;    team = true; }
        else if (k == "shoot_from_distance"){ dir.kind = DK::ShootFromDistance; team = true; }
        else if (k == "work_it_into_box")   { dir.kind = DK::WorkItIntoBox;     team = true; }
        else if (k == "press_intensity")   { dir.kind = DK::PressIntensity;  team = true; }   // tactical-depth dials (Gaylord seam)
        else if (k == "mentality")         { dir.kind = DK::Mentality;       team = true; }
        else if (k == "line_height")       { dir.kind = DK::LineHeight;      team = true; }
        else if (k == "fk_taker")          dir.kind = DK::FkTaker;          // Gaylord set-piece-taker seam
        else if (k == "corner_taker")      dir.kind = DK::CornerTaker;
        else if (k == "pen_taker")         dir.kind = DK::PenTaker;
        else if (k == "long_throw_taker")  dir.kind = DK::LongThrowTaker;
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
            std::string ph = w.contains("phase") && w["phase"].is_string() ? w["phase"].get<std::string>() : "";
            if (ph == "in_possession" || ph == "attacking")         dir.phase = GameEngine::CondPhase::InPossession;
            else if (ph == "out_of_possession" || ph == "defending") dir.phase = GameEngine::CondPhase::OutOfPossession;
            else if (ph == "transition")                            dir.phase = GameEngine::CondPhase::Transition;
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
    std::string snapshotPath;   // --snapshot-in: situation snapshot to resume from (see tools/snapshot_from_trace.py)
    std::string matchPath;
    double streamFromMs = 0;   // suppress frame output before this clock (live re-sim resume)
    bool forceLive = false;    // --live (or FOOTY_LIVE env): self-pace the engine to wall-clock (§1.1)

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--summary") summaryOnly = true;
        else if (arg == "--live") forceLive = true;
        else if (arg == "--no-debug") debugMode = false;
        else if (arg == "--trace" && i + 1 < argc) tracePath = argv[++i];
        else if (arg == "--snapshot-in" && i + 1 < argc) snapshotPath = argv[++i];
        else if (arg == "--match" && i + 1 < argc) matchPath = argv[++i];
        else if (arg == "--stream-from" && i + 1 < argc) streamFromMs = std::atof(argv[++i]);
        else if (i == 1 && arg[0] != '-') seed = std::atoi(argv[i]);
        else if (i == 2 && arg[0] != '-') minutes = std::atoi(argv[i]);
    }
    const bool streamFrames = !summaryOnly;

    // §1.1 LIVE: gate self-pacing behind FOOTY_LIVE / --live (incompatible with --summary). When off
    // (the default + every existing path) the binary is byte-identical — the golden is untouched.
    bool isLiveMode = forceLive;
    if (const char* fl = std::getenv("FOOTY_LIVE")) isLiveMode = isLiveMode || (fl[0] == '1' || fl[0] == 't' || fl[0] == 'y');
    double liveSpeed = 1.0;   // wall->sim scalar; FOOTY_LIVE_SPEED tunes it (CRITICAL for fast tests; the §1.2 channel makes it mutable)
    if (const char* fs = std::getenv("FOOTY_LIVE_SPEED")) { double v = std::atof(fs); if (v > 0.0) liveSpeed = v; }
    if (isLiveMode && summaryOnly) { std::cerr << "FOOTY_LIVE/--live is incompatible with --summary\n"; return 1; }

    GameEngine engine;

    // Data-driven match: rosters + tactics from a JSON spec (the FM-style game).
    if (!matchPath.empty()) {
        std::ifstream f(matchPath);
        if (!f) { std::cerr << "Cannot open match spec: " << matchPath << "\n"; return 1; }
        nlohmann::json spec; f >> spec;
        if (spec.contains("seed") && spec["seed"].is_number()) seed = spec["seed"].get<int>();
        if (spec.contains("minutes") && spec["minutes"].is_number()) minutes = spec["minutes"].get<int>();
        // §weather bridge: an optional per-match condition (rain|wet|wind) so a match SPEC can carry
        // weather — the product/web path was env-only (FOOTY_WEATHER). Absent -> clear (byte-identical;
        // golden specs have no "weather" key). The FOOTY_WEATHER env below still overrides, for testing.
        if (spec.contains("weather") && spec["weather"].is_string()) {
            std::string w = spec["weather"].get<std::string>();
            if (w == "wind") engine.weather = 2;
            else if (w == "rain" || w == "wet") engine.weather = 1;
        }
        loadTeam(spec["home"], engine.homeRoster, engine.baseConfig[0]);
        loadTeam(spec["away"], engine.awayRoster, engine.baseConfig[1]);
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
                // Optional motivational effect: per-player moraleBoost deltas applied
                // when this entry fires. Shape: "morale":[{playerId, delta}].
                if (e.contains("morale") && e["morale"].is_array()) {
                    for (const auto& m : e["morale"]) {
                        if (m.contains("playerId") && m["playerId"].is_number() && m.contains("delta") && m["delta"].is_number()) {
                            int id = m["playerId"].get<int>();
                            if (id >= 0 && id < 22) te.moraleDelta[id] = m["delta"].get<double>();
                        }
                    }
                }
                // Optional mid-match formation change: per-player new role + anchor.
                // Shape: "layout":[{playerId, role, homeX, homeY}] (engine frame).
                if (e.contains("layout") && e["layout"].is_array()) {
                    for (const auto& L : e["layout"]) {
                        if (!L.contains("playerId") || !L["playerId"].is_number()) continue;
                        int id = L["playerId"].get<int>();
                        if (id < 0 || id >= 22) continue;
                        // Apply a layout slot ONLY if role+homeX+homeY are ALL present —
                        // a partial row would otherwise default role to GK / homeY to 0
                        // and corrupt the player (the apply gate keys on layoutSet).
                        bool hasRole = L.contains("role")  && L["role"].is_string();
                        bool hasHX   = L.contains("homeX") && L["homeX"].is_number();
                        bool hasHY   = L.contains("homeY") && L["homeY"].is_number();
                        if (!hasRole || !hasHX || !hasHY) {
                            if (hasRole || hasHX || hasHY)
                                std::cerr << "Skipping incomplete timeline layout for player " << id
                                          << " (missing " << (!hasRole ? "role " : "") << (!hasHX ? "homeX " : "")
                                          << (!hasHY ? "homeY" : "") << ")\n";
                            continue;
                        }
                        te.layoutHX[id]   = L["homeX"].get<double>();
                        te.layoutHY[id]   = L["homeY"].get<double>();
                        te.layoutRole[id] = roleFromStr(L["role"].get<std::string>());
                        te.layoutSet[id]  = true;
                    }
                }
                // §4 LIVE: which side this entry replaces (0=home, 1=away; -1=both, back-compat).
                // Lets a recorded TWO-SIDED match replay PER-TEAM byte-identically to the live frames
                // — live-inject ≡ timeline-replay, since both go through the shared applyDirectiveEntry.
                te.team = e.value("team", -1);
                engine.directiveTimeline.push_back(std::move(te));
            }
            std::sort(engine.directiveTimeline.begin(), engine.directiveTimeline.end(),
                      [](const GameEngine::TimelineEntry& a, const GameEngine::TimelineEntry& b) { return a.atMs < b.atMs; });
        }
        engine.configOverride = true;
        debugMode = false;  // never equalize a real team's attributes
    }

    if (const char* pd = std::getenv("FOOTY_PASSDEBUG")) engine.passDebug = (pd[0] == '1' || pd[0] == 't' || pd[0] == 'y');
    // §weather: FOOTY_WEATHER=rain/wet/1 -> wet pitch (ball skids); =wind -> windy (airborne drift);
    // unset/anything-else -> clear (byte-identical default). "wind" checked first ('w' also starts "wet").
    if (const char* wx = std::getenv("FOOTY_WEATHER")) {
        std::string w = wx;
        if (w == "wind") engine.weather = 2;
        else if (w == "rain" || w == "wet" || w == "1" || w[0] == 'r') engine.weather = 1;
    }

    engine.initWithSeed(seed);
    engine.setMatchLengthMinutes(minutes);
    if (debugMode) engine.equalizeAttributes(65);
    engine.startMatch();

    // ── Situation snapshot load (--snapshot-in) ── resume a SITUATION captured
    // from any trace (tools/snapshot_from_trace.py) in THIS engine version:
    // positions/velocities/facing/stamina, ball state, clock and score are
    // overridden after normal init; agent trackers/perceptions start fresh and
    // this engine's logic runs the moment forward. Exact bit-resume across
    // versions is impossible by design (any code change shifts the RNG stream)
    // — this is the cross-version "load the moment and continue" the owner
    // asked for: fix something, reload the snapshot, watch the same situation
    // play out under the new rules.
    if (!snapshotPath.empty()) {
        std::ifstream sf(snapshotPath);
        if (!sf) { std::cerr << "Failed to open snapshot: " << snapshotPath << "\n"; return 1; }
        nlohmann::json snap;
        try { sf >> snap; } catch (const std::exception& e) {
            std::cerr << "Bad snapshot JSON: " << e.what() << "\n"; return 1;
        }
        auto& st = engine.state;
        st.clockMs = snap.value("clockMs", 0.0);
        if (snap.contains("score")) {
            st.homeScore = snap["score"].value("home", 0);
            st.awayScore = snap["score"].value("away", 0);
        }
        if (snap.contains("ball")) {
            const auto& jb = snap["ball"];
            st.ball.x = jb.value("x", 525.0);   st.ball.y = jb.value("y", 340.0);
            st.ball.z = jb.value("z", 0.0);     st.ball.curl = jb.value("curl", 0.0);
            st.ball.vx = jb.value("vx", 0.0);   st.ball.vy = jb.value("vy", 0.0);
            st.ball.vz = jb.value("vz", 0.0);
            st.ball.controllerId = jb.value("controllerId", -1);
            st.ball.intendedReceiverId = jb.value("intendedReceiverId", -1);
            st.ball.lastToucherId = jb.value("lastToucherId", -1);
            int ltt = jb.value("lastTouchTeam", st.ball.lastToucherId >= 11 ? 1 : 0);
            st.ball.lastTouchTeam = ltt == 1 ? Team::Away : Team::Home;
        }
        if (snap.contains("players"))
            for (const auto& jp : snap["players"]) {
                int id = jp.value("id", -1);
                if (id < 0 || id >= (int) st.players.size()) continue;
                auto& p = st.players[id];
                p.x = jp.value("x", p.x);             p.y = jp.value("y", p.y);
                p.vx = jp.value("vx", 0.0);           p.vy = jp.value("vy", 0.0);
                p.targetX = jp.value("targetX", p.x); p.targetY = jp.value("targetY", p.y);
                p.facing = jp.value("facing", p.facing);
                p.stamina = jp.value("stamina", p.stamina);
            }
        // Live-ball housekeeping: no kickoff staging, no armed restart; the
        // carry tracker starts on the snapshot's controller so dwell/marathon
        // logic measures from the resume, not from a phantom past.
        engine.phase.kickoffPhase = false;
        engine.phase.actionTimer = 0;
        engine.setPiece.armed = false;
        engine.setPiece.type = SetPiece::None;
        engine.setPiece.placeBallAtMs = 0.0;
        engine.carrierTracker.carryTrackerId = st.ball.controllerId;
        engine.carrierTracker.carryStartMs = st.clockMs;
        engine.carrierTracker.carryStartX = st.ball.x;
        engine.carrierTracker.marathonReleased = false;
        std::cerr << "Snapshot loaded: t=" << st.clockMs / 1000.0 << "s score "
                  << st.homeScore << "-" << st.awayScore << " ball(" << st.ball.x << "," << st.ball.y
                  << ") ctrl=" << st.ball.controllerId << "\n";
    }

    TraceWriter trace;
    if (!tracePath.empty()) {
        if (trace.open(tracePath, seed, minutes * 60.0 * 1000.0))
            std::cerr << "Trace enabled: " << tracePath << "\n";
        else
            std::cerr << "Failed to open trace file: " << tracePath << "\n";
    }

    auto start = std::chrono::high_resolution_clock::now();

    double lastOutput = 0;

    // The per-frame work (trace write + throttled JSON output), shared by both loops below.
    auto emit = [&]() {
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
    };

    if (!isLiveMode) {
        // §1.4 flat-out: advance every tick as fast as possible (default — byte-identical to before).
        while (engine.step()) emit();
    } else {
        // §1.1 self-paced + §1.2 live command channel. Self-pace: advance whole FIXED_DT ticks only as
        // fast as wall-elapsed × speed allows, so the engine clock tracks what a viewer watches and a live
        // command lands on the CURRENT tick (no re-sim). SAME ticks as flat-out -> identical result.
        // §1.2: a reader THREAD owns the blocking stdin read and drains lines into rawCmds; the loop
        // applies them each iteration without ever blocking the tick.
        std::vector<std::string> rawCmds;
        std::mutex cmdMutex;
        std::thread reader([&]() {
            std::string line;
            while (std::getline(std::cin, line))
                if (!line.empty()) { std::lock_guard<std::mutex> lk(cmdMutex); rawCmds.push_back(line); }
        });
        reader.detach();   // blocks on getline; process exit reaps it (no clean join possible). §6 dead-stdout exit = TODO.

        auto liveStart = std::chrono::steady_clock::now();
        double pausedAccum = 0.0;
        bool paused = false;
        auto pauseStart = liveStart;
        for (;;) {
            // Drain + apply live commands. Match-global controls (speed/pause/resume) apply now;
            // `inject` is logged here and applied per-team in §1.3 (applyLiveCommands). NEVER block here.
            std::vector<std::string> cmds;
            { std::lock_guard<std::mutex> lk(cmdMutex); cmds.swap(rawCmds); }
            for (const auto& line : cmds) {
                try {
                    auto j = nlohmann::json::parse(line);
                    std::string type = j.value("type", std::string());
                    if (type == "speed") {
                        double v = j.value("value", 1.0);
                        if (v > 0.0) { liveSpeed = v; std::cerr << "[live] speed=" << liveSpeed << "\n"; }
                    } else if (type == "pause") {
                        if (!paused) { paused = true; pauseStart = std::chrono::steady_clock::now(); std::cerr << "[live] paused\n"; }
                    } else if (type == "resume") {
                        if (paused) { pausedAccum += std::chrono::duration<double, std::milli>(
                                          std::chrono::steady_clock::now() - pauseStart).count();
                                      paused = false; std::cerr << "[live] resumed\n"; }
                    } else if (type == "inject") {
                        // §1.3b: parse the inject into a TimelineEntry (same shape as a spec timeline
                        // entry) and queue it; applyLiveCommands drains it per-team at atMs<=clock.
                        GameEngine::TimelineEntry entry;
                        entry.atMs = j.value("atMs", engine.state.clockMs);
                        entry.team = j.value("team", -1);
                        if (j.contains("directives")) parseDirectives(j["directives"], entry.directives);
                        if (j.contains("morale")) for (const auto& m : j["morale"]) {
                            int pid = m.value("playerId", -1);
                            if (pid >= 0 && pid < 22) entry.moraleDelta[pid] = m.value("delta", 0.0);
                        }
                        if (j.contains("layout")) for (const auto& l : j["layout"]) {
                            int pid = l.value("playerId", -1);
                            if (pid >= 0 && pid < 22 && l.contains("role") && l.contains("homeX") && l.contains("homeY")) {
                                entry.layoutHX[pid] = l["homeX"].get<double>();
                                entry.layoutHY[pid] = l["homeY"].get<double>();
                                entry.layoutRole[pid] = roleFromStr(l["role"].get<std::string>());
                                entry.layoutSet[pid] = true;
                            }
                        }
                        std::cerr << "[live] inject queued (atMs=" << entry.atMs << " team=" << entry.team << ")\n";
                        engine.liveCommandQueue.push_back(std::move(entry));
                    }
                } catch (const std::exception&) {
                    std::cerr << "[live] bad command: " << line << "\n";
                }
            }
            if (paused) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }   // match clock holds
            double wallMs = std::chrono::duration<double, std::milli>(
                                std::chrono::steady_clock::now() - liveStart).count() - pausedAccum;
            double targetClockMs = wallMs * liveSpeed;
            bool more = true;
            while (engine.state.clockMs < targetClockMs && (more = engine.step())) emit();
            if (!more) break;   // full-time
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
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

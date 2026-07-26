#pragma once
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "types.h"

// ── Binary trace format for deterministic replay and analysis ──
//
// Format:
//   [Header]     — version, seed, config
//   [Frame 0..N] — full engine state per tick
//   [Event 0..M] — tagged events (goals, tackles, etc.)
//   [Footer]     — frame count, event count
//
// Designed for: fwrite() speed, zero serialization overhead,
// post-process with Python/TS tools.

static constexpr uint32_t TRACE_MAGIC   = 0x46545346; // "FSTF" (Footy-Sim Trace Format)
static constexpr uint32_t TRACE_VERSION = 3;  // v3: + per-player `renderFacing` (smoothed display copy; raw `facing` kept)
                                              // v2: + per-player `wall` bool + ball `curl` (render hints)

#pragma pack(push, 1)

struct TraceHeader {
    uint32_t magic;
    uint32_t version;
    int32_t  seed;
    double   matchDurationMs;
    char     engineVersion[32];
};

struct TracePlayerState {
    int32_t  id;
    double   x, y;
    double   vx, vy;
    double   targetX, targetY;
    double   stamina;
    double   facing;        // RAW body angle — the engine's truth. Gates the vision cone
                            // (agent_movement.cpp) and every analysis tool reads THIS.
    int32_t  dribbleType;
    double   tackleAnim;
    double   headingAnim;
    int32_t  wall;          // v2: in the defensive FK wall this tick (render hint)
    double   renderFacing;  // v3: low-passed display copy (EMA alpha 0.18, engine.cpp).
                            // The live JSON stream has always shipped this instead of the
                            // raw angle, so a .bin replay used to render a facing shimmer
                            // the web viewer smoothed away. RENDER ONLY — never analysis.
};

struct TraceBallState {
    double   x, y;
    double   vx, vy;
    double   z, vz;
    int32_t  controllerId;
    int32_t  intendedReceiverId;
    int32_t  lastToucherId;
    double   curl;          // v2: lateral spin rad/s (render hint, for the curl trail)
};

struct TraceFrame {
    double   clockMs;
    TraceBallState ball;
    TracePlayerState players[22];
    int32_t  homeScore;
    int32_t  awayScore;
    double   physicsMs;
    double   agentMs;
};

struct TraceEvent {
    double   clockMs;
    char     type[24];    // "goal", "tackle", "tackle_won", "tackle_loose", "takeon",
                          // "takeon_lost" (R28 C3: winner grant of a read feint),
                          // "chop" (R28 C8: the two-stage beat cut, at the switch),
                          // "foul", "stuck", "freeze", "throw_in", "free_kick"
    double   x, y;
    int32_t  playerId;
    int32_t  teamId;      // 0=home, 1=away, -1=unknown
};

struct TraceFooter {
    uint32_t frameCount;
    uint32_t eventCount;
};

#pragma pack(pop)

class TraceWriter {
    FILE* f = nullptr;
    bool active = false;
    uint32_t frameCount = 0;
    uint32_t eventCount = 0;
    std::vector<TraceEvent> pendingEvents;

public:
    bool isOpen() const { return active; }

    bool open(const std::string& path, int seed, double matchDurationMs) {
        f = std::fopen(path.c_str(), "wb");
        if (!f) return false;
        active = true;
        frameCount = 0;
        eventCount = 0;

        TraceHeader header;
        header.magic = TRACE_MAGIC;
        header.version = TRACE_VERSION;
        header.seed = seed;
        header.matchDurationMs = matchDurationMs;
        std::strncpy(header.engineVersion, "cpp", sizeof(header.engineVersion) - 1);
        header.engineVersion[sizeof(header.engineVersion) - 1] = '\0';
        std::fwrite(&header, sizeof(header), 1, f);
        return true;
    }

    // `renderFacing` is the engine's smoothed display copy (GameEngine::renderFacing);
    // pass nullptr and the raw angle is written into both slots.
    void writeFrame(const EngineState& state, const std::array<double, 22>* renderFacing = nullptr,
                    double physicsMs = 0, double agentMs = 0) {
        if (!active) return;
        TraceFrame frame{};
        frame.clockMs = state.clockMs;
        frame.homeScore = state.homeScore;
        frame.awayScore = state.awayScore;
        frame.physicsMs = physicsMs;
        frame.agentMs = agentMs;

        frame.ball.x = state.ball.x;
        frame.ball.y = state.ball.y;
        frame.ball.vx = state.ball.vx;
        frame.ball.vy = state.ball.vy;
        frame.ball.z = state.ball.z;
        frame.ball.vz = state.ball.vz;
        frame.ball.controllerId = state.ball.controllerId;
        frame.ball.intendedReceiverId = state.ball.intendedReceiverId;
        frame.ball.lastToucherId = state.ball.lastToucherId;
        frame.ball.curl = state.ball.curl;

        for (size_t i = 0; i < state.players.size() && i < 22; i++) {
            auto& p = state.players[i];
            auto& tp = frame.players[i];
            tp.id = p.id;
            tp.x = p.x; tp.y = p.y;
            tp.vx = p.vx; tp.vy = p.vy;
            tp.targetX = p.targetX; tp.targetY = p.targetY;
            tp.stamina = p.stamina;
            tp.facing = p.facing;
            tp.dribbleType = p.dribbleType;
            tp.tackleAnim = p.tackleAnim;
            tp.headingAnim = p.headingAnim;
            tp.wall = p.wall ? 1 : 0;
            tp.renderFacing = (renderFacing && p.id >= 0 && p.id < 22) ? (*renderFacing)[p.id] : p.facing;
        }
        std::fwrite(&frame, sizeof(frame), 1, f);
        frameCount++;
    }

    // Events are buffered and flushed at close: the file format (and reader)
    // is header → frames → events → footer, so they can't be interleaved.
    void writeEvent(const std::string& type, double clockMs, double x, double y, int playerId = -1, int teamId = -1) {
        if (!active) return;
        TraceEvent event{};
        event.clockMs = clockMs;
        std::strncpy(event.type, type.c_str(), sizeof(event.type) - 1);
        event.type[sizeof(event.type) - 1] = '\0';
        event.x = x;
        event.y = y;
        event.playerId = playerId;
        event.teamId = teamId;
        pendingEvents.push_back(event);
        eventCount++;
    }

    void close() {
        if (!active || !f) return;
        for (const auto& e : pendingEvents) std::fwrite(&e, sizeof(e), 1, f);
        pendingEvents.clear();
        TraceFooter footer;
        footer.frameCount = frameCount;
        footer.eventCount = eventCount;
        std::fwrite(&footer, sizeof(footer), 1, f);
        std::fclose(f);
        f = nullptr;
        active = false;
    }
};

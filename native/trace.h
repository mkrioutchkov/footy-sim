#pragma once
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
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
static constexpr uint32_t TRACE_VERSION = 1;

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
    double   facing;
    int32_t  dribbleType;
    double   tackleAnim;
    double   headingAnim;
};

struct TraceBallState {
    double   x, y;
    double   vx, vy;
    double   z, vz;
    int32_t  controllerId;
    int32_t  intendedReceiverId;
    int32_t  lastToucherId;
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
    char     type[24];    // "goal", "tackle", "foul", "stuck", "freeze", "throw_in", "free_kick"
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

    void writeFrame(const EngineState& state, double physicsMs = 0, double agentMs = 0) {
        if (!active) return;
        TraceFrame frame;
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
        }
        std::fwrite(&frame, sizeof(frame), 1, f);
        frameCount++;
    }

    void writeEvent(const std::string& type, double clockMs, double x, double y, int playerId = -1, int teamId = -1) {
        if (!active) return;
        TraceEvent event;
        event.clockMs = clockMs;
        std::strncpy(event.type, type.c_str(), sizeof(event.type) - 1);
        event.type[sizeof(event.type) - 1] = '\0';
        event.x = x;
        event.y = y;
        event.playerId = playerId;
        event.teamId = teamId;
        std::fwrite(&event, sizeof(event), 1, f);
        eventCount++;
    }

    void close() {
        if (!active || !f) return;
        TraceFooter footer;
        footer.frameCount = frameCount;
        footer.eventCount = eventCount;
        std::fwrite(&footer, sizeof(footer), 1, f);
        std::fclose(f);
        f = nullptr;
        active = false;
    }
};

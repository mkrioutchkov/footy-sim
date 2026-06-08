#include "engine.h"
#include "trace.h"
#include <iostream>
#include <chrono>

int main(int argc, char* argv[]) {
    int seed = 101;
    int minutes = 5;
    bool summaryOnly = false;
    bool debugMode = true;
    std::string tracePath;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--summary") summaryOnly = true;
        else if (arg == "--no-debug") debugMode = false;
        else if (arg == "--trace" && i + 1 < argc) tracePath = argv[++i];
        else if (i == 1) seed = std::atoi(argv[i]);
        else if (i == 2) minutes = std::atoi(argv[i]);
    }
    const bool streamFrames = !summaryOnly;

    GameEngine engine;
    engine.initWithSeed(seed);
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

        // Write trace frame every tick
        if (trace.isOpen()) {
            trace.writeFrame(engine.state);
        }

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

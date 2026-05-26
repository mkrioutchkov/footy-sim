#include "engine.hpp"
#include <iostream>
#include <chrono>

int main(int argc, char* argv[]) {
    int seed = 101;
    int minutes = 5;
    if (argc > 1) seed = std::atoi(argv[1]);
    if (argc > 2) minutes = std::atoi(argv[2]);
    const bool streamFrames = argc <= 3 || std::string(argv[3]) != "--summary";

    GameEngine engine;
    engine.initWithSeed(seed);
    engine.startMatch();

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

    while (engine.state.clockMs < totalMs && engine.state.matchState != "finished") {
        engine.update(FIXED_DT);

        // Output JSON every ~33ms (30fps) for real-time display
        if (streamFrames && engine.state.clockMs - lastOutput >= 33.0) {
            lastOutput = engine.state.clockMs;
            std::cout << engine.getJSON() << std::endl;
        }
    }

    // Final state
    std::cout << engine.getJSON() << std::endl;

    return 0;
}

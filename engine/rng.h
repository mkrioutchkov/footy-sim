#pragma once
#include <cstdint>
#include <cstdlib>

class SeededRNG {
    uint32_t state = 0;
    bool seeded = false;
public:
    void setSeed(uint32_t seed) { state = seed; seeded = true; }
    // Snapshot support: the whole PRNG is this one word. Restoring it resumes
    // the exact draw sequence — same-version snapshot resumes replay the same
    // rolls (cross-version still diverges: different code consumes the stream
    // in a different order, which is inherent, not fixable by carrying state).
    uint32_t getState() const { return state; }
    void setState(uint32_t s) { state = s; seeded = true; }

    // splitmix32 — deterministic, high-quality 32-bit PRNG
    double random() {
        if (!seeded) return (double)std::rand() / RAND_MAX;
        state += 0x9e3779b9;
        uint32_t z = state;
        z ^= z >> 16;
        z *= 0x85ebca6b;
        z ^= z >> 13;
        z *= 0xc2b2ae35;
        z ^= z >> 16;
        return static_cast<double>(z) / 4294967296.0;
    }

    int randomInt(int min, int max) {
        return static_cast<int>(random() * (max - min + 1)) + min;
    }
};

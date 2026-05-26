#pragma once
#include <cstdint>
#include <cstdlib>

class SeededRNG {
    uint32_t state = 0;
    bool seeded = false;
public:
    void setSeed(uint32_t seed) { state = seed; seeded = true; }
    void clearSeed() { seeded = false; }

    double random() {
        if (!seeded) return (double)std::rand() / RAND_MAX;
        state += 0x6d2b79f5;
        uint32_t t = state;
        t = (t ^ (t >> 15)) * (t | 1);
        t ^= t + (t ^ (t >> 7)) * (t | 61);
        return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
    }

    int randomInt(int min, int max) {
        return static_cast<int>(random() * (max - min + 1)) + min;
    }
};

# Footy Sim

2D football simulation engine. C++ simulation core, TypeScript browser renderer.

## Architecture

```
native/             C++ simulation engine
  main.cpp          CLI entry point (live + benchmark modes)
  engine.h          GameEngine class declaration
  engine.cpp        Engine core loop
  engine_actions.cpp     Action execution (passes, shots, tackles)
  engine_physics.cpp     Physics (ball movement, collisions)
  engine_defense.cpp     Defense logic and helpers
  engine_defense_helpers.cpp
  engine_gk.cpp      Goalkeeper-specific engine code
  engine_setpiece.cpp    Set piece handling
  agent.h/cpp        PlayerAI — outfield player decision-making
  agent_defend.cpp       Defensive positioning and tactics
  agent_movement.cpp     Movement and path logic
  agent_pass.cpp         Passing decisions
  agent_pass_helpers.cpp
  agent_perception.cpp   Player perception and awareness
  agent_positioning.cpp  Positioning logic
  agent_positioning_helpers.cpp
  agent_resolve.cpp      Resolution of ambiguous states
  agent_scoring.cpp      Scoring chances and shots
  agent_setpiece.cpp     Set piece AI
  agent_shoot_dribble.cpp    Shooting and dribbling decisions
  gk_ai.h/cpp        GKPlayerAI — goalkeeper-specific AI
  role_ai.h/cpp      Role-specific AI subclasses (CF, WM, CM, CB, FB)
  types.h/cpp        Core data types (Player, Ball, EngineState, enums)
  constants.h        Named constants, utility functions
  stats.h/cpp        StatsCollector — match telemetry
  trace.h            Binary trace writer
  rng.h              Deterministic PRNG (splitmix32)
  small_vector.h     Utility template
  build_version.h/cpp    Build metadata

src/                TypeScript
  cpp-server.ts      WebSocket relay for live.exe (paced 30fps)
  renderer.ts        PixiJS browser renderer
  native-batch.ts    Parallel benchmark runner
  native-scenarios.ts    Deterministic scenario checks
  types.ts           TypeScript type definitions
  constants.ts       Constants

scripts/            Build scripts (PowerShell)
  build-native.ps1   C++ compilation and linking

build/              Compiled binaries (gitignored)
  live.exe           The simulation engine binary

tools/              Python utilities
  trace_reader.py    Parse and read binary trace files
  diagnose_trace.py  Trace analysis helper

third_party/        External dependencies
  nlohmann/          JSON library (header-only)
```

## Building

Requires Visual Studio with C++ workload (cl.exe) and Node.js.

```
npm run build           # Full build (native + TypeScript)
npm run native:build    # Native C++ only (outputs build/live.exe)
```

## Running

```
npm run dev             # Vite dev server (browser)
npm run cpp-server      # WebSocket relay for live match
npm run benchmark       # 8×10min parallel benchmark
npm run scenarios       # Deterministic scenario checks
```

The `npm run benchmark` command runs 8 seeds (101–108) for 10 minutes each via parallel invocations of the native binary.

## Debugging

### Binary Trace Files

The engine can write per-tick binary traces for offline analysis:

```
build/live.exe 101 1 --trace match.bin
```

Then analyze with the Python reader:

```python
from tools.trace_reader import TraceReader
t = TraceReader('match.bin')
for f in t.frames_ms(22000, 24000):
    b = f.ball
    print(f'{f.clock_ms:.0f}ms ({b.x:.0f},{b.y:.0f}) ctrl={b.controller_id}')
```

The trace stores ball position/velocity, all 22 player states, scores, and tagged events (pass, shot, tackle). Useful for diagnosing position jumps, stuck play, and tactical issues.

### Command-Line Arguments

The binary accepts:

```
build/live.exe <seed> <minutes> [--summary] [--no-debug] [--trace <path>]
```

- `<seed>`: RNG seed (integer, e.g., 101)
- `<minutes>`: Match duration in minutes (integer, e.g., 10)
- `--summary`: Output only final JSON summary (fast, no frame streaming)
- `--no-debug`: Disable attribute equalization (players retain rolled variance)
- `--trace <path>`: Write binary trace to file for analysis

Examples:

```
build/live.exe 103 10                    # Run seed 103 for 10 minutes, stream frames
build/live.exe 103 10 --trace debug.bin  # Same, with trace for analysis
build/live.exe 101 5 --summary           # Fast summary-only benchmark
build/live.exe 101 5 --no-debug          # Realistic variance, no attribute equalization
```

### Quality Flags

The engine tracks automated quality alerts in `StatsCollector`:

| Flag | Detection |
|------|-----------|
| `ball_jump` | Ball moved >50px beyond what velocity explains (loose ball only) |
| `stuckCarrier` | Carrier didn't move for 4.2s |
| `simulationFreeze` | Ball didn't move for 1.5s |
| `dizzySpin` | Player accumulated >720° rotation in 2s |
| `questionableShot` | Shot from bad distance/angle |
| `questionablePress` | Primary presser not the closest defender |

These appear in the benchmark JSON output under `qualityFlags`.

### Seeded Determinism

All matches use `SeededRNG` (splitmix32). Same seed = identical match. Use this to reproduce bugs:

```
build/live.exe 103 10              # Run seed 103 for 10 minutes
build/live.exe 103 10 --trace t.bin # With trace for analysis
```

### Comparing Benchmarks

Run before and after a change with the same seeds:

```
npm run benchmark   # Uses seeds 101-108, 10 minutes each
```

Key metrics to compare: goals/match, shots/match, pass completion %, offsides, quality flags. All must match for a pure refactor. Behavioral changes should show measurable differences.

### Common Issues

**Build fails with missing cl.exe**: The build script calls `VsDevCmd.bat` from Visual Studio. Adjust the path in `scripts/build-native.ps1` if your VS install differs.

**Ball teleport / position jump**: Check the `ball_jump` quality flag. Run a trace and look for large position deltas. Common causes: set piece placement, `updateControlledBall` running during set pieces.

**Blowout scores in 90-min matches**: Check attribute variance (35-90 range in `initWithSeed`). One team may roll significantly better players. The urgency system was removed — if scores seem unrealistic, check GK attribute variance.

## Code Style

- Spaced formatting: `if (x == y) { ... }`, not `if(x==y){...}`
- Named constants in `constants.h`, not magic numbers
- Enum comparisons, not string comparisons (`Role::GK` not `"GK"`)
- Virtual dispatch for role-specific AI behavior
- Forward declarations preferred over includes where possible

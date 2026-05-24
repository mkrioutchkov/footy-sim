# Footy Sim — Repo Structure

```
footy-sim/
├── src/
│   ├── server.ts        WebSocket engine server (Node.js) — broadcasts state to clients
│   ├── main.ts          WebSocket client — receives state, renders via PixiJS
│   ├── engine.ts        Core simulation loop, ball physics, set pieces, GK, grid
│   ├── agent.ts         Per-player agent: perception, state machine, decision-making
│   ├── intention.ts     Shared types for perception and agent phase state
│   ├── renderer.ts      PixiJS renderer — pitch, players, ball, trails, HUD, events
│   ├── types.ts         TypeScript interfaces: Player, Ball, EngineState, Formations
│   ├── constants.ts     Pitch dimensions, physics tuning, helper functions
│   ├── teams.ts         Team generation from formation templates
│   ├── manager.ts       Manager config creation (AI/human, formation, aggression)
│   ├── ui.ts            HTML overlay: pre-match setup screen + in-game HUD controls
│   └── vite-env.d.ts    Vite type declarations
├── .scratch/
│   └── footy-sim-logs/  Game session logs (JSONL format)
├── .gitignore
├── DESIGN.md
├── index.html
├── package.json
└── tsconfig.json
```

## Build & Run

```bash
cd footy-sim
npm install

# Terminal 1: Start engine server
npm run server        # WebSocket server on ws://localhost:3000

# Terminal 2: Start client
npm run dev           # Vite dev server on http://localhost:5173
```

The engine runs server-side in Node.js. The browser is a thin client — it connects via WebSocket to `ws://localhost:3000`, receives state updates, and renders them with PixiJS.

Speed slider and pause controls send commands back to the server via WebSocket messages.

## Architecture

The simulation is completely decoupled from rendering:

- **Engine** (`engine.ts`) runs a fixed-timestep physics loop at 60Hz server-side. Handles ball movement, friction, player-ball collision, goal detection, out-of-play, set pieces, and goalkeeper logic.
- **Server** (`server.ts`) wraps the engine in a WebSocket server. Broadcasts `EngineState` JSON to all connected clients at 60Hz. Accepts `pause` and `speed` commands.
- **Client** (`main.ts`) connects via WebSocket, receives state updates, renders via `MatchRenderer`.
- **Agents** (`agent.ts`) are per-player state machines. Each tick they perceive the world, evaluate options via weighted scoring, and execute actions. GKs have no agent — they're managed by the engine.
- **Renderer** (`renderer.ts`) reads a shared state object each frame. Uses pre-created PixiJS Graphics objects (moved via position.set, not redrawn) for performance.

## Logging

Logs are JSONL files in `.scratch/footy-sim-logs/`. Each line is a JSON event. The engine logs:

- `session_start` — match metadata
- `sample` — periodic state snapshot (ball pos, controller, pressure, close players)
- `possession` — when a player gains control
- `pass_start` / `force_pass_start` — normal vs panic passes
- `shot_start` — shot taken
- `tackle` / `save` / `goal` — key match events
- `set_piece_awarded`, `set_piece_taker` — restarts
- `assignments` — team coordinator role assignments
- `contest_block` — player blocked from re-collecting after releasing

Add more logging freely — the system is designed to be verbose for debugging.

**Log analysis:** Compare event frequency to real football. Expect 8-12 possession changes per real-world minute. If you see 30+ per 30 seconds, pacing is broken.

## Repeatable Simulation Checks

Full AI evaluation and seeded-debugging instructions are in `AI_EVALUATION.md`.

Run seeded headless matches before and after AI changes:

```bash
npm run batch -- --matches 5 --minutes 10 --seed 1
```

The batch output includes possession, territory, pass and shot rates, quality
flags, tactical task selection counts, and per-match summaries. Reusing the
same seed set makes tactical changes comparable rather than anecdotal.

For visual inspection with repeatable team generation and agent decisions,
seed the live server:

```powershell
$env:SIM_SEED='17'; npm.cmd run server
```

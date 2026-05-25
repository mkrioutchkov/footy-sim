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
- `pass_attempt`, `pass_complete`, `pass_fail` — accountable delivery outcomes
- `pass_start` / `force_pass_start` — normal vs panic pass execution
- `pass_selection` — chosen target geometry, expected completion and viable safer alternative
- `timed_run_start`, `timed_pass_release`, `offside` — through-run release timing
- `cutback_start`, `cutback_to_shot`, `cutback_goal` — wide pull-back outcomes
- `shot_start`, `goal_audit` — shot choice geometry and resulting scored chance
- `goal_line_crossing` — accepted crossing position and height inside the goal frame
- `cross_to_shot`, `cross_goal` - delivered crosses that lead to a shot or goal, retaining open-play/corner origin in batch outcomes
- `gk_distribution_result` - goalkeeper delivery completion or failure context
- `gk_save_assessment` - shot speed, projected offset, time to line and save chance
- `tackle_win`, `tackle_fail`, `tackle_rejected` — contact-validated challenges
- `save` / `goal` — key match outcomes
- `set_piece_awarded`, `set_piece_taker` — restarts
- `assignments` — team coordinator role assignments
- `press_assignment_audit`, `off_ball_shape` — presser choice and tracked attacking runs
- `moment_start`, `moment_followup` — paired decision snapshots for quality alerts
- `contest_block` — player blocked from re-collecting after releasing
- `stale_chase_cancelled` - loose-ball perception invalidated after another player takes control
- `collection_rejected` - rejected controlled-ball, out-of-reach or protected re-collection attempt
- `final_third_entry` - attacking-third possession-chain start for conversion measurement
- `shot_blocked` - outfield control, header or physical deflection stopping an active shot
- `cross_completed` - delivered cross secured by a receiver with goal distance context

Quality flags are intended to name actionable failures. In particular,
`ball_unclaimed` means a slow grounded ball is close enough to contest but is
still ignored, while `rapid_control_changes` counts rapid team turnovers rather
than ordinary completed passes. `bad_gk_distribution` and
`bad_player_distribution` identify harmful defensive-third distribution
outcomes; `unrealistic_gk_save` and `poor_gk_save_attempt` retain the
speed/trajectory/reaction values needed for replay.

**Log analysis:** Compare event frequency to real football. Expect 8-12 possession changes per real-world minute. If you see 30+ per 30 seconds, pacing is broken.

## Repeatable Simulation Checks

Full AI evaluation and seeded-debugging instructions are in `AI_EVALUATION.md`.

Run seeded headless matches before and after AI changes:

```bash
npm run batch -- --matches 5 --minutes 10 --seed 1
```

Run deterministic rule scenarios before accepting behavior changes:

```bash
npm run scenarios
```

The batch output includes possession, territory, pass and shot rates, cross
and cutback outcomes, distribution outcomes, goalkeeper assessments, weighted
ball launch speeds, pass/shot selection audits and pressing-assignment
diagnostics. It also includes contest bounds: collection and interception
contact distances, stale chase cancellations, rejected grabs and winning
tackle distances. Ordinary or interception collection is bounded to `20` px,
winning tackles to `24` px; an intended pass receiver alone may secure a
stretched first touch at `28` px and the controlled ball is snapped to the
visible boot position. Reusing the same seed set makes tactical changes
comparable rather than anecdotal.

Final-third conversion is measured per possession entry and counts at most one
shot for each attacking-third possession. Shot blocks are attributed to
outfield controls, headers and physical deflections while a shot is active.
`panic_clear` means an unpressured forced pass made within one second of
receiving a teammate's pass; unpressured out-of-play audits use launch-time
pressure and require the passing team to remain the last toucher.

A scripted corner cross owns its short wind-up interval: the taker cannot
execute an ordinary agent shot or pass before that delivery. Selected shots
use the same long/acute geometry rejection as the low-value audit, and
rejected options cannot be revived by later urgency or pressure bonuses.
`poor_gk_save_attempt` is reserved for clear keeper failures; less certain
beaten assessments remain visible in `gk_save_assessment`.

A wide forward delivery into a central finishing target is a cross; a
cutback is the pull-back alternative, not a catch-all label for every wide
pass. Batch cross output separates open-play and corner attempts,
completions, shots and goals. A selected cross remains an attempted cross if
the eventual delivery misses its intended central landing area.

For visual inspection with repeatable team generation and agent decisions,
seed the live server:

```powershell
$env:SIM_SEED='17'; npm.cmd run server
```

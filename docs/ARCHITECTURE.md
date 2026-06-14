# Architecture

How the whole system fits together. `★` marks components being added for the
plain-English tactics feature (see [TACTICS.md](TACTICS.md)); `(Px)` is the
roadmap phase that builds it.

```
                          +---------------------------+
                          |    MANAGER (web browser)    |
                          |  Plan box: plan + ASCII XI  |
                          |  Shouts box: subs (consumed)|
                          +-----+----------------+------+
                       text/subs|               ^ 2D match + "receipt"
                                v               |
+------------------------- web/frontend (vanilla TS SPA) -----------------------+
|  app.ts router . api.ts (HTTP + WS) . styles.css                             |
|  Screens:  Auth . Dashboard . League table . Squad                           |
|  * Tactics textbox + interpretation receipt              (P4)                |
|  Watch view --------------------> PixiJS MatchRenderer (renderer.ts)         |
+------+--------------------------------------------------------------^--------+
       | /api (HTTP, cookie session)        /ws/match (frames --------+ + cmds)
       v                                                              
+------------------------- web/backend (Fastify + node:sqlite) -----------------+
|  Routes:  auth . team . tactics . league . advance . play . /ws/match        |
|  Auth/session (scrypt)        Game:  leagues . fixtures . standings           |
|                                                                              |
|  * TACTICS COMPILER (P3)                 MATCH ORCHESTRATION                  |
|     text --> rules parser --+            - playFixture -> spawn --summary      |
|               +--> Haiku ----+--> DSL    - MatchStream -> live pacer + cmd chan|
|     cache by text-hash          |        * TIMELINE STORE (P2)                |
|        | ANTHROPIC_API_KEY      |            seed + [(clock, DSL-delta)]       |
|        v                        v                  |                          |
|   +------------+          spec.json  <-------------+                          |
|   | Claude     |          {rosters, 5 dials, *directives}                     |
|   | Haiku      |                 |                                            |
|   +------------+                 | spawn / stdin cmds         ^ summary JSON   |
+----------+-----------------------+----------------------------+----------------+
           | node:sqlite           v                            | + 30fps frames
           v             +------------- engine/ -> build/live.exe +--------------+
+--------------------+   |  Deterministic C++ sim  (pure: seed + spec + deltas) |
|   SQLite DB        |   |  - score-based decisions: pass.shoot.dribble.mark... |
|  users . sessions  |   |  - tactic dials (configFor)                          |
|  leagues . teams   |   |  * DSL INTERPRETER + condition eval         (P1)      |
|  players . fixtures|   |  * live delta apply @ clock                 (P2)      |
|  * tactics timeline|   |  * morale / compliance gating               (P5)      |
|  * match reports   |   |  emits: summary JSON  +  30fps frame stream          |
+--------------------+   +------------------------------------------------------+

  Determinism:  match = f( seed , ordered [(clock, compiled-DSL)] )
                the compiled DSL is cached per instruction text, so the LLM runs
                once per shout and every replay is byte-identical.
```

## Components

| Component | Where | Role |
|---|---|---|
| **Engine** | `engine/` -> `build/live.exe` | Deterministic C++ match sim. Reads `spec.json` (rosters + tactics), emits a summary JSON (`--summary`) or a 30 fps frame stream. Same seed + spec -> identical output. |
| **Backend** | `web/backend/` | Fastify + `node:sqlite`. Auth/sessions, leagues/teams/fixtures/standings, and match orchestration: `playFixture` (spawn for a result) and `MatchStream` (spawn + pace frames to the watch socket). |
| **Frontend** | `web/frontend/` | Vanilla-TS SPA + the PixiJS `MatchRenderer`. Login -> create club -> league -> set tactics -> play matchday -> watch. |
| **Database** | `web/backend/data/footy.sqlite` | SQLite (gitignored). `users, sessions, leagues, teams, players, fixtures`. |
| **Engine harness** | `tools/` | `native-batch.ts` (parallel benchmarking), `native-scenarios.ts`, `cpp-server.ts` (standalone watch relay), python trace probes. |

### Planned (plain-English tactics)

| Component | Where | Phase |
|---|---|---|
| **DSL interpreter + condition eval** | `engine/` | P1 |
| **Live delta apply at clock** | `engine/` + watch cmd channel | P2 |
| **Tactics compiler** (rules parser + Haiku, constrained JSON, cache) | `web/backend/` | P3 |
| **Tactics textbox + receipt, shout-to-officials subs** | `web/frontend/` | P4 |
| **Morale / compliance** (`discipline`, `morale` attrs) | `engine/` + UI feedback | P5 |
| **Timeline store + match reports** | `web/backend/` + DB | P2+ |

## Key flows

- **Instant sim** (matchday for other fixtures): backend builds `spec.json` from
  both teams, spawns `live.exe --match spec.json --summary`, parses the last JSON
  line for the score, persists it.
- **Live watch**: `MatchStream` spawns the engine *without* `--summary` (streams
  frames), paces them by match-clock to one websocket client; client sends
  pause/speed (and, P2+, tactical deltas) back over the same channel.
- **Determinism**: a match is a pure function of its seed and the ordered list of
  `(clock, compiled-DSL)` deltas. The binary is the contract boundary between the
  two halves — see [CONTRACT.md](CONTRACT.md).

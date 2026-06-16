# Architecture

How the whole system fits together. Everything below is **shipped** unless marked
otherwise; for the live roadmap see `GAME_LAYER_NOTES.md`, [`TACTICS.md`](TACTICS.md),
and [`SHOUTS_AND_PERSONALITY.md`](SHOUTS_AND_PERSONALITY.md). The frozen engine↔web
interface is [`CONTRACT.md`](CONTRACT.md); ownership/process is [`TEAM.md`](TEAM.md).

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
|  Screens:  Auth . Dashboard . League/Cup . Squad . Transfers . Training       |
|  Tactics textbox + interpretation receipt (live, mid-match)                   |
|  Watch view --------------------> PixiJS MatchRenderer (renderer.ts)         |
+------+--------------------------------------------------------------^--------+
       | /api (HTTP, cookie session)        /ws/match (frames --------+ + cmds)
       v                                                              
+------------------------- web/backend (Fastify + node:sqlite) -----------------+
|  Routes: auth . team . tactics . league . advance . play . transfers . /ws    |
|  Game: leagues . fixtures . standings . seasons/divisions . cup . AI managers  |
|        transfer market . training . injuries/fitness . reports . record-replay |
|                                                                              |
|  LLM modules (provider-agnostic, OpenAI-compatible):                         |
|    tactics.ts (text->directives) . plan.ts (composite plan) . lineup.ts       |
|    personality.ts . press.ts . news.ts . report.ts                           |
|    default Groq llama-3.3-70b-versatile, via TACTICS_LLM_* in .env (gitignored)|
|       | compile (cache by roster+side+text)                                  |
|       v                          MATCH ORCHESTRATION (match.ts)              |
|   directives + timeline -------> playFixture -> spawn --summary               |
|                                  MatchStream -> live pacer + cmd channel      |
|                                  per-session timeline: seed + [(clock,delta)]  |
|                                       |                                       |
|   +------------+   spec.json  <-------+                                       |
|   | morale.ts  |   {rosters, 5 dials, directives, timeline}                   |
|   | squad      |          |                                                  |
|   | morale     |          | spawn / stdin cmds          ^ summary JSON + 30fps |
+---+-----+------+----------+---------------------------+--+--------------------+
         | node:sqlite      v                           |
         v        +------------- engine/ -> build/live.exe ---------------------+
+------------------+  |  Deterministic C++ sim  (pure: seed + spec + deltas)   |
|   SQLite DB      |  |  - score-based decisions: pass/shoot/dribble/mark/...   |
|  users sessions  |  |  - tactic dials (configFor) + directive interpreter     |
|  leagues teams   |  |  - directives: 17 per-player + 12 team-wide kinds        |
|  players fixtures|  |  - timeline deltas applied at recorded clocks           |
|  free_agents     |  |  - runtime moraleBoost / per-entry moraleDelta channel  |
|  player_news     |  |  emits: summary JSON  +  30fps frame stream             |
|  cup_ties        |  +--------------------------------------------------------+
|  match_recordings|
|  match_reports   |   Determinism:  match = f( seed, ordered [(clock, compiled-DSL)] )
+------------------+   the compiled DSL is cached per instruction text, so the LLM runs
                      once per shout and every replay is byte-identical.
```

## Components

| Component | Where | Role |
|---|---|---|
| **Engine** | `engine/` -> `build/live.exe` | Deterministic C++ match sim. Reads `spec.json` (rosters + 5 dials + `directives` + `timeline`), emits a summary JSON (`--summary`) or a 30 fps frame stream. Same seed + spec -> identical output. Executes the directive interpreter + timeline deltas each tick. |
| **Backend** | `web/backend/` | Fastify + `node:sqlite`. Auth/sessions; leagues/teams/fixtures/standings; seasons & divisions; cup; AI managers; transfer market; training; injuries/fitness; match orchestration (`playFixture`, `MatchStream`); record/replay; reports; the LLM modules. |
| **LLM modules** | `web/backend/*.ts` | `plan.ts` (**the live mid-match text→directives compiler** — a stateful composite-plan editor), `tactics.ts` (shared directive vocabulary + `validate`; single-shot `compileTactics` now test-only), `lineup.ts`, `personality.ts`, `press.ts`, `news.ts`, `report.ts`. **Provider-agnostic** OpenAI-compatible; **default Groq `llama-3.3-70b-versatile`** via `TACTICS_LLM_BASE_URL/MODEL/API_KEY` in `web/backend/.env` (gitignored). Output cached so replays stay byte-identical — the engine never calls an LLM. |
| **Frontend** | `web/frontend/` | Vanilla-TS SPA + the PixiJS `MatchRenderer`. Login → create club → league → set tactics → play matchday → watch, with a live tactics textbox + interpretation receipt over the watch socket. |
| **Database** | `web/backend/data/footy.sqlite` | SQLite (gitignored, path overridable via `FOOTY_DB`). Tables: `users, sessions, leagues, teams, players, fixtures, free_agents, player_news, cup_ties, match_recordings, match_reports`. (The tactics *timeline* is a per-session construct in `match.ts`/`spec.json`, **not** a DB table.) |
| **Engine harness** | `tools/` | `native-batch.ts` (parallel benchmarking), `native-scenarios.ts`, `cpp-server.ts` (standalone watch relay), the backend test suite (`*_test.ts`), `recordings_gc.ts`, and the Python trace probes (`_passaudit.py`, `_shotaudit.py`, `_saveprobe.py`, …). |

## Key flows

- **Instant sim** (matchday for other fixtures): backend builds `spec.json` from both
  teams, spawns `live.exe --match spec.json --summary`, parses the last JSON line for
  the score, persists it (+ a generated post-match report).
- **Live watch**: `MatchStream` spawns the engine *without* `--summary` (streams
  frames), paces them by match-clock to one websocket client; the client sends
  pause/speed **and mid-match tactical edits** back over the same channel — a
  `{type:'tactics'}` edit appends to the timeline at the watched clock and re-sims
  from there (`--stream-from`), resuming seamlessly because the prefix is
  byte-identical.
- **Determinism**: a match is a pure function of its seed and the ordered list of
  `(clock, compiled-DSL)` deltas. The binary is the contract boundary between the two
  halves — see [`CONTRACT.md`](CONTRACT.md).

## Still on the roadmap

Personality **drift** over time, and **per-directive compliance gating** (weighting
an order by the addressed player's temperament/morale). The rest of the
plain-English-tactics + personality/morale loop — composite plan, the morale engine
hook, press conferences that move morale — is **shipped**. See
[`SHOUTS_AND_PERSONALITY.md`](SHOUTS_AND_PERSONALITY.md) and `GAME_LAYER_NOTES.md`.

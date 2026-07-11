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
|  leagues teams   |  |  - directives: 25 player + 17 team + 4 taker kinds       |
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
| **Engine** | `engine/` -> `build/live[.exe]` | Deterministic C++ match sim (build cross-platform: `build-native.ps1` on Windows, `build-native.sh` on Linux/macOS). Reads `spec.json` (rosters + 5 dials + `directives` + `timeline`), emits a summary JSON (`--summary`) or a 30 fps frame stream. Same seed + spec -> identical output. Directive interpreter: ~25 per-player + 17 team-wide + 4 set-piece-taker kinds (authoritative list: `tactics.ts` VALID_KINDS + [`TACTICS.md`](TACTICS.md)). |
| **Backend** | `web/backend/` | Fastify + `node:sqlite`. Auth/sessions; **shared worlds + claim-a-club** (`worlds.ts`); leagues/teams/fixtures/standings; seasons & divisions; cup; **national teams + international tournaments + Club World Cup** (`national.ts`, `nations.ts`); AI + assistant managers wired into the matchday; a **turn-based / autonomous world scheduler**; transfer market; training; injuries/fitness; match orchestration (`playFixture`, `MatchStream`) + the **live-match coordinator** (`coordinator.ts`); record/replay; reports; the LLM modules. |
| **LLM modules** | `web/backend/*.ts` | `plan.ts` (**the live mid-match text→directives compiler** — a stateful composite-plan editor), `tactics.ts` (shared directive vocabulary + `validate` + `sanitizeStructuredDirectives`; single-shot `compileTactics` now test-only), `lineup.ts`, `personality.ts`, `press.ts`, `news.ts`, `report.ts`. Transport in `llm.ts`: **provider-agnostic** — `http` (default Groq `llama-3.3-70b-versatile`, OpenAI-compatible) **or** `claude-code` (the local Claude CLI on a Max/Pro subscription), set by `TACTICS_LLM_PROVIDER` in `web/backend/.env` (gitignored). Output cached so replays stay byte-identical — the engine never calls an LLM. |
| **Frontend** | `web/frontend/` | Vanilla-TS SPA + the PixiJS `MatchRenderer`. Login → create/claim a club → league → set tactics → play matchday → watch. Tactics has **two surfaces**: a plain-English plan/shout textbox (LLM) **and** a deterministic structured **tactics board** (sliders + formation picker + role presets), both writing the same `plan_directives`. |
| **Database** | `web/backend/data/footy.sqlite` | SQLite (gitignored, path overridable via `FOOTY_DB`). ~26 tables — core `users, sessions, leagues, teams, players, fixtures` plus `worlds, nations, tournaments, free_agents, cup_ties, match_recordings, match_reports, staff, finance_entries, season_history, youth_prospects, contract_offers, …` (see `db.ts`). Per-team tactics persist as `formation`/`lineup`/`plan_text`/`plan_directives`/`set_piece_takers` columns; the tactics *timeline* is a per-session construct in `match.ts`/`spec.json`, **not** a table. |
| **Engine harness** | `tools/` | `native-batch.ts` (parallel benchmark), `native-scenarios.ts`, `ab.py` (paired A/B t-test — real change vs seed noise), `tactics_golden.py` (byte-identical guard), `scan_anomalies.py` / `audit_weird.py`, `trace_reader.py` / `diagnose_trace.py` / `snapshot_from_trace.py`, `cpp-server.ts` (standalone watch relay), `recordings_gc.ts`. The `_*`-prefixed files (`_passaudit.py`, `*_test.ts`, …) are throwaway dev probes / backend tests (gitignored pattern). |

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
- **Cross-version snapshots**: `--snapshot-out`/`--snapshot-at` freezes a match moment
  (all 22 players, ball, clock, score, + the PRNG word); `--snapshot-in` reloads it into
  a *different* engine build to watch how the new code plays the same situation — how a
  fix is judged when the seed no longer reproduces the bug (butterfly effect). See
  [`CONTRACT.md`](CONTRACT.md) + the README engine-dev section.

## Still on the roadmap

Personality **drift** over time, and **per-directive compliance gating** (weighting
an order by the addressed player's temperament/morale). The rest of the
plain-English-tactics + personality/morale loop — composite plan, the morale engine
hook, press conferences that move morale — is **shipped**. See
[`SHOUTS_AND_PERSONALITY.md`](SHOUTS_AND_PERSONALITY.md) and `GAME_LAYER_NOTES.md`.

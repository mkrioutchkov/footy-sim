# CONTRACT — the engine ↔ web seam

This file is the **frozen interface** between the two halves of the codebase so
they can be built in parallel sessions. Changing anything in here is a
cross-boundary change: announce it and update **both** sides in the same merge
(e.g. the `woodwork` event needed `engine/` to emit it *and*
`web/frontend/types.ts` to render it).

## The two halves & ownership

| Half | Owns | Talks to the other half via |
|------|------|------------------------------|
| **Engine session** | `engine/` (C++), `scripts/build-native.ps1`, `tools/` (engine harness + python probes), produces `build/live.exe` | the binary + the JSON I/O below |
| **Web session** | `web/backend/` (Fastify + node:sqlite), `web/frontend/` (SPA + PixiJS renderer), `dist/` | spawns `build/live.exe`, reads its JSON |

Build outputs and shared deps stay at the repo root by design: `build/`
(engine binary), `dist/` (frontend build), `third_party/`. The **engine binary
is the contract boundary** — the web side never reads C++; the engine side never
reads TS.

## Engine CLI (the binary the web side spawns)

```
build/live.exe SEED MINUTES --summary --no-debug                 # legend teams
build/live.exe --match <spec.json> --summary --no-debug          # data-driven teams
build/live.exe --match <spec.json> --trace out.bin               # + binary frame trace
```
- `--summary` prints ONE JSON object per line; the **last `{…}` line** is the
  match summary. NEVER omit `--summary` (without it the process streams frames
  forever and locks the binary).
- Without `--summary`, the engine streams per-tick frames (`EngineState`, below)
  to stdout — this is what the live-watch path consumes and paces to the client.
- Determinism: same `SEED` + same `spec.json` + same binary ⇒ byte-identical
  output. The web side relies on this (a fixture replays identically).

## INPUT — `spec.json` (web → engine)

Written by `web/backend/match.ts → buildSpec()`; consumed by the engine's
`--match` reader (`engine/main.cpp` + `RosterOverride`/`configOverride` in
`engine/engine.*`). Shape:

```jsonc
{
  "seed": 123456,
  "minutes": 90,
  "home": {
    "name": "Iron Lions",
    "tactics": { /* the 5 dials + formation, see Tactics below */ },
    "players": [ { "name": "…", "attrs": { /* PlayerAttributes */ } }, … ]  // 11, sorted by slot (GK first)
  },
  "away": { … same shape … },

  // OPTIONAL — plain-English tactics, compiled to directives (engine P1, live).
  // Player ids are RESOLVED to engine ids (0..21) by the caller; the engine
  // works purely in ids. Omit the block entirely for no directives.
  "directives": [
    { "playerId": 3, "kind": "man_mark", "targetId": 19, "intensity": 0.9,
      "when": { "fromMin": 70, "toMin": 90, "scoreState": "losing", "scoreBy": 1 } }
  ]
}
```
- `players`: exactly 11 per team, ordered by squad slot. `attrs` is
  `PlayerAttributes` (`speed, passing, creativity, shooting, tackling,
  positioning, stamina`, each 0–100) — see `web/frontend/types.ts`.
- The fixed-22 invariant: home = engine ids 0–10, away = 11–21.
- `directives[].kind`: **20 per-player + 12 team-wide** kinds (man_mark,
  shoot_on_sight, get_forward, sit_deep, target_player, …; team-wide kinds carry a
  `teamScope` flag and adjust the 5 dials at runtime). The **authoritative list lives
  in `engine/main.cpp` `parseDirectives` + `web/backend/tactics.ts`** and is
  documented in [docs/TACTICS.md](TACTICS.md) — don't duplicate it here. `targetId`
  for man_mark/target_player. `when` (all optional): `fromMin` (default 0) / `toMin`
  (default 1000) minute window, `scoreState` ∈ `winning|drawing|losing` + `scoreBy`
  N. Conditions are evaluated each tick from clock+score (pure, deterministic).

## OUTPUT — summary JSON (engine → web)

Last `{…}` line of `--summary`. The web backend reads `summary.homeScore` /
`summary.awayScore` to persist a result (`web/backend/match.ts`). The object also
carries rich stats the web UI may surface: `saves`, `shots`, `passes`,
`passCompletionPct`, `goalsByDistance`, `shotsByDistance`, `crossesCompleted`,
per-player stats, etc. **Treat extra fields as additive** — read what you need,
ignore the rest.

## OUTPUT — live frames (`EngineState`) — render stream **and recorded artifact**

The engine streams a per-tick `EngineState` (players, ball, clock, score,
`events[]`, set-piece state, per-player stats, team stats, …) to the watch socket.
The **authoritative schema is `web/frontend/types.ts`** (`EngineState` + the
per-player `Player`) — do not duplicate it; import from there.

> ⚠️ **Live frames are no longer transient render data — they are persisted and
> re-read.** Human-stake matches are captured **full-frame** (the engine is spawned
> *without* `--summary`: `live.exe --match spec --no-debug`, via `web/backend/match.ts`
> `recordMatch`; non-stake fixtures still use the `--summary` quick path) and gzipped
> to **`web/backend/data/recordings/{kind}-{id}.ndjson.gz`** (NDJSON, one frame per
> line). `web/backend/report.ts` (match reports + player **ratings**) and
> `web/backend/news.ts` (dynamic player-news) **re-read** these recordings later
> (`recordingFor` → `loadRecording` → `analyzeRecording`). **The frame JSON is
> therefore a storage-frozen contract: a silent change to a frame field the analysis
> reads breaks every existing recording.** The `match_recordings` table carries a
> `format INTEGER NOT NULL DEFAULT 1` version column (`web/backend/db.ts`) for
> *deliberate* schema bumps — **bump it when you change the recorded frame shape.**
> (Caveat: today `format` is written but **not read** anywhere — there is no
> read-side version branch / migration yet, so the bump is a manual-discipline
> marker, not an enforced gate. A reader/migration is the natural follow-up.)

### Frame fields the game layer depends on (now part of the contract)

`report.ts → analyzeRecording` reads these out of the recorded frames; changing or
removing one breaks reports / ratings / news:

- **Per-player** (off every frame's `players[]`): `goals`, `assists`, `shots`,
  `tackles`, `yellow`, `sentOff` (+ `id`, `name`, `team`, `role`).
- **Team** (read off the **final** frame): `homeScore`, `awayScore`, `possessionPct`,
  `homeShots`, `awayShots`, `shotsOnTarget`, `saves`, `cornersAwarded`. These team
  stats are the **`--summary` stats object merged into every frame** by the engine
  (`engine.cpp` `j.update(summary)`), so they ride on the live frame as well as the
  summary.

### Own-goal attribution — per-player `goals` is last-toucher; the SCORE is authoritative

The engine credits per-player **`goals` to the *last toucher*, regardless of which
net the ball entered** (`engine_physics.cpp` — both goal branches call
`creditGoal(lastGoal.toucherId)`; the increment is unconditional). So an own-goal
deflector's own `goals` tally rises while the **opponent's** score increases. The web
layer never trusts per-player `goals` for attribution: `report.ts analyzeRecording`
attributes goals by **score DELTA** (`homeScore`/`awayScore` change between frames),
matches it to a same-side per-player increment for the scorer name, and labels the
unmatched case the literal string **`"Own goal"`**; own goals are excluded from a
player's rating credit (`legitGoals`). **`homeScore`/`awayScore` are the authoritative
scoreline — never reconstruct the score by summing per-player `goals`** (that
mis-sides own goals).

### Completion marker — `matchState: "finished"`

A recording is only published once the stream ends **and** the final frame's
`matchState === "finished"` (the capture gate in `match.ts`; incomplete captures are
rejected). The *readers* (`report.ts`/`news.ts`) do **not** re-check `matchState` —
they trust the persisted recording is complete and treat the **last frame as
full-time**. So `"finished"` is the capture-completeness contract, and the last
recorded frame is the authoritative final state.

### `MatchEvent.type` is part of the contract
Adding an engine event means adding it to the `MatchEvent` union in
`web/frontend/types.ts` AND giving it a label/colour in `web/frontend/renderer.ts`.
Current set includes: `pass, shot, save, goal, header, woodwork, penalty, foul,
offside, yellow, red, sub, …` (full list in types.ts).

### ⚠️ Known contract gap — chip filed for Boris
`shotsOnTarget`, `saves`, and `cornersAwarded` ride on the recorded frame (merged
from `--summary`) and `report.ts` reads them off the last frame, but they are **not
declared on `EngineState`/`Player` in `web/frontend/types.ts`** — the type lags the
wire. **Boris → add `shotsOnTarget`, `saves`, `cornersAwarded` to `EngineState` in
`web/frontend/types.ts`** so the recorded-frame contract is fully typed. (EngineState
already types `homeShots`/`awayShots`/`possessionPct`; these three are the omission.)

## Tactics (the 5 dials + the plain-English layer)

`tactics` in the spec = the manager dials (`web/frontend/types.ts →
ManagerConfig`), all 0–100, centred at 50 = neutral:
`aggression, passingDirectness, overlapFrequency, midfieldFreedom,
defensiveLineHeight`, plus a `formation`. The engine maps these in
`engine/*` (`configFor(team)` etc.).

**Shipped:** the plain-English tactics layer. The web side compiles free text into
the `directives` block (team-wide kinds also nudge the 5 dials at runtime) via the LLM
plan compiler (`web/backend/plan.ts` `compilePlanEdit`; `tactics.ts` holds the shared
directive vocabulary), with the output **cached and frozen on the timeline** — the
engine only ever sees compiled directives, so replays stay byte-identical. See
[docs/TACTICS.md](TACTICS.md) and [docs/TACTICS_RUNTIME.md](TACTICS_RUNTIME.md).

## Repo layout & commands

```
engine/         C++ match engine            scripts/build-native.ps1  →  build/live.exe
web/backend/    Fastify + node:sqlite        npm run game     (:4000)
web/frontend/   SPA + PixiJS renderer        npm run dev      (:5173, proxies /api,/ws → 4000)
tools/          engine harness + py probes   npm run batch | scenarios | cpp-server
docs/           ARCHITECTURE · CONTRACT · TACTICS · SHOUTS_AND_PERSONALITY · STATSBOMB_DATA · REAL_DATA_AND_IP · TEAM
```
- DB: SQLite via `node:sqlite`, file at `web/backend/data/footy.sqlite` (gitignored).
- After `engine/` or `scripts/` edits: `npm run native:build`. After
  `web/backend/` edits: restart `npm run game` (tsx has no hot-reload).
- A fresh worktree needs `npm install` (node_modules is gitignored) and a
  `npm run native:build` (build/ is gitignored).

## Parallel workflow

- Engine session → `master` (or an `engine` branch); Web session → a `web`
  branch in its own git worktree. Merge via PRs/merges at milestones.
- Touch only your half's dirs. The only shared files are this CONTRACT and the
  schema in `web/frontend/types.ts` — change those deliberately, together.

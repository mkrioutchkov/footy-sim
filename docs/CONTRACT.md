# CONTRACT — the engine ↔ web seam

This file is the **frozen interface** between the two halves of the codebase so
they can be built in parallel sessions. Changing anything in here is a
cross-boundary change: announce it and update **both** sides in the same merge
(e.g. the `woodwork` event needed `engine/` to emit it *and*
`web/frontend/types.ts` to render it).

## The two halves & ownership

| Half | Owns | Talks to the other half via |
|------|------|------------------------------|
| **Engine session** | `engine/` (C++), `scripts/build-native.ps1` + `scripts/build-native.sh`, `tools/` (engine harness + python probes), produces `build/live.exe` (Windows) or `build/live` (Linux/macOS) | the binary + the JSON I/O below |
| **Web session** | `web/backend/` (Fastify + node:sqlite), `web/frontend/` (SPA + PixiJS renderer), `dist/` | spawns the engine binary (`match.ts` resolves either name), reads its JSON |

Build outputs and shared deps stay at the repo root by design: `build/`
(engine binary), `dist/` (frontend build), `third_party/`. The **engine binary
is the contract boundary** — the web side never reads C++; the engine side never
reads TS.

## Engine CLI (the binary the web side spawns)

```
build/live.exe SEED MINUTES --summary --no-debug                 # legend teams
build/live.exe --match <spec.json> --summary --no-debug          # data-driven teams
build/live.exe --match <spec.json> --trace out.bin               # + binary frame trace
build/live.exe SEED MINUTES --snapshot-out m.json --snapshot-at 58000   # freeze a moment (+ RNG)
build/live.exe SEED MINUTES --snapshot-in m.json                        # reload a moment (cross-version)
```
(On Linux/macOS the binary is `build/live` — `match.ts` resolves either name.)
- `--summary` prints ONE JSON object per line; the **last `{…}` line** is the
  match summary. NEVER omit `--summary` (without it the process streams frames
  forever and locks the binary).
- Without `--summary`, the engine streams per-tick frames (`EngineState`, below)
  to stdout — this is what the live-watch path consumes and paces to the client.
- Determinism: same `SEED` + same `spec.json` + same binary ⇒ byte-identical
  output. The web side relies on this (a fixture replays identically).
- **Cross-version moment replay** (snapshots): `--snapshot-out <f> --snapshot-at <ms>`
  freezes a match moment — all 22 players' pos/vel/facing/stamina, ball state (incl.
  curl + controller), clock, score, **and the single-word PRNG state** — to a JSON
  file; `--snapshot-in <f>` reloads it into a **DIFFERENT engine build** to watch how
  the new code plays out that exact situation (e.g. a bug seen at 0:58 that the seed
  no longer reproduces after a fix — the butterfly effect). Same-build resume replays
  on the identical roll sequence; across builds the RNG field is ignored (different
  code consumes the stream in a different order — inherent, not a gap).
  `tools/snapshot_from_trace.py` extracts a moment from a `--trace` file instead of a
  live run (positions/velocities but not the RNG). See the README engine-dev section.

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
  ],

  // OPTIONAL — timed plan changes (the watch flow's mid-match edits, recorded so a
  // match REPLAYS identically). Parse ground truth: engine/main.cpp --match reader
  // ("timeline" block). Entries are sorted by atMs and applied when the clock
  // reaches atMs.
  "timeline": [
    {
      "atMs": 2700000,                       // when this entry fires (ms; default 0)
      "directives": [ /* same shape + parser as the top-level block */ ],
      "morale":    [ { "playerId": 3, "delta": 8 } ],   // per-player moraleBoost deltas (id 0..21)
      "layout":    [ { "playerId": 3, "role": "CB", "homeX": 300, "homeY": 200 } ],
      "team": 0                              // 0=home, 1=away, -1=both (default; back-compat)
    }
  ]
}
```
- `players`: exactly 11 per team, ordered by squad slot. `attrs` is
  `PlayerAttributes` (`speed, passing, creativity, shooting, tackling,
  positioning, stamina`, each 0–100) — see `web/frontend/types.ts`.
- The fixed-22 invariant: home = engine ids 0–10, away = 11–21.
- `directives[].kind`: **~25 per-player + 17 team-wide (+ 4 set-piece-taker)** kinds (man_mark,
  shoot_on_sight, get_forward, sit_deep, target_player, …; team-wide kinds carry a
  `teamScope` flag and adjust the 5 dials at runtime). The **authoritative list lives
  in `engine/main.cpp` `parseDirectives` + `web/backend/tactics.ts`** and is
  documented in [docs/TACTICS.md](TACTICS.md) — don't duplicate it here. `targetId`
  for man_mark/target_player. `when` (all optional): `fromMin` (default 0) / `toMin`
  (default 1000) minute window, `scoreState` ∈ `winning|drawing|losing` + `scoreBy`
  N, and `phase` ∈ `in_possession` (alias `attacking`) | `out_of_possession` (alias
  `defending`) | `transition` — a live tactical-phase gate on top of the clock/score
  ones. Conditions are evaluated each tick from clock+score+phase (pure,
  deterministic).
- ⚠️ **Unknown `kind`s are dropped SILENTLY** (`parseDirectives`: `else continue`).
  **KNOWN-INERT: `gk_up_for_corners`** — `web/backend/tactics.ts` lists it and the UI
  offers it as a live toggle, but `engine/main.cpp parseDirectives` has no branch for
  it, so the engine discards it without a warning. Wiring it up (or pulling it from
  the vocabulary) is an open cross-boundary chore; until then the toggle does nothing.
- `timeline[]` (2026-08, documented from `engine/main.cpp`'s reader): each entry
  carries optional `directives` (same parser as the top-level block), `morale`
  (`{playerId, delta}` per-player moraleBoost deltas, ids 0..21), and `layout` —
  a mid-match formation change (`{playerId, role, homeX, homeY}`, engine-frame
  coordinates). **`layout` rows are all-or-nothing: `role` + `homeX` + `homeY` must
  ALL be present or the row is skipped** (with a stderr warning) — a partial row
  would default role to GK / homeY to 0 and corrupt the player. `team` selects which
  side an entry replaces (0=home, 1=away, -1=both, the back-compat default) so a
  recorded two-sided match replays per-team byte-identically to the live frames.

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
  `tackles`, `yellow`, `sentOff`, `passes`, `passesCompleted` (+ `id`, `name`,
  `team`, `role`).
- **Team** (read off the **final** frame): `homeScore`, `awayScore`, `possessionPct`,
  `homeShots`, `awayShots`, `shotsOnTarget`, `saves`, `cornersAwarded`. These team
  stats are the **`--summary` stats object merged into every frame** by the engine
  (`engine.cpp` `j.update(summary)`), so they ride on the live frame as well as the
  summary.
- **`substitutionLog`** (on every frame; cumulative — the final frame carries the
  whole match): one record per substitution, `{clockMs, slotId, team, outName,
  inName, outGoals, outAssists, outShots, outTackles, outPasses,
  outPassesCompleted, outYellowCards}` (typed as `SubstitutionRecord` in
  `web/frontend/types.ts`).
  A substitution is an **in-place slot identity swap** (`engine_squad.cpp`
  `substituteSlot`): the pitch slot keeps its `id`/`role`, the engine renames it to
  the arrival **in the same tick** and zeroes the slot's stat tally — so the
  departing man's line survives ONLY in this record's `out*` snapshot, and the slot
  id alone identifies a *shirt*, not a *person*. `report.ts` splits each slot into
  stints on these records (goal credit follows whoever held the slot at the goal's
  `clockMs`; the `out*` tally becomes the departed man's rating row — a 4-sub match
  yields 26 rating rows, not 22). The replay exporter joins the log to the `.bin`
  trace's `sub` events on `(clockMs, slotId)`. Recordings persisted before engine
  573675e have no `substitutionLog`; readers must degrade (22 rows), not crash.
  ⚠️ Cards do not ride in the `out*` tally, because they live in per-slot *runtime*
  state that the swap wipes: a departed man's yellow count comes from the separate
  **`outYellowCards`** field instead. `sentOff` needs no field — `pickSubstitutions`
  skips a sent-off man, so he is never substituted. Recordings made before
  `outYellowCards` landed omit it; readers must degrade to 0, not crash.

### ⚠️ Same name, different type — top-level vs per-player stats

The summary merge (`j.update(summary)`) puts whole-match TEAM aggregates at the
frame's top level under names that collide with per-player keys — **never type or
read them alike**:
- top-level `tackles` is an **object** (`{attempts, wins, cleanControls,
  looseDeflections, fouls}`, `stats.cpp`) while `players[].tackles` is an **int**;
- top-level `passes` is an **int**, but it is the *whole-match, both-teams attempt
  count* (e.g. 1367), while `players[].passes` is that player's attempts.
A reader that grabs `frame.tackles` expecting a number gets `[object Object]`; one
that sums `frame.passes` per player double-counts the match. Read team stats from
the documented team list above and player stats only off `players[]`.

### Own-goal attribution — the SCORE is authoritative

The engine credits per-player **`goals`/`assists` only to a last toucher on the
*scoring* team** (`engine_physics.cpp finishGoal` gates `creditGoal` — and the goal's
role/header attribution — on `lastGoal.touchTeam == scoringTeam`; an own goal credits
no player and is recorded with role "unknown"). The web layer still does not
reconstruct attribution from per-player `goals`: `report.ts analyzeRecording`
attributes goals by **score DELTA** (`homeScore`/`awayScore` change between frames),
matches it to a same-side per-player increment for the scorer name, and labels the
unmatched case the literal string **`"Own goal"`** — this stays robust regardless of
the engine's per-player crediting. Own goals earn no rating credit (`legitGoals`).
**`homeScore`/`awayScore` are the authoritative scoreline — never reconstruct the
score by summing per-player `goals`.**

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

### ~~Known contract gap — chip filed for Boris~~ CLOSED 2026-08
`shotsOnTarget`, `saves`, and `cornersAwarded` are now declared on `EngineState` in
`web/frontend/types.ts`, alongside the already-typed `homeShots`/`awayShots`/
`possessionPct` — the recorded-frame team stats `report.ts` reads are fully typed.
The same audit fixed the reverse drift: `Player.homeX/homeY/attrs` and `Ball.vz`
were *required* in types.ts but never emitted by the engine (deleted; no consumer
read them), and `substitutionLog` (emitted since engine 573675e) is typed as
`SubstitutionRecord[]`.

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
engine/         C++ match engine            build-native.ps1 (win) / .sh (posix)  →  build/live[.exe]
web/backend/    Fastify + node:sqlite        npm run game     (:4000)
web/frontend/   SPA + PixiJS renderer        npm run dev      (:5173, proxies /api,/ws → 4000)
tools/          engine harness + py probes   npm run batch | scenarios | cpp-server
docs/           ARCHITECTURE · CONTRACT · TACTICS · SHOUTS_AND_PERSONALITY · STATSBOMB_DATA · REAL_DATA_AND_IP · TEAM
```
- DB: SQLite via `node:sqlite`, file at `web/backend/data/footy.sqlite` (gitignored).
- After `engine/` or `scripts/` edits: `npm run native:build` (auto-detects the OS via `scripts/native-build.mjs`; `native:build:posix` forces bash). After
  `web/backend/` edits: restart `npm run game` (tsx has no hot-reload).
- A fresh worktree needs `npm install` (node_modules is gitignored) and a
  `npm run native:build` (build/ is gitignored).

## Parallel workflow

- Engine session → `master` (or an `engine` branch); Web session → a `web`
  branch in its own git worktree. Merge via PRs/merges at milestones.
- Touch only your half's dirs. The only shared files are this CONTRACT and the
  schema in `web/frontend/types.ts` — change those deliberately, together.

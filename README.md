# footy-sim

An FM-style football game: a **deterministic C++ match engine** wrapped in a
**web game layer** (create a club, set tactics, play a season of fixtures, watch
the 2D match). You manage by setting tactics — matches simulate deterministically
and you watch the replay.

## Layout

Role-based — the engine and the web app are cleanly separable (see
[docs/CONTRACT.md](docs/CONTRACT.md)):

```
engine/        C++ match engine            -> build/live[.exe]   (deterministic sim)
web/backend/   Fastify + node:sqlite       npm run game  (:4000)   API, auth, DB, match orchestration
web/frontend/  vanilla-TS SPA + PixiJS     npm run dev   (:5173)   the game UI + 2D match renderer
tools/         engine harness + py probes  npm run batch | scenarios | ab.py
scripts/       build-native.ps1 / .sh      (engine build — Windows / Linux+macOS)
docs/          ARCHITECTURE . CONTRACT . TACTICS
build/  dist/  third_party/                build outputs + deps
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full component diagram.

## Quickstart — play the game

Requires **Node.js** and a **C++ toolchain**. The engine build is cross-platform:
- **Windows** — Visual Studio with the C++ workload (`cl.exe`); `npm run native:build` (scripts/build-native.ps1) → `build/live.exe`.
- **Linux / macOS** — `g++`/`clang++`; `npm run native:build:posix` (scripts/build-native.sh) → `build/live`.

`match.ts` resolves either binary name, and the `pre*` npm hooks pick the Windows build script — POSIX users run `native:build:posix` explicitly (or add it to the hook).

```
npm install
npm run native:build            # Windows: compile the engine -> build/live.exe
#   or: npm run native:build:posix   # Linux/macOS -> build/live
npm run game                    # backend API + match-watch socket on :4000
npm run dev                     # frontend on :5173 (proxies /api + /ws -> 4000)
```
Open http://localhost:5173 -> register -> create a club -> Play matchday -> Watch.
The SQLite DB lives at `web/backend/data/footy.sqlite` (gitignored — delete it to
wipe all accounts/leagues; override the path with `FOOTY_DB`). `tsx` does **not**
hot-reload: restart `npm run game` after any `web/backend/` or `engine/` change
(rebuild the engine first).

## Engine development

The engine is a standalone deterministic binary:

```
build/live.exe <seed> <minutes> [--summary] [--no-debug] [--trace <path>]
build/live.exe --match <spec.json> [--summary]      # data-driven teams (see CONTRACT.md)
```
- `--summary` — print only the final JSON summary (fast; required for batch runs —
  without it the process streams frames forever and locks the binary).
- `--no-debug` — keep rolled attribute variance (don't equalize).
- `--trace <path>` — write a per-tick binary trace for offline analysis.

```
npm run batch            # parallel multi-seed benchmark (tools/native-batch.ts)
npm run scenarios        # deterministic scenario checks
```

**Determinism**: same seed + same spec + same binary = byte-identical output. Use
it to reproduce bugs and to verify pure refactors (metrics must match exactly).
Measure on >= 30 seeds — small samples are noise.

**Traces**: `build/live.exe 101 1 --trace t.bin`, then read with the python tools:
```python
from tools.trace_reader import TraceReader
t = TraceReader('t.bin')
for f in t.frames: ...
```
The trace stores ball + all 22 player states, scores, and tagged events.

**Situation snapshots** (cross-version moment replay): freeze any moment from a
trace and reload it into a DIFFERENT engine build — e.g. a bug seen at 0:58 no
longer reproduces from the seed after a fix (butterfly effect), so load the
0:58 situation directly and watch how the new engine plays it out:
```
python3 tools/snapshot_from_trace.py old_trace.bin --ms 58000 -o moment.json
./build/live.exe <seed> <minutes> --snapshot-in moment.json [--trace out.bin]
```
The snapshot carries positions/velocities/facing/stamina for all 22, ball state
(incl. curl + controller), clock, and score. It is a *situation* restore, not a
bit-exact resume — the RNG stream is code-coupled, so play diverges from the
loaded moment the way a real re-run of the situation would. The tool warns if
the requested moment sits within ±3s of a restart (set-piece choreography
doesn't snapshot cleanly).

To also carry the **RNG stream**, capture the snapshot from a live run instead
of a trace — the PRNG is a single word and `--snapshot-out` includes it:
```
./build/live.exe 133 12 --summary --no-debug --snapshot-out moment.json --snapshot-at 58000
./build/live.exe 133 12 --snapshot-in moment.json     # same-version: same draw sequence
```
Same-version resumes then replay the moment on the exact same rolls. Across
versions the field is ignored — different code consumes the stream in a
different order, so carrying the state cannot make builds agree (that part is
inherent, not a missing feature).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the full system diagram + components.
- [docs/CONTRACT.md](docs/CONTRACT.md) — the engine<->web interface (spec.json in, summary/stream out, the `MatchEvent` types, tactic dials). Freeze before parallel work.
- [docs/TACTICS.md](docs/TACTICS.md) — the plain-English tactics feature: design + phased roadmap.

## Roadmap

The single-player loop **and** shared-world multiplayer are shipped: auth → create/claim
a club → league + cup → set tactics (plain-English plan **or** the structured board) →
transfers, training, scouting, contracts, finances, board → play/watch matchdays → season
rollover (promotion/relegation, honours) → national teams + international tournaments +
a Club World Cup, with AI/assistant managers and a turn-based/autonomous world scheduler.

Genuinely next:
1. **Distribution** — package for release (Electron desktop wrap; itch/Steam), and make the
   LLM optional (the structured tactics board is already the no-LLM path).
2. **Live-multiplayer polish** — the LiveAIManager checkpoints + the round-robin runner
   (see [docs/LIVE_MATCH_ARCHITECTURE.md](docs/LIVE_MATCH_ARCHITECTURE.md) §4–5).
3. **Engine role depth** — real DM/AM behaviour, ball-playing CB, true inverted full-back
   (see [docs/TACTICS_ENGINE_FOLLOWUPS.md](docs/TACTICS_ENGINE_FOLLOWUPS.md)).

Known engine debt: move per-player stats/alerts/decision-audits closer to the agent code;
track time-in-offside by player/role (CF/WM); add CB-pair defensive-line telemetry.

## Code style

- Spaced formatting: `if (x == y) { ... }`, not `if(x==y){...}`.
- Named constants in `engine/constants.h`, not magic numbers.
- Enum comparisons, not strings (`Role::GK`, not `"GK"`).
- Virtual dispatch for role-specific AI; forward-declare over `#include` where practical.

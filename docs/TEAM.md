# The team — who owns what, and how we talk

footy-sim is built by **three parallel Claude Code sessions**, each scoped to one
slice of the codebase. This keeps every session's context small and focused (cheaper
per turn, less compaction, warmer prompt cache) and matches the repo's own
contract-based design — see [`CONTRACT.md`](CONTRACT.md).

## The three devs

| Dev | Session | Owns (write) | Stack |
|---|---|---|---|
| **Boris** | *FootySim Engine* | `engine/` (C++), `tools/` (harness + Python probes), `scripts/build-native.ps1`, `build/` → `build/live.exe` | C++ / Python / PowerShell |
| **Fuckwit** | *FootySim FrontEnd/Tactics/DB* | `web/backend/` (Fastify + node:sqlite **DB**, the **tactics compiler**, match orchestration) **and** `web/frontend/` (SPA + PixiJS renderer) | TypeScript / SQL / Pixi |
| **Gaylord** | *FootySim SysArch* (this session) | `docs/`, `MEMORY.md`, cross-cutting research & decisions; **steward** of the contract | prose / research / no heavy code |

> ⚠️ **"Backend" is overloaded — read this once.** Boris is "the backend" in the
> sense of the **simulation backend** (the C++ match engine). Boris does **not** own
> `web/backend/` — that Fastify+SQLite+tactics-compiler layer belongs to **Fuckwit**
> (it's the back end of the *web app*, which ships with the frontend it serves).
> Rule of thumb: **anything that compiles to `build/live.exe` is Boris; anything
> under `web/` is Fuckwit; anything under `docs/` is Gaylord.**

### Why three (and not one, or five)

- **Not one "do-everything" session:** it would carry C++ *and* TS *and* SQL *and*
  Pixi at once, churn the prompt cache every domain-switch, and hit auto-compaction
  ~2× sooner (compaction costs tokens *and* loses fidelity — here that means
  forgetting a contract detail or a golden-guard gotcha).
- **Not split further** (e.g. backend vs frontend, or tactics on its own): the web
  layers change together through the HTTP/WS API and `web/frontend/types.ts`, so
  separating them just adds constant cross-session re-sync. Tactics is *already*
  split along the contract seam — the **compiler + UI** are Fuckwit's; the
  **directive execution** in the engine is Boris's.
- **Gaylord stays code-light on purpose:** heavy research (the StatsBomb / IP /
  benchmark fan-outs) generates huge context. Quarantining it in SysArch keeps
  Boris's and Fuckwit's coding contexts lean.

## How we communicate

The three sessions **cannot see each other's chat.** They communicate only through
**committed artifacts in the repo.** A "message" from one dev to another is a commit
plus an update to a shared file. There are exactly four channels:

1. **The Contract — [`CONTRACT.md`](CONTRACT.md) + `web/frontend/types.ts`** *(the
   main channel between Boris and Fuckwit).* The engine binary is the only seam:
   Fuckwit spawns `build/live.exe` and reads its JSON; neither side reads the other's
   source. The contract covers the CLI flags, the `spec.json` **input**, the
   `--summary` JSON **output**, and the live `EngineState` / `MatchEvent` schema
   (authoritative copy in `web/frontend/types.ts`). **These two files are the only
   shared-write files — change them deliberately, together.**
2. **Git** — each dev works in their own branch/worktree (Boris on `master`/`engine`;
   Fuckwit on a `web` branch in its own worktree), touches **only their half's dirs**,
   and merges at milestones. This is how work physically moves between sessions.
3. **`MEMORY.md` + `docs/`** — Gaylord-curated shared knowledge: decisions, calibration
   targets, gotchas, the licence/IP stance. Read at session start; the durable memo
   board.
4. **Spawned task chips / hand-offs** — when one dev spots out-of-scope work in
   another's half, file it (don't fix it across the boundary).

### Contract-change protocol (the one thing that needs both halves)

A **contract change** = anything that alters the binary's CLI, the `spec.json`
input, the `--summary` output, or the `EngineState`/`MatchEvent` schema. These are
the only changes that *require* Boris **and** Fuckwit. Handle them deliberately:

1. **Propose** — whoever needs it writes a one-paragraph request (what field/event/
   flag, its shape, why). Usually originates from Fuckwit (needs a new stat to show)
   or Boris (emits a new mechanic/event).
2. **Record** — Gaylord (or the proposer) updates `CONTRACT.md` **and**
   `web/frontend/types.ts` in the same change, so the spec is the single source of
   truth before either side codes against it.
3. **Implement both sides in the same milestone** — Boris emits it; Fuckwit renders
   it. Never ship one half of a contract change.
4. **Determinism caveat** — any change touching the **default (no-directive) match**
   (a new `--summary` field, a constant on the default path, the 4-3-3 anchors)
   breaks the golden hash in `tools/tactics_golden.py`. That's **Boris's**
   re-baseline ritual — do it deliberately, never let it drift silently.

### Operational gotchas (so a dev doesn't wait on the other)

- After `engine/` or `scripts/` edits → **Boris** runs `npm run native:build`
  (rebuilds `build/live.exe`). The binary is the hand-off artifact Fuckwit consumes.
- After `web/backend/` edits → **Fuckwit** restarts `npm run game` (`:4000`) — `tsx`
  has no hot-reload. Frontend `npm run dev` (`:5173`) hot-reloads.
- `live.exe` with no `--summary` streams frames forever and **locks the binary** —
  always `--summary` for one-shot runs, or Boris can't rebuild.
- Engine benchmarking: `npm run batch` (Boris). It aggregates `--summary` across seeds
  into the rates a calibration scorecard checks.

## Gaylord's role (this session)

**Architect · scribe · contract steward · researcher — not a feature coder.**

What Gaylord **does**:
- **Cross-cutting research & decisions** that would bloat a dev session: the
  StatsBomb licence + calibration benchmarks ([`STATSBOMB_DATA.md`](STATSBOMB_DATA.md)),
  the real-teams/players IP stance ([`REAL_DATA_AND_IP.md`](REAL_DATA_AND_IP.md)),
  this team doc. Heavy multi-agent fan-outs live here so Boris/Fuckwit stay lean.
- **Contract stewardship** — records contract changes in `CONTRACT.md` +
  `types.ts`, keeps the two halves' assumptions aligned, flags determinism/golden
  impacts.
- **Docs & memory hygiene** — writes/prunes `docs/`, curates `MEMORY.md` so every
  session starts from current shared knowledge (e.g. the docs staleness audit).
- **Read-only cross-half review/audit** — because Gaylord sees both halves, it's the
  natural place for design review, calibration-target setting, and "is this still
  true?" sweeps. Read-only: findings go back to Boris/Fuckwit to implement.
- **Planning** — turns a goal into a spec/plan that Boris or Fuckwit executes.

What Gaylord **does not** do:
- Write engine C++ (Boris) or web TS feature code (Fuckwit). Keeping Gaylord
  code-light is the point — it's the cheap "thinking" session.
- Edit outside `docs/` / `MEMORY.md` without explicit say-so. (Current standing
  scope: **write only `docs/`**; root docs like `README.md`, `GAME_LAYER_NOTES.md`,
  `NOTES_OVERNIGHT.md` are out of scope until granted.)

**One-line charter:** *Gaylord decides and documents; Boris and Fuckwit build.*

## Quick reference — who do I ask?

| I need… | Owner |
|---|---|
| A match-engine mechanic / physics / AI / calibration constant | **Boris** |
| `build/live.exe`, determinism golden, engine benchmarks | **Boris** |
| A screen, API route, DB schema, the tactics **compiler**, the renderer | **Fuckwit** |
| A new directive **kind** (end-to-end) | **Boris** (execution) + **Fuckwit** (compiler/UI) → contract change |
| A new `--summary` field or `MatchEvent` | contract change → both, recorded by **Gaylord** |
| A decision, a spec, research, a doc, "is this still true?" | **Gaylord** |

---
*Added 2026-06-16 by Gaylord (SysArch). The technical interface contract lives in
[`CONTRACT.md`](CONTRACT.md); this doc is the human/process layer on top of it.*

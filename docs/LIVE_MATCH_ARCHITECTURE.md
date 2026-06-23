# Live Match Architecture — resident, self-paced, live-injectable engine

**Decision (2026-06-18):** matches that a human (or AI) manages must run in **real wall-clock time** so up to **two human managers on opposite teams + AI** make **live in-match decisions** (a shout at minute 60 bends minute 61). We go straight to the **resident source-paced engine** (not the re-sim stopgap), because the same mechanism is the foundation for the future "many live games per thread" runner.

This doc is the cross-team contract. Owners: **Boris** (engine), **Gaylord** (web coordinator/DB/scheduler), **manager_ai/SysArch** (the live AI hook). It supersedes the kill-respawn + `--stream-from` re-sim shout path for live human matches (that path stays only as the basis of deterministic replay — see §4).

---

## 0. The one correction vs the naive design (read first)

The current engine runs the **whole match flat-out (~12–31s)** and Node's `FramePacer` paces the *output* (match.ts:378–444). **That model is incompatible with live injection**: if the engine sprints to minute 90 in ~20s, a command issued when the human is watching minute 60 arrives in the engine's *past* and cannot be applied without re-sim.

**So in live mode the engine paces ITSELF to the wall-clock.** It advances whole `FIXED_DT` ticks only as fast as `wall-elapsed × speed` allows, sleeping between, so the engine's `clockMs` ≈ what the viewer is watching. A command then lands on the **current live tick** — no re-sim, no stall. Node's `FramePacer` becomes a **thin relay / jitter-buffer** in live mode, not the pacer. (The flat-out + Node-paces model remains correct for no-stake spectating and replay.)

This is the load-bearing change. Everything else composes around it.

---

## 1. Engine changes (Boris)

All live behaviour is **gated behind `isLiveMode`** (set from `FOOTY_LIVE=1` env or a `--live` flag, **incompatible with `--summary`**). When false — the default and every existing path — the binary is **byte-identical** to today: no self-pacing, no stdin read, golden guard untouched (`tools/tactics_golden.py`).

### 1.1 Self-pacing loop (the core)
The flat-out loop at `main.cpp:233–251` gains a live branch:
- Track `liveStartWall` (a `std::chrono` timepoint) at kickoff.
- Each iteration, compute `targetClockMs = (now − liveStartWall − pausedAccum) × speed`.
- Advance **whole `FIXED_DT` ticks** (constants.h:55 = 16.667ms) until `state.clockMs ≥ targetClockMs`, then `sleep` until the next tick is due. Catch-up = run several whole ticks in a row (still deterministic — same ticks, same `FIXED_DT`).
- `speed` is a **live, mutable** scalar (a `speed` control command changes it); it scales the wall→sim mapping, **never** the per-tick computation.
- Pause: stop advancing, accumulate paused wall-time into `pausedAccum`; resume subtracts it. Match clock holds.

> **Determinism invariant:** self-pacing changes *when* a tick runs in wall-clock, never *what* it computes. The number of `FIXED_DT` ticks to reach minute 90 is fixed; the sim is identical to flat-out. Only real-time *delivery* differs.

### 1.2 Live control channel
A **non-blocking** line-reader (stdin for v1; a named pipe/socket later) drains `\n`-delimited JSON commands each tick into a per-engine `liveCommandQueue`. Never block the tick loop on the read.

**Protocol (Node → engine):**
```jsonc
{ "type":"inject", "atMs":3600000, "team":0,           // team 0=home,1=away
  "directives":[ {"playerId":3,"kind":"man_mark","targetId":15,"intensity":0.9},
                 {"teamScope":0,"kind":"high_press","intensity":0.8} ],
  "morale":[{"playerId":3,"delta":0.18}],               // SPARSE — only changed players
  "layout":[{"playerId":1,"role":"CM","homeX":420,"homeY":170}] }   // optional, sparse
{ "type":"speed",  "value":2.0 }
{ "type":"pause" }   { "type":"resume" }
```
> **These bytes are LOCKED to the shipped coordinator** (`web/backend/coordinator.ts` `inject()`/`setSpeed()`/`setPaused()` — 20 fake-engine tests). The `morale`/`layout` shapes are the **existing directive-timeline entry shapes** (`{playerId,delta}` and `{playerId,role,homeX,homeY}`), NOT the older "22-array"/`{set,…}` paper form — because §1.3 mirrors the timeline application (`engine_defense.cpp:37–57`) which already parses these. Parse to THESE. `commandsToTimeline` reconstructs the identical entry for replay, so live-inject and timeline-replay parse one shape.
- `atMs` = the engine clock when the shout was issued (the coordinator stamps `state.clockMs`). The engine applies it when `state.clockMs ≥ atMs`, **monotonic** (reject/log `atMs < lastInjectedMs`). The coordinator already guarantees monotonic atMs (`editLock` + `max(lastInjectedMs+1, clockMs)`), so the engine's reject is a backstop, never the normal path. In practice atMs ≈ current clock (self-paced), so it lands next tick.
- `kind` values must stay within `tactics.ts VALID_KINDS`. 🔴 **Per-team replacement (the one hard contract item):** the engine keeps **two** active directive sets (home + away). An inject with `team:T` **replaces only set T**, leaving the other side's directives intact — NOT one global set. A `pause`/`speed`/`resume` is match-global (no `team`). A missing `team` ⇒ global/both (back-compat for the one-sided path + old logs). Without this, two interleaved home/away injects clobber each other and a two-sided replay diverges. See §1.3 + §4.

### 1.3 `applyLiveCommands()` — call site & order
New method, called in `fixedUpdate()` **after `applyDirectives()` and before `tickAgents()`** (so pre-match plan runs first, the live overlay replaces it, agents see the composite). It drains queue entries with `atMs ≤ clockMs`, applies directive-replacement + morale deltas (`moraleBoost`, clamped) + formation re-anchor (`baseHomeX/Y` + `reassignAgent`), mirroring the existing timeline application (`engine_defense.cpp:37–57`) so the two paths are provably identical. Pure function of clock+score+command — **no RNG** (preserve the determinism note at `engine_defense.cpp:19`).
> **Per-team (the blocker, restated):** make `applyDirectives()`/`applyLiveCommands()` hold the active directives as a **per-team pair** (e.g. `activeDirectives[2]`) and apply an entry's `team` to index which set it replaces; a missing `team` replaces both (back-compat). This is the single change that lets two interleaved sides coexist AND lets §4 timeline-replay reproduce a two-sided live match byte-for-byte. The current single-`activeDirectives` path is the only thing standing between today's one-sided shouts and full two-manager live.

### 1.4 Runner-readiness (do this shape now, even before the runner)
Express the tick as a public **`bool step()`** (one `fixedUpdate`, returns false at full-time); `main()`'s loop becomes `while (step()) { … }`. This costs nothing today and means the future "many games per thread" scheduler can drive N engines round-robin via `step()` without a second rewrite. Keep the command queue an in-memory structure (stdin just feeds it) so a scheduler can `pushCommand()` directly later.

---

## 2. Web shared match-coordinator (Gaylord)

**Today's bug (verified):** each WebSocket spawns its *own* `MatchStream`+engine, and `.watch.json` is keyed only by `fixtureId` (match.ts:503/511, index.ts:597), so two managers on one fixture **overwrite each other's timeline**. Fix = one shared coordinator per fixture.

- **One engine per fixture**, keyed in an `activeMatches` registry. The first connection spawns `live.exe` with `FOOTY_LIVE=1`; the opposite-team manager and spectators **attach to the same instance** (`MatchStream.join`). Frames are produced once and **fanned out** to all subscribers.
- **`editLock` serialization:** every shout chains on a per-fixture promise (`editLock = editLock.then(() => applyEdit(...))`) so concurrent home/away shouts append to **one canonical timeline** monotonically — no race, no out-of-order `atMs`.
- **Per-team routing & isolation:** a connection's team is resolved from its session (`index.ts:580–581`); `onCommand` **drops any command whose `team !== myTeam`** (a manager can only affect their own side; the LLM is already scoped to one squad, plan.ts:53). playerId 0–10 = home, 11–21 = away; `teamScope` 0/1.
- **Shared speed / pause:** speed and pause are **match-global** (both touchlines share one clock — you can't have two managers at different speeds in a live contest). Changing it broadcasts to all subscribers.
- **Reconnection:** a dropped socket just unsubscribes; the engine stays alive while anyone is attached. Re-opening re-attaches to the live `MatchStream` and resumes at the current frame (no seek in live mode). The coordinator disposes the engine when the last subscriber leaves (or at full-time).
- **`FramePacer` in live mode = thin relay** (a small jitter buffer), since the engine self-paces. Keep the existing pacer only for no-stake spectating/replay.

---

## 3. manager_ai v2 — live AI decisions (SysArch/me)

manager_ai **v1 (merged)** is pre-match only (formation/XI/transfers/plan → the 4 columns). **v2** adds a live hook reusing the *same* command path a human uses:
- A `LiveAIManager` attached to the coordinator for any club with `user_id IS NULL`. It watches the live frame state and, at **checkpoints** (every ~10s match-time, or events: goal, red card, halftime), asks the LLM (via `llm.ts`, the Claude-Code subscription transport — no Groq 429s) for a plain-English shout, compiles it (`compilePlanEdit`), and submits it through the coordinator's `applyAIShout` → the same `editLock`/inject path.
- Rate-limited (≥10s between, skip if the queue is deep) to avoid feedback loops. AI shouts are recorded as commands (§4) so replays are faithful.
- **AI-vs-AI with no human stays cheap:** it does **not** need the resident engine — run it on the existing flat-out `--summary` path with AI reactivity baked as **conditional timeline checkpoints** (halftime / on-concede) computed pre-match. Only human-stake matches go resident.

---

## 4. Determinism & event-sourced recording

**Canonical inputs of a live match = `seed` + the timestamped command log** (the applied-tick `atMs` of every inject/sub). The engine stamps each command at the tick it applied, so the log is exact.

- **Recording format 2** (`match_recordings.format` already exists, write-only today → start writing it): alongside the gzipped NDJSON frames, persist a `.events.json` = `{seed, duration, scores, commands:[{atMs,team,directives,morale,layout}]}`. Human-stake matches → format 2; legacy/AI-summary → format 1 (frames-only), unchanged. No back-migration.
- **Replay = reuse the proven path, NOT live stdin.** To replay/re-sim a format-2 match, **convert the command log into a spec `timeline`** (`commandsToTimeline`, shipped — each entry keeps its `team`) and run the engine in the **existing non-live flat-out timeline mode** (`engine_defense.cpp:37–57`). Because that path is already deterministic and the commands carry their applied `atMs`, the replay is **byte-identical** — and it exercises the same code the golden guard locks. (Frames-only `ReplayStream` still serves format-1.) 🔴 **The flat-out timeline parser must be per-team too:** `main.cpp parseDirectives`→`directiveTimeline` (and its swap in `engine_defense.cpp`) reads each entry's `team` and replaces only that side's set — the SAME two-set model as §1.3. This is what makes live-inject ≡ timeline-replay for a two-sided match; a single-set timeline parser would diverge from the live frames the moment home and away both shout.
- **Why live-inject ≡ replay:** a live command applied at tick T and a timeline entry at `{atMs:T}` run the *same* `applyLiveCommands`/`applyDirectives` replacement, at the same clock, with no RNG. The only thing real-time decides is *which tick T a human's click lands on* — and that T is **captured** in the log, so it's data, not nondeterminism.

---

## 5. Rollout, ownership, and the golden guard

**Phased (each phase independently shippable, golden green throughout):**
1. **Engine (Boris):** `isLiveMode` gate + self-pacing loop + control channel + `applyLiveCommands` + `step()`. Test: `--summary` byte-identical (golden, 7 seeds); a `FOOTY_LIVE=1` run with an empty queue matches a flat-out run frame-for-frame.
2. **Coordinator (Gaylord):** one-engine-per-fixture + `editLock` + per-team routing + fan-out + reconnection; retire kill-respawn for live. Test: two managers, no overwrite; shout lands live with no stall; pause/resume clean.
3. **Event-sourcing (Gaylord):** write format-2; replay-via-timeline. Test: record a live match with ≥3 shouts → timeline-replay is byte-identical.
4. **Live AI v2 (me):** `LiveAIManager` checkpoints. Test: AI shouts recorded + replay faithfully.
5. **Runner (Boris+Gaylord):** the `step()`-driven round-robin scheduler for many games per thread.

**Who builds what:** Boris = §1 (+ §5 engine). Gaylord = §2, §4 recording/replay, §5 scheduler. Me = §3 hook (manager_ai v2), keep the manager_ai column contract intact.

**Golden discipline (every phase):** the live path is gated; the default + `--summary` + `tools/tactics_golden.py` must stay byte-identical. Add a determinism regression that records a small format-2 match and asserts timeline-replay is byte-identical, run on every engine commit.

---

## 6. Residual risks (survive the design — watch these)

- **Self-pacing clock drift / catch-up under load:** if the host stalls, the engine must catch up by running whole ticks (never partial `FIXED_DT`), capped so it can't spiral. Keep frame emission throttled to ~30fps sim-time regardless.
- **Stdin backpressure:** non-blocking read; bound the queue; never block the tick loop. Large `layout` payloads (full re-anchor) are the worst case — test ~100KB.
- **Two-manager UX coupling:** shared speed/pause is a deliberate constraint (one live clock). Surface it in the UI so neither manager is surprised.
- **AI feedback loops:** rate-limit + queue-depth guard; AI shouts must not outrun the engine.
- **Engine orphaning:** on Node crash / last-subscriber-leave, the engine must detect a dead stdout (or a timeout) and exit cleanly — no zombie `live.exe` (cf. the live.exe-locks-the-binary hazard).
- **Replay regression coupling:** any change to `applyDirectives`/`applyLiveCommands` can break old format-2 replays — the golden determinism regression must include a format-2 sample.

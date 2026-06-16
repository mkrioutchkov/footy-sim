# Tactics — runtime flow & persistence (as-built)

How the plain-English tactics system **actually works at runtime** today: text →
directives, the live timeline, the engine mechanisms, and — importantly — **what
persists vs what's ephemeral**. Companion to [TACTICS.md](TACTICS.md) (the design +
directive vocabulary), [CONTRACT.md](CONTRACT.md) (the spec/frame contract), and
[SHOUTS_AND_PERSONALITY.md](SHOUTS_AND_PERSONALITY.md) (personality/morale). Verified
against the working tree 2026-06-16.

> **One thing the older docs got wrong:** the **live mid-match compiler is
> `web/backend/plan.ts` `compilePlanEdit`**, not `tactics.ts`. The single-shot
> `tactics.ts` `compileTactics` is now **test-only** (its only caller is
> `tools/_tactics_test.ts`); `tactics.ts` still owns the shared directive vocabulary
> (`VALID_KINDS`, `validate`) that `plan.ts` reuses.

## The flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MANAGER (browser) · web/frontend/app.ts                                        │
│  • standing PLAN box (plain-English, editable any time incl. mid-match)         │
│  • type a shout ── WS {type:'tactics', text} ──▶        ◀── {tacticsReceipt}   │
└───────────────┬───────────────────────────────────────────────▲───────────────┘
                │ /ws/match                                       │ "here's what
                ▼                                                 │  I heard"
┌────────────────────────────── web/backend ───────────────────────────────────┐
│ index.ts /ws/match:  recording w/ frames? ─ yes ─▶ ReplayStream                │
│                                                    (frames only · NO shouts)   │
│                         └─ no / live ─▶ MatchStream  (shouts allowed)          │
│                                                                                │
│ MatchStream.onCommand('tactics')                                              ┌┴┐
│   └▶ applyTacticsEdit ─▶ plan.ts compilePlanEdit() ─────────────────────────▶ │L│ Groq
│        STATEFUL DIFF: (current plan + shout + squad personalities             │L│ llama-3.3
│        + minute/score) ⇒ FULL new directive set, formation?, motivation[]     │M│ temp 0.4
│        • validate(): drop bad kinds · clamp · strip unjustified 'when'        │ │ JSON-only
│          · cap motivation 2/player                          ◀────────────────  └┬┘
│        • commitEdit ─▶ push {atMs,directives,morale,layout} → this.timeline    │ in-mem cache
│        • rewrite  <spec>.watch.json = {baseSpec, timeline}   (scratch disk)    │ (per-process)
│        • fromMs = clockMs ; re-spawn engine with --stream-from fromMs          │
│                                                                                │
│ EPHEMERAL (per watch session — gone on restart / socket close):               │
│   this.plan · this.timeline · motivationUsed · moraleEst · plan.ts cache       │
└───────────────┬───────────────────────────────────────────────▲───────────────┘
                │ spawn  live.exe --match <watch.json>            │ stdout: per-tick
                │        --no-debug --stream-from <fromMs>        │ EngineState frames
                ▼                                                 │ (0..fromMs suppressed)
┌────────────────────────── engine · build/live.exe ───────────────────────────┐
│ main.cpp  parseDirectives(spec.directives) + timeline → directiveTimeline      │
│           (sorted by atMs).  Engine NEVER calls the LLM.                        │
│                                                                                │
│ every 60 Hz tick → applyDirectives()  [engine_defense.cpp]:                    │
│   1. RESET per-tick directive state; restore homeX/homeY ← base anchors        │
│   2. advance timeline: while clock ≥ entry.atMs → swap active directives,      │
│        fire moraleDelta once, apply layout (re-anchor / re-role)               │
│   3. per active directive, if WHEN passes (fromMin/toMin + score-state):       │
│        ├─ Mech 1  per-player SCORE BIAS  → directiveBias[id]   (scorers read)  │
│        ├─ Mech 2  formation ANCHOR SHIFT → homeX / homeY       (shape slides)  │
│        └─ Mech 3  team-wide DIAL DELTA   → dialOverride[team]  (the 5 dials)   │
│             + 4 dedicated hooks: longBall · counter · offsideTrap · allOut     │
│                                                                                │
│ DETERMINISM: clock+score only, no rng → no-directive match byte-identical      │
│              (golden guard: tools/tactics_golden.py)                           │
└────────────────────────────────────────────────────────────────────────────────┘
```

## 1. Compile path — `plan.ts compilePlanEdit`

The live compiler is a **stateful composite-plan editor**, not a one-shot compile.
The LLM receives `(current plan + this shout + squad personalities + minute/score)`
and returns the **full new directive set after the edit** (amend-one / overhaul /
nuke / no-op), plus an optional `formation` and a `motivation[]` judgement.

- **Provider**: Groq `llama-3.3-70b-versatile`, OpenAI-compatible
  `POST /chat/completions`, **temp 0.4**, JSON-only, 15 s timeout, **one** retry on
  429/5xx (honouring `retry-after`). No other retry. **No offline rules parser** —
  failure ⇒ unchanged plan + an error note (`tactics.ts`'s old fuzzy fallback was
  removed because it mis-resolved names).
- **`validate()`** (in `tactics.ts`, reused by `plan.ts`) makes the output
  deterministic *given the LLM reply*: drops kinds not in `VALID_KINDS`, clamps
  `intensity` to 0..1, requires a valid `targetId` (opponent for `man_mark`,
  team-mate for `target_player`), and **strips any `when` condition the raw text
  doesn't justify** (TIME_WORDS/SCORE_WORDS regexes; `toMin>=90` → 1000).
- **Cache**: an in-process `Map` (no LRU/TTL, **lost on restart**) keyed by
  `planText | shout | motivationUsed | minute/score`. The rich key means the same
  shout re-compiles whenever the standing plan, motivation-cap state, or clock/score
  changes — so stateful edits stay deterministic on in-session replay but miss across
  plan evolution.
- **Directive shape**: `{playerId, teamScope?(0/1), kind, targetId?, intensity?, when?{fromMin,toMin,scoreState,scoreBy}}`.
  Vocabulary = **17 per-player + 12 team-wide** kinds (authoritative list in
  `tactics.ts` `VALID_KINDS` / `engine/main.cpp parseDirectives`, documented in
  [TACTICS.md](TACTICS.md)).

## 2. Shouts

There is **no separate "shouts" compiler** — every mid-match shout is an **edit to
the single standing composite plan** (`this.plan` on `MatchStream`).

- **Edit by intent**: amend one player · overhaul · **nuke** ("forget all that" →
  `directives:[]`) · **no-op** (pure motivation, directives echoed verbatim).
- **Motivation**: a shout can move a player's morale; *how it lands is judged from
  that player's personality dials* (criticismResponse / praiseResponse / ego /
  temperament). Returns `{playerId, moraleDelta(-30..30), reaction, durationMin}`.
  **Capped at 2 motivation hits/player/game** (`MOTIVATION_CAP`); tactical edits are
  uncapped.
- **Subs are NOT directives** — "sub him off" routes to `directives:[]` + a note.
  `onCommand` handles only `restart/pause/speed/tactics`; there's no sub-by-shout
  path wired today.
- **The receipt** (`{tacticsReceipt}` over the WS) shows formation, a "changed"
  line, per-player morale swings + the in-character reaction, the full standing
  directive list, and the note. A formation token (`4-3-3`) still applies via a
  regex fallback even if the LLM errored.

## 3. The live timeline & mid-match re-sim

A committed shout is pushed onto the in-memory `this.timeline` as
`{atMs, directives, morale, layout}`, the `<spec>.watch.json` scratch file is
rewritten as `{baseSpec, timeline}`, `fromMs` is set to the watched clock
(monotonic), and the engine is **re-spawned** with `--match <watch.json>
--stream-from <fromMs>`. Because the engine never calls the LLM and the prefix is
deterministic, frames `0..fromMs` are **byte-identical**, so the client resumes
seamlessly at the watched moment with the new tactics live.

## 4. Persistence — what survives a backend restart

| Layer | Where it lives | Survives restart? |
|---|---|---|
| Team's **5 dials** (`teams.tactics`), **formation** (`teams.formation`), **lineup** (`teams.lineup`) | DB `teams` table | ✅ yes |
| Match **recording** (gzipped NDJSON **frames only**) + metadata row | `recordings/*.ndjson.gz` + `match_recordings` | ✅ frames; **tactics NOT stored** |
| The composite **plan**, **shouts**, compiled **directives**, the **timeline**, `motivationUsed`, `moraleEst` | in-memory `MatchStream` only | ❌ no |
| `<spec>.watch.json` (baseSpec + timeline) | throwaway scratch file, rewritten per shout | ❌ regenerated per session |
| Compiled-directive **LLM cache** | in-process `Map` | ❌ rebuilt empty |

**Consequences (the important part):**

- There is **no `plan` / `tactics_timeline` / `shout` / `directive` table** in the
  schema. The whole plain-English layer is **session-local** — when the watch socket
  closes (or the backend restarts), **every shout is gone**.
- A **recorded human match stores only the resulting frames**, never the tactical
  inputs. So it can be **replayed as frames** (`ReplayStream`, which hides the
  tactics box) but **never re-simmed from its shouts** — you cannot reconstruct what
  tactics produced a given match.
- Only **human-stake** matches are recorded; AI-vs-AI uses the `--summary` path and
  keeps nothing. After a restart, a non-recorded match is re-simmed live **from the
  persisted standing tactics only** — any shouts are lost.
- **Determinism is session-local.** Within a live session a match = `seed + frozen
  timeline`, fully reproducible (the LLM's non-determinism is quarantined to
  compile-time + the per-process cache). Once the cache + timeline are gone, the exact
  shout-driven match is **not** reproducible (the cache isn't persisted, and re-calling
  Groq at temp 0.4 isn't bit-guaranteed — though `validate()` is deterministic given a
  fixed reply).

## 5. Engine execution (`applyDirectives`, every 60 Hz tick)

`main.cpp parseDirectives` maps each kind string to a `DirectiveKind` enum (unknown
kinds skipped) and parses the `timeline` into `directiveTimeline` (sorted by `atMs`).
Then each tick, `applyDirectives` (`engine_defense.cpp`):

1. **Resets** all per-tick directive state and restores every player's `homeX/homeY`
   from the kickoff base anchors.
2. **Advances the timeline**: while `clock ≥ entry.atMs`, swap the active `directives`,
   fire that entry's `moraleDelta` once, apply its `layout` (re-anchor + re-role via
   `reassignAgent`), `idx++` (each entry fires exactly once).
3. For each active directive whose **`when`** passes (`fromMin/toMin` window +
   `scoreState`/`scoreBy`, clock+score only, no rng), apply **one of three
   mechanisms**:
   - **Mech 1 — per-player score bias** → `directiveBias[id]`, read by the
     pass/shoot/dribble/press scorers.
   - **Mech 2 — formation-anchor shift** → relocate `homeX`/`homeY` so the whole
     shape slides coherently.
   - **Mech 3 — team-wide dial delta** → accumulate into `dialOverride[team]` on top
     of the base 5 dials, then `configFor` applies score-state nudges and clamps.
   - **+ 4 dedicated hooks** (kept off the dials so the default match is unchanged):
     `longBallBias`, `counterAttackBonus`, `offsideTrapActive`, `allOutActive`.

**Morale channel**: `Player.moraleBoost ∈ [-1,1]` shades sprint/effort by
`clamp(1 + boost*0.12, 0.88, 1.10)` and decays toward 0 over ~4 min; a timeline
`moraleDelta` adds a one-shot bump (then decays). It's the one directive effect that's
*stateful* (carried across ticks) rather than re-derived — but it's still a pure
clock-driven event, so replays match.

**Determinism / golden**: the engine never calls an LLM and sees only frozen
directives; everything is re-derived each tick (except the clock-driven morale bump).
`tools/tactics_golden.py` hashes the **no-directive** match across 7 seeds — it locks
the default path byte-for-byte, but does **not** regression-test that a given directive
produces a given effect.

## 6. Gaps & quirks (current)

- **Plan/timeline ephemerality** is the headline gap: a human match's shouts vanish on
  socket close; no re-sim-from-shouts or tactical replay is possible. Persisting the
  timeline (a column on `match_recordings` or a sibling table) is what you'd need.
- **`DirectiveBias.pushUp` is dead code** — `get_forward`/`sit_deep` moved to the
  anchor-shift mechanism; the bias channel is never assigned (contributes 0).
- **Formation-change timeline entries permanently overwrite the base anchors** — a
  mid-match shape change can't "lapse" back like a windowed directive.
- **Stale doc-comment**: `main.cpp`'s `when`-gate example mentions `minuteMod/minuteEq`,
  but only `fromMin/toMin/scoreState/scoreBy` are parsed (flagged to Boris).
- **Score-state auto-tactics** in `configFor` fire independently of any directive
  (always-on chasing/protecting nudges); a directive's `dialOverride` stacks on top
  before the same clamps.
- **The golden guard locks only the no-directive match** — no per-directive effect
  regression test exists.

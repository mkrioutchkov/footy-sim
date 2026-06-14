# Plain-English tactics

The differentiator: the manager controls the team by **typing**, not by dragging
sliders. A perpetual tactical-plan textbox (editable at any moment, including
mid-match) drives a real conditional instruction system the engine executes —
not decorators over the 5 dials.

See [ARCHITECTURE.md](ARCHITECTURE.md) for where every component plugs in.

## The model: a match is a script

A match is a pure function of:

```
match = f( seed , ordered [ (clock_time, instruction_text) ] )
```

The textbox at kickoff is the entry at `t=0`; editing it at 46' / 88' appends
`(46:00, text)` / `(88:00, text)`. That tuple *is* the match — it gives replays,
highlights, "what-if" branching, and shareable matches (a seed + a script of
shouts) for free.

## The two inputs

The manager has **two textareas**, not one:

- **The Plan** (persistent, editable any time) — the plain-English tactical plan
  *and* the ASCII lineup/formation, together. Every edit is a timestamped delta on
  the match timeline. This is the standing instruction set.
- **The Shouts** (consumed) — one-shot, in-the-moment orders, primarily
  **substitutions** ("take off Nesta, bring on Terry") but also momentary nudges.
  Submitting a shout applies it (at the next dead ball for subs) and clears the box.

## How text becomes behaviour

1. **Compile** (once, per shout): `text -> structured DSL`. **LLM-primary** — an
   OpenAI-compatible model (default **Groq `llama-3.3-70b`**, ~150-500ms) with
   constrained JSON output + both rosters + the manager's side in context handles
   arbitrary phrasing, slang, and typos. A deterministic **rules parser** is kept
   only as a silent offline fallback (no key / failure / timeout; one 429 retry
   first). The result is **cached by (roster + side + text)**, so the model runs
   once per unique order and replays are byte-identical (the engine never calls
   the LLM — it only ever sees the compiled, frozen directives on the timeline).
2. **Execute** (per tick, in the engine): the DSL is a set of conditional
   directives that hook into the engine's already score-based decisions — as a
   targeted score bias or a hard override — gated by player temperament.

### The DSL (sketch)

```jsonc
{ "directives": [
  { "player":"Nesta", "when":"minute % 2 == 1", "do":"man_mark", "target":"Messi",   "intensity":0.9 },
  { "player":"Nesta", "when":"minute % 2 == 0", "do":"man_mark", "target":"Ronaldo", "intensity":0.9 }
]}
```

- **Selectors**: a named player, an opponent by role ("their striker" => opp CF),
  role groups ("the midfield"), or the whole team ("we/us/all" => the manager's
  side, resolved from the watch session).
- **Conditions**: time windows (`fromMin`/`toMin` — "first half", "last 15",
  "after the 60th") and score state (winning/losing/drawing by N). Sequenced
  orders ("press high for 20 then drop off") split into two timed directives.
- **Directives** (~28 per-player + 10 team-wide, and growing). Each maps onto an
  existing engine knob (assignment / a per-player score bias / a formation-anchor
  shift / a per-team dial delta), gated behind a non-empty directive so the
  no-directive match is byte-identical:
  - *Marking / passing target*: `man_mark(target)`, `target_player(X)`.
  - *Shooting / on-ball*: `shoot_on_sight`, `cross_early`, `switch_play`,
    `play_simple`, `dribble_more`.
  - *Movement (formation-anchor shift)*: `get_forward`/`sit_deep` (homeX),
    `stay_wide`/`come_inside`/`stay_central` (homeY), `run_in_behind`/`make_runs`.
  - *Defending*: `press_hard`, `tackle_hard`, `stay_on_feet`.
  - *Team-wide (the 5 dials at runtime)*: `all_out_attack`, `park_the_bus`,
    `high_press`, `drop_off`, `play_it_long`, `keep_it_on_ground`, `get_it_wide`,
    `play_narrow`, `push_up`, `slow_it_down`.
- **Measured**: directive effects validated where a clean stat exists, e.g.
  `cross_early` +8% crosses, `shoot_on_sight` +88% shots, `tackle_hard` +62%
  bookings. `play_it_long` nudges directness but the engine has no strong
  ball-over-the-top mechanic, so the hoofball effect is limited (a long ball
  through traffic is correctly near-impossible).
- **Determinism guard**: `tools/tactics_golden.py check` hashes the no-directive
  match across 7 seeds; run it after every change to prove the default match
  hasn't drifted as the vocabulary grows.
- **Compliance** (P5, not yet built): each directive will be weighted by
  `intensity x f(discipline, morale, instruction-sanity)`; impossible orders
  ignored (+ morale hit). Today an unmappable order is simply dropped.

### ASCII lineups

```
messi ronaldo
zidane xavi busquets iniesta
bale chiellini nesta alves
    buffon
```
Parses bottom-to-top into GK -> defense -> mid -> attack bands, left-to-right
within a band, names fuzzy-matched to the squad. Illegal shapes (e.g. 5-5-2 = 12
players) coerce to the nearest legal one (4-4-2) and tell you.

### Subs = "shout to the officials"

A text shout ("take off Nesta, bring on Terry") compiles to a sub, is validated
(on the bench? subs left?), queues, and applies at the **next dead ball** — then
the shout is consumed. Invalid -> the official waves you off (feedback).

### Graceful degradation (the product rule)

Every input yields **something reasonable + a visible "here's what I heard"**
receipt. Impossible -> ignore (+ morale). Unknown name -> drop/ask. Out-of-grammar
-> nearest supported set, stated. The LLM reads arbitrary intent; the engine only
ever executes a **bounded palette** of effects, so it can't go off the rails.

## LLM details (built — `web/backend/tactics.ts`)

- **Provider-agnostic**: any **OpenAI-compatible** `/chat/completions` endpoint,
  configured by env vars in `web/backend/.env` (gitignored):
  ```
  TACTICS_LLM_API_KEY=...                              # required
  TACTICS_LLM_BASE_URL=https://api.groq.com/openai/v1  # default (Groq)
  TACTICS_LLM_MODEL=llama-3.3-70b-versatile            # default
  ```
  **Default is Groq** — free tier (30 req/min, no card), ~150-500ms, reliable.
  Swapping providers is a one-line `.env` change + a backend restart. (We started
  on Xiaomi MiMo but it timed out on 100% of calls — measured; the wiring is
  provider-agnostic so the swap was trivial.) Point `BASE_URL`/`MODEL` at a local
  **Ollama** (`http://localhost:11434/v1`) for fully offline.
- **Determinism**: cache-by-(roster + side + text) — the model runs once per
  unique instruction and the compiled directives are frozen on the timeline, so
  replays stay byte-identical *regardless of how the text was compiled* (the LLM's
  non-determinism never reaches the match).
- **Robustness**: 12s timeout; one retry on 429/5xx (honouring `retry-after`)
  before degrading to the offline rules parser. Quick mid-match bursts stay on
  the LLM path.
- **No-LLM baseline**: with no key (or the model unreachable) the rules parser
  alone still handles the common single-clause orders — a degraded but functional,
  fully-deterministic floor.

## Roadmap (risk-first)

| Phase | What | Where |
|---|---|---|
| **P1 ✅ done** | DSL + **engine interpreter**: 5 directives (man_mark, shoot_on_sight, get_forward, sit_deep, target_player) + minute/score conditions; engine reads a `directives` block in `spec.json` and executes it each tick. Proven from hand-written specs ("Nesta marks Messi on odd minutes"), deterministic, **no LLM**. | engine + CONTRACT |
| **P2 ✅ done** | **Live deltas + timeline**: a match is `seed + timeline` of timed directive sets (engine applies them at the recorded clocks — replays identically). A mid-watch `tactics` edit appends to the timeline at the watched clock and re-sims with `--stream-from`, resuming seamlessly (the prefix is byte-identical). Verified live: edit at 2533ms resumed there and engaged the mark. | engine + backend |
| **P3 ✅ done** | **Text -> DSL compiler** (`web/backend/tactics.ts`): provider-agnostic OpenAI-compatible call, strict-schema prompt + roster context, validate/coerce + cache. Wired into the watch socket ({type:'tactics', text} -> compile -> receipt -> timeline). Now **LLM-primary on Groq** with the rules parser as offline fallback + 429 retry. | backend |
| **P4 ✅ done** | **Web UX**: tactical-plan textbox in the watch view → sends text on the socket → shows an interpretation receipt of what was understood, match re-sims live. Verified in-browser. Panel scrolls (long receipts don't truncate). Follow-on: the consumed "Shouts" box for subs (needs the engine runtime sub-trigger). | frontend |
| **P4.5 ✅ done** | **Vocabulary expansion + provider**: ~28 per-player + 10 team-wide directives (movement, on-ball, defending, the 5 dials at runtime), opponent-by-role + whole-team ("we/us/all", manager-side plumbed end-to-end) + sequenced conditions. Swapped the flaky MiMo for Groq (LLM-primary). Golden regression guard locks the default match. Effects measured where a clean stat exists. | engine + backend + frontend |
| **P5** | **Morale / compliance**: `discipline` + `morale` attrs; compliance gating; instructions feed morale back. | engine + UI |
| **Ongoing** | More directive kinds (hold_up_play, waste_time, formation changes), a stronger ball-over-the-top mechanic so `play_it_long` bites, formation library, replays/sharing. | both |

P1 and P2 are valuable and fully deterministic on their own — you could
hand-write tactical scripts and they'd work — so the feature has a real spine
even before the LLM layer lands.

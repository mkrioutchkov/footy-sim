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

1. **Compile** (once, per shout): `text -> structured DSL`. A deterministic
   **rules parser** handles ASCII lineups + simple orders; **Claude Haiku** (with
   constrained JSON output + both rosters in context) handles the fuzzy/emotional
   rest. The result is **cached by text-hash**, so the LLM runs once and replays
   are byte-identical (the engine never calls the LLM).
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

- **Selectors**: a named player, a role ("all CBs"), or everyone.
- **Conditions**: minute / minute-parity / time bands / score state (winning/
  losing by N) / man up-or-down / ball zone / phase. (A tiny expression evaluator
  covers `minute % 2`.)
- **Directives** (v1, ~4, grows): `man_mark(target)`, `shoot_on_sight`,
  `get_forward`/`sit_deep`, `target_player(X)`. Each maps onto an existing engine
  knob (marking assignment, shoot score, positioning bias, pass-target bias).
- **Compliance**: each directive is applied with weight ~ `intensity x
  f(discipline, morale, instruction-sanity)` — a low-discipline player drifts off
  a weird order; impossible orders are ignored and dent morale ("Messi angry").

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
  TACTICS_LLM_API_KEY=...            # required
  TACTICS_LLM_BASE_URL=https://api.xiaomimimo.com/v1   # default (Xiaomi MiMo)
  TACTICS_LLM_MODEL=mimo-v2-flash                       # default (budget)
  ```
  Defaults to MiMo's budget model; point `BASE_URL`/`MODEL` at a local **Ollama**
  (`http://localhost:11434/v1`) for instant + free + reproducible, or any other
  provider. Cost on MiMo flash is ~420 tokens/edit (<<1c).
- **Determinism**: cache-by-(roster+text) — the model runs once per unique
  instruction and the result is frozen, so replays stay byte-identical.
- **Latency note**: mimo-v2-flash queues badly under load (~60s observed). For
  snappy live use, prefer local Ollama or add the rules-parser fast-path so
  common orders never hit the LLM.
- **No-LLM baseline**: the rules parser alone (ASCII grids + simple orders) is a
  shippable, fully-deterministic floor; the LLM is the upgrade for fuzzy text.

## Roadmap (risk-first)

| Phase | What | Where |
|---|---|---|
| **P1 ✅ done** | DSL + **engine interpreter**: 5 directives (man_mark, shoot_on_sight, get_forward, sit_deep, target_player) + minute/score conditions; engine reads a `directives` block in `spec.json` and executes it each tick. Proven from hand-written specs ("Nesta marks Messi on odd minutes"), deterministic, **no LLM**. | engine + CONTRACT |
| **P2 ✅ done** | **Live deltas + timeline**: a match is `seed + timeline` of timed directive sets (engine applies them at the recorded clocks — replays identically). A mid-watch `tactics` edit appends to the timeline at the watched clock and re-sims with `--stream-from`, resuming seamlessly (the prefix is byte-identical). Verified live: edit at 2533ms resumed there and engaged the mark. | engine + backend |
| **P3 ✅ done** | **Text -> DSL compiler** (`web/backend/tactics.ts`): provider-agnostic OpenAI-compatible call (default MiMo flash), strict-schema prompt + roster context, validate/coerce + cache-by-text. Wired into the watch socket ({type:'tactics', text} -> compile -> receipt -> timeline). Proven on MiMo flash. Follow-on: rules-parser fast-path for instant common orders. | backend |
| **P4** | **Web UX**: perpetual tactics textbox, interpretation receipt, shout-to-officials subs, pause-to-order live application. | frontend |
| **P5** | **Morale / compliance**: `discipline` + `morale` attrs; compliance gating; instructions feed morale back. | engine + UI |
| **Ongoing** | Grow the directive vocabulary, formation library, replays/sharing. | both |

P1 and P2 are valuable and fully deterministic on their own — you could
hand-write tactical scripts and they'd work — so the feature has a real spine
even before the LLM layer lands.

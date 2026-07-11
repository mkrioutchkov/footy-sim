# Plain-English tactics

The differentiator: the manager can control the team by **typing**. A perpetual
tactical-plan textbox (editable at any moment, including mid-match) drives a real
conditional instruction system the engine executes — not decorators over the 5
dials. For managers who prefer to point-and-click there is now *also* a
deterministic **structured tactics board** (sliders + formation picker + role
presets) as a second, no-LLM input surface — both surfaces compile to the same
directives (see [The structured tactics board](#the-structured-tactics-board)).

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

## The structured tactics board

Alongside the textbox there is a **deterministic, no-LLM** point-and-click board
(`web/frontend/app.ts`): a **formation picker**, per-player **role presets**
(wing-back, inside forward, false 9, ball-winner…), and team **sliders / segmented
controls** (mentality, pressing, line, passing directness, width, shot selection).
Each control maps onto a real directive `kind` from `tactics.ts` `VALID_KINDS`, so
the board and the plain-English plan are interchangeable — both write the same
`plan_directives`. It posts to `POST /api/team/plan-structured` (sanitised by
`sanitizeStructuredDirectives`) and `POST /api/lineup/set` (formation + XI); with no
opponent and no model call, a shape or role change is instant and byte-identical on
replay. `man_mark` is board-excluded (it needs a live opponent XI, so it stays a
mid-match shout).

## How text becomes behaviour

1. **Compile** (once, per shout): `text -> structured DSL`. **LLM-only** — an
   OpenAI-compatible model (default **Groq `llama-3.3-70b`**, ~150-500ms) with
   constrained JSON output + both rosters + the manager's side in context handles
   arbitrary phrasing, slang, and typos. There is **no offline rules parser** (it was
   removed); with no key or an unreachable model the compile returns **zero
   directives + an error note** (one 429 retry first), not a fallback parse. The
   result is **cached by (roster + side + text)**, so the model runs once per unique
   order and replays are byte-identical (the engine never calls the LLM — it only
   ever sees the compiled, frozen directives on the timeline).
2. **Execute** (per tick, in the engine): the DSL is a set of conditional
   directives that hook into the engine's already score-based decisions — as a
   targeted score bias or a hard override. (Per-directive compliance gating by
   temperament is still to build — see P5.)

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
  "after the 60th"), score state (winning/losing/drawing by N), and a possession
  **phase** (`in_possession`/`out_of_possession`/`transition`) — all gated by the
  engine, no rng. Sequenced orders ("press high for 20 then drop off") split into
  two timed directives.
- **Directives** (**25 per-player kinds + 17 team-wide** — the per-player vocab
  accepts 35 phrasings that alias onto the 25 engine kinds; the engine also parses
  4 set-piece-taker kinds, `fk_taker`/`corner_taker`/`pen_taker`/`long_throw_taker`,
  that are NOT in `VALID_KINDS`). Each maps onto an
  existing engine knob (assignment / a per-player score bias / a formation-anchor
  shift / a per-team dial delta), gated behind a non-empty directive so the
  no-directive match is byte-identical:
  - *Marking / passing target*: `man_mark(target)`, `target_player(X)`.
  - *Shooting / on-ball*: `shoot_on_sight`, `cross_early`, `switch_play`,
    `play_simple`, `dribble_more`, `cutback` (favour the pull-back to an arriving
    runner over an early cross).
  - *Movement (formation-anchor shift / off-ball runs)*: `get_forward`/`sit_deep`
    (homeX), `stay_wide`/`come_inside`/`stay_central` (homeY),
    `run_in_behind`/`make_runs`, `stay_back` (hold shape — damps the dynamic
    overlap/advance push, distinct from `sit_deep`'s static anchor shift).
  - *Defending*: `press_hard`, `tackle_hard`, `stay_on_feet`, `contain` (sit off
    and jockey instead of diving in — the opposite of `press_hard`).
  - *Team-wide (the 5 dials at runtime)*: `all_out_attack`, `park_the_bus`,
    `high_press`, `drop_off`, `play_it_long`, `keep_it_on_ground`, `get_it_wide`,
    `play_narrow`, `push_up`, `slow_it_down`, `counter_attack` (amplifies the
    quick-transition through-ball + run bonuses), `offside_trap` (holds a high
    line in the danger zone to spring late runners offside),
    `shoot_from_distance`/`work_it_into_box` (team shot-range bias) and the three
    gradated FM dials `press_intensity`/`mentality`/`line_height` (0-1, 0.5 =
    neutral).
- **Measured**: directive effects validated where a clean stat exists, e.g.
  `shoot_on_sight` +93% shots, `tackle_hard` +62% bookings. (`cross_early`'s old
  +8% was retracted as seed noise — it's now a volume-neutral timing nudge.)
  `play_it_long` now bites: it suppresses safe recycling so forward passes rise
  (~691→726).
- **Determinism guard**: `tools/tactics_golden.py check` hashes the no-directive
  match across 7 seeds; run it after every change to prove the default match
  hasn't drifted as the vocabulary grows.
- **Compliance** (still to build): each directive weighted by
  `intensity x f(temperament, morale)` so disliked/impossible orders are resisted.
  Today an unmappable order is simply dropped. (Squad morale + the instruction→morale
  feedback loop are **shipped** — see SHOUTS_AND_PERSONALITY.md.)

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

## LLM details (live compiler `web/backend/plan.ts`; vocabulary `web/backend/tactics.ts`)

> The **live mid-match compiler is `plan.ts` `compilePlanEdit`** — a *stateful*
> composite-plan editor (current plan + shout + squad personalities + minute/score →
> the full new directive set + formation + motivation). `tactics.ts` still owns the
> shared directive **vocabulary** (`VALID_KINDS`, `validate`) that `plan.ts` reuses;
> its single-shot `compileTactics` is now **test-only**. The provider / cache /
> robustness notes below apply to both. See [TACTICS_RUNTIME.md](TACTICS_RUNTIME.md)
> for the full runtime flow + persistence model.

- **Provider-agnostic**: two backends, chosen by `TACTICS_LLM_PROVIDER` in
  `web/backend/.env` (gitignored): **`http`** (default) — any **OpenAI-compatible**
  `/chat/completions` endpoint — or **`claude-code`**, which spawns the local Claude
  Code CLI in headless mode (runs on a Max subscription, no API billing):
  ```
  TACTICS_LLM_PROVIDER=http                            # or claude-code
  TACTICS_LLM_API_KEY=...                              # required (http)
  TACTICS_LLM_BASE_URL=https://api.groq.com/openai/v1  # default (Groq)
  TACTICS_LLM_MODEL=llama-3.3-70b-versatile            # default (http)
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
- **Robustness**: 12s timeout; one retry on 429/5xx (honouring `retry-after`).
  On failure the compile returns zero directives + an error note (no fallback
  parser). Quick mid-match bursts stay on the LLM path.
- **No-LLM behaviour**: there is no rules-parser fallback (removed). With no key or
  an unreachable model a compile returns zero directives + a visible error note; the
  match still runs the byte-identical default.

## Roadmap (risk-first)

| Phase | What | Where |
|---|---|---|
| **P1 ✅ done** | DSL + **engine interpreter**: 5 directives (man_mark, shoot_on_sight, get_forward, sit_deep, target_player) + minute/score conditions; engine reads a `directives` block in `spec.json` and executes it each tick. Proven from hand-written specs ("Nesta marks Messi on odd minutes"), deterministic, **no LLM**. | engine + CONTRACT |
| **P2 ✅ done** | **Live deltas + timeline**: a match is `seed + timeline` of timed directive sets (engine applies them at the recorded clocks — replays identically). A mid-watch `tactics` edit appends to the timeline at the watched clock and re-sims with `--stream-from`, resuming seamlessly (the prefix is byte-identical). Verified live: edit at 2533ms resumed there and engaged the mark. | engine + backend |
| **P3 ✅ done** | **Text -> DSL compiler**: provider-agnostic OpenAI-compatible call, strict-schema prompt + roster context, validate/coerce + cache. Wired into the watch socket ({type:'tactics', text} -> compile -> receipt -> timeline). **LLM-only on Groq** + 429 retry. (Live path is now `web/backend/plan.ts` `compilePlanEdit`, a stateful composite-plan editor; the original single-shot `tactics.ts` `compileTactics` is test-only.) | backend |
| **P4 ✅ done** | **Web UX**: tactical-plan textbox in the watch view → sends text on the socket → shows an interpretation receipt of what was understood, match re-sims live. Verified in-browser. Panel scrolls (long receipts don't truncate). Follow-on: the consumed "Shouts" box for subs (needs the engine runtime sub-trigger). | frontend |
| **P4.5 ✅ done** | **Vocabulary expansion + provider**: per-player + team-wide directives (movement, on-ball, defending, the 5 dials at runtime; the vocabulary has since grown to 25 per-player kinds / 35 phrasings + 17 team-wide), opponent-by-role + whole-team ("we/us/all", manager-side plumbed end-to-end) + sequenced conditions. Swapped the flaky MiMo for Groq (LLM-primary). Golden regression guard locks the default match. Effects measured where a clean stat exists. | engine + backend + frontend |
| **P5 ◑ partial** | **Morale SHIPPED** (squad morale shades effort/decisions; shouts move morale via personality — see SHOUTS_AND_PERSONALITY.md). **Still to build**: per-directive compliance gating by temperament. | engine + UI |
| **Ongoing** | More directive kinds (hold_up_play, waste_time, formation changes), a stronger ball-over-the-top mechanic so `play_it_long` bites, formation library, replays/sharing. | both |

P1 and P2 are valuable and fully deterministic on their own — you could
hand-write tactical scripts and they'd work — so the feature has a real spine
even before the LLM layer lands.

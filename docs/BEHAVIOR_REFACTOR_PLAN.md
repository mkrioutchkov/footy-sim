# Behaviour-by-position / behaviour-by-location refactor — plan

**Scope: `engine/` only.** No web/TS changes, no `spec.json`/summary/wire-format
changes (`docs/CONTRACT.md` stays frozen). Everything here is an *internal*
refactor.

**Goal (what "easier" means, concretely):** today, answering "what makes this
player behave the way he does?" means grepping ~150 sites in ~19 files. After
this work it should mean reading **two** places:

- **who he is** (position/role) → one role block, backed by one taxonomy header.
- **where he is** (pitch location) → one named-zone vocabulary, not a hand-picked
  `PITCH_H * 0.73`.

Secondary goal: more code reuse — kill the copy-pasted role logic and the
recomputed "am I forward / wide / in danger?" boilerplate.

---

## The finding: behaviour is keyed on two axes, and *both* axes are split

Player behaviour is a function of two things — **role** and **pitch location**.
Each axis currently has a good abstraction that is half-built or bypassed, plus a
scattered ad-hoc mechanism doing the same job. The two mechanisms don't know
about each other, so the knowledge is duplicated and drifts.

### Axis 1 — role/position: one clean mechanism, one scattered one, competing

| Mechanism | Where | Count | Verdict |
|---|---|---|---|
| Virtual "role hooks" on `PlayerAI` | `agent.h` decls + `role_ai.h`/`gk_ai.*` overrides | **67 virtuals** | Centralised, but 67 bare-number one-liners with no grouping/units; defaults (`agent.h`) live far from overrides (`role_ai.h`) |
| Inline `role == Role::X` branches | **19 files** | **145 sites** | Not centralised at all — role behaviour hardcoded where it's used, invisible to `role_ai.h` |

Worst offenders for inline role-branching:
`agent_pass_helpers.cpp` (32), `engine.cpp` (25), `agent_defend.cpp` (16),
`engine_defense.cpp` (15), `engine_defense_helpers.cpp` (14),
`engine_physics.cpp` (11), `agent.cpp` (11).

So "what makes a CF a CF" is really spread across **~150 sites in two competing
representations.** Example — `agent_pass_helpers.cpp` alone scores the *same*
role taxonomy three separate times with three sets of literals:

```cpp
if (t.role == Role::CF) sc += 0.30;                 // ~line 237
else if (t.role == Role::WM) sc += 0.10;
else if (t.role == Role::CM) sc -= 0.34;
...
bool targetWide = (t.role == Role::WM || t.role == Role::FB)   // ~line 296
                  && std::abs(t.y - PITCH_H / 2.0) > 125.0;
...
bool targetAttacker = t.role == Role::CF || t.role == Role::WM; // ~line 408
```

Many of these branches are really asking a **trait** — *is this an attacker? is
this wide? which channel?* `agent.h` already exposes some as hooks
(`isAttackerRole()`, `isWidePlayer()`, `isDefenderLike()`), but the 145 inline
sites can't use them: they operate on a bare `Player`/`Role`, not a `PlayerAI&`.
So the taxonomy gets re-spelled by hand every time.

### Axis 2 — pitch location: a dead abstraction + 71 hand-picked thresholds

- `PitchArea` (enum in `types.h`, computed in `agent.cpp::currentPitchArea()`) is
  **dead code** — zero callers outside its own definition. The "position-aware
  behaviour" vocabulary was built and abandoned.
- In its place: **71 ad-hoc `PITCH_W*0.xx` / `PITCH_H*0.yy` fractional
  thresholds** across 15 files. The fractions are nearly-identical hand-picks
  with no shared meaning — `0.72, 0.73, 0.74, 0.75, 0.76` all appear, each a
  separate literal that means roughly "wide-ish."
- The *derived* location vocabulary is recomputed inline everywhere too:
  `fd` (attack direction) — **43×** in 14 files; `wide` — **28×** in 10 files;
  `danger` — **24×** in 6 files; `ballAdvance` — **20×**; plus `depth`,
  `progress`, thirds. Every site rederives "how far up am I / am I wide / am I in
  danger" from scratch — and the constants **drift**:

```cpp
bool danger = std::abs(controller->x - ownGoalX) < 240.0;          // agent.cpp:855
bool danger = std::abs(carrier.x - ownGoalX) < DANGER_ZONE_DIST;   // engine_defense.cpp:416  (=330)
```

Same concept ("attacker is in a dangerous area"), two different numbers, invisible
to each other.

### Why this blocks the user's question

To reason about behaviour today you must hold in your head: 67 virtual defaults,
145 inline role checks, a dead `PitchArea`, 71 bespoke pitch fractions, and 4+
inline re-derivations of forward/wide/danger with drifting literals. There is no
single vocabulary for "position" or for "location," so there's nowhere to *look*.

---

## The enabling constraint (and the safety net)

Per `docs/ENGINE_AUDIT_2026-07.md` **Golden Rule**: *almost any behavioural
change reshuffles the RNG stream and shifts the goal rate.* That sounds like it
forbids refactoring — it's actually what makes this plan safe:

> A **pure refactor is byte-identical**, and the engine is deterministic
> (same seed + spec + binary ⇒ byte-identical summary). So the determinism
> harness (`npm run batch`, `npm run scenarios`, ≥30 seeds) is a *mechanical
> proof* that a refactor changed no behaviour.

This gives every step a hard, objective acceptance test. The one discipline that
keeps it honest:

> **Separate mechanical extraction from value unification.**
> Introducing `inDangerZone(p, team)` and routing `agent.cpp:855` through it must
> *keep passing `240.0`*, and `engine_defense.cpp:416` must *keep passing
> `DANGER_ZONE_DIST`.* That's a byte-identical extraction (safe, do freely).
> *Then* unifying those two literals to one value is a **balance change** — gated
> behind a ≥30-seed measurement, shipped (or not) on its own merits. The plan
> does extraction first; unification is an explicit, optional, measured phase.

The payoff: after extraction, the literal-drift that was invisible across 6 files
becomes a visible list of arguments to one function — so the *balance* questions
become answerable for the first time, even if we choose not to touch them.

---

## The design: two shared vocabularies

Two small, pure, header-only modules become the single source of truth for the
two axes. Both are keyed on plain data (`Role`, coordinates), so **every** call
site can use them — the `PlayerAI` agents, and the `Player`/`Role`-based physics,
defense, and pass code that can't reach a virtual hook.

### `role_traits.h` — the position taxonomy (keyed on `Role`)

Free functions over `Role`, the taxonomy that the 145 inline branches keep
re-spelling:

```cpp
constexpr bool  isAttacker(Role r);     // CF, WM  (and CM in the attacking sense where used)
constexpr bool  isDefender(Role r);     // CB, FB
constexpr bool  isWide(Role r);         // WM, FB
constexpr bool  isCentral(Role r);      // CB, CM, CF
constexpr Channel channelOf(Role r);    // Wide | Central
constexpr Line    lineOf(Role r);       // Back | Middle | Front
```

- The `PlayerAI` hooks (`isAttackerRole()`, `isWidePlayer()`, …) become
  one-liners delegating here — one definition of the taxonomy, reachable from both
  worlds.
- The 145 `role == Role::X` sites collapse to `isAttacker(p.role)` etc. **wherever
  the branch is exactly that set** (byte-identical). Sites that test a genuinely
  bespoke set stay explicit — this is a taxonomy, not a straitjacket.

### `pitch_zones.h` — the location vocabulary (keyed on coordinates)

What `PitchArea` was supposed to be, plus the derived scalars everyone recomputes.
Named bands replace the hand-picked fractions:

```cpp
double attackingProgress(const Player& p);      // 0 (own goal) → 1 (opp goal), fd-normalised
Third  thirdOf(double x, Team attackingTeam);   // Defensive | Middle | Final
Channel channelOfY(double y);                    // Left | Central | Right (named bands, not 0.73)
double lateralFromCenter(double y);              // |y - PITCH_H/2|, the thing behind 28 `wide` checks
bool   isWide(const Player& p);                  // one definition of "wide"
bool   inDangerZone(const Player& p, Team defendingTeam, double band = DANGER_ZONE_DIST);
double distToGoal(const Player& p), distToOwnGoal(const Player& p);
// fd(team), goalXFor, ownGoalXFor already exist in constants.h — re-exported/co-located here
```

- The 71 fractional thresholds route through `thirdOf` / `channelOfY` / named
  band constants — the fraction zoo (`0.72…0.76`) becomes a handful of named
  edges defined once.
- `fd` (43×), `wide` (28×), `danger` (24×), `ballAdvance` (20×) each get one
  definition; call sites pass their original literal during extraction so it's
  byte-identical, and the drift becomes a visible argument list.
- Either delete `PitchArea`/`currentPitchArea()` (dead) or re-home it here as the
  public zone lookup — decided in Phase 3, not left as zombie code.

### End-state option (bigger, optional): `RoleProfile` data table

The 67 scattered virtuals could become **one POD struct per role** — a
`RoleProfile` each role fills once, so "what makes a CF a CF" is a single struct
literal you read top-to-bottom instead of 67 one-line overrides interleaved with
defaults. This is the most direct answer to the user's question but the largest
change; it's proposed as a **direction**, gated on Phases 1–2 proving the
vocabulary out. Virtual dispatch stays for genuinely behavioural overrides
(`adjustActionScores`); only the bare-number knobs migrate to data. (Note: the
repo README lists "virtual dispatch for role-specific AI" as house style — this
option is a deviation to discuss, not a foregone conclusion.)

---

## Phased plan (each phase byte-identical unless flagged BALANCE)

**Phase 0 — Baseline + guardrail.** Capture `npm run batch` / `npm run scenarios`
output on a fixed seed set (≥30) as the golden reference. Confirm the Linux build
line from the audit (`g++ -std=c++20 -O2 -I third_party -o build/live
engine/*.cpp`) so verification runs without the Windows toolchain. Every
subsequent phase must reproduce this byte-for-byte.

**Phase 1 — `pitch_zones.h`, mechanical routing.** Add the header. Route the 71
thresholds + the `fd`/`wide`/`danger`/`ballAdvance` re-derivations through it,
**passing each site's existing literal.** Byte-identical. Biggest single
readability win for the "location" question; touches the most files, so land it
in small per-file commits each verified against Phase 0.

**Phase 2 — `role_traits.h`, fold the role branches.** Add the header;
`PlayerAI` hooks delegate to it. Convert the 145 `role == Role::X` sites to trait
calls where the set matches exactly. Byte-identical. Start with the dense files
(`agent_pass_helpers.cpp`, `engine_defense*.cpp`) for the biggest reuse gain.

**Phase 3 — Consolidate & de-dupe.** (a) Group + comment the 67 hooks in `agent.h`
by concern (shooting / passing / dribbling / defending / positioning / keeper),
co-locating each default with a one-line unit/meaning. (b) Extract the
**verbatim-duplicated role→AI factory** switch (`engine.cpp:1343` and
`engine.cpp:1618` are copy-paste identical) into one
`makeAgentFor(Player&, GameEngine&)`. (c) Resolve `PitchArea` — delete or re-home.
Byte-identical.

**Phase 4 — Value unification (BALANCE, optional, measured).** With the drift now
visible (e.g. the two `danger` bands 240 vs 330), decide per-cluster whether to
unify. Each unification is a balance change measured on ≥30 seeds per the Golden
Rule and shipped only if goal-neutral or deliberately tuned. **Not** part of the
pure-refactor deliverable — listed so the extraction work has a clear "and then
what" without being blocked by tuning debates.

**Phase 5 — `RoleProfile` (optional, design-first).** Only if Phases 1–2 prove
the vocabulary. Prototype on one role behind the byte-identical bar before
committing to all six.

---

## Other reuse wins spotted (grab-bag, engine-only)

- **Duplicated role→AI factory** (`engine.cpp:1343` ≡ `:1618`) — one function.
  (Folded into Phase 3.)
- **`danger` literal drift** — `240.0` (agent.cpp) vs `DANGER_ZONE_DIST=330`
  (defense) vs others; surfaced by Phase 1, resolved in Phase 4.
- **`agent_helpers.h` already models the good pattern** (`countPressure`,
  `countLaneBlockers`, press-slot helpers) — extend that style; the new headers
  are the same idea for role/location.
- **Grouping the 67 hooks** turns `agent.h`/`role_ai.h` into a readable per-role
  spec sheet even before any `RoleProfile` migration.

## Non-goals / risks

- **Not** a behaviour or balance change (Phases 1–3). If a "refactor" moves the
  goal rate, it wasn't pure — revert and redo.
- **Not** touching `web/` or the engine↔web contract.
- **Not** re-tuning the numbers (that's Phase 4, opt-in, measured).
- Risk: an over-eager trait fold that changes a branch's set (e.g. folding a
  CF-only check into `isAttacker` which also matches WM). Mitigation: the
  byte-identical harness catches it immediately; convert only exact-set matches.
- Risk: `constexpr`/header-only churn inflating compile times — keep the headers
  small and leaf-level.

## Acceptance criteria

1. `role_traits.h` + `pitch_zones.h` exist and are the single definition of the
   role taxonomy and pitch-zone vocabulary.
2. Inline `role == Role::X` sites and `PITCH_*` fractional thresholds materially
   reduced (target: the 145 + 71 down to the genuinely-bespoke remainder), each
   surviving site justified.
3. No dead `PitchArea`.
4. One role→AI factory, not two.
5. **Every** refactor commit reproduces the Phase-0 golden output byte-for-byte
   (`npm run batch` / `npm run scenarios`).
6. "What makes an X behave in area Y?" is answerable by reading `role_traits.h` +
   the role's block + `pitch_zones.h` — no cross-file grep hunt.

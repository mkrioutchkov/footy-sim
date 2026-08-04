# Tactics — engine follow-ups & a parked WIP MR (hand-off for the engine dev)

**Context.** The web layer now has a full structured **tactics board** (formation picker + team-instruction
sliders + per-player role presets), shipped on branch `feature/tactics-ui-sliders`. It is a thin, deterministic
front-end over the **existing** directive vocabulary — no engine change was needed for it. Every "FM position"
is modelled as a **preset bundle of (formation anchor + directives)** over the engine's 6 roles, because the
native sim knows only `GK, CB, FB, CM, WM, CF` (`engine/types.h:12`) and `roleFromStr` maps anything else to
`CF` (`engine/types.cpp:52`). Web `DM`/`AM` are slot labels that collapse to `CM` at the spec boundary
(`formations.ts:23`).

That covers most positions **faithfully today**:

| Position | Ships today via | Engine change? |
|---|---|---|
| Wing-back | FB slot (high anchor) + `overlap` + `get_forward` + `stay_wide` | none |
| Inside / wide forward | WM + `cut_inside` + `shoot_on_sight` + `come_inside` | none |
| Advanced playmaker (#10) | CM/AM slot (high) + `get_forward` + `drift_into_pocket` (real pocket behaviour) | none |
| Holding / deep-lying mid | CM/DM slot (deep) + `sit_deep` + `stay_back` | anchor-only* |
| Inverted full-back | FB + `come_inside` (+ `stay_back`) | approximate* |
| **Ball-playing CB** | `ball_playing` on a CB (steps out + carries + progresses from the back) | ✅ **SHIPPED** (PR #4) |

`*` The board labels these honestly ("tuck inside — approx.", "a CM anchored deep/high"). The three items
below are the engine work that would make them first-class. **Your call whether/when to land any of them** —
they touch the calibration-sensitive sim, so each needs a golden + A/B pass. **§0 and §1 below have since
SHIPPED** (role-weighted `overall()` = PR #3; ball-playing CB = PR #4); §2 (true DM/AM) and §3 (true
inverted full-back) remain — their sections stand as the implementation spec.

---

## 0. Role-weighted `overall()` — ✅ MERGED (PR #3)

Unrelated to the tactics board — found uncommitted in the working tree, packaged as its own MR, and since merged:

- **Branch / PR:** `feature/role-weighted-overall` → merged via **PR #3**.
- **What:** `overall(attrs, role?)` folds `handling` into the mean **for `role==='GK'` only**; every outfielder
  (and an omitted role) keeps the 7-attr mean, so non-keeper ratings/values stay **byte-identical**.
  `playerValue`/`playerWage` gain the same optional `role?`; all call sites (market, scout, shortlist, youth,
  training, contracts, ai, manager transfers, index, frontend) pass the player's role. Includes a one-time
  reconcile so existing GK potentials (derived from the old 7-attr OVR) are recomputed.
- **State:** typecheck-green. Based on its authored parent `c135be6`, so it **needs rebasing onto `master`**
  (the national-teams / world-scheduler drop) before merge — expect touch-ups in `game.ts` / `index.ts` /
  `training.ts` / `app.ts`. Web-only; no engine change. A backup stash also exists locally.

---

## 1. Ball-playing CB — ✅ SHIPPED (PR #4)

*Implemented as speced below:* the `ball_playing` (aliases `step_out`/`carry_out`) directive → `DK::BallPlaying`;
the CB steps out, carries from the back, and plays progressive passes. The UI preset is now enabled (no longer
disabled). Recipe kept below as the as-built reference.


**Why it's missing:** the CB profile actively suppresses carrying — `dribbleOwnHalfExtraPenalty`,
`canUseOpenLane=false`, `canUseWideDribble=false`, `roleBonusForPassTarget=0`, lowest `shotMaxDistance`
(`engine/role_profile.h:85-92`). The role-agnostic `dribble_more`/`switch_play`/`play_simple` biases don't give a
CB a progressive, line-breaking game. **No new Role needed** — one directive bias, following the existing
`cutInsideBias`/`overlapBias` pattern.

**Recipe (single directive kind + a bias flag):**
1. `engine/engine.h` — add `BallPlaying` to the `DirectiveKind` enum and a `bool ballPlaying` (or a scalar) to the
   `DirectiveBias` struct. (Symbol names, not line numbers — both moved when GameEngine's nested
   types were grouped; grep for them.)
2. `engine/main.cpp` — map the string `"ball_playing"` (aliases `"step_out"`, `"carry_out"`) → `DirectiveKind::BallPlaying`
   in `parseDirectives` (~66-144).
3. `engine/engine_defense.cpp` — in the per-player `applyDirectives` switch (~246-319) set the bias when the kind
   fires (respecting the same `when`/intensity plumbing as its neighbours).
4. Consumption: when the bias is set on a CB, (a) enable `canUseOpenLane` + raise the space-carry role bonus,
   (b) zero/reduce `dribbleOwnHalfExtraPenalty` so it can carry out of defence, (c) add a progressive /
   line-breaking pass-purpose reward (Build/Through/Switch). These read in `agent_shoot_dribble.cpp` /
   `agent_pass_helpers.cpp` / `role_profile.h`.
5. Web: add `'ball_playing'` to `PLAYER_KINDS` in `web/backend/tactics.ts` (VALID_KINDS), then **flip the UI**:
   in `web/frontend/app.ts` the CB preset `ballplaying` is currently `disabled:true` with a "needs engine update"
   label and `dirs: []` — set `dirs: [['ball_playing', 1]]` and drop `disabled`. (Add a `PLAYER_VERB` entry so the
   readback reads as English.)

**Risk:** low-moderate — it hands CBs a new on-ball option, so re-run the goal/pass balance. **Verify:**
`tools/tactics_golden.py` (no-directive match stays byte-identical) + a directive-effect A/B with `tools/ab.py`
(baseline vs a plan that sets `ball_playing` on both CBs) — expect more CB carries/progressive passes without a
goal blow-out.

## 2. True DM / AM behaviour — largest change

Today DM and AM are **positionally** real (deep/high `homeX` anchor) but **behaviourally** generic `CM`. A faithful
model needs new roles (a documented handoff already exists per `formations.ts:18`):
1. `engine/types.h` — add `DM`, `AM` to the `Role` enum; `engine/types.cpp` `roleFromStr` — parse `"DM"`/`"AM"`.
2. `engine/role_profile.h` — the tuning TABLE has `static_assert(size==6)` (~134); add one `RoleProfile` row each
   (it won't compile until you do). DM: deeper defensive-line task + screening + damped forward runs; AM: default
   pocket / between-lines + higher through-ball / shot reward.
3. `engine/role_traits.h` — fold DM/AM into the `isAttacker`/`isDefenderLike`/… predicates.
4. Optional `role_ai` subclass only where the logic genuinely differs from CM.
5. Web: **remove the `DM/AM → CM` collapse** in `engineRole()` (`formations.ts:23`); the board already surfaces
   DM/AM slots and MID presets, so no UI change beyond that.

**Risk:** high — new roles touch positioning, pressing, and pass/shot rewards league-wide. Full golden + a broad
A/B (32+ seeds) and a re-benchmark against `docs/STATSBOMB_DATA.md` targets. Until it lands, the board's honest
"a CM anchored deep/high" labelling is correct.

## 3. True inverted full-back (step into midfield)

Today `inverted` = `come_inside` + `stay_back` = a lateral tuck, **not** an FB stepping up into the DM line in
possession. Minimal faithful version, **no new Role** — build on the existing `directiveBias` + `CondPhase`
machinery (`DirectiveBias` + `CondPhase` in `engine.h`): a dedicated `invert` bias that, **in possession** (`CondPhase::InPossession`), shifts
the FB's anchor into the pivot (homeX up toward the DM line + homeY toward centre) and lets it act as a midfield
outlet, reverting wide/deep out of possession. Wire it like §1 (kind + bias + phase-gated consumption in
`agent_positioning.cpp`). **Risk:** moderate. Golden + A/B as above. Until then the board labels it "approx.".

---

### How the web board plugs in once any of these land
The board is a thin front-end over `VALID_KINDS`. For §1/§3 you only add the kind to `tactics.ts` and flip the
preset's `dirs`/`disabled` in `app.ts ROLE_PRESETS`. For §2 you drop the `engineRole()` collapse. The new
deterministic endpoint `POST /api/team/plan-structured` + the sanitizer already accept any `VALID_KINDS` directive,
so no plumbing changes.

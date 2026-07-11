# Training & Coaches — Unified Design Spec

**Owner:** Gaylord (game layer — `web/backend` + frontend SPA).
**Engine contact surface:** none new for MVP/Phase 2; one optional, omittable `startStamina` field in Phase 3 (SysArch/Boris own only that ~10-line `loadTeam` read).
**Doc home:** `docs/TRAINING_COACHES_SPEC.md`

---

## 1. Overview & the player-facing fantasy

footy-sim already *develops* players — every matchday `developmentTick()` drifts each player's attributes toward their potential. But the player never **feels** like a coach. There is one club-wide focus dropdown, an aggregate "+X% training" number from anonymous staff, and a report card of deltas. The decisions are thin and the causal chain is invisible.

The fantasy we are building: **"I shaped this player."** The manager should be able to look at a 19-year-old, decide *he becomes my next striker*, put him on a shooting focus under a 5-star attacking coach at heavy intensity, watch his shooting climb week over week, see the report card narrate *why*, and two seasons later put a player on the pitch who is measurably better **because of choices the manager made**. Conversely, over-train a thin, old squad and watch the injuries pile up. Hire a great attacking coach and the strikers sharpen faster than the defenders.

Training is meaningful when three loops close:
1. **Coaches matter** — a specialist coach in the right category visibly accelerates the right attributes (not one flat club number).
2. **Choices trade off** — focus, intensity, and game-time are levers with costs (fatigue, injury, an attribute you *didn't* train).
3. **It reaches the pitch** — developed attributes flow into the match engine and change results, deterministically, so a recording/replay/golden match is never disturbed.

Everything below extends the existing deterministic tick. **Nothing is rebuilt.**

---

## 2. Current-state gaps (what the code does vs doesn't today)

**`training.ts` does today** (`web/backend/training.ts`):
- `developAttrs(attrs, age, potential, traits, focus, morale=65, coachFactor=1, harmonyF=1, role?, growthMul=1, loadDampenF=1, retrainPenaltyF=1)` — drift = `ageDrift(age) × diligence × moraleDevFactor(morale)`; on **positive drift only** it is multiplied by `growthMul × coachFactor × harmonyF × loadDampenF × retrainPenaltyF`; capped by headroom to `potential`; focus attribute gets `1.8×`; `'position'` focus spreads the bonus across `ROLE_KEY`. Clamp `[30,95]`, rounded to 0.1. **[SHIPPED — the `growthMul`/`loadDampenF`/`retrainPenaltyF` multipliers landed with the Coaches feature; all default to 1, so the pre-feature drift stays byte-identical. There is NO `minutesFactor` parameter.]**
- `developmentTick(leagueId)` — one pass per matchday over every player in the league; caches `coachingFactor`/harmony per team; writes `players.attrs`; records a latest-only `training_reports` row per **human** club.
- `explainTraining` / `trainingFactors` — plain-English "why" lines.
- `ageDrift(age)` — hardcoded bands 20/23/27/30/33 → `+1.5 / +1.0 / +0.5 / 0 / −0.6 / −1.2`.

**`staff.ts` does today** (`web/backend/staff.ts`):
- One per-world hire pool, roles `coach|physio|scout`, single `rating` 45–88, one-off `cost` from `teams.budget`, max 8 staff/club.
- `coachingFactor(teamId) = 1 + min(0.30, strength*0.10)` — **one flat club-wide number**, applied identically to every player and every attribute.
- `physioEffect` (injury mult + recover bonus), `scoutDepth`.

**The gaps that block the fantasy** (the original design brief; **most are now closed by the SHIPPED MVP + Phase 2 — see §8** — retained here for context):
- **Coaches are homogeneous & flat.** No specialty, no per-category quality, no assignment, no workload. A striker's shooting and a CB's tackling get the exact same boost.
- **No intensity / load.** Training is always full-tilt; no fatigue or injury trade-off, no rest weeks, no taper.
- **No per-player programme beyond a focus key.** No trait learning, no position retraining/settling-in cost, no game-time gate (a benched kid develops as fast as a starter).
- **AI clubs are silently under-coached** — `aiManagerTick` sets focus + lineup but never touches staff; AI training is unrecorded.
- **No youth pipeline tie-in to coaching.** `season.ts:youthAndRetirement` brings prospects through at rollover, but there is no facility lever, no hidden-potential intake report, no tutoring, and coaching never touches them as academy players.
- **The causal chain is invisible.** "+12%" with no name, no category, no "your striker is on a heavy attacking block under John Smith."

---

## 3. The model loop

The spine is unchanged: **one deterministic pass per matchday**, writing `players.attrs`. The new levers all feed `developAttrs`'s drift before the headroom clamp.

```
  COACHES (roles + 7 attrs)                TEAM SCHEDULE                INDIVIDUAL
  ┌───────────────────────┐        ┌──────────────────────────┐   ┌──────────────────┐
  │ staff.specialty +     │        │ teams.training_intensity  │   │ players.train_   │
  │ staff.attrs{atk,def,  │        │  (light|normal|heavy)     │   │   focus (exists) │
  │  tec,tac,fit,gk,yth}  │        │ teams.training_mix (JSON  │   │ players.train_   │
  │ teams.coach_assignment│        │  category weights, opt.)  │   │   intensity      │
  └──────────┬────────────┘        └────────────┬─────────────┘   │ players.train_   │
             │                                  │                 │   trait/_prog     │
             │ categoryCoachFactor(team,cat)    │ intensityFactor  │ players.retrain_ │
             │  per-category [0.90,1.30]        │  growth/fatigue/ │   role/_familiar │
             │  fallback → legacy coachingFactor│  injury triple   └────────┬─────────┘
             └──────────────┬───────────────────┴───────────────────────────┘
                            ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  developmentTick(leagueId)   ── ONE pass / matchday / league ──    │
        │  per player, resolve PRIMARY category from (focus | role-weights), │
        │  look up categoryCoachFactor, intensityFactor, minutesFactor,     │
        │  loadDampen → call developAttrs(...) → seededGrowth jitter         │
        │  → advanceTrait / advanceFamiliarity → UPDATE players SET attrs    │
        └──────────────────────────────┬───────────────────────────────────┘
                                       ▼
                    players.attrs (JSON)  ── unchanged shape ──
                                       ▼
   specForTeam → buildTieSpec → spec.json → engine loadTeam → PlayerAttributes
                                       ▼
              attrFactor = attr/100  → shot range, pass %, tackle win, pace …
```

**Reading order each tick (per player):**
1. Resolve effective **focus** (`players.train_focus ?? teams.training_focus`).
2. Resolve the player's **primary training category** (from the focus, or from `ROLE_KEY` if `balanced`/`position`).
3. **Coach quality** for that category → `categoryCoachFactor(team, cat)` (falls back to today's flat `coachingFactor` when the category is unassigned — this is the golden-safe identity path).
4. **Intensity** (`players.train_intensity ?? teams.training_intensity`) → `{growthMul, injuryMul, loadAdd}`.
5. **Minutes→ROI** — **NOT SHIPPED (roadmap).** `developAttrs` has no `minutesFactor`; game-time is not yet a development lever.
6. **Load dampen** (Phase 2) — **SHIPPED.** `loadDampen(training_load)` trims this tick's gain once accumulated load passes ~40.
7. Call `developAttrs(... growthMul, coachFactor, loadDampenF, retrainPenaltyF)` (the real shipped signature — no `minutesFactor`), clamp, write back.
8. Advance any **familiarity** bar — **SHIPPED** (retrain settles inline in `developmentTick`). **Trait** learning is **NOT SHIPPED**: the `train_trait`/`train_trait_prog` columns exist but no code advances them into `personality.traits`.

**Determinism guarantee:** every "random" growth quantum comes from `seededGrowth(playerId, season, round, worldId)` — a stable hash (FNV-1a/xorshift on the tuple), **never raw `Math.random()`**. The tick is a pure function of DB state, so recordings, replays, and the golden match stay byte-stable. Default state (no specialty, normal intensity, unassigned coaches) reproduces today's numbers **byte-identical** — verify with `tools/_training_test.ts` + `tools/tactics_golden.py`.

---

## 4. Data model (ADD / EXTEND — lean on existing `db.ts` migration pattern)

All additions use the existing `ensureColumn(table, col, ddl)` lazy migration (each default reproduces current behaviour). New tables use `CREATE TABLE IF NOT EXISTS`.

### Phase 1 — Coaches + meaningful per-player training

**`staff` table (EXTEND):**
| Column | DDL | Notes |
|---|---|---|
| `specialty` | `specialty TEXT` | `assistant_manager\|first_team_coach\|fitness_coach\|gk_coach\|set_piece_coach\|youth_coach`; NULL for physio/scout and legacy coaches (lazily inferred = `first_team_coach`). |
| `attrs` | `attrs TEXT` | JSON `{attacking,defending,technical,tactical,fitness,gk,youth}` 0..100. NULL → lazy-backfill all keys = legacy `rating` (byte-safe, no migration storm). |

**`teams` table (EXTEND):**
| Column | DDL | Notes |
|---|---|---|
| `coach_assignment` | `coach_assignment TEXT` | JSON `{category -> [staffId]}`. NULL = auto-assign-by-specialty (reproduces today's aggregate). |
| `coaching_style` | `coaching_style TEXT NOT NULL DEFAULT 'balanced'` | AI preset preference (`developer\|balanced\|conservation`). Unblocks the existing `ai.ts` EXTEND ask. |

**`players` table (EXTEND):**
| Column | DDL | Notes |
|---|---|---|
| `train_intensity` | `train_intensity TEXT` | `double\|normal\|half\|rest`; NULL = normal / club default. |
| `train_trait` | `train_trait TEXT` | PPM/trait being learned (e.g. `shoots_from_distance`); NULL = none. |
| `train_trait_prog` | `train_trait_prog REAL NOT NULL DEFAULT 0` | 0..100; at 100 → merge into `personality.traits`, clear both columns. |

**`training_reports` (EXTEND):** add `intensity TEXT` and `category_factors TEXT` (JSON `{category -> {stars, coverage, factor, load, capacity}}`) — snapshot, mirrors the existing `team_focus`/`coach_factor` pattern. `TrainLine` (the JSON blob, no migration) gains optional `{intensity, category, categoryStars, coverage, trait?, traitProg?}`.

> **Categories are code-side**, not a table: `const CATEGORY_ATTRS` in `training.ts`. Six categories mapped onto the 7 trainable attrs so engine flow is untouched:
> `Attacking={shooting,creativity}`, `Possession={passing,creativity}`, `Defending={tackling,positioning}`, `Fitness={speed,stamina}`, `Goalkeeping={handling}` (keeper-only, opt-in), `SetPieces` (non-attr, gated OFF for MVP). Each trainable attr has exactly one **primary** category for the coach-factor lookup.

### Phase 2 — Schedule, intensity-as-team-dial, retraining, minutes

**`teams` table (EXTEND):**
| Column | DDL | Notes |
|---|---|---|
| `training_intensity` | `training_intensity TEXT NOT NULL DEFAULT 'normal'` | `light\|normal\|heavy`. `normal`/legacy ⇒ byte-identical drift. |
| `training_mix` | `training_mix TEXT` | JSON normalized weights `{physical,tactical,attacking,defending,setpieces,recovery}`. NULL = derive from `training_focus`. |

**`players` table (EXTEND):**
| Column | DDL | Notes |
|---|---|---|
| `minutes_recent` | `minutes_recent INTEGER NOT NULL DEFAULT 0` | Rolling minutes over last N fixtures → `minutesFactor`. |
| `training_load` | `training_load REAL NOT NULL DEFAULT 0` | Burnout accumulator; decayed each tick. |
| `current_form` | `current_form INTEGER NOT NULL DEFAULT 0` | −10..+10 from last match; short-term ROI + `moraleBoost` shade. |
| `retrain_role` | `retrain_role TEXT` | Target role being retrained into; NULL = settled. |
| `role_familiarity` | `role_familiarity REAL NOT NULL DEFAULT 100` | 0..100 with current role; new signings/retrainees start low. |
| `sharpness` | `sharpness INTEGER NOT NULL DEFAULT 100` | Optional short-term form stat (depth lever; defer if MVP-thin). |
| `recovery_until` | `recovery_until INTEGER` | Rehab gate; `fitness.ts` sets it when `injured_matches` set. |

### Phase 3 — Youth + facilities + tutoring

**`players` table (EXTEND):** `is_youth INTEGER NOT NULL DEFAULT 0`, `intake_season INTEGER`, `mentor_id INTEGER` (FK players.id), `mentor_until INTEGER`.
**`teams` table (EXTEND):** `facility_training INTEGER NOT NULL DEFAULT 2`, `facility_youth INTEGER NOT NULL DEFAULT 2`, `facility_recruitment INTEGER NOT NULL DEFAULT 2` (tiers 1–5; default 2 = neutral midpoint, current behaviour unchanged).
**`staff`:** allow `youth_coach` role string (no schema change beyond the new specialty value); `seedStaffPool` mixes it in.
**NEW `youth_intake_reports` table** (mirrors `training_reports`): `id, team_id, season, recruitment_tier, youth_coach_factor, lines TEXT (JSON), created_at`. Latest-only per club.
**`finances` ledger:** add line kinds `facility_capex` (one-off) and `facility_upkeep` (recurring per-season) via the existing `recordFinance` path.

> **Deferred to "depth" (no MVP/Phase commitment):** `training_plans` (multi-year roadmap), `training_drills` (weekly audit), `staff.salary`/`contract_years` (recurring wages), `staff_stats` career JSON. All additive when wanted.

---

## 5. Backend logic + the precise tick hook

### Where development runs (unchanged hook)
`/api/advance` → per league: `fitnessTick` → `moraleTick` → `marketTick` → FA/contract offers → `aiManagerTick` → **`developmentTick(l.id)`** (`index.ts:1322`). Once per matchday. Season-level work (intake, facilities upkeep) would run in **`season.ts:rolloverSeason`** (`season.ts:95`) alongside the existing `youthAndRetirement` (defined in `youth.ts:61`, called at `season.ts:199`).

### New/extended functions

**`staff.ts`:**
- `coachAttrs(staff)` → parse/lazy-backfill the 7-key block from `attrs` or from legacy `rating`.
- `categoryStars(team, category)` → weighted mean of assigned coaches' category-relevant attrs × coverageMult → **0.5..5.0**. `assistant_manager` counts at 0.6 weight; off-role `first_team_coach` at 1.0.
- `categoryCoverage(team, category)` → LOAD = players routed to the category (by focus or `ROLE_KEY`); CAPACITY = effective coach slots (1.0 to specialty, 0.5 to a secondary; spreading thin is self-punishing). `coverageMult = clamp(capacity / max(1, load/IDEAL_PER_COACH), 0.55, 1.0)`, `IDEAL_PER_COACH ≈ 8`.
- **`categoryCoachFactor(team, category)`** → `1 + (stars − 2.5)/2.5 * 0.30` clamped `[0.90, 1.30]` (2.5★ neutral, 5★ ≈ +30%, thin coverage can now *mildly penalise* −10% — which the old flat factor never could). **Unassigned category → fall back to legacy `coachingFactor(team)`.** This is the function `developmentTick` calls instead of the flat factor.
- `autoAssignCoaches(team)` — default specialty-based assignment when `coach_assignment` is NULL (keeps un-managed clubs identical to today).
- `hireStaff` (EXTEND) — set `specialty` + `attrs` on hire; auto-assign into the thinnest category.

**`training.ts`:**
- `developAttrs` — **EXTENDED signature (SHIPPED):** `growthMul` (intensity), per-category `coachFactor` (caller passes `categoryCoachFactor`, not the flat one), `loadDampenF` (burnout), `retrainPenaltyF` (unsettled role). Shipped drift, on **positive drift only**, = `ageDrift(age) × diligence × moraleDevFactor × growthMul × coachFactor × harmonyF × loadDampenF × retrainPenaltyF` (mirrors today's growth-only rule). **`minutesFactor` was designed but is NOT shipped** — there is no game-time term in the signature. Decline path unchanged except (Phase 3, unbuilt) a `fitness_coach` would soften physical fade. Keeps the `[30,95]` clamp + headroom cap.
- `intensityFactor(level)` → `{growthMul, injuryMul, loadAdd}`: `double→{1.4, +injury, +load}`, `normal→{1.0,…}`, `half→{0.6,…}`, `rest→{0.0, recovery, −load}`. (Team-dial variant: `light 0.7 / normal 1.0 / heavy 1.4`.)
- `focusBonus(role, attr)` — keep the `1.8×` default but scale by a small `(role,attr)` affinity so an against-type focus (CB training shooting) grows ~1.3× not 1.8×.
- `seededGrowth(playerId, season, round, worldId)` → deterministic `[0,1)` hash. **Document next to the FOOTY_DB golden notes — this is the determinism guarantee.**
- `advanceTrait(player, coachF, matchesDirective)` (Phase 2) — per tick add `base × coachF × matchingDirectiveBonus × relevantAttrFactor`; at ≥100 write the trait into `personality.traits`, clear columns, emit a "learned" factor line + news hook.
- `advanceFamiliarity(player)` (Phase 2) — climb `role_familiarity` via `roleAdaptation(oldRole, newRole)` speed; at threshold clear `retrain_role`, commit the role.
- `resolvePreset(name)` / `applyTaper(mix, isPreFixture, importance)` (Phase 2) — pure helpers, unit-testable.
- `developmentTick` — cache per-category coach factors + intensity + style per team once; per player read the new columns, compute the factors, call `developAttrs`, then `advanceTrait`/`advanceFamiliarity`. **Still ONE pass; still writes the same `attrs` column.** Snapshot intensity/category factors into `training_reports`.
- `trainingFactors` / `explainTraining` — append lines: `Coaching: Attacking ★★★★☆ (+24%)` / `over-stretched (−6%)`, `Double intensity (+40% gains, fatigue risk)`, `Learning: shoots from distance (62%)`, `Settling into CB (familiarity 70%)`, `Limited minutes (−)`.

**`fitness.ts`:** `startInjuryRisk` × `intensityFactor.injuryMul` + a `training_load` term; `fitnessTick` bleeds `training_load` on rest, gates `recoverBonus` by `recovery_until`, applies the `loadAdd` accrual. (Recovering players auto-shift to a recovery session — zero attribute drift, accelerated condition.)

**`ai.ts`:** `pickTrainingFocus` reads `teams.coaching_style` (struct philosophy) instead of the single greedy rule; new `aiManagerStaff(team)` (Phase 2): if a category's stars `<` league-median−1 and budget allows, hire+assign the best-value pool coach. AI defaults to **normal intensity, no trait/retrain** so existing matches + golden stay byte-stable unless opted in.

**`season.ts` / `game.ts` (Phase 3):** `generateIntake(team, recruitmentTier, youthCoachFactor)` reusing `genAttrs(role, lowBase~45)` + `genPotential` boosted by tier; called from `rolloverSeason` for every club (fold into the existing `youthAndRetirement` loop). `facilities.ts:upgradeFacility/facilityUpkeep` via `recordFinance`. `tutoring.ts:assignMentor/tickTutoring` drifts mentee personality toward the mentor.

---

## 6. Frontend screens (`web/frontend/app.ts`)

### Training schedule view — `screenTraining()` (extend the existing screen at app.ts:2943)
- **Phase 1:** per-player row keeps the FOCUS dropdown; **add an INTENSITY segmented control** (Double · Normal · Half · Rest) with a one-line trade-off hint, and a **"learn a trait"** picker with a progress bar when active. The category **★ stars** for the active focus shown inline (`Shooting focus → Attacking ★★★★☆, full coverage, +24% growth`). Report card lines render the per-player programme (intensity badge, trait %, category star, coverage).
- **Phase 2:** a **preset button row** (Balanced / Fitness / Attacking / Defending / Tactical / Recovery) writing intensity+mix in one click; an optional collapsed 6-category mix control behind "Customize"; a per-player **retrain** affordance (role picker + familiarity bar + "unsettled — match penalty" warning); a squad load-at-a-glance count of players on Double/Rest (reuses `rotation.ts` fitness bands); "Tapering for next fixture" / "Managed recovery" badges.

### Coaches hire/assign view — `screenStaff()` (extend at app.ts:3944)
- Per-coach **specialty badge** + 7-attribute mini-bar.
- A **CATEGORY BOARD**: 6 rows (Attacking/Possession/Defending/Fitness/Goalkeeping/SetPieces) each showing ★ stars, a green/amber/red **coverage bar**, assigned-coach chips, and `load: N players / capacity: M slots`.
- **Assign** dropdown per category; amber-warn when a coach is spread over >2 categories; live star delta.
- Hire-pool cards show specialty + the attribute block + one-off fee; a *"recommended: you have no Defending coach"* nudge.

### Per-player Development view (new tab on the player detail panel)
- **Age-vs-potential bar** (current OVR → ceiling), current-form indicator, recent-minutes sparkline (Phase 2), and "projected drift this tick."
- Editable: this player's focus override, intensity override, trait-to-learn, retrain target. Read-only: which coach/category is driving them, the settling-in countdown, the rehab gate. **Makes the invisible model visible** (FM's player-development screen, right-sized).

### Youth Academy view (Phase 3) — new `screenYouthAcademy()`
- Three facility tiers as 1–5 star bars + Upgrade buttons (CapEx, projected dev-rate delta, affordability gate).
- **Intake preview card** on intake day: name/age/role/OVR + fogged star-rated potential band (fog tightens with youth-scout/coach quality) + a one-line scout note.
- Prospect list with sortable potential stars + a **Promote to first team** button (gated on the readiness threshold). Tutoring pair-up panel (pick youngster + senior mentor, shows compatibility + projected effect).

---

## 7. Engine touchpoint (small + golden-safe)

**MVP & Phase 2: zero engine change.** Coaching/intensity/focus only change *which attributes grow* in the per-matchday `developmentTick`. Those attributes are written to `players.attrs` exactly as today, serialized by `specForTeam → buildTieSpec` into `spec.json`, and parsed by `engine/main.cpp:loadTeam` into `PlayerAttributes` (`attrFactor = attr/100`). Better coaching simply shows up as higher attrs over seasons — it reaches the pitch through the **existing** attr→spec→loadTeam pipeline. Trait completion writes into `personality.traits`, which already flows into `spec.players[].personality` where the engine's existing directive/PPM primitives bias decisions — **no new engine code** for traits that map to existing primitives.

Short-term shades (current_form, role-settling, sharpness) ride the **existing `moraleBoost` seam** in `specForTeam` → `engine Player.moraleBoost` (`types.h:209`) — the engine stays attribute-only, no new field.

**Phase 3 (optional, the only engine ask):** `match.ts:specForTeam` may emit an optional `players[i].startStamina` derived from `fitness`/`recovery_until`, and `engine/main.cpp:loadTeam` reads it **defaulting to current behaviour when omitted** (golden-safe by omission, exactly like `weather: 'clear'`). This is the sole SysArch/Boris-owned touchpoint and is deferred, not required.

**Determinism guardrail for the engine/golden lane:** all development jitter is computed in TS via `seededGrowth` **before** the spec is built. The engine stays a pure function of the spec; recordings/replays and the golden match are unaffected — verify with the existing field-diff-excluding-`version` method.

---

## 8. PHASED plan

Each phase ships independently, leaves the default save **byte-identical**, and is gated by: `npm run typecheck` (BOTH `tsconfig` configs — the backend route is only covered by `tsconfig.backend.json`) **and** a deterministic season-tick test.

### MVP — "training is meaningful": coach-influenced focus that actually grows attributes — **[SHIPPED]**
**The smallest slice that makes a manager feel like a coach.** No new tables beyond columns.

**Ships:**
1. `staff.specialty` + `staff.attrs` (lazy-backfilled from `rating`) + `teams.coach_assignment`.
2. `CATEGORY_ATTRS` map + `categoryCoverage` + `categoryStars` + `categoryCoachFactor` over the 4 attr-backed categories (Attacking/Possession/Defending/Fitness) — skip Goalkeeping/SetPieces.
3. `developmentTick` resolves each player's primary category and feeds `categoryCoachFactor` as the `coachF` arg; **unassigned/AI/golden clubs fall back to the flat `coachingFactor` → byte-identical.**
4. `players.train_intensity` wired into `developAttrs` (growth-only `growthMul`) **and** `fitness.ts` (fatigue/injury trade-off).
5. `hireStaff` sets specialty/attrs + auto-assigns by specialty.
6. `seededGrowth` replaces any per-tick jitter (determinism anchor for everything that follows).
7. UI: specialty badges + the 4-category star/coverage board with assignment dropdowns in `screenStaff`; an intensity segmented control + the active-focus category star in `screenTraining`.

**Verify:**
- `npm run typecheck` (frontend + backend configs).
- Extend `tools/_training_test.ts`: **(a) legacy-fallback identity** — a club with no assigned coaches + normal intensity produces byte-identical attrs to today (assert exact values, locks the golden); **(b) star math + coverage clamps + over-stretch penalty**; **(c) intensity scaling** double > normal > rest on paired same-seed; **(d) per-category wiring** — a 5★ Attacking club's shooting climbs faster than its tackling under a balanced focus; **(e) determinism** — two `developmentTick` runs over identical state give byte-identical `attrs`.
- `tools/tactics_golden.py` unchanged (proves the engine/match lane is untouched).

### Phase 2 — schedules, intensity dial, retraining, traits, minutes→ROI — **[PARTIALLY SHIPPED]**
**Ships:** `teams.training_intensity`/`training_mix` + presets (`resolvePreset`); match-prep **taper**; `players.minutes_recent` + `minutesToFactor` (game-time as a development lever); `training_load` burnout + `loadDampen`; position **retrain** (`retrain_role` + `role_familiarity` + `roleAdaptation` + the in-match `attrFactor`/`moraleBoost` shade); **trait learning** (`train_trait`/`_prog` → `personality.traits`, coupled to matching directives); `current_form` from match output; `ai.ts` `coaching_style` presets + `aiManagerStaff` (closes "AI forever under-coached"); Goalkeeping (trainable `handling` via `gk_coach`). UI: preset row, mix sliders, retrain affordance, the per-player Development tab, recovery/taper badges.

> **Status (verified against `training.ts` / `staff.ts` / `ai.ts` / `db.ts`):**
> **SHIPPED** — the club `training_intensity` dial + presets (`resolvePreset`/`applyTrainingPreset`/`TRAINING_PRESETS`); `training_load` burnout (`loadDampen`/`LOAD_DECAY`); position retrain (`retrain_role`/`role_familiarity`/`roleAdaptation`/`retrainPenalty`, settled inline in `developmentTick`); `ai.ts` `coaching_style` + `aiManagerStaff`.
> **NOT YET SHIPPED (roadmap)** — `training_mix` + match-prep taper; `minutes_recent`/minutes→ROI (`developAttrs` has no `minutesFactor`); trait learning (`train_trait`/`train_trait_prog` columns exist in `db.ts` but nothing merges them into `personality.traits`); `current_form`; the Goalkeeping category (`CATEGORY_ATTRS` holds only the 4 attr-backed categories — no `handling`/`gk_coach`).

**Verify:** typecheck both configs; `_training_test.ts` adds — benched player drifts `<` starter same-seed (minutes gate); burnout dampening past threshold; intensity-dial paired ordering; trait bar reaches 100 → trait present in `personality.traits` then columns cleared; retrain familiarity climbs and the in-match shade is applied; **determinism** assertion still holds with all levers active. `tactics_golden.py` still green (AI on normal/no-trait, so the golden match is byte-stable).

### Phase 3 — youth intake, facilities, tutoring — **[ROADMAP · UNBUILT]**
**Ships:** `players.is_youth`/`intake_season` + `teams.facility_training/youth/recruitment` (default 2 = neutral); `game.ts:generateIntake` called from `rolloverSeason` (fold into `youthAndRetirement`), with `youth_intake_reports` for human clubs; `developAttrs`/`developmentTick` fold the two facility multipliers into the positive-drift amplifier (youth players get the youth multiplier stacked); `facilities.ts:upgradeFacility` charging `facility_capex` to the ledger; `youth_coach` specialty driving intake quality + academy dev; tutoring (`mentor_id`/`mentor_until` + `tutoring.ts`); the new `screenYouthAcademy`; news hooks (intake day, facility upgrade, graduate promoted); AI parity via `aiManageAcademy`. **Optional engine ask:** omittable `players[i].startStamina` in `specForTeam`/`loadTeam`.

> **Status: UNBUILT.** None of the Phase-3 columns/tables exist yet (`db.ts` has no `is_youth`, `intake_season`, `facility_training/youth/recruitment`, `mentor_id`, or `youth_intake_reports`), and there is no `generateIntake`, `facilities.ts`, `tutoring.ts`, or `screenYouthAcademy`. The pre-existing `youthAndRetirement` (in `youth.ts`, called from `rolloverSeason`) brings prospects through at rollover, but is **not** the academy/facilities/tutoring system described here.

**Verify:** typecheck both configs; a new `tools/_youth_test.ts` (mirrors `_training_test`) asserting — **default tier-2 keeps senior development math byte-identical** (golden-safe); intake batch size + PA spread monotonic in recruitment tier; facility dev-rate monotonicity (tier 5 youth player grows faster than tier 1, same seed); tutoring drifts mentee personality toward the mentor and clears on expiry/promotion; a promoted prospect flows through `specForTeam` unchanged. `tactics_golden.py` still green.

---

### Calibration & balance guard-rails (all phases)
- The default teams already over-convert because of high/legend attrs (see attribute-calibration notes) — **do not** let MVP coaching let a top club run away. The +30% cap and the 2.5★-neutral baseline keep a fully-coached club's growth bounded; verify a full season under 5★ coaching doesn't push squad OVR past the ~78 elite band that the showcase teams should sit in.
- Use a **broad random seed set (16+)** for any absolute read on goals/development; fixed paired seeds only for deltas.
- Keep wages/contracts at default 0 (fee-only) through MVP/Phase 2 so the economy is untouched; recurring staff salary is a depth lever, not a phase commitment.

This is FM-faithful in spirit — stars + workload, intensity↔fatigue↔injury, individual focus + traits + retraining, a youth academy with hidden potential and tutoring — expressed as **thin extensions of `developAttrs` / `developmentTick` / `rolloverSeason`**, every stochastic quantum seeded, every default path byte-identical, and the engine touched only by an optional omittable field in the final phase.
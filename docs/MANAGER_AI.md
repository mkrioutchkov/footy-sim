# manager_ai — shipped contract

An AI manager that decides a club's matchday setup (and, for fully-AI clubs, transfers/renewals),
**filling in for absent humans** in a scheduled, synchronized, multi-world live sim. Lives in its own
dir **`web/backend/manager/`**; wired into the world tick via `runManagerPrePass` (see Integration).

## The seam (why it's a decoupled subsystem)
manager_ai's **only output is writing four team columns that `specForTeam` (`web/backend/match.ts`)
already reads** — so the engine and `match.ts` need **zero knowledge** of it:

| Column | Type | Meaning |
|---|---|---|
| `teams.formation` | TEXT | a `FORMATIONS` key (e.g. `4-3-3`) |
| `teams.lineup` | TEXT (JSON `int[11]`) or NULL | per-slot player order; **NULL = identity XI** (keeps the byte-identical default path) |
| `teams.plan_text` | TEXT | the manager's plain-English standing plan |
| `teams.plan_directives` | TEXT (JSON) | the compiled directives (what the engine runs) |

It only **reads** other `web/backend` modules + the DB, and **writes only those 4 columns + its own dir**.

## Entry points
Both shapes live in `web/backend/manager/index.ts`.

**Wired — what actually runs each matchday (heuristic, deterministic, no LLM):**
```ts
setTacticsAndXI(teamId: number): void              // formation + XI + deterministic fallbackPlan (no transfers)
prepareMatchdayHeuristic(teamId, autonomy): void   // same, plus transfers/renewals for the 'full' tier
```
`web/backend/routes/world.ts` imports **only these two** (line 13) and calls them from `runManagerPrePass`
(see Integration). Both persist the four columns synchronously; the plan they write is the deterministic
`fallbackPlan` (`plan.ts`), never the LLM.

**Async LLM entries — they exist but are NOT wired into the world tick:**
```ts
prepareMatchday(teamId, autonomy): Promise<void>             // per-club; may call the LLM for the plan
prepareWorldMatchday(fixtureIds: number[]): Promise<void>    // batches all AI clubs' plans into ONE LLM call
```
These are exercised by `manager/manager_test.ts` and `tools/manager_balance.ts` but are **not** called
from `index.ts`. When wired they honour the fire-path rule (LLM in the pre-matchday async pass, never on
the synchronous fire path). All entries are **idempotent** (safe to re-run).

## Inputs (read-only — reuse existing helpers, do not duplicate)
- Squad + attrs + per-player **personality** dials + age/fitness/morale (`getTeamWithPlayers`, `game.ts`).
- Budget / wage budget / wage bill (`market.ts` / the team row).
- League + world context; the **weakest role** (already computed for the AI in `market.ts`/`ai.ts`).

## Two autonomy tiers
- **`assistant`** — a present-but-idle human didn't set tactics for this matchday. Fill **only the gaps**:
  a heuristic best XI + a neutral/conservative plan. **No transfers/renewals** (never spend a human's
  money). The human can override before kickoff.
- **`full`** — a fully-AI club (`user_id IS NULL`). Decide **everything**: formation + XI + a
  personality-flavoured plan + transfers/renewals to address the weakest role within budget. The old
  XI-only `aiManagerTick` (`ai.ts`) still **coexists** — it runs in the post-match world tick each
  matchday (`routes/world.ts`, in `advanceWorldCore`), while the manager pre-pass sets shape/XI/plan before kickoff. manager_ai
  does not remove it; `FOOTY_MANAGER_AI=0` reverts to `aiManagerTick`-only.

## Heuristic vs LLM split
- **Heuristic (deterministic — no rng/seeded — runs anytime):** formation choice (from the `FORMATIONS`
  registry by squad shape/strength), XI selection (**reuse `optimizeLineup`**, `ai.ts`), transfers +
  renewals (**reuse the weakest-role + market helpers**, `market.ts`).
- **LLM (full tier; PERSISTED):** the plain-English plan (**reuse `plan.ts compileInitialPlan` /
  `compileInitialPlans`**), flavoured by the club's identity/personalities → writes `plan_text` +
  `plan_directives`. ⚠️ Only reachable via the async `prepareMatchday` / `prepareWorldMatchday` entries,
  which are **not wired into the world tick** — so in the shipped path the **deterministic `fallbackPlan`
  (`plan.ts`) is what actually ships** to every match (`setTacticsAndXI` / `prepareMatchdayHeuristic`
  both write it). Press is optional.

## ⚠️ The fire-path rule (non-negotiable)
The LLM plan is generated in a **pre-matchday async pass and PERSISTED** to the columns. The synchronous
"play all worlds" fire path **only READS** the columns. **Never call the LLM (plan/press) on the
synchronous fire path** — Groq 429s + 4 s retries × hundreds of clubs would make a synchronized kickoff
take minutes-to-fail.

## Determinism + balance
- The heuristic parts must be **deterministic** (the match sim is deterministic; manager decisions must
  be too, or replays drift).
- manager_ai is the **highest-risk-to-balance** subsystem: bad AI tactics/transfers silently degrade
  **every world at once** (no human watches most AI-vs-AI games), and match goals are too noisy to
  eyeball-tune (<48 seeds). It **must ship with its own paired-same-seed balance harness** (golden-match
  style, cf. `tools/tactics_golden.py`) comparing manager_ai-managed clubs vs the baseline
  (`aiManagerTick`) before its plans go live.

## Integration — the wired hook
`web/backend/routes/world.ts` calls **`runManagerPrePass(fixtureIds)`** from `advanceWorldCore` (line 112,
right before the synchronous fire path `mapPool(toPlay, playFixture)`), gated by **`FOOTY_MANAGER_AI`**
(default on; `FOOTY_MANAGER_AI=0` reverts to the old XI-only `aiManagerTick` behaviour). Per distinct
club about to play it dispatches:
- **AI club** (`user_id IS NULL`) → `setTacticsAndXI(tid)` — formation/XI + deterministic plan; transfers
  stay with `marketTick` (no double-trade).
- **Absent human** (no `last_seen`, or away > `FOOTY_ABSENT_HOURS`, default 30h) → `prepareMatchdayHeuristic(tid, 'full')`
  if the club opted into `autonomy = 'full'`, else `setTacticsAndXI(tid)` (assistant tier: tactics + XI, never spends).
- **Present human** → left entirely alone (keeps their own tactics/XI).

manager_ai exports the entries; `index.ts` owns `runManagerPrePass` and the wiring. It does **not** modify
`season.ts` / `ai.ts` / `match.ts`.

## Ownership & stability
`web/backend/manager/` is the manager_ai lane. **Don't rename the four columns** without updating this
contract — a Gaylord column rename or a Boris directive-vocab change can silently produce broken specs
(schema churn is a known hazard). The directive vocabulary it emits must stay within
`tactics.ts VALID_KINDS` (see `docs/TACTICS.md`).

# manager_ai — contract & v1 spec

An AI manager that decides a club's matchday setup (and, for fully-AI clubs, transfers/renewals),
**filling in for absent humans** in a scheduled, synchronized, multi-world live sim. Built in parallel
by the SysArch session; lives in its own dir **`web/backend/manager/`**.

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

## Entry point
```ts
prepareMatchday(teamId: number, autonomy: 'assistant' | 'full'): Promise<void>
```
Reads the club state, decides, persists the four columns. **Idempotent** (safe to re-run).
**Never called on the synchronous match-fire path** (see the fire-path rule).

## Inputs (read-only — reuse existing helpers, do not duplicate)
- Squad + attrs + per-player **personality** dials + age/fitness/morale (`getTeamWithPlayers`, `game.ts`).
- Budget / wage budget / wage bill (`market.ts` / the team row).
- League + world context; the **weakest role** (already computed for the AI in `market.ts`/`ai.ts`).

## Two autonomy tiers
- **`assistant`** — a present-but-idle human didn't set tactics for this matchday. Fill **only the gaps**:
  a heuristic best XI + a neutral/conservative plan. **No transfers/renewals** (never spend a human's
  money). The human can override before kickoff.
- **`full`** — a fully-AI club (`user_id IS NULL`). Decide **everything**: formation + XI + a
  personality-flavoured plan + transfers/renewals to address the weakest role within budget. Replaces
  today's XI-only `aiManagerTick`.

## Heuristic vs LLM split
- **Heuristic (deterministic — no rng/seeded — runs anytime):** formation choice (from the `FORMATIONS`
  registry by squad shape/strength), XI selection (**reuse `optimizeLineup`**, `ai.ts`), transfers +
  renewals (**reuse the weakest-role + market helpers**, `market.ts`).
- **LLM (full tier; PERSISTED):** the plain-English plan (**reuse `plan.ts compileInitialPlan` / the plan
  compiler**), flavoured by the club's identity/personalities → writes `plan_text` + `plan_directives`.
  Press is optional (v1+).

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

## Integration — the ONE hook (Gaylord wires this; manager_ai does NOT edit it)
In the **pre-matchday async pass** of the matchday tick (`advanceWorld` / the per-division tick), call
`prepareMatchday(teamId, tier)` for each club — `tier = 'full'` if `user_id IS NULL`, else `'assistant'`
if the human left tactics blank. manager_ai **exports `prepareMatchday`**; it does **not** modify
`index.ts` / `season.ts` / `ai.ts` / `match.ts`.

## Ownership & stability
`web/backend/manager/` is the manager_ai lane. **Don't rename the four columns** without updating this
contract — a Gaylord column rename or a Boris directive-vocab change can silently produce broken specs
(schema churn is a known hazard). The directive vocabulary it emits must stay within
`tactics.ts VALID_KINDS` (see `docs/TACTICS.md`).

# Game Layer — Management Sim Build Notes

The footy-sim **game layer** (Node/Fastify/`node:sqlite` backend in `web/backend/`,
vanilla-TS SPA in `web/frontend/`) wraps the C++ match engine in an FM-style
management game. This doc designs the four growth pillars — **transfer market,
training/development, seasons, AI managers** — and records the taste-heavy defaults
chosen along the way.

> The C++ engine (`engine/`, `build/live.exe`) is OFF LIMITS here — parallel work.
> Everything below lives in the Node + TS game layer and feeds the engine only via
> the JSON match spec (`specForTeam` in `match.ts`).

---

## What exists today (baseline)

- **DB** (`db.ts`): `users, sessions, leagues, teams, players, fixtures`. Idempotent
  migrations via `ensureColumn()` (PRAGMA guard) + `CREATE TABLE IF NOT EXISTS`.
- **Teams** hold **exactly 11 players** in engine slots 0..10 (`ROLE_SLOTS`), each with
  `attrs` (8 dials + height) and an LLM `personality` (8 trait dials).
- **League**: per-user world — your team + 7 AI teams, double round-robin fixtures,
  live standings. `newSeasonForUser` seeds it.
- **Match**: `specForTeam` builds the JSON spec from a team's roster+formation+lineup;
  `playFixture` runs `live.exe --match --summary` and persists the score. The default
  4-3-3 identity XI emits a **byte-identical** spec (the invariant we must not break).
- **LLM compiler pattern** (`tactics.ts` / `lineup.ts` / `personality.ts`): Groq via
  `web/backend/.env`, always with a non-LLM fallback + 429 retry.

The fixed-11 roster is the central constraint every pillar has to respect.

---

## Pillar 1 — TRANSFER MARKET (build first; most self-contained)

**Roster model decision: a SQUAD of 11–24, of which 11 start.** Buying adds a player;
selling removes one. This is the FM model and the existing lineup machinery already
selects "11 of N by index", so it needs only two *byte-safe* touches:
- `specForTeam` default path slices `bySlot.slice(0, 11)` (no-op for 11-player teams).
- the `getTeamWithPlayers` lineup-permutation guard relaxes its upper bound from
  `<= 10` to `< squadSize` (no-op for 11-player teams).
Existing teams (always 11) emit identical specs — verified in the pillar-1 test.

**Free agents** live in their own `free_agents` table (league-scoped), NOT as
`players` rows with a null team — that keeps every existing player query and the
fixed-22 match invariant untouched. Buy = INSERT into `players` + DELETE the agent.

**Schema (pillar 1):**
- `teams.budget INTEGER DEFAULT 50000000` — 50M starting transfer kitty.
- `players.age INTEGER DEFAULT 24` — needed by the value formula (and pillar 2).
- `players.listed INTEGER DEFAULT 0`, `players.ask_price INTEGER` — transfer-list a
  player at a price.
- new `free_agents(id, league_id, name, role, attrs, personality, age, value)`.

**Player value** = `f(overall, age, personality)`:
- `overall` = mean of the 7 skill attrs (height excluded — it's a physical, not a
  quality, dial).
- base = `(overall/100)^3 * 60M` — convex so an 85-OVR star is worth far more than a
  60-OVR squad filler.
- age multiplier: peak ~24–26 (×1.0), young prospects discounted slightly but with
  upside, 30+ falls off steeply (×0.5 by 33).
- personality nudge: high `professionalism`+`consistency`+`bigGame` up to +15%,
  high `ego` down to −8%.
Rounded to the nearest 100k. Stored as a snapshot on free agents; computed live for
owned players. **TASTE:** the curve constants are a first guess — tune against feel.

**Market actions:**
- `BUY` a free agent → pay `value`, INSERT into squad (if squad < 24 and budget ≥ value).
- `LIST` / `UNLIST` one of your players at an asking price (default = computed value).
- On each **market tick** (fired from `/api/advance`, i.e. once per matchday) AI teams:
  (a) sign the best affordable free agent for their **weakest role** if squad < cap,
  and (b) may buy a listed player that upgrades their weakest role (fee → seller's
  budget). This makes the market feel alive even in a solo world.

**Endpoints:** `GET /api/market` (budget + free agents + my listings + my squad with
values), `POST /api/market/buy {agentId}`, `POST /api/market/list {playerSlot, price}`,
`POST /api/market/unlist {playerSlot}`. **Frontend:** a `#/market` screen + a nav button.

---

## Pillar 2 — TRAINING / DEVELOPMENT

- Add `players.potential INTEGER` (a ceiling OVR, ≥ current; generated for new
  players, backfilled ≈ current+gap for existing).
- Add `teams.training_focus TEXT` (an attribute key or 'balanced').
- **Between matchdays** (a development tick, also fired by `/api/advance` after the
  market tick), each player's attrs drift **toward potential**, deterministically:
  - rate scales with `(potential − overall)` headroom, age (sharp growth < 23, plateau
    24–29, decline 31+), and `professionalism`/`consistency` traits.
  - the team `training_focus` attribute gets an extra nudge.
- Deterministic given (attrs, age, potential, traits, focus) — no RNG, so a test can
  assert exact post-tick values. **TASTE:** growth/decline rates per age band.

---

## Pillar 3 — SEASONS

- ≥2 divisions: extend league creation to a **pyramid** (e.g. Div 1 + Div 2, 8 teams
  each) OR keep one league but add `teams.division`. Decision: add a `divisions`
  concept via `leagues.tier` + linking same-world leagues by a `world_id` so the
  existing single-league flow still works untouched when there's one tier.
- **Season end** (all fixtures played) → freeze final standings → **promote** bottom
  of Div 1 ↔ **relegate** top of Div 2 (e.g. swap 2 teams) → **new season**: keep
  squads, regenerate fixtures, bump `leagues.season`, pay **prize money** into
  `teams.budget` by final position. Apply an **ageing tick** (everyone +1 year) at
  rollover so squads evolve across seasons.
- **TASTE:** division sizes, promotion/relegation counts, prize-money schedule.

## Pillar 4 — AI MANAGERS

- Unify the per-cycle AI behaviour: each AI team, every matchday tick, makes
  **transfer** (pillar 1 hook), **training-focus** (pillar 2 hook) and **lineup/formation**
  choices driven by squad shape + budget + recent form, so the whole world manages
  itself. Keep it rule-based + cheap (no LLM in the hot path; optional LLM flavour).

---

## Recommended build order

1. **Transfer market** — self-contained, exercises the squad-size relaxation early. ✅ first.
2. **Training/development** — needs `age` (added in 1) + `potential`; pure function, easy to test.
3. **Seasons** — depends on standings (exists) + budget (1) for prize money + ageing (2).
4. **AI managers** — ties 1–3 together into a living world; do last.

Each increment: `npx tsc --noEmit` clean + a temp-`FOOTY_DB` test that creates teams,
runs the tick, and asserts state — then a commit with a WHY + Co-authored-by trailer.

---

## Open TASTE questions (defaults chosen; flag for the user)

- **Economy scale**: 50M budgets, value curve `(ovr/100)^3 * 60M`. Right ballpark?
- **Squad cap**: 24 max / 11 min. OK?
- **Training rates**: how fast should a 19-y/o with 80 potential close the gap? (chosen:
  a few OVR points/season.)
- **League structure**: 2 divisions of 8, promote/relegate 2? Or a bigger pyramid?
- **Prize money** schedule and whether relegation has a financial penalty.
- **AI aggression** in the market — how much should the AI churn squads each season?

---

## Status ledger

- **SHIPPED:**
  - **Pillar 1 — Transfer market.** `teams.budget` (50M), `players.age/listed/ask_price`,
    a league-scoped `free_agents` pool (+ idempotent `market_seeded` backfill for
    pre-market saves). `playerValue` (convex-in-overall × age curve × personality).
    Backend `market.ts`: `buyFreeAgent` (auto-upgrade-into-XI or bench), `listPlayer`/
    `unlistPlayer`, `getMarket`, and `marketTick` (AI signs its weakest role + buys
    listed players each matchday, with a role-aware starter backfill on sales).
    `/api/market*` endpoints, tick hooked into `/api/advance`, a `#/market` SPA screen.
    Verified by `tools/_market_test.ts` (46 assertions: seeding, value, money
    conservation, squad caps, the always-11 spec invariant, both review fixes) +
    an ad-hoc real-`buildSpec` check (11/side, byte-identical default, no bench leak).
- **DESIGNED:** training, seasons, AI managers (this doc).
- **AWAITING YOUR TASTE:** economy scale (50M budgets, `(ovr/100)^3 × 55M` value
  curve, 24-man cap), training rates, league structure, prize money.

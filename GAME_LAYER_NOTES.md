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

- **Economy scale (now PL/Championship-based, 2026-06-16):** value = `((ovr−30)/65)^4 × 130M`
  × age × personality (95-rated ≈ £130M, 85 ≈ £67M, 70 ≈ £19M, 50 ≈ £1.2M); wage ≈ 10% of the
  ego-neutral value + ego premium. Tier finances: **Premier League** (tier 1) £80M transfer /
  £140M wages, prize money £160M (champ) → £100M (last); **Championship** (tier 2) £18M / £40M,
  prize £12M → £3M. Promotion = +£40M windfall and the jump to the PL wage budget; relegation
  drops to the Championship wage budget. (Parachute payments that decay over 3 years are a
  future refinement.) Right ballpark?
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
  - **Pillar 2 — Training / development.** `players.potential` (youth-weighted ceiling,
    backfilled for old saves) + `teams.training_focus`. `training.ts`: `developAttrs`
    (pure, deterministic — attrs drift toward potential, scaled by age + professionalism/
    consistency; the focus attr trains ~80% faster; the legs fade first with age; growth
    caps at potential, decline floors at 30) and `developmentTick` (every league player,
    once per matchday after the market tick). Potential threads through every signing.
    `PUT /api/training`, a `#/training` screen, a POT column in the market, age/potential
    on dashboard cards, and a shared `skillOvr` so OVR reads the same on every screen.
    Verified by `tools/_training_test.ts` (25 assertions: convergence, decline, focus,
    diligence, clamp, backfill, tick, signing-carries-potential) + `tools/_http_smoke.ts`
    (15 assertions: the live pillar 1+2 endpoints on a temp-DB backend).
  - **Pillar 3 — Seasons & divisions.** A new user's world is now TWO divisions
    (`leagues.tier` + `world_id`): the user starts in Division 2 among weaker AI, with a
    stronger Division 1 above. `season.ts`: `worldLeagues`, `pendingMatchday` (each
    division's earliest incomplete round — so a watched-ahead fixture's round is completed,
    not orphaned), `seasonComplete`, and `rolloverSeason` (one tx: prize money by position,
    promotion/relegation of the bottom-2 ↔ top-2 of adjacent tiers + a promotion bonus,
    every player ages +1, season++, fixtures regenerated, free-agent pools refreshed).
    `/api/advance` plays a matchday across every division then rolls over; `/api/league`
    carries season/tier/division + every division's table; the dashboard shows the
    division, season, an "other divisions" peek, and a rollover summary. Legacy single
    leagues (world_id NULL) still roll over as a lone division (no promotion). Added
    `tsconfig.backend.json` + `npm run typecheck` so the tsx-run backend is type-checked
    (the main tsconfig excludes it — a missing import had shipped past it; a multi-agent
    review caught it). Verified by `tools/_season_test.ts` (34 assertions) + the HTTP smoke
    (20, incl. the league/world shape).
  - **Pillar 4 — AI managers.** `ai.ts`: each matchday every AI club (in `aiManagerTick`,
    fired per division in `/api/advance` after the market tick) sets a training focus
    (`pickTrainingFocus` — its outfield XI's weakest attribute, else balanced) and fields
    its strongest role-correct XI (`optimizeLineup` — best player per role-slot, rest
    benched). Combined with the market's existing AI signings, AI clubs now make transfer +
    training + lineup choices, so the whole world manages itself. Strictly AI-only — a human
    manager's focus and hand-picked lineup are never touched. Verified by `tools/_ai_test.ts`
    (12 assertions) + a multi-agent review (zero findings).
- **SHIPPED — Round 5 (toward FM depth):**
  - **5.1 Story-driven traits.** The trait dials are now first-class as the machine-readable
    projection of a player's backstory. `personality.ts` `deriveTraits` (LLM primary) +
    `deriveTraitsFromText` (deterministic keyword projection) re-derive the 8 dials from the
    text; `PUT /api/player/:slot/story` rewrites a backstory and re-derives, so the training
    rate (training.ts reads professionalism/consistency) and transfer value (game.ts reads
    the dials) move with the story. A `#/player/:slot` profile shows the dials + an editable
    backstory. Verified by `tools/_personality_test.ts` (14) + the HTTP smoke (24).
  - **5.2 Contracts & wages.** Every player draws an annual `wage` (≈8% of the ego-neutral
    value × an ego premium — a diva costs more to PAY) and holds a `contract_years` deal;
    each club has a `wage_budget` (40M) separate from the transfer kitty. Signing is gated by
    BOTH a fee and wage headroom (`market.ts`, AI included). At season rollover `tickContracts`
    (in `contracts.ts`) ticks every deal down: AI clubs force-renew (stable world); a human's
    expiring players are released to the pool worst-first but never below a legal XI (the rest
    are force-renewed). `PUT /api/player/:slot/renew` recomputes the wage and commits a new
    deal (budget-gated). The market shows the wage bill/budget; the player profile a Renew
    button. Verified by `tools/_contracts_test.ts` (18) + `_market_test.ts` (53) + HTTP smoke (26).
  - **5.3 Youth & retirement.** At each rollover (`youth.ts`, after the contract tick) players
    aged ≥37 retire (leave the game, floor-guarded to never drop below a legal XI) and every
    club brings through `YOUTH_INTAKE` (2) prospects — raw teens (attrs 40–55) with high
    `genPotential` upside, a neutral personality to flesh out via the story editor (which
    re-derives their weights), a wage + a 3-yr deal — capped at the 24-man squad. Closes the
    ageing loop: squads now renew across seasons. `market.ts` `removePlayerFromSquad` is shared
    by retirement + release. Verified by `tools/_youth_test.ts` (17) + season (36) regression.
  - **Injuries & match fitness** (`fitness.ts`). Condition 0–100: the XI that plays drains
    (~10–17), the rest recover (+20); low fitness raises injury risk (3% fresh → 13% exhausted,
    out 1–5 matchdays), so neglecting rotation bites. Injured players can't be selected —
    `specForTeam` draws the XI fit-first (byte-identical when fully fit), and a shared
    `fitFirstSelection` (game.ts) keeps "who played" (fitnessTick) identical to "who's
    fielded". `resetFitness` at rollover (pre-season). Fired first each matchday in
    `/api/advance`. Verified by `tools/_fitness_test.ts` (incl. the depleted-squad edge a
    review caught). Known limits: injury cover isn't role-aware (emergency out-of-position
    cover); fitness bookkeeping uses the first-11-by-slot, so a custom-lineup user can see a
    small skew; a fatigue→performance penalty (vs only injury risk) is a future refinement.
  - **Newgen backstories (LLM).** `game.ts fillMissingPersonalities(teamId)` gives an LLM-
    written backstory + matching dials to players lacking one (fresh academy regens, created
    with a blank-backstory neutral personality), WITHOUT touching established/hand-edited
    players. Kicked off in the background after a season rollover (`void` in /api/advance — off
    the rollover tx, like team-creation's `assignPersonalities`). With no LLM, regens stay
    neutral until the manager writes their story (which re-derives the dials — the coupling).
    Verified by `tools/_newgen_test.ts` (targeting + non-destructive + regens start needy).
    Note: only the user's regens are enriched (AI regens stay neutral — cost); an offline
    archetype-variety generator is a future add.
  - **Cup competition** (`cup.ts`). A single-elimination knockout of every world club (16,
    or 8 for a legacy single league), drawn at random each season (so a Championship side can
    draw + dump out a PL one — giant-killings come from the engine result). Spread across the
    season — round R plays once the league reaches matchday R×3 (final at MD12, before the MD14
    rollover). Drawn ties → a deterministic seeded shootout. `createCup` (idempotent) at world
    creation + each rollover; `advanceCupRound` (idempotent, won't duplicate a round — also a
    `uq_cup_tie` unique index); `cupView`/`pendingCupRound`/`cupTieFor`. `match.ts` shares a
    `runEngineSummary` + `buildTieSpec` between league fixtures + `playCupTie`. `/api/cup` +
    a `#/cup` bracket screen. `/api/advance` is now per-user-locked (a 409 on a concurrent
    advance) so overlapping requests can't double-run ticks or duplicate a cup round (a review
    finding). Verified by `tools/_cup_test.ts` (incl. idempotency + the draw shootout + a full
    16→1 run) + HTTP smoke.
  - **Morale** (`morale.ts`). Persistent squad morale 0–100 (default 65 = neutral): `moraleTick`
    each matchday drifts it 15% toward neutral and shifts it with the latest league result (win
    +8 / draw +2 / loss −7); morale modulates development (`moraleDevFactor`, 65 → ×1.0 so it's
    backward-compatible — happy squads improve faster, unhappy ones stall). `resetMorale` to
    fresh optimism at rollover. Shown on the squad card (😊/😟) + profile. Verified by
    `tools/_morale_test.ts`. (Morale → match performance is deliberately NOT a spec-attr scale —
    kept off the byte-identical match path; it drives development instead.)
  - **Press conferences (LLM).** `press.ts`: the manager's free-text media statement is judged
    against each player's dials to move morale — praise lifts the praise-hungry + big egos; a
    public rocket lifts the criticism-responsive but dents the sensitive + hot-heads. LLM-primary
    (`judgePressConference`) with a deterministic keyword-tone fallback; deltas clamp to ±15.
    `applyPressConference` writes morale relative-in-SQL (`morale + delta`, clamped) so it can't
    clobber a concurrent matchday morale tick across the LLM await (a review finding). `POST
    /api/press` + a dashboard press box. Verified by `tools/_press_test.ts` + HTTP smoke (30).
  - **Record & replay (Phase 1).** A played match's frame stream is recorded ONCE and replayed
    instead of re-simulating per viewer — cheaper, and it can't drift from the stored scoreline
    the way a re-sim does after the squad changed. `match.ts`: a match with a human stakeholder
    (a human manager on either side, even if absent; spectators later) is played FULL-FRAME and
    its frames gzipped to `<data>/recordings/<kind>-<ref>.ndjson.gz` (`persistRecording`), the
    score derived from the final frame so the two can't disagree; pure AI-vs-AI keeps the
    lightweight `--summary` path so idle matchdays + the engine benchmark never pay the capture
    cost. `MatchStream`'s pacing/speed/pause is refactored into a shared `FramePacer` (pure
    `paceStep` core) with a pluggable source: the live engine (`MatchStream`) or a stored
    recording (`ReplayStream`, with rewind/seek). `/ws/match` replays a recording if one exists,
    else falls back to the live re-sim. **Also fixed the 4× fast-forward bug** — the old pacer
    capped every `>1×` at one frame per 33ms (so 2×/4×/60× all played identically); it now
    frame-skips, advancing ~speed× of match-clock per render. `tools/recordings_gc.ts` prunes by
    retention. Adversarial-review hardening: capture STREAMS to a gzipped temp file (O(1) memory —
    a 90' match is ~200k frames / GBs, which buffering would OOM / blow V8's max string length)
    and is published via an atomic rename **only on a complete match** (final frame matchState
    `"finished"`), so a crash/timeout/kill leaves a discarded `.tmp`, never a partial recording or
    a scoreline that disagrees with an unplayed fixture; a metadata row that outlived its file
    falls back to the live re-sim instead of hanging the watch. Verified by `tools/_replay_test.ts`
    (31, synthetic frames + a synthetic capture stream — no engine) + typecheck + HTTP smoke (30).
  - **Match reports + ratings (LLM).** `report.ts`: after a match, its RECORDING is the source of
    truth — `analyzeRecording` scans the frames for the goal/card timeline (goals driven by the
    SCORE delta so the timeline can't disagree with the headline; an own goal the engine credits
    to the conceding player shows as "Own goal", not a goal for the wrong team, and earns no
    rating) and reads the final frame for deterministic 1–10 player ratings. `writeNarrative` is
    LLM-primary (Groq) for the prose body with a deterministic template fallback; the HEADLINE is
    ALWAYS the deterministic facts-derived scoreline (the LLM can't move the score). Cached in
    `match_reports`, generated lazily on first `GET /api/report?fixture=ID` (single-flighted so
    concurrent first-views don't double-call the LLM). `#/report/:id` screen (headline, narrative,
    timeline, possession/shots, two-column ratings) + a Report link on every played fixture. Old
    recordings + reports are purged at season rollover (`purgeRecordings`/`purgeReports`) so the
    tables don't accumulate rows for deleted fixtures. Verified by `tools/_report_test.ts` (28,
    synthetic recording incl. an own-goal + purge cases — no engine) + typecheck + HTTP smoke (32).
  - **Transfer windows + club-to-club negotiation.** `market.ts`: `transferWindow(leagueId)`
    derives a **summer** (pre-season) + **winter** (mid-season) window from the fixture rounds;
    free agents are signable any time, but **club-to-club deals are window-gated** — both the user
    (`bidForPlayer`) and the AI (`marketTick` step 2). `bidForPlayer(buyer, targetPlayerId, fee)`
    is real negotiation: the seller accepts at/above its price (a listed player's ask, else
    `value × 1.4` to prise an unlisted one away), counters at that price if the bid is close
    (≥ 80%), else rejects — and won't sell down to the minimum squad. On acceptance the deal runs
    immediately (reusing `transferListed`; the player keeps his wage + remaining contract years),
    buyer budget/wage/squad permitting. Stateless: a counter just returns the price and the user
    re-bids. `POST /api/transfer/bid` (200 for accept/counter/reject, 400 for an illegal bid);
    `getMarket` now carries the window + `transferTargets` (listed players across the world). A
    window banner + a "For sale — other clubs" table with a bid flow. Verified by
    `tools/_transfer_test.ts` (19 — window progression, reject/counter/accept with money conserved
    + squads legal, unlisted premium, seller-min refusal, window-shut blocking) + smoke (36).
  - **Loans.** `market.ts`: `loanIn(borrower, targetPlayerId)` borrows another club's player for
    the season — no fee, window-gated, the owner must keep a legal squad, the borrower needs room +
    wage headroom and carries the loanee's wage. `players.parent_team_id` (owner) + `loan_until`
    track it; `relocatePlayer` moves him IN PLACE (keeping his row id, so the link survives a clean
    return — unlike a transfer, which deletes + re-inserts) and backfills the club he leaves.
    `returnLoans(leagueIds)` sends every loanee in the rolling-over world home at season rollover
    (review fix: world-scoped, not global). Guards: a loaned player is excluded from transfer
    targets and can't be bid for, listed, or re-loaned; the squad view flags `onLoan`. `POST
    /api/transfer/loan` + a Loan button on the targets table + a "loan" squad marker (List
    disabled). Verified by `tools/_loans_test.ts` (18 — no-fee move with id preserved, owner-min
    refusal, the guards, window gating, return-to-parent + idempotent).
  - **Dynamic player-news (LLM).** `news.ts`: notable events — a hat-trick, brace, red card,
    man-of-the-match, a long injury — become a news item AND evolve the player: a cue-rich
    development is woven into his backstory and his trait dials are RE-DERIVED from the new text
    (the text↔dial coupling, so a hat-trick lifts big-game/ego, a red card temperament, a long
    injury fragility). Because the dials feed training rate + transfer value, form reshapes who he
    is. LLM-primary rewrite (`rewriteStory`) with a deterministic cue-append fallback that PREPENDS
    so the newest cue survives the cap; `deriveTraits` re-derives. Match events are read from the
    recording (no engine), user-side only; injuries from the fitness tick. Attribution is by stable
    DB **id** captured at detection (immune to slot renumbering), via a UNIQUE-name map (a duplicate
    squad name drops the event rather than mis-evolve a team-mate), and the red-card set is
    side-filtered (review fixes). Idempotent per matchday (`ref_id` = fixture). `players.personality`
    is updated in place; `player_news` is the club's persistent feed (kept across seasons — NOT
    purged at rollover). Fired in the background from `/api/advance`; `GET /api/news` + a Club-news
    dashboard card (links by current name). Verified by `tools/_news_test.ts` (17 — detection,
    story+dial evolution, idempotency, + the two name-collision regressions — no engine, keyless).
- **DESIGNED:** the four original pillars + round 5 + injuries/fitness + newgen + cup + morale
  + press conferences + record/replay (Phase 1) + match reports/ratings + transfer windows &
  negotiation + loans + dynamic player-news are all SHIPPED.
- **NOT YET (future / awaiting taste):** AI formation choice (it optimises the XI, not the
  shape); richer scouting (hidden attributes until scouted); season-history/honours archive;
  morale/form feeding match results; probabilistic (not hard-cutoff) retirement + injuries.
  Deferred transfer follow-ons (loans now SHIPPED): **loan-OUT** by the user + AI clubs initiating
  loans/bids of their own (incl. for the user's unlisted stars); **wage-split / loan fees** (loans
  are currently free, borrower pays full wage); **NL/LLM negotiation** (haggle in natural language)
  — an LLM-stream item; cross-window deadline-day feel.
- **AWAITING YOUR TASTE:** economy scale (50M budgets, `(ovr/100)^3 × 55M` value
  curve, 24-man cap), training/decline rates per age band, division sizes / promotion
  counts (2 of 8), the prize-money schedule.

## Known limitations / future enhancements (flag for the user)

- **Watch: replay where recorded, re-sim otherwise.** Human-stake matches are now recorded at
  play time and the watch socket replays that exact stored stream — faithful to the scoreline,
  no engine spawn (Record & replay, above). A match with no recording (a pure AI-vs-AI game the
  user spectates) still falls back to re-running the engine from the team's CURRENT spec, which
  can drift from the stored scoreline after the squad changed. Decisions noted: **files on disk**
  (not a DB blob) so the store scales toward object storage; recorded **iff a human stakeholder**;
  **headless capture at `/api/advance`** for now — folding "the live watched session IS the
  recording" + a one-compute-many-viewers broadcast + record-everything is **Phase 2**.
- **Loading a recording is whole-file (replay + reports).** `loadRecording` gunzips the entire
  recording into one string/array. Fine at short/prototype match lengths, but a full 90' match
  (~200k frames, multi-GB decompressed) would blow V8's max string length — capture already
  streams (bounded memory), but the LOAD path (both `ReplayStream` and `analyzeRecording`, which
  is already written to iterate-not-accumulate) needs a streaming gunzip reader. To do alongside
  the live-path Phase 2 work, when a real 90' recording can be produced + verified with the exe.
- **Cup match reports/watching aren't surfaced.** Cup ties ARE recorded (`kind='cup'`) and
  `buildMatchReport('cup', …)` works, but the report endpoint + the cup screen are fixture-only —
  no UI path reaches a cup tie's replay or report yet. Wiring a cup watch/report entry point is a
  small follow-on.
- **No retirement / youth intake.** Players age +1 each season and decline past ~30 but are
  never retired/regenerated, so over many seasons squads grey out. A release-at-38 +
  generated-youth intake at rollover is the natural next step.
- **AI keeps the default 4-3-3 shape.** AI optimises WHICH 11 start, not the formation —
  picking a shape to suit the squad (the `formations.ts` registry is already there) is a
  future enhancement.
- **Season history isn't archived.** Rollover regenerates fixtures, discarding the played
  results; a `season_results` table would preserve past tables/honours.

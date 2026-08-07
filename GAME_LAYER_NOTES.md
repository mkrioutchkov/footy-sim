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
    side-filtered (review fixes). `players.personality` is updated in place; `player_news` is the
    club's persistent feed (kept across seasons — NOT purged at rollover). `GET /api/news` + a
    Club-news dashboard card (links by current name). (The detector lives in `processMatchAftermath`
    — see Awards below.) Verified by `tools/_news_test.ts` (no engine, keyless).
  - **Ratings → morale + season awards.** The per-match player ratings (report.ts) finally drive
    something. `news.ts processMatchAftermath` (the renamed news detector, fired in the background
    from `/api/advance` before rollover): one pass over the user-side ratings nudges each player's
    morale by `clamp(round((rating−6.5)×2.5), ±8)` AND accumulates a season tally (`players.
    season_rating_sum/season_apps`) — alongside the story-evolving news events. Guarded per-fixture
    by `fixtures.aftermath_done` (set after the synchronous morale/tally pass, before the async LLM
    story loop) so the watch-then-advance path can't double-apply. `recordSeasonAwards` at rollover
    (step 0b, before ageing + before the tally resets) crowns the club's **Player of the Season** +
    **Young Player of the Season** (U-21) by average rating over ≥3 games, as `player_news` rows
    (🏆/🌟). Adversarial review: clean (0 findings). Verified by `tools/_news_test.ts` (23 — morale
    up/down, the tally, no-double-apply, the awards) + multiseason (83, awards + reset across 8 seasons).
  - **Plain-English tactics plan (replaces the 5-dial human UI).** Pre-match, the manager types a
    standing plan ("high press, build from the back, full-backs bomb on, sit deeper if 2-0 up");
    `plan.ts compileInitialPlan` (reusing `compilePlanEdit`) compiles it to directives, persisted on
    `teams.plan_text` + `teams.plan_directives` (TEAM-RELATIVE slot ids 0-10, frozen). At spec build,
    a HUMAN team's dials go NEUTRAL (the plan is its tactical input); AI keeps its dials. `specForTeam`
    builds a slot→engine-position map (so a custom XI / formation / injury-cover swap retargets
    correctly — review fix) and `resolvePlanDirectives` resolves the plan to engine ids (home 0-10,
    away +11), merged into top-level `spec.directives` (omitted when no plan → AI-vs-AI specs
    unchanged). NO engine/contract change. `MatchStream` seeds its live plan from the spec's resolved
    directives so the first shout edits the standing plan. `POST /api/team/plan` (graceful no-key:
    text saved, empty directives + note). UI: a plan textarea + read-only resolved display (reusing
    `describeDirective`) on create-team + `#/tactics`; the 5 sliders are gone. Verified by
    `tools/_plan_test.ts` (18 — persistence, home/away + slot→engine resolution, neutral-human /
    AI-keeps-dials, AI-vs-AI unchanged) + smoke (41). Reviewed; the one finding (slot→engine remap) fixed.
  - **Frontend polish sweep (P1–P7).** Watch connecting/error overlay; typed `ApiError` + network-error
    mapping; removed the `innerHTML` escape hatch from `h()` (XSS hardening) + a11y (focus rings,
    reduced-motion, dvh, meta/noscript); honest no-personality profile state; renderer perf (per-frame
    id→player Map replacing `state.players.find()`, debug logs behind `RENDER_DEBUG`, defensive marker
    prune); typed live-watch socket envelope (`WatchMessage`) + EngineState drift fix (home/awayName);
    market in-app bid/confirm modals (ESC/Enter/backdrop/close-on-nav) + scroll preservation across the
    per-action re-render.
  - **Pre-match opponent scouting report (`scout.ts`, `GET /api/scout?fixture=`, `#/scout/:id`).** For an
    upcoming fixture the user is in: the opponent's table position + last-5 form, a plain-English read of
    how they play (derived from their dials, NOT their plan text — no human team-talk leak), and the top-5
    key players in the likely XI with one danger man flagged. A 🔍 Scout button sits on each upcoming
    fixture row. No engine run. Verified by `tools/_scout_test.ts` (24) + smoke (incl. the scout probe).
    **Deeper scouting (attribute fog):** the report's key players now carry `attrs` — each skill as a
    `{lo,hi}` range that tightens with the club's scout depth (none = hidden, depth 1 = ±7, depth 2 = ±4,
    depth 3 = exact). Read-only; ties the Staff scouts into a concrete payoff.
  - **Season history / honours archive (`history.ts`, `season_history` table, `GET /api/history`,
    `#/history`).** One row per club per finished season, written inside the rollover tx (step 2b,
    BEFORE fixtures are purged + the season counter advances — `recordSeasonHistory`, idempotent via
    `INSERT OR IGNORE` on a unique (team, season) index): final position/record, champion/promoted/
    relegated flags, cup-won (from `cupView` before `createCup` regenerates it), and POTS (read from
    that season's award `player_news`). A History nav button opens a trophy cabinet (titles/cups/
    promotions/seasons) + a season-by-season table with honour badges. Verified by
    `tools/_history_test.ts` (17 — champion/promotion/cup/POTS, most-recent-first, idempotency) +
    smoke (47) + the 8-season multiseason regression (83, rollover unaffected).
  - **Board objectives (`objectives.ts`, teams + season_history columns, `/api/league.objective`).** The
    board sets a season expectation (`deriveObjective` from tier + last finish + promotion/relegation:
    title / promotion / top-half / survival, each a position target met if final ≤ target). Set at club
    creation + each rollover (for the NEW tier); the finished season's target + verdict are archived into
    season_history alongside the honours. The dashboard shows the objective + a live on-track / just-
    outside / work-to-do indicator (from current position); the History screen shows a ✅/❌ Board badge
    per season. No morale/balance effect — purely the season narrative. Verified by `tools/_history_test.ts`
    (30 — derive cases, MET archival, promotion→survival→title progression) + smoke (48) + multiseason (83).
  - **Board confidence / job security (`confidence.ts`, teams.board_confidence, `/api/league.confidence`).**
    0–100 board rating of the manager: drifts ±2 per result (in `processMatchAftermath`, exactly-once per
    fixture) and SWINGS at rollover (`settleConfidenceAtRollover`: relegation −30, promotion +22, objective
    met/missed ±14/16, top-/bottom-third finish ±6, clamped). Status bands secure/stable/under-pressure/at-
    risk; dashboard shows a confidence bar beside the objective. At each rollover the board delivers a
    verdict (`boardVerdictAtRollover`: backed / satisfied / concerned / warned / final-warning), escalating
    via a persisted `low_confidence_streak` when confidence stays at-risk season on season; it rides home in
    `RolloverResult.board` and surfaces as a dashboard toast. No hard sacking yet (taste). Verified by
    `tools/_confidence_test.ts` (23 — bands, drift, settle math + clamp, the champion-soars roll, the verdict
    + escalation ladder) + smoke (49) + multiseason (83).
  - **Backroom staff (`staff.ts`, `staff` table, `/api/staff` + hire/fire).** A shared per-world hire pool
    the club signs coaches/physios/scouts from for a one-off fee (from the transfer budget; no wage gate).
    Effects, each aggregated from a role's combined quality and capped, IDENTITY with no staff (so the
    engine-free regressions are unchanged): coaches ×1.0–1.30 training growth (`developAttrs` coachFactor,
    per-team in `developmentTick`); physios cut injury risk to ×0.55 + add up to +15 recovery (`fitnessTick`);
    scouts reveal +1–3 extra key players (`buildScoutReport`). MAX_STAFF 8; hire guarded on budget + cap.
    Staff screen with an effects panel + your-staff/hire-pool tables. Verified by `tools/_staff_test.ts`
    (23 — pool/hire/fire flow, the effect math + caps, budget/cap guards, the coach + scout integration) +
    smoke (54) + the season/multiseason regressions (identity, unchanged).
  - **Club finances ledger (`finances.ts`, `finance_entries` table, `/api/finances`).** A RECORD-ONLY
    statement of the club's real cash movements — it never moves money (the budget stays the source of
    truth), it logs what already moved. `recordFinance` is a no-op for AI clubs, so the hooks call it
    freely at the money-movement chokepoints: rollover prize (season.ts), club-to-club transfers (both
    sides, in market.ts `transferListed`), free-agent signings (`buyFreeAgent`), staff fees (`hireStaff`).
    `getFinances` returns the balance + this-season income/expense + by-category breakdown + last-25
    movements. Finances screen shows the headline figures + category + recent tables. Because no new
    money is introduced, the economy + the multiseason regression are unchanged. Verified by
    `tools/_finances_test.ts` (14 — record/aggregate, AI no-op, per-season filtering, the buyFreeAgent +
    rollover-prize hooks) + smoke (56).
  - **FM-frontend pass (2026-06-17, roadmap-driven):** Phase 0 — responsive layout (class-driven
    `.grid.cols-*` collapsing ≤860px + a ≤560px phone pass; migrated the 7 inline grids), real club
    names in the renderer goal banner / HT-FT panel (`clipName`), dashboard `Retry` on a team/league
    fetch failure, scoped transfer-window messaging (per-section pills), tightened bid-parse, toast
    `aria-live` region (`.sr-only`), `generatePersonalities` sends a body. Phase 1 (LLM legibility) —
    the press conference renders the per-player `reactions[]` as a 'how it landed' panel patched in
    place (no dashboard rebuild) + `press.ts` now returns an in-character quote per player; the live
    watch reads the standing plan back in the manager's voice (`plan.summary` prose). Phase 2 — a
    dedicated `#/squad` screen (sortable attr table + heat + depth chart + 2-player compare + captain
    badge) and a visual SVG tactics **pitch** (`GET /api/formations` exposes the registry; `svgEl`
    builds it XSS-safely; Shape dropdown re-positions via `setLineup`; plain-English box kept alongside).
    STILL TODO (Phase 3-4): persistent `#/inbox` (archive the advance toasts), conversational team-talk
    + half-time review, in-match subs + live-stats overlay on watch, the signing/contract NEGOTIATION
    flow (offer→deliberation→agent→accept/counter — the LENS exemplar), NL squad/market search, analytics.
  - **Enrichment pass (2026-06-17, audit-driven):** (1) **finances** — wage-bill-vs-budget line + season-over-
    season income/expense/net (both pure reads, no money); (2) **board presence** — `boardMood` (mid-season
    line on the dashboard) + `recruitmentBacking` (boardroom line on the market), pure framing; (3) **verdict
    in history** — the rollover board verdict (tone/message/confidence) persisted on `season_history` +
    shown as a board pill; (4) **harmony → training** — `harmonyFactor` (EXACTLY 1.0 across the settled band
    so regressions are byte-identical; +6%/−8% outside) threaded into `developAttrs`/`developmentTick`, giving
    the read-only harmony card a real consequence; (5) **all-time club records** — pure `getClubRecords`
    reduction over `season_history`. DEFERRED as taste/balance calls: market attribute-fog (changes core
    market UX + the market test), the captain mechanic (needs a set-captain UI), commercial income.
  - **Squad harmony / dressing room (`harmony.ts`, `/api/harmony`).** A READ-ONLY read of how settled
    the squad is, derived from the existing personality dials + morale — it mutates nothing (no balance
    effect): leaders + model pros lift it, big egos who are unhappy or stuck on the bench drag it, as does
    a wide morale spread (a split dressing room). Returns a 0–100 harmony + status (united/settled/restless/
    fractured) + the notable players (leader/pro/disruptive/unsettled), shown as a Dressing-room card on the
    dashboard (click a name → profile). Verified by `tools/_harmony_test.ts` (12 — status bands, each flag,
    the happy-vs-benched ego distinction, disruption drags harmony) + smoke (57).
- **DESIGNED:** the four original pillars + round 5 + injuries/fitness + newgen + cup + morale
  + press conferences + record/replay (Phase 1) + match reports/ratings + transfer windows &
  negotiation + loans + dynamic player-news + ratings→morale & season awards are all SHIPPED.
- **NOT YET (future / awaiting taste):** AI formation choice (it optimises the XI, not the
  shape); deeper scouting (hidden attributes until scouted — the pre-match report now exists);
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
- **AI keeps the default 4-3-3 shape.** AI optimises WHICH 11 start, not the formation —
  picking a shape to suit the squad (the `formations.ts` registry is already there) is a
  future enhancement.

> **Since this doc's ledger was last swept** (kept here so the log stays honest): retirement +
> youth intake **shipped** (`youth.ts`, release/regeneration at rollover) and season history +
> honours **shipped** (`history.ts` + the `season_history` table) — both former "limitations"
> above are done. Also shipped since: the **P1–P4 world drop** — shared worlds + claim-a-club
> (`worlds.ts`), national teams + international tournaments + a Club World Cup (`national.ts`,
> `nations.ts`), the live-match coordinator (`coordinator.ts`), and a turn-based/autonomous world
> scheduler; plus the **structured tactics board** (sliders/formation-picker/role-presets;
> `/api/team/plan-structured`, `/api/lineup/set`) alongside the plain-English plan.

> **2026-08-05 — the verification suite is IN THE REPO now.** Every `tools/_*_test.ts`
> this ledger cites was git-ignored by `.gitignore`'s blanket `_*` scratch pattern,
> never committed, and lost with its session container — the replay-viewer story
> again. Six were recreated from this ledger's own descriptions and committed
> (training 60 / market 179 / season 76 / harmony 83 / ai 66 / http_smoke 145 =
> 609 assertions; `npm run test:game`, `npm run test:smoke`), the ignore pattern
> now carries a `!tools/_*.ts` negation, and each recreated file documents where
> current code has drifted from this ledger (economy curve, wage %, tier budgets,
> the S2.1 offer flow). Still lost, worth recreating next: cup, youth, fitness,
> newgen, contracts, personality, loans.

> **2026-08-05 (later) — suite recreation FINISHED.** cup (119), youth (58),
> fitness (94), contracts (108), loans (62), newgen (44) are all recreated,
> adversarially verified SOLID, and chained into `npm run test:game` — 11 suites,
> **951 assertions**. Only `personality` remains unrecreated (its behaviours are
> partially pinned inside harmony/market). Each suite's header documents the
> ledger-vs-code discrepancies it found; the ones that look like real bugs rather
> than ledger drift: the **diligence sign bug** (model pros decline ~1.4× faster
> than lax ones — `training.ts` applies the professionalism modifier with the
> sign flipped), **optimizeLineup ignores injury/fitness** (`ai.ts` — an AI club
> will field a man at 3% fitness), **playFixture's summary path** skips
> `season_apps`/rating tallies, `seedAcademy` only runs in the signup route (AI
> clubs never restock academies), and contracts' **silent countered-lapse** (a
> countered offer that expires emits no inbox event).

> **2026-08-05 — engine↔web contract audit** (read-only; docs/CONTRACT.md +
> `web/frontend/types.ts` vs the real wire). The one drift corrupting output
> TODAY: **`substitutionLog` has no TypeScript consumer** — engine commit
> 573675e added per-sub `outTally` precisely so substituted players keep their
> stats, but `web/backend/report.ts:130-141` still builds ratings from the final
> frame's 22 slots. Measured seed 151 @90': 26 men played, 22 rating rows, **5 of
> 7 goals credited to the wrong player**, 68 assists/shots/tackles dropped. Fix:
> declare `substitutionLog` in types.ts + CONTRACT.md, fold `outTally` into a
> rating row keyed by the departed man, re-key goal credit by who held the slot
> at goal time. Lesser drift, same audit: types.ts requires 4 fields the engine
> never emits (`Player.homeX/homeY/attrs`, `Ball.vz` — delete or mark optional);
> the MatchEvent union misses `added_time` (which overloads playerId=minute,
> targetId=half) and carries a dead `punch`; **`gk_up_for_corners` is a live UI
> toggle the engine silently discards** (`main.cpp` parseDirectives has no
> branch for it); CONTRACT.md's input block omits the whole `timeline`
> sub-schema and `when.phase`; top-level `tackles`/`passes` are objects while
> the per-player keys of the same name are ints — never type them alike.

> **2026-08-05 — engine anomaly hunt** (24 seeds @45', 7 full traces; per-tick
> proof for each, artifacts were session-local). Three confirmed defects for the
> next balance rounds: (1) the **loose-ball freeze watchdog re-arms off the
> goalkeeper's distance** (`engine_audit.cpp:428` — `bestD` scans ALL players,
> and in 6/6 real fires the arm-time nearest was a GK who then walked off), so
> it fires mid-chase and rolled the ball to the OPPONENT all 6 times; fix by
> excluding keepers from the baseline or re-arming on any per-player approach.
> (2) The **knock-ahead cannot fail**: `engine_shot.cpp:482` releases at ~18.6
> px/s (DRIBBLE_KNOCK_SPEED_ADVANTAGE = −25) against a 53 px/s runner — median
> travel 4.4 px, re-collected in 133 ms, 3489 knocks → 1 turnover, so the risky-
> knock ledger is dead instrumentation. A real knock-into-space needs roughly
> +65, a deliberate balance change (A/B + golden re-baseline). (3) The **GK save
> model's `preventable` gate is unreachable** (`engine_gk.cpp:495` tests ≥0.90
> against a value clamped to GK_SAVE_MAX = 0.76) and 67% of save rolls pin to
> the GK_SAVE_MIN = 0.09 floor where keeper attributes cancel entirely. Also:
> 6–10 dead-ball episodes per match (ball at rest, nobody within 40 px, median
> 1.6 s) — the substrate the watchdog papers over; fix pass weighting, not the
> watchdog. Turnover-burst census re-run post-Round-35: healthy (max 6 flips
> per 5 s window across 7 matches).

> **2026-08-07 — performance round.** The game layer got **3.02x faster** and the
> engine **1.9x** (round one) **+ 1.03x** (round two), all measured, none of it
> guessed. Game layer: `db.ts` had no prepared-statement caching across 504
> `db.prepare()` sites — a transparent LRU cache plus `synchronous = NORMAL`
> (the default's two fsyncs per commit were the single biggest cost, hundreds of
> commits per matchday) took a 30-matchday workload 7519ms → 2486ms, verified by
> a byte-identical whole-DB fingerprint across every variant. The one real hazard
> was `.iterate()` on a shared statement silently advancing another loop's cursor
> — closed by construction and pinned by `tools/_db_test.ts`. Engine: the
> `scorePositioning` candidate loop was recomputing a jitter sinusoid and an
> offside scan per candidate (~150M sin/cos a match), and two atan2 angle-wraps
> that feed only a BOOLEAN were reformulated onto monotone cheaper tests with a
> fallback band (−11.2M atan2 a match). **Every engine change was gated
> BYTE-IDENTICAL 40/40 before being judged on speed** — two correct-but-slower
> changes were implemented, measured and reverted.
>
> **Round three's map, with numbers** (from the round-two profile): `resolveChoice`'s
> sort is still ~23% of a match and the ONLY restructure with headroom is never
> materializing the permutation (capped at ~3–4%, touches every ranked scan);
> `std::hypot` is now the largest libm consumer at **45.6M calls/match** and is
> entirely unexamined — classify its ~40 sites value-producing vs comparison-only,
> the same lens that worked on atan2. `auditBlobPurposes` costs **64M dist() calls
> a match in the SHIPPING build** (recordBlobMoment fires regardless of
> FOOTY_BLOBDEBUG) and can only be gated at the cost of the `blobMoments` summary
> stat — an owner call, since it breaks byte-identity by construction.

> **2026-08-07 — stat attribution is now consistent across all three paths.**
> The substitutionLog bug existed in three places; 031680e fixed reports, and
> this round fixed the `--summary` path (`match.ts`, pure LOSS of every
> substituted man — seed 19960: season_apps 9→11 human, 8→11 AI, players 22→27)
> and the live-watch path (`coordinator.ts`, which would otherwise have become a
> NEW asymmetry: simmed matches crediting everyone, watched ones not). Cached
> pre-fix reports now self-heal via `REPORT_FORMAT_VERSION` on read.
> **Still open, engine-side:** a departed man's yellow is unrecoverable web-side
> (`--summary` carries no frame history and the slot's card count resets at the
> swap), leaving his rating 0.3 too high — the fix is ONE int, `int outYellowCards`
> on `SubstitutionRecord` (engine.h) written at `substituteSlot` (engine_squad.cpp).
> Also latent: the engine's bench is its own fixed reserve-name list rather than
> the club's real bench, so an ARRIVING substitute matches no DB row and his
> contributions cannot be credited to a real player at all.

> **2026-08-07 — two "held for owner taste" AI bugs settled as real bugs.**
> The **diligence sign was flipped**: model professionals declined faster than
> slackers (age 35: pro −1.60 vs lax −0.90 per matchday), contradicting the
> game's own UI copy. Fixed, with neutral personalities byte-identical either
> way. **optimizeLineup ignored injury and fitness** — an AI club would field a
> man at 3% fitness; injury now excludes, fitness weights (a 60%-fit star can
> still beat a fresh reserve), and a fully fit squad repacks byte-identically.
> **Deliberately NOT changed, do not re-litigate without an owner call:** MORALE
> has the same inverted shape diligence did; and the training report's "why"
> string keys off the rounded-OVR delta, so a player whose attributes are falling
> too slowly to move his OVR still reads "learns fast" (216 cases in a sweep) —
> both predate this round.

> **2026-08-07 (round 4) — the suite recreation is FINISHED.** `personality` was the
> last of the fourteen suites lost to `.gitignore`'s blanket `_*`. `npm run test:game`
> now chains **14 suites / 1,204 assertions**. What the personality suite found and
> pinned as CURRENT behaviour (owner to rule, not for a test to assert away): **three
> personality down-cues are dead code and a fourth leaks**, all from substring
> shadowing in the cue table; the **wage formula uses 8% where this ledger says 10%**;
> the **reassure range is ~3..13 where this ledger says 1..15**; and `manager/plan.ts`
> uses 60/40 prose bands against 65/35 directive bands.

> **2026-08-07 — TWO CROSS-TENANT LEAKS, now closed.** Splitting the route monolith
> is what made these visible. `GET /ws/match?fixture=N` had **no ownership check at
> all** — an anonymous socket, or any user in a different world, could stream another
> tenant's private match. `POST /api/shortlist` accepted any global `players.id`, so
> id-scanning read another world's player records. Both reproduced with a two-user
> HTTP/WS exercise before and after. A third, found by a verifier: `market.ts` `loanIn`
> ran its world check AFTER two rejections that interpolate the player's NAME, so
> posting a foreign id told you who he was. **Lesson worth keeping: `players.id` is
> GLOBAL, not world-scoped — any route taking one must check world membership BEFORE
> any error message that names the row.**

> **2026-08-07 — the golden baseline moved for the first time in this session's work**
> (`d9330e30` → `96f4b18a`), for three intended engine fixes measured in isolation.
> The one that changes what you SEE: the loose-ball freeze watchdog re-armed off the
> **goalkeeper's** distance, so a keeper who happened to be nearest when the watch
> armed pinned the baseline and wandering off made "nobody is closing" read true —
> **13 of 13 fires across 60 hours of football landed on top of a live chase**, and 3
> of them handed the ball to a keeper. Now 0 fires, with the watch timer peaking at
> 400ms against its 3000ms trigger. Also: `preventableGoals` is reachable at last
> (threshold keyed off the ceiling, 0.95 picked from a 498-roll census), and
> `outYellowCards` now rides `SubstitutionRecord` so a booked-then-substituted man
> keeps his -0.3 rating dent — the web side reads it as of this round, so that
> follow-up is CLOSED.
>
> **Method note for the next behaviour change:** goals moved +0.375 at 90min x40 and
> it looked real until an independent batch (seeds 141-180) gave −0.25, pooling to
> +0.06 over 80 paired seeds. One batch is not a result. The watchdog fix's own
> effect (`simulationFreezes` 0.325 → 0.000) DID replicate, which is what a real
> effect looks like.

> **2026-08-07 — frontend profiled for the first time.** The boot/head arrow was the
> pitch's largest per-rAF cost: up to 22 Graphics re-tessellations per animation
> frame, and under fast-forward the ~2° dirty-check never engages so every one
> rebuilt every frame. For a non-carrying player the whole drawing is a **rigid
> rotation of one template**, so it is now painted once per pose and rides
> `arrow.rotation` — fill ops/sec −93% at 1x, renderFrame main-thread time −43%.
> Carriers still repaint (boots swing toward the BALL, genuinely two angles).

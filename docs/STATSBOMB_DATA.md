# StatsBomb Open Data — licence, integration, and real-world calibration benchmarks

> **Audience: a coding agent (or human) about to use StatsBomb open data, or real
> football benchmark numbers, to calibrate footy-sim.** This file is the project's
> standing reference. It has three parts:
>
> 1. **What's legal** (the binding licence) — read before touching the data.
> 2. **How the data maps onto this engine** (seams, units, the trace/summary I/O).
> 3. **Real-world benchmark targets** — concrete numbers, with sources, to
>    calibrate the engine against, plus how to compute them yourself.
>
> **This is not legal advice.** For any commercial decision, read `LICENSE.pdf`
> from a fresh clone yourself and talk to StatsBomb (they sell commercial licences)
> or a lawyer.

---

# PART 1 — What's legal

footy-sim is **the match engine of an FM-style game that may become a commercial
product**. That future-commercial intent is why the licence matters: a private
research toy could ignore most of this; a shipped game cannot.

## Bottom line (traffic lights)

| | Activity | Verdict |
|---|---|---|
| 🟢 | Clone locally, **read it for private R&D**: compute distributions, fit an xG curve, derive win-rates, study shapes | **Allowed** (clause 1.1 — research) |
| 🟢 | Use the findings to **hand-tune / sanity-check the engine** in development; build the `tools/` calibration harness | **Allowed** for private/non-commercial work |
| 🟢 | Publish analysis/insights (a chart, a write-up) | **Allowed, but you must show the StatsBomb logo** (clause 1.4) |
| 🔴 | Commit any StatsBomb JSON (events / lineups / 360 / `competitions.json`) into this repo | **Prohibited** (1.2.1) |
| 🔴 | Ship or commit **real player/club/competition names or per-player ratings derived from the data** | **Prohibited** (1.2.1, 1.2.2, 7) |
| 🔴 | Ship a **derived data table** as a product asset (an xG coefficient file, reference-stats file, archetype lookup) | **Prohibited** (1.2.2, 7) |
| 🔴 | Sell / paywall anything that **is** the data or an analysis of it (a "classic matches" pack, a stats product) | **Prohibited** (1.2.2) |
| 🟠 | Ship, **in a commercial build**, engine *constants* that were **fitted directly to** StatsBomb data | **Legally ambiguous → treat as needing a commercial licence.** See "The amber zone". |

**The safe strategy:** keep StatsBomb strictly in the **private calibration /
validation layer**. Let it *measure and inform* the engine; never let it *become*
shipped content. The benchmark numbers in Part 3 below are mostly from **public,
non-StatsBomb analytics sources** (Opta/FBref/CIES/etc.), which sidesteps the
licence for the targets themselves — only the act of computing your own numbers
*from the StatsBomb files* is governed by the licence.

## What the binding licence actually says

Two documents, not equal:

1. **`README.md`** says only: *"…please state the data source as StatsBomb and use
   our logo."* This casual line is **not** the licence.
2. **`LICENSE.pdf`** — the *StatsBomb Public Data User Agreement, Standard Terms*
   (last updated **8 September 2023**, laws of **England & Wales**). **Binding, and
   far more restrictive than the README.**

Key verbatim clauses (read in full 2026-06-16):

- **1.1** — access *"to be used for analysis, research and to facilitate the shared
  ideas & understanding of the data."* A **research tool**.
- **1.2 The User may not:** **1.2.1** *"edit, distort, distribute, reproduce, sell
  or in any way provide the data to any external or third party"*; **1.2.2**
  *"commercially exploit the data or any analysis derived from the use of the
  Service"* ← **the commercial gate**; **1.2.5** no reverse-engineering the Service.
- **1.4** — *"required to accredit any publication of analysis formed from
  StatsBomb Data with the StatsBomb brand logo."*
- **2.2** — StatsBomb *asks* every user to register name + email at
  <https://statsbomb.com/resource-centre>.
- **3.x / 5.x** — provided **"as is"**, no warranty, no liability.
- **7 (IP)** — *all data is the property of StatsBomb*; no modify/translate/transfer/
  distribute/license/sell/exploit *"without the express prior written consent of
  StatsBomb."*
- **2.1 / 6** — StatsBomb may withhold or suspend access **at any time without notice.**

### The amber zone

Clause 1.2.2 forbids commercially exploiting *"any analysis derived from the use of
the Service"* — a **broad** phrase. The spectrum:

- **Clearly fine:** general understanding gained from the data, applied to
  hand-tune the engine.
- **Clearly not fine:** shipping the data, real ratings, real names, or a derived
  lookup table.
- **Ambiguous (amber):** a constant *mechanically fitted* to StatsBomb data, then
  written into the commercial binary.

**Policy:** treat amber as **red for any commercial build.** Either obtain a
commercial licence, or re-derive that target from a **permissively-licensed or
self-collected dataset** before it ships. For private/non-commercial builds, amber
is fine. Always leave a provenance comment (Hard rule #5).

## Hard rules for a coding agent in this repo

1. **Never add a StatsBomb data file to the repo.** Keep your clone **outside** the
   tree (e.g. `C:\data\statsbomb-open-data\`) and point scripts at it via an env
   var (`SB_OPEN_DATA_DIR`), never an in-repo path.
2. **Never commit a derived data artifact** (fitted xG tables, reference-stats
   files, archetype/rating tables). They live only in a **gitignored** area. The
   repo's `.gitignore` already swallows `tools/_*.py`, `_*`, `*.bin`, `*.jsonl`,
   `*_summary.json`, `audit*.json`. **Convention: put all StatsBomb-derived working
   files under `tools/_sb/`** (gitignored by the `_*` rule).
3. **Keep the shippable surface anonymous and procedural.** The data that ends up
   in a build flows through one seam:
   `web/backend/game.ts (genAttrs)` → `web/backend/match.ts (buildSpec)` →
   `spec.json` → `engine/main.cpp:15 loadTeam()` → the binary. Do **not** populate
   any *committed/shipped* `spec.json`, the SQLite seed, or `formations.ts` with
   real names/ratings. (Tuning the generator's role-bias *magnitudes* from
   anonymous distributions is fine; shipping specific real players is not.)
4. **Calibration scripts may be committed; the data they read may not.** A
   `tools/calib_*.py` reads from `$SB_OPEN_DATA_DIR`, embeds **no** real-team/player
   tables, and computes reference numbers at run time.
5. **Provenance-tag any data-informed constant**, e.g.:
   ```cpp
   // CALIB(statsbomb): re-derived from open-data shot conversion, 2026-06-xx.
   // Amber under LICENSE.pdf 1.2.2 for a commercial build — re-source before sale.
   inline constexpr double SHOT_SCOOP_CHANCE = 0.80;
   ```
6. **Attribution + registration.** Publishing analysis ⇒ show the **StatsBomb logo**
   (1.4). Register name + email (2.2).
7. **When in doubt, it stays in `tools/_sb/` and out of the binary.** Measuring is
   always safe; shipping the measurement is what bites.

---

# PART 2 — How the data maps onto this engine

StatsBomb is **on-the-ball event data**: events with `[x,y]` locations,
`shot.statsbomb_xg` on every shot, a per-shot `freeze_frame` of visible players,
and (for 12 of ~91 seasons) StatsBomb 360 positional snapshots. It has **no
continuous tracking and no ball physics** — so it validates *outcomes and
positions*, not your curl/chip/keeper-speed model. That makes it a **calibration
oracle**, which is the engine's biggest gap: today the only enforced behavioural
target is the determinism golden; every realism number is "tuned by feel."

## Coordinate & unit conversion (the #1 footgun — get this right first)

| Quantity | StatsBomb | This engine |
|---|---|---|
| Pitch grid | `120 × 80` coordinate units | `1050 × 680` **pixels** (`PITCH_W`/`PITCH_H`, `constants.h`), 10 px = 1 m |
| **Location** x → px | — | `x_px = x_sb × 8.75` (1050/120) |
| **Location** y → px | — | `y_px = y_sb × 8.5` (680/80) |
| Attacking goal | `(120, 40)` | `(1050, 340)` — home attacks **+x**; away mirrors as `x_engine = 1050 − x` |
| Shot distance bands | (compute from location) | `<100 px` close, `<200 px` medium, else long (`stats.cpp:34`) — i.e. **<10 m / <20 m** |

> ⚠️ **`pass.length` / `carry` / shot length are in StatsBomb coordinate units
> (≈ yards), NOT metres.** (An earlier note here said metres — that was wrong.) The
> `120×80` grid is a normalised model of the pitch (penalty-area markings fixed,
> midfield stretched), so a "unit" ≈ 1 yard ≈ 0.9144 m but is **not** exact.
> **Locations** convert grid-to-grid cleanly (`×8.75`, `×8.5` above — independent of
> the yard/metre question because it's just 120→1050, 80→680). **Length scalars** do
> not: to use `pass.length`, convert via the grid scale (`length_units × 8.75 ≈ px`,
> `≈ 0.875 m/unit`), and **verify the unit in `doc/StatsBomb Open Data
> Specification v1.1.pdf` in your clone.** SB normalises every team to attack +x,
> matching the engine HOME frame.

## The two engine I/O surfaces a calibration harness uses

- **`--summary` JSON** (last line of `build/live.exe … --summary`) — **per-match**
  raw counters: `homeScore`/`awayScore`, `saves`, `shots`, `passes`,
  `passCompletionPct` (+ fwd/side/back split), `shotsByDistance{close,medium,long}`,
  `goalsByDistance{…}`, `crossesCompleted`, `throughBallCompletionPct`, offsides,
  cards, per-player stats, etc. **`tools/native-batch.ts`** runs this over many seeds
  and aggregates into the **rates** a scorecard checks (`goalsPerMatch`,
  `shotsPer90`, `shotsOnTargetPct`, `goalsPerShotPct`, `savePct`, `tackleWinPct`,
  `tacklesAttemptedPerMatch`, `penaltiesAwardedPerMatch`, …). **So the scorecard
  consumes `native-batch` output, not raw `--summary` directly** — still a pure
  consumer, zero engine change. (Field names here are indicative — confirm against
  `engine/stats.cpp` and `tools/native-batch.ts` before wiring; the "engine field"
  column in Part 3 is a per-match raw counter or a native-batch rate accordingly.)
- **`--trace out.bin`** — a binary, **per-tick (60 Hz) freeze-frame of all 22
  players + the ball + tagged events**. Read with `tools/trace_reader.py`. This is
  what makes **xG-shape validation** possible: reconstruct the engine's own
  freeze-frame at each shot instant and bin conversion by chance-quality features,
  the way StatsBomb's `freeze_frame` feeds `statsbomb_xg`.

  *Verified working* — a 5-min trace (`live.exe 101 5 --summary --no-debug --trace
  out.bin`, 21,600 frames / 284 events) reconstructs the shot moment exactly:
  ```
  shot t=38184ms  shooter=#9  loc=(849,340)
  ball  x=869 y=334 z=0.0
  home XI: (0,127,340)(1,487,86)(2,535,286)(3,433,369)(4,481,586)
           (5,840,263)(6,819,381)(7,821,446)(8,900,271)(9,848,340)(10,901,309)
  away XI: (11,995,339)(12,923,265)(13,842,319)(14,920,306)(15,946,357)
           (16,805,323)(17,867,346)(18,901,361)(19,860,161)(20,813,360)(21,658,557)
  ```
  From this you can count defenders in the ball→goal cone — the first-order feature
  StatsBomb's xG uses.

  > ⚠️ A 90-min trace is ~0.8 GB and matches `*.bin` in `.gitignore`. Write traces
  > to a scratch/temp path, never the repo. Always pass `--summary` (without it the
  > binary streams frames forever and locks itself).

## The golden-guard tripwire

The engine is deterministic and `tools/tactics_golden.py` hashes the default
(no-directive) match across 7 fixed seeds. **Any** change to a default-path
constant (`SHOT_SCOOP_CHANCE`, `finishChance`, pass geometry, the default 4-3-3
anchors) **or even a new `--summary` field** breaks that hash — re-baseline
deliberately. A pure scorecard / `--trace` harness touches none of this.

---

# PART 3 — Real-world benchmark targets

All numbers below are **published real-football benchmarks** (predominantly
**men's top-5 European leagues, ~2018–2025**, Premier League where a single clean
figure was needed) with the source and the engine field/lever each calibrates.
Use them as **bands, not point values** — football varies by league, era and
definition (see the Definition Traps and Men/Women & Era sections).

## 3.0 — The central calibration identity (read first)

Four shooting levers are **coupled**; you cannot tune one in isolation:

```
goalsPerMatch  ≈  shotsPerMatch × shotsOnTarget% × (1 − savePct)
   ~2.7        ≈     ~25        ×     ~0.33       ×   (1 − 0.69)
```
and equivalently `avg_xG_per_shot (~0.10–0.11) × shots_per_team (~13) ≈ 1.4 goals/team`.

**The headline finding for this engine:** real **GK save% over *on-target* shots is
~68–70%**, but the engine's keeper saves **~83%** (per the keeper-tracker memory).
That ~13pp gap is almost certainly *why the offense-only goal ceiling sits at ~2.1
vs a realistic ~2.75*. **Before touching `SHOT_SCOOP_CHANCE` or `GK_SAVE_MAX`,
re-measure the engine's `savePct` over StatsBomb's exact denominator** — `savePct =
saves / (saves + goals)` over **on-target** shots only (`shot.outcome ∈ {Saved,
Goal, Saved to Post, Saved Off T}`, excluding `Blocked / Off T / Wayward / Post`).
If the engine's 83% is measured over *all* shots faced, it isn't comparable.
`GK_SAVE_MAX = 0.80` is fine as a per-shot **cap**; the **mean** must fall to ~0.69.

## 3.1 — Shooting, conversion & xG

| Metric | Target | Band | Engine field / lever | Source | Caveat |
|---|---|---|---|---|---|
| Goals/match (both teams) | **2.75** | 2.5–3.0 (PL 23-24 spike 3.28; women ~3.0+) | `goalsPerMatch` | Opta/The Analyst | Pick an era; women's higher |
| Goals/team/match | 1.4 | 1.2–1.65 | `goalsPerMatch` ÷ 2 | Opta | Home scores ~0.2–0.3 > away |
| Shots/team/match | **13** | 12.3–13.7 (both teams ~25–26) | `shotsPer90` | Opta/FBref | Opta "shots" include blocked |
| Shots on target % (of ALL shots) | **34%** | 32–37% | `shotsOnTargetPct` | Opta/FBref | **Trap: PL "accuracy" excl. blocked ≈ 45–50%** |
| Conversion (goals/shot, all shots) | **11%** | 9.5–12% (non-pen ~10%) | `goalsPerShotPct` | Opta (PL 1071/9747) | Penalties (~76%) lift it slightly |
| Conversion — close `<10m` (6-yd) | **~33%** | 25–45% | close band `finishChance`/`SHOT_SCOOP_CHANCE` | StatsBomb/ASA (triangulated) | Highly angle-dependent |
| Conversion — medium `10–20m` | **~11%** | 8–15% | medium band `finishChance` | StatsBomb/PL | Avg of band ~0.08–0.12 xG |
| Conversion — long `>20m` | **~3.5%** | 2.5–5% (outside box 4.2%) | long band; `goalsByDistance{long}` | PL 24-25 | `>20m` is *farther* than box edge ⇒ low end |
| Avg xG per shot | 0.10 | 0.09–0.12 | (no xG model; implied mean) | Soccerment | Equivalent to ~11% conversion |
| Big-chance / 1v1 conversion | ~40% | 35–45% | clear-chance `finishChance` (dribble-round-GK, chip) | Opta | A clean 1v1 ≈ 0.35–0.40 xG |
| Penalty conversion | **~78%** | 73–84% (xG 0.78) | `1 − PENALTY_SAVE_BASE − miss%` | StatsBomb/FiveThirtyEight | Add ~5–7% off-target miss (below) |
| Goal share inside / outside box | **88% / 12%** | outside 11–20% (era) | `goalsByDistance` share | Opta/PL | Long-band goal share ~10–15%, not higher |
| Headed-goal share | ~16% | 13–24% | header counters | Football365/Opta | Headers convert **lower** per shot (ASA −0.65 log-odds) |
| Mean shot distance | 14.9 m (~149 px) | 13.6–16.1 m | `shotsByDistance` distribution | Opta/PL | ~2/3 of shots inside box, ~1/3 outside |

**Distance-band conversion ladder (the key shooting calibration):** close `<100px`
≈ **30–35%**, medium `100–200px` ≈ **9–12%**, long `>200px` ≈ **3–4%**.

## 3.2 — Passing, possession & tempo

| Metric | Target | Band | Engine field / lever | Source | Caveat |
|---|---|---|---|---|---|
| Pass completion % (overall) | **82%** | 80–87 team; top sides 88–91; women ~78 | `passCompletionPct` | FBref/arXiv 2506.22119 | League avg ≠ elite-team avg |
| Short-pass completion (`~<10m`) | ~90% | 88–93 | close-band pass geometry | FBref | FBref "short" = 5–15 yd, ≈ but ≠ engine band |
| Medium-pass completion (`10–20m`) | ~85% | 83–88 | medium-band pass geometry | FBref | overlaps engine band |
| Long-pass completion (`>20m`) | **~55%** | 47–62 (Opta >35yd "long ball" = 47%) | long-band pass geometry | Opta/SI | The biggest direct-play realism lever |
| Direction split (F / S / B) | ~47 / 38 / 17% | F 40–55, S 30–40, B 12–22 | `passCompletionPct` fwd/side/back | Opta | **Forward completes lower than back/side** |
| Passes/team/match | ~440–470 | 390–570 (style) | (derived — sanity check) | Opta | Trending down as PL gets direct |
| Passes per possession/sequence | 4.7 | ~3.5–5.5 (≈9.5s, ≈12m upfield) | tempo sanity check | Opta | Heavily right-skewed |
| Possession % | 50 (by construction) | team spread **35–65** | `possession%` | FBref | **Validate the SPREAD, not the trivial 50 mean** |
| PPDA | high-press 7–9, mid 10–13, low-block >15 | — | **needs new counter** (press intensity) | PL/Opta | Definition varies (40% vs 60% zone) |
| Cross completion (open play) | **~23.5%** | 18–25 (set-piece 34) | `crossesPerMatch` + collection gates | StatsBomb | Cross→goal ~1.6–1.8% (1 in ~60) |
| Through-ball completion | ~50% | 40–60 (weakly sourced) | `throughBallCompletionPct` | FBref convention | Set **well below** overall completion |

## 3.3 — Defending & duels

| Metric | Target | Band | Engine field / lever | Source | Caveat |
|---|---|---|---|---|---|
| Tackle win % | **~55%** (ball-won) | 50–65; "true tackle" 65–72 | `tackleWinPct` | Opta/FBref/StatsBomb | **Trap: two definitions** (won-ball vs got-a-touch); providers diverge ±30% |
| Take-on / dribble success | **~37%** (retain+advance) or ~50–55% (beat-man) | 36–60 | dribble conversion | Opta/The Analyst | **Trap: pick the engine's success condition** |
| Defender stops dribbler | ~50–60% | elite 80–87%, poor ~32% | 1v1 take-on resolution | Opta/PL | Mirror of take-on success |
| Aerial win % (population) | 50% | 49–51 | header counters (conservation check) | structural | One winner per duel |
| Aerial win % — CB | ~60% | 55–65 (elite 70–78) | header split by role + `height` attr | StatsBomb | CBs self-select duels |
| Aerial win % — striker | ~48% | 40–55 (target-men 55–65) | header split by role | StatsBomb | Wide by archetype |
| Aerial win % — full-back/wide | ~47% | 42–55 | header split by role | StatsBomb (inferred) | Sparse public data |
| Interceptions/team/match | ~9 | 7–11 | **needs new counter** `interceptionsPerMatch` | FBref | Anti-correlated w/ possession |
| Blocks/team/match | ~4 (shots+passes) | 2.5–6 (shots-only ~1–2) | **needs new counter** `blocksPerMatch` | FBref | Confirm shot vs pass split |
| Clearances/team/match | ~20 | 12–30 (possession-driven) | **needs new counter** `clearancesPerMatch` | FBref/FotMob | Range matters more than central |
| Ball recoveries/team/match | ~48 | 40–58 | **needs new counter** `recoveriesPerMatch` | StatsBomb/Hudl | Largest defensive-event class |
| Pressures/team/match | ~150 | 110–220 (style) | **needs new counter** (advanced) | StatsBomb | Proprietary; only if modelling press |
| Pressure→regain (≤5s) | ~30% | 25–33 | press→turnover rate | StatsBomb | SB-specific definition |
| Tackles attempted/team/match | ~17 | 14–20 | `tacklesAttemptedPerMatch` | FBref-derived | Known engine debt ("tackle volume") |
| Fouls/team/match | **~10.5** (PL) | 8.4–17 (La Liga/Serie A ~13.3) | feeds `cards` + `penaltiesAwardedPerMatch` | CIES | Strong league/referee effect |

## 3.4 — Set pieces, discipline & goalkeeping

| Metric | Target | Band | Engine field / lever | Source | Caveat |
|---|---|---|---|---|---|
| Penalty conversion | **~78%** | 73–84 (xG 0.78) | reconcile `PENALTY_SAVE_BASE` + miss% | StatsBomb/Sportingpedia | See note below |
| Penalty save % (GK) | **~16%** | 12–22 (elite ~28) | `PENALTY_SAVE_BASE = 0.16` ✔ well-anchored | rg.org/Opta | + ~5–7% off-target misses |
| Corners/team/match | ~5 (total ~10) | 4.5–5.5 | **needs new counter** `cornersPerMatch` | StatMuse | — |
| Corner→goal conversion | ~3% | 2.4–4 (elite 2–4×) | off-corner header `finishChance` | Opta/StatMuse | Set-piece era pushing up |
| Direct free-kick conversion | ~6% | 5–7 (specialists 12–15) | **needs new mechanic** (DFK shot) | Opta/SQAF | Declining long-term |
| Set-piece goal share (excl. pen) | **~28%** | 21–30 (decade ~22, rising) | system-level: ~70–75% open play | bet365/Opta | +pens ≈ 33% |
| Fouls/match (both teams) | ~21 | 19–24 | feeds `cards`/penalties | StatMuse | La Liga/Serie A higher |
| Yellow cards/match (both) | **~3.7** | 3.0–5.3 (recent ↑) | `cards` (yellow rate) | StatMuse | La Liga/Serie A ~4.5–5.5 |
| Red cards/match (both) | ~0.18 | 0.12–0.25 | `cards` (red rate) | MyFootballFacts | ~1 red per 5–7 matches |
| Offsides/team/match | **~1.85** (total ~3.7) | 1.3–2.3 | `offsidesPerMatch` ✔ | StatMuse | High-line teams 2.2+ |
| **GK save % (on-target)** | **~69%** | 65–72 | `savePct` ⚠️ **engine ~83% too high** | FBref/Opta | The keeper re-anchor (see 3.0) |
| PSxG − GA (shot-stopping) | ~0 (neutral) | −0.3..+0.5 /90 | (needs xG/PSxG model) | Opta | Avg keeper is PSxG-neutral |
| Crosses/team/match | ~19 (incl. SP) or ~10–14 (open play) | 18–26 | `crossesPerMatch` | Soccerment | Confirm what the counter includes |
| Penalties awarded/match | ~0.27 | 0.20–0.40 (post-VAR ↑) | `penaltiesAwardedPerMatch` | FBref | Contributes ~0.20 goals/match |

**Penalty reconciliation:** `PENALTY_SAVE_BASE = 0.16` matches the PL keeper save
rate exactly. But xG 0.78 / ~78% scored means ~22% are *not* scored = ~16% saved
**+ ~5–7% off-target/post**. If the engine models only keeper saves, **add a
~5–7% miss-the-target rate** so net penalty conversion lands ~76–79% (not ~84%).
Let `+ skill` push elite keepers to ~22–25% saved.

## 3.5 — StatsBomb open-data specifics (for the compute-it-yourself path)

- **Events/match:** ~3,400 (StatsBomb's own figure) — mostly passes/ball-receipts/
  carries/pressures. footy-sim lacks those event classes, so a like-for-like total
  is much lower. **Granularity check only, not a target.**
- **Penalty xG = 0.78** (StatsBomb 2022 model; most other models use 0.76). All
  penalties get the same static value (no shooter skill).
- **xG by location (context-blended):** central 6-yd ≈ **0.45** (0.3–0.65),
  edge-of-box central ≈ **0.07** (0.04–0.12), long-range >20–25 m ≈ **0.03**
  (0.02–0.05). The real model is freeze-frame-dependent and swings widely — use
  these as *context-averaged* `finishChance` targets per band, not constants.
- **xG model features:** distance, angle, body part, assist/prior-action type,
  **goalkeeper position + status**, all attacker/defender locations in frame, shot
  **impact height**. (This is the freeze-frame context the engine lacks.)
- **360 coverage:** 12 of ~91 competition-season rows (~13%, June 2026):
  WC 2022, Euro 2020 & 2024, Women's Euro 2022 & 2025, Women's WC 2023, La Liga
  2020/21, Ligue 1 2021/22 & 2022/23, Bundesliga 2023/24, MLS 2023, AFCON 2023.
- **Clean league-wide releases (use these for distributions):** the **2023 women's
  five-league release** (NWSL 2023 + WSL/Serie A/Frauen-Bundesliga/Liga F 2023/24 =
  **~771 matches, 62 teams, ~1,500 players** — the cleanest domestic sample),
  **World Cup 2018 & 2022** (64 each), **Euro 2020 & 2024** (51 each).
- **Do NOT use for league-average distributions (biased):** the Messi/Barcelona La
  Liga run (one elite attacking team), Champions League finals (highlights only),
  Arsenal Invincibles, etc. — they inflate shots/goals/possession.

## 3.6 — Priority targets (wire these into a scorecard first)

The highest-leverage bands that are **checkable from today's `--summary`** AND
attack a known engine debt:

1. `goalsPerMatch` → **2.5–3.0** (the headline target; currently capped ~2.1)
2. `savePct` (on-target denominator!) → **65–72%** (engine ~83% — the root cause)
3. `goalsPerShotPct` → **9–12%**
4. `shotsPer90` → **12–14** per team
5. `shotsOnTargetPct` → **32–37%** (match the denominator)
6. `passCompletionPct` → **80–84%** league-average team
7. Distance-band conversion ladder → close **30–35%** / medium **9–12%** / long **3–4%**
8. `offsidesPerMatch` → **~1.85/team**
9. `penaltiesAwardedPerMatch` → **0.20–0.35** ; penalty conversion **76–79%**
10. `tacklesAttemptedPerMatch` → **16–18** ; `tackleWinPct` → **~55%** (50–65 band, won-ball def.)
11. Yellow `cards` → **3.5–4.0/match** ; red **~0.15–0.20/match**
12. `crossesPerMatch` (confirm open-play vs total) ; cross→goal ~1.6%

Make them **WARN bands, not hard CI gates**, or natural tuning drift will spam
failures. Metrics marked "needs new counter" in 3.3/3.4 (interceptions, blocks,
clearances, recoveries, corners, fouls, PPDA) are valuable but require a
`StatsCollector` addition → a golden re-baseline.

## 3.7 — Definition traps (these cause silent miscalibration)

1. **Save% denominator:** `saves/(saves+goals)` over **on-target** shots ≈ 69%.
   Over *all* shots faced, "83%" can look plausible but isn't comparable. **Fix
   this before trusting the engine's keeper number.**
2. **Shots-on-target %:** conventional `SoT / ALL shots` ≈ 33–35%; the PL.com
   "accuracy" stat excludes blocked from the denominator ≈ 45–50%. Match the
   engine's denominator.
3. **Shot count:** Opta "shots" include blocked (~13/team); FBref non-blocked runs
   lower. Decide which the engine mirrors.
4. **Conversion** includes penalties (~76%); non-penalty overall ≈ 10%.
5. **Tackle success:** "won the ball" (~50%) vs Opta "true tackle / got a touch"
   (65–72%). Tackle counting is the **least standardised** stat across providers
   (±30%) — anchor loosely.
6. **Dribble success:** Opta "retain + advance" 36.7% vs StatsBomb/FBref "beat your
   man" ~50–55%. Pick the one matching the engine's success condition.
7. **Blocks/crosses:** "Blocks" may bundle shot+pass blocks; "crosses" may include
   set pieces. Confirm scope before anchoring.
8. **Length units:** `pass.length` is StatsBomb units (≈ yards), **not metres**
   (see Part 2).

## 3.8 — Men/women & era adjustments

- **Women's leagues** (the 771-match release) run **~3.0+ goals/match** vs men's
  ~2.7, with **lower pass completion** (top ~78% vs ~82%) and a wider top-to-bottom
  spread. If you calibrate to the women's open data, target ~3.0 goals, not 2.75.
- **Era (men's PL):** goals/match rose 2.82 (21-22) → 3.28 (23-24); outside-box
  goal share fell ~20% (2006-07) → ~11.5% (record low) as teams chase higher-xG
  chances; **cards up** sharply (2024-26 yellows ~4.3–5.3/match vs ~3.0 historic);
  **penalties up** post-VAR (~0.20 → 0.30–0.40); **fouls and direct-FK goals down**;
  passing volume up ~10–15% since 2010.
- **League:** Premier League is the **lenient outlier** on fouls/cards; La Liga &
  Serie A run ~13/team fouls and ~4.5–5.5 yellows/match. Bundesliga is a
  penalty-conversion outlier (~69%). **Tag every target with the gender + era +
  league of its source competition** and pick the "feel" you want.

## 3.9 — Compute these yourself from the open data (recipes)

Read events from `$SB_OPEN_DATA_DIR/data/events/<match_id>.json`; filter to a clean
league-wide competition (3.5). All open-play unless noted (`shot.type`/`pass.type`
filters exclude set pieces/penalties). **Two universal gotchas:** (a) **exclude
penalty-shootout events (`period==5`)** from every aggregate; (b) StatsBomb fields
are **event-type-conditional** — most keys are absent unless relevant, so read
defensively and treat a missing key as its "default" outcome.

- **Goals/match, shots/match, conversion:** count `type=='Shot'` with
  `shot.outcome.name=='Goal'`, **plus own goals** (`type=='Own Goal For'`);
  on-target = outcome ∈ {Goal, Saved, Saved to Post, Saved Off Target}; conversion =
  goals / shots. Per-band: bin `shot.location` distance-to-`(120,40)`, convert to
  the engine's pixel bands (`×8.75/×8.5` → `<100/<200 px`).
- **Save%:** `saves / (saves + goals)` over **on-target** shots only (exclude
  Blocked/Off T/Post/Wayward and penalties). Cross-check via `Goal Keeper` events
  (`goalkeeper.type ∈ {Shot Saved, Save, Penalty Saved}`). This is the one to
  compare against the engine's re-measured `savePct` (expect ~0.67–0.70).
- **Pass completion by length/direction:** `type=='Pass'`; completed = `pass.outcome`
  **absent** (Incomplete/Out/Pass Offside are explicit failures); band by
  `pass.length` (in **yards** — `×0.9144` → m, `×10` → px); direction from
  `pass.angle` (0 = +x toward attacking goal): forward `|angle|<π/4`, backward
  `|angle|>3π/4`, else sideways; `under_pressure` splits pressured vs not.
- **Penalty conversion / save:** `shot.type=='Penalty'` (exclude `period==5`); scored
  vs `Goal Keeper` outcome `Penalty Saved`; off-target = outcome `Off T`/`Post`/
  `Wayward`. Each penalty also carries `shot.statsbomb_xg ≈ 0.78`.
- **Duels / take-ons / aerials:** `Duel` `duel.type=='Tackle'` (outcome Won/Success
  vs Lost) for tackle win%; `Dribble` (Complete/Incomplete) for take-on% (the
  "beat-your-man" ~50–55% definition; require retain+progress to approximate Opta's
  37%); aerial-won is encoded via `clearance.aerial_won` / `pass.aerial_won` /
  `shot.aerial_won` (the `Duel` `Aerial Lost` marks only **losses**) — split by
  `lineups.json` position for the CB ~60% vs FB/forward ~47% role spread.
- **Fouls / cards / offsides / penalties awarded:** `Foul Committed`;
  **cards = sum of `foul_committed.card` AND `bad_behaviour.card`** (Yellow / Second
  Yellow / Red); offsides = `type=='Offside'` **plus** `pass.outcome=='Pass Offside'`;
  penalties = `shot.type=='Penalty'` **plus** `foul_won.penalty==true` (awarded but
  not taken).
- **Set-piece goal share:** group goals by `play_pattern` (From Corner / Free Kick /
  Throw In) vs Regular Play / From Counter.
- **xG sanity (the calibration identity):** sum `shot.statsbomb_xg` ≈ goals over a
  large sample (model is calibrated to ~1.0); bin shots by xG decile and confirm
  realized goal frequency matches — then mirror the same binning on the engine's
  reconstructed `--trace` shot freeze-frames.

> Keep every number you compute, and any script output, under gitignored
> `tools/_sb/`. Commit only the *methodology* (a `tools/calib_*.py` that reads
> `$SB_OPEN_DATA_DIR`), never the derived numbers as a data file (Hard rules #2/#4).

## Recommended first move

1. **Unit harness** (`tools/_sb/`): pin `120×80 → 1050×680` (`×8.75`, `×8.5`), the
   goal-mouth/x-mirror alignment, and the yards-vs-metres length convention. ~½ day.
   Prevents silent corruption of everything downstream.
2. **Re-measure `savePct` over StatsBomb's on-target denominator** — this single
   check likely explains the 2.1-goal ceiling and tells you whether the keeper or
   the finishing dials need to move.
3. **League-distribution scorecard** (`tools/calib_scorecard.py`): the Part 3.6
   WARN-bands over the counters `native-batch.ts` already emits. ~1 day, **zero
   engine change**, fully licence-safe (reference numbers computed at run time from
   `$SB_OPEN_DATA_DIR`, never committed).

This converts the engine's biggest weakness ("tuned by feel, one enforced target")
into "tuned to a real league" — entirely inside the private calibration layer.

---

## Provenance & sources

- **Binding terms:** `LICENSE.pdf` from `statsbomb/open-data` — *Public Data User
  Agreement, Standard Terms, last updated 8 September 2023*, laws of England &
  Wales. Read in full 2026-06-16. README attribution line: `README.md`, same repo.
- **Codebase anchors** (verified 2026-06-16): `main.cpp:15` (`loadTeam`), `:133–136`
  (CLI flags), `constants.h:161/164/175` (`PENALTY_SAVE_BASE`, `SHOT_SCOOP_CHANCE`,
  `GK_SAVE_MAX`), `engine_gk.cpp:209/212`, `engine_actions.cpp:851`,
  `stats.cpp:34/162/174`, `tools/trace_reader.py`, `.gitignore`.
- **Benchmark sources** (public analytics — these are *not* StatsBomb data and may
  be cited freely; numbers are bands, spot-verify against live tables for precision):
  - Opta / The Analyst — goals/shots/conversion, playing styles, definitions:
    <https://theanalyst.com/articles/numbers-behind-premier-league-goal-explosion>,
    <https://theanalyst.com/articles/playing-styles-top-five-european-leagues-stats>,
    <https://theanalyst.com/articles/opta-football-stats-definitions>
  - Premier League.com — inside/outside-box conversion, PPDA, defenders v dribbles:
    <https://www.premierleague.com/en/news/4272809>
  - StatsBomb / Hudl — xG, crosses, pressures, xPass, women's release, data spec:
    <https://statsbomb.com/articles/soccer/new-statsbomb-radars-2023-update/>,
    <https://www.hudl.com/blog/expected-goals-xg-explained>,
    <https://blogarchive.statsbomb.com/articles/soccer/how-low-can-you-go-assorted-thoughts-about-crosses/>
  - FBref / StatsPerform — league passing/shooting/keeper/defense tables:
    <https://fbref.com/en/comps/Big5/> (note: returns HTTP 403 to automated fetch;
    figures are well-established multi-season norms, verify live for one-decimal precision)
  - CIES Football Observatory — fouls by league: <https://football-observatory.com/Foul-analysis-at-big-5-league-level-from-2219>
  - FiveThirtyEight / Sportingpedia — penalty conversion: <https://www.sportingpedia.com/2025/07/03/penalty-kick-statistics-for-the-2024-25-season-across-major-european-leagues/>
  - Soccerment — shot quality, crossing: <https://soccerment.com/shot-quality-and-results-in-football/>
  - American Soccer Analysis — xG by body part/zone; Carstens et al. arXiv 2506.22119
    (men/women pass completion, 13,018 matches 2020-2025): <https://arxiv.org/abs/2506.22119>
- **Terms can change and access can be withdrawn (clause 2.1).** Re-read
  `LICENSE.pdf` from a fresh clone before relying on specifics for any commercial
  decision. Benchmark numbers reflect ~2018–2025 men's top-5 leagues unless tagged
  otherwise — re-pull for the era/league/gender you actually target.

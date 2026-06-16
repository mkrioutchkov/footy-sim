# StatsBomb Open Data — what's legal, and how to use it with footy-sim

> **Audience: a coding agent (or human) about to write code that touches StatsBomb
> open data in this repo.** Read the "Bottom line" and "Hard rules" sections
> before you write a single line. This file is the project's standing policy on
> the dataset at <https://github.com/statsbomb/open-data>.
>
> **This is not legal advice.** It summarises the binding licence in good faith
> for engineering decisions. For any commercial decision, read `LICENSE.pdf` from
> a fresh clone yourself and, if money is involved, talk to StatsBomb (they sell
> commercial licences) or a lawyer.

---

## Bottom line (traffic lights)

footy-sim is **the match engine of an FM-style game that may become a commercial
product** (see the product vision). That future-commercial intent is what makes
the licence matter — a private research toy could ignore most of this; a shipped
game cannot.

| | Activity | Verdict |
|---|---|---|
| 🟢 | Clone the data locally and read it for **private R&D**: compute distributions, fit an xG curve, derive duel/pass/aerial win-rates, study real shapes | **Allowed** (clause 1.1 — research use) |
| 🟢 | Use those findings to **hand-tune / sanity-check the engine** during development, and to build the calibration tooling in `tools/` | **Allowed** for private/non-commercial work |
| 🟢 | Publish analysis/insights (a blog post, a chart, a write-up) | **Allowed, but you must show the StatsBomb logo** (clause 1.4) |
| 🔴 | Commit any StatsBomb JSON (events / lineups / 360 / competitions) into this repo | **Prohibited** (1.2.1 — no reproducing/distributing the data) |
| 🔴 | Ship or commit **real player/club/competition names or per-player ratings derived from the data** (e.g. baked into `spec.json`, the DB, or `formations.ts`) | **Prohibited** (1.2.1, 1.2.2, 7) |
| 🔴 | Ship a **derived data table** as a product asset (an xG coefficient file, a reference-stats file, an archetype lookup table) | **Prohibited** (1.2.2 — derived analysis; 7 — IP) |
| 🔴 | Sell, or put behind a paywall, anything that **is** the data or an analysis of it (a "classic matches" pack, a stats product) | **Prohibited** (1.2.2) |
| 🟠 | Ship, **in a commercial build**, engine *constants* that were **fitted directly to** StatsBomb data (e.g. a re-derived `SHOT_SCOOP_CHANCE`) | **Legally ambiguous — treat as needing a commercial licence.** See "The amber zone" below. |

**The safe strategy for this project:** keep StatsBomb strictly in the
**private calibration / validation layer**. Let it *measure and inform* the
engine; never let it *become* shipped content. Everything in the green rows is
the recommended way to get value from it without licensing risk.

---

## What the binding licence actually says

There are **two** documents and they are not equal:

1. **`README.md`** in the repo says only: *"If you publish, share or distribute any
   research, analysis or insights based on this data, please state the data source
   as StatsBomb and use our logo."* This casual line is **not** the licence.
2. **`LICENSE.pdf`** — the *StatsBomb Public Data User Agreement, Standard Terms*
   (last updated **8 September 2023**, governed by the laws of **England & Wales**).
   **This is the binding document and it is far more restrictive than the README.**

Key verbatim clauses (from `LICENSE.pdf`, retrieved 2026-06-16):

- **1.1** — access is provided *"to be used for analysis, research and to
  facilitate the shared ideas & understanding of the data."* It is a **research
  tool**.
- **1.2 The User may not:**
  - **1.2.1** *"edit, distort, distribute, reproduce, sell or in any way provide
    the data to any external or third party"*
  - **1.2.2** *"commercially exploit the data or any analysis derived from the use
    of the Service"*  ← **the commercial gate**
  - **1.2.5** *"decompile, reverse engineer, or otherwise attempt to obtain the
    source code of the Services"*
- **1.4** — *"The User is required to accredit any publication of analysis formed
  from StatsBomb Data with the StatsBomb brand logo."* (Logo, not just a text
  credit.)
- **2.2** — StatsBomb *asks* every user to register name + email at
  <https://statsbomb.com/resource-centre> before accessing the data.
- **3.x / 5.x** — provided **"as is"**, no warranty as to accuracy/completeness,
  no liability.
- **7 (IP)** — *"all data provided through the Service is the property of
  StatsBomb… the User shall not modify, translate, transfer, distribute, license,
  sell or otherwise exploit for any purposes whatsoever any data… without the
  express prior written consent of StatsBomb."*
- **2.1 / 6** — StatsBomb may withhold or suspend access **at any time without
  notice**.

The two clauses that govern shipping are **1.2.2** (no commercial exploitation of
the data *or any analysis derived from it*) and **1.2.1 / 7** (no
redistribution; IP stays with StatsBomb).

### The amber zone

Clause 1.2.2 forbids commercially exploiting *"any analysis derived from the use
of the Service."* That phrase is **broad**. There is a spectrum:

- **Clearly fine:** general football understanding you gained by looking at the
  data, applied to hand-tune the engine. A human learning "long shots convert
  poorly" and nudging a constant is not redistributing analysis.
- **Clearly not fine:** shipping the data, real ratings, real names, or a derived
  lookup table.
- **Ambiguous (amber):** a constant *mechanically fitted* to StatsBomb data (you
  ran a regression on their shots and wrote the output coefficient into the
  commercial binary). An aggressive reading of 1.2.2 calls that "analysis derived
  from the Service," now commercially exploited.

**Policy for this repo:** treat amber as **red for any commercial build.** If a
tuning value was fitted directly to StatsBomb data and you intend to sell the
product, either (a) obtain a commercial licence from StatsBomb, or (b) re-derive
that target from a **permissively-licensed or self-collected dataset** before it
ships. For private/non-commercial builds, amber is fine. Always leave a provenance
comment (see Hard rules #5) so a future commercial decision can find and re-source
these values.

---

## Hard rules for a coding agent in this repo

These are mechanical and non-negotiable. They keep us on the green path.

1. **Never add a StatsBomb data file to the repo.** Not events, lineups,
   three-sixty, `competitions.json`, nor a CSV/Parquet extract of them. Keep your
   local clone **outside** the working tree (e.g. `C:\data\statsbomb-open-data\`)
   and point scripts at it via an env var (e.g. `SB_OPEN_DATA_DIR`), never a path
   inside the repo.

2. **Never commit a derived data artifact.** Fitted xG tables, reference
   distribution files, archetype/team lookup tables, per-player rating DBs derived
   from the data — these are "analysis derived from the Service." They live only
   in a **gitignored** working area. The repo's `.gitignore` already swallows the
   natural homes: `tools/_*.py`, `_*`, `*.bin`, `*.jsonl`, `*_summary.json`,
   `audit*.json`. **Recommended convention: put all StatsBomb-derived working
   files under `tools/_sb/`** — the leading underscore is already the repo's
   scratch convention and is gitignored.

3. **Keep the shippable surface anonymous and procedural.** The data that ends up
   in a build flows through one seam:

   ```
   web/backend/game.ts (genAttrs, procedural)
        └─> web/backend/match.ts (buildSpec)
              └─> spec.json  ──>  engine/main.cpp:15  loadTeam()  ──>  the binary
   ```

   Do **not** populate any *committed or shipped* `spec.json`, the SQLite seed, or
   `web/backend/formations.ts` with real StatsBomb-derived **names or per-player
   ratings**. Procedural/anonymous generation stays exactly as it is. (Using the
   data privately to *tune the generator's role-bias magnitudes* is the green,
   anonymous-distribution variant — that's fine; shipping specific real players is
   not.)

4. **Calibration scripts may be committed; the data they read may not.** A
   `tools/calib_*.py` that reads from `$SB_OPEN_DATA_DIR` and prints PASS/WARN
   bands is methodology — committable. It must (a) read the data from the external
   path, never an in-repo copy, and (b) contain **no embedded real-team/player
   tables**. If it needs reference numbers, compute them at run time from the local
   clone.

5. **Tag any data-informed constant with provenance.** If you change an engine
   constant based on StatsBomb analysis, leave a comment so a future commercial
   review can find it:

   ```cpp
   // CALIB(statsbomb): re-derived from open-data shot conversion, 2026-06-xx.
   // Amber under LICENSE.pdf 1.2.2 for a commercial build — re-source before sale.
   inline constexpr double SHOT_SCOOP_CHANCE = 0.80;
   ```

6. **Attribution + registration.** If you publish *any* analysis from the data
   (charts, write-ups), show the **StatsBomb logo** (clause 1.4). Register your
   name + email at <https://statsbomb.com/resource-centre> (clause 2.2).

7. **When in doubt, it stays in `tools/_sb/` and out of the binary.** Measuring is
   always safe; shipping the measurement is what bites.

---

## How the data lines up with this engine (the green path)

StatsBomb is event data: **on-the-ball events with `[x,y]` locations, `shot.statsbomb_xg`
on every shot, a per-shot `freeze_frame` of visible players, and (for 12 of ~80
seasons) StatsBomb 360 positional snapshots.** Crucially it has **no continuous
tracking and no ball physics** — so it can validate *outcomes and positions*, not
your curl/chip/keeper-speed model. That makes it a **calibration oracle**, which is
exactly the engine's biggest gap: today the only enforced behavioural target is the
determinism golden; every realism number is "tuned by feel."

### Coordinate & unit conversion (the #1 footgun — get this right first)

| Quantity | StatsBomb | This engine |
|---|---|---|
| Pitch grid | `120 × 80` abstract units | `1050 × 680` **pixels** (`PITCH_W`/`PITCH_H`, `constants.h`), 10 px = 1 m |
| X scale | — | `x_px = x_sb × 8.75` |
| Y scale | — | `y_px = y_sb × 8.5` |
| Attacking goal | `(120, 40)` | `(1050, 340)` — home attacks **+x**; away mirrors as `x_engine = 1050 − x` |
| `pass.length` | **metres** | `metres × 10` px |
| Shot distance bands | (compute from location) | `<100 px` close, `<200 px` medium, else long (`stats.cpp:34`) — i.e. **<10 m / <20 m** |

SB normalises every team to attack +x, which matches the engine's HOME frame.
**`pass.length` is metres while locations are grid units** — mixing them silently
corrupts geometry. Build/verify this mapping before any spatial calibration.

### The two engine I/O surfaces a calibration harness uses

- **`--summary` JSON** (last line of `build/live.exe … --summary`). Already emits
  the counters a realism scorecard needs: `shots`, `saves`, `passCompletionPct`,
  `shotsByDistance` / `goalsByDistance` (`stats.cpp:162,174`), crosses, tackles,
  offsides, cards, per-player stats. A scorecard is a **pure consumer** — zero
  engine change. (`tools/native-batch.ts` already runs this over many seeds.)
- **`--trace out.bin`** — a binary, **per-tick (60 Hz) freeze-frame of all 22
  players + the ball + tagged events**. Read it with `tools/trace_reader.py`. This
  is what makes an **xG-shape validation** possible: reconstruct the engine's own
  freeze-frame at each shot instant and bin conversion by chance-quality features,
  the same way StatsBomb's `freeze_frame` feeds `statsbomb_xg`.

  *Verified working* — a 5-min trace (`live.exe 101 5 --summary --no-debug --trace
  out.bin`, 21 600 frames / 284 events) reconstructs the shot moment exactly:

  ```
  shot t=38184ms  shooter=#9  loc=(849,340)
  ball  x=869 y=334 z=0.0
  home XI: (0,127,340) (1,487,86) (2,535,286) (3,433,369) (4,481,586)
           (5,840,263) (6,819,381) (7,821,446) (8,900,271) (9,848,340) (10,901,309)
  away XI: (11,995,339) (12,923,265) (13,842,319) (14,920,306) (15,946,357)
           (16,805,323) (17,867,346) (18,901,361) (19,860,161) (20,813,360) (21,658,557)
  ```

  From this you can count defenders in the ball→goal cone, exactly the first-order
  feature StatsBomb's xG model uses.

  > ⚠️ A full 90-min trace is large (~44 MB for 5 min → ~0.8 GB for 90 min) and
  > matches `*.bin` in `.gitignore`. Write traces to a scratch/temp path, never the
  > repo. Always pass `--summary` (without it the binary streams frames forever and
  > locks itself — see the engine notes).

### Calibration levers this data can target (all currently "tuned by feel")

| Lever | Where | What StatsBomb anchors it to |
|---|---|---|
| `SHOT_SCOOP_CHANCE = 0.80` ("primary goal-rate dial") | `constants.h:164`, used `engine_actions.cpp:851` | conversion by distance/context |
| first-touch `finishChance` | `engine_physics.cpp` | conversion vs chance quality |
| `PENALTY_SAVE_BASE = 0.16` (+ skill) | `constants.h:161`, `engine_gk.cpp:212` | real penalty save % (~17–25%) — directly countable from `GoalKeeper` "Penalty Saved" events |
| `GK_SAVE_MAX = 0.80` / save model | `constants.h:175`, `engine_gk.cpp:209` | save % by shot quality (shape only — engine keeper is a physical tracker, not an xG roll) |
| pass geometry / completion | `engine/agent_pass*.cpp` | completion% by length × angle × pressure |
| duel / aerial / take-on rates | `stats.cpp` counters | real tackle-win%, take-on% (~50–60%), aerial-win% |
| formation anchors (non-default shapes) | `web/backend/formations.ts` | real average positions from 360 frames |

### The golden-guard tripwire

The engine is deterministic and `tools/tactics_golden.py` hashes the default
(no-directive) match across 7 fixed seeds. **Any** change to a default-path
constant (`SHOT_SCOOP_CHANCE`, `finishChance`, pass geometry, the default 4-3-3
anchors) **or even a new `--summary` field** breaks that hash. Calibration that
touches the engine must be a deliberate re-baseline (re-save the golden), never a
silent drift. A pure scorecard/`--trace` harness touches none of this.

---

## Recommended first move (safe, high-value, zero ship risk)

1. **Unit harness** (`tools/_sb/`): pin the `120×80 → 1050×680` mapping above and
   the goal-mouth/x-mirror alignment. Half a day. Prevents silent corruption of
   everything downstream.
2. **League-distribution scorecard** (`tools/calib_scorecard.py`): hold
   StatsBomb-derived **WARN-bands** (per match) for the counters `native-batch.ts`
   already emits; print PASS/WARN. One day, **zero engine change**, fully green.
   Reference numbers computed at run time from `$SB_OPEN_DATA_DIR`, never committed.

This converts the engine's biggest weakness ("tuned by feel, one enforced target")
into "tuned to a real league" — and stays entirely inside the private calibration
layer.

---

## Provenance

- Binding terms: `LICENSE.pdf` from `statsbomb/open-data` — *Public Data User
  Agreement, Standard Terms, last updated 8 September 2023*, laws of England &
  Wales. Retrieved and read in full 2026-06-16.
- README attribution line: `README.md`, same repo, same date.
- Codebase anchors verified against the working tree on 2026-06-16: `main.cpp:15`
  (`loadTeam`) and `:133–136` (CLI flags), `constants.h:161/164/175`,
  `engine_gk.cpp:209/212`, `engine_actions.cpp:851`, `stats.cpp:34/162/174`,
  `tools/trace_reader.py`, `.gitignore`.
- Terms can change and access can be withdrawn (clause 2.1). **Re-read
  `LICENSE.pdf` from a fresh clone before relying on the specifics for any
  commercial decision.**

# tools/replay — the standalone match-replay viewer

Turns a deterministic engine run into **one self-contained HTML file** you can
open, scrub, and hand to anyone. This is the artifact the owner watches after a
balance round: no server, no build step, no network.

Until Round-31 this lived only in a session scratch directory and was rebuilt by
hand each round. It now lives here.

## Pipeline

```
./build/live.exe SEED MINUTES --trace T.bin      per-tick binary trace (engine/trace.h)
        │
        ├── tools/trace_reader.py                the one binary parser
        ▼
tools/replay/export_match.py                     downsample + join summary → match.json
        │                                         (~12.5 fps, ~250 KB per simulated minute)
        ▼
tools/replay/build_viewer.py                     inline match.json into viewer_template.html
        ▼
   replay.html                                   standalone, ~9 MB for a 35-min match
```

One-shot driver:

```bash
bash tools/replay/make_replay.sh            # seed 13, 35 min  → build/replay/replay.html
bash tools/replay/make_replay.sh 117 20     # seed 117, 20 min
ARENA=5 bash tools/replay/make_replay.sh 117 10   # arena drill instead of a match
```

Or run the steps yourself — every input is an environment override, so nothing
needs editing in place:

```bash
mkdir -p build/replay
./build/live.exe 13 35 --trace build/replay/m13.bin --no-debug
EXPORT_BIN=build/replay/m13.bin EXPORT_SEED=13 EXPORT_MINUTES=35 \
  EXPORT_OUT=build/replay/match.json python3 tools/replay/export_match.py
python3 tools/replay/build_viewer.py build/replay/match.json build/replay/replay.html
```

| variable | meaning | default |
|---|---|---|
| `EXPORT_BIN` | trace to read | `$REPLAY_DIR/match.bin` |
| `EXPORT_SEED` | seed the trace was run with | `13` (`117` for arena) |
| `EXPORT_MINUTES` | minutes the trace covers | `35` (`10` for arena) |
| `EXPORT_ARENA` | drill id (`export_arena.py` only) | `5` |
| `EXPORT_OUT` | json to write | `$REPLAY_DIR/match.json` |
| `EXPORT_STEP_MS` | frame downsample step | `80` |
| `REPLAY_DIR` | working directory for all of the above | `build/replay` |
| `KEEP_TRACE` | `make_replay.sh`: keep the `.bin` | unset (deleted) |

`EXPORT_SEED`/`EXPORT_MINUTES` must match the trace: the roster, the sub log and
the final line come from a *second* `--summary` run of the same seed, which only
agrees with the trace because the engine is deterministic.

**Traces are large** — roughly 8 MB per simulated minute (a 35-minute match is
~290 MB). `make_replay.sh` deletes the trace when it is done. Everything lands in
`build/replay/`, which is gitignored.

## What the viewer does

`viewer_template.html` is a single-file canvas renderer over the exported frames.
Its non-obvious behaviour, all of it earned against a specific observed bug:

- **Cubic-spline player interpolation.** Frames are 80 ms apart; positions go
  through a stateless cubic B-spline over 4 keyframes, which low-passes the
  sub-keyframe jockey zigzag (most tackles flap laterally at ~the keyframe
  period, and plain lerp aliases that into a kink at every keyframe). The convex
  hull means no overshoot; it falls back to lerp across teleport-scale jumps.
- **Smoothed facing.** Renders `render_facing` (the engine's low-passed display
  copy, TRACE_VERSION 3), not the raw `facing`. Raw angles shimmer. Analysis
  tools keep reading `facing` — that is the engine's truth and gates the vision
  cone.
- **Possession-ring cross-fade** plus a separate *touch* flash. The ring only
  followed `controller_id`, so one-touch plays and deflections never lit up; the
  exporter's `last_toucher_id` change-list drives the flash.
- **HALF TIME / FULL TIME break cards** from the engine's own break window.
  The engine emits `full_time` and returns without writing a frame at that
  instant, which is why the exporter always force-keeps the final frame.
- **One goal-cut discontinuity rule** (Round-30) replacing the earlier
  halftime-only special case: any large positional jump between keyframes is a
  cut, so interpolation is suppressed rather than smeared across the pitch.
- **`scoreAt` correction for goals that precede their keyframe.** A goal event
  can land up to one downsample step (80 ms) *before* the frame that records the
  new score, so the celebration card — drawn at the goal instant — read the
  pre-goal scoreline. `scoreAt()` replays the goal list on top of the raw frame
  score.
- **Own-goal scoreboard fix.** The crediting side comes from the score *delta*
  across the goal instant, never from the toucher's team, so the card can never
  disagree with the scorebug beside it.
- **Substitution toasts naming both men.** A trace `sub` event is fixed-width and
  carries only the pitch *slot*, which the end-of-match roster resolves to the man
  who came ON — the departing man exists nowhere else in the trace. The exporter
  joins the engine's summary-side `substitutionLog` on `(clockMs, slotId)`.
- **450 ms tackle-animation latch.** `tackleAnim` drops before the pose should,
  so the slide/poke pose is latched from onset.
- **Duel event cues** for `takeon_lost` and `chop`.

## Relationship to `web/frontend/renderer.ts`

`web/frontend/renderer.ts` is the **shipping** renderer: stateful, fed live JSON
from the running backend, ~2500 lines of TypeScript. It shares concepts with this
template but is a different codebase.

**Do not merge them.** They have different inputs (live incremental state vs a
complete pre-exported timeline), different failure modes, and the template's
value is that it stays a single dependency-free file.

Where a fix exists here but not there, it belongs on a follow-up list rather than
in a copy-paste:

- **`scoreAt` (goal-before-keyframe).** Known divergence. The template corrects
  the scoreline for a goal event that precedes the keyframe carrying the new
  score. The shipping renderer takes the score from live state, so it may not be
  exposed to the same ordering — but its *replay* mode (`replayMode`, seeking
  backwards through buffered state) plausibly is. Worth a targeted check:
  seek to a goal instant in replay mode and confirm the banner's scoreline
  matches the scorebug.

Anything else found should be appended here, not silently ported.

## Verified

Round-31: exported seed 13 @ 35 min from a fresh trace (25481 frames, 1076
events, 4 subs), built the page (8.7 MB), loaded it headlessly in Chromium and
drove it into open play at 14'54 — **zero console errors, zero page errors, zero
failed requests**.

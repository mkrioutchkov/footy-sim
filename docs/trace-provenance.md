# Trace provenance — regenerating the `m264rNN.bin` reference footage

This note records how the owner's per-round reference traces (`SP/m264rNN.bin`,
seed 264, 35 min) are produced, so any future round can regenerate one and check
it **byte-for-byte** against the reference.

## The `--no-debug` fork (`engine/main.cpp`)

`main()` has a single boolean, `debugMode`, that decides whether the match runs
with **equalized** or **real** player attributes:

- `main.cpp:154` — `bool debugMode = true;` — **debug mode is the DEFAULT.**
- `main.cpp:169` — `else if (arg == "--no-debug") debugMode = false;` — the flag
  *turns debug mode OFF*.
- `main.cpp:287` — `if (debugMode) engine.equalizeAttributes(65);` — in debug mode
  every outfielder is flattened to a rating of 65, so the match is a pure test of
  the *mechanics* rather than the roster. `--no-debug` leaves the real roster
  attributes intact.

So there are two deterministic matches for seed 264 / 35 min:

| invocation | attributes | seed-264 result |
|---|---|---|
| `./build/live.exe 264 35 --trace X --summary`              | **equalized (65)** | **2–0** (home: Messi 25:34, Modric 26:19) |
| `./build/live.exe 264 35 --trace X --no-debug --summary`   | **real**           | 1–2 (away: Ronaldo ×2) |

A data-driven `--match <spec>.json` run also forces `debugMode = false`
(`main.cpp:271` — "never equalize a real team's attributes"), i.e. the FM/game
path is always the real-attribute match.

## Ground-truth: which mode produced `m264r27.bin`

Regenerating **both** modes at `468d0cc` and comparing byte-for-byte against
`SP/m264r27.bin`:

```
cmp regen_debug.bin   m264r27.bin   -> IDENTICAL   (equalized, no --no-debug, 2-0)
cmp regen_nodebug.bin m264r27.bin   -> DIFFERS @ char 191293   (--no-debug, 1-2)
```

**Verdict: the reference `m264rNN.bin` lineage is the DEBUG / equalized match
(no `--no-debug`), final score 2–0.** All moment-repro work for this fixture
(the 0:19 shepherd, the 0:21 lost take-on at 20.83 s, the 0:22 gifted pass at
22.57 s, and the two home goals at 25:34 / 26:19) must use the **default**
(equalized) mode, because that is the match the owner's footage actually is.

The `--no-debug` (real-attribute) match is a *different* game and must not be
used to reproduce those moments.

## Byte-cmp is a valid regen check

The trace's per-frame `physicsMs` / `agentMs` perf-timer fields are always
written as `0` on the golden path (`TraceWriter::writeFrame` is called with the
default `physicsMs = agentMs = 0`), so a wall-clock difference between runs never
perturbs the bytes. A plain `cmp` of two traces built from the same commit is
therefore exact: identical bytes ⟺ identical simulation.

## Format version

`TRACE_VERSION` (engine/trace.h) is stamped in every trace header, and
`tools/trace_reader.py` picks the frame layout from it — so a trace written by an
older engine still loads, and a trace written by a *newer* one fails loudly with a
"newer than this reader" error instead of silently mis-parsing. A version bump
changes the bytes by construction, so a `cmp` across a bump is meaningless; compare
summaries (or re-baseline the reference) instead.

| v | added |
|---|---|
| 2 | per-player `wall`, ball `curl` |
| 3 | per-player `renderFacing` — the engine's low-passed **display** angle (what the live web stream has always sent). Raw `facing` is unchanged and is still the analysis truth: it is what gates the vision cone, so tools must keep reading `facing`, and only renderers should read `render_facing`. |

## Recipe

```sh
# Build the engine at the commit under test.
g++ -std=c++20 -O2 -I third_party -o build/live engine/*.cpp && cp build/live build/live.exe

# Regenerate the reference match (DEBUG / equalized — the m264rNN lineage).
./build/live.exe 264 35 --trace SP/m264rNN.bin --summary

# Verify against the prior reference (only meaningful at the SAME commit).
cmp SP/m264rNN.bin SP/m264r<prev>.bin   # identical iff the engine is unchanged
```

#!/usr/bin/env bash
# One-shot replay pipeline: simulate -> trace -> match.json -> standalone HTML.
#
#   bash tools/replay/make_replay.sh              # seed 13, 35 min
#   bash tools/replay/make_replay.sh 117 20       # seed 117, 20 min
#   ARENA=5 bash tools/replay/make_replay.sh 117 10   # arena drill 5
#
# Traces are LARGE (~8 MB per simulated minute); the trace is deleted at the end
# unless KEEP_TRACE=1. Everything lands in build/replay/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/../.."

SEED="${1:-13}"
MINUTES="${2:-35}"
OUTDIR="${REPLAY_DIR:-build/replay}"
mkdir -p "$OUTDIR"

BIN=build/live.exe
[ -f "$BIN" ] || BIN=build/live
if [ ! -f "$BIN" ]; then
  echo "→ no engine binary, building ..."
  mkdir -p build
  g++ -std=c++20 -O2 -I third_party -o build/live engine/*.cpp
  cp build/live build/live.exe
  BIN=build/live.exe
fi

# Only the trace is read, so ask the engine not to serialise its JSON frames as well: that
# was ~7 of the ~9 minutes a 90' replay took (403s for the trace run alone, 2026-11-10).
# An engine built before --frame-sample ignores the flag and just runs the slow way.
QUIET_FRAMES="--frame-sample 1000000"
# "python3" on Windows is usually the Microsoft Store stub, which exists but cannot run.
PY=python3
"$PY" --version >/dev/null 2>&1 || PY=python

TRACE="$OUTDIR/s${SEED}.bin"
JSON="$OUTDIR/match.json"
HTML="${REPLAY_OUT:-$OUTDIR/replay.html}"

if [ -n "${ARENA:-}" ]; then
  echo "→ simulating seed $SEED, ${MINUTES}min, arena $ARENA ..."
  "./$BIN" "$SEED" "$MINUTES" --arena "$ARENA" --trace "$TRACE" --no-debug $QUIET_FRAMES >/dev/null
  EXPORT_BIN="$TRACE" EXPORT_SEED="$SEED" EXPORT_MINUTES="$MINUTES" EXPORT_ARENA="$ARENA" \
    EXPORT_OUT="$JSON" "$PY" tools/replay/export_arena.py
else
  echo "→ simulating seed $SEED, ${MINUTES}min ..."
  "./$BIN" "$SEED" "$MINUTES" --trace "$TRACE" --no-debug $QUIET_FRAMES >/dev/null
  EXPORT_BIN="$TRACE" EXPORT_SEED="$SEED" EXPORT_MINUTES="$MINUTES" \
    EXPORT_OUT="$JSON" "$PY" tools/replay/export_match.py
fi

"$PY" tools/replay/build_viewer.py "$JSON" "$HTML"

if [ "${KEEP_TRACE:-0}" != "1" ]; then
  rm -f "$TRACE"
  echo "→ removed $TRACE (KEEP_TRACE=1 to keep it)"
fi
echo "→ open $HTML"

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

TRACE="$OUTDIR/s${SEED}.bin"
JSON="$OUTDIR/match.json"
HTML="${REPLAY_OUT:-$OUTDIR/replay.html}"

if [ -n "${ARENA:-}" ]; then
  echo "→ simulating seed $SEED, ${MINUTES}min, arena $ARENA ..."
  "./$BIN" "$SEED" "$MINUTES" --arena "$ARENA" --trace "$TRACE" --no-debug >/dev/null
  EXPORT_BIN="$TRACE" EXPORT_SEED="$SEED" EXPORT_MINUTES="$MINUTES" EXPORT_ARENA="$ARENA" \
    EXPORT_OUT="$JSON" python3 tools/replay/export_arena.py
else
  echo "→ simulating seed $SEED, ${MINUTES}min ..."
  "./$BIN" "$SEED" "$MINUTES" --trace "$TRACE" --no-debug >/dev/null
  EXPORT_BIN="$TRACE" EXPORT_SEED="$SEED" EXPORT_MINUTES="$MINUTES" \
    EXPORT_OUT="$JSON" python3 tools/replay/export_match.py
fi

python3 tools/replay/build_viewer.py "$JSON" "$HTML"

if [ "${KEEP_TRACE:-0}" != "1" ]; then
  rm -f "$TRACE"
  echo "→ removed $TRACE (KEEP_TRACE=1 to keep it)"
fi
echo "→ open $HTML"

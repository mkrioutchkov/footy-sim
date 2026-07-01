#!/usr/bin/env bash
# Linux/macOS engine build — the g++/clang++ counterpart to build-native.ps1 (which needs
# Visual Studio's cl.exe and only runs on Windows). Compiles engine/*.cpp into build/live.exe.
# The output keeps the .exe name on purpose: the backend (match.ts / coordinator.ts) spawns
# `build/live.exe`, so one name works cross-platform with no code change.
#
#   scripts/build-native.sh            # optimized build
#   CXX=clang++ scripts/build-native.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CXX="${CXX:-g++}"
OUT="$ROOT/build"
EXE="$OUT/live.exe"
mkdir -p "$OUT"

# Stamp the binary with the git hash + a "custom" flag when there are staged changes, matching
# build-native.ps1 so `--version` reads the same on both platforms.
GIT_HASH="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if git -C "$ROOT" diff --cached --quiet --exit-code 2>/dev/null; then GIT_CUSTOM=0; else GIT_CUSTOM=1; fi

echo "Building engine with $CXX -> $EXE (git $GIT_HASH)"
# Whole-program single-shot compile — the engine is small enough (~30 TUs, ~50s) that a
# non-incremental build is simpler and reliable across machines. -O2 matches the /O2 release build.
"$CXX" -std=c++20 -O2 -pthread \
  -DBUILD_GIT_HASH=$GIT_HASH -DBUILD_GIT_CUSTOM=$GIT_CUSTOM \
  -I "$ROOT/third_party" \
  "$ROOT"/engine/*.cpp \
  -o "$EXE"

echo "Native build complete: $EXE"

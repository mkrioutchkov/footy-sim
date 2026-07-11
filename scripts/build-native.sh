#!/usr/bin/env bash
# Linux/macOS counterpart to build-native.ps1 (which needs MSVC). Compiles the C++ match engine with
# g++ or clang++ into build/live — the same deterministic simulator the Windows build produces, just an
# ELF/Mach-O binary instead of live.exe. The backend resolves either name (see match.ts resolveEngine),
# so an autonomous "next turn" server can run the real engine on Linux without a Windows toolchain.
#
# Incremental like the PS build: each .cpp -> build/<name>.o, recompiled only when the source, any
# header, or this script is newer than the object; then linked. build_version.cpp always recompiles so
# the embedded git hash stays current.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native="$root/engine"
third_party="$root/third_party"
out="$root/build"
mkdir -p "$out"

CXX="${CXX:-}"
if [[ -z "$CXX" ]]; then
  if command -v g++ >/dev/null 2>&1; then CXX=g++
  elif command -v clang++ >/dev/null 2>&1; then CXX=clang++
  else echo "No C++ compiler found (need g++ or clang++)." >&2; exit 1; fi
fi

std=c++20
optflags=(-O2 -DNDEBUG)
incflags=(-I "$third_party")

# Embed the git hash + a "custom" flag when there are staged changes (parity with the PS build).
git_hash="$(cd "$root" && git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
git_custom=0
if ! (cd "$root" && git diff --cached --quiet --exit-code 2>/dev/null); then git_custom=1; fi
defines=(-DBUILD_GIT_HASH="$git_hash" -DBUILD_GIT_CUSTOM="$git_custom")

# Newest header mtime — any header change forces a full recompile (headers aren't tracked per-object).
newest_header=0
while IFS= read -r -d '' f; do
  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"); (( m > newest_header )) && newest_header=$m
done < <(find "$native" "$third_party" -type f \( -name '*.h' -o -name '*.hpp' \) -print0 2>/dev/null)
script_mtime=$(stat -c %Y "${BASH_SOURCE[0]}" 2>/dev/null || stat -f %m "${BASH_SOURCE[0]}")

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

objs=()
compiled=0
for src in "$native"/*.cpp; do
  base="$(basename "$src" .cpp)"
  obj="$out/$base.o"
  objs+=("$obj")
  need=0
  if [[ "$base" == build_version ]]; then need=1
  elif [[ ! -f "$obj" ]]; then need=1
  else
    ot=$(mtime "$obj")
    (( ot < $(mtime "$src") )) && need=1
    (( ot < newest_header )) && need=1
    (( ot < script_mtime )) && need=1
  fi
  if (( need )); then
    echo "  CXX $base.cpp"
    "$CXX" -std=$std "${optflags[@]}" "${defines[@]}" "${incflags[@]}" -pthread -c "$src" -o "$obj"
    compiled=1
  fi
done

exe="$out/live"
if (( compiled )) || [[ ! -f "$exe" ]]; then
  echo "  LINK live"
  "$CXX" -std=$std "${optflags[@]}" "${objs[@]}" -pthread -o "$exe"
  echo "Built $exe (git $git_hash$([[ $git_custom == 1 ]] && echo ' custom'))"
else
  echo "Native build up to date: $exe"
fi

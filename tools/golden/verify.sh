#!/usr/bin/env bash
# Golden verification for engine refactors.
#
# Rebuilds the engine, reruns the frozen seed set, and checks the result against
# the committed byte-identical fingerprint. A pure refactor MUST reproduce it
# exactly (100%). Any per-seed drift is a behaviour change — investigate, don't
# wave it through (see docs/ENGINE_AUDIT_2026-07.md "Golden rule").
#
# Usage:  bash tools/golden/verify.sh            # rebuild + verify
#         bash tools/golden/verify.sh --no-build # verify current build/live.exe
set -euo pipefail
cd "$(dirname "$0")/../.."

SEED_LO=101 SEED_HI=140 MINUTES=10
# Dual-name: build-native.ps1 emits live.exe, scripts/build-native.sh emits live.
BIN=build/live.exe
[ -f "$BIN" ] || BIN=build/live
REF=tools/golden/fingerprint.sha256
BASE=tools/golden/baseline_summaries.jsonl

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ building (g++ -O2 -std=c++20) ..."
  mkdir -p build
  g++ -std=c++20 -O2 -I third_party -o "$BIN" engine/*.cpp
fi

echo "→ running seeds $SEED_LO-$SEED_HI @ ${MINUTES}min ..."
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
seq "$SEED_LO" "$SEED_HI" | xargs -P8 -I{} sh -c \
  './'"$BIN"' {} '"$MINUTES"' --summary --no-debug 2>/dev/null | tail -1 > "'"$work"'/{}.json"'

new="$work/new.jsonl"; : > "$new"
for s in $(seq "$SEED_LO" "$SEED_HI"); do cat "$work/$s.json"; done >> "$new"

got="$(sha256sum "$new" | awk '{print $1}')"
want="$(awk '{print $1; exit}' "$REF")"

echo
echo "expected fingerprint: $want"
echo "actual   fingerprint: $got"
if [[ "$got" == "$want" ]]; then
  echo "✓ BYTE-IDENTICAL — 40/40 seeds match. Pure refactor confirmed."
  exit 0
fi

echo "✗ DRIFT — fingerprint mismatch. Per-seed breakdown:"
mism=0
i=1
for s in $(seq "$SEED_LO" "$SEED_HI"); do
  base_line="$(sed -n "${i}p" "$BASE")"
  new_line="$(cat "$work/$s.json")"
  if [[ "$base_line" != "$new_line" ]]; then
    echo "  seed $s: DIFFERS"
    mism=$((mism+1))
  fi
  i=$((i+1))
done
echo "  → $mism/40 seeds drifted."
echo "  To see WHAT changed on a seed: diff <(sed -n '<row>p' $BASE) <(./$BIN <seed> $MINUTES --summary --no-debug | tail -1)"
echo "  (row = seed - $SEED_LO + 1). A refactor that drifts is NOT pure — bisect the last edit batch."
exit 1

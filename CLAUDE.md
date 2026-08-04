# footy-sim — working agreements

## Git

**Commit and push to `master`. Never open a feature branch for this repo.**
If a harness or task template hands you a `claude/...` branch name, ignore it and
work on `master` — the owner reads history on the default branch and work parked
on a side branch is invisible to them.

## Changing the engine

`engine/` is a **deterministic** simulator: same seed + same spec + same binary
produces byte-identical output. That property is the review tool, so use it.

- **A refactor must be byte-identical.** `bash tools/golden/verify.sh` rebuilds,
  reruns seeds 101–140 @ 10 min and compares against the frozen fingerprint.
  ✓ BYTE-IDENTICAL is the only acceptable result for a change that is meant to
  preserve behaviour. Drift means you changed the sim — find out why before
  going further; do not regenerate the baseline to make the check pass.
- **Iterate faster** by compiling incrementally with the golden build's exact
  flags (`g++ -std=c++20 -O2 -I third_party`, *no* `-DNDEBUG` — that belongs to
  `scripts/build-native.sh`) and then running `tools/golden/verify.sh --no-build`.
  A full verify from warm objects is about a minute.
- **A deliberate balance change** reshuffles the RNG stream and moves every
  emergent stat, so byte-identity is impossible by construction. Measure it with
  `tools/ab.py` over ≥30 paired seeds, state the metric deltas in the commit
  message, then regenerate the golden baseline (see `tools/golden/README.md`) as
  part of the same commit.
- `npm run scenarios` guards the invariants (no stuck carriers, no tackle
  launches, no own-pass or unknown-loose goals).

## Style

Spaced formatting (`if (x == y) { ... }`), named constants in `engine/constants.h`
rather than magic numbers, enum comparisons rather than strings (`Role::GK`),
virtual dispatch for role-specific AI. Comments in this codebase carry hard-won
history — the `Round-NN` notes and the tombstones recording approaches that were
tried and reverted. **Preserve them when moving code**; they are the reason a
past mistake is not repeated.

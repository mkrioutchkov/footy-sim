#!/usr/bin/env python3
"""Paired A/B verdict — is a candidate engine change REAL or just seed noise?

The engine is deterministic: same seed + same binary => byte-identical output.
So the honest way to test a change is *paired* — run baseline and candidate on
the SAME seeds and compare match-by-match. Pairing cancels the dice; a per-seed
difference can then only come from the code change itself. Aggregate a batch of
paired seeds and a two-sided paired t-test says whether the mean shift clears the
noise floor.

Nothing is hardcoded: any metric (any numeric leaf of --summary, dotted for
nested fields, plus the derived `goals`), any seed count, any two binaries.

Workflow
--------
    # 1. freeze the baseline binary
    scripts/build-native.ps1
    cp build/live.exe build/baseline.exe
    # 2. make your engine change, rebuild the candidate
    scripts/build-native.ps1
    # 3. verdict
    python tools/ab.py                      # defaults: baseline.exe vs live.exe, 48 seeds, 10 min
    python tools/ab.py --metrics goals,passCompletionPct,shots --sort
    python tools/ab.py --all --json build/ab.json

Reading it
----------
    metric              base     cand    delta        95% CI       verdict
    goals               3.42     3.79    +0.37   [-0.15, +0.89]   noise (ns)
    passCompletionPct  80.60    82.40    +1.80   [+1.31, +2.29]   REAL** (p<.01)

delta is the mean paired difference (candidate - baseline). If the 95% CI
straddles 0 the change is indistinguishable from noise at this sample size --
collect more seeds or drop the change. Verdicts: REAL** = p<.01, REAL* = p<.05,
noise = not significant, IDENTICAL = every paired seed matched to the bit (a pure
refactor, or both flags point at the same binary).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Two-sided critical values, nearest-lower df (conservative between entries) ──
# Using the largest tabulated df <= the real df yields a slightly larger crit,
# which biases AGAINST false "significant" — we would rather miss a marginal real
# effect than ship a noise artefact as real.
_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
        8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
        15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080,
        22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
        29: 2.045, 30: 2.042, 40: 2.021, 50: 2.009, 60: 2.000, 80: 1.990, 100: 1.984,
        120: 1.980}
_T99 = {1: 63.657, 2: 9.925, 3: 5.841, 4: 4.604, 5: 4.032, 6: 3.707, 7: 3.499,
        8: 3.355, 9: 3.250, 10: 3.169, 11: 3.106, 12: 3.055, 13: 3.012, 14: 2.977,
        15: 2.947, 16: 2.921, 17: 2.898, 18: 2.878, 19: 2.861, 20: 2.845, 21: 2.831,
        22: 2.819, 23: 2.807, 24: 2.797, 25: 2.787, 26: 2.779, 27: 2.771, 28: 2.763,
        29: 2.756, 30: 2.750, 40: 2.704, 50: 2.678, 60: 2.660, 80: 2.639, 100: 2.626,
        120: 2.617}
_T95_INF, _T99_INF = 1.960, 2.576


def _tcrit(table: dict[int, float], inf: float, df: int) -> float:
    if df < 1:
        return inf
    keys = [k for k in table if k <= df]
    return table[max(keys)] if keys else inf


# A curated headline set for the default run. Names are resolved against what the
# binary actually emits, so an absent one is skipped with a warning rather than
# crashing — the default stays useful even as the summary schema evolves.
DEFAULT_METRICS = [
    "goals", "shots", "shotsOnTarget", "saves", "passes", "passCompletionPct",
    "offsides", "clearances", "tackles.attempts", "tackles.wins",
    "crossesAttempted", "throughBallsAttempted",
]


def flatten(d: dict, prefix: str = "") -> dict[str, float]:
    """Numeric leaves only, nested keys joined with '.'. Bools and non-numbers dropped."""
    out: dict[str, float] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            out[key] = float(v)
        elif isinstance(v, dict):
            out.update(flatten(v, key + "."))
    return out


def run_one(exe: str, seed: int, minutes: int) -> dict[str, float]:
    """Run one deterministic match, return the flattened summary (+ derived goals)."""
    # Absolute, OS-native path: Windows CreateProcess fails to locate a
    # forward-slash relative exe ("build/live.exe") even when it exists on disk.
    proc = subprocess.run(
        [os.path.abspath(exe), str(seed), str(minutes), "--summary", "--no-debug"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{os.path.basename(exe)} seed {seed} exited {proc.returncode}: {proc.stderr.strip()[:200]}")
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"{os.path.basename(exe)} seed {seed} produced no summary")
    raw = json.loads(lines[-1])
    flat = flatten(raw)
    if "homeScore" in flat and "awayScore" in flat:
        flat["goals"] = flat["homeScore"] + flat["awayScore"]
    return flat


def collect(exe: str, seeds: list[int], minutes: int, jobs: int, label: str) -> dict[int, dict[str, float]]:
    """Run every seed for one binary (bounded parallelism), keyed by seed."""
    out: dict[int, dict[str, float]] = {}
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futs = {pool.submit(run_one, exe, s, minutes): s for s in seeds}
        done = 0
        for fut in as_completed(futs):
            out[futs[fut]] = fut.result()
            done += 1
            print(f"\r  {label}: {done}/{len(seeds)} matches", end="", file=sys.stderr, flush=True)
    print("", file=sys.stderr)
    return out


def verdict(diffs: list[float]) -> dict:
    """Paired t-test on candidate−baseline differences → mean, CI, real/noise verdict."""
    n = len(diffs)
    mean_d = statistics.fmean(diffs) if n else 0.0
    if n < 2:
        return {"n": n, "mean": mean_d, "verdict": "n/a (need >=2 seeds)", "kind": "na"}
    if all(d == 0.0 for d in diffs):
        return {"n": n, "mean": 0.0, "ci": (0.0, 0.0), "t": 0.0, "verdict": "IDENTICAL (0 variance)", "kind": "identical"}
    sd = statistics.stdev(diffs)
    se = sd / math.sqrt(n)
    df = n - 1
    if se == 0.0:  # nonzero constant shift with zero spread => infinitely significant
        return {"n": n, "mean": mean_d, "ci": (mean_d, mean_d), "t": math.inf,
                "verdict": "REAL** (p<.01)", "kind": "strong"}
    t = mean_d / se
    c95, c99 = _tcrit(_T95, _T95_INF, df), _tcrit(_T99, _T99_INF, df)
    half = c95 * se
    ci = (mean_d - half, mean_d + half)
    if abs(t) > c99:
        v, kind = "REAL** (p<.01)", "strong"
    elif abs(t) > c95:
        v, kind = "REAL* (p<.05)", "real"
    else:
        v, kind = "noise (ns)", "noise"
    return {"n": n, "mean": mean_d, "sd": sd, "se": se, "t": t, "ci": ci, "verdict": v, "kind": kind}


def _selftest() -> int:
    """Validate the stats with synthetic paired data (no binaries needed)."""
    cases = [
        ("identical",  [0.0] * 40,                                   "identical"),
        ("pure noise", [(-1) ** i * 0.5 for i in range(40)],         "noise"),
        ("small real", [0.4 + (0.02 if i % 2 else -0.02) for i in range(40)], "strong"),
        ("tiny n",     [1.0],                                        "na"),
    ]
    ok = True
    for name, diffs, want in cases:
        got = verdict(diffs)["kind"]
        flag = "PASS" if got == want else "FAIL"
        if got != want:
            ok = False
        print(f"  [{flag}] {name:12s} expected={want:10s} got={got}")
    return 0 if ok else 1


def main() -> int:
    # Insurance for any future non-ASCII output; the printed tables are ASCII by design.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Paired A/B verdict for engine changes (real vs seed noise).")
    ap.add_argument("--baseline", default="build/baseline.exe", help="baseline binary (default build/baseline.exe)")
    ap.add_argument("--candidate", default="build/live.exe", help="candidate binary (default build/live.exe)")
    ap.add_argument("--seeds", type=int, default=48, help="number of paired seeds (default 48)")
    ap.add_argument("--seed-start", type=int, default=101, help="first seed (default 101)")
    ap.add_argument("--minutes", type=int, default=10, help="match minutes (default 10)")
    ap.add_argument("--metrics", default=None, help="comma list of metrics; omit for the headline set")
    ap.add_argument("--all", action="store_true", help="every numeric metric the binary emits")
    ap.add_argument("--jobs", type=int, default=4, help="parallel match processes (default 4; keep low on this box)")
    ap.add_argument("--json", default=None, help="also dump the full result to this path")
    ap.add_argument("--sort", action="store_true", help="sort rows by significance (|t|) instead of metric order")
    ap.add_argument("--selftest", action="store_true", help="validate the statistics on synthetic data and exit")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    for path in (args.baseline, args.candidate):
        if not os.path.isfile(path):
            print(f"error: binary not found: {path}\n  (build it, then `cp build/live.exe build/baseline.exe` to freeze a baseline)", file=sys.stderr)
            return 2
    if args.seeds < 2:
        print("error: need >=2 seeds for a verdict", file=sys.stderr)
        return 2

    seeds = list(range(args.seed_start, args.seed_start + args.seeds))
    same = os.path.abspath(args.baseline) == os.path.abspath(args.candidate)
    print(f"paired A/B  |  {args.seeds} seeds [{seeds[0]}..{seeds[-1]}]  |  {args.minutes} min  |  jobs {args.jobs}", file=sys.stderr)
    print(f"  baseline : {args.baseline}", file=sys.stderr)
    print(f"  candidate: {args.candidate}" + ("   (SAME binary -> expect all IDENTICAL)" if same else ""), file=sys.stderr)

    base = collect(args.baseline, seeds, args.minutes, args.jobs, "baseline")
    cand = collect(args.candidate, seeds, args.minutes, args.jobs, "candidate")

    # Resolve which metrics to report against what the binaries actually emit.
    available = set().union(*(d.keys() for d in base.values()), *(d.keys() for d in cand.values()))
    if args.all:
        metrics = sorted(available)
    elif args.metrics:
        metrics, missing = [], []
        for m in (x.strip() for x in args.metrics.split(",") if x.strip()):
            (metrics if m in available else missing).append(m)
        if missing:
            print(f"  warning: metrics not emitted, skipped: {', '.join(missing)}", file=sys.stderr)
    else:
        metrics = [m for m in DEFAULT_METRICS if m in available]

    rows = []
    for m in metrics:
        paired = [(base[s][m], cand[s][m]) for s in seeds if m in base.get(s, {}) and m in cand.get(s, {})]
        if len(paired) < 2:
            continue
        b_mean = statistics.fmean(b for b, _ in paired)
        c_mean = statistics.fmean(c for _, c in paired)
        v = verdict([c - b for b, c in paired])
        rows.append({"metric": m, "base": b_mean, "cand": c_mean, **v})

    if args.sort:
        rows.sort(key=lambda r: abs(r.get("t", 0.0)) if math.isfinite(r.get("t", 0.0)) else math.inf, reverse=True)

    # ── Render (ASCII only: this box's console is cp1252) ──
    wm = max((len(r["metric"]) for r in rows), default=6)
    print(f"\n{'metric'.ljust(wm)}   {'base':>8} {'cand':>8} {'delta':>8}   {'95% CI':>18}   verdict")
    print("-" * (wm + 62))
    for r in rows:
        ci = r.get("ci")
        ci_s = f"[{ci[0]:+.2f}, {ci[1]:+.2f}]" if ci else "—"
        print(f"{r['metric'].ljust(wm)}   {r['base']:8.2f} {r['cand']:8.2f} {r['mean']:+8.2f}   {ci_s:>18}   {r['verdict']}")

    tally: dict[str, int] = {}
    for r in rows:
        tally[r["kind"]] = tally.get(r["kind"], 0) + 1
    summary = "  ".join(f"{k}:{v}" for k, v in sorted(tally.items()))
    print("-" * (wm + 62))
    print(f"{len(rows)} metrics  |  {summary}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"config": vars(args), "seeds": seeds, "rows": rows}, f, indent=2)
        print(f"  wrote {args.json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Regression guard for the tactics work: the DEFAULT (no-directive) match must
stay byte-identical as the tactics vocabulary grows. Run `save` once on a known-
good binary, then `check` after every iteration.

  python tools/tactics_golden.py save     # capture golden (no-directive matches)
  python tools/tactics_golden.py check     # compare current binary to golden
"""
import json, subprocess, os, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "build", "live.exe")
# Committed base spec — see the note in tools/tactics_bench.py. The old default
# (web/backend/data/specs/fixture-1.json) is gitignored, so the hashes in
# tactics_golden.json were bound to one developer's untracked file and this guard
# could not run on a clean checkout at all.
SPEC = os.environ.get("TACTICS_SPEC", os.path.join(ROOT, "tools", "tactics_fixture.json"))
GOLDEN = os.path.join(ROOT, "tools", "tactics_golden.json")
SEEDS = [40985, 1, 7, 13, 22, 99, 314]
MINUTES = 90

def summary_for(seed):
    base = json.load(open(SPEC, encoding="utf-8")); base["minutes"] = MINUTES; base["seed"] = seed
    base.pop("directives", None); base.pop("timeline", None)   # DEFAULT match: no tactics
    fp = os.path.join(ROOT, f"_golden_{seed}.json")
    json.dump(base, open(fp, "w", encoding="utf-8"))
    line = None
    for _attempt in range(3):   # retry: a stray live.exe lock can leave a run with no summary line
        out = subprocess.run([ENGINE, "--match", fp, "--summary", "--no-debug"],
                             capture_output=True, text=True, encoding="utf-8", timeout=180).stdout
        cand = [l for l in out.splitlines() if l.strip().startswith("{")]
        if cand:
            line = cand[-1]; break
    os.remove(fp)
    if line is None:
        raise RuntimeError(f"live.exe produced no summary for seed {seed} after 3 tries "
                           "(stray live.exe lock? taskkill live.exe and retry)")
    d = json.loads(line)
    d.pop("version", None)   # version is a cosmetic git-hash field — ignore
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16], d

def run():
    return {str(s): summary_for(s) for s in SEEDS}

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    cur = run()
    if mode == "save":
        json.dump({s: h for s, (h, _) in cur.items()}, open(GOLDEN, "w", encoding="utf-8"), indent=2)
        print(f"saved golden for {len(cur)} seeds -> {GOLDEN}")
        for s, (h, d) in cur.items():
            print(f"  seed {s:>6}: {h}  {d.get('homeScore')}-{d.get('awayScore')}")
    else:
        if not os.path.exists(GOLDEN):
            print("NO GOLDEN — run `save` first"); sys.exit(2)
        gold = json.load(open(GOLDEN, encoding="utf-8"))
        bad = []
        for s, (h, d) in cur.items():
            ok = gold.get(s) == h
            print(f"  seed {s:>6}: {'PASS' if ok else 'FAIL'}  {h}  {d.get('homeScore')}-{d.get('awayScore')}")
            if not ok: bad.append(s)
        if bad:
            print(f"\n[FAIL] DEFAULT MATCH CHANGED for seeds {bad} — tactics work leaked into the no-directive path!")
            sys.exit(1)
        print(f"\n[OK] default match unchanged across {len(cur)} seeds")

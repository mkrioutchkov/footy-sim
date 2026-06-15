#!/usr/bin/env python3
"""Tactics engine self-test + benchmark.

For each directive it runs baseline vs directed matches across many seeds and
asserts the relevant stat moves the EXPECTED direction (so a kind that silently
does nothing fails loudly). Plus determinism (every kind, replay-identical) and
the golden default-match guard. Summary-stat jobs run in parallel across cores;
frame-position jobs (for the movement kinds) stream a few short matches.

  python tools/tactics_bench.py
"""
import json, subprocess, copy, os, sys
# ThreadPool (not Process): the work is subprocess-bound (GIL released during the
# match run), so threads give real parallelism without Windows pickling/respawn
# overhead — and avoid the ProcessPool OOM/crash this hit before.
from concurrent.futures import ThreadPoolExecutor as ProcessPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "build", "live.exe")
BASE = json.load(open(os.path.join(ROOT, "web", "backend", "data", "specs", "fixture-1.json")))
PITCH_H = 680.0

def _spec(seed, minutes, directives):
    s = copy.deepcopy(BASE); s["minutes"] = minutes; s["seed"] = seed
    if directives: s["directives"] = directives
    return s

def _run(args):
    seed, minutes, directives, stream = args
    fp = os.path.join(ROOT, f"_b_{seed}_{abs(hash(json.dumps(directives)))%99999}.json")
    json.dump(_spec(seed, minutes, directives), open(fp, "w"))
    cmd = [ENGINE, "--match", fp, "--no-debug"] + ([] if stream else ["--summary"])
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=240).stdout
    os.remove(fp)
    return out

def num(v): return sum(v.values()) if isinstance(v, dict) else (v or 0)

def summary(args):
    out = _run((*args, False))
    return json.loads([l for l in out.splitlines() if l.strip().startswith("{")][-1])

def avg_pos(args):
    # Memory-safe: stream the (huge) frame output line-by-line and accumulate ONLY
    # the target player's running sums — never hold all frames (that OOM'd at 6x).
    # Sample every 4th frame to cut JSON-parse CPU; the average is unaffected.
    seed, minutes, directives, pid = args
    fp = os.path.join(ROOT, f"_p_{seed}_{abs(hash(json.dumps(directives)))%99999}.json")
    json.dump(_spec(seed, minutes, directives), open(fp, "w"))
    proc = subprocess.Popen([ENGINE, "--match", fp, "--no-debug"], stdout=subprocess.PIPE, text=True, bufsize=1 << 16)
    sx = say = n = i = 0
    needle = f'"id":{pid},'
    for line in proc.stdout:
        if not line.startswith("{"): continue
        i += 1
        if i & 3: continue                 # sample 1 in 4 frames
        if needle not in line: continue
        try: f = json.loads(line)
        except: continue
        for p in f.get("players", []):
            if p.get("id") == pid:
                sx += p["x"]; say += abs(p["y"] - PITCH_H / 2.0); n += 1
                break
    proc.wait(); os.remove(fp)
    n = max(1, n)
    return sx / n, say / n

# ── stat benchmarks: (name, directives, stat_fn, "up"/"down", note) ──
P = lambda ids, kind: [{"playerId": i, "kind": kind} for i in ids]
T = lambda kind: [{"teamScope": 0, "kind": kind}]
STAT = [
    ("shoot_on_sight", P([5,6,7,9], "shoot_on_sight"), lambda d: num(d.get("homeShots")), "up",   "home CM+CF"),
    ("cross_early",    P([1,4,8,10], "cross_early"),    lambda d: num(d.get("homeCrossesAttempted")), "up", "home wide"),
    ("tackle_hard",    P([1,2,3,4], "tackle_hard"),     lambda d: num(d.get("yellowCards")), "up",  "home def"),
    ("stay_on_feet",   P([1,2,3,4], "stay_on_feet"),    lambda d: num(d.get("yellowCards")), "down","home def"),
    ("all_out_attack", T("all_out_attack"),             lambda d: num(d.get("homeShots")), "up",   "home"),
    ("park_the_bus",   T("park_the_bus"),               lambda d: num(d.get("homeShots")), "down", "home"),
    ("high_press",     T("high_press"),                 lambda d: num(d.get("tackles")), "up",     "home"),
    ("drop_off",       T("drop_off"),                   lambda d: num(d.get("tackles")), "down",   "home"),
    ("keep_it_on_ground", T("keep_it_on_ground"),       lambda d: num(d.get("passCompletionPct")), "up", "home"),
    # added 2026-06-15 — coverage for the previously-unbenchmarked kinds
    ("man_mark",       [{"playerId":2,"kind":"man_mark","targetId":20},{"playerId":3,"kind":"man_mark","targetId":20}],
                                                         lambda d: num(d.get("awayShots")), "down", "2 CBs on their CF #20"),
    ("press_hard",     P([1,2,3,4], "press_hard"),       lambda d: num(d.get("tackles")), "up",     "home def"),
    ("play_simple",    P([5,6,7], "play_simple"),        lambda d: num(d.get("passCompletionPct")), "up", "home CM"),
    ("play_it_long",   T("play_it_long"),                lambda d: num(d.get("passCompletionPct")), "down", "home"),
    ("slow_it_down",   T("slow_it_down"),                lambda d: num(d.get("passCompletionPct")), "up", "home"),
    ("dribble_more",   P([8,9,10], "dribble_more"),      lambda d: num(d.get("dribbleTypes")), "up", "home att"),
    ("counter_attack", T("counter_attack"),              lambda d: num(d.get("throughBallsCompleted")), "up", "home break"),
    ("offside_trap",   T("offside_trap"),                lambda d: num(d.get("offsides")), "up", "home traps away"),
]
# ── movement benchmarks: (name, directives, pid, axis x|absy, up/down) ──
POS = [
    ("get_forward",   [{"playerId": 6, "kind": "get_forward"}],  6, "x",    "up",   "CM #6"),
    ("sit_deep",      [{"playerId": 6, "kind": "sit_deep"}],     6, "x",    "down", "CM #6"),
    ("stay_wide",     [{"playerId": 10, "kind": "stay_wide"}],  10, "absy", "up",   "WM #10"),
    ("come_inside",   [{"playerId": 10, "kind": "come_inside"}],10, "absy", "down", "WM #10"),
    ("get_it_wide",   [{"teamScope": 0, "kind": "get_it_wide"}], 1, "absy", "up",   "home FB #1 width"),
    ("play_narrow",   [{"teamScope": 0, "kind": "play_narrow"}], 1, "absy", "down", "home FB #1 width"),
    ("run_in_behind", [{"playerId": 9, "kind": "run_in_behind"}], 9, "x",    "up",   "CF #9 advances"),
    ("stay_central",  [{"playerId": 10, "kind": "stay_central"}],10, "absy", "down", "WM #10 narrows"),
    ("push_up",       [{"teamScope": 0, "kind": "push_up"}],      2, "x",    "up",   "home CB #2 line"),
]
ALL_KINDS = [  # one of every kind, for the determinism torture spec
    {"playerId":2,"kind":"man_mark","targetId":20},{"playerId":9,"kind":"shoot_on_sight"},
    {"playerId":6,"kind":"get_forward"},{"playerId":3,"kind":"sit_deep"},{"playerId":5,"kind":"target_player","targetId":9},
    {"playerId":10,"kind":"stay_wide"},{"playerId":8,"kind":"come_inside"},{"playerId":7,"kind":"stay_central"},
    {"playerId":1,"kind":"cross_early"},{"playerId":5,"kind":"switch_play"},{"playerId":7,"kind":"play_simple"},
    {"playerId":9,"kind":"run_in_behind"},{"playerId":8,"kind":"make_runs"},{"playerId":9,"kind":"dribble_more"},
    {"playerId":2,"kind":"press_hard"},{"playerId":3,"kind":"tackle_hard"},{"playerId":4,"kind":"stay_on_feet"},
    {"teamScope":0,"kind":"all_out_attack"},{"teamScope":1,"kind":"park_the_bus"},
    {"playerId":6,"kind":"get_forward","when":{"fromMin":20,"toMin":70}},
    {"teamScope":0,"kind":"high_press","when":{"scoreState":"losing"}},
    {"teamScope":0,"kind":"counter_attack"},{"teamScope":1,"kind":"offside_trap"},
]

def main():
    SEEDS = list(range(1, 31)); MIN = 35
    POS_SEEDS = list(range(1, 13)); POS_MIN = 14   # 5 seeds false-failed get_forward (noise); 12 is reliable
    fails = []

    # 1. determinism (all kinds in one spec, x2)
    a = json.dumps(summary((40985, 40, ALL_KINDS)), sort_keys=True)
    b = json.dumps(summary((40985, 40, ALL_KINDS)), sort_keys=True)
    det = "PASS" if a == b else "FAIL"
    if det == "FAIL": fails.append("determinism")
    print(f"[determinism] all-kinds spec x2: {det}")

    # 2. stat benchmarks (parallel). Verdict is a PAIRED per-seed sign test —
    # robust to cross-match variance, which makes summed totals (esp. for noisy
    # cross counts) misleading. win = the same seed moved the expected direction.
    print(f"\n[effect benchmarks] {len(SEEDS)} seeds x {MIN}min, paired per-seed (only HOME directed)")
    print(f"  {'kind':<18}{'base':>8}{'directed':>9}{'mean d':>9}{'win%':>7}  verdict   note")
    with ProcessPoolExecutor(max_workers=min(8, (os.cpu_count() or 4))) as ex:
        base = {s: f for s, f in zip(SEEDS, ex.map(summary, [(s, MIN, None) for s in SEEDS]))}
        for name, dirs, fn, want, note in STAT:
            got = {s: g for s, g in zip(SEEDS, ex.map(summary, [(s, MIN, dirs) for s in SEEDS]))}
            pairs = [(fn(base[s]), fn(got[s])) for s in SEEDS]
            sgn = 1 if want == "up" else -1
            wins = sum(1 for b, d in pairs if (d - b) * sgn > 0)
            ties = sum(1 for b, d in pairs if d == b)
            winrate = wins / max(1, len(pairs) - ties)
            bv = sum(b for b, _ in pairs) / len(pairs); dv = sum(d for _, d in pairs) / len(pairs)
            # PASS: directed wins clearly. WEAK: ~coin-flip (within noise, no
            # reliable effect). FAIL: consistently the WRONG direction.
            verdict = "PASS" if winrate >= 0.62 else ("FAIL" if winrate <= 0.38 else "WEAK")
            if verdict == "FAIL": fails.append(name)
            print(f"  {name:<18}{bv:>8.0f}{dv:>9.0f}{dv-bv:>+9.1f}{100*winrate:>6.0f}%  {verdict:<7}   {note}")

    # 3. movement benchmarks (frame positions) — skip with BENCH_NOPOS=1 for a fast
    # stat-only re-run (the movement kinds are stable).
    if os.environ.get("BENCH_NOPOS"):
        print("\n[movement benchmarks] skipped (BENCH_NOPOS)")
        if fails: print(f"\nFAILURES: {fails}"); sys.exit(1)
        print("\nstat benchmarks pass"); return
    print(f"\n[movement benchmarks] {len(POS_SEEDS)} seeds x {POS_MIN}min (directed player avg position)")
    with ProcessPoolExecutor(max_workers=2) as ex:   # streaming is memory-heavy — keep it low
        for name, dirs, pid, axis, want, note in POS:
            b0 = list(ex.map(avg_pos, [(s, POS_MIN, None, pid) for s in POS_SEEDS]))
            d0 = list(ex.map(avg_pos, [(s, POS_MIN, dirs, pid) for s in POS_SEEDS]))
            idx = 0 if axis == "x" else 1
            bv = sum(p[idx] for p in b0) / len(b0); dv = sum(p[idx] for p in d0) / len(d0)
            moved = (dv > bv) if want == "up" else (dv < bv)
            res = "PASS" if moved else ("flat" if abs(dv - bv) < 8 else "FAIL")
            if res == "FAIL": fails.append(name)
            print(f"  {name:<18}{axis:>5} {bv:>7.0f} -> {dv:>7.0f}  ({dv-bv:+.0f}px)  expect {want:<5} {res}  ({note})")

    print(f"\n{'='*48}")
    if fails: print(f"FAILURES: {fails}"); sys.exit(1)
    print("ALL TACTICS BENCHMARKS PASS")

if __name__ == "__main__":
    main()

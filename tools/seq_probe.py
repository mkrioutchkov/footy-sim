#!/usr/bin/env python3
"""Uninterrupted pass-sequence distribution probe (build-up calibration).

A "sequence" = consecutive completed passes by ONE team, cut by a loss of
possession (intercept / tackle won by the opponent / ball came loose), a shot,
a dead ball (offside), or a restart (kickoff). Dribble moves (skill/nutmeg/
dragback) by the holding team do NOT break or extend a sequence. This mirrors
Opta's open-play convention; restarts reset the count.

Read-only over engine --trace captures (no engine change, no golden touch).

Usage:
  python tools/seq_probe.py --seeds 1-24 [--minutes 90]
  python tools/seq_probe.py trace1.bin trace2.bin ...
"""
import sys, os, subprocess, argparse, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from trace_reader import TraceReader

THRESHOLDS = [1, 5, 10, 15, 20, 25, 30]
# A sequence ends on a DEFINITIVE turnover (opponent intercept / tackle won), a
# shot, a dead ball (offside), or a restart (kickoff). NOT on tackle_loose: that
# is a contested loose ball (controllerId=-1) the SAME team often recovers — the
# possession-flip rule (a pass by the other team) handles a real turnover there,
# so counting tackle_loose as an ender artificially splits sequences (Opta
# convention; audited 2026-06-18).
END_EVENTS = {"intercept", "tackle_won", "shot", "goal", "offside", "kickoff", "woodwork"}

def side(pid):
    return 0 if 0 <= pid < 11 else (1 if pid >= 11 else -1)

def sequences_from_trace(path):
    """Return list of sequence lengths (completed-pass counts) for one match."""
    t = TraceReader(path)
    evs = sorted(t.events, key=lambda e: e.clock_ms)
    seqs = []
    cur_team = -1
    count = 0
    def flush():
        nonlocal count, cur_team
        if count > 0:
            seqs.append(count)
        count = 0
        cur_team = -1
    for e in evs:
        ty = e.type
        if ty == "pass":
            tm = side(e.player_id)
            if cur_team == -1:
                cur_team = tm; count = 1
            elif tm == cur_team:
                count += 1
            else:               # possession flipped to the other team
                flush(); cur_team = tm; count = 1
        elif ty in END_EVENTS:
            # a turnover/shot/stoppage ends the current possession's sequence
            flush()
        # else: dribble/header/save/block/etc. — neither a pass nor a hard cut
    flush()
    return seqs, (t.frames[-1].clock_ms / 60000.0 if t.frames else 0.0)

def run_match(seed, minutes, engine):
    fd, path = tempfile.mkstemp(suffix=f"_seq{seed}.bin"); os.close(fd)
    subprocess.run([engine, str(seed), str(minutes), "--no-debug", "--trace", path],
                   capture_output=True, timeout=600)
    try:
        return sequences_from_trace(path)
    finally:
        try: os.remove(path)
        except OSError: pass

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("traces", nargs="*")
    ap.add_argument("--seeds", default=None, help="e.g. 1-24")
    ap.add_argument("--minutes", type=int, default=90)
    ap.add_argument("--engine", default=os.path.join("build", "live.exe"))
    args = ap.parse_args()

    all_seqs = []
    total_minutes = 0.0
    n_matches = 0
    if args.seeds:
        a, b = args.seeds.split("-"); lo, hi = int(a), int(b)
        for s in range(lo, hi + 1):
            seqs, mins = run_match(s, args.minutes, args.engine)
            all_seqs += seqs; total_minutes += mins; n_matches += 1
            print(f"  seed {s}: {len(seqs)} sequences, max {max(seqs) if seqs else 0}", flush=True)
    else:
        for p in args.traces:
            seqs, mins = sequences_from_trace(p)
            all_seqs += seqs; total_minutes += mins; n_matches += 1

    if not all_seqs:
        print("no sequences"); return
    per90 = 90.0 / (total_minutes / n_matches) if total_minutes else 1.0  # scale one match to 90
    # combined (both teams) per 90 = (total over N matches) / N * (90/matchlen)
    scale = (90.0 / (total_minutes / n_matches)) / n_matches if total_minutes else 0
    print(f"\n=== {n_matches} matches, {total_minutes/n_matches:.0f} min each, {len(all_seqs)} total sequences ===")
    mean_len = sum(all_seqs) / len(all_seqs)
    print(f"mean sequence length: {mean_len:.2f} passes  (real benchmark ~4.7)")
    print(f"{'thresh':>7} {'count/90 (both teams)':>22} {'per team':>10}")
    raw = {}
    for th in THRESHOLDS:
        c = sum(1 for s in all_seqs if s >= th)
        raw[th] = c
        per90c = c * scale
        print(f"  {('>='+str(th)):>5} {per90c:>20.1f} {per90c/2:>10.1f}")
    # machine-parseable raw line (for aggregating across batches before scaling)
    import json as _json
    print("RAW " + _json.dumps({"matches": n_matches, "total_minutes": round(total_minutes, 1),
                                "mean_len": round(mean_len, 3), "max_len": max(all_seqs),
                                "counts": raw}))

if __name__ == "__main__":
    main()

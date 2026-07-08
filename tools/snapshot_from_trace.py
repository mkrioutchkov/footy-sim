#!/usr/bin/env python3
"""Extract a SITUATION SNAPSHOT from a match trace, for engine --snapshot-in.

The engine is deterministic per (seed + code): any code change reshuffles every
moment after it, so a cited moment ("0:58 in seed 103") disappears from the
re-run — the butterfly effect. This tool freezes the SITUATION (positions,
velocities, facing, stamina, ball state, clock, score) from the ORIGINAL trace
so any engine version — including one with the fix applied — can load it as an
initial condition and play the same moment forward under its own logic:

    python3 tools/snapshot_from_trace.py trace.bin --ms 58000 -o moment.json
    ./build/live.exe <seed> <minutes> --snapshot-in moment.json --trace out.bin

Notes:
  - Snapshots are cross-version by design; they restore the physical situation,
    not the RNG stream. Agent trackers/perceptions start fresh at load.
  - Dead-ball moments (a restart mid-arming) don't restore meaningfully — the
    tool warns when a restart event sits within +-3s and suggests using a live
    frame instead.
"""
import argparse, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trace_reader import TraceReader

RESTART_EVENTS = {"kickoff", "corner", "free_kick", "throw_in", "goal_kick", "goal", "penalty", "offside"}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trace", help="trace .bin (from --trace)")
    ap.add_argument("--ms", type=float, required=True, help="match clock (ms) to snapshot")
    ap.add_argument("-o", "--out", default=None, help="output json (default: <trace>.<ms>.snapshot.json)")
    ap.add_argument("--force", action="store_true", help="snapshot even inside a dead-ball window")
    args = ap.parse_args()

    best = None
    for fr in TraceReader.stream_frames(args.trace):
        if best is None or abs(fr.clock_ms - args.ms) < abs(best.clock_ms - args.ms):
            best = fr
        if fr.clock_ms > args.ms + 1000:
            break
    if best is None:
        sys.exit("no frames in trace")

    near = [e for e in TraceReader.read_events(args.trace)
            if abs(e.clock_ms - args.ms) < 3000 and e.type in RESTART_EVENTS]
    if near and not args.force:
        print("WARNING: restart/goal events within +-3s of the requested moment:")
        for e in near:
            print(f"  {e.clock_ms/1000:.2f}s {e.type} pid={e.player_id}")
        print("A dead-ball situation doesn't restore meaningfully. Pick a live frame nearby"
              " (ball moving or controlled) or re-run with --force.")
        if any(abs(e.clock_ms - best.clock_ms) < 700 for e in near):
            sys.exit(2)

    b = best.ball
    snap = {
        "version": 1,
        "meta": {"sourceTrace": os.path.basename(args.trace), "requestedMs": args.ms,
                 "frameMs": best.clock_ms},
        "clockMs": best.clock_ms,
        "score": {"home": best.home_score, "away": best.away_score},
        "ball": {"x": round(b.x, 2), "y": round(b.y, 2), "z": round(b.z, 2),
                 "vx": round(b.vx, 2), "vy": round(b.vy, 2), "vz": round(b.vz, 2),
                 "curl": round(getattr(b, "curl", 0.0), 4),
                 "controllerId": b.controller_id,
                 "intendedReceiverId": getattr(b, "intended_receiver_id", -1),
                 "lastToucherId": getattr(b, "last_toucher_id", -1)},
        "players": [
            {"id": p.id, "x": round(p.x, 2), "y": round(p.y, 2),
             "vx": round(p.vx, 2), "vy": round(p.vy, 2),
             "targetX": round(getattr(p, "target_x", p.x), 2),
             "targetY": round(getattr(p, "target_y", p.y), 2),
             "facing": round(p.facing, 4),
             "stamina": round(getattr(p, "stamina", 100.0), 2)}
            for p in best.players
        ],
    }
    out = args.out or f"{args.trace}.{int(args.ms)}.snapshot.json"
    with open(out, "w") as f:
        json.dump(snap, f, indent=1)
    print(f"snapshot @ {best.clock_ms/1000:.2f}s (requested {args.ms/1000:.2f}s) -> {out}")
    print(f"  score {best.home_score}-{best.away_score}  ball ({b.x:.0f},{b.y:.0f},z{b.z:.0f}) "
          f"v=({b.vx:.0f},{b.vy:.0f}) ctrl={b.controller_id}")

if __name__ == "__main__":
    main()

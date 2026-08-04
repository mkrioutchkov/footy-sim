#!/usr/bin/env python3
"""engagement_audit.py — per-player 'wake-up' anomaly probe for footy-sim traces.

Trigger semantics
-----------------
A tick is WINNABLE for player P when the ball is up for grabs from P's side —
loose (controller_id < 0) or controlled by an OPPONENT — and P is within
--radius of the ball and among the --n-closest of his own outfielders to it.
(A ball controlled by, or in flight to, a teammate still counts as loose in the
raw state; each episode records ball_state so 'flight_mate' cases — where the
engine deliberately leaves the ball to the intended receiver — can be told
apart from truly contestable ones.)

Two detectors run over every player's winnable stretches:

  FROZEN  P's scalar speed stays under --walk for >= --min-latency, then within
          --wake-window his speed exceeds --run: he stood/walked next to a
          winnable ball, then abruptly accelerated.  (The literal "disengaged,
          then suddenly wakes up" signature.)
  AVERTED P's velocity component TOWARD the ball stays under --close for
          >= --min-latency (he may be moving fast — just not at the ball),
          then within --wake-window it exceeds --burst: he ignored a winnable
          ball he was among the closest to, then abruptly turned and attacked
          it.  (Catches the running-the-wrong-way-then-whirling case a pure
          speed gate misses.)

Episodes that fade without a wake (the ball got claimed / left the radius while
P never engaged) are tallied per player as `faded` but are not anomalies.
Latency = wake time minus the start of the disengaged-while-winnable stretch.
heading_flip is the angle (deg) between P's velocity just before the wake
window and just after the wake — 180 means the visually-jarring full pivot.

Dead-ball choreography is blanked: [t-0.5s, t+8s] around throw_in / free_kick /
goal_kick / corner / kickoff / goal / half_time events, [t-0.5s, t+3s] around
freeze / stuck, and the first 2s of each half, so restart holds don't read as
frozen players.  ball_state is the MODE over the disengaged stretch
(loose / flight_mate / flight_opp / opp_ctrl).

GKs (pid 0 and 11) are excluded unless --include-gk.

Usage
-----
    python3 engagement_audit.py build/replay/s151.bin [--top 10] [--json out.json]
Thresholds (defaults tuned on seed 151; units: engine px = decimeters, px/s):
    --n-closest 3  --radius 300  --walk 30  --run 45  --close 12  --burst 38
    --min-latency 1.25  --wake-window 0.6
"""
import argparse
import json
import math
import os
import statistics
import sys

# trace_reader.py lives beside this script in tools/; --tools overrides when a
# copy runs from elsewhere.
def _import_reader(tools_dir):
    sys.path.insert(0, tools_dir)
    from trace_reader import TraceReader  # noqa: E402
    return TraceReader


def shirt(pid):
    return f"H{pid + 1}" if pid < 11 else f"A{pid - 10}"


def build_blank_windows(events, first_half_starts):
    """[t0,t1] ms windows to ignore (restart choreography, freeze rescues)."""
    win = []
    for ev in events:
        if ev.type in ("throw_in", "free_kick", "goal_kick", "corner",
                       "corner_short", "goal", "kickoff", "half_time"):
            win.append((ev.clock_ms - 500.0, ev.clock_ms + 8000.0))
        elif ev.type in ("freeze", "stuck"):
            win.append((ev.clock_ms - 500.0, ev.clock_ms + 3000.0))
    for t in first_half_starts:
        win.append((t, t + 2000.0))
    win.sort()
    merged = []
    for a, b in win:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return merged


class Track:
    """One detector's state machine for one player."""
    __slots__ = ("active", "t0", "d0", "rank0", "pending", "pend_t", "pend_d",
                 "pend_state", "pre_vx", "pre_vy", "st_counts")

    def __init__(self):
        self.active = False   # in a disengaged-while-winnable stretch
        self.t0 = 0.0
        self.d0 = 0.0
        self.rank0 = 0
        self.pending = False  # stretch ended by re-engagement; waiting for wake
        self.pend_t = 0.0
        self.pend_d = 0.0
        self.pend_state = ""
        self.pre_vx = 0.0
        self.pre_vy = 0.0
        self.st_counts = {}   # ball_state tick counts over the stretch


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("trace")
    ap.add_argument("--tools", default=None, help="dir containing trace_reader.py "
                    "(default: this script's own directory)")
    ap.add_argument("--n-closest", type=int, default=3)
    ap.add_argument("--radius", type=float, default=300.0, help="winnable ball radius, px")
    ap.add_argument("--walk", type=float, default=30.0, help="FROZEN: speed floor, px/s")
    ap.add_argument("--run", type=float, default=45.0, help="FROZEN: wake speed, px/s")
    ap.add_argument("--close", type=float, default=12.0, help="AVERTED: ballward-velocity floor, px/s")
    ap.add_argument("--burst", type=float, default=38.0, help="AVERTED: wake ballward velocity, px/s")
    ap.add_argument("--min-latency", type=float, default=1.25, help="seconds disengaged before a wake counts "
                    "(keep well above the ~0.3s momentum plant-and-brake dip)")
    ap.add_argument("--wake-window", type=float, default=0.6, help="seconds after stretch end for the wake")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--include-gk", action="store_true")
    ap.add_argument("--json", default=None, help="write full episode list + summary as JSON")
    args = ap.parse_args()

    tools_dir = args.tools or os.path.dirname(os.path.abspath(__file__))
    TraceReader = _import_reader(tools_dir)

    events = TraceReader.read_events(args.trace)
    half_starts = [0.0] + [e.clock_ms for e in events if e.type == "half_time"]
    blanks = build_blank_windows(events, half_starts)

    gk = () if args.include_gk else (0, 11)
    wake_win_ms = args.wake_window * 1000.0
    min_lat_ms = args.min_latency * 1000.0

    episodes = []            # dicts
    faded = {p: 0 for p in range(22)}
    frozen_tr = {p: Track() for p in range(22)}
    avert_tr = {p: Track() for p in range(22)}
    prev_v = {p: (0.0, 0.0) for p in range(22)}

    bi = 0                   # blank window cursor
    n_frames = 0
    for fr in TraceReader.stream_frames(args.trace):
        t = fr.clock_ms
        n_frames += 1
        while bi < len(blanks) and t > blanks[bi][1]:
            bi += 1
        blanked = bi < len(blanks) and blanks[bi][0] <= t <= blanks[bi][1]

        b = fr.ball
        ctrl = b.controller_id
        intended = b.intended_receiver_id
        ctrl_team = -1 if ctrl < 0 else (0 if ctrl < 11 else 1)

        # distances + per-team closeness rank
        ps = fr.players
        dists = [0.0] * 22
        for p in ps:
            dists[p.id] = math.hypot(b.x - p.x, b.y - p.y)
        for p in ps:
            pid = p.id
            team = 0 if pid < 11 else 1
            if pid in gk:
                continue
            d = dists[pid]
            spd = math.hypot(p.vx, p.vy)
            if d > 1e-6:
                closing = ((b.x - p.x) * p.vx + (b.y - p.y) * p.vy) / d
            else:
                closing = 0.0

            winnable = (not blanked) and (ctrl_team != team) and d <= args.radius and ctrl != pid
            if winnable:
                rank = 1
                lo = 0 if team == 0 else 11
                for q in range(lo, lo + 11):
                    if q != pid and q not in gk and dists[q] < d:
                        rank += 1
                winnable = rank <= args.n_closest
            else:
                rank = 99

            if ctrl < 0 and intended < 0:
                bstate = "loose"
            elif ctrl < 0:
                bstate = "flight_mate" if (intended < 11) == (team == 0) else "flight_opp"
            else:
                bstate = "opp_ctrl"

            for kind, tr, low, high, metric in (
                ("FROZEN", frozen_tr[pid], args.walk, args.run, spd),
                ("AVERTED", avert_tr[pid], args.close, args.burst, closing),
            ):
                if tr.pending:
                    if metric >= high:
                        dur = tr.pend_t - tr.t0
                        pvx, pvy = tr.pre_vx, tr.pre_vy
                        flip = 0.0
                        if spd > 5.0 and math.hypot(pvx, pvy) > 5.0:
                            dot = (pvx * p.vx + pvy * p.vy) / (math.hypot(pvx, pvy) * spd)
                            flip = math.degrees(math.acos(max(-1.0, min(1.0, dot))))
                        episodes.append(dict(
                            pid=pid, label=shirt(pid), kind=kind,
                            t_start=round(tr.t0 / 1000.0, 2),
                            t_wake=round(t / 1000.0, 2),
                            latency=round(dur / 1000.0, 2),
                            d_start=round(tr.d0 / 10.0, 1),      # meters
                            d_wake=round(d / 10.0, 1),
                            rank=tr.rank0, ball_state=tr.pend_state,
                            heading_flip=round(flip)))
                        tr.pending = False
                    elif t - tr.pend_t > wake_win_ms:
                        faded[pid] += 1
                        tr.pending = False
                disengaged = winnable and metric < low
                if disengaged:
                    if not tr.active:
                        tr.active = True
                        tr.t0, tr.d0, tr.rank0 = t, d, rank
                        tr.st_counts = {}
                    tr.st_counts[bstate] = tr.st_counts.get(bstate, 0) + 1
                elif tr.active:
                    tr.active = False
                    if t - tr.t0 >= min_lat_ms:
                        if winnable or metric >= low:   # re-engaged: arm the wake test
                            tr.pending = True
                            tr.pend_t, tr.pend_d = t, d
                            tr.pend_state = max(tr.st_counts, key=tr.st_counts.get)
                            tr.pre_vx, tr.pre_vy = prev_v[pid]
                        else:                            # ball claimed/left: no wake
                            faded[pid] += 1
            prev_v[pid] = (p.vx, p.vy)

    # de-dupe: drop AVERTED episodes fully inside a FROZEN one for the same pid
    frozen_eps = [e for e in episodes if e["kind"] == "FROZEN"]
    def dominated(e):
        return any(f["pid"] == e["pid"] and f["t_start"] - 0.3 <= e["t_start"]
                   and e["t_wake"] <= f["t_wake"] + 0.3 for f in frozen_eps)
    episodes = [e for e in episodes if e["kind"] == "FROZEN" or not dominated(e)]
    episodes.sort(key=lambda e: -e["latency"])

    # per-player summary
    summary = []
    for pid in range(22):
        eps = [e for e in episodes if e["pid"] == pid]
        if not eps and not faded[pid]:
            continue
        lat = [e["latency"] for e in eps]
        summary.append(dict(
            pid=pid, label=shirt(pid), episodes=len(eps),
            frozen=sum(1 for e in eps if e["kind"] == "FROZEN"),
            averted=sum(1 for e in eps if e["kind"] == "AVERTED"),
            median_latency=round(statistics.median(lat), 2) if lat else 0.0,
            max_latency=max(lat) if lat else 0.0, faded=faded[pid]))
    summary.sort(key=lambda s: (-s["episodes"], -s["median_latency"]))

    print(f"# engagement_audit  {args.trace}  frames={n_frames}")
    print(f"# winnable: ball loose/opp-side, within {args.radius:.0f}px, among "
          f"{args.n_closest} closest of team; min disengaged {args.min_latency}s")
    print(f"\n== top {args.top} wake-up anomalies (by latency) ==")
    print(f"{'label':>6} {'kind':>7} {'t_start':>8} {'t_wake':>8} {'lat_s':>6} "
          f"{'d0_m':>5} {'dw_m':>5} {'rank':>4} {'flip':>4}  ball_state")
    for e in episodes[:args.top]:
        print(f"{e['label']:>6} {e['kind']:>7} {e['t_start']:>8.2f} {e['t_wake']:>8.2f} "
              f"{e['latency']:>6.2f} {e['d_start']:>5.1f} {e['d_wake']:>5.1f} "
              f"{e['rank']:>4} {e['heading_flip']:>4}  {e['ball_state']}")

    print(f"\n== per-player engagement summary ==")
    print(f"{'label':>6} {'eps':>4} {'frozen':>6} {'averted':>7} {'med_lat':>7} "
          f"{'max_lat':>7} {'faded':>5}")
    for s in summary:
        print(f"{s['label']:>6} {s['episodes']:>4} {s['frozen']:>6} {s['averted']:>7} "
              f"{s['median_latency']:>7.2f} {s['max_latency']:>7.2f} {s['faded']:>5}")

    if args.json:
        with open(args.json, "w") as f:
            json.dump(dict(episodes=episodes, summary=summary), f, indent=1)
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()

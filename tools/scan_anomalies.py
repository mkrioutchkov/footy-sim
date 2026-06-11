#!/usr/bin/env python3
"""Sweep trace files for gameplay anomalies and print a timestamped report.

Usage: python tools/scan_anomalies.py build/t101.bin [more traces...]
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
from trace_reader import TraceReader

PITCH_W, PITCH_H = 1050, 680
MAX_PLAYER_SPEED = 220.0       # px/s — generous ceiling for sprint speed
OVERLAP_DIST = 9.0             # two players closer than this = bodies overlapping
OVERLAP_MIN_MS = 700           # sustained overlap before flagging
TELEPORT_FACTOR = 3.0          # actual move > factor * velocity-explained + slack
TELEPORT_SLACK = 25.0
LOOSE_NO_CHASE_MS = 2500       # loose ball, slow, nobody within reach moving to it
OOB_MARGIN = 12.0              # outside pitch by more than this
OOB_MIN_MS = 1500
SPIN_WINDOW_MS = 1500
SPIN_DEG = 540.0


def speed(vx, vy):
    return math.hypot(vx, vy)


def fmt_ms(ms):
    s = ms / 1000.0
    return f"{int(s//60)}:{s%60:04.1f}"


def scan(path):
    t = TraceReader(path)
    frames = t.frames
    if not frames:
        print(f"{path}: empty trace")
        return
    dt_ms = (frames[-1].clock_ms - frames[0].clock_ms) / max(1, len(frames) - 1)
    report = []  # (clock_ms, category, message)

    # per-player rolling state
    prev = None
    overlap_since = {}        # (idA,idB) -> start ms
    overlap_flagged = set()
    oob_since = {}            # id -> start ms
    oob_flagged = set()
    facing_hist = {p.id: [] for p in frames[0].players}
    spin_cool = {p.id: -1e9 for p in frames[0].players}
    loose_since = None
    loose_flagged_at = -1e9
    max_spd_seen = {}

    for fi, f in enumerate(frames):
        ms = f.clock_ms
        b = f.ball

        if prev is not None:
            pdt = max(1e-3, (ms - prev.clock_ms) / 1000.0)
            # ── ball teleport (loose ball only; controller change = kick) ──
            if b.controller_id < 0 and prev.ball.controller_id < 0:
                moved = math.hypot(b.x - prev.ball.x, b.y - prev.ball.y)
                explained = speed(prev.ball.vx, prev.ball.vy) * pdt + abs(prev.ball.vz) * pdt
                if moved > TELEPORT_FACTOR * explained + TELEPORT_SLACK:
                    report.append((ms, "BALL_TELEPORT",
                        f"ball jumped {moved:.0f}px (vel explains {explained:.0f}) "
                        f"({prev.ball.x:.0f},{prev.ball.y:.0f})->({b.x:.0f},{b.y:.0f})"))
            # ── player teleports / overspeed ──
            for p, q in zip(prev.players, f.players):
                moved = math.hypot(q.x - p.x, q.y - p.y)
                inst = moved / pdt
                max_spd_seen[q.id] = max(max_spd_seen.get(q.id, 0), inst)
                if inst > MAX_PLAYER_SPEED and moved > 12:
                    report.append((ms, "PLAYER_TELEPORT",
                        f"player {q.id} moved {moved:.0f}px in {pdt*1000:.0f}ms ({inst:.0f}px/s) "
                        f"({p.x:.0f},{p.y:.0f})->({q.x:.0f},{q.y:.0f})"))

        # ── sustained player-player overlap (excluding tackles/headers) ──
        ps = f.players
        for i in range(len(ps)):
            for k in range(i + 1, len(ps)):
                a, c = ps[i], ps[k]
                d = math.hypot(a.x - c.x, a.y - c.y)
                key = (a.id, c.id)
                if d < OVERLAP_DIST and a.tackle_anim <= 0 and c.tackle_anim <= 0:
                    if key not in overlap_since:
                        overlap_since[key] = ms
                    elif ms - overlap_since[key] > OVERLAP_MIN_MS and key not in overlap_flagged:
                        same = "SAME-TEAM" if (a.id <= 10) == (c.id <= 10) else "opponents"
                        report.append((ms, "PLAYER_OVERLAP",
                            f"players {a.id}&{c.id} ({same}) within {d:.0f}px for "
                            f"{(ms-overlap_since[key])/1000:.1f}s at ({a.x:.0f},{a.y:.0f})"))
                        overlap_flagged.add(key)
                else:
                    overlap_since.pop(key, None)
                    overlap_flagged.discard(key)

        # ── players stuck out of bounds ──
        for p in ps:
            oob = (p.x < -OOB_MARGIN or p.x > PITCH_W + OOB_MARGIN or
                   p.y < -OOB_MARGIN or p.y > PITCH_H + OOB_MARGIN)
            if oob:
                if p.id not in oob_since:
                    oob_since[p.id] = ms
                elif ms - oob_since[p.id] > OOB_MIN_MS and p.id not in oob_flagged:
                    report.append((ms, "PLAYER_OOB",
                        f"player {p.id} out of bounds {(ms-oob_since[p.id])/1000:.1f}s at ({p.x:.0f},{p.y:.0f})"))
                    oob_flagged.add(p.id)
            else:
                oob_since.pop(p.id, None)
                oob_flagged.discard(p.id)

        # ── spin detection (unwrapped facing accumulation) ──
        for p in ps:
            h = facing_hist[p.id]
            h.append((ms, p.facing))
            while h and ms - h[0][0] > SPIN_WINDOW_MS:
                h.pop(0)
            if len(h) > 3 and ms - spin_cool[p.id] > 3000:
                total = 0.0
                for (m0, f0), (m1, f1) in zip(h, h[1:]):
                    d = f1 - f0
                    while d > math.pi: d -= 2 * math.pi
                    while d < -math.pi: d += 2 * math.pi
                    total += abs(d)
                if math.degrees(total) > SPIN_DEG:
                    report.append((ms, "SPIN",
                        f"player {p.id} rotated {math.degrees(total):.0f} deg in {SPIN_WINDOW_MS}ms"))
                    spin_cool[p.id] = ms

        # ── loose ball nobody collects ──
        bspd = speed(b.vx, b.vy)
        if b.controller_id < 0 and bspd < 40 and 0 < b.x < PITCH_W and 0 < b.y < PITCH_H and b.z < 5:
            if loose_since is None:
                loose_since = ms
            elif ms - loose_since > LOOSE_NO_CHASE_MS and ms - loose_flagged_at > 5000:
                nd = min(math.hypot(p.x - b.x, p.y - b.y) for p in ps)
                report.append((ms, "LOOSE_STALL",
                    f"ball loose+slow for {(ms-loose_since)/1000:.1f}s at ({b.x:.0f},{b.y:.0f}) "
                    f"spd={bspd:.0f} nearest player {nd:.0f}px"))
                loose_flagged_at = ms
        else:
            loose_since = None

        prev = f

    # ── summary ──
    name = os.path.basename(path)
    print(f"\n{'='*72}\n{name}: seed={t.header.seed} frames={len(frames)} "
          f"dur={fmt_ms(frames[-1].clock_ms)} dt~{dt_ms:.1f}ms "
          f"score={frames[-1].home_score}-{frames[-1].away_score} events={len(t.events)}")
    by_cat = {}
    for ms, cat, msg in report:
        by_cat.setdefault(cat, []).append((ms, msg))
    if not report:
        print("  no anomalies flagged")
    for cat, items in sorted(by_cat.items()):
        print(f"\n  [{cat}] x{len(items)}")
        for ms, msg in items[:12]:
            print(f"    {fmt_ms(ms):>7}  {msg}")
        if len(items) > 12:
            print(f"    ... {len(items)-12} more")
    top = sorted(max_spd_seen.items(), key=lambda kv: -kv[1])[:3]
    print(f"\n  peak player speeds: " + ", ".join(f"#{i}={v:.0f}px/s" for i, v in top))
    # event histogram
    ev = {}
    for e in t.events:
        ev[e.type] = ev.get(e.type, 0) + 1
    print(f"  events: {ev}")


if __name__ == '__main__':
    for p in sys.argv[1:]:
        scan(p)

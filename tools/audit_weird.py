#!/usr/bin/env python3
"""Sequence-level weirdness auditor — finds plays that look wrong to a human
even when every individual frame is physically legal.

Detectors:
  PINGPONG          ball alternates between the same two players rapidly
  CARRIER_STALL     carrier holds the ball for seconds without going anywhere
  GK_ABANDON        keeper far from goal while danger is live in his box
  CROWD             player pile-ups (6+ within a small radius)
  TURNOVER_STORM    possession flips many times within a short window
  LOITER            player nearly stationary within reach of a slow loose ball
  CROSS_FLIGHT      report: airborne cross deliveries — speed, hang, bend

Usage: python tools/audit_weird.py trace.bin [--ms-from N] [--ms-to N]
"""
import math
import sys
from collections import defaultdict

sys.path.insert(0, 'tools')
from trace_reader import TraceReader


def fmt_t(ms):
    s = ms / 1000.0
    return f"{int(s//60)}:{s%60:04.1f}"


def main():
    path = sys.argv[1]
    trace = TraceReader(path)
    frames = trace.frames
    print(f"frames={len(frames)} seed={trace.header.seed}")

    issues = []

    # -- possession timeline (controller per frame) --
    ctrl = [(f.clock_ms, f.ball.controller_id) for f in frames]

    # PINGPONG: A→B→A→B touch alternation within 5s
    touches = []  # (ms, playerId) on controller change to >=0
    last = -1
    for ms, c in ctrl:
        if c != last and c >= 0:
            touches.append((ms, c))
        last = c
    i = 0
    while i + 3 < len(touches):
        a, b = touches[i][1], touches[i + 1][1]
        if a != b and touches[i + 2][1] == a and touches[i + 3][1] == b \
                and touches[i + 3][0] - touches[i][0] < 5000:
            n = 4
            j = i + 4
            while j < len(touches) and touches[j][1] == (a if n % 2 == 0 else b):
                n += 1
                j += 1
            issues.append((touches[i][0], 'PINGPONG',
                           f"players {a}<->{b} x{n} in {touches[min(j, len(touches)) - 1][0] - touches[i][0]:.0f}ms"))
            i = j
        else:
            i += 1

    # CARRIER_STALL: same controller >5s, net displacement <45px
    seg_start, seg_id, sx, sy = None, -1, 0, 0
    for f in frames:
        c = f.ball.controller_id
        if c != seg_id:
            if seg_id >= 0 and seg_start is not None:
                pass
            seg_id, seg_start, sx, sy = c, f.clock_ms, f.ball.x, f.ball.y
        elif c >= 0 and f.clock_ms - seg_start > 5000:
            d = math.hypot(f.ball.x - sx, f.ball.y - sy)
            if d < 45:
                issues.append((seg_start, 'CARRIER_STALL',
                               f"player {c} held {f.clock_ms - seg_start:.0f}ms moved {d:.0f}px"))
            seg_start, sx, sy = f.clock_ms, f.ball.x, f.ball.y  # re-arm

    # GK_ABANDON + CROWD + LOITER + TURNOVER_STORM
    flips = []
    last_team_holder = None
    gk_alarm_until = defaultdict(float)
    crowd_until = 0
    loiter = {}
    for fi, f in enumerate(frames):
        ms = f.clock_ms
        players = f.players
        # team possession flips
        c = f.ball.controller_id
        if c >= 0:
            team = 0 if c < 11 else 1
            if last_team_holder is not None and team != last_team_holder:
                flips.append(ms)
            last_team_holder = team
        # GK far from goal with live danger in his box
        for gk_idx, goal_x in ((0, 0.0), (11, 1050.0)):
            gk = players[gk_idx] if players[gk_idx].id in (0, 11) else None
            if gk is None:
                continue
            bd_goal = math.hypot(f.ball.x - goal_x, f.ball.y - 340.0)
            gk_d = math.hypot(gk.x - goal_x, gk.y - 340.0)
            opp_has = c >= 0 and ((c < 11) != (gk_idx < 11))
            if bd_goal < 240 and gk_d > 230 and (opp_has or c < 0) and ms > gk_alarm_until[gk_idx]:
                issues.append((ms, 'GK_ABANDON',
                               f"GK {gk.id} {gk_d:.0f}px out, ball {bd_goal:.0f}px from goal"))
                gk_alarm_until[gk_idx] = ms + 5000
        # crowding
        if ms > crowd_until:
            for p in players:
                near = sum(1 for q in players if math.hypot(p.x - q.x, p.y - q.y) < 50)
                if near >= 6:
                    issues.append((ms, 'CROWD', f"{near} players within 50px of ({p.x:.0f},{p.y:.0f})"))
                    crowd_until = ms + 4000
                    break
        # loiter near slow loose ball
        bs = math.hypot(f.ball.vx, f.ball.vy)
        if c < 0 and bs < 90:
            for p in players:
                d = math.hypot(p.x - f.ball.x, p.y - f.ball.y)
                spd = math.hypot(p.vx, p.vy)
                if d < 70 and spd < 18:
                    key = p.id
                    if key not in loiter:
                        loiter[key] = ms
                    elif ms - loiter[key] > 1800:
                        issues.append((loiter[key], 'LOITER',
                                       f"player {p.id} idle {ms - loiter[key]:.0f}ms beside loose ball ({d:.0f}px)"))
                        loiter[key] = ms + 6000
                else:
                    loiter.pop(p.id, None)
        else:
            loiter.clear()

    # TURNOVER_STORM: 6+ possession flips in 5s
    k = 0
    last_report = -1e9
    for j in range(len(flips)):
        while flips[j] - flips[k] > 5000:
            k += 1
        if j - k + 1 >= 6 and flips[k] - last_report > 5000:
            issues.append((flips[k], 'TURNOVER_STORM', f"{j - k + 1} possession flips in 5s"))
            last_report = flips[k]

    # -- CROSS_FLIGHT report: airborne deliveries with bend measurement --
    # Detect launch: controller -> -1 with z rising and speed > 250, wide origin.
    crosses = []
    for fi in range(1, len(frames)):
        f0, f1 = frames[fi - 1], frames[fi]
        if f0.ball.controller_id >= 0 and f1.ball.controller_id < 0:
            sp = math.hypot(f1.ball.vx, f1.ball.vy)
            wide = abs(f0.ball.y - 340.0) > 130
            if sp > 250 and f1.ball.vz > 120 and wide:
                # follow flight until touched or grounded
                ang0 = math.atan2(f1.ball.vy, f1.ball.vx)
                gi = fi
                while gi + 1 < len(frames) and frames[gi + 1].ball.controller_id < 0 \
                        and (frames[gi + 1].ball.z > 1 or gi - fi < 4) and gi - fi < 90:
                    gi += 1
                fe = frames[gi]
                spe = math.hypot(fe.ball.vx, fe.ball.vy)
                if spe < 1:
                    continue
                ang1 = math.atan2(fe.ball.vy, fe.ball.vx)
                bend = math.degrees((ang1 - ang0 + math.pi) % (2 * math.pi) - math.pi)
                dur = fe.clock_ms - f1.clock_ms
                travel = math.hypot(fe.ball.x - f1.ball.x, fe.ball.y - f1.ball.y)
                if travel > 140 and dur > 250:
                    crosses.append((f1.clock_ms, sp, dur, travel, bend))
        # cheap guard
    print(f"\n-- CROSS_FLIGHT: {len(crosses)} airborne wide deliveries --")
    bent = [c for c in crosses if abs(c[4]) > 8]
    for ms, sp, dur, travel, bend in crosses[:14]:
        print(f"  {fmt_t(ms)}  speed={sp:5.0f} hang={dur:4.0f}ms travel={travel:4.0f}px bend={bend:+5.1f}deg")
    if crosses:
        print(f"  bent>8deg: {len(bent)}/{len(crosses)}  avg|bend|={sum(abs(c[4]) for c in crosses)/len(crosses):.1f}deg"
              f"  avg speed={sum(c[1] for c in crosses)/len(crosses):.0f}")

    issues.sort()
    print(f"\n-- {len(issues)} sequence issues --")
    by = defaultdict(int)
    for ms, kind, msg in issues:
        by[kind] += 1
    for kind, n in sorted(by.items()):
        print(f"  {kind}: {n}")
    for ms, kind, msg in issues[:40]:
        print(f"  {fmt_t(ms)} [{kind}] {msg}")


if __name__ == '__main__':
    main()

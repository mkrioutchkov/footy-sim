#!/usr/bin/env python3
"""Pass-quality census from a binary trace (round-29 owner metric).

Mirrors the engine's shared pass grader (GameEngine::gradePass in
engine_actions.cpp — keep the two in sync):

    grade = pComplete * (0.55 + 0.45*threat) - (1 - pComplete) * 0.35 * turnoverDanger

pComplete distills the pass scorer's lane machinery from the release frame:
blocker perp with the step-in closing extension, graded mid-lane risk,
receiver pressure, and length. threat is normalized forward gain of the
receiver; turnoverDanger scales with how close to the passer's own goal the
ball dies if cut.

Usage:
    PYTHONPATH=tools python3 tools/pass_grade.py trace.bin [trace2.bin ...] [--floor 0.2]

Reports a grade histogram, the sub-floor count and per-90 rate, and the
calibration Brier score of pComplete against actual outcomes (completed =
next controlled touch is by the passing team).
"""
import argparse
import bisect
import math
import sys

from trace_reader import TraceReader

PITCH_W, PITCH_H = 1050.0, 680.0
PASS_BLOCKER_PERP = 36.0
PASS_RECEIVER_PRESS_MAX = 45.0
PASS_DIST_NORM = 850.0
FLOOR_DEFAULT = 0.2


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def grade_pass(passer, receiver, opponents):
    """Engine-mirror grade for one pass at the release frame."""
    dx, dy = receiver[0] - passer[0], receiver[1] - passer[1]
    d = math.hypot(dx, dy)
    if d < 1.0:
        return None
    ls = d * d
    bl = bl_closing = recv_press = 0
    lane_risk = 0.0
    for (ox, oy, ovx, ovy) in opponents:
        if math.hypot(ox - receiver[0], oy - receiver[1]) < PASS_RECEIVER_PRESS_MAX:
            recv_press += 1
        t2 = clamp(((ox - passer[0]) * dx + (oy - passer[1]) * dy) / ls, 0.0, 1.0)
        if t2 * d < 40.0 and math.hypot(ox - passer[0], oy - passer[1]) < 42.0:
            continue  # on-boot presser blocks every lane equally
        cx, cy = passer[0] + t2 * dx, passer[1] + t2 * dy
        perp = math.hypot(ox - cx, oy - cy)
        tlx, tly = cx - ox, cy - oy
        tld = math.hypot(tlx, tly)
        closing = (ovx * tlx + ovy * tly) / tld if tld > 1.0 else 0.0
        eff = PASS_BLOCKER_PERP + clamp(closing / 50.0, 0.0, 1.0) * 13.0
        if perp < eff:
            bl += 1
            if closing > 25.0:
                bl_closing += 1
        elif perp < 112.0 and 0.10 < t2 < 0.92:
            lane_risk += clamp((112.0 - perp) / 76.0, 0.0, 1.0)
    p_complete = clamp(0.92 - d / PASS_DIST_NORM * 0.28 - bl * 0.23 - bl_closing * 0.10
                       - min(lane_risk, 2.2) * 0.10 - recv_press * 0.15, 0.05, 0.97)
    fwd = 1.0 if passer[2] == 0 else -1.0
    fp = (receiver[0] - passer[0]) * fwd
    threat = clamp((fp + 60.0) / 300.0, 0.0, 1.0)
    own_goal_x = 0.0 if passer[2] == 0 else PITCH_W
    turnover_danger = clamp(1.25 - abs(receiver[0] - own_goal_x) / (PITCH_W * 0.8), 0.35, 1.10)
    return p_complete * (0.55 + 0.45 * threat) - (1.0 - p_complete) * 0.35 * turnover_danger, p_complete


def analyze(path, floor):
    tr = TraceReader(path)
    frames = tr.frames
    times = [f.clock_ms for f in frames]
    match_min = frames[-1].clock_ms / 60000.0 if frames else 0.0
    grades, brier_terms = [], []
    sub_floor = 0
    for ev in tr.events:
        if ev.type != "pass":
            continue
        i = bisect.bisect_left(times, ev.clock_ms)
        if i >= len(frames):
            continue
        # release frame: passer position + intended receiver from just-after frame
        rel = frames[min(i + 1, len(frames) - 1)]
        recv_id = rel.ball.intended_receiver_id
        if recv_id is None or recv_id < 0:
            continue
        P = {p.id: p for p in rel.players}
        if ev.player_id not in P or recv_id not in P:
            continue
        pf, rc = P[ev.player_id], P[recv_id]
        team = 0 if ev.player_id < 11 else 1
        opp_ids = range(12, 22) if team == 0 else range(1, 11)  # outfielders only
        opponents = [(P[i2].x, P[i2].y, P[i2].vx, P[i2].vy) for i2 in opp_ids if i2 in P]
        res = grade_pass((pf.x, pf.y, team), (rc.x, rc.y), opponents)
        if res is None:
            continue
        g, p_complete = res
        grades.append(g)
        if g < floor:
            sub_floor += 1
        # outcome: next controlled touch within 4s
        j = i
        completed = None
        while j < len(frames) and frames[j].clock_ms < ev.clock_ms + 4000:
            cid = frames[j].ball.controller_id
            if cid >= 0 and frames[j].clock_ms > ev.clock_ms + 120:
                completed = (cid < 11) == (team == 0)
                break
            j += 1
        if completed is not None:
            brier_terms.append((p_complete - (1.0 if completed else 0.0)) ** 2)
    return grades, sub_floor, match_min, brier_terms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("traces", nargs="+")
    ap.add_argument("--floor", type=float, default=FLOOR_DEFAULT)
    args = ap.parse_args()

    all_grades, total_sub, total_min, all_brier = [], 0, 0.0, []
    for path in args.traces:
        grades, sub_floor, mins, brier = analyze(path, args.floor)
        all_grades += grades
        total_sub += sub_floor
        total_min += mins
        all_brier += brier
        print(f"{path}: {len(grades)} passes, {sub_floor} sub-{args.floor:.2f} "
              f"({sub_floor / max(mins, 1e-9) * 90:.1f}/90)")

    if not all_grades:
        print("no passes found")
        return
    print(f"\nTOTAL: {len(all_grades)} passes over {total_min:.1f} min")
    print(f"sub-{args.floor:.2f}: {total_sub} ({total_sub / max(total_min, 1e-9) * 90:.2f}/90)")
    if all_brier:
        print(f"Brier (pComplete vs outcome): {sum(all_brier) / len(all_brier):.4f} (n={len(all_brier)})")
    print("grade histogram:")
    lo = math.floor(min(all_grades) * 10) / 10
    hi = math.ceil(max(all_grades) * 10) / 10
    b = lo
    while b < hi:
        n = sum(1 for g in all_grades if b <= g < b + 0.1)
        bar = "#" * int(60 * n / max(1, len(all_grades)) * 4)
        print(f"  [{b:+.1f},{b + 0.1:+.1f}) {n:5d} {bar}")
        b += 0.1


if __name__ == "__main__":
    main()

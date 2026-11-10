"""Low-level gameplay forensics over engine traces.

  1. TURNOVERS      — possession-spell flips, % ending <3s after the gain
                      (hot potato), longest rapid-flip chain (flips <10s apart).
  2. ATTACK QUALITY — spells that reached the attacking 30%: % ending with net
                      BACKWARD ball exit and no shot; shots per such spell.
  3. OFF-BALL MOVE  — final-third receptions where the receiver was STATIC
                      (<25 px/s over prior ~0.4s) AND MARKED (<28px); plus,
                      while carrying in the final third, % of his 3 nearest
                      teammates moving <15px over the next 1.0s ("statues").

usage: python tools/gameplay_forensics.py ENGINE SEED [MINUTES]

Reads nothing but the engine's own binary trace; the trace is written to a
temp file and deleted. Pair it with the same seed on two builds to A/B a
behaviour change at the possession-spell level (counts are chaotic per-seed —
use several seeds and read the totals).
"""
import math
import os
import subprocess
import sys
import tempfile

# abspath: Windows CreateProcess rejects a forward-slash relative path such as build/live.exe.
ENGINE, SEED = os.path.abspath(sys.argv[1]), int(sys.argv[2])
MINUTES = int(sys.argv[3]) if len(sys.argv) > 3 else 20
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACE = os.path.join(tempfile.gettempdir(), "_footy_forensics.bin")

# --frame-sample: only the trace is wanted, but without it the engine also serialises
# every JSON frame to stdout (~13.5 KB each, ~1,800 a simulated minute) and
# capture_output holds all of it in memory — about 500 MB for the default 20 minutes.
# An engine older than the flag ignores it and behaves as before.
subprocess.run([ENGINE, str(SEED), str(MINUTES), "--trace", TRACE, "--no-debug",
                "--frame-sample", "1000000"],
               capture_output=True, check=True)

sys.path.insert(0, REPO)
from tools.trace_reader import TraceReader

PITCH_W = 1050.0


def fwd(x, team_home):
    return x if team_home else PITCH_W - x


def team_home(pid):
    return pid < 11


def near(p, q):
    return math.hypot(p.x - q.x, p.y - q.y)


t = TraceReader(TRACE)
shots = sorted(e.clock_ms for e in t.events if e.type == "shot")

stats = {"spells": 0, "hot": 0, "hot_dur_sum": 0, "chain": 0, "max_chain": 0,
         "ft_spells": 0, "ft_backward": 0,
         "receives": 0, "static_marked": 0,
         "support_samples": 0, "support_static": 0,
         "hot_cause": {}, "hot_zone": {},
         "hot_pass_tried": 0, "hot_pass_completed": 0}

CAUSE_EVENTS = ("tackle_won", "intercept", "steal", "tackle_loose")
PASS_EVENTS = ("pass",)
events_sorted = sorted(((e.clock_ms, e.type, e.player_id) for e in t.events), key=lambda p: p[0])
event_times = [e[0] for e in events_sorted]


def zone_of(fwd_x):
    if fwd_x < PITCH_W * 0.33:
        return "def"
    if fwd_x < PITCH_W * 0.70:
        return "mid"
    return "att"

cur = None            # dict(team_home, gain_ms, start_fwd, ft)
last_flip_ms = -1e9
prev_cid = -1
buf = []              # rolling window (~0.5s)
last_support_ms = 0
pending_support = None   # (sample_ms, [(x,y), ...])


def close_spell(end_ms, end_ball_x, cause_opponent):
    global cur, last_flip_ms
    global stats
    if cur is None:
        return
    dur = end_ms - cur["gain_ms"]
    prog = fwd(end_ball_x, cur["team"]) - cur["start_fwd"]
    shot = any(cur["gain_ms"] - 200 <= s <= end_ms + 600 for s in shots)
    if cause_opponent:
        stats["spells"] += 1
        if dur < 3000 and not shot:
            stats["hot"] += 1
            stats["hot_dur_sum"] += dur
            import bisect
            i0 = bisect.bisect_left(event_times, cur["gain_ms"])
            i = bisect.bisect_left(event_times, end_ms - 900)
            causes = [e[1] for e in events_sorted[i:] if e[0] <= end_ms and e[1] in CAUSE_EVENTS]
            c = causes[-1] if causes else "other"
            stats["hot_cause"][c] = stats["hot_cause"].get(c, 0) + 1
            z = zone_of(max(cur["start_fwd"], fwd(end_ball_x, cur["team"])))
            stats["hot_zone"][z] = stats["hot_zone"].get(z, 0) + 1
            # did the hot-spell victim TRY to play before he died?
            tried = any(e[0] >= cur["gain_ms"] and e[0] <= end_ms and e[2] == cur.get("gainer")
                        and e[1] in PASS_EVENTS for e in events_sorted[i0:])
            if tried:
                stats["hot_pass_tried"] += 1
        if end_ms - last_flip_ms <= 10000:
            stats["chain"] += 1
            stats["max_chain"] = max(stats["max_chain"], stats["chain"])
        else:
            stats["chain"] = 1
            stats["max_chain"] = max(stats["max_chain"], 1)
        last_flip_ms = end_ms
    else:
        stats["chain"] = 0
    if cur["ft"] and not shot:
        stats["ft_spells"] += 1
        if prog < -30:
            stats["ft_backward"] += 1
    cur = None


for f in t.frames:
    buf.append(f)
    if len(buf) > 14:
        buf.pop(0)

    # resolve pending support samples
    if pending_support and f.clock_ms >= pending_support[0] + 1000:
        moved = sum(1 for (sx, sy), p in zip(pending_support[1], f.players)
                    if math.hypot(p.x - sx, p.y - sy) >= 15)
        stats["support_samples"] += len(pending_support[1])
        stats["support_static"] += len(pending_support[1]) - moved
        pending_support = None

    cid = f.ball.controller_id
    if cid is None or cid < 0 or cid > 21:
        prev_cid = -1
        continue

    th = team_home(cid)
    me = f.players[cid]

    if cur is None or cur["team"] != th:
        close_spell(f.clock_ms, f.ball.x, cur is not None)
        cur = {"team": th, "gain_ms": f.clock_ms, "start_fwd": fwd(f.ball.x, th),
               "ft": False, "gainer": cid}

    if fwd(me.x, th) > PITCH_W * 0.70:
        cur["ft"] = True
        # support-movement sampling (throttled to ~1.5s)
        if f.clock_ms - last_support_ms > 1500:
            last_support_ms = f.clock_ms
            mates = sorted((p for p in f.players
                            if p.id != cid and team_home(p.id) == th and p.wall == 0),
                           key=lambda p: near(p, me))[:3]
            pending_support = (f.clock_ms, [(p.x, p.y) for p in mates])

    # reception analysis: EDGE into control, where the ball was loose+fast
    # within the last ~0.65s (i.e. this control ended a pass/loose spell)
    if prev_cid < 0:
        loose_fast = False
        for k in range(len(buf) - 2, -1, -1):   # skip the current (controlled) frame
            b = buf[k]
            if b.ball.controller_id >= 0 or b.ball.controller_id is None:
                break
            if math.hypot(b.ball.vx, b.ball.vy) > 120:
                loose_fast = True
            if f.clock_ms - b.clock_ms > 650:
                break
        if loose_fast and fwd(me.x, th) > PITCH_W * 0.70:
            speeds = [math.hypot(buf[k].players[cid].vx, buf[k].players[cid].vy)
                      for k in range(max(0, len(buf) - 13), len(buf) - 1)]
            statik = sum(1 for s in speeds if s < 25) >= len(speeds) - 2
            opps = [p for p in f.players if team_home(p.id) != th and p.wall == 0]
            marked = min(near(o, me) for o in opps) < 28 if opps else False
            stats["receives"] += 1
            if statik and marked:
                stats["static_marked"] += 1
    prev_cid = cid

close_spell(t.frames[-1].clock_ms, t.frames[-1].ball.x, False)

out = dict(stats)
out.pop("chain")
out["hot_avg_ms"] = round(out.pop("hot_dur_sum") / out["hot"]) if out["hot"] else 0
print(f"{SEED}: {out}")

try:
    os.remove(TRACE)
except OSError:
    pass

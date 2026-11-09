#!/usr/bin/env python3
# pass_ball_probe.py — measure two realism issues on a recorded match:
#  (1) BACKWARD PASSES: the angle between the passer's facing and the pass direction
#      (a ~180deg pass = blind, played directly behind where the passer is looking).
#  (2) GLUED CONTROLLED BALL: distance from the ball to its controller while dribbling
#      (CONTROL_DIST=12 -> if it's always ~12px the ball is snapped/glued, not kicked).
#   usage: python tools/pass_ball_probe.py [recording.ndjson.gz]
import gzip, json, math, sys

def wrap(a): return math.atan2(math.sin(a), math.cos(a))

path = sys.argv[1] if len(sys.argv) > 1 else 'web/backend/data/recordings/fixture-2242.ndjson.gz'
op = gzip.open(path, 'rt', encoding='utf-8') if path.endswith('.gz') else open(path, encoding='utf-8')

passes = back150 = back120 = back90 = 0
prev_key = None
ctrl_n = near12 = 0
ctrl_sum = 0.0

for line in op:
    try:
        d = json.loads(line)
    except Exception:
        continue
    pl, ball = d.get('players'), d.get('ball')
    if not pl or not ball:
        continue
    byid = {p['id']: p for p in pl}
    cid = ball.get('controllerId')
    bs = math.hypot(ball.get('vx', 0), ball.get('vy', 0))
    if cid is not None and cid >= 0:
        c = byid.get(cid)
        if c:
            dd = math.hypot(ball['x'] - c['x'], ball['y'] - c['y'])
            ctrl_n += 1; ctrl_sum += dd
            if 8 <= dd <= 16:
                near12 += 1
        prev_key = None
    else:
        irid, ltid = ball.get('intendedReceiverId'), ball.get('lastToucherId')
        if irid is not None and ltid is not None and bs > 40:
            key = (ltid, irid)
            if key != prev_key:
                passer = byid.get(ltid)
                if passer:
                    diff = abs(wrap(math.atan2(ball.get('vy', 0), ball.get('vx', 0)) - passer['facing']))
                    passes += 1
                    if diff > math.radians(150): back150 += 1
                    if diff > math.radians(120): back120 += 1
                    if diff > math.radians(90): back90 += 1
                prev_key = key
        else:
            prev_key = None

print(f'=== BACKWARD PASSES (angle of the pass from the passer facing) — {passes} passes ===')
if passes:
    print(f'  >150deg (blind, played behind):  {100*back150/passes:.1f}%')
    print(f'  >120deg:                          {100*back120/passes:.1f}%')
    print(f'  >90deg (behind the shoulder):     {100*back90/passes:.1f}%')
print(f'=== GLUED CONTROLLED BALL — {ctrl_n} dribble frames ===')
if ctrl_n:
    print(f'  mean ball-to-carrier distance: {ctrl_sum/ctrl_n:.1f}px  (CONTROL_DIST=12 -> glued if pinned near 12)')
    print(f'  pinned 8-16px of the carrier:  {100*near12/ctrl_n:.1f}%')

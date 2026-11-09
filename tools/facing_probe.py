#!/usr/bin/env python3
# facing_probe.py — measure "which way are players looking" on a recorded match.
# For defenders actively chasing (moving, near the ball, not on the attacking team),
# how often is their BACK to the ball? The chase-facing realism metric.
#   usage: python tools/facing_probe.py [web/backend/data/recordings/fixture-53.ndjson.gz]
# Baseline (fixture-53, latest engine 2026-06-29, PRE-fix): back-to-ball 31.6% — target <10%.
import gzip, json, math, sys

def wrap(a): return math.atan2(math.sin(a), math.cos(a))

def main(path):
    engaged = backToBall = sideOn = facingBall = vsMove = vsMoveN = 0
    fi = 0
    op = gzip.open(path, 'rt', encoding='utf-8') if path.endswith('.gz') else open(path, encoding='utf-8')
    for line in op:
        fi += 1
        if fi % 4:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        pl, ball = d.get('players'), d.get('ball')
        if not pl or not ball:
            continue
        cid = ball.get('controllerId')
        if cid is None or cid < 0:
            continue
        atk = next((p for p in pl if p['id'] == cid), None)
        if not atk:
            continue
        bx, by = ball['x'], ball['y']
        for p in pl:
            if p['team'] == atk['team'] or p.get('role') == 'GK':
                continue
            dx, dy = bx - p['x'], by - p['y']
            dist = math.hypot(dx, dy)
            spd = math.hypot(p.get('vx', 0), p.get('vy', 0))
            if dist > 320 or spd < 1.2:   # engaged = near the ball + actually moving
                continue
            engaged += 1
            err = abs(wrap(p['facing'] - math.atan2(dy, dx)))
            if err > 2.094:    # >120deg = back to the ball
                backToBall += 1
            elif err > 1.571:
                sideOn += 1
            elif err < 0.785:
                facingBall += 1
            if spd > 2:
                vsMoveN += 1
                if abs(wrap(p['facing'] - math.atan2(p['vy'], p['vx']))) < 0.6:
                    vsMove += 1
    print(f'engaged chasing-defender samples: {engaged}')
    if engaged:
        print(f'  BACK to ball (>120deg): {100*backToBall/engaged:.1f}%   <-- the metric (baseline 31.6%, target <10%)')
        print(f'  side/away (90-120deg):  {100*sideOn/engaged:.1f}%')
        print(f'  looking at ball (<45):  {100*facingBall/engaged:.1f}%')
    if vsMoveN:
        print(f'  facing ~= movement dir: {100*vsMove/vsMoveN:.1f}% of moving defenders (the root cause)')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'web/backend/data/recordings/fixture-53.ndjson.gz')

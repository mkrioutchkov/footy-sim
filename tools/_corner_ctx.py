import sys
sys.path.insert(0, 'tools')
from trace_reader import TraceReader

path = sys.argv[1]
t0 = float(sys.argv[2])
r = TraceReader(path)
for f in r.frames:
    if t0-250 <= f.clock_ms <= t0+120:
        b=f.ball
        print(f't={f.clock_ms:.0f} ball=({b.x:.1f},{b.y:.1f}) v=({b.vx:.0f},{b.vy:.0f}) z={b.z:.1f} cid={b.controller_id} lastTouch={b.last_toucher_id}')

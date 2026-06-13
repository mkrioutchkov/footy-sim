import sys
sys.path.insert(0, 'tools')
from trace_reader import TraceReader
from collections import Counter

path = sys.argv[1] if len(sys.argv) > 1 else 'out7.bin'
r = TraceReader(path)
ev = r.events
frames = r.frames
print('frames', len(frames), 'events', len(ev))
c = Counter(e.type for e in ev)
print('event types:', dict(sorted(c.items())))

# Build a time-indexed frame lookup for ball position
fr_by_ms = {}
for f in frames:
    fr_by_ms[round(f.clock_ms)] = f

def frame_at(ms):
    # nearest frame at or before ms
    best = None
    for f in frames:
        if f.clock_ms <= ms + 1:
            best = f
        else:
            break
    return best

PITCH_W = 1050.0
PITCH_H = 680.0

# Examine each corner: find where the ball ends up right after the award.
# A corner sets ball to (6 or 1044, 6 or 674). We detect frames where ball is
# near a corner arc and controllerId<0 and setpiece. We don't have setpiece in
# trace, so detect ball teleport to corner coords.
print('\n=== Ball-at-corner-arc frames (near 4 arcs, |v|<1) ===')
corners_seen = []
prev_at_corner = False
for f in frames:
    b = f.ball
    near = None
    for (cx, cy, label) in [(6,6,'HL-top'),(6,674,'HL-bot'),(1044,6,'AL-top'),(1044,674,'AL-bot')]:
        if abs(b.x-cx) < 3 and abs(b.y-cy) < 3:
            near = label
    at = near is not None
    if at and not prev_at_corner:
        corners_seen.append((f.clock_ms, near, b.x, b.y))
    prev_at_corner = at
print('corner-arc placements:', len(corners_seen))
for (ms, lab, bx, by) in corners_seen[:30]:
    print(f'  t={ms:.0f}ms {lab} ball=({bx:.1f},{by:.1f})')

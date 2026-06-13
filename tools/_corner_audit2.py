import sys
sys.path.insert(0, 'tools')
from trace_reader import TraceReader
from collections import Counter

path = sys.argv[1]
r = TraceReader(path)
frames = r.frames
ev = r.events
print('frames', len(frames), 'events', len(ev))
print('event types:', dict(sorted(Counter(e.type for e in ev).items())))

PITCH_W, PITCH_H = 1050.0, 680.0
ARCS = [(6,6,'home-top'),(6,674,'home-bot'),(1044,6,'away-top'),(1044,674,'away-bot')]

# Detect corner placements: ball jumps to an arc with v~0 and controller<0
prev_corner = False
placements = []
for i,f in enumerate(frames):
    b=f.ball
    lab=None
    for (cx,cy,l) in ARCS:
        if abs(b.x-cx)<2.5 and abs(b.y-cy)<2.5:
            lab=l
    at = lab is not None and abs(b.vx)<1 and abs(b.vy)<1
    if at and not prev_corner:
        placements.append((i,f.clock_ms,lab,b.x,b.y,b.controller_id))
    prev_corner=at

print('\ncorner placements:',len(placements))
for (i,ms,lab,bx,by,cid) in placements:
    f=frames[i]
    # nearest player of each team to the arc
    home=[(abs(p.x-bx)+abs(p.y-by),p.id) for p in f.players if p.id<11]
    away=[(abs(p.x-bx)+abs(p.y-by),p.id) for p in f.players if p.id>=11]
    home.sort(); away.sort()
    # which side end? home arc => x~6 => HOME_GOAL_X => attacking team should be AWAY
    end = 'HOME_END(x=0)' if bx<500 else 'AWAY_END(x=1050)'
    # who is the taker (closest of the attacking team should approach)
    print(f'  t={ms:.0f} {lab} {end} ball=({bx:.1f},{by:.1f}) cid={cid}')
    print(f'    nearest HOME id={home[0][1]} d~{home[0][0]:.0f} | nearest AWAY id={away[0][1]} d~{away[0][0]:.0f}')
    # events near this time
    near = [e for e in ev if abs(e.clock_ms-ms)<2500]
    print('    nearby events:', [(round(e.clock_ms),e.type,e.player_id) for e in near])

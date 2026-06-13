import sys
sys.path.insert(0, r'C:\Users\maxkr\Documents\dev\Game\footy-sim\tools')
from trace_reader import TraceReader
tr = TraceReader(r'C:\Users\maxkr\Documents\dev\Game\footy-sim\s11.bin')
frames = tr.frames
print("num_frames", len(frames))
print("last clock_ms", frames[-1].clock_ms)
# events near the end
evs = [e for e in tr.events]
print("num_events", len(evs))
for e in evs[-25:]:
    print(f"  EV {e.type} @ {e.clock_ms:.0f}ms ({e.x:.0f},{e.y:.0f}) pid={e.player_id} tid={e.target_id}")
# last 5 frames ball + setpiece-ish
for f in frames[-5:]:
    b = f.ball
    print(f"  F {f.clock_ms:.0f}ms ball=({b.x:.1f},{b.y:.1f}) v=({b.vx:.1f},{b.vy:.1f}) z={b.z:.1f} ctrl={b.controller_id} recv={b.intended_receiver_id} lastT={b.last_toucher_id}")
# find when ball first parked at x~70,y~418
parked = None
for f in frames:
    b = f.ball
    if abs(b.x-70.0)<2 and abs(b.y-418.0)<3 and b.controller_id<0:
        parked = f.clock_ms; break
print("first parked near (70,418) at ms", parked)

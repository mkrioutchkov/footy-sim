#!/usr/bin/env python3
"""Diagnose trace issues around specific timestamps."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from trace_reader import TraceReader

trace = TraceReader(os.path.join(os.path.dirname(__file__), "..", "build", "seed101.trace"))
print(f"Seed: {trace.header.seed}, Frames: {len(trace.frames)}")

def nearest_players(frame, n=5):
    """Return players sorted by distance to ball."""
    bx, by = frame.ball.x, frame.ball.y
    dists = []
    for p in frame.players:
        d = ((p.x - bx)**2 + (p.y - by)**2)**0.5
        dists.append((d, p))
    dists.sort(key=lambda x: x[0])
    return dists[:n]

def player_speed(p):
    return (p.vx**2 + p.vy**2)**0.5

# ══════════════════════════════════════════════════════════════
# Issue 1: Throw-in around 1:05 (60000-70000ms)
# ══════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("THROW-IN ANALYSIS: 58000-72000ms")
print("="*70)

for frame in trace.frames_ms(58000, 72000):
    bx, by = frame.ball.x, frame.ball.y
    ctrl = frame.ball.controller_id
    # Look for set-piece-like conditions: ball near sideline, no controller or stationary
    near_sideline = by < 15 or by > 665
    ball_stopped = abs(frame.ball.vx) < 2 and abs(frame.ball.vy) < 2
    
    if near_sideline and (ctrl < 0 or ball_stopped):
        nearest = nearest_players(frame, 5)
        print(f"\n  {frame.clock_ms:.0f}ms  ball=({bx:.0f},{by:.0f}) ctrl={ctrl} vel=({frame.ball.vx:.0f},{frame.ball.vy:.0f})")
        for d, p in nearest:
            # IDs 0-10 = home, 11-21 = away
            team = "HOME" if p.id <= 10 else "AWAY"
            spd = player_speed(p)
            print(f"    {team} #{p.id:2d}  pos=({p.x:.0f},{p.y:.0f})  tgt=({p.target_x:.0f},{p.target_y:.0f})  spd={spd:.1f}  dist={d:.0f}")

# Also show a window around the actual throw-in to see positioning spread
print("\n  --- Detailed throw-in positioning (every 500ms) ---")
for frame in trace.frames_ms(63000, 68000):
    bx, by = frame.ball.x, frame.ball.y
    ctrl = frame.ball.controller_id
    near_sideline = by < 15 or by > 665
    if not near_sideline:
        continue
    # Show home team target positions relative to ball
    home_players = [(p.id, p.x, p.y, p.target_x, p.target_y, player_speed(p)) for p in frame.players if p.id <= 10]
    # Only print one frame per ~500ms window
    if int(frame.clock_ms) % 500 < 20:
        print(f"\n  {frame.clock_ms:.0f}ms  ball=({bx:.0f},{by:.0f}) ctrl={ctrl}")
        for pid, px, py, tx, ty, spd in home_players:
            dx_from_ball = px - bx
            dy_from_ball = py - by
            print(f"    Home #{pid:2d}  pos=({px:.0f},{py:.0f})  tgt=({tx:.0f},{ty:.0f})  dBall=({dx_from_ball:+.0f},{dy_from_ball:+.0f})  spd={spd:.1f}")

# ══════════════════════════════════════════════════════════════
# Issue 2: Away player gives up chase ~3:4X (220000-240000ms)
# ══════════════════════════════════════════════════════════════
print("\n" + "="*70)
print("CHASE ISSUE ANALYSIS: 220000-240000ms")
print("="*70)

# Look for loose ball with away players stopping chase
prev_frame = None
for frame in trace.frames_ms(220000, 240000):
    bx, by = frame.ball.x, frame.ball.y
    ctrl = frame.ball.controller_id
    ball_speed = player_speed(frame.ball) if hasattr(frame.ball, 'vx') else ((frame.ball.vx**2 + frame.ball.vy**2)**0.5)
    
    # Look for frames where ball is loose and moving
    if ctrl < 0 and ball_speed > 5:
        # Find away players and their speeds
        away_players = [(p.id, p.x, p.y, player_speed(p), 
                        ((p.x - bx)**2 + (p.y - by)**2)**0.5) 
                       for p in frame.players if p.id >= 11]
        # Sort by distance to ball
        away_players.sort(key=lambda x: x[4])
        
        # Check if the closest away player is slow despite being close to a moving ball
        closest = away_players[0]
        cid, cx, cy, cspd, cdist = closest
        
        if cdist < 200 and cspd < 15:
            # This could be the issue - away player near loose ball but slow
            if int(frame.clock_ms) % 33 < 20:
                print(f"\n  {frame.clock_ms:.0f}ms  ball=({bx:.0f},{by:.0f}) ballSpd={ball_speed:.0f}")
                print(f"    CLOSEST AWAY: #{cid} pos=({cx:.0f},{cy:.0f}) spd={cspd:.1f} dist={cdist:.0f}")
                # Show the 3 nearest away players
                for pid, px, py, spd, d in away_players[:5]:
                    tgt = None
                    for p in frame.players:
                        if p.id == pid:
                            tgt = (p.target_x, p.target_y)
                            break
                    print(f"    Away #{pid:2d}  pos=({px:.0f},{py:.0f})  tgt=({tgt[0]:.0f},{tgt[1]:.0f})  spd={spd:.1f}  dist={d:.0f}")

# Also look for any frames where an away player near ball had a sudden speed drop
print("\n  --- Away player speed transitions near ball (220000-240000ms) ---")
prev_speeds = {}
for frame in trace.frames_ms(220000, 240000):
    bx, by = frame.ball.x, frame.ball.y
    ctrl = frame.ball.controller_id
    ball_speed = ((frame.ball.vx**2 + frame.ball.vy**2)**0.5)
    
    for p in frame.players:
        if p.id < 11:
            continue
        d = ((p.x - bx)**2 + (p.y - by)**2)**0.5
        spd = player_speed(p)
        
        if p.id in prev_speeds:
            prev_spd, prev_d = prev_speeds[p.id]
            # Speed dropped significantly while near ball
            if prev_spd > 20 and spd < 8 and d < 150 and ball_speed > 10 and ctrl < 0:
                print(f"\n  *** {frame.clock_ms:.0f}ms: Away #{p.id} speed drop {prev_spd:.0f} -> {spd:.0f} at dist={d:.0f} from ball ({bx:.0f},{by:.0f}) ballSpd={ball_speed:.0f}")
        
        prev_speeds[p.id] = (spd, d)

print("\nDone.")

"""Trace seed 114 first 60s: find throw-ins, track home10 position."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s114_trace.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

pv_ctl = -2
while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms > 60:
        break

    poff = o+8+BALL_STATE_SIZE
    h10 = None
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        if pid == 10: h10 = {'x':px,'y':py,'tx':tx,'ty':ty,'vx':pvx,'vy':pvy,'spd':hypot(pvx,pvy),'f':fac}
        poff += PLAYER_STATE_SIZE

    # Detect throw-in: ball suddenly stops at sideline
    bs = hypot(bvx, bvy)
    if bs < 1 and abs(by) < 15 and pv_ctl >= 0:
        print(f"\n[THROW-IN at {ms:.3f}s] ball=({bx:.0f},{by:.0f}) last_touch={lt}")

    # Show home10 position every frame near throw-in times
    if h10 and ms > 0:
        d_to_ball = hypot(h10['x']-bx, h10['y']-by)
        if d_to_ball < 300 or (ctl == 10):
            print(f"[{ms:7.3f}] f={fc:5d} h10=({h10['x']:6.1f},{h10['y']:6.1f}) tgt=({h10['tx']:6.1f},{h10['ty']:6.1f}) spd={h10['spd']:5.1f} ball=({bx:6.1f},{by:6.1f}) bs={bs:5.0f} ctl={ctl} d={d_to_ball:.0f}")

    pv_ctl = ctl
    fc += 1
    o += FRAME_SIZE

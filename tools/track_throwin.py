"""Track home10 during throw-in at 12-18s in seed 114."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s114_v2.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 12.0 or ms > 18.0:
        fc += 1; o += FRAME_SIZE; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        players[pid] = {'x':px,'y':py,'tx':tx,'ty':ty,'spd':hypot(pvx,pvy),'vx':pvx,'vy':pvy}
        poff += PLAYER_STATE_SIZE

    h10 = players.get(10)
    ctl_name = f'p{ctl}' if ctl >= 0 else 'none'

    if h10:
        d = hypot(h10['x']-bx, h10['y']-by)
        # Only print every 10th frame or when something interesting happens
        if fc % 10 == 0 or ctl == 10 or d < 30 or (bs < 2 and by > 660):
            print(f"[{ms:7.3f}] f={fc:5d} ball=({bx:6.1f},{by:6.1f}) bs={bs:5.0f} ctl={ctl_name:4s} "
                  f"h10=({h10['x']:6.1f},{h10['y']:6.1f}) tgt=({h10['tx']:6.1f},{h10['ty']:6.1f}) spd={h10['spd']:5.1f} d={d:.0f}")

    fc += 1; o += FRAME_SIZE

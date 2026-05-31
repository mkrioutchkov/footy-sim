"""Track CF(9) and ball positions 24-27s in seed 101."""
import struct
from math import hypot, atan2, degrees

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_shot.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 24.0 or ms > 27.0:
        fc += 1; o += FRAME_SIZE; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    cf = None
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        if pid == 9: cf = {'x':px,'y':py,'vx':pvx,'vy':pvy,'f':fac,'dt':dt}
        poff += PLAYER_STATE_SIZE

    if cf:
        d = hypot(cf['x']-bx, cf['y']-by)
        team_ctl = 'CF' if ctl==9 else 'none' if ctl<0 else f'p{ctl}'
        print(f"[{ms:7.3f}] f={fc:5d}  ball=({bx:6.1f},{by:6.1f})  bs={bs:5.0f}  ctl={team_ctl:4s}  "
              f"CF=({cf['x']:6.1f},{cf['y']:6.1f})  CF_facing={degrees(cf['f']):6.1f}  "
              f"dist={d:5.1f}  dt={cf['dt']}")

    fc += 1; o += FRAME_SIZE

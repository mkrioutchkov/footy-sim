"""Track away14 and home9 positions 60-75s in seed 101."""
import struct
from math import hypot, atan2, degrees

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_case.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 60.0 or ms > 75.0:
        fc += 1; o += FRAME_SIZE; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        players[pid] = {'x':px,'y':py,'vx':pvx,'vy':pvy,'speed':hypot(pvx,pvy),'f':fac,'stam':stam,'dt':dt,'tx':tx,'ty':ty}
        poff += PLAYER_STATE_SIZE

    p14 = players.get(14)
    p9 = players.get(9)

    if p14 and p9:
        d = hypot(p14['x']-p9['x'], p14['y']-p9['y'])
        # Is away14 moving toward home9?
        to9_x = p9['x'] - p14['x']
        to9_y = p9['y'] - p14['y']
        to9_dist = hypot(to9_x, to9_y)
        if to9_dist > 0.1:
            dot = (p14['vx']*to9_x + p14['vy']*to9_y) / (p14['speed'] * to9_dist + 0.001)
        else:
            dot = 0
        toward = "TOWARD" if dot > 0.3 else "AWAY" if dot < -0.3 else "PERP"

        ctl_name = f'p{ctl}' if ctl >= 0 else 'none'
        print(f"[{ms:7.3f}] f={fc:5d}  ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl_name}  "
              f"a14=({p14['x']:.0f},{p14['y']:.0f}) spd={p14['speed']:.0f} tgt=({p14['tx']:.0f},{p14['ty']:.0f}) stam={p14['stam']:.0f}  "
              f"h9=({p9['x']:.0f},{p9['y']:.0f}) spd={p9['speed']:.0f} tgt=({p9['tx']:.0f},{p9['ty']:.0f}) stam={p9['stam']:.0f}  "
              f"d={d:.0f} {toward} dot={dot:.2f}")

    fc += 1; o += FRAME_SIZE

"""Track home9, away13, away14 positions 5-10s in seed 101."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_v3.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 5.0 or ms > 10.0:
        fc += 1; o += FRAME_SIZE; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        players[pid] = {'x':px,'y':py,'vx':pvx,'vy':pvy,'speed':hypot(pvx,pvy),'f':fac,'stam':stam,'dt':dt,'tx':tx,'ty':ty}
        poff += PLAYER_STATE_SIZE

    p9 = players.get(9)
    p13 = players.get(13)
    p14 = players.get(14)
    if not (p9 and p13 and p14):
        fc += 1; o += FRAME_SIZE; continue

    d13 = hypot(p13['x']-p9['x'], p13['y']-p9['y'])
    d14 = hypot(p14['x']-p9['x'], p14['y']-p9['y'])
    to9_13x = p9['x'] - p13['x']; to9_13y = p9['y'] - p13['y']
    to9_14x = p9['x'] - p14['x']; to9_14y = p9['y'] - p14['y']
    dot13 = (p13['vx']*to9_13x + p13['vy']*to9_13y) / (p13['speed'] * d13 + 0.001) if d13 > 0.1 else 0
    dot14 = (p14['vx']*to9_14x + p14['vy']*to9_14y) / (p14['speed'] * d14 + 0.001) if d14 > 0.1 else 0
    t13 = "TWD" if dot13 > 0.3 else "AWAY" if dot13 < -0.3 else "PERP"
    t14 = "TWD" if dot14 > 0.3 else "AWAY" if dot14 < -0.3 else "PERP"

    ctl_name = f'p{ctl}' if ctl >= 0 else 'none'
    print(f"[{ms:6.3f}] f={fc:5d} ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl_name}  "
          f"h9=({p9['x']:.0f},{p9['y']:.0f}) spd={p9['speed']:.0f}  "
          f"a13=({p13['x']:.0f},{p13['y']:.0f}) spd={p13['speed']:.0f} tgt=({p13['tx']:.0f},{p13['ty']:.0f}) d={d13:.0f} {t13}  "
          f"a14=({p14['x']:.0f},{p14['y']:.0f}) spd={p14['speed']:.0f} tgt=({p14['tx']:.0f},{p14['ty']:.0f}) d={d14:.0f} {t14}")

    fc += 1; o += FRAME_SIZE

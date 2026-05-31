"""Analyze away20, home4, home2 positions 34-37s in seed 101."""
import struct
from math import hypot, degrees

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_new.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 34.0 or ms > 37.5:
        fc += 1; o += FRAME_SIZE; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        players[pid] = {'x':px,'y':py,'vx':pvx,'vy':pvy,'speed':hypot(pvx,pvy),'f':fac,'stam':stam,'dt':dt,'tx':tx,'ty':ty}
        poff += PLAYER_STATE_SIZE

    ctl_name = f'p{ctl}' if ctl >= 0 else 'none'
    p20 = players.get(20)
    p4 = players.get(4)
    p2 = players.get(2)

    if p20 and p4 and p2:
        d20_4 = hypot(p20['x']-p4['x'], p20['y']-p4['y'])
        d20_2 = hypot(p20['x']-p2['x'], p20['y']-p2['y'])
        print(f"[{ms:7.3f}] f={fc:5d}  ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl_name}  "
              f"a20=({p20['x']:.0f},{p20['y']:.0f}) spd={p20['speed']:.0f} stam={p20['stam']:.0f} tgt=({p20['tx']:.0f},{p20['ty']:.0f})  "
              f"h4=({p4['x']:.0f},{p4['y']:.0f}) spd={p4['speed']:.0f} stam={p4['stam']:.0f}  "
              f"h2=({p2['x']:.0f},{p2['y']:.0f}) spd={p2['speed']:.0f} stam={p2['stam']:.0f}  "
              f"d20-4={d20_4:.0f} d20-2={d20_2:.0f}")

    fc += 1; o += FRAME_SIZE

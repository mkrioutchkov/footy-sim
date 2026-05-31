"""Track away20 and nearby defenders 20-28s in seed 101."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_v6.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms < 20.0 or ms > 28.0:
        fc += 1; o += FRAME_SIZE; continue
    if ms > 28.5:
        break

    bs = hypot(bvx, bvy)
    poff = o+8+BALL_STATE_SIZE
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        players[pid] = {'x':px,'y':py,'vx':pvx,'vy':pvy,'speed':hypot(pvx,pvy),'f':fac,'stam':stam,'dt':dt,'tx':tx,'ty':ty}
        poff += PLAYER_STATE_SIZE

    p20 = players.get(20)
    if not p20:
        fc += 1; o += FRAME_SIZE; continue

    # Find nearest 3 defenders to away20
    defenders = []
    for pid, p in players.items():
        if pid >= 11 and pid <= 21 and pid != 20:  # away team
            continue
        if pid < 11:  # home team = defenders
            d = hypot(p['x']-p20['x'], p['y']-p20['y'])
            defenders.append((d, pid, p))
    defenders.sort()

    ctl_name = f'p{ctl}' if ctl >= 0 else 'none'
    d0, id0, p0 = defenders[0]
    d1, id1, p1 = defenders[1]
    d2, id2, p2 = defenders[2]

    def rname(pid):
        r=['GK','FB','CB','CB','FB','CM','CM','CM','WM','CF','WM']
        return r[pid%11]

    print(f"[{ms:7.3f}] f={fc:5d} ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl_name}  "
          f"a20=({p20['x']:.0f},{p20['y']:.0f}) spd={p20['speed']:.0f} tgt=({p20['tx']:.0f},{p20['ty']:.0f})  "
          f"nearest: {rname(id0)}({id0}) d={d0:.0f} spd={p0['speed']:.0f} tgt=({p0['tx']:.0f},{p0['ty']:.0f})  "
          f"{rname(id1)}({id1}) d={d1:.0f} spd={p1['speed']:.0f}  "
          f"{rname(id2)}({id2}) d={d2:.0f} spd={p2['speed']:.0f}")

    fc += 1; o += FRAME_SIZE

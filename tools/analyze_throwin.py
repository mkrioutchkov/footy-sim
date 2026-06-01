"""Analyze throw-in sequence at 12-20s in seed 114: what happens after taker gets ball."""
import struct
from math import hypot

BSZ = 6*8+3*4; PSZ = 4+8*8+4+2*8; FSZ = 8+BSZ+22*PSZ+4+4+8+8
HSZ = 52; FTSZ = 8

with open('build/s114_now.bin','rb') as f: d = f.read()
o = HSZ; fc = 0; end = len(d) - FTSZ

pv_ctl = -2
while o + FSZ <= end:
    clk = struct.unpack_from('<d', d, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', d, o+8)
    ms = clk/1000
    if ms < 12.0 or ms > 22.0:
        pv_ctl = ctl; fc += 1; o += FSZ; continue

    bs = hypot(bvx, bvy)
    poff = o+8+BSZ
    players = {}
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', d, poff)
        players[pid] = {'x':px,'y':py,'vx':pvx,'vy':pvy,'spd':hypot(pvx,pvy),'f':fac,'dt':dt}
        poff += PSZ

    h10 = players.get(10)
    ctl_name = f'p{ctl}' if ctl >= 0 else 'none'

    # Show when control changes or ball speed changes significantly
    if ctl != pv_ctl or (bs < 5 and by > 660) or (ctl >= 0 and h10):
        h10_d = hypot(h10['x']-bx, h10['y']-by) if h10 else 0
        print(f"[{ms:7.3f}] f={fc:5d} ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl_name:4s} lt={lt:2d} "
              f"h10=({h10['x']:.0f},{h10['y']:.0f}) spd={h10['spd']:.0f} dt={h10['dt']} d={h10_d:.0f}")

    pv_ctl = ctl
    fc += 1; o += FSZ

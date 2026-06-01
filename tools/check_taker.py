"""Check taker movement toward ball during throw-in in s114."""
import struct
from math import hypot

BSZ = 6*8+3*4; PSZ = 4+8*8+4+2*8; FSZ = 8+BSZ+22*PSZ+4+4+8+8
HSZ = 52; FTSZ = 8

with open('build/s114_hold.bin','rb') as f: d = f.read()
o = HSZ; fc = 0; end = len(d) - FTSZ

while o + FSZ <= end:
    clk = struct.unpack_from('<d', d, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', d, o+8)
    ms = clk / 1000
    if 12.0 < ms < 16.0:
        poff = o + 8 + BSZ
        h10 = None
        for _ in range(22):
            pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', d, poff)
            if pid == 10: h10 = (px, py, tx, ty, hypot(pvx, pvy))
            poff += PSZ
        bs = hypot(bvx, bvy)
        if h10:
            dist = hypot(h10[0]-bx, h10[1]-by)
            if fc % 5 == 0 or dist < 30 or (bs < 5 and by > 660):
                print(f"[{ms:7.3f}] ball=({bx:.0f},{by:.0f}) bs={bs:.0f} ctl={ctl:3d} "
                      f"h10=({h10[0]:.1f},{h10[1]:.1f}) tgt=({h10[2]:.1f},{h10[3]:.1f}) spd={h10[4]:.1f} d={dist:.0f}")
    fc += 1; o += FSZ

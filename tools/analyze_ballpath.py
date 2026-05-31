"""Ball movement detail 24.5 to 25.0s in seed 101."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_fix.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

def rname(pid):
    r=['GK','FB','CB','CB','FB','CM','CM','CM','WM','CF','WM']
    return r[pid%11] if 0<=pid<22 else '??'

while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    ms = clk/1000
    if ms >= 24.5 and ms <= 25.3:
        bs = hypot(bvx, bvy)
        ctl_name = rname(ctl) if ctl>=0 else 'none'
        # GK distance to ball
        poff = o+8+BALL_STATE_SIZE
        gk = None
        for _ in range(22):
            pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
            if pid == 11: gk = (px, py)
            poff += PLAYER_STATE_SIZE
        gk_dist = hypot(gk[0]-bx, gk[1]-by) if gk else 0
        print(f"[{ms:7.3f}] f={fc:5d}  ball=({bx:6.1f},{by:6.1f})  vel=({bvx:6.1f},{bvy:6.1f})  bs={bs:5.0f}  bz={bz:4.1f}  ctl={ctl_name:4s}({ctl:2d})  lt={rname(lt)}({lt})  gk_dist={gk_dist:.1f}")
    fc+=1; o+=FRAME_SIZE

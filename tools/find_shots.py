"""Find all shots in seed 101 trace."""
import struct
from math import hypot, atan2, degrees

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_shot.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

def rname(pid):
    r=['GK','FB','CB','CB','FB','CM','CM','CM','WM','CF','WM']
    return r[pid%11] if 0<=pid<22 else '??'

pv_ctl = -2
for _ in range(100000):
    if o + FRAME_SIZE > end: break
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    bs = hypot(bvx, bvy)
    ms = clk/1000

    # Shot: controller goes to none, high speed, no intended receiver
    if pv_ctl >= 0 and ctl < 0 and bs > 300 and itd < 0:
        # Get shooter info
        poff = o+8+BALL_STATE_SIZE
        shooter = None
        for _ in range(22):
            pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
            if pid == pv_ctl: shooter = (px, py, fac, dt)
            poff += PLAYER_STATE_SIZE
        if shooter:
            px, py, fac, dt = shooter
            fd = degrees(fac)
            bd = degrees(atan2(bvy, bvx))
            team = 'home' if pv_ctl<11 else 'away'
            m, s = divmod(ms, 60)
            print(f"[{int(m):02d}:{s:06.3f}] f={fc:5d} SHOT  {rname(pv_ctl)}({pv_ctl}) [{team}]  "
                  f"pos=({px:.0f},{py:.0f})  facing={fd:.1f}  ball_dir={bd:.1f}  "
                  f"speed={bs:.0f}  dribbleType={dt}")

    pv_ctl = ctl
    fc += 1
    o += FRAME_SIZE

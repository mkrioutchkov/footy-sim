"""Detailed frame dump 24-27s seed 101."""
import struct
from math import hypot, atan2, degrees

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s101_d.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

def rname(pid):
    r=['GK','FB','CB','CB','FB','CM','CM','CM','WM','CF','WM']
    return r[pid%11] if 0<=pid<22 else '??'

frames = []
while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    pl = []
    poff = o+8+BALL_STATE_SIZE
    for _ in range(22):
        pid, px, py, pvx, pvy, tx, ty, stam, fac, dt, ta, ha = struct.unpack_from('<i 4d 4d i 2d', data, poff)
        pl.append({'id':pid,'x':px,'y':py,'vx':pvx,'vy':pvy,'f':fac,'dt':dt,'ta':ta,'ha':ha})
        poff += PLAYER_STATE_SIZE
    frames.append({'c':clk,'bx':bx,'by':by,'bvx':bvx,'bvy':bvy,'bz':bz,'ctl':ctl,'itd':itd,'lt':lt,'pl':pl})
    fc+=1; o+=FRAME_SIZE

pv_ctl = -2
for fi, f in enumerate(frames):
    ms = f['c']/1000
    if ms < 24.0 or ms > 27.5:
        pv_ctl = f['ctl']
        continue

    bs = hypot(f['bvx'],f['bvy'])
    ctl = f['ctl']; itd = f['itd']; lt = f['lt']

    # Show ALL frames with ball state
    ctl_name = rname(ctl) if ctl>=0 else 'none'
    lt_name = rname(lt) if lt>=0 else 'none'

    # Track home8 and home9 specifically
    h8 = next((x for x in f['pl'] if x['id']==8), None)
    h9 = next((x for x in f['pl'] if x['id']==9), None)

    # Control changes
    if ctl != pv_ctl:
        print(f"\n[{ms:7.3f}] f={fi:5d} CONTROL: {rname(pv_ctl)}({pv_ctl})->{ctl_name}({ctl})  "
              f"ball=({f['bx']:.1f},{f['by']:.1f})  bs={bs:.0f}  bz={f['bz']:.1f}  lt={lt_name}({lt})")
        if itd >= 0:
            print(f"  intended={rname(itd)}({itd})")

    # Tackle animation detection
    for p in f['pl']:
        if p['ta'] > 0:
            print(f"  TACKLE_ANIM: {rname(p['id'])}({p['id']}) ta={p['ta']:.1f}")

    # home8 shot detection
    if pv_ctl == 8 and ctl < 0 and bs > 200 and itd < 0:
        print(f"  >>> HOME8 SHOT! facing={degrees(h8['f']):.1f}  ball_dir={degrees(atan2(f['bvy'],f['bvx'])):.1f}  speed={bs:.0f}")

    # home8 activity
    if h8 and (h8['dt'] > 0 or h8['ta'] > 0):
        print(f"  home8: dribbleType={h8['dt']}  tackleAnim={h8['ta']:.1f}  pos=({h8['x']:.0f},{h8['y']:.0f})")

    # home9 activity
    if h9 and (h9['dt'] > 0 or h9['ta'] > 0):
        print(f"  home9: dribbleType={h9['dt']}  tackleAnim={h9['ta']:.1f}  pos=({h9['x']:.0f},{h9['y']:.0f})")

    pv_ctl = ctl

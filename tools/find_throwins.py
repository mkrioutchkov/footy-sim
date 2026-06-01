"""Find any ball position near sideline in seed 114 5-min trace."""
import struct
from math import hypot

BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32; FOOTER_SIZE = 4+4

with open('build/s114_5min.bin','rb') as f: data = f.read()
o = HEADER_SIZE; fc = 0; end = len(data) - FOOTER_SIZE

frames = []
while o + FRAME_SIZE <= end:
    clk = struct.unpack_from('<d', data, o)[0]
    bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o+8)
    frames.append({'ms':clk/1000,'bx':bx,'by':by,'bs':hypot(bvx,bvy),'ctl':ctl})
    fc += 1; o += FRAME_SIZE

pv_by = 340
for i, f in enumerate(frames):
    # Look for ball near sideline (y < 20 or y > 660)
    if f['by'] < 20 or f['by'] > 660:
        print(f"[{f['ms']:7.3f}] f={i:5d} ball=({f['bx']:6.1f},{f['by']:6.1f}) bs={f['bs']:5.0f} ctl={f['ctl']}")
    pv_by = f['by']

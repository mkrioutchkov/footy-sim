"""Find offside events: detect ball teleports where velocity drops to near-zero and ball jumps."""
import struct
import sys
from math import hypot

TRACE_MAGIC = 0x46545346
BALL_STATE_SIZE = 6*8 + 3*4
PLAYER_STATE_SIZE = 4 + 8*8 + 4 + 2*8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22*PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4+4+4+8+32
FOOTER_SIZE = 4+4

def main():
    if len(sys.argv) < 2:
        print("Usage: python find_offsides.py <trace.bin>")
        sys.exit(1)

    with open(sys.argv[1], 'rb') as f:
        data = f.read()

    magic, ver, seed, dur = struct.unpack_from('<IIi d', data, 0)
    if magic != TRACE_MAGIC:
        print(f"Bad magic: {hex(magic)}")
        return

    o = HEADER_SIZE
    fc = 0
    px, py = 0.0, 0.0
    pbs = 0.0
    prev_ctl = -1
    end = len(data) - FOOTER_SIZE

    while o + FRAME_SIZE <= end:
        bx, by, bvx, bvy, bz, bvz, ctl, itd, lt = struct.unpack_from('<6d 3i', data, o + 8)
        clk = struct.unpack_from('<d', data, o)[0]
        bs = hypot(bvx, bvy)

        if fc > 0:
            dist = hypot(bx - px, by - py)
            # ball teleport: big jump, velocity near zero, no controller, no intended receiver
            if dist > 100 and bs < 3 and ctl == -1 and itd == -1:
                tm = clk / 1000; m, s = divmod(tm, 60)
                print(f"[{int(m):02d}:{s:06.3f}] f={fc:5d}  TELEPORT  jump={dist:5.0f}px  pos=({bx:6.0f},{by:6.0f})  prev=({px:6.0f},{py:6.0f})  ctl={ctl} itd={itd}")

        px, py = bx, by
        pbs = bs
        prev_ctl = ctl
        fc += 1
        o += FRAME_SIZE

if __name__ == '__main__':
    main()

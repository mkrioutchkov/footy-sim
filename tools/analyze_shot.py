"""Dump possession changes and ball launches from a native trace."""

import argparse
import struct
from math import atan2, cos, degrees, hypot, sin

BALL_STATE_SIZE = 6 * 8 + 3 * 4
PLAYER_STATE_SIZE = 4 + 8 * 8 + 4 + 2 * 8
FRAME_SIZE = 8 + BALL_STATE_SIZE + 22 * PLAYER_STATE_SIZE + 4 + 4 + 8 + 8
HEADER_SIZE = 4 + 4 + 4 + 8 + 32
FOOTER_SIZE = 4 + 4
TRACE_MAGIC = 0x46545346


def rname(pid: int) -> str:
    if pid < 0:
        return "  "
    roles = ["GK", "FB", "CB", "CB", "FB", "CM", "CM", "CM", "WM", "CF", "WM"]
    return roles[pid % 11]


def parse_trace(path: str) -> list[dict]:
    with open(path, "rb") as f:
        data = f.read()

    magic = struct.unpack_from("<I", data, 0)[0]
    if magic != TRACE_MAGIC:
        raise SystemExit(f"Bad trace magic: {hex(magic)}")

    frames = []
    offset = HEADER_SIZE
    end = len(data) - FOOTER_SIZE
    while offset + FRAME_SIZE <= end:
        clock_ms = struct.unpack_from("<d", data, offset)[0]
        bx, by, bvx, bvy, _bz, _bvz, ctl, intended, _last_touch = struct.unpack_from("<6d 3i", data, offset + 8)
        players = []
        player_offset = offset + 8 + BALL_STATE_SIZE
        for _ in range(22):
            pid, px, py, _pvx, _pvy, _tx, _ty, _stam, facing, _dt, _ta, _ha = struct.unpack_from(
                "<i 4d 4d i 2d", data, player_offset
            )
            players.append({"id": pid, "x": px, "y": py, "f": facing})
            player_offset += PLAYER_STATE_SIZE
        frames.append({"c": clock_ms, "bx": bx, "by": by, "bvx": bvx, "bvy": bvy, "ctl": ctl, "itd": intended, "pl": players})
        offset += FRAME_SIZE
    return frames


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", help="Path to a native binary trace, e.g. build/s114.bin")
    parser.add_argument("--start", type=float, default=0.0, help="Start time in seconds")
    parser.add_argument("--end", type=float, default=float("inf"), help="End time in seconds")
    args = parser.parse_args()

    prev_ctl = -2
    for frame_index, frame in enumerate(parse_trace(args.trace)):
        seconds = frame["c"] / 1000
        if seconds < args.start or seconds > args.end:
            continue

        ball_speed = hypot(frame["bvx"], frame["bvy"])
        ctl = frame["ctl"]
        intended = frame["itd"]

        if ctl != prev_ctl and ctl >= 0 and seconds > args.start:
            print(
                f"[{seconds:7.3f}] f={frame_index:5d} POSSESSION: {prev_ctl:2d}({rname(prev_ctl)}) -> "
                f"{ctl:2d}({rname(ctl)})  pos=({frame['bx']:.0f},{frame['by']:.0f})  bs={ball_speed:.0f}"
            )

        if ctl == -1 and prev_ctl >= 0 and ball_speed > 80:
            launcher = next((p for p in frame["pl"] if p["id"] == prev_ctl), None)
            if launcher:
                ball_dir = degrees(atan2(frame["bvy"], frame["bvx"]))
                facing = degrees(launcher["f"])
                fx = cos(launcher["f"])
                fy = sin(launcher["f"])
                dot = (fx * frame["bvx"] + fy * frame["bvy"]) / (ball_speed + 0.01)
                label = "SHOT" if intended < 0 else "PASS"
                print(
                    f"[{seconds:7.3f}] f={frame_index:5d} {label:5s} ctl={prev_ctl:2d} {rname(prev_ctl):2s} "
                    f"facing={facing:6.1f}  ball_dir={ball_dir:6.1f}  dot={dot:5.2f}  "
                    f"speed={ball_speed:.0f}  itd={intended:2d}({rname(intended)})  "
                    f"from=({launcher['x']:.0f},{launcher['y']:.0f})  ball=({frame['bx']:.0f},{frame['by']:.0f})"
                )

        prev_ctl = ctl


if __name__ == "__main__":
    main()

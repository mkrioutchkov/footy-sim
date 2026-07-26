#!/usr/bin/env python3
"""Export an --arena drill trace to the viewer's match.json shape.

    ./build/live.exe 117 10 --arena 5 --trace build/replay/ar117.bin --no-debug
    EXPORT_BIN=build/replay/ar117.bin EXPORT_SEED=117 EXPORT_ARENA=5 EXPORT_MINUTES=10 \
        python3 tools/replay/export_arena.py

Same env-override contract as export_match.py, plus EXPORT_ARENA (the drill id).
Arena runs have no substitutions, so no sub log is joined; and they draw the RAW
`facing` rather than the smoothed `render_facing`, because a drill is a behaviour
probe — you want to see the angle the agent actually holds, shimmer and all.
"""
import os
import json
import subprocess

from replay_paths import engine_bin, outdir
from trace_reader import TraceReader

BIN = os.environ.get("EXPORT_BIN", os.path.join(outdir(), "arena.bin"))
SEED = int(os.environ.get("EXPORT_SEED", "117"))
MINUTES = os.environ.get("EXPORT_MINUTES", "10")
ARENA = os.environ.get("EXPORT_ARENA", "5")
OUT = os.environ.get("EXPORT_OUT", os.path.join(outdir(), "match.json"))
STEP_MS = int(os.environ.get("EXPORT_STEP_MS", "80"))

if not os.path.exists(BIN):
    raise SystemExit(f"no trace at {BIN} — run the engine with --trace first (see module docstring)")

# --- roster (names/roles/team) from a --summary run ---
out = subprocess.run([engine_bin(), str(SEED), MINUTES, "--arena", ARENA, "--summary", "--no-debug"],
                     capture_output=True, text=True).stdout.strip().splitlines()[-1]
summ = json.loads(out)
roster = [{"id": p["id"], "name": p["name"], "role": p["role"], "team": p["team"]}
          for p in summ["players"]]

# --- events ---
events = [{"t": round(e.clock_ms), "type": e.type, "x": round(e.x, 1), "y": round(e.y, 1),
           "pid": e.player_id, "team": e.team_id}
          for e in TraceReader.read_events(BIN)]


def pack(fr):
    # flat player array: [x,y,facing, x,y,facing, ...] rounded
    pl = []
    for p in fr.players:
        pl.append(round(p.x)); pl.append(round(p.y)); pl.append(round(p.facing, 2))
    return {
        "t": round(fr.clock_ms),
        "b": [round(fr.ball.x), round(fr.ball.y), round(fr.ball.z),
              fr.ball.controller_id, fr.ball.last_toucher_id],
        "hs": fr.home_score, "as": fr.away_score,
        "p": pl,
    }


frames = []
next_t = 0.0
last = None
for fr in TraceReader.stream_frames(BIN):
    last = fr
    if fr.clock_ms < next_t:
        continue
    next_t = fr.clock_ms + STEP_MS
    frames.append(pack(fr))
# Round-30: ALWAYS keep the final frame. The greedy step drops the whistle tick,
# so DUR landed 33-67ms short of the full_time event on every measured seed and
# the viewer's FULL TIME banner could never be reached.
if last is not None and (not frames or frames[-1]["t"] != round(last.clock_ms)):
    frames.append(pack(last))

data = {"seed": SEED, "pitchW": 1050, "pitchH": 680, "goalW": 73,
        "stepMs": STEP_MS, "roster": roster, "events": events, "subs": [], "frames": frames,
        "final": {"hs": summ["homeScore"], "as": summ["awayScore"],
                  "shots": summ["homeShots"] + summ["awayShots"],
                  "possHome": summ["possessionPct"]}}

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f, separators=(",", ":"))

print(f"frames={len(frames)} events={len(events)} final {summ['homeScore']}-{summ['awayScore']}")
print("event types:", sorted(set(e['type'] for e in events)))
print("json size KB:", os.path.getsize(OUT) // 1024)
print("wrote", OUT)

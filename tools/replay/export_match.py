#!/usr/bin/env python3
"""Turn a binary engine trace into the compact match.json the replay viewer reads.

    ./build/live.exe 13 35 --trace build/replay/m13.bin --no-debug
    EXPORT_BIN=build/replay/m13.bin EXPORT_SEED=13 EXPORT_MINUTES=35 \
        python3 tools/replay/export_match.py

Every input is an environment override, so one exporter serves any probe trace
without editing the file. Defaults land in build/replay/ (gitignored).

    EXPORT_BIN      trace to read            (default $REPLAY_DIR/match.bin)
    EXPORT_SEED     seed the trace was run with (default 13)
    EXPORT_MINUTES  minutes the trace covers (default 35)
    EXPORT_OUT      json to write            (default $REPLAY_DIR/match.json)
    EXPORT_STEP_MS  frame downsample step    (default 80 -> ~12.5fps)

The seed/minutes must match the trace: the roster and the final line come from a
separate `--summary` run of the same seed, which is only identical because the
engine is deterministic.
"""
import os
import sys
import json
import subprocess

from replay_paths import engine_bin, outdir
from trace_reader import TraceReader

BIN = os.environ.get("EXPORT_BIN", os.path.join(outdir(), "match.bin"))
SEED = int(os.environ.get("EXPORT_SEED", "13"))
MINUTES = os.environ.get("EXPORT_MINUTES", "35")
OUT = os.environ.get("EXPORT_OUT", os.path.join(outdir(), "match.json"))
STEP_MS = int(os.environ.get("EXPORT_STEP_MS", "80"))

if not os.path.exists(BIN):
    raise SystemExit(f"no trace at {BIN} — run the engine with --trace first (see module docstring)")

# --- roster (names/roles/team) from a --summary run of the same seed ---
out = subprocess.run([engine_bin(), str(SEED), MINUTES, "--summary", "--no-debug"],
                     capture_output=True, text=True).stdout.strip().splitlines()[-1]
summ = json.loads(out)
roster = [{"id": p["id"], "name": p["name"], "role": p["role"], "team": p["team"]}
          for p in summ["players"]]

# --- substitutions (Round-31) ---
# The binary trace's event record is fixed-width, so a "sub" event carries only the
# pitch SLOT id — and the engine renames that slot in the same tick, so the roster we
# export (from the END-of-match summary) resolves it to the man who came ON. The
# engine now publishes a whole-match sub log in the summary; join it to the trace's
# sub events on (clockMs, slotId) so a replay can name BOTH men.
subs = [{"t": round(s["clockMs"]), "slot": s["slotId"], "team": s["team"],
         "out": s["outName"], "in": s["inName"]}
        for s in summ.get("substitutionLog", [])]

# --- events ---
events = [{"t": round(e.clock_ms), "type": e.type, "x": round(e.x, 1), "y": round(e.y, 1),
           "pid": e.player_id, "team": e.team_id}
          for e in TraceReader.read_events(BIN)]


def pack(fr):
    # flat player array: [x,y,facing, x,y,facing, ...] rounded.
    # Round-31: RENDER from `render_facing` (the engine's low-passed display copy, which
    # the live web viewer has always used), not the raw `facing`. A .bin replay used to
    # draw the raw angle and so showed a body shimmer the live app smooths away. On a v2
    # trace render_facing mirrors facing, so an old export is unchanged. Analysis keeps
    # reading p.facing — it is the engine's truth and gates the vision cone.
    pl = []
    for p in fr.players:
        pl.append(round(p.x)); pl.append(round(p.y)); pl.append(round(p.render_facing, 2))
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
        "stepMs": STEP_MS, "roster": roster, "events": events, "subs": subs, "frames": frames,
        "final": {"hs": summ["homeScore"], "as": summ["awayScore"],
                  "shots": summ["homeShots"] + summ["awayShots"],
                  "possHome": summ["possessionPct"]}}

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f, separators=(",", ":"))

print(f"frames={len(frames)} events={len(events)} subs={len(subs)} final {summ['homeScore']}-{summ['awayScore']}")
print("event types:", sorted(set(e['type'] for e in events)))
print("json size KB:", os.path.getsize(OUT) // 1024)
print("wrote", OUT)

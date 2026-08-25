#!/usr/bin/env python3
"""Inline a match.json into viewer_template.html -> one standalone replay page.

    python3 tools/replay/build_viewer.py [match.json] [out.html]

Defaults to $REPLAY_DIR/match.json -> $REPLAY_DIR/replay.html. The result has no
external references at all: open the file, or hand it to anyone, and it plays.
"""
import os
import sys

from replay_paths import outdir

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.environ.get("VIEWER_TEMPLATE", os.path.join(HERE, "viewer_template.html"))

data_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(outdir(), "match.json")
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(outdir(), "replay.html")

tpl = open(TEMPLATE, encoding="utf-8").read()
data = open(data_path, encoding="utf-8").read()
assert "__DATA__" in tpl, f"template placeholder missing in {TEMPLATE}"
os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
open(out_path, "w", encoding="utf-8").write(tpl.replace("__DATA__", data))
print("wrote", out_path, os.path.getsize(out_path) // 1024, "KB")

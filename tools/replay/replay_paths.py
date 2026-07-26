"""Shared path resolution for the replay exporters.

The exporters used to live in a scratch directory and hard-coded absolute paths.
Everything is now resolved from the repo root (this file's grandparent), so the
tools work from any cwd and on any checkout.
"""
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.join(REPO, "tools")
# tools/trace_reader.py is the single binary-trace parser; keep one copy.
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

# build/ is gitignored, so it is the natural home for traces and exported pages.
OUTDIR = os.environ.get("REPLAY_DIR", os.path.join(REPO, "build", "replay"))


def engine_bin() -> str:
    """The native engine binary. build-native.ps1 emits live.exe, the .sh emits live."""
    for name in ("live.exe", "live"):
        p = os.path.join(REPO, "build", name)
        if os.path.exists(p):
            return p
    raise SystemExit(
        "no engine binary — build first:\n"
        "  mkdir -p build && g++ -std=c++20 -O2 -I third_party -o build/live engine/*.cpp")


def outdir() -> str:
    os.makedirs(OUTDIR, exist_ok=True)
    return OUTDIR

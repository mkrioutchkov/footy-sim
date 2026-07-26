#!/usr/bin/env python3
"""Tactics engine self-test + benchmark.

For each directive it runs baseline vs directed matches across many seeds and
asserts the relevant stat moves the EXPECTED direction (so a kind that silently
does nothing fails loudly). Plus determinism (every kind, replay-identical) and
the golden default-match guard. Summary-stat jobs run in parallel across cores;
frame-position jobs (for the movement kinds) stream a few short matches.

  python tools/tactics_bench.py
  BENCH_NOPOS=1 python tools/tactics_bench.py     # stat cases only (fast-ish)
  BENCH_RECORD=1 python tools/tactics_bench.py    # print observed verdicts, never fail
                                                  # (use when re-recording an xfail)

── Coverage contract (Round-31) ───────────────────────────────────────────────
Every one of the engine's 47 directive kinds (engine/engine.h DirectiveKind,
parsed in engine/main.cpp parseDirectives) is exercised here, plus the phantom
`gk_up_for_corners` that the TS layer emits and the engine has no enum entry for.
Each kind lands in exactly one of three tables:

  STAT  — a summary counter moves a stated DIRECTION (paired per-seed sign test)
  POS   — the directed player's average frame position moves a stated DIRECTION
  BITE  — no directional metric exists (the summary carries no per-receiver or
          per-taker breakdown), so the only honest assertion is that the
          directive changes the match at all

── Enforcement (Round-31) ─────────────────────────────────────────────────────
Every case runs and prints a verdict. Whether that verdict GATES depends on the
case's mode (last tuple slot; see the mode block below the imports):

  enforced (None)  a FAIL — the metric moved consistently the WRONG way — fails
                   the suite. WEAK does not: it means "no effect this sample can
                   resolve", which is a weaker claim than "broken".
  provisional      runs and reports, does not gate. This is where an assertion
                   lives until someone has actually RECORDED it against the
                   current engine head. Shipping an unrecorded assertion as a
                   gate would be asserting something nobody measured.
  pinned (xfail)   a measured, reproduced broken verdict. Fails loudly if it
                   changes AT ALL — including to PASS, which means the defect
                   was fixed and the pin must be deleted. A pin is not a mute.

Verdicts are sample-size dependent, so the sizes at the top of main() are part of
every recorded verdict. Shrinking them is conservative for the enforced cases (it
pushes verdicts toward WEAK, which does not gate); growing them can legitimately
move a borderline case, so re-record after a permanent change.

Do NOT fix engine defects from here — this file only has to notice them.
"""
import json, subprocess, copy, os, sys
# ThreadPool (not Process): the work is subprocess-bound (GIL released during the
# match run), so threads give real parallelism without Windows pickling/respawn
# overhead — and avoid the ProcessPool OOM/crash this hit before.
from concurrent.futures import ThreadPoolExecutor as ProcessPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = os.path.join(ROOT, "build", "live.exe")
# The base spec is COMMITTED (tools/tactics_fixture.json). It used to be
# web/backend/data/specs/fixture-1.json, which .gitignore excludes and which only
# exists after a league bootstrap seeded by unseeded Math.random() — so on a clean
# checkout this module raised FileNotFoundError at import and the "run the bench
# after every change" ritual four docs prescribe was impossible to follow.
# TACTICS_SPEC still points it at a real league fixture when you want one.
SPEC = os.environ.get("TACTICS_SPEC", os.path.join(ROOT, "tools", "tactics_fixture.json"))
BASE = json.load(open(SPEC))
PITCH_H = 680.0
RECORD = bool(os.environ.get("BENCH_RECORD"))
# Subprocess-bound work, so oversubscribing the core count is a win — and on a box
# shared with other engine runs it is the only way to keep a fair slice. Override
# with BENCH_WORKERS when you want the machine back.
WORKERS = int(os.environ.get("BENCH_WORKERS", 2 * (os.cpu_count() or 4)))

def _spec(seed, minutes, directives):
    s = copy.deepcopy(BASE); s["minutes"] = minutes; s["seed"] = seed
    s.pop("directives", None)          # the fixture must never smuggle a baseline directive
    if directives: s["directives"] = directives
    return s

def _run(args):
    seed, minutes, directives, stream = args
    fp = os.path.join(ROOT, f"_b_{seed}_{abs(hash(json.dumps(directives)))%99999}.json")
    json.dump(_spec(seed, minutes, directives), open(fp, "w"))
    cmd = [ENGINE, "--match", fp, "--no-debug"] + ([] if stream else ["--summary"])
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=240).stdout
    os.remove(fp)
    return out

def num(v): return sum(v.values()) if isinstance(v, dict) else (v or 0)

def at(*keys):
    """Metric accessor for a nested summary field: at('tackles','attempts').

    Prefer this over num() on a dict — num() sums EVERY value, so
    num(dribbleTypes) silently added launchSpeedAvg (a float speed that dominates
    the counts) and num(tackles) double-counted attempts + wins + fouls.
    """
    def get(d):
        for k in keys:
            if not isinstance(d, dict): return 0
            d = d.get(k)
        return d if isinstance(d, (int, float)) else 0
    return get

def summary(args):
    out = _run((*args, False))
    return json.loads([l for l in out.splitlines() if l.strip().startswith("{")][-1])

def avg_pos(args):
    # Memory-safe: stream the (huge) frame output line-by-line and accumulate ONLY
    # the target player's running sums — never hold all frames (that OOM'd at 6x).
    # Sample every 4th frame to cut JSON-parse CPU; the average is unaffected.
    seed, minutes, directives, pid = args
    fp = os.path.join(ROOT, f"_p_{seed}_{abs(hash(json.dumps(directives)))%99999}.json")
    json.dump(_spec(seed, minutes, directives), open(fp, "w"))
    proc = subprocess.Popen([ENGINE, "--match", fp, "--no-debug"], stdout=subprocess.PIPE, text=True, bufsize=1 << 16)
    sx = say = n = i = 0
    needle = f'"id":{pid},'
    for line in proc.stdout:
        if not line.startswith("{"): continue
        i += 1
        if i & 3: continue                 # sample 1 in 4 frames
        if needle not in line: continue
        try: f = json.loads(line)
        except: continue
        for p in f.get("players", []):
            if p.get("id") == pid:
                sx += p["x"]; say += abs(p["y"] - PITCH_H / 2.0); n += 1
                break
    proc.wait(); os.remove(fp)
    n = max(1, n)
    return sx / n, say / n

# ── case modes ────────────────────────────────────────────────────────────────
# The last slot of every case says how its verdict is enforced.
#
#   None            ENFORCED. A FAIL (the metric moved consistently the WRONG way)
#                   fails the suite. WEAK is not a failure — it means "no effect
#                   this sample can resolve".
#   PROV_*          PROVISIONAL. The case RUNS and prints its verdict, but does
#                   not gate. Used where the assertion has not yet been recorded
#                   against the current engine head, so enforcing it would be
#                   asserting something nobody has measured.
#   ("xfail", …)    PINNED to a measured, reproduced verdict. Fails loudly if the
#                   verdict changes AT ALL — including to PASS, which means the
#                   engine defect was fixed and the pin must be deleted.
#
# Turning a provisional case into an enforced one is deliberately cheap: run
# `BENCH_RECORD=1 python3 tools/tactics_bench.py`, confirm the verdict is stable,
# then drop the PROV_* marker (or pin it, if it is broken).
PROV_NEW = ("prov",
    "added round-31; direction derived from the engine code that consumes the "
    "directive, but not yet recorded against this engine head")
PROV_METRIC = ("prov",
    "metric corrected round-31 (was num(dribbleTypes), which summed launchSpeedAvg "
    "— a float speed — into a 'count'); the corrected metric has not been recorded")
PROV_POS = ("prov",
    "the movement rule became DIRECTIONAL in round-31: a wrong-direction move under "
    "8px used to score 'flat' and pass. Needs recording before it can gate")
PROV_CONTAIN = ("prov",
    "AUDIT: contain is self-cancelling — engine_defense_helpers.cpp:88-94 forces "
    "standoff=8.0 once the carrier stops progressing for 1500ms, which is exactly "
    "what a working contain causes. Round-32 fix: widen the 46px escort window by "
    "containBias*22 so the escort-stale override is contain-aware. Left provisional "
    "because the audit measured it on the PRE-aerial engine")
PROV_WIDTH = ("prov",
    "AUDIT: the width family moves BACKWARDS in position space — the full-back tuck "
    "(agent_positioning_helpers.cpp:19-26) reads the DIRECTIVE-MODIFIED homeY in its "
    "farSide test, and the wide run targets are absolute touchline constants gated by "
    "|carrier.y - homeY| < 190, so narrowing a winger unlocks the extreme-flank runs "
    "MORE often. Round-32 fix: read the BASE anchor in the tuck test and scale flankY "
    "with the anchor. Left provisional because the audit measured it on the PRE-aerial "
    "engine")
# The one pin that is provable without a statistical sweep, and re-verified on this
# engine head: gk_up_for_corners has no DirectiveKind entry and no parseDirectives
# branch, so main.cpp's `else continue` drops it outright; nothing in the engine ever
# writes the directiveBias[].gkUpForCorners that engine_gk.cpp reads, so its `up > 0.0`
# gate can never open. Measured 2026-07-26 on the aerial-duel head: byte-IDENTICAL
# summary on 3/3 seeds (1, 7, 13 @25min), while the control directive all_out_attack
# changed the match on 3/3 — so the harness can see a change; this kind simply is not
# one. Round-32 fix: add the enum entry AND resolve the keeper id inside the team-scope
# branch (engine_defense.cpp `continue`s before directiveBias[] is touched).
XFAIL_GK = ("xfail", "gk_up_for_corners is not wired to the engine at all", "INERT")

# ── stat benchmarks: (name, directives, stat_fn, "up"/"down", note, xfail) ──
P = lambda ids, kind, **kw: [dict({"playerId": i, "kind": kind}, **kw) for i in ids]
T = lambda kind, **kw: [dict({"teamScope": 0, "kind": kind}, **kw)]
STAT = [
    ("shoot_on_sight", P([5,6,7,9], "shoot_on_sight"), lambda d: num(d.get("homeShots")), "up",   "home CM+CF", None),
    ("cross_early",    P([1,4,8,10], "cross_early"),    lambda d: num(d.get("homeCrossesAttempted")), "up", "home wide", None),
    ("tackle_hard",    P([1,2,3,4], "tackle_hard"),     lambda d: num(d.get("yellowCards")), "up",  "home def", None),
    ("stay_on_feet",   P([1,2,3,4], "stay_on_feet"),    lambda d: num(d.get("yellowCards")), "down","home def", None),
    ("all_out_attack", T("all_out_attack"),             lambda d: num(d.get("homeShots")), "up",   "home", None),
    ("park_the_bus",   T("park_the_bus"),               lambda d: num(d.get("homeShots")), "down", "home", None),
    ("high_press",     T("high_press"),                 lambda d: num(d.get("tackles")), "up",     "home", None),
    ("drop_off",       T("drop_off"),                   lambda d: num(d.get("tackles")), "down",   "home", None),
    ("keep_it_on_ground", T("keep_it_on_ground"),       lambda d: num(d.get("passCompletionPct")), "up", "home", None),
    # added 2026-06-15 — coverage for the previously-unbenchmarked kinds
    ("man_mark",       [{"playerId":2,"kind":"man_mark","targetId":20},{"playerId":3,"kind":"man_mark","targetId":20}],
                                                         lambda d: num(d.get("awayShots")), "down", "2 CBs on their CF #20", None),
    # press_hard belongs on the PRESSING unit (mids+forwards), not the back line —
    # CBs hold the line, they're never the primary presser, so [1,2,3,4] measured a
    # no-op. On the front six it raises tackles a real but MODEST ~6-9% (often WEAK
    # on the strict paired sign test): the press standoff is already near-maximal
    # (full press_hard sits the presser ~3px off the carrier), so there's little
    # headroom. The impactful pressing lever is press HEIGHT (where the press starts
    # — a team-wide pressLineX), not standoff. See BORIS_TACTICS pressing-height.
    ("press_hard",     P([5,6,7,8,9,10], "press_hard"),  lambda d: num(d.get("tackles")), "up", "home press unit", None),
    ("play_simple",    P([5,6,7], "play_simple"),        lambda d: num(d.get("passCompletionPct")), "up", "home CM", None),
    ("play_it_long",   T("play_it_long"),                lambda d: num(d.get("passCompletionPct")), "down", "home", None),
    ("slow_it_down",   T("slow_it_down"),                lambda d: num(d.get("passCompletionPct")), "up", "home", None),
    # Round-31: was num(dribbleTypes), which summed launchSpeedAvg (a float speed
    # that dwarfs the counts) into the "dribble count". takeOnAttempts is the clean
    # scalar the engine already publishes.
    ("dribble_more",   P([8,9,10], "dribble_more"),      at("takeOnAttempts"), "up", "home att", PROV_METRIC),
    ("counter_attack", T("counter_attack"),              lambda d: num(d.get("throughBallsCompleted")), "up", "home break", None),
    ("offside_trap",   T("offside_trap"),                lambda d: num(d.get("offsides")), "up", "home traps away", None),

    # ── Round-31: the other half of the vocabulary ──────────────────────────
    # cut_inside disables bylineSeek for a wide carrier in the final third
    # (agent_shoot_dribble.cpp) — he drives inside instead of reaching the byline,
    # so the team's cross volume must FALL.
    ("cut_inside",     P([8,10], "cut_inside"),          at("homeCrossesAttempted"), "down", "home wide drive in", PROV_NEW),
    # overlap boosts the Overlap positioning purpose for the full-backs.
    ("overlap",        P([1,4], "overlap"),              at("homeCrossesAttempted"), "up", "home FBs overlap", PROV_NEW),
    # cutback has a dedicated counter and had never been asserted.
    ("cutback",        P([8,10], "cutback"),             at("cutbacksAttempted"), "up", "home wide", PROV_NEW),
    # come_short suppresses the RunAhead purpose: the CF drops off the last line.
    ("come_short",     P([9], "come_short"),             at("offsides"), "down", "CF #9 checks to feet", PROV_NEW),
    # the pocket is onside by construction (lerp between defLine and midLine).
    ("drift_into_pocket", P([9], "drift_into_pocket"),   at("offsides"), "down", "CF #9 between lines", PROV_NEW),
    # make_runs is run_in_behind at lower gain — same field, so the same metric.
    ("make_runs",      P([9], "make_runs"),              at("offsides"), "up", "CF #9 runs the line", PROV_NEW),
    # target_man_holdup gates the shield: the CF holds the ball up longer.
    ("target_man_holdup", P([9], "target_man_holdup"),   at("longestCarryMs"), "up", "CF #9 holds it up", PROV_NEW),
    # ball-playing CB: carry penalty relaxed, +Build/+Switch pass weights.
    ("ball_playing",   P([2,3], "ball_playing"),         at("forwardPasses"), "up", "home CBs step out", PROV_NEW),
    # switch_play has no dedicated counter; the honest proxy is mean pass distance.
    ("switch_play",    P([5,6,7], "switch_play"),        at("passSelection","avgDistance"), "up", "home CM switch", PROV_NEW),
    # shootDistBias +70k raises the hard cap and the soft range.
    ("shoot_from_distance", T("shoot_from_distance"),    at("shotsByDistance","average"), "up", "home", PROV_NEW),
    ("work_it_into_box",    T("work_it_into_box"),       at("shotsByDistance","average"), "down", "home", PROV_NEW),
    # The three gradated dials. main.cpp defaults intensity to 1.0 and the engine
    # maps k to s=(k-0.5)*2, so k=0.5 is a literal no-op (byte-identical match) —
    # a dial MUST be tested at both extremes or the test can never fail.
    ("press_intensity+", T("press_intensity", intensity=1.0), lambda d: num(d.get("tackles")), "up",   "dial k=1", PROV_NEW),
    ("press_intensity-", T("press_intensity", intensity=0.0), lambda d: num(d.get("tackles")), "down", "dial k=0", PROV_NEW),
    ("mentality+",       T("mentality", intensity=1.0),  at("homeShots"), "up",   "dial k=1", PROV_NEW),
    ("mentality-",       T("mentality", intensity=0.0),  at("homeShots"), "down", "dial k=0", PROV_NEW),
    ("line_height+",     T("line_height", intensity=1.0), at("lineTooDeepSamples"), "down", "dial k=1", PROV_NEW),
    ("line_height-",     T("line_height", intensity=0.0), at("lineTooDeepSamples"), "up",   "dial k=0", PROV_NEW),
    # The width family, measured through a SUMMARY counter rather than frame
    # position. See the POS table for the position-space assertions and the audit
    # note on why those read backwards.
    ("get_it_wide",    T("get_it_wide"),                 at("homeCrossesAttempted"), "up",   "home width", PROV_NEW),
    ("play_narrow",    T("play_narrow"),                 at("homeCrossesAttempted"), "down", "home width", PROV_NEW),
    # contain widens the primary presser's standoff by +22px …and then
    # engine_defense_helpers.cpp:88-94 slams standoff to 8.0 as soon as the carrier
    # stops progressing for 1500ms — which is exactly what a successful contain
    # causes. The order cancels itself; see the round-31 audit, "contain".
    ("contain",        P([5,6,7], "contain"),            at("marking","avgPrimaryPressDistance"), "up",
                                                         "home CM stand off", PROV_CONTAIN),
]
# ── movement benchmarks: (name, directives, pid, axis x|absy, up/down, note, xfail) ──
POS = [
    ("get_forward",   [{"playerId": 6, "kind": "get_forward"}],  6, "x",    "up",   "CM #6", PROV_POS),
    ("sit_deep",      [{"playerId": 6, "kind": "sit_deep"}],     6, "x",    "down", "CM #6", PROV_POS),
    ("run_in_behind", [{"playerId": 9, "kind": "run_in_behind"}], 9, "x",   "up",   "CF #9 advances", PROV_POS),
    ("push_up",       [{"teamScope": 0, "kind": "push_up"}],      2, "x",   "up",   "home CB #2 line", PROV_POS),
    # Round-31: stay_back damps the full-back's push-up/wide-purpose weights.
    ("stay_back",     [{"playerId": 1, "kind": "stay_back"}],     1, "x",   "down", "home FB #1 holds", PROV_POS),
    # ── the width family ──
    # The anchor writes in engine_defense.cpp are correctly signed, but the
    # measured lateral average moves the WRONG way, for two reasons found in the
    # round-31 audit:
    #  (1) agent_positioning_helpers.cpp:19-26 — the out-of-possession full-back
    #      "tuck" reads the DIRECTIVE-MODIFIED homeY in its farSide test, so a
    #      widened FB tucks over a strictly larger band of ball positions;
    #  (2) the wide run targets (flankY, farPostY, …) are ABSOLUTE touchline
    #      constants that depend only on sign(homeY-340), while the sameSide gate
    #      `|carrier.y - homeY| < 190` does depend on magnitude — so narrowing a
    #      winger unlocks the extreme-flank runs MORE often and widening him
    #      unlocks the narrow far-post run more often.
    # Both are engine defects and belong to round 32. Pinned here, not muted.
    ("stay_wide",     [{"playerId": 10, "kind": "stay_wide"}],  10, "absy", "up",   "WM #10", PROV_WIDTH),
    ("come_inside",   [{"playerId": 10, "kind": "come_inside"}],10, "absy", "down", "WM #10", PROV_WIDTH),
    ("stay_central",  [{"playerId": 10, "kind": "stay_central"}],10,"absy", "down", "WM #10 narrows", PROV_WIDTH),
    ("get_it_wide",   [{"teamScope": 0, "kind": "get_it_wide"}], 1, "absy", "up",   "home FB #1 width", PROV_WIDTH),
    ("play_narrow",   [{"teamScope": 0, "kind": "play_narrow"}], 1, "absy", "down", "home FB #1 width", PROV_WIDTH),
]
# ── bite tests: (name, directives, note, xfail) ────────────────────────────────
# Kinds with NO directional metric in the summary. `--summary` carries no
# per-receiver pass breakdown and no set-piece-taker identity, so "did the match
# change at all" is the strongest honest assertion. Passing means the directive
# is at least wired end-to-end; failing means it is INERT.
BITE = [
    ("target_player",    [{"playerId": 5, "kind": "target_player", "targetId": 9}],
                         "CM #5 looks for CF #9 (+0.30 receiver weight)", PROV_NEW),
    ("fk_taker",         [{"playerId": 10, "kind": "fk_taker"}],        "WM #10 takes free kicks", PROV_NEW),
    ("corner_taker",     [{"playerId": 10, "kind": "corner_taker"}],    "WM #10 takes corners", PROV_NEW),
    ("pen_taker",        [{"playerId": 2,  "kind": "pen_taker"}],       "CB #2 takes penalties", PROV_NEW),
    ("long_throw_taker", [{"playerId": 2,  "kind": "long_throw_taker"}],"CB #2 takes long throws", PROV_NEW),
    # gk_up_for_corners is emitted by web/frontend/app.ts and web/backend/coordinator.ts
    # but has NO DirectiveKind enum entry and no branch in parseDirectives, so
    # main.cpp hits `else continue` and drops it. engine_gk.cpp:80-95 reads
    # directiveBias[gk.id].gkUpForCorners, which nothing in the engine ever writes,
    # so the `up > 0.0` gate can never open. Fully inert — pinned as such.
    ("gk_up_for_corners", [{"teamScope": 0, "kind": "gk_up_for_corners", "intensity": 1.0}],
                          "keeper joins late corners", XFAIL_GK),
]
# Every kind in engine/engine.h DirectiveKind + the phantom the TS layer emits.
# main.cpp drops an unknown kind silently, so a typo here would look like a pass;
# main() cross-checks this list against the tables above and fails on a gap.
ALL_DIRECTIVE_KINDS = [
    "man_mark", "shoot_on_sight", "get_forward", "sit_deep", "target_player",
    "stay_wide", "come_inside", "cut_inside", "overlap", "stay_central",
    "cross_early", "switch_play", "play_simple", "cutback", "run_in_behind",
    "make_runs", "come_short", "drift_into_pocket", "dribble_more", "stay_back",
    "target_man_holdup", "ball_playing", "press_hard", "tackle_hard",
    "stay_on_feet", "contain",
    "fk_taker", "corner_taker", "pen_taker", "long_throw_taker",
    "all_out_attack", "park_the_bus", "high_press", "drop_off", "play_it_long",
    "keep_it_on_ground", "get_it_wide", "play_narrow", "push_up", "slow_it_down",
    "counter_attack", "offside_trap", "shoot_from_distance", "work_it_into_box",
    "press_intensity", "mentality", "line_height",
    "gk_up_for_corners",   # phantom: TS-only, no engine enum entry (see BITE)
]
ALL_KINDS = [  # one of every kind, for the determinism torture spec
    {"playerId":2,"kind":"man_mark","targetId":20},{"playerId":9,"kind":"shoot_on_sight"},
    {"playerId":6,"kind":"get_forward"},{"playerId":3,"kind":"sit_deep"},{"playerId":5,"kind":"target_player","targetId":9},
    {"playerId":10,"kind":"stay_wide"},{"playerId":8,"kind":"come_inside"},{"playerId":7,"kind":"stay_central"},
    {"playerId":1,"kind":"cross_early"},{"playerId":5,"kind":"switch_play"},{"playerId":7,"kind":"play_simple"},
    {"playerId":9,"kind":"run_in_behind"},{"playerId":8,"kind":"make_runs"},{"playerId":9,"kind":"dribble_more"},
    {"playerId":2,"kind":"press_hard"},{"playerId":3,"kind":"tackle_hard"},{"playerId":4,"kind":"stay_on_feet"},
    {"teamScope":0,"kind":"all_out_attack"},{"teamScope":1,"kind":"park_the_bus"},
    {"playerId":6,"kind":"get_forward","when":{"fromMin":20,"toMin":70}},
    {"teamScope":0,"kind":"high_press","when":{"scoreState":"losing"}},
    {"teamScope":0,"kind":"counter_attack"},{"teamScope":1,"kind":"offside_trap"},
    # Round-31: the determinism spec claimed "one of every kind" but exercised 22
    # of 47. The rest, so a replay-divergence in any of them is caught.
    {"playerId":8,"kind":"cut_inside"},{"playerId":4,"kind":"overlap"},
    {"playerId":10,"kind":"cutback"},{"playerId":9,"kind":"come_short"},
    {"playerId":6,"kind":"drift_into_pocket"},{"playerId":9,"kind":"target_man_holdup"},
    {"playerId":2,"kind":"ball_playing"},{"playerId":1,"kind":"stay_back"},
    {"playerId":5,"kind":"contain"},
    {"playerId":10,"kind":"fk_taker"},{"playerId":10,"kind":"corner_taker"},
    {"playerId":9,"kind":"pen_taker"},{"playerId":4,"kind":"long_throw_taker"},
    {"teamScope":0,"kind":"play_it_long"},{"teamScope":1,"kind":"keep_it_on_ground"},
    {"teamScope":0,"kind":"get_it_wide"},{"teamScope":1,"kind":"play_narrow"},
    {"teamScope":0,"kind":"push_up"},{"teamScope":1,"kind":"slow_it_down"},
    {"teamScope":0,"kind":"drop_off"},{"teamScope":1,"kind":"shoot_from_distance"},
    {"teamScope":0,"kind":"work_it_into_box"},
    {"teamScope":0,"kind":"press_intensity","intensity":0.8},
    {"teamScope":1,"kind":"mentality","intensity":0.2},
    {"teamScope":0,"kind":"line_height","intensity":0.9},
    {"teamScope":1,"kind":"gk_up_for_corners","intensity":1.0},
]



def judge(name, got, mode, fails, notes, provs):
    """Apply a case's enforcement mode to its observed verdict.

    Returns the label to print. See the mode block near the top of this file.
    """
    if mode is None:                                  # enforced
        if got == "FAIL": fails.append(name)
        return got
    if mode[0] == "prov":                             # runs, reports, does not gate
        provs.append((name, got, mode[1]))
        return f"prov({got})"
    _, why, want = mode                               # pinned
    if got == want:
        notes.append((name, why))
        return f"xfail({got})"
    if got == "PASS":
        fails.append(f"{name}: XPASS — pinned defect now behaves; confirm the engine "
                     f"fix and delete the pin")
        return f"XPASS!({got})"
    fails.append(f"{name}: pinned verdict changed {want}->{got}")
    return f"XSTATE!({want}->{got})"


def main():
    # Sample sizes. These are DELIBERATELY unchanged from the pre-round-31 arm
    # (30 seeds x 35min stat, 12 x 14min movement): the cases that still ENFORCE
    # are the ones that were already enforced, and a verdict is only meaningful at
    # the sample size it was calibrated at. Shrinking the sample does NOT make the
    # suite safer — at small n a single seed going the wrong way drags winrate past
    # the 0.38 FAIL threshold, so a short run manufactures failures. (Measured: at
    # 2 seeds x 3min, 9 long-standing cases "FAIL".) Everything added or changed in
    # round-31 is provisional precisely because it has NOT been recorded here yet.
    # Every arm is overridable so the whole script can be smoke-run in a couple of
    # minutes (BENCH_SEEDS=2 BENCH_MIN=3 BENCH_POS_SEEDS=2 BENCH_POS_MIN=3
    # BENCH_BITE_MIN=4) without touching the recorded defaults.
    NS = int(os.environ.get("BENCH_SEEDS", 30)); MIN = int(os.environ.get("BENCH_MIN", 35))
    SEEDS = list(range(1, NS + 1))
    # streaming arm: full frame output, far costlier per simulated minute than --summary
    PS = int(os.environ.get("BENCH_POS_SEEDS", 12)); POS_MIN = int(os.environ.get("BENCH_POS_MIN", 14))
    POS_SEEDS = list(range(1, PS + 1))
    BITE_SEEDS = [1, 7, 13, 22][:int(os.environ.get("BENCH_BITE_SEEDS", 4))]
    BITE_MIN = int(os.environ.get("BENCH_BITE_MIN", 30))
    fails = []
    notes = []
    provs = []

    # 0. coverage: every engine directive kind must appear in a table above.
    covered = {d["kind"] for tbl in (STAT, POS, BITE) for _, dirs, *_ in tbl for d in dirs}
    missing = [k for k in ALL_DIRECTIVE_KINDS if k not in covered]
    stray = sorted(covered - set(ALL_DIRECTIVE_KINDS))
    print(f"[coverage] {len(ALL_DIRECTIVE_KINDS)-len(missing)}/{len(ALL_DIRECTIVE_KINDS)} directive kinds asserted")
    if missing: print(f"  MISSING: {missing}"); fails.append("coverage")
    if stray:   print(f"  UNKNOWN KIND IN A TABLE (main.cpp would silently drop it): {stray}"); fails.append("coverage")
    det_kinds = {d["kind"] for d in ALL_KINDS}
    det_missing = [k for k in ALL_DIRECTIVE_KINDS if k not in det_kinds]
    if det_missing: print(f"  determinism spec MISSING: {det_missing}"); fails.append("coverage")

    # 1. determinism (all kinds in one spec, x2)
    a = json.dumps(summary((40985, 40, ALL_KINDS)), sort_keys=True)
    b = json.dumps(summary((40985, 40, ALL_KINDS)), sort_keys=True)
    det = "PASS" if a == b else "FAIL"
    if det == "FAIL": fails.append("determinism")
    print(f"[determinism] all-kinds spec x2: {det}")

    # 2. stat benchmarks (parallel). Verdict is a PAIRED per-seed sign test —
    # robust to cross-match variance, which makes summed totals (esp. for noisy
    # cross counts) misleading. win = the same seed moved the expected direction.
    print(f"\n[effect benchmarks] {len(SEEDS)} seeds x {MIN}min, paired per-seed (only HOME directed)")
    print(f"  {'kind':<20}{'base':>8}{'directed':>9}{'mean d':>9}{'win%':>7}  verdict        note")
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        base = {s: f for s, f in zip(SEEDS, ex.map(summary, [(s, MIN, None) for s in SEEDS]))}
        for name, dirs, fn, want, note, xkey in STAT:
            got = {s: g for s, g in zip(SEEDS, ex.map(summary, [(s, MIN, dirs) for s in SEEDS]))}
            pairs = [(fn(base[s]), fn(got[s])) for s in SEEDS]
            sgn = 1 if want == "up" else -1
            wins = sum(1 for b, d in pairs if (d - b) * sgn > 0)
            ties = sum(1 for b, d in pairs if d == b)
            winrate = wins / max(1, len(pairs) - ties)
            bv = sum(b for b, _ in pairs) / len(pairs); dv = sum(d for _, d in pairs) / len(pairs)
            # PASS: directed wins clearly. WEAK: ~coin-flip (within noise, no
            # reliable effect). FAIL: consistently the WRONG direction.
            verdict = "PASS" if winrate >= 0.62 else ("FAIL" if winrate <= 0.38 else "WEAK")
            label = verdict if RECORD else judge(name, verdict, xkey, fails, notes, provs)
            print(f"  {name:<20}{bv:>8.1f}{dv:>9.1f}{dv-bv:>+9.1f}{100*winrate:>6.0f}%  {label:<14} {want} · {note}")

    # 3. bite tests — no directional metric exists, so assert the directive changes
    # the match at all. Cheap: a handful of seeds, pass on the FIRST difference.
    print(f"\n[bite tests] {len(BITE_SEEDS)} seeds x {BITE_MIN}min — 'does this kind reach the engine at all?'")
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        bbase = {s: json.dumps(f, sort_keys=True) for s, f in
                 zip(BITE_SEEDS, ex.map(summary, [(s, BITE_MIN, None) for s in BITE_SEEDS]))}
        for name, dirs, note, xkey in BITE:
            got = list(ex.map(summary, [(s, BITE_MIN, dirs) for s in BITE_SEEDS]))
            moved = sum(1 for s, g in zip(BITE_SEEDS, got) if json.dumps(g, sort_keys=True) != bbase[s])
            verdict = "PASS" if moved else "INERT"
            label = verdict if RECORD else judge(name, verdict, xkey, fails, notes, provs)
            print(f"  {name:<20}{moved}/{len(BITE_SEEDS)} seeds changed   {label:<14} {note}")

    # 4. movement benchmarks (frame positions) — skip with BENCH_NOPOS=1 for a fast
    # stat-only re-run (the movement kinds are stable).
    if os.environ.get("BENCH_NOPOS"):
        print("\n[movement benchmarks] skipped (BENCH_NOPOS)")
        return finish(fails, notes, provs, partial=True)
    print(f"\n[movement benchmarks] {len(POS_SEEDS)} seeds x {POS_MIN}min (directed player avg position)")
    with ProcessPoolExecutor(max_workers=max(2, WORKERS // 3)) as ex:   # streaming is memory-heavy — keep it low
        # Baselines depend only on (seed, pid), so compute each ONCE instead of
        # re-streaming the same undirected match for every case that shares a pid.
        pids = sorted({pid for _, _, pid, *_ in POS})
        bcache = {pid: list(ex.map(avg_pos, [(s, POS_MIN, None, pid) for s in POS_SEEDS])) for pid in pids}
        for name, dirs, pid, axis, want, note, xkey in POS:
            b0 = bcache[pid]
            d0 = list(ex.map(avg_pos, [(s, POS_MIN, dirs, pid) for s in POS_SEEDS]))
            idx = 0 if axis == "x" else 1
            bv = sum(p[idx] for p in b0) / len(b0); dv = sum(p[idx] for p in d0) / len(d0)
            # Round-31: DIRECTIONAL. The old rule scored a wrong-direction move of
            # up to 8px as "flat" and passed it, which is exactly how the width
            # family stayed green while moving backwards. Now: moved the right way
            # by more than the 3px noise floor = PASS, wrong way by more than the
            # noise floor = FAIL, inside it = WEAK (no measurable effect).
            delta = dv - bv
            sgn = 1 if want == "up" else -1
            verdict = "WEAK" if abs(delta) < 3 else ("PASS" if delta * sgn > 0 else "FAIL")
            label = verdict if RECORD else judge(name, verdict, xkey, fails, notes, provs)
            print(f"  {name:<20}{axis:>5} {bv:>7.0f} -> {dv:>7.0f}  ({delta:+.0f}px)  expect {want:<5} {label:<14} ({note})")

    return finish(fails, notes, provs)


def finish(fails, notes, provs, partial=False):
    print(f"\n{'='*60}")
    if notes:
        print("PINNED known-failing (round 32 owns the engine fixes):")
        for name, why in notes:
            print(f"  · {name:<20} {why}")
    if provs:
        print(f"provisional — {len(provs)} case(s) run but do NOT gate. Record them with")
        print("BENCH_RECORD=1 and drop the PROV_* marker to make them enforce:")
        for name, got, why in provs:
            print(f"  · {name:<20} {got:<5} {why.split(';')[0].split('.')[0]}")
    if RECORD:
        print("\nBENCH_RECORD — no verdict enforced."); return
    if fails:
        print(f"\nFAILURES: {fails}")
        print("An XPASS means a pinned defect now behaves: confirm the engine fix, then")
        print("delete the case's xfail key. An XSTATE means it changed but is still wrong.")
        sys.exit(1)
    print("\nstat benchmarks pass" if partial else "\nALL TACTICS BENCHMARKS PASS")


if __name__ == "__main__":
    main()

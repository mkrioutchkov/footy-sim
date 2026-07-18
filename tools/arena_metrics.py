#!/usr/bin/env python3
import sys, json, subprocess, os
EXE = sys.argv[1] if len(sys.argv) > 1 else 'build/live.exe'
SPEC = os.environ.get('ARENA_SPEC', os.path.join(os.path.dirname(__file__), 'arena_spec.json'))
seeds = [42, 7, 99, 13, 77]
if len(sys.argv) > 2:
    seeds = [int(x) for x in sys.argv[2].split(',')]
hdr = f"{'seed':>5} {'G':>5} {'shots':>6} {'takeon':>7} {'succ':>5} {'fouls':>6} {'skill':>6} {'red':>4} {'frz':>4} {'inv':>4} {'tp':>4}"
print(hdr)
tot = {}
for s in seeds:
    out = subprocess.run([EXE, str(s), '10', '--arena', '--match', SPEC, '--no-debug', '--summary'],
                         capture_output=True, text=True).stdout
    d = json.loads(out)
    g = d['homeScore'] + d['awayScore']
    shots = d['homeShots'] + d['awayShots']
    fouls = d['tackles']['fouls']
    skill = d.get('skillMoves', 0)
    red = d.get('redCards', 0)
    frz = d.get('simulationFreezes', 0)
    inv = d.get('invariantViolations', 0)
    ta = d.get('takeOnAttempts', 0)
    tw = d.get('takeOnWins', 0)
    succ = f"{100*tw/ta:.0f}%" if ta else "-"
    qf = d.get('qualityFlags', {})
    tp = qf.get('BallTeleport', 0) if isinstance(qf, dict) else 0
    print(f"{s:>5} {g:>5} {shots:>6} {ta:>7} {succ:>5} {fouls:>6} {skill:>6} {red:>4} {frz:>4} {inv:>4} {tp:>4}")
    for k, v in [('g', g), ('shots', shots), ('ta', ta), ('tw', tw), ('fouls', fouls), ('skill', skill), ('red', red)]:
        tot[k] = tot.get(k, 0) + v
n = len(seeds)
succ = f"{100*tot['tw']/tot['ta']:.0f}%" if tot['ta'] else "-"
print(f"{'AVG':>5} {tot['g']/n:>5.1f} {tot['shots']/n:>6.1f} {tot['ta']/n:>7.1f} {succ:>5} {tot['fouls']/n:>6.1f} {tot['skill']/n:>6.1f} {tot['red']/n:>4.1f}")

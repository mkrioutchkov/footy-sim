#!/usr/bin/env python3
"""Binary trace reader for footy-sim engine traces.

Usage:
    from trace_reader import TraceReader

    trace = TraceReader("seed_101.trace")
    print(f"Seed: {trace.header.seed}, Frames: {len(trace.frames)}")

    # Iterate frames in a time range
    for frame in trace.frames_ms(5000, 7000):
        print(f"  {frame.clock_ms:.0f}ms ball=({frame.ball.x:.0f},{frame.ball.y:.0f}) ctrl={frame.ball.controller_id}")

    # List events
    for event in trace.events:
        print(f"  {event.type} at {event.clock_ms:.0f}ms ({event.x:.0f},{event.y:.0f})")

    # Export to JSON
    trace.to_json("output.json", start_ms=0, end_ms=60000)
"""
import struct
import json
from dataclasses import dataclass, field
from typing import List, Optional, Iterator

HEADER_FMT = '<IIi d 32s'
HEADER_SIZE = struct.calcsize(HEADER_FMT)
TRACE_MAGIC = 0x46545346  # "FSTF"

# Current writer version (engine/trace.h TRACE_VERSION). Older versions still load:
# the frame layout is selected from the header's version field, so a v2 trace kept
# from an earlier round is readable — its `render_facing` simply mirrors `facing`.
TRACE_VERSION = 3

# v2: id, x, y, vx, vy, targetX, targetY, stamina, facing, dribbleType,
#     tackleAnim, headingAnim, wall
_PLAYER_FMT_V2 = '<i dd dd dd d d i dd i'
# v3: + renderFacing (smoothed display copy; `facing` stays the raw analysis truth)
_PLAYER_FMT_V3 = '<i dd dd dd d d i dd i d'

BALL_FMT = '<dddd dd ii i d'  # v2: + curl (double)
BALL_SIZE = struct.calcsize(BALL_FMT)


def _layout(version: int):
    """(player_fmt, player_size, frame_fmt, frame_size) for a trace version."""
    if version <= 2:
        pf = _PLAYER_FMT_V2
    elif version == 3:
        pf = _PLAYER_FMT_V3
    else:
        raise ValueError(
            f'trace version {version} is newer than this reader (max {TRACE_VERSION}). '
            'Update tools/trace_reader.py to match engine/trace.h.')
    ps = struct.calcsize(pf)
    ff = f'<d {BALL_SIZE}s {ps * 22}s ii dd'
    return pf, ps, ff, struct.calcsize(ff)


def read_header(path: str) -> 'Header':
    with open(path, 'rb') as f:
        magic, version, seed, duration, version_bytes = struct.unpack(HEADER_FMT, f.read(HEADER_SIZE))
    if magic != TRACE_MAGIC:
        raise ValueError(f'{path}: not a footy-sim trace (magic {magic:#x})')
    return Header(magic=magic, version=version, seed=seed, match_duration_ms=duration,
                  engine_version=version_bytes.rstrip(b'\x00').decode('utf-8', errors='replace'))


# Back-compat module constants: the CURRENT version's layout. Prefer _layout(version).
PLAYER_FMT, PLAYER_SIZE, FRAME_FMT, FRAME_SIZE = _layout(TRACE_VERSION)

EVENT_FMT = '<d 24s dd ii'
EVENT_SIZE = struct.calcsize(EVENT_FMT)

FOOTER_FMT = '<II'
FOOTER_SIZE = struct.calcsize(FOOTER_FMT)


@dataclass
class BallState:
    x: float = 0
    y: float = 0
    vx: float = 0
    vy: float = 0
    z: float = 0
    vz: float = 0
    controller_id: int = -1
    intended_receiver_id: int = -1
    last_toucher_id: int = -1
    curl: float = 0


@dataclass
class PlayerState:
    id: int = 0
    x: float = 0
    y: float = 0
    vx: float = 0
    vy: float = 0
    target_x: float = 0
    target_y: float = 0
    stamina: float = 0
    facing: float = 0
    dribble_type: int = 0
    tackle_anim: float = 0
    heading_anim: float = 0
    wall: int = 0
    # v3 render hint: the engine's smoothed display facing (EMA alpha 0.18). Use it to
    # DRAW a player; keep using `facing` for anything that reasons about the sim (it is
    # what gates the vision cone). On a v2 trace it mirrors `facing`.
    render_facing: float = 0


@dataclass
class Frame:
    clock_ms: float = 0
    ball: BallState = field(default_factory=BallState)
    players: List[PlayerState] = field(default_factory=list)
    home_score: int = 0
    away_score: int = 0
    physics_ms: float = 0
    agent_ms: float = 0


# Known trace event `type` values — the engine's ACTUAL emit vocabulary. The old
# hand-maintained list had drifted to 20 entries while the engine emits 42: it was
# missing every restart/dead-ball type (goal_kick, corner, kickoff, throw_in ...),
# which made a downstream probe misread goal-kick choreography as a player anomaly
# until it blanked those events itself (found during the round-35 engagement
# audit). It also carried 'stuck' and 'freeze', which nothing has emitted for
# rounds. Regenerate rather than hand-edit:
#   grep -rhoE 'emitEvent\("([a-z_]+)"' engine/*.cpp | sed 's/emitEvent("//;s/"//' | sort -u
# plus the variable-typed skill-move emits in agent.cpp (moveType/mv):
#   dragback, nutmeg, roulette, stepover, skill.
KNOWN_EVENT_TYPES = frozenset({
    'added_time', 'advantage', 'assist', 'block', 'chop', 'claim', 'clearance',
    'corner', 'corner_short', 'dragback', 'foul', 'free_kick', 'full_time',
    'gk_punch', 'goal', 'goal_kick', 'half_time', 'handball', 'header', 'injury',
    'intercept', 'kickoff', 'nutmeg', 'offside', 'pass', 'penalty', 'red',
    'roulette', 'save', 'shot', 'skill', 'steal', 'stepover', 'sub', 'tackle',
    'tackle_loose', 'tackle_won', 'takeon', 'takeon_lost', 'throw_in', 'tip',
    'woodwork', 'yellow',
})


@dataclass
class Event:
    clock_ms: float = 0
    type: str = ''
    x: float = 0
    y: float = 0
    player_id: int = -1
    team_id: int = -1


@dataclass
class Header:
    magic: int = 0
    version: int = 0
    seed: int = 0
    match_duration_ms: float = 0
    engine_version: str = ''


class TraceReader:
    def __init__(self, path: str):
        self.path = path
        self.header = Header()
        self.frames: List[Frame] = []
        self.events: List[Event] = []
        self._read()

    def _read(self):
        self.header = read_header(self.path)
        # Frame layout depends on the header's version — a v2 trace kept from an
        # earlier round still loads (its render_facing mirrors facing).
        pf, ps, ff, fs = _layout(self.header.version)
        self._player_fmt, self._player_size, self._frame_size = pf, ps, fs
        with open(self.path, 'rb') as f:
            file_size = f.seek(0, 2)
            f.seek(file_size - FOOTER_SIZE)
            footer_data = f.read(FOOTER_SIZE)
            self.frames = []
            self.events = []
            if len(footer_data) != FOOTER_SIZE:
                return
            frame_count, event_count = struct.unpack(FOOTER_FMT, footer_data)
            f.seek(HEADER_SIZE)
            for _ in range(frame_count):
                frame_data = f.read(fs)
                if len(frame_data) == fs:
                    self.frames.append(self._parse_frame(frame_data))
            for _ in range(event_count):
                event_data = f.read(EVENT_SIZE)
                if len(event_data) == EVENT_SIZE:
                    self.events.append(self._parse_event(event_data))

    def _parse_frame(self, data: bytes) -> Frame:
        player_fmt = getattr(self, '_player_fmt', PLAYER_FMT)
        player_size = getattr(self, '_player_size', PLAYER_SIZE)
        offset = 0
        clock_ms = struct.unpack_from('<d', data, offset)[0]; offset += 8

        # Ball
        ball_data = struct.unpack_from(BALL_FMT, data, offset); offset += BALL_SIZE
        ball = BallState(
            x=ball_data[0], y=ball_data[1], vx=ball_data[2], vy=ball_data[3],
            z=ball_data[4], vz=ball_data[5],
            controller_id=ball_data[6], intended_receiver_id=ball_data[7],
            last_toucher_id=ball_data[8], curl=ball_data[9]
        )

        # Players
        players = []
        for _ in range(22):
            pd = struct.unpack_from(player_fmt, data, offset); offset += player_size
            players.append(PlayerState(
                id=pd[0], x=pd[1], y=pd[2], vx=pd[3], vy=pd[4],
                target_x=pd[5], target_y=pd[6], stamina=pd[7],
                facing=pd[8], dribble_type=pd[9],
                tackle_anim=pd[10], heading_anim=pd[11], wall=pd[12],
                render_facing=pd[13] if len(pd) > 13 else pd[8],
            ))

        home_score, away_score = struct.unpack_from('<ii', data, offset); offset += 8
        physics_ms, agent_ms = struct.unpack_from('<dd', data, offset); offset += 16

        return Frame(
            clock_ms=clock_ms, ball=ball, players=players,
            home_score=home_score, away_score=away_score,
            physics_ms=physics_ms, agent_ms=agent_ms
        )

    def _parse_event(self, data: bytes) -> Event:
        clock_ms, type_bytes, x, y, player_id, team_id = struct.unpack(EVENT_FMT, data)
        return Event(
            clock_ms=clock_ms,
            type=type_bytes.rstrip(b'\x00').decode('utf-8', errors='replace'),
            x=x, y=y, player_id=player_id, team_id=team_id
        )

    @staticmethod
    def read_events(path: str) -> List[Event]:
        """Read ONLY the events (small) without loading any frames — O(events) memory."""
        frame_size = _layout(read_header(path).version)[3]
        with open(path, 'rb') as f:
            file_size = f.seek(0, 2)
            f.seek(file_size - FOOTER_SIZE)
            frame_count, event_count = struct.unpack(FOOTER_FMT, f.read(FOOTER_SIZE))
            f.seek(HEADER_SIZE + frame_count * frame_size)
            evs = []
            for _ in range(event_count):
                d = f.read(EVENT_SIZE)
                if len(d) == EVENT_SIZE:
                    clock_ms, tb, x, y, pid, tid = struct.unpack(EVENT_FMT, d)
                    evs.append(Event(clock_ms=clock_ms, type=tb.rstrip(b'\x00').decode('utf-8', 'replace'),
                                     x=x, y=y, player_id=pid, team_id=tid))
            return evs

    @staticmethod
    def stream_frames(path: str) -> Iterator[Frame]:
        """Yield frames ONE AT A TIME without holding them all in memory — O(1) frames.
        Use this (not TraceReader(path).frames) for long traces; a 90-min trace has
        ~325k frames and the full list balloons to multiple GB of Python objects."""
        dummy = TraceReader.__new__(TraceReader)   # for _parse_frame (no instance state needed)
        pf, ps, _ff, fs = _layout(read_header(path).version)
        dummy._player_fmt, dummy._player_size, dummy._frame_size = pf, ps, fs
        with open(path, 'rb') as f:
            file_size = f.seek(0, 2)
            f.seek(file_size - FOOTER_SIZE)
            frame_count, _ = struct.unpack(FOOTER_FMT, f.read(FOOTER_SIZE))
            f.seek(HEADER_SIZE)
            for _ in range(frame_count):
                d = f.read(fs)
                if len(d) < fs:
                    break
                yield dummy._parse_frame(d)

    def frames_ms(self, start_ms: float = 0, end_ms: float = float('inf')) -> Iterator[Frame]:
        """Iterate frames in a time range (milliseconds)."""
        for frame in self.frames:
            if frame.clock_ms < start_ms:
                continue
            if frame.clock_ms > end_ms:
                break
            yield frame

    def player_frames(self, player_id: int, start_ms: float = 0, end_ms: float = float('inf')) -> Iterator[tuple]:
        """Iterate (frame, player_state) for a specific player."""
        for frame in self.frames_ms(start_ms, end_ms):
            for p in frame.players:
                if p.id == player_id:
                    yield frame, p
                    break

    def events_ms(self, start_ms: float = 0, end_ms: float = float('inf')) -> Iterator[Event]:
        """Iterate events in a time range."""
        for event in self.events:
            if event.clock_ms < start_ms:
                continue
            if event.clock_ms > end_ms:
                break
            yield event

    def to_json(self, path: str, start_ms: float = 0, end_ms: float = float('inf')):
        """Export frames to JSON file."""
        data = {
            'header': {
                'seed': self.header.seed,
                'version': self.header.engine_version,
                'duration_ms': self.header.match_duration_ms,
            },
            'frames': [],
            'events': [],
        }
        for frame in self.frames_ms(start_ms, end_ms):
            f = {
                'clock_ms': frame.clock_ms,
                'ball': {'x': frame.ball.x, 'y': frame.ball.y,
                         'vx': frame.ball.vx, 'vy': frame.ball.vy,
                         'controller_id': frame.ball.controller_id},
                'home_score': frame.home_score,
                'away_score': frame.away_score,
            }
            data['frames'].append(f)
        for event in self.events_ms(start_ms, end_ms):
            data['events'].append({
                'clock_ms': event.clock_ms, 'type': event.type,
                'x': event.x, 'y': event.y, 'player_id': event.player_id,
            })
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)

    def summary(self) -> dict:
        """Return a summary dict of the trace."""
        return {
            'seed': self.header.seed,
            'version': self.header.engine_version,
            'total_frames': len(self.frames),
            'total_events': len(self.events),
            'duration_ms': self.frames[-1].clock_ms if self.frames else 0,
            'events_by_type': {},
        }


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("Usage: python trace_reader.py <trace_file> [--json output.json] [--range start_ms end_ms]")
        sys.exit(1)

    trace = TraceReader(sys.argv[1])
    print(f"Seed: {trace.header.seed}")
    print(f"Frames: {len(trace.frames)}")
    print(f"Events: {len(trace.events)}")
    if trace.frames:
        print(f"Duration: {trace.frames[-1].clock_ms:.0f}ms")

    if '--json' in sys.argv:
        idx = sys.argv.index('--json')
        out_path = sys.argv[idx + 1]
        start_ms = 0
        end_ms = float('inf')
        if '--range' in sys.argv:
            ri = sys.argv.index('--range')
            start_ms = float(sys.argv[ri + 1])
            end_ms = float(sys.argv[ri + 2])
        trace.to_json(out_path, start_ms, end_ms)
        print(f"Exported to {out_path}")

    for event in trace.events:
        print(f"  [{event.type}] {event.clock_ms:.0f}ms ({event.x:.0f},{event.y:.0f}) player={event.player_id}")

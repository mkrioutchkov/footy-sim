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

PLAYER_FMT = '<i dd dd dd d d i dd'
PLAYER_SIZE = struct.calcsize(PLAYER_FMT)

BALL_FMT = '<dddd dd ii i'
BALL_SIZE = struct.calcsize(BALL_FMT)

FRAME_FMT = f'<d {BALL_SIZE}s {PLAYER_SIZE * 22}s ii dd'
FRAME_SIZE = struct.calcsize(FRAME_FMT)

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


@dataclass
class Frame:
    clock_ms: float = 0
    ball: BallState = field(default_factory=BallState)
    players: List[PlayerState] = field(default_factory=list)
    home_score: int = 0
    away_score: int = 0
    physics_ms: float = 0
    agent_ms: float = 0


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
        with open(self.path, 'rb') as f:
            # Header
            data = f.read(HEADER_SIZE)
            magic, version, seed, duration, version_bytes = struct.unpack(HEADER_FMT, data)
            self.header = Header(
                magic=magic, version=version, seed=seed,
                match_duration_ms=duration,
                engine_version=version_bytes.rstrip(b'\x00').decode('utf-8', errors='replace')
            )

            # Calculate frame and event counts from file size
            file_size = f.seek(0, 2)
            f.seek(HEADER_SIZE)
            remaining = file_size - HEADER_SIZE - FOOTER_SIZE
            num_frames = remaining // (FRAME_SIZE + EVENT_SIZE * 0)  # approximate
            # We'll read until we hit the footer

            f.seek(HEADER_SIZE)
            self.frames = []
            self.events = []

            # Read frames and events until footer
            while True:
                pos = f.tell()
                remaining = file_size - pos
                if remaining <= FOOTER_SIZE:
                    break

                # Try reading a frame
                if remaining >= FRAME_SIZE:
                    frame_data = f.read(FRAME_SIZE)
                    if len(frame_data) < FRAME_SIZE:
                        break
                    frame = self._parse_frame(frame_data)
                    self.frames.append(frame)
                else:
                    break

            # Read events after frames (events are written interleaved or after)
            # Actually, events are written inline. Let me re-read with event support.
            # The format writes frames and events interleaved.
            # We need to detect which is which by trying both formats.
            # For now, just read the footer.
            f.seek(file_size - FOOTER_SIZE)
            footer_data = f.read(FOOTER_SIZE)
            if len(footer_data) == FOOTER_SIZE:
                frame_count, event_count = struct.unpack(FOOTER_FMT, footer_data)
                # Re-read with correct counts
                f.seek(HEADER_SIZE)
                self.frames = []
                self.events = []
                for _ in range(frame_count):
                    frame_data = f.read(FRAME_SIZE)
                    if len(frame_data) == FRAME_SIZE:
                        self.frames.append(self._parse_frame(frame_data))
                for _ in range(event_count):
                    event_data = f.read(EVENT_SIZE)
                    if len(event_data) == EVENT_SIZE:
                        self.events.append(self._parse_event(event_data))

    def _parse_frame(self, data: bytes) -> Frame:
        offset = 0
        clock_ms = struct.unpack_from('<d', data, offset)[0]; offset += 8

        # Ball
        ball_data = struct.unpack_from(BALL_FMT, data, offset); offset += BALL_SIZE
        ball = BallState(
            x=ball_data[0], y=ball_data[1], vx=ball_data[2], vy=ball_data[3],
            z=ball_data[4], vz=ball_data[5],
            controller_id=ball_data[6], intended_receiver_id=ball_data[7],
            last_toucher_id=ball_data[8]
        )

        # Players
        players = []
        for _ in range(22):
            pd = struct.unpack_from(PLAYER_FMT, data, offset); offset += PLAYER_SIZE
            players.append(PlayerState(
                id=pd[0], x=pd[1], y=pd[2], vx=pd[3], vy=pd[4],
                target_x=pd[5], target_y=pd[6], stamina=pd[7],
                facing=pd[8], dribble_type=pd[9],
                tackle_anim=pd[10], heading_anim=pd[11]
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

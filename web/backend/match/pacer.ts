// Pacing a frame stream to one WebSocket client: the pure per-step decision (paceStep) and the
// shared queue/speed/pause/tick machinery (FramePacer). Frame SOURCES subclass it — see streams.ts.
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { WebSocket } from 'ws';
import { type Weather, weatherForSeed } from './weather.ts';

// ── Live watch / replay: pace a frame stream to one client ──
export const DEFAULT_FRAME_MS = 1000 / 30;
export type Proc = ChildProcessByStdio<null, Readable, Readable>;

// One pacing step over a frame queue (pure, so it's unit-testable). At ≤1× every frame is paced
// by its own clock delta / speed (real-time or slow-mo). At >1× we FRAME-SKIP: drain ~speed× of
// match-clock per render and send only the last frame — so 4× is genuinely 4× wall-clock while
// the render cadence stays ~30fps and the socket never floods. (The old code capped EVERY >1× at
// one frame per 33ms, so 2×/4×/60× all played identically — the "fast-forward does nothing" bug.)
// Mutates `pending` — shifts the consumed frame(s) off it.
export interface PaceStep { state: any | null; prevClock: number | null; delayMs: number; drained: number }
export function paceStep(pending: string[], prevClock: number | null, speed: number): PaceStep {
  if (pending.length === 0) return { state: null, prevClock, delayMs: DEFAULT_FRAME_MS, drained: 0 };
  if (speed > 1) {
    const budget = DEFAULT_FRAME_MS * speed;
    let advanced = 0, drained = 0, pc = prevClock;
    let lastLine: string | null = null;
    while (pending.length && advanced < budget) {
      const line = pending.shift()!; drained++;
      // SKIPPED frames only need their clock — extract it with the same cheap regex ReplayStream's
      // pre-index uses. Full-parsing every drained 22-player frame cost ~240 parses/sec at 8×
      // (~1,800/sec at the 60× cap) on the box the engine shares. Only the frame actually SENT is parsed.
      const m = line.match(/"clockMs":(-?\d+(?:\.\d+)?)/);
      if (m) { const c = +m[1]; advanced += pc === null ? DEFAULT_FRAME_MS : Math.max(0, c - pc); pc = c; }
      lastLine = line;
    }
    let state: any = null;
    if (lastLine !== null) { try { state = JSON.parse(lastLine); } catch { /* malformed tail — tick() retries the queue */ } }
    // Pace by the match-clock actually CONSUMED, not a fixed 33ms tick. On a thinned recording
    // (REPLAY_SAMPLE=8 → ~264ms between frames) one frame overshoots the whole 2×/4× budget, and a
    // fixed delay floored playback at ~8× no matter what speed was chosen (2× and 4× played
    // identically fast). advanced/speed keeps the wall-clock honest: one 264ms frame at 2× waits
    // 132ms; an unthinned ~33ms live stream still lands on ~33ms (unchanged).
    return { state, prevClock: pc, delayMs: Math.max(DEFAULT_FRAME_MS, advanced / speed), drained };
  }
  const line = pending.shift()!;
  let state: any; try { state = JSON.parse(line); } catch { return { state: null, prevClock, delayMs: 1, drained: 1 }; }
  const delta = prevClock === null ? DEFAULT_FRAME_MS : Math.max(1, state.clockMs - prevClock);
  return { state, prevClock: state.clockMs, delayMs: Math.max(1, delta / speed), drained: 1 };
}

// Shared pacer: holds the frame queue + speed/pause/clock and the tick loop. Subclasses supply
// the frame SOURCE — the live engine (MatchStream) or a stored recording (ReplayStream) — via
// refill() (called when the queue drains) plus their own command handling.
export abstract class FramePacer {
  protected pending: string[] = [];
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected prevClock: number | null = null;
  protected speed = 1;
  protected paused = false;
  protected latest: any = null;
  protected alive = true;
  protected replay = false;   // tags the wire frame so the client hides live-only controls
  protected durationMs = 0;   // the recording's real match length (ReplayStream sets it) — sizes the client scrub slider; 0 = unknown/live
  // explicit fields (not constructor parameter properties) — the tools tsconfig type-checks this
  // file under erasableSyntaxOnly, which disallows that syntax.
  protected ws: WebSocket;
  protected seed: number;
  protected homeName: string;
  protected awayName: string;
  protected weather: Weather;   // §weather: the match's condition (same seed-derived value the spec carried)

  constructor(ws: WebSocket, seed: number, homeName: string, awayName: string) {
    this.ws = ws; this.seed = seed; this.homeName = homeName; this.awayName = awayName;
    this.weather = weatherForSeed(seed);
  }

  protected send(state: any): void {
    if (this.ws.readyState !== 1) return;
    this.latest = state;
    this.ws.send(JSON.stringify({ ...state, seed: this.seed, speed: this.speed, homeName: this.homeName, awayName: this.awayName, weather: this.weather, replay: this.replay, durationMs: this.durationMs || undefined, matchState: this.paused ? 'paused' : state.matchState }));
  }

  protected tick(): void {
    if (this.timer || this.paused || !this.alive) return;
    if (this.pending.length === 0) { this.refill(); return; }
    // LOW-WATER refill: resuming the source only when the queue EMPTIED made fast-forward starve on a
    // live re-sim — each drain-to-empty waited a full resume→chunk round-trip, capping 8× at ~3.6×.
    // Refill while we still have frames to pace so the pipe fills in parallel (growth stays bounded:
    // the stdout handler re-pauses after every chunk; a recording's refill is a no-op).
    if (this.pending.length < 32) this.refill();
    const r = paceStep(this.pending, this.prevClock, this.speed);
    this.prevClock = r.prevClock;
    if (r.state === null) { this.tick(); return; }   // parse-skip / nothing drained — try the next
    this.send(r.state);
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, r.delayMs);
  }

  // Queue drained: the live source resumes the engine's stdout; a finished recording does nothing.
  protected abstract refill(): void;

  protected setSpeed(v: number): void {
    this.speed = Math.max(0.25, Math.min(60, v));
    if (this.latest) this.send(this.latest);
    // Re-arm the in-flight tick under the NEW speed — else the change only bites after the previously
    // scheduled inter-frame delay (up to ~528ms leaving 0.5× on a thinned recording), reading as a stall.
    if (!this.paused && this.timer) { clearTimeout(this.timer); this.timer = null; this.tick(); }
  }
  protected togglePause(): void {
    this.paused = !this.paused;
    if (this.paused && this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.latest) this.send(this.latest);
    if (!this.paused) this.tick();
  }

  dispose(): void {
    this.alive = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

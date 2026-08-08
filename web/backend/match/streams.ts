// The three frame SOURCES a watch socket can be attached to, all riding the shared FramePacer:
// MatchStream (a live engine spawn, the only one that accepts shouts), ReplayStream (a stored
// recording, seekable) and EventsReplayStream (a paced re-sim from a persisted command log).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { ROLE_SLOTS } from '../game.ts';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer } from '../plan.ts';
import type { Directive } from '../tactics.ts';
import { FORMATIONS, PITCH_W, normalizeFormation, engineRole } from '../formations.ts';
import { ENGINE, SPEC_DIR } from './runtime.ts';
import { FramePacer, type Proc } from './pacer.ts';
import type { RecKind } from './recordings.ts';
import { type Command, type EventsLog, buildReplaySpec, writeEventsLog } from './events-log.ts';

let watchSpecSeq = 0;   // makes each MatchStream's engine-input spec UNIQUE (see sessionSpecPath) so concurrent watches of one fixture don't share/clobber/delete one file
export class MatchStream extends FramePacer {
  private proc: Proc | null = null;
  private buffer = '';
  // P2: mid-match plan edits become a timeline of {atMs, directives}. Editing at
  // 46' re-sims the match with the new timeline and resumes streaming from 46'
  // (--stream-from) — seamless because frames 0..46' are byte-identical.
  private timeline: { atMs: number; directives: unknown; morale?: { playerId: number; delta: number }[]; layout?: { playerId: number; role: string; homeX: number; homeY: number }[] }[] = [];
  // The same edits as `timeline`, in the durable event-sourcing shape (+ team + the raw shout text).
  // Persisted to the events log on socket close so a shout-driven match can be reviewed/re-simmed
  // (seed + commands → byte-identical) — see SCALE_ARCH.md. Empty for a no-shout watch.
  private commands: Command[] = [];
  // P5: the manager's running composite plan (stateful — each shout edits it) and a
  // per-player motivation-change tally for the cap.
  private plan: Plan = EMPTY_PLAN;
  private motivationUsed = new Map<number, number>();
  private moraleEst = new Map<number, number>();        // cumulative morale points injected per player (LLM context)
  private editLock: Promise<void> = Promise.resolve();  // serialises shouts so the cap/plan/fromMs update without a race
  private fromMs = 0;
  private baseSpec: any;
  private sessionSpecPath: string;
  private myTeam: 'home' | 'away';
  private canShout: boolean;   // only a manager of this fixture may inject tactics (§1.2)
  private kind: RecKind;
  private refId: number;       // fixture/cup id — the events-log key (0 ⇒ don't persist)

  constructor(
    ws: WebSocket, specPath: string, seed: number,
    homeName = 'HOME', awayName = 'AWAY',
    myTeam: 'home' | 'away' = 'home',
    seedPlan?: Plan | null,
    canShout = true,
    kind: RecKind = 'fixture',
    refId = 0,
  ) {
    super(ws, seed, homeName, awayName);
    this.myTeam = myTeam;
    this.canShout = canShout;
    this.kind = kind;
    this.refId = refId;
    this.baseSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    // Seed the running plan from the STANDING plan the engine is ALREADY running — this side's
    // slice of the spec's resolved directives — so the first live shout edits the standing plan
    // (using the same watch-roster ids squads() emits), not an empty one. (No re-resolution: the
    // spec.directives are already correct engine ids, so the seed can't drift from what's running.)
    if (seedPlan) {
      const all: Directive[] = Array.isArray(this.baseSpec.directives) ? this.baseSpec.directives : [];
      const wantScope = myTeam === 'away' ? 1 : 0, lo = myTeam === 'away' ? 11 : 0;
      const mine = all.filter(d => (d.teamScope === 0 || d.teamScope === 1) ? d.teamScope === wantScope : (d.playerId >= lo && d.playerId <= lo + 10));
      if (mine.length || (seedPlan.summary && seedPlan.summary !== EMPTY_PLAN.summary)) this.plan = { summary: seedPlan.summary || EMPTY_PLAN.summary, directives: mine };
    }
    // UNIQUE per instance (not a deterministic fixture-<id>.watch.json): two concurrent watches of the same
    // fixture (home+away managers, a spectator, two tabs) must not share one engine-input file — else one
    // shouter's timeline clobbers the other's, and one viewer's dispose() would delete a file the other still
    // re-reads on --stream-from re-spawn. A unique name makes writeSessionSpec/start/dispose fully instance-local.
    this.sessionSpecPath = specPath.replace(/\.json$/, '') + `.watch.${watchSpecSeq++}.json`;
    this.writeSessionSpec();
    this.start();
    ws.on('message', (d: Buffer) => this.onCommand(d));
    ws.on('close', () => this.dispose());
  }

  private writeSessionSpec(): void {
    writeFileSync(this.sessionSpecPath, JSON.stringify({ ...this.baseSpec, timeline: this.timeline }));
  }

  private start(): void {
    this.stopProc();
    this.prevClock = null; this.pending = []; this.buffer = '';
    const args = ['--match', this.sessionSpecPath, '--no-debug'];
    if (this.fromMs > 0) args.push('--stream-from', String(this.fromMs));
    const child = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
    this.proc = child;
    child.stdout.on('data', (data: Buffer) => {
      if (this.proc !== child || !this.alive) return;
      this.buffer += data.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';
      for (const l of lines) if (l.length) this.pending.push(l);
      // HIGH-WATER backpressure: pausing after EVERY chunk made each refill a full resume→chunk
      // round-trip, starving fast-forward (~5 frames per tick at 8×). Let the pipe flow until the
      // queue is genuinely ahead (bounded: ~256 frames ≈ a few hundred KB + one chunk).
      if (this.pending.length > 256) child.stdout.pause();
      this.tick();
    });
    child.stderr.on('data', () => { /* swallow */ });
    child.on('close', () => { if (this.proc === child) this.tick(); });
  }

  // Live source: the engine streamed faster than we paced, so the queue drained — let it flow on.
  protected refill(): void { this.proc?.stdout.resume(); }

  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown; text?: string };
      if (cmd.type === 'restart') { this.paused = false; this.start(); }
      else if (cmd.type === 'pause') this.togglePause();
      else if (cmd.type === 'resume') { if (this.paused) this.togglePause(); }   // live-mode clients send distinct pause/resume
      else if (cmd.type === 'speed' && typeof cmd.value === 'number') this.setSpeed(cmd.value);
      else if (cmd.type === 'tactics' && this.canShout) {
        // Edit the plan mid-match (text -> plan + motivation; the compile calls the LLM).
        // Serialised: each shout waits for the prior edit to finish so the cap, plan and fromMs
        // advance in arrival order, never racing or rewinding. Gated to the team's manager (§1.2) —
        // a spectator/unauth socket can watch but not inject tactics (nor burn LLM quota).
        this.editLock = this.editLock.then(() => this.applyTacticsEdit(cmd)).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }

  // Build my squad (with personalities for motivation) + the opponent, by engine id
  // (= spec order). Personalities ride on the spec via specForTeam.
  private squads(): { mine: SquadPlayer[]; opp: { id: number; name: string; role: string }[] } {
    const make = (players: any[] | undefined, off: number) =>
      (players ?? []).slice(0, 11).map((p: any, i: number) => ({ id: off + i, name: p.name as string, role: (p.role as string) ?? ROLE_SLOTS[i], personality: p.personality ?? null }));
    const home = make(this.baseSpec.home?.players, 0);
    const away = make(this.baseSpec.away?.players, 11);
    const mineArr = this.myTeam === 'home' ? home : away;
    const oppArr = this.myTeam === 'home' ? away : home;
    const mine: SquadPlayer[] = mineArr.map(p => ({ id: p.id, name: p.name, role: p.role, personality: p.personality, morale: Math.max(0, Math.min(100, 50 + (this.moraleEst.get(p.id) ?? 0))), motivationUsed: this.motivationUsed.get(p.id) ?? 0 }));
    const opp = oppArr.map(p => ({ id: p.id, name: p.name, role: p.role }));
    return { mine, opp };
  }

  // Mid-match shout: EDIT the running composite plan (and judge its motivational
  // effect via personality), send a receipt, freeze the new plan + morale on the
  // timeline at the watched clock, re-sim, and resume there.
  private async applyTacticsEdit(cmd: { text?: string }): Promise<void> {
    if (typeof cmd.text !== 'string' || !cmd.text.trim()) return;
    const { mine, opp } = this.squads();
    const t = this.latest?.clockMs ?? 0;
    const ctx = { minute: Math.floor(t / 60000), score: this.latest ? `${this.latest.homeScore ?? 0}-${this.latest.awayScore ?? 0}` : undefined };
    const r = await compilePlanEdit(this.plan, cmd.text, mine, opp, this.myTeam, ctx);
    // Resolve the formation: trust the model's "formation", else scan the raw text
    // for a clear shape token ("go 4-3-3", "4 4 2", "4-1-2-1-2") so the common case
    // works even when the model misses it or is unreachable.
    let fk = (r.formation && FORMATIONS[r.formation]) ? r.formation : null;
    if (!fk) { const m = cmd.text.match(/\b\d\s*[-\s]\s*\d\s*[-\s]\s*\d(?:\s*[-\s]\s*\d)?(?:\s*[-\s]\s*\d)?\b/); if (m) fk = normalizeFormation(m[0]); }
    console.log(`[plan] "${cmd.text}" -> ${r.error ? `ERROR ${r.error}` : `${r.plan.directives.length} dir, ${r.motivation.length} mot${fk ? ', shape '+fk : ''} | ${r.changed}`}`);
    // A formation shout with an unreachable model still applies the shape (the text
    // scan caught it); only bail if it errored AND no shape was detected.
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ tacticsReceipt: { text: cmd.text, plan: r.plan, changed: r.changed, motivation: r.motivation, formation: fk, directives: r.plan.directives, error: (r.error && !fk) ? r.error : null, note: r.note ?? null } }));
    }
    if ((r.error && !fk) || !this.alive) return;
    this.plan = r.plan;
    // morale delta (points) -> moraleBoost delta (/50); tally the per-player cap.
    const morale = r.motivation.map(m => {
      this.motivationUsed.set(m.playerId, (this.motivationUsed.get(m.playerId) ?? 0) + 1);
      this.moraleEst.set(m.playerId, (this.moraleEst.get(m.playerId) ?? 0) + m.moraleDelta);
      return { playerId: m.playerId, delta: m.moraleDelta / 50 };
    });
    // A formation shout re-shapes MY team for the rest of this match: each slot's new
    // role + anchor (away side mirrored), GK left alone. The engine re-anchors/re-roles
    // on the timeline. This match only — the squad screen owns the persistent formation.
    let layout: { playerId: number; role: string; homeX: number; homeY: number }[] | undefined;
    if (fk && FORMATIONS[fk]) {
      const off = this.myTeam === 'home' ? 0 : 11;
      layout = FORMATIONS[fk].map((slot, i) => ({
        playerId: off + i, role: engineRole(slot.role),
        homeX: this.myTeam === 'away' ? PITCH_W - slot.x : slot.x, homeY: slot.y,
      })).filter((_, i) => i > 0);
    }
    this.commitEdit(r.plan.directives, morale, layout, cmd.text);
  }

  private commitEdit(directives: unknown, morale: { playerId: number; delta: number }[], layout?: { playerId: number; role: string; homeX: number; homeY: number }[], text?: string): void {
    const t = this.latest?.clockMs ?? 0;
    this.timeline.push({ atMs: t, directives, morale, layout });
    this.commands.push({ atMs: t, team: this.myTeam === 'home' ? 0 : 1, directives, morale, layout, text: text || undefined });
    this.writeSessionSpec();
    // Durably flush the command log on EVERY committed edit, not only on socket close
    // (GAP 2): dispose()'s persistTactics() misses a mid-match backend crash/restart,
    // which would silently lose every shout so far — no re-sim, no shout review. This
    // is idempotent (overwrites with the growing log) and best-effort; shouts are rare
    // enough that rewriting the small log each time is free. A no-shout watch never
    // reaches here, so its spec stays byte-identical.
    this.persistTactics();
    this.fromMs = Math.max(this.fromMs, t);   // monotonic — never rewind already-streamed frames
    this.paused = false;
    this.start();
  }

  private stopProc(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }

  override dispose(): void {
    super.dispose();
    this.stopProc();
    this.persistTactics();
    // Remove this instance's unique engine-input spec (only needed while its engine runs). Safe because the
    // name is per-instance (see sessionSpecPath) — no concurrent viewer shares it. Mirrors EventsReplayStream.dispose().
    try { if (existsSync(this.sessionSpecPath)) rmSync(this.sessionSpecPath, { force: true }); } catch { /* best effort */ }
  }

  // On socket close, persist the shout command log as the durable event-sourcing artifact
  // (seed + commands + final score + self-contained spec) so the shout-driven match can be
  // reviewed and re-simmed. Best-effort + only when shouts actually happened — a plain watch
  // (no shouts) leaves no log, so it never clobbers a prior shout-driven session's record.
  private persistTactics(): void {
    if (!this.commands.length || !this.refId) return;
    try {
      writeEventsLog(this.kind, this.refId, {
        seed: this.seed,
        duration: this.latest?.clockMs ?? 0,
        scores: { home: this.latest?.homeScore ?? 0, away: this.latest?.awayScore ?? 0 },
        spec: this.baseSpec,
        commands: this.commands,
      });
    } catch { /* best-effort — a watch must never fail because persistence did */ }
  }
}

// Replay a stored recording through the same pacer — no engine spawn, no re-sim drift. A
// recording is finished + immutable, so playback supports random-access seek/rewind (re-fill the
// queue from a different clock) but no shouts; the client hides the tactics box on a replay.
export class ReplayStream extends FramePacer {
  private frames: string[];
  // clockMs per line, extracted ONCE with a cheap regex at construction. seekTo() used to JSON.parse EVERY
  // line on EVERY seek — on a ~20k-frame recording (~30MB of JSON) that was ~2-3s PER seek/scrub/−10s (the
  // user's "rewind/−10s laggy"). A numeric pre-index makes a seek O(n) compares (~ms). null = no clockMs (a
  // non-frame/metadata line) → always kept, matching the "a seek must preserve non-frame lines" intent.
  private frameClocks: (number | null)[];
  // Takes the already-loaded frames (loaded once by the caller) — so /ws/match can verify the
  // recording actually has frames before choosing replay over the live re-sim, never leaving a
  // viewer staring at a blank pitch because a row outlived its file.
  constructor(ws: WebSocket, frames: string[], seed: number, homeName: string, awayName: string) {
    super(ws, seed, homeName, awayName);
    this.replay = true;
    this.frames = frames;
    this.frameClocks = frames.map(l => { const m = l.match(/"clockMs":(-?\d+(?:\.\d+)?)/); return m ? +m[1] : null; });
    // the recording's real length — the client sizes its scrub slider to this instead of a fixed 96'
    this.durationMs = this.frameClocks.reduce<number>((mx, c) => (c !== null && c > mx ? c : mx), 0);
    ws.on('message', (d: Buffer) => this.onCommand(d));
    ws.on('close', () => this.dispose());
    this.seekTo(0);
  }

  // Load every frame at/after `fromMs` into the queue and (re)start pacing from there. Uses the pre-indexed
  // frameClocks (no per-seek JSON.parse) so a seek is instant.
  private seekTo(fromMs: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.prevClock = null;
    this.pending = fromMs <= 0 ? this.frames.slice()
      : this.frames.filter((_l, i) => { const c = this.frameClocks[i]; return c === null || c >= fromMs; });   // keep non-frame/event lines (captureLineStream + loadRecording preserve them; a seek must too)
    // Seeking past the end (the client scrub max is a generous fixed 96', most matches end ~94') filters to
    // an empty queue → refill() is a no-op → the pitch/scrub would freeze with no feedback. Re-send the final
    // frame so the last state (the real full-time) is (re)shown at the end of the track instead of stranding it.
    if (this.pending.length === 0 && this.frames.length) this.pending = this.frames.slice(-1);
    this.paused = false;
    this.tick();
  }

  protected refill(): void { /* recording exhausted — playback is complete, leave the final frame up */ }

  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown };
      if (cmd.type === 'pause') this.togglePause();
      // a client in LIVE mode sends distinct pause/resume — honour resume (a finished live match's URL
      // still says ?live=1 but routes HERE once recorded; ignoring 'resume' left its pause button dead/inverted)
      else if (cmd.type === 'resume') { if (this.paused) this.togglePause(); }
      else if (cmd.type === 'speed' && typeof cmd.value === 'number') this.setSpeed(cmd.value);
      else if (cmd.type === 'restart') this.seekTo(0);
      else if (cmd.type === 'seek' && typeof cmd.value === 'number') this.seekTo(Math.max(0, cmd.value));
    } catch { /* ignore */ }
  }
}

let replaySeq = 0;
// "▶ Replay from your shouts": stream a shout-driven match's re-sim from its persisted command log,
// PACED like a live watch (no upfront wait). Spawns the engine on the self-contained events-log spec
// (buildReplaySpec) and relays frames through the FramePacer's backpressure — pausing/resuming the
// engine's stdout as the play queue drains — so the user watches it unfold instead of waiting ~8 min
// for the emit-bound flat-out batch (replayViaTimeline). Immutable: pause/speed/restart, no tactics.
// NOTE: frames are NOT tagged replay:true. This re-sim has no BACKEND random-access seek (it's a live
// engine spawn), so it rides the SAME client-side buffer + rewind path a live watch uses — the scrub /
// ⏪ / ⏮ / 🎞 controls then actually work (a rewind window into the buffered frames), instead of showing
// dead backend-seek controls. The shout box stays hidden via the client's `live` flag, not this one.
export class EventsReplayStream extends FramePacer {
  private proc: Proc | null = null;
  private buffer = '';
  private specFile: string;
  constructor(ws: WebSocket, log: EventsLog, seed: number, homeName: string, awayName: string) {
    super(ws, seed, homeName, awayName);
    this.replay = false;
    this.specFile = path.join(SPEC_DIR, `replay-shouts-${replaySeq++}.json`);
    writeFileSync(this.specFile, JSON.stringify(buildReplaySpec(log)));
    this.start();
    ws.on('message', (d: Buffer) => this.onCommand(d));
    ws.on('close', () => this.dispose());
  }
  private start(): void {
    this.stopProc();
    this.prevClock = null; this.pending = []; this.buffer = '';
    const child = spawn(ENGINE, ['--match', this.specFile, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
    this.proc = child;
    child.stdout.on('data', (data: Buffer) => {
      if (this.proc !== child || !this.alive) return;
      this.buffer += data.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';
      for (const l of lines) if (l.length) this.pending.push(l);
      // HIGH-WATER backpressure (see MatchStream): pause only when genuinely ahead, so fast-forward
      // isn't starved by a resume→chunk round-trip per refill. Bounded ~256 frames + one chunk.
      if (this.pending.length > 256) child.stdout.pause();
      this.tick();
    });
    child.stderr.on('data', () => { /* swallow */ });
    child.on('close', () => {
      if (this.proc !== child) return;
      this.tick();
      // engine produced nothing (crash / bad log) — don't leave the viewer on "Connecting…" forever
      if (!this.latest && this.alive && this.ws.readyState === 1) {
        try { this.ws.send(JSON.stringify({ error: "Couldn't re-sim this match from its shouts." })); } catch { /* gone */ }
      }
    });
  }
  protected refill(): void { this.proc?.stdout.resume(); }
  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown };
      if (cmd.type === 'restart') { this.paused = false; this.start(); }
      else if (cmd.type === 'pause') this.togglePause();
      else if (cmd.type === 'resume') { if (this.paused) this.togglePause(); }   // live-mode clients send distinct pause/resume
      else if (cmd.type === 'speed' && typeof cmd.value === 'number') this.setSpeed(cmd.value);
      // no 'tactics' — a replay is immutable
    } catch { /* ignore */ }
  }
  private stopProc(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }
  override dispose(): void {
    super.dispose();
    this.stopProc();
    try { if (existsSync(this.specFile)) rmSync(this.specFile, { force: true }); } catch { /* best effort */ }
  }
}

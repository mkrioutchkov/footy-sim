// Shared live match-coordinator (docs/LIVE_MATCH_ARCHITECTURE.md §2 + §4).
//
// One RESIDENT engine per fixture, driven in real wall-clock by stdin-injected commands
// (the §1.2 protocol), fanned out to every subscriber (two managers + spectators). This
// replaces the per-connection MatchStream + kill-respawn shout path FOR LIVE matches.
// Non-live spectating/replay (MatchStream re-sim, ReplayStream) is untouched and stays
// byte-identical — the live path is opt-in (index.ts `?live=1`).
//
// BUILD-AHEAD NOTE: Boris's engine Phase 1 (FOOTY_LIVE resident self-pacing + the stdin
// reader + applyLiveCommands + step()) is NOT built yet (confirmed 2026-06-18). This module
// is written to the PAPER protocol so it drops on the moment Phase 1 lands; until then the
// live path can't actually run against a real engine. Everything here is structured so the
// logic is unit-tested with an INJECTED fake engine (EngineFactory), and so the only thing
// that changes when the engine ships is that the real spawn starts honouring the commands.
//
// Protocol assumptions handed to Boris (see .scratch/traces/GAYLORD_LIVE_COORDINATOR.md):
//  - inject/morale/layout shapes MIRROR the existing directive-timeline entry (engine_defense
//    .cpp:37-57) so applyLiveCommands and the timeline path are provably identical; we add the
//    §1.2 `team` field (0=home,1=away) so the engine replaces the active set PER TEAM.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { WebSocket } from 'ws';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer, type Motivation } from './plan.ts';
import { FORMATIONS, normalizeFormation, engineRole, PITCH_W } from './formations.ts';
import { ROLE_SLOTS } from './game.ts';
import {
  type RecKind, type Command, captureLineStream, writeEventsLog, hasHumanStake,
} from './match.ts';

const ENGINE = path.resolve(process.cwd(), 'build', 'live.exe');
export type Side = 'home' | 'away';
export type Seat = Side | 'spectator';

// ── Engine transport ─────────────────────────────────────────────────────────
// Injectable so (a) the coordinator logic is testable without spawning live.exe, and (b) a
// future "many games per thread" scheduler can drive engines via the same interface (doc §1.4)
// instead of one OS process per match.
export interface EngineProc {
  writeCommand(line: string): void;        // a single \n-delimited JSON control line -> engine stdin
  onFrame(cb: (frame: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}
export type EngineFactory = (specPath: string) => EngineProc;

// The real transport: spawn live.exe in resident live mode (FOOTY_LIVE=1) with stdin OPEN.
const realEngine: EngineFactory = (specPath) => {
  const child = spawn(ENGINE, ['--match', specPath, '--no-debug'], {
    env: { ...process.env, FOOTY_LIVE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],       // stdin PIPED (vs 'ignore' on the non-live path)
  });
  let buf = '';
  let frameCb: (f: string) => void = () => {};
  let exitCb: () => void = () => {};
  let exited = false;
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/); buf = lines.pop() ?? '';
    for (const l of lines) if (l.length) frameCb(l);
  });
  // Surface the engine's `[live]` command acks (speed/pause/resume/inject) — the live path is real
  // now, so these are the observability for stdin injection; other engine stderr stays swallowed.
  let errBuf = '';
  child.stderr.on('data', (d: Buffer) => {
    errBuf += d.toString();
    const lines = errBuf.split(/\r?\n/); errBuf = lines.pop() ?? '';
    for (const l of lines) if (l.startsWith('[live]')) console.log(`[coordinator] engine ${l}`);
  });
  const fireExit = (): void => { if (!exited) { exited = true; exitCb(); } };
  child.on('close', fireExit);
  child.on('error', fireExit);
  return {
    writeCommand: (line) => { try { child.stdin.write(line + '\n'); } catch { /* engine gone */ } },
    onFrame: (cb) => { frameCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { try { child.kill(); } catch { /* gone */ } },
  };
};

interface Subscriber { ws: WebSocket; seat: Seat }

interface CreateOpts {
  specPath: string; seed: number; homeName: string; awayName: string;
  homeTeamId: number; awayTeamId: number;          // to map an AI club's teamId -> side (applyAIShout)
  kind: RecKind; refId: number; record: boolean;
  seedPlans?: Partial<Record<Side, Plan | null>>;
}

// ── LiveMatch: the shared per-fixture coordinator ─────────────────────────────
export class LiveMatch {
  private proc: EngineProc;
  private subs = new Set<Subscriber>();
  private latest: Record<string, unknown> | null = null;
  private speed = 1;
  private paused = false;
  private finished = false;
  private disposed = false;
  // Per-fixture serialization: every shout (human or AI, either side) chains here so the
  // canonical command log + per-side plans advance in arrival order — never racing, never an
  // out-of-order atMs.
  private editLock: Promise<void> = Promise.resolve();
  private lastInjectedMs = -1;
  // Two-sided running state (each side edits its OWN composite plan; a manager can only touch
  // their own side — see routing in onCommand).
  private plans: Record<Side, Plan> = { home: EMPTY_PLAN, away: EMPTY_PLAN };
  private motivationUsed: Record<Side, Map<number, number>> = { home: new Map(), away: new Map() };
  private moraleEst: Record<Side, Map<number, number>> = { home: new Map(), away: new Map() };
  private commands: Command[] = [];                 // event-sourcing log (§4)
  private baseSpec: { home?: { players?: unknown[] }; away?: { players?: unknown[] }; directives?: Command['directives'] };
  private capture: PassThrough | null = null;        // tee of frames -> recording (format 2)
  private readonly key: string;
  private readonly seed: number;
  private readonly homeName: string;
  private readonly awayName: string;
  private readonly homeTeamId: number;
  private readonly awayTeamId: number;
  private readonly onGone: (key: string) => void;

  constructor(key: string, o: CreateOpts, onGone: (key: string) => void, makeEngine: EngineFactory = realEngine) {
    this.key = key; this.seed = o.seed; this.homeName = o.homeName; this.awayName = o.awayName;
    this.homeTeamId = o.homeTeamId; this.awayTeamId = o.awayTeamId; this.onGone = onGone;
    this.baseSpec = JSON.parse(readFileSync(o.specPath, 'utf8'));
    this.seedPlan('home', o.seedPlans?.home);
    this.seedPlan('away', o.seedPlans?.away);
    // Record live human-stake matches as format 2 (frames + the command log) by teeing each
    // frame into the proven capture path while we broadcast it.
    if (o.record) {
      this.capture = new PassThrough();
      captureLineStream(o.kind, o.refId, this.capture, 2)
        .then(({ homeScore, awayScore }) => writeEventsLog(o.kind, o.refId, {
          seed: o.seed, duration: Number(this.latest?.clockMs ?? 0),
          scores: { home: homeScore, away: awayScore },
          spec: this.baseSpec as Record<string, unknown>, commands: this.commands,
        }))
        .catch(() => { /* incomplete capture (crash/kill) — no recording, same as the AI path */ });
    }
    this.proc = makeEngine(o.specPath);
    this.proc.onFrame(f => this.onFrame(f));
    this.proc.onExit(() => this.onEngineExit());
  }

  // Seed a side's running plan from its STANDING plan (this side's slice of the spec directives)
  // so the first live shout edits the standing plan, mirroring MatchStream's seeding.
  private seedPlan(side: Side, plan?: Plan | null): void {
    if (!plan) return;
    const all = Array.isArray(this.baseSpec.directives) ? this.baseSpec.directives as Array<Record<string, unknown>> : [];
    const wantScope = side === 'away' ? 1 : 0, lo = side === 'away' ? 11 : 0;
    const mine = all.filter(d => (d.teamScope === 0 || d.teamScope === 1)
      ? d.teamScope === wantScope
      : (typeof d.playerId === 'number' && d.playerId >= lo && d.playerId <= lo + 10)) as unknown as Plan['directives'];
    if (mine.length || (plan.summary && plan.summary !== EMPTY_PLAN.summary)) {
      this.plans[side] = { summary: plan.summary || EMPTY_PLAN.summary, directives: mine };
    }
  }

  // ── subscription / fan-out ──────────────────────────────────────────────────
  subscribe(ws: WebSocket, seat: Seat): void {
    const sub: Subscriber = { ws, seat };
    this.subs.add(sub);
    ws.on('message', (d: Buffer) => this.onCommand(sub, d));
    ws.on('close', () => this.unsubscribe(sub));
    if (this.latest) this.sendOne(sub, this.latest);   // catch a re-/late-joiner up to the live frame
  }

  private unsubscribe(sub: Subscriber): void {
    this.subs.delete(sub);
    if (this.subs.size === 0) this.dispose();           // engine stays alive only while someone watches
  }

  private onFrame(frame: string): void {
    let state: Record<string, unknown>; try { state = JSON.parse(frame); } catch { return; }
    this.latest = state;
    const cap = this.capture;   // snapshot — dispose/onEngineExit may null it between check and write
    if (cap) { try { cap.write(frame + '\n'); } catch { /* sink closed */ } }
    for (const sub of this.subs) this.sendOne(sub, state);
  }

  private sendOne(sub: Subscriber, state: Record<string, unknown>): void {
    if (sub.ws.readyState !== 1) return;
    sub.ws.send(JSON.stringify({
      ...state, seed: this.seed, speed: this.speed, homeName: this.homeName, awayName: this.awayName,
      live: true, replay: false, matchState: this.paused ? 'paused' : state.matchState,
    }));
  }

  // ── command routing (per-team isolation) ─────────────────────────────────────
  private onCommand(sub: Subscriber, d: Buffer): void {
    // ISOLATION: spectators only watch — they can't shout AND can't touch the shared live clock
    // (speed/pause are match-global; a spectator must not be able to freeze a live contest for the
    // two managers). A manager can only ever affect their OWN side (the side is `sub.seat`).
    if (sub.seat !== 'home' && sub.seat !== 'away') return;
    let cmd: { type?: string; value?: unknown; text?: string };
    try { cmd = JSON.parse(d.toString()); } catch { return; }
    if (cmd.type === 'speed' && typeof cmd.value === 'number') { this.setSpeed(cmd.value); return; }
    if (cmd.type === 'pause') { this.setPaused(true); return; }
    if (cmd.type === 'resume') { this.setPaused(false); return; }
    if (cmd.type === 'tactics' && typeof cmd.text === 'string') {
      const side = sub.seat;                              // narrowed to 'home' | 'away'
      this.editLock = this.editLock.then(() => this.applyShout(side, cmd.text as string, sub.ws)).catch(() => { /* ignore */ });
    }
  }

  // ── shouts → inject (no kill-respawn) ─────────────────────────────────────────
  private squadsFor(side: Side): { mine: SquadPlayer[]; opp: { id: number; name: string; role: string }[] } {
    const make = (players: unknown[] | undefined, off: number) =>
      (players ?? []).slice(0, 11).map((p: unknown, i: number) => {
        const pl = p as { name?: string; role?: string; personality?: unknown };
        return { id: off + i, name: pl.name ?? `P${off + i}`, role: pl.role ?? ROLE_SLOTS[i], personality: pl.personality ?? null };
      });
    const home = make(this.baseSpec.home?.players, 0);
    const away = make(this.baseSpec.away?.players, 11);
    const mineArr = side === 'home' ? home : away;
    const oppArr = side === 'home' ? away : home;
    const mine: SquadPlayer[] = mineArr.map(p => ({
      id: p.id, name: p.name, role: p.role, personality: p.personality as SquadPlayer['personality'],
      morale: Math.max(0, Math.min(100, 50 + (this.moraleEst[side].get(p.id) ?? 0))),
      motivationUsed: this.motivationUsed[side].get(p.id) ?? 0,
    }));
    const opp = oppArr.map(p => ({ id: p.id, name: p.name, role: p.role }));
    return { mine, opp };
  }

  // Compile a side's shout into a plan edit + morale, send the receipt to the shouter, then
  // inject it onto the live tick. Serialised by editLock (caller). Returns when injected.
  private async applyShout(side: Side, text: string, ws?: WebSocket): Promise<void> {
    if (!text.trim() || this.disposed || this.finished) return;
    const { mine, opp } = this.squadsFor(side);
    const t = Number(this.latest?.clockMs ?? 0);
    const ctx = { minute: Math.floor(t / 60000), score: this.latest ? `${this.latest.homeScore ?? 0}-${this.latest.awayScore ?? 0}` : undefined };
    const r = await compilePlanEdit(this.plans[side], text, mine, opp, side, ctx);
    let fk = (r.formation && FORMATIONS[r.formation]) ? r.formation : null;
    if (!fk) { const m = text.match(/\b\d\s*[-\s]\s*\d\s*[-\s]\s*\d(?:\s*[-\s]\s*\d)?(?:\s*[-\s]\s*\d)?\b/); if (m) fk = normalizeFormation(m[0]); }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ tacticsReceipt: { text, plan: r.plan, changed: r.changed, motivation: r.motivation, formation: fk, directives: r.plan.directives, error: (r.error && !fk) ? r.error : null, note: r.note ?? null } }));
    }
    if ((r.error && !fk) || this.disposed || this.finished) return;
    this.plans[side] = r.plan;
    const morale = this.tallyMorale(side, r.motivation);
    const layout = fk ? this.layoutFor(side, fk) : undefined;
    this.inject(side, r.plan.directives, morale, layout);
  }

  // Public seam for manager_ai v2 (docs §3): an AI club's pre-compiled shout rides the SAME
  // editLock/inject path a human uses. `compiled` is a compilePlanEdit() result; teamId picks
  // the side (caller guarantees it's an AI club, user_id IS NULL). A teamId not in this fixture
  // is a no-op.
  applyAIShout(teamId: number, compiled: { plan: Plan; motivation?: Motivation[]; formation?: string | null }): Promise<void> {
    const side: Side | null = teamId === this.homeTeamId ? 'home' : teamId === this.awayTeamId ? 'away' : null;
    this.editLock = this.editLock.then(() => {
      if (side === null || this.disposed || this.finished) return;
      this.plans[side] = compiled.plan;
      const morale = this.tallyMorale(side, compiled.motivation ?? []);
      const fk = (compiled.formation && FORMATIONS[compiled.formation]) ? compiled.formation : null;
      const layout = fk ? this.layoutFor(side, fk) : undefined;
      this.inject(side, compiled.plan.directives, morale, layout);
    }).catch(() => { /* ignore */ });
    return this.editLock;
  }

  // morale points -> moraleBoost delta (/50), tallying the per-player cap (mirrors MatchStream).
  private tallyMorale(side: Side, motivation: Motivation[]): { playerId: number; delta: number }[] {
    return motivation.map(m => {
      this.motivationUsed[side].set(m.playerId, (this.motivationUsed[side].get(m.playerId) ?? 0) + 1);
      this.moraleEst[side].set(m.playerId, (this.moraleEst[side].get(m.playerId) ?? 0) + m.moraleDelta);
      return { playerId: m.playerId, delta: m.moraleDelta / 50 };
    });
  }

  // A formation shout re-anchors this side (mirrored x for away); GK (slot 0) left alone.
  private layoutFor(side: Side, fk: string): { playerId: number; role: string; homeX: number; homeY: number }[] {
    const off = side === 'home' ? 0 : 11;
    return FORMATIONS[fk].map((slot, i) => ({
      playerId: off + i, role: engineRole(slot.role),
      homeX: side === 'away' ? PITCH_W - slot.x : slot.x, homeY: slot.y,
    })).filter((_, i) => i > 0);
  }

  // Stamp the command at the current live clock, append to the canonical log, and write the
  // §1.2 inject line to the engine. Monotonic: the coordinator's editLock guarantees arrival
  // order, and we clamp atMs forward so the engine never sees a backwards stamp.
  private inject(side: Side, directives: Command['directives'], morale: { playerId: number; delta: number }[], layout?: Command['layout']): void {
    const atMs = Math.max(this.lastInjectedMs + 1, Number(this.latest?.clockMs ?? 0));
    this.lastInjectedMs = atMs;
    const team: 0 | 1 = side === 'home' ? 0 : 1;
    const command: Command = { atMs, team, directives, morale, layout };
    this.commands.push(command);
    this.proc.writeCommand(JSON.stringify({ type: 'inject', ...command }));
  }

  // ── shared speed / pause (match-global, broadcast) ────────────────────────────
  private setSpeed(v: number): void {
    this.speed = Math.max(0.25, Math.min(60, v));
    this.proc.writeCommand(JSON.stringify({ type: 'speed', value: this.speed }));
    if (this.latest) for (const sub of this.subs) this.sendOne(sub, this.latest);   // refresh the speed badge
  }
  private setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    this.proc.writeCommand(JSON.stringify({ type: p ? 'pause' : 'resume' }));
    if (this.latest) for (const sub of this.subs) this.sendOne(sub, this.latest);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  private onEngineExit(): void {
    if (this.finished || this.disposed) return;   // idempotent: full-time + a later dispose can't double-fire
    this.finished = true;
    if (this.capture) { try { this.capture.end(); } catch { /* already ended */ } this.capture = null; }
    // The match is over: a fresh connection will now find the recording and replay it, so drop
    // the live instance from the registry. Existing sockets keep the final frame until they leave.
    this.onGone(this.key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.capture) { try { this.capture.destroy(); } catch { /* gone */ } this.capture = null; }
    this.proc.kill();
    this.onGone(this.key);
  }

  // test/diagnostic accessors
  get commandLog(): readonly Command[] { return this.commands; }
  get subscriberCount(): number { return this.subs.size; }
}

// ── registry: one LiveMatch per fixture key ─────────────────────────────────────
const activeMatches = new Map<string, LiveMatch>();
export const liveKey = (kind: RecKind, refId: number): string => `${kind}-${refId}`;

// First connection for a key creates the resident engine; the rest attach to it. `create` is
// only consulted on creation (ignored when the match already exists). makeEngine is for tests.
export function joinLiveMatch(
  key: string, ws: WebSocket, seat: Seat, create: CreateOpts, makeEngine?: EngineFactory,
): LiveMatch {
  let m = activeMatches.get(key);
  if (!m) {
    m = new LiveMatch(key, create, k => { activeMatches.delete(k); }, makeEngine);
    activeMatches.set(key, m);
  }
  m.subscribe(ws, seat);
  return m;
}

export function liveMatchFor(key: string): LiveMatch | undefined { return activeMatches.get(key); }
export { hasHumanStake };

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { db } from './db.ts';
import { getTeamWithPlayers, ROLE_SLOTS } from './game.ts';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer } from './plan.ts';
import { FORMATIONS, DEFAULT_FORMATION, PITCH_W, normalizeFormation } from './formations.ts';

const ENGINE = path.resolve(process.cwd(), 'build', 'live.exe');
const SPEC_DIR = path.resolve(process.cwd(), 'web', 'backend', 'data', 'specs');
mkdirSync(SPEC_DIR, { recursive: true });
const MINUTES = Number.parseInt(process.env.FOOTY_MINUTES ?? '90', 10);

interface Fixture {
  id: number; league_id: number; home_team_id: number; away_team_id: number;
  seed: number; played: number; home_score: number | null; away_score: number | null;
}

export function getFixture(id: number): Fixture | null {
  return (db.prepare('SELECT * FROM fixtures WHERE id = ?').get(id) as Fixture | undefined) ?? null;
}

const isIdentityXI = (lineup: number[] | null): boolean =>
  !lineup || lineup.every((v, i) => v === i);

function specForTeam(teamId: number, side: 'home' | 'away') {
  const t = getTeamWithPlayers(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  const bySlot = t.players.slice().sort((a, b) => a.slot - b.slot);
  const formation = t.formation ?? DEFAULT_FORMATION;
  const layout = FORMATIONS[formation];
  // Byte-identical guard: a team on the default shape with the identity XI emits the
  // exact pre-formation spec (no role/anchor fields) — so every existing team plays
  // precisely as before. Only an opted-in team (non-default formation OR a reordered
  // XI) gets an explicit per-slot layout.
  if ((formation === DEFAULT_FORMATION && isIdentityXI(t.lineup)) || !layout) {
    // personality rides along (engine ignores it) so the watch flow can read each
    // player's personality by engine id without re-deriving the lineup order.
    return { name: t.name, tactics: t.tactics, players: bySlot.map(p => ({ name: p.name, attrs: p.attrs, personality: p.personality ?? null })) };
  }
  // Emit per-slot role + home anchor. The away side mirrors x (PITCH_W - x) to match
  // the engine's away frame; width (y) is shared. Slot 0 stays the keeper (the engine
  // pins it regardless). lineup[i] = which squad slot fills formation slot i.
  const lineup = t.lineup ?? bySlot.map((_, i) => i);
  const players = layout.map((slot, i) => {
    const idx = lineup[i];
    const p = bySlot[(Number.isInteger(idx) && idx >= 0 && idx < bySlot.length) ? idx : i] ?? bySlot[i];
    return {
      name: p.name, attrs: p.attrs, role: slot.role, personality: p.personality ?? null,
      homeX: side === 'away' ? PITCH_W - slot.x : slot.x,
      homeY: slot.y,
    };
  });
  return { name: t.name, tactics: t.tactics, players };
}

export function buildSpec(fixture: Fixture) {
  return {
    seed: fixture.seed,
    minutes: MINUTES,
    home: specForTeam(fixture.home_team_id, 'home'),
    away: specForTeam(fixture.away_team_id, 'away'),
  };
}

export function writeSpec(fixture: Fixture): string {
  const spec = buildSpec(fixture);
  const file = path.join(SPEC_DIR, `fixture-${fixture.id}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

export interface PlayResult { fixtureId: number; homeScore: number; awayScore: number; alreadyPlayed: boolean; }

// Run a fixture through the engine (deterministic via the stored seed) and
// persist the score. Idempotent: a played fixture returns its stored result.
// ASYNC (spawn, not spawnSync) so a ~1-2s (slower under load) match sim never
// blocks the Node event loop — that froze the watch socket and serialised a
// whole matchday. A round's fixtures can now sim concurrently (Promise.all).
export function playFixture(fixtureId: number): Promise<PlayResult> {
  const fx = getFixture(fixtureId);
  if (!fx) return Promise.reject(new Error('fixture not found'));
  if (fx.played) {
    return Promise.resolve({ fixtureId, homeScore: fx.home_score ?? 0, awayScore: fx.away_score ?? 0, alreadyPlayed: true });
  }
  const file = writeSpec(fx);
  return new Promise<PlayResult>((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', file, '--summary', '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    const to = setTimeout(() => { child.kill(); reject(new Error('engine timeout')); }, 120000);
    child.on('error', e => { clearTimeout(to); reject(e); });
    child.on('close', () => {
      clearTimeout(to);
      try {
        const lines = out.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
        const summary = JSON.parse(lines[lines.length - 1]);
        const homeScore = summary.homeScore ?? 0;
        const awayScore = summary.awayScore ?? 0;
        db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?')
          .run(homeScore, awayScore, fixtureId);
        resolve({ fixtureId, homeScore, awayScore, alreadyPlayed: false });
      } catch (e) { reject(new Error(`engine parse failed: ${err || String(e)}`)); }
    });
  });
}

// ── Live watch: spawn the engine for a fixture and pace frames to one client ──
const DEFAULT_FRAME_MS = 1000 / 30;
type Proc = ChildProcessByStdio<null, Readable, Readable>;

export class MatchStream {
  private proc: Proc | null = null;
  private buffer = '';
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private prevClock: number | null = null;
  private speed = 1;
  private paused = false;
  private latest: any = null;
  private alive = true;
  // P2: mid-match plan edits become a timeline of {atMs, directives}. Editing at
  // 46' re-sims the match with the new timeline and resumes streaming from 46'
  // (--stream-from) — seamless because frames 0..46' are byte-identical.
  private timeline: { atMs: number; directives: unknown; morale?: { playerId: number; delta: number }[]; layout?: { playerId: number; role: string; homeX: number; homeY: number }[] }[] = [];
  // P5: the manager's running composite plan (stateful — each shout edits it) and a
  // per-player motivation-change tally for the cap.
  private plan: Plan = EMPTY_PLAN;
  private motivationUsed = new Map<number, number>();
  private moraleEst = new Map<number, number>();        // cumulative morale points injected per player (LLM context)
  private editLock: Promise<void> = Promise.resolve();  // serialises shouts so the cap/plan/fromMs update without a race
  private fromMs = 0;
  private baseSpec: any;
  private sessionSpecPath: string;

  constructor(
    private ws: WebSocket, private specPath: string, private seed: number,
    private homeName = 'HOME', private awayName = 'AWAY',
    private myTeam: 'home' | 'away' = 'home',
  ) {
    this.baseSpec = JSON.parse(readFileSync(specPath, 'utf8'));
    this.sessionSpecPath = specPath.replace(/\.json$/, '') + '.watch.json';
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
      child.stdout.pause();
      this.buffer += data.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';
      for (const l of lines) if (l.length) this.pending.push(l);
      this.tick();
    });
    child.stderr.on('data', () => { /* swallow */ });
    child.on('close', () => { if (this.proc === child) this.tick(); });
  }

  private send(state: any): void {
    if (this.ws.readyState !== 1) return;
    this.latest = state;
    this.ws.send(JSON.stringify({ ...state, seed: this.seed, speed: this.speed, homeName: this.homeName, awayName: this.awayName, matchState: this.paused ? 'paused' : state.matchState }));
  }

  private tick(): void {
    if (this.timer || this.paused || !this.alive) return;
    if (this.pending.length === 0) { this.proc?.stdout.resume(); return; }
    const line = this.pending.shift()!;
    let state: any;
    try { state = JSON.parse(line); } catch { this.tick(); return; }
    const delta = this.prevClock === null ? DEFAULT_FRAME_MS : Math.max(1, state.clockMs - this.prevClock);
    this.prevClock = state.clockMs;
    this.send(state);
    const delay = this.speed > 1 ? DEFAULT_FRAME_MS : Math.max(1, delta / this.speed);
    this.timer = setTimeout(() => { this.timer = null; this.tick(); }, delay);
  }

  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown };
      if (cmd.type === 'restart') { this.paused = false; this.start(); }
      else if (cmd.type === 'pause') {
        this.paused = !this.paused;
        if (this.paused && this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.latest) this.send(this.latest);
        if (!this.paused) this.tick();
      } else if (cmd.type === 'speed' && typeof cmd.value === 'number') {
        this.speed = Math.max(0.25, Math.min(60, cmd.value));
        if (this.latest) this.send(this.latest);
      } else if (cmd.type === 'tactics') {
        // Edit the plan mid-match (text -> plan + motivation; the compile calls the
        // LLM). Serialised: each shout waits for the prior edit to finish so the cap,
        // plan and fromMs advance in arrival order, never racing or rewinding.
        const c = cmd as { text?: string };
        this.editLock = this.editLock.then(() => this.applyTacticsEdit(c)).catch(() => { /* ignore */ });
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
        playerId: off + i, role: slot.role,
        homeX: this.myTeam === 'away' ? PITCH_W - slot.x : slot.x, homeY: slot.y,
      })).filter((_, i) => i > 0);
    }
    this.commitEdit(r.plan.directives, morale, layout);
  }

  private commitEdit(directives: unknown, morale: { playerId: number; delta: number }[], layout?: { playerId: number; role: string; homeX: number; homeY: number }[]): void {
    const t = this.latest?.clockMs ?? 0;
    this.timeline.push({ atMs: t, directives, morale, layout });
    this.writeSessionSpec();
    this.fromMs = Math.max(this.fromMs, t);   // monotonic — never rewind already-streamed frames
    this.paused = false;
    this.start();
  }

  private stopProc(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc) { this.proc.kill(); this.proc = null; }
  }

  dispose(): void {
    this.alive = false;
    this.stopProc();
  }
}

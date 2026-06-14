import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { db } from './db.ts';
import { getTeamWithPlayers } from './game.ts';
import { compileTactics } from './tactics.ts';

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

function specForTeam(teamId: number) {
  const t = getTeamWithPlayers(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  return {
    name: t.name,
    tactics: t.tactics,
    players: t.players
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map(p => ({ name: p.name, attrs: p.attrs })),
  };
}

export function buildSpec(fixture: Fixture) {
  return {
    seed: fixture.seed,
    minutes: MINUTES,
    home: specForTeam(fixture.home_team_id),
    away: specForTeam(fixture.away_team_id),
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
  private timeline: { atMs: number; directives: unknown }[] = [];
  private fromMs = 0;
  private baseSpec: any;
  private sessionSpecPath: string;

  constructor(
    private ws: WebSocket, private specPath: string, private seed: number,
    private homeName = 'HOME', private awayName = 'AWAY',
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
        // Edit the plan mid-match — text (compiled to directives) or pre-compiled
        // directives. Handled async (the compile may call the LLM).
        void this.applyTacticsEdit(cmd as { text?: string; directives?: unknown });
      }
    } catch { /* ignore */ }
  }

  // Mid-match plan edit: compile the manager's text to directives (or use ones
  // already compiled by the client), send back a receipt of what was understood,
  // record it on the timeline at the watched clock, re-sim, and resume there.
  private async applyTacticsEdit(cmd: { text?: string; directives?: unknown }): Promise<void> {
    let directives = Array.isArray(cmd.directives) ? cmd.directives : null;
    if (!directives && typeof cmd.text === 'string' && cmd.text.trim()) {
      const r = await compileTactics(cmd.text, this.baseSpec);
      directives = r.directives;
      console.log(`[tactics] "${cmd.text}" -> ${r.raw || 'llm'} | ${directives.length} directive(s)` +
        (r.error ? ` | ERROR: ${r.error}` : '') + ` | ${JSON.stringify(directives)}`);
      if (this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ tacticsReceipt: { text: cmd.text, directives, error: r.error ?? null } }));
      }
    }
    if (!this.alive || !Array.isArray(directives)) return;
    const t = this.latest?.clockMs ?? 0;
    this.timeline.push({ atMs: t, directives });
    this.writeSessionSpec();
    this.fromMs = t;
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

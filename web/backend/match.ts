import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { gzip, gunzipSync, createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { db } from './db.ts';
import { getTeamWithPlayers, fitFirstSelection, ROLE_SLOTS, DEFAULT_TACTICS } from './game.ts';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer } from './plan.ts';
import type { Directive } from './tactics.ts';
import { FORMATIONS, DEFAULT_FORMATION, PITCH_W, normalizeFormation } from './formations.ts';

const ENGINE = path.resolve(process.cwd(), 'build', 'live.exe');
// Recordings live next to the DB (so a temp-DB test writes them to its temp dir, never the
// real save), and the SPEC scratch under the canonical data dir.
const DATA_DIR = process.env.FOOTY_DB ? path.dirname(process.env.FOOTY_DB) : path.resolve(process.cwd(), 'web', 'backend', 'data');
const SPEC_DIR = path.resolve(process.cwd(), 'web', 'backend', 'data', 'specs');
const REC_DIR = path.join(DATA_DIR, 'recordings');
mkdirSync(SPEC_DIR, { recursive: true });
mkdirSync(REC_DIR, { recursive: true });
const gzipAsync = promisify(gzip);
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

// Resolve a persisted plan (TEAM-RELATIVE squad-slot ids, teamScope 0) to THIS match's engine ids.
// slotToEngine maps a squad slot to its POSITION in the emitted spec.players — which differs from
// slot order under a custom XI, a non-default formation, or an injury-cover swap, so a directive
// must be translated through it (not just +11'd). A per-player order whose slot isn't in the
// fielded XI is dropped; team-wide orders take the side's teamScope; the away side then shifts
// engine ids by +11. (Pre-match plans carry no man_mark of a specific opponent — only a
// target_player's team-mate target is remapped.)
function resolvePlanDirectives(dirs: Directive[] | undefined, slotToEngine: Map<number, number>, side: 'home' | 'away'): Directive[] {
  if (!dirs?.length) return [];
  const off = side === 'away' ? 11 : 0;
  const out: Directive[] = [];
  for (const d of dirs) {
    if (d.teamScope === 0 || d.teamScope === 1) { out.push({ ...d, teamScope: side === 'away' ? 1 : 0 }); continue; }
    const eng = slotToEngine.get(d.playerId);
    if (eng === undefined) continue;                      // that slot isn't on the pitch — drop the order
    const r: Directive = { ...d, playerId: eng + off };
    if (d.kind === 'target_player' && typeof d.targetId === 'number') {
      const tEng = slotToEngine.get(d.targetId);
      if (tEng === undefined) continue;                   // the team-mate to feed isn't fielded — drop
      r.targetId = tEng + off;
    }
    out.push(r);
  }
  return out;
}

// Returns the per-team spec object + this side's engine-id-resolved standing directives (combined
// into the top-level spec.directives by buildTieSpec). A HUMAN team's dials are forced neutral —
// the plain-English plan (directives) is the manager's only tactical input now; AI keeps its dials.
function specForTeam(teamId: number, side: 'home' | 'away'): { spec: Record<string, unknown>; directives: Directive[] } {
  const t = getTeamWithPlayers(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  const tactics = t.userId != null ? DEFAULT_TACTICS : t.tactics;
  const bySlot = t.players.slice().sort((a, b) => a.slot - b.slot);
  // Draw the XI from fit men first (shared with fitnessTick via fitFirstSelection so "who
  // played" can never diverge from "who got drained"). A fully fit squad is unchanged
  // (byte-identical); a bench player covering a sidelined starter may play out of position
  // (emergency cover) — a known, realistic limitation.
  const available = fitFirstSelection(bySlot, p => !!p.injuredMatches);
  const formation = t.formation ?? DEFAULT_FORMATION;
  const layout = FORMATIONS[formation];
  // squad slot -> position in the emitted spec.players (the engine id) — fit-first selection / a
  // custom XI / a formation reorder make this differ from slot order, so the plan resolves through it.
  const slotToEngine = new Map<number, number>();
  let players: Record<string, unknown>[];
  // Byte-identical guard: a team on the default shape with the identity XI emits the
  // exact pre-formation spec (no role/anchor fields) — so every existing team plays
  // precisely as before. Only an opted-in team (non-default formation OR a reordered
  // XI) gets an explicit per-slot layout.
  if ((formation === DEFAULT_FORMATION && isIdentityXI(t.lineup)) || !layout) {
    // personality rides along (engine ignores it) so the watch flow can read each
    // player's personality by engine id without re-deriving the lineup order.
    // slice(0,11) starts the first 11 by slot — a no-op for an 11-player squad (so
    // existing teams emit a byte-identical spec) but it keeps bench depth (slots 11+,
    // added by the transfer market) out of the match.
    const xi = available.slice(0, 11);
    players = xi.map(p => ({ name: p.name, attrs: p.attrs, personality: p.personality ?? null }));
    xi.forEach((p, i) => slotToEngine.set(p.slot, i));
  } else {
    // Emit per-slot role + home anchor. The away side mirrors x (PITCH_W - x) to match
    // the engine's away frame; width (y) is shared. Slot 0 stays the keeper (the engine
    // pins it regardless). lineup[i] = which squad slot fills formation slot i; an injured
    // pick is swapped for the best fit, unused player so the XI is always fit + complete.
    const lineup = t.lineup ?? bySlot.map((_, i) => i);
    // indices already destined for the XI — a substitute must come from OUTSIDE this set (a
    // genuine fit bench player), else two slots could end up sharing a player.
    const inXI = new Set(lineup.slice(0, layout.length).filter(n => Number.isInteger(n) && n >= 0 && n < bySlot.length));
    const used = new Set<number>();
    players = layout.map((slot, i) => {
      const want = lineup[i];
      let idx = (Number.isInteger(want) && want >= 0 && want < bySlot.length) ? want : i;
      if (bySlot[idx]?.injuredMatches) {
        const subIdx = bySlot.findIndex((q, qi) => !q.injuredMatches && !used.has(qi) && !inXI.has(qi));
        if (subIdx >= 0) idx = subIdx;
      }
      const p = bySlot[idx] ?? bySlot[i];
      used.add(idx);
      slotToEngine.set(p.slot, i);
      return {
        name: p.name, attrs: p.attrs, role: slot.role, personality: p.personality ?? null,
        homeX: side === 'away' ? PITCH_W - slot.x : slot.x,
        homeY: slot.y,
      };
    });
  }
  const directives = resolvePlanDirectives(t.plan?.directives, slotToEngine, side);
  return { spec: { name: t.name, tactics, players }, directives };
}

// Build a match spec for two teams (shared by league fixtures + cup ties). Each team's persisted
// standing plan is resolved to engine ids and merged into the top-level `directives` the engine
// reads (home 0-10, away +11) — omitted entirely when neither team has a plan, so AI-vs-AI specs
// are unchanged. Tactics dials are neutral for human teams (their plan is the tactical input).
export function buildTieSpec(homeTeamId: number, awayTeamId: number, seed: number) {
  const home = specForTeam(homeTeamId, 'home');
  const away = specForTeam(awayTeamId, 'away');
  const directives = [...home.directives, ...away.directives];
  const spec: Record<string, unknown> = { seed, minutes: MINUTES, home: home.spec, away: away.spec };
  if (directives.length) spec.directives = directives;
  return spec;
}
export function buildSpec(fixture: Fixture) {
  return buildTieSpec(fixture.home_team_id, fixture.away_team_id, fixture.seed);
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
// Run a written spec through the engine (--summary, deterministic via its seed) and return
// the parsed score. Async (spawn) so a ~1-2s sim never blocks the event loop. Shared by
// league fixtures + cup ties so they sim identically.
function runEngineSummary(specPath: string): Promise<{ homeScore: number; awayScore: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--summary', '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
        resolve({ homeScore: summary.homeScore ?? 0, awayScore: summary.awayScore ?? 0 });
      } catch (e) { reject(new Error(`engine parse failed: ${err || String(e)}`)); }
    });
  });
}

// ── Recordings: store a match's frame stream once, replay it instead of re-simulating ──
// Files (gzipped NDJSON on disk) rather than a DB blob, so the store scales toward object
// storage and the sqlite file stays small; the DB row is metadata + a relative path.
export type RecKind = 'fixture' | 'cup';
export interface Recording { kind: RecKind; refId: number; path: string; homeScore: number; awayScore: number; frames: number; bytes: number }

const recRel = (kind: RecKind, refId: number): string => `recordings/${kind}-${refId}.ndjson.gz`;

// A match is recorded iff it has a human stakeholder — a human manager on either side (even if
// they aren't watching) or, later, a spectator. Pure AI-vs-AI stays the lightweight --summary
// path, so an idle matchday (and the engine benchmark, which never touches this layer) never
// pays the full-frame capture cost.
function hasHumanStake(homeTeamId: number, awayTeamId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id IN (?, ?) AND user_id IS NOT NULL').get(homeTeamId, awayTeamId) as { n: number };
  return row.n > 0;
}

// Upsert the metadata row (idempotent — re-recording REPLACES via the unique kind+ref_id index).
function upsertRecordingRow(kind: RecKind, refId: number, homeScore: number, awayScore: number, rel: string, frames: number, bytes: number): void {
  db.prepare(`INSERT INTO match_recordings (kind, ref_id, format, home_score, away_score, path, frames, bytes, created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      format = 1, home_score = excluded.home_score, away_score = excluded.away_score,
      path = excluded.path, frames = excluded.frames, bytes = excluded.bytes, created_at = excluded.created_at`)
    .run(kind, refId, homeScore, awayScore, rel, frames, bytes, Date.now());
}

// Persist a bounded, in-memory frame array (the exact NDJSON lines a watch consumes): gzip to
// disk + upsert the row, deriving the score from the LAST scored frame so the recording and the
// stored scoreline can never disagree. For SYNTHETIC/small inputs (tests) — the live engine path
// uses recordMatch, which streams to disk so it never holds a whole match in memory.
export async function persistRecording(kind: RecKind, refId: number, lines: string[]): Promise<{ homeScore: number; awayScore: number; frames: number }> {
  let homeScore = 0, awayScore = 0;
  for (const l of lines) { try { const f = JSON.parse(l); if (typeof f.homeScore === 'number') { homeScore = f.homeScore; awayScore = f.awayScore ?? 0; } } catch { /* skip non-frame line */ } }
  const rel = recRel(kind, refId);
  const blob = await gzipAsync(Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf8'));
  writeFileSync(path.join(DATA_DIR, rel), blob);
  upsertRecordingRow(kind, refId, homeScore, awayScore, rel, lines.length, blob.byteLength);
  return { homeScore, awayScore, frames: lines.length };
}

// The recording for a match, or null (caller falls back to a re-sim).
export function recordingFor(kind: RecKind, refId: number): Recording | null {
  const r = db.prepare('SELECT kind, ref_id, path, home_score, away_score, frames, bytes FROM match_recordings WHERE kind = ? AND ref_id = ?')
    .get(kind, refId) as { kind: RecKind; ref_id: number; path: string; home_score: number; away_score: number; frames: number; bytes: number } | undefined;
  return r ? { kind: r.kind, refId: r.ref_id, path: r.path, homeScore: r.home_score, awayScore: r.away_score, frames: r.frames, bytes: r.bytes } : null;
}

// Decompress a recording into its raw engine frame lines (exactly what a live watch streamed).
export function loadRecording(rec: Recording): string[] {
  const abs = path.join(DATA_DIR, rec.path);
  if (!existsSync(abs)) return [];
  return gunzipSync(readFileSync(abs)).toString('utf8').split(/\r?\n/).filter(l => l.length > 0);
}

// Prototype housekeeping: prune recordings beyond a retention policy (file + row). Used by
// tools/recordings_gc.ts. `now` is injectable for tests. Newest-first; keeps `keep` of them.
export function pruneRecordings(opts: { keep?: number; maxAgeDays?: number; now?: number } = {}): { pruned: number; files: number; kept: number } {
  const keep = opts.keep ?? 100;
  const now = opts.now ?? Date.now();
  const cutoff = opts.maxAgeDays != null ? now - opts.maxAgeDays * 86_400_000 : null;
  const all = db.prepare('SELECT id, path, created_at FROM match_recordings ORDER BY created_at DESC').all() as unknown as { id: number; path: string; created_at: number }[];
  const doomed = all.filter((r, i) => i >= keep || (cutoff != null && r.created_at < cutoff));
  const del = db.prepare('DELETE FROM match_recordings WHERE id = ?');
  let files = 0;
  for (const r of doomed) {
    const abs = path.join(DATA_DIR, r.path);
    if (existsSync(abs)) { rmSync(abs, { force: true }); files++; }
    del.run(r.id);
  }
  return { pruned: doomed.length, files, kept: all.length - doomed.length };
}

// Delete the recordings (files + rows) for a specific set of matches. Called when the underlying
// fixtures are removed at season rollover, so match_recordings doesn't accumulate rows keyed to
// dead fixture ids. (Report rows are cleaned separately by report.ts.)
export function purgeRecordings(kind: RecKind, refIds: number[]): void {
  if (!refIds.length) return;
  const sel = db.prepare('SELECT path FROM match_recordings WHERE kind = ? AND ref_id = ?');
  const del = db.prepare('DELETE FROM match_recordings WHERE kind = ? AND ref_id = ?');
  for (const id of refIds) {
    const row = sel.get(kind, id) as { path: string } | undefined;
    if (row) { try { const abs = path.join(DATA_DIR, row.path); if (existsSync(abs)) rmSync(abs, { force: true }); } catch { /* best effort */ } }
    del.run(kind, id);
  }
}

// STREAM a line-oriented frame source straight to a gzipped temp file — O(1) memory, never the
// whole match at once (a 90' match is ~200k frames / multi-GB uncompressed, which buffering would
// OOM / blow V8's max string length). The score is tracked from the last scored frame as lines
// flow past, and backpressure pauses the source while the gzip drains. We publish (atomic rename
// + row) ONLY on a CLEAN, COMPLETE finish — the source ended AND the final frame's matchState is
// "finished" — so a crashed/timed-out/killed run (stream errored, or EOF'd before the final
// whistle) leaves only a discarded .tmp, never a partial recording or a scoreline that disagrees
// with an unplayed fixture. Exported (not just internal) so a synthetic-stream test exercises it
// without spawning the engine. Returns the derived score + frame count.
export function captureLineStream(kind: RecKind, refId: number, src: NodeJS.ReadableStream): Promise<{ homeScore: number; awayScore: number; frames: number }> {
  return new Promise((resolve, reject) => {
    const rel = recRel(kind, refId);
    const abs = path.join(DATA_DIR, rel);
    const tmp = abs + '.tmp';
    const gz = createGzip();
    const out = createWriteStream(tmp);
    gz.pipe(out);
    let buffer = '', frames = 0, homeScore = 0, awayScore = 0, lastState = '', settled = false;
    const fail = (e: Error): void => {
      if (settled) return; settled = true;
      gz.destroy(); out.destroy();
      try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
      reject(e);
    };
    const writeLine = (l: string): void => {
      if (!l.length) return;
      frames++;
      if (!gz.write(l + '\n')) src.pause();   // backpressure -> bounded memory
      try { const f = JSON.parse(l); if (typeof f.homeScore === 'number') { homeScore = f.homeScore; awayScore = f.awayScore ?? 0; } if (typeof f.matchState === 'string') lastState = f.matchState; } catch { /* skip non-frame line */ }
    };
    gz.on('drain', () => { if (!settled) src.resume(); });
    src.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split(/\r?\n/); buffer = parts.pop() ?? '';
      for (const l of parts) writeLine(l);
    });
    src.on('error', e => fail(e));
    out.on('error', e => fail(e));
    src.on('end', () => {
      if (settled) return;
      if (buffer.trim().length) writeLine(buffer.trim());
      if (!frames || lastState !== 'finished') { fail(new Error(`incomplete capture (${frames} frames, last "${lastState}")`)); return; }
      gz.end();   // flush the gzip trailer through to the file
      out.on('finish', () => {
        if (settled) return; settled = true;
        try {
          renameSync(tmp, abs);   // atomic publish: the recording appears only once fully written
          upsertRecordingRow(kind, refId, homeScore, awayScore, rel, frames, statSync(abs).size);
          resolve({ homeScore, awayScore, frames });
        } catch (e) {
          try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
          reject(e as Error);
        }
      });
    });
  });
}

// Run a match through the engine FULL-FRAME (no --summary) and capture it. Wires the child's
// lifecycle to the stream: a spawn error or a 120s hang destroys stdout (→ the capture rejects +
// cleans up); a crash EOFs stdout without a "finished" frame, which captureLineStream rejects.
function recordMatch(kind: RecKind, refId: number, specPath: string): Promise<{ homeScore: number; awayScore: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } child.stdout.destroy(new Error(`engine timeout: ${err}`)); }, 120000);
    child.on('error', e => { try { child.stdout.destroy(e); } catch { /* gone */ } });
    captureLineStream(kind, refId, child.stdout).then(
      r => { clearTimeout(to); resolve({ homeScore: r.homeScore, awayScore: r.awayScore }); },
      e => { clearTimeout(to); try { child.kill(); } catch { /* gone */ } reject(e); },
    );
  });
}

export function playFixture(fixtureId: number): Promise<PlayResult> {
  const fx = getFixture(fixtureId);
  if (!fx) return Promise.reject(new Error('fixture not found'));
  if (fx.played) {
    return Promise.resolve({ fixtureId, homeScore: fx.home_score ?? 0, awayScore: fx.away_score ?? 0, alreadyPlayed: true });
  }
  const specPath = writeSpec(fx);
  // Human-stake matches are recorded (full-frame) so watching replays the recording; AI-only
  // matches take the lightweight --summary path (no frames kept).
  const play = hasHumanStake(fx.home_team_id, fx.away_team_id)
    ? recordMatch('fixture', fixtureId, specPath)
    : runEngineSummary(specPath);
  return play.then(({ homeScore, awayScore }) => {
    db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, fixtureId);
    return { fixtureId, homeScore, awayScore, alreadyPlayed: false };
  });
}

export interface CupTieResult { tieId: number; homeScore: number; awayScore: number; alreadyPlayed: boolean }

// Play a cup tie through the engine and persist its score. Idempotent.
export function playCupTie(tieId: number): Promise<CupTieResult> {
  const t = db.prepare('SELECT home_team_id, away_team_id, seed, played, home_score, away_score FROM cup_ties WHERE id = ?')
    .get(tieId) as { home_team_id: number | null; away_team_id: number | null; seed: number; played: number; home_score: number | null; away_score: number | null } | undefined;
  if (!t || t.home_team_id == null || t.away_team_id == null) return Promise.reject(new Error('cup tie not ready'));
  if (t.played) return Promise.resolve({ tieId, homeScore: t.home_score ?? 0, awayScore: t.away_score ?? 0, alreadyPlayed: true });
  const file = path.join(SPEC_DIR, `cup-${tieId}.json`);
  writeFileSync(file, JSON.stringify(buildTieSpec(t.home_team_id, t.away_team_id, t.seed)));
  const play = hasHumanStake(t.home_team_id, t.away_team_id)
    ? recordMatch('cup', tieId, file)
    : runEngineSummary(file);
  return play.then(({ homeScore, awayScore }) => {
    db.prepare('UPDATE cup_ties SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, tieId);
    return { tieId, homeScore, awayScore, alreadyPlayed: false };
  });
}

// ── Live watch / replay: pace a frame stream to one client ──
export const DEFAULT_FRAME_MS = 1000 / 30;
type Proc = ChildProcessByStdio<null, Readable, Readable>;

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
    let advanced = 0, drained = 0, pc = prevClock, state: any = null;
    while (pending.length && advanced < budget) {
      const line = pending.shift()!; drained++;
      let f: any; try { f = JSON.parse(line); } catch { continue; }
      advanced += pc === null ? DEFAULT_FRAME_MS : Math.max(0, (f.clockMs ?? pc) - pc);
      pc = f.clockMs ?? pc; state = f;
    }
    return { state, prevClock: pc, delayMs: DEFAULT_FRAME_MS, drained };
  }
  const line = pending.shift()!;
  let state: any; try { state = JSON.parse(line); } catch { return { state: null, prevClock, delayMs: 1, drained: 1 }; }
  const delta = prevClock === null ? DEFAULT_FRAME_MS : Math.max(1, state.clockMs - prevClock);
  return { state, prevClock: state.clockMs, delayMs: Math.max(1, delta / speed), drained: 1 };
}

// Shared pacer: holds the frame queue + speed/pause/clock and the tick loop. Subclasses supply
// the frame SOURCE — the live engine (MatchStream) or a stored recording (ReplayStream) — via
// refill() (called when the queue drains) plus their own command handling.
abstract class FramePacer {
  protected pending: string[] = [];
  protected timer: ReturnType<typeof setTimeout> | null = null;
  protected prevClock: number | null = null;
  protected speed = 1;
  protected paused = false;
  protected latest: any = null;
  protected alive = true;
  protected replay = false;   // tags the wire frame so the client hides live-only controls
  // explicit fields (not constructor parameter properties) — the tools tsconfig type-checks this
  // file under erasableSyntaxOnly, which disallows that syntax.
  protected ws: WebSocket;
  protected seed: number;
  protected homeName: string;
  protected awayName: string;

  constructor(ws: WebSocket, seed: number, homeName: string, awayName: string) {
    this.ws = ws; this.seed = seed; this.homeName = homeName; this.awayName = awayName;
  }

  protected send(state: any): void {
    if (this.ws.readyState !== 1) return;
    this.latest = state;
    this.ws.send(JSON.stringify({ ...state, seed: this.seed, speed: this.speed, homeName: this.homeName, awayName: this.awayName, replay: this.replay, matchState: this.paused ? 'paused' : state.matchState }));
  }

  protected tick(): void {
    if (this.timer || this.paused || !this.alive) return;
    if (this.pending.length === 0) { this.refill(); return; }
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

export class MatchStream extends FramePacer {
  private proc: Proc | null = null;
  private buffer = '';
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
  private myTeam: 'home' | 'away';

  constructor(
    ws: WebSocket, specPath: string, seed: number,
    homeName = 'HOME', awayName = 'AWAY',
    myTeam: 'home' | 'away' = 'home',
    seedPlan?: Plan | null,
  ) {
    super(ws, seed, homeName, awayName);
    this.myTeam = myTeam;
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

  // Live source: the engine streamed faster than we paced, so the queue drained — let it flow on.
  protected refill(): void { this.proc?.stdout.resume(); }

  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown; text?: string };
      if (cmd.type === 'restart') { this.paused = false; this.start(); }
      else if (cmd.type === 'pause') this.togglePause();
      else if (cmd.type === 'speed' && typeof cmd.value === 'number') this.setSpeed(cmd.value);
      else if (cmd.type === 'tactics') {
        // Edit the plan mid-match (text -> plan + motivation; the compile calls the LLM).
        // Serialised: each shout waits for the prior edit to finish so the cap, plan and fromMs
        // advance in arrival order, never racing or rewinding.
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

  override dispose(): void {
    super.dispose();
    this.stopProc();
  }
}

// Replay a stored recording through the same pacer — no engine spawn, no re-sim drift. A
// recording is finished + immutable, so playback supports random-access seek/rewind (re-fill the
// queue from a different clock) but no shouts; the client hides the tactics box on a replay.
export class ReplayStream extends FramePacer {
  private frames: string[];
  // Takes the already-loaded frames (loaded once by the caller) — so /ws/match can verify the
  // recording actually has frames before choosing replay over the live re-sim, never leaving a
  // viewer staring at a blank pitch because a row outlived its file.
  constructor(ws: WebSocket, frames: string[], seed: number, homeName: string, awayName: string) {
    super(ws, seed, homeName, awayName);
    this.replay = true;
    this.frames = frames;
    ws.on('message', (d: Buffer) => this.onCommand(d));
    ws.on('close', () => this.dispose());
    this.seekTo(0);
  }

  // Load every frame at/after `fromMs` into the queue and (re)start pacing from there.
  private seekTo(fromMs: number): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.prevClock = null;
    this.pending = fromMs <= 0 ? this.frames.slice()
      : this.frames.filter(l => { try { return (JSON.parse(l).clockMs ?? 0) >= fromMs; } catch { return false; } });
    this.paused = false;
    this.tick();
  }

  protected refill(): void { /* recording exhausted — playback is complete, leave the final frame up */ }

  private onCommand(d: Buffer): void {
    try {
      const cmd = JSON.parse(d.toString()) as { type?: string; value?: unknown };
      if (cmd.type === 'pause') this.togglePause();
      else if (cmd.type === 'speed' && typeof cmd.value === 'number') this.setSpeed(cmd.value);
      else if (cmd.type === 'restart') this.seekTo(0);
      else if (cmd.type === 'seek' && typeof cmd.value === 'number') this.seekTo(Math.max(0, cmd.value));
    } catch { /* ignore */ }
  }
}

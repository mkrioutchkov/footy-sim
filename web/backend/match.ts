import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { gzip, gunzipSync, createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import type { WebSocket } from 'ws';
import { db } from './db.ts';
import { getTeamWithPlayers, fieldedXIIndices, ROLE_SLOTS, DEFAULT_TACTICS, type SetPieceTakers } from './game.ts';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer } from './plan.ts';
import { getTeamTalkDeltas, consumeTeamTalk } from './teamtalk.ts';
import { tallyFixtureStats } from './leaders.ts';
import type { Directive } from './tactics.ts';
import { FORMATIONS, DEFAULT_FORMATION, PITCH_W, normalizeFormation, engineRole } from './formations.ts';

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
function specForTeam(teamId: number, side: 'home' | 'away', talk?: Map<number, number>): { spec: Record<string, unknown>; directives: Directive[] } {
  const t = getTeamWithPlayers(teamId);
  if (!t) throw new Error(`team ${teamId} not found`);
  const tactics = t.userId != null ? DEFAULT_TACTICS : t.tactics;
  const bySlot = t.players.slice().sort((a, b) => a.slot - b.slot);
  const formation = t.formation ?? DEFAULT_FORMATION;
  const layout = FORMATIONS[formation];
  // The fielded XI as squad-slot INDICES, in formation order — via fieldedXIIndices, the ONE selection
  // shared with fitnessTick so "who played" can never diverge from "who got drained" (a fully fit squad
  // on the default shape is byte-identical; a custom XI / non-default shape / injury-cover swap reorders).
  const xiIdx = fieldedXIIndices(bySlot, p => !!p.injuredMatches, formation, t.lineup);
  // squad slot -> position in the emitted spec.players (the engine id) — differs from slot order under a
  // custom XI / a non-default formation / an injury-cover swap, so the plan resolves through it.
  const slotToEngine = new Map<number, number>();
  let players: Record<string, unknown>[];
  // Byte-identical guard: a team on the default shape with the identity XI emits the
  // exact pre-formation spec (no role/anchor fields) — so every existing team plays
  // precisely as before. Only an opted-in team (non-default formation OR a reordered
  // XI) gets an explicit per-slot layout.
  if ((formation === DEFAULT_FORMATION && isIdentityXI(t.lineup)) || !layout) {
    // personality rides along (engine ignores it) so the watch flow can read each
    // player's personality by engine id without re-deriving the lineup order. The bench
    // depth (slots 11+, added by the transfer market) stays out of the match.
    const xi = xiIdx.map(i => bySlot[i]);
    // §2.13: a pre-match team talk rides in as players[].moraleBoost (engine reads it at kickoff). Only
    // added when a talk gave this player a non-zero delta — no talk ⇒ no field ⇒ byte-identical spec.
    players = xi.map(p => { const mb = talk?.get(p.slot); return { name: p.name, attrs: p.attrs, personality: p.personality ?? null, ...(mb ? { moraleBoost: mb } : {}) }; });
    xi.forEach((p, i) => slotToEngine.set(p.slot, i));
  } else {
    // Emit per-slot role + home anchor. The away side mirrors x (PITCH_W - x) to match
    // the engine's away frame; width (y) is shared. Slot 0 stays the keeper (the engine
    // pins it regardless). xiIdx[i] = which squad slot fills formation slot i (an injured
    // pick already swapped for the best fit, unused player by fieldedXIIndices).
    players = layout.map((slot, i) => {
      const p = bySlot[xiIdx[i]] ?? bySlot[i];
      slotToEngine.set(p.slot, i);
      const mb = talk?.get(p.slot);
      return {
        name: p.name, attrs: p.attrs, role: engineRole(slot.role), personality: p.personality ?? null,
        homeX: side === 'away' ? PITCH_W - slot.x : slot.x,
        homeY: slot.y,
        ...(mb ? { moraleBoost: mb } : {}),
      };
    });
  }
  // Set-piece takers (user-watch): the manager's designated FK/corner/pen/long-throw takers ride in as
  // per-player directives (playerId = squad slot) that resolve to engine ids alongside the plan. A taker
  // who isn't in the fielded XI is dropped by resolvePlanDirectives → the engine falls back to its default.
  // Unknown kinds are a no-op in today's engine (main.cpp `else continue`) until Boris reads them.
  const directives = resolvePlanDirectives([...(t.plan?.directives ?? []), ...setPieceTakerDirectives(t.setPieceTakers)], slotToEngine, side);
  return { spec: { name: t.name, tactics, players }, directives };
}

// Build the per-player set-piece-taker directives the engine reads at a restart (omits any taker left on
// the default). Kinds: fk_taker | corner_taker | pen_taker | long_throw_taker; playerId = squad slot.
function setPieceTakerDirectives(takers: SetPieceTakers | null): Directive[] {
  if (!takers) return [];
  const out: Directive[] = [];
  if (takers.fk != null) out.push({ kind: 'fk_taker', playerId: takers.fk });
  if (takers.corner != null) out.push({ kind: 'corner_taker', playerId: takers.corner });
  if (takers.pen != null) out.push({ kind: 'pen_taker', playerId: takers.pen });
  if (takers.longThrow != null) out.push({ kind: 'long_throw_taker', playerId: takers.longThrow });
  return out;
}

// §weather: a deterministic per-match condition (the engine reads spec.weather — "rain"/"wet" skids the
// ball on a wet pitch, "wind" drifts airborne balls; see engine main.cpp:177). A PURE function of the
// match seed, so a re-sim or replay of the same fixture gets the SAME weather; 'clear' is OMITTED from
// the spec → byte-identical with pre-weather/AI-vs-AI specs (and the golden, which loads a static
// weather-free fixture-1.json). Mostly clear, with some rain/wind for variety (the average goal effect
// is ≈0 — rain −0.56, wind +0.6 — so league balance holds while individual matches vary).
export type Weather = 'clear' | 'rain' | 'wind';
export function weatherForSeed(seed: number): Weather {
  let h = seed | 0;                                       // a well-mixing 32-bit integer hash of the seed
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  const b = ((h ^ (h >>> 16)) >>> 0) % 100;
  if (b < 18) return 'rain';                              // ~18%
  if (b < 30) return 'wind';                              // ~12%
  return 'clear';                                         // ~70%
}

// Build a match spec for two teams (shared by league fixtures + cup ties). Each team's persisted
// standing plan is resolved to engine ids and merged into the top-level `directives` the engine
// reads (home 0-10, away +11) — omitted entirely when neither team has a plan, so AI-vs-AI specs
// are unchanged. Tactics dials are neutral for human teams (their plan is the tactical input).
export function buildTieSpec(homeTeamId: number, awayTeamId: number, seed: number, fixtureId?: number) {
  // §2.13: fold each side's pre-match team talk (if any) into its players' moraleBoost. No talk ⇒ empty
  // map ⇒ no moraleBoost field ⇒ the spec is byte-identical (AI-vs-AI + untouched fixtures unchanged).
  const homeTalk = fixtureId != null ? getTeamTalkDeltas(homeTeamId, fixtureId) : undefined;
  const awayTalk = fixtureId != null ? getTeamTalkDeltas(awayTeamId, fixtureId) : undefined;
  const home = specForTeam(homeTeamId, 'home', homeTalk && homeTalk.size ? homeTalk : undefined);
  const away = specForTeam(awayTeamId, 'away', awayTalk && awayTalk.size ? awayTalk : undefined);
  const directives = [...home.directives, ...away.directives];
  const spec: Record<string, unknown> = { seed, minutes: MINUTES, home: home.spec, away: away.spec };
  if (directives.length) spec.directives = directives;
  const weather = weatherForSeed(seed);
  if (weather !== 'clear') spec.weather = weather;       // omit 'clear' ⇒ byte-identical with weather-free specs
  return spec;
}
export function buildSpec(fixture: Fixture) {
  return buildTieSpec(fixture.home_team_id, fixture.away_team_id, fixture.seed, fixture.id);
}

export function writeSpec(fixture: Fixture): string {
  const spec = buildSpec(fixture);
  const file = path.join(SPEC_DIR, `fixture-${fixture.id}.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

export interface PlayResult { fixtureId: number; homeScore: number; awayScore: number; alreadyPlayed: boolean; players?: SummaryPlayer[]; }

// Best-effort replay recordings run ONE AT A TIME (so they can't pile up + swamp a slow host), but via a
// SEQUENTIAL QUEUE rather than a drop-if-busy gate — the old `at most one in flight, others skip` lost a
// game's recording whenever two human matches (or a league + cup tie) finished close together (viewer P2).
// Now every queued match records in turn; failures are isolated + the result/aftermath are untouched either
// way (they come from --summary). Dedup keeps a fixture from being queued twice.
type RecordJob = { kind: 'fixture' | 'cup'; id: number; spec: string };
const recordQueue: RecordJob[] = [];
const recordQueued = new Set<string>();   // `${kind}:${id}` currently queued or recording (dedupe)
let recordingActive = false;
function enqueueRecording(kind: 'fixture' | 'cup', id: number, spec: string): void {
  const key = `${kind}:${id}`;
  if (recordQueued.has(key) || recordingFor(kind, id)) return;   // already queued/recording, or already on disk
  recordQueued.add(key);
  recordQueue.push({ kind, id, spec });
  void drainRecordQueue();
}
async function drainRecordQueue(): Promise<void> {
  if (recordingActive) return;            // a drain is already running — it picks up newly-queued jobs
  recordingActive = true;
  try {
    while (recordQueue.length) {
      const job = recordQueue.shift()!;
      try { await recordMatch(job.kind, job.id, job.spec); }
      catch (e) { console.error(`[match] replay recording ${job.kind} ${job.id} failed (${(e as Error).message}); result + aftermath unaffected.`); }
      finally { recordQueued.delete(`${job.kind}:${job.id}`); }
    }
  } finally { recordingActive = false; }
}

// Run a fixture through the engine (deterministic via the stored seed) and
// persist the score. Idempotent: a played fixture returns its stored result.
// ASYNC (spawn, not spawnSync) so a ~1-2s (slower under load) match sim never
// blocks the Node event loop — that froze the watch socket and serialised a
// whole matchday. A round's fixtures can now sim concurrently (Promise.all).
// The per-player line from a --summary run — the cheap STATS the aftermath rates off (the same fields
// analyzeRecording reads from the final frame), so ratings/news/morale never need the frame recording.
export interface SummaryPlayer { id: number; name: string; role: string; team: 'home' | 'away'; goals: number; assists: number; shots: number; tackles: number; passes: number; passesCompleted: number; yellow: number; sentOff: boolean }
export interface SummaryResult { homeScore: number; awayScore: number; players: SummaryPlayer[] }
const numF = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Run a written spec through the engine (--summary, deterministic via its seed) and return the score +
// the per-player stats. Async (spawn) so a ~1-2s sim never blocks the event loop. Shared by league
// fixtures + cup ties so they sim identically.
function runEngineSummary(specPath: string): Promise<SummaryResult> {
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
        const summary = JSON.parse(lines[lines.length - 1]) as { homeScore?: number; awayScore?: number; players?: Record<string, unknown>[] };
        const players: SummaryPlayer[] = (summary.players ?? []).map(p => ({
          id: numF(p.id), name: String(p.name ?? ''), role: String(p.role ?? ''),
          team: p.team === 'away' ? 'away' : 'home',
          goals: numF(p.goals), assists: numF(p.assists), shots: numF(p.shots), tackles: numF(p.tackles),
          passes: numF(p.passes), passesCompleted: numF(p.passesCompleted),
          yellow: numF(p.yellow), sentOff: !!p.sentOff,
        }));
        resolve({ homeScore: summary.homeScore ?? 0, awayScore: summary.awayScore ?? 0, players });
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
const eventsRel = (kind: RecKind, refId: number): string => `recordings/${kind}-${refId}.events.json`;

// ── Event-sourced command log (docs/LIVE_MATCH_ARCHITECTURE.md §4) ──
// The canonical INPUTS of a live match: its base spec (seed + rosters + standing directives) plus
// the timestamped command log (every inject/sub stamped with the tick it applied). Replaying these
// via the engine's existing flat-out directive-timeline mode (engine_defense.cpp:37-57) is
// byte-identical AND exercises the golden-locked path — see replayViaTimeline.
export interface Command {
  atMs: number; team: 0 | 1; directives: unknown;
  morale?: { playerId: number; delta: number }[];
  layout?: { playerId: number; role: string; homeX: number; homeY: number }[];
  text?: string;   // the human shout that produced this edit — kept for REVIEW; the engine ignores it
}
// `spec` is stored so a replay is SELF-CONTAINED (rosters drift with transfers, so rebuilding the
// spec from current DB state would not be byte-identical). This extends the doc's literal
// {seed,duration,scores,commands} — flagged to Boris.
export interface EventsLog { seed: number; duration: number; scores: { home: number; away: number }; spec: Record<string, unknown>; commands: Command[] }

export function writeEventsLog(kind: RecKind, refId: number, log: EventsLog): void {
  const abs = path.join(DATA_DIR, eventsRel(kind, refId));
  const tmp = abs + '.tmp';
  writeFileSync(tmp, JSON.stringify(log));
  renameSync(tmp, abs);   // atomic publish — a crash mid-write never leaves a partial events log
}
export function loadEventsLog(kind: RecKind, refId: number): EventsLog | null {
  const abs = path.join(DATA_DIR, eventsRel(kind, refId));
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')) as EventsLog; } catch { return null; }
}

// Convert the command log into a spec `timeline` (the existing directive-timeline shape). Each
// entry keeps its `team` so a per-team-aware timeline mode replays two-sided live injects
// byte-identically (an engine-contract item for Boris). Pure (no engine) — unit-tested.
export function commandsToTimeline(commands: Command[]): Array<Record<string, unknown>> {
  return commands.map(c => {
    const e: Record<string, unknown> = { atMs: c.atMs, team: c.team, directives: c.directives };
    if (c.morale) e.morale = c.morale;
    if (c.layout) e.layout = c.layout;
    return e;
  });
}
// The self-contained re-sim spec for a format-2 recording (base spec + reconstructed timeline). Pure.
export function buildReplaySpec(log: EventsLog): Record<string, unknown> {
  return { ...log.spec, timeline: commandsToTimeline(log.commands) };
}

// A human-readable digest of a shout-driven match's command log for the report screen — minute,
// the shout text, and what it changed (directive count, a formation swap, morale hits). Pure.
export interface ShoutReviewEntry { minute: number; text: string; directives: number; formationChange: boolean; morale: number }
export function tacticsReview(log: EventsLog): { side: 'home' | 'away'; scores: { home: number; away: number }; shouts: ShoutReviewEntry[] } {
  // MatchStream persists single-team commands (one shouting manager), so the side is that team.
  const side: 'home' | 'away' = log.commands[0]?.team === 1 ? 'away' : 'home';
  const shouts: ShoutReviewEntry[] = log.commands.map(c => ({
    minute: Math.floor(c.atMs / 60000),
    text: c.text ?? '',
    directives: Array.isArray(c.directives) ? c.directives.length : 0,
    formationChange: Array.isArray(c.layout) && c.layout.length > 0,
    morale: Array.isArray(c.morale) ? c.morale.length : 0,
  }));
  return { side, scores: log.scores, shouts };
}
// Re-simulate a format-2 match from its command log via the engine's flat-out timeline mode (NOT
// live stdin), returning the frame lines — byte-identical to the live frames once the engine's
// timeline parser is per-team aware (Boris). Drives the determinism regression.
export function replayViaTimeline(kind: RecKind, refId: number): Promise<string[]> {
  const log = loadEventsLog(kind, refId);
  if (!log) return Promise.reject(new Error('no format-2 events log'));
  const spec = buildReplaySpec(log) as { home?: { players?: unknown[] }; away?: { players?: unknown[] } };
  if ((spec.home?.players?.length ?? 0) < 11 || (spec.away?.players?.length ?? 0) < 11) {
    return Promise.reject(new Error('format-2 events log has an incomplete roster spec'));   // distinguishes bad-data from an engine crash
  }
  const file = path.join(SPEC_DIR, `replay-${kind}-${refId}.json`);
  writeFileSync(file, JSON.stringify(spec));
  const cleanup = (): void => { try { if (existsSync(file)) rmSync(file, { force: true }); } catch { /* best effort */ } };
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', file, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = ''; const frames: string[] = [];
    child.stdout.on('data', (d: Buffer) => { buf += d.toString(); const ls = buf.split(/\r?\n/); buf = ls.pop() ?? ''; for (const l of ls) if (l.length) frames.push(l); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } cleanup(); reject(new Error('replay timeout')); }, 120000);
    child.on('error', e => { clearTimeout(to); cleanup(); reject(e); });
    child.on('close', () => { clearTimeout(to); cleanup(); if (buf.length) frames.push(buf); if (frames.length) resolve(frames); else reject(new Error(`replay produced no frames: ${err}`)); });
  });
}

// A match is recorded iff it has a human stakeholder — a human manager on either side (even if
// they aren't watching) or, later, a spectator. Pure AI-vs-AI stays the lightweight --summary
// path, so an idle matchday (and the engine benchmark, which never touches this layer) never
// pays the full-frame capture cost.
export function hasHumanStake(homeTeamId: number, awayTeamId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id IN (?, ?) AND user_id IS NOT NULL').get(homeTeamId, awayTeamId) as { n: number };
  return row.n > 0;
}

// Upsert the metadata row (idempotent — re-recording REPLACES via the unique kind+ref_id index).
function upsertRecordingRow(kind: RecKind, refId: number, homeScore: number, awayScore: number, rel: string, frames: number, bytes: number, format = 1): void {
  db.prepare(`INSERT INTO match_recordings (kind, ref_id, format, home_score, away_score, path, frames, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET
      format = excluded.format, home_score = excluded.home_score, away_score = excluded.away_score,
      path = excluded.path, frames = excluded.frames, bytes = excluded.bytes, created_at = excluded.created_at`)
    .run(kind, refId, format, homeScore, awayScore, rel, frames, bytes, Date.now());
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
    // delete the paired format-2 events log too (sibling of the .ndjson.gz)
    const ev = path.join(DATA_DIR, r.path.replace(/\.ndjson\.gz$/, '.events.json'));
    try { if (existsSync(ev)) rmSync(ev, { force: true }); } catch { /* best effort */ }
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
    try { const ev = path.join(DATA_DIR, eventsRel(kind, id)); if (existsSync(ev)) rmSync(ev, { force: true }); } catch { /* best effort */ }
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
// sampleEvery>0 thins captured FRAMES to ~1-in-N (the replay renderer interpolates, so it stays smooth)
// while ALWAYS keeping the first frame, every score change, every matchState change (kickoff/half/FINISHED —
// the capture requires a 'finished' last state) and any non-frame/event line. A full capture is ~200k frames
// (~97MB gz) which floods the replay renderer + balloons load-time memory; thinning the OPT-IN matchday capture
// makes its replay screenshot-able + light. Default 0 = keep every line (the live-watch recorder is unchanged).
export function captureLineStream(kind: RecKind, refId: number, src: NodeJS.ReadableStream, format = 1, sampleEvery = 0): Promise<{ homeScore: number; awayScore: number; frames: number }> {
  return new Promise((resolve, reject) => {
    const rel = recRel(kind, refId);
    const abs = path.join(DATA_DIR, rel);
    const tmp = abs + '.tmp';
    const gz = createGzip();
    const out = createWriteStream(tmp);
    gz.pipe(out);
    let buffer = '', frames = 0, seen = 0, homeScore = 0, awayScore = 0, lastState = '', settled = false, ended = false;
    const fail = (e: Error): void => {
      if (settled) return; settled = true;
      gz.destroy(); out.destroy();
      try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
      reject(e);
    };
    const writeLine = (l: string): void => {
      if (!l.length) return;
      // parse EVERY line for score/state first (a dropped frame still advances the tally), then decide KEEP.
      let isFrame = false, scoreChanged = false, stateChanged = false, eventful = false;
      try {
        const f = JSON.parse(l); isFrame = true;
        if (typeof f.homeScore === 'number') { if (f.homeScore !== homeScore || (f.awayScore ?? 0) !== awayScore) scoreChanged = true; homeScore = f.homeScore; awayScore = f.awayScore ?? 0; }
        if (typeof f.matchState === 'string') { if (f.matchState !== lastState) stateChanged = true; lastState = f.matchState; }
        // Always keep a frame carrying a FRESH notable transient event (a saved/missed penalty, woodwork) so
        // the timeline (analyzeRecording) can surface it — these don't move score/card state, so they'd
        // otherwise be thinned away. Rare + age-gated (~a few frames each) → negligible size cost.
        if (Array.isArray(f.events)) eventful = f.events.some((e: any) => (e.type === 'penalty' || e.type === 'woodwork') && (typeof e.age === 'number' ? e.age : 999) < 150);
      } catch { /* a non-frame/event line — always kept */ }
      seen++;
      // keep everything (no sampling), or any non-frame/score-change/state-change/notable-event, or every Nth frame
      if (!(sampleEvery <= 0 || !isFrame || scoreChanged || stateChanged || eventful || (seen % sampleEvery === 1))) return;
      frames++;
      if (!gz.write(l + '\n')) src.pause();   // backpressure -> bounded memory
    };
    gz.on('drain', () => { if (!settled) src.resume(); });
    src.on('data', (d: Buffer) => {
      buffer += d.toString();
      const parts = buffer.split(/\r?\n/); buffer = parts.pop() ?? '';
      for (const l of parts) writeLine(l);
    });
    src.on('error', e => fail(e));
    out.on('error', e => fail(e));
    // A source .destroy()-ed WITHOUT an error (e.g. coordinator.dispose() when the last viewer leaves
    // mid-match) emits neither 'end' nor 'error' — only 'close'. Without this the Promise never settles and
    // gz/out (+ the .tmp file's fd) leak. 'close' also fires on the clean path AFTER 'end', so guard on
    // `ended` so this only rejects the genuinely-truncated case. fail() destroys gz/out + removes the .tmp.
    src.on('close', () => { if (!settled && !ended) fail(new Error('capture source closed before end')); });
    src.on('end', () => {
      if (settled) return;
      ended = true;
      if (buffer.trim().length) writeLine(buffer.trim());
      if (!frames || lastState !== 'finished') { fail(new Error(`incomplete capture (${frames} frames, last "${lastState}")`)); return; }
      gz.end();   // flush the gzip trailer through to the file
      out.on('finish', () => {
        if (settled) return; settled = true;
        try {
          renameSync(tmp, abs);   // atomic publish: the recording appears only once fully written
          upsertRecordingRow(kind, refId, homeScore, awayScore, rel, frames, statSync(abs).size, format);
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
// Captured SAMPLED (1-in-REPLAY_SAMPLE frames + every score/state change) so the matchday replay is
// light enough to load + screenshot — a full ~200k-frame capture floods the renderer (the QA "catch-22").
export const REPLAY_SAMPLE = 8;   // exported: the live coordinator's capture thins with the same rate (unthinned live matches stored ~160-200k frames)
function recordMatch(kind: RecKind, refId: number, specPath: string): Promise<{ homeScore: number; awayScore: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // 180s: a full-frame capture is heavier than --summary, so give a slow host room to finish (and earn
    // a watchable replay) before the playFixture fallback drops it to --summary. A real hang still lapses.
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } child.stdout.destroy(new Error(`engine timeout: ${err}`)); }, 180000);
    child.on('error', e => { try { child.stdout.destroy(e); } catch { /* gone */ } });
    captureLineStream(kind, refId, child.stdout, 1, REPLAY_SAMPLE).then(
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
  // --summary is the AUTHORITATIVE, fast result + the per-player stats the aftermath rates off (same seed
  // ⇒ same score as a full-frame run). The frame recording is now PURELY OPT-IN for replay (recordReplay,
  // fired AFTER the matchday's summaries so it never competes with them) — if it times out or crashes the
  // season is untouched. The event/stats-vs-frames split: ratings/news/morale derive from the cheap stats.
  return runEngineSummary(specPath).then(({ homeScore, awayScore, players }) => {
    db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, fixtureId);
    consumeTeamTalk(fixtureId);   // §2.13: a pre-match talk is a one-off — spent once the match is played
    tallyFixtureStats(fixtureId, players);   // §stat-leaders: both clubs' goals/assists → the division leaderboard (once)
    return { fixtureId, homeScore, awayScore, alreadyPlayed: false, players };
  });
}

// Best-effort full-frame REPLAY recording for a just-played fixture — fired by the advance handler AFTER
// the matchday's summaries resolve, so the slow full-frame run never competes with the (fast, result-
// bearing) summaries that gate the advance. Capped at one in flight + skips an existing recording, so it
// can't pile up on a slow host. Failure is silent: the result + aftermath already came from --summary.
export function recordReplay(fixtureId: number): void {
  const fx = getFixture(fixtureId);
  if (!fx) return;
  // Default: only human-stake matches are recorded (your games — faithful + bounded ~38/season). The
  // FOOTY_RECORD_ALL knob records any fixture passed here too (for "watch any game" testing; off by
  // default so the default disk footprint + behaviour are unchanged).
  if (process.env.FOOTY_RECORD_ALL !== '1' && !hasHumanStake(fx.home_team_id, fx.away_team_id)) return;
  enqueueRecording('fixture', fixtureId, writeSpec(fx));
}

// A matchday sims the WHOLE world (every division's round + any cup ties) — ~16 engine processes at once.
// Promise.all fired them ALL concurrently, which on a modest player's box (a 4-core laptop) means 16 native
// engines + node + vite fighting over a handful of cores — a real crash/swap risk. Cap the in-flight engines
// at the box's own parallelism: a 16-core host still runs the round in one wave (this box is throughput-bound,
// not oversubscription-bound, so a smaller cap only adds batch barriers), a 4-core box runs ~3 at a time.
// FOOTY_MATCH_CONCURRENCY overrides for a tuned deploy. Order-preserving so callers can index results by
// position. (No-op vs Promise.all when the cap >= items.length.)
const envCap = Math.floor(Number(process.env.FOOTY_MATCH_CONCURRENCY));
export const MATCH_CONCURRENCY = Number.isFinite(envCap) && envCap >= 1
  ? envCap
  : Math.max(2, (os.availableParallelism?.() ?? 4) - 1);
export async function mapPool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = MATCH_CONCURRENCY): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
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
  const human = hasHumanStake(t.home_team_id, t.away_team_id);
  // Same split as the league: --summary is the authoritative result; a human tie ALSO fires a best-effort,
  // capped, non-blocking replay recording (a timeout/crash leaves the result + bracket untouched).
  return runEngineSummary(file).then(({ homeScore, awayScore }) => {
    db.prepare('UPDATE cup_ties SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, tieId);
    if (human || process.env.FOOTY_RECORD_ALL === '1') enqueueRecording('cup', tieId, file);
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
abstract class FramePacer {
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

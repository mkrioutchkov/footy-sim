import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, createWriteStream, renameSync, statSync } from 'node:fs';
import { gzip, gunzipSync, createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { db } from './db.ts';
import { getTeamWithPlayers, fieldedXIIndices, ROLE_SLOTS, DEFAULT_TACTICS } from './game.ts';
import { compilePlanEdit, EMPTY_PLAN, type Plan, type SquadPlayer } from './plan.ts';
import { getTeamTalkDeltas, consumeTeamTalk } from './teamtalk.ts';
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
  const directives = resolvePlanDirectives(t.plan?.directives, slotToEngine, side);
  return { spec: { name: t.name, tactics, players }, directives };
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
export function captureLineStream(kind: RecKind, refId: number, src: NodeJS.ReadableStream, format = 1): Promise<{ homeScore: number; awayScore: number; frames: number }> {
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
function recordMatch(kind: RecKind, refId: number, specPath: string): Promise<{ homeScore: number; awayScore: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE, ['--match', specPath, '--no-debug'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    // 180s: a full-frame capture is heavier than --summary, so give a slow host room to finish (and earn
    // a watchable replay) before the playFixture fallback drops it to --summary. A real hang still lapses.
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } child.stdout.destroy(new Error(`engine timeout: ${err}`)); }, 180000);
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
  // matches take the lightweight --summary path (no frames kept). RESILIENCE: if the full-frame
  // capture fails (engine timeout on a slow host, a crash, an incomplete capture), fall back to
  // --summary — the SAME seed yields the SAME score, so the match still resolves (just no replay)
  // instead of a single recording failure rejecting the whole /api/advance Promise.all and wedging
  // the season. The matchday must never be blocked by a recording glitch.
  const play = hasHumanStake(fx.home_team_id, fx.away_team_id)
    ? recordMatch('fixture', fixtureId, specPath).catch((e: Error) => {
        console.error(`[match] recording fixture ${fixtureId} failed (${e.message}); falling back to --summary (no replay).`);
        return runEngineSummary(specPath);
      })
    : runEngineSummary(specPath);
  return play.then(({ homeScore, awayScore }) => {
    db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(homeScore, awayScore, fixtureId);
    consumeTeamTalk(fixtureId);   // §2.13: a pre-match talk is a one-off — spent once the match is played
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
  private canShout: boolean;   // only a manager of this fixture may inject tactics (§1.2)

  constructor(
    ws: WebSocket, specPath: string, seed: number,
    homeName = 'HOME', awayName = 'AWAY',
    myTeam: 'home' | 'away' = 'home',
    seedPlan?: Plan | null,
    canShout = true,
  ) {
    super(ws, seed, homeName, awayName);
    this.myTeam = myTeam;
    this.canShout = canShout;
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

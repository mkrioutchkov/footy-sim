// The recording STORE: what a match recording is, where it lives, and the row/file lifecycle
// (write, read back, prune, purge). The streaming CAPTURE that produces one lives next door in
// capture.ts; this module is the part a consumer (report.ts, routes/watch.ts, the GC tool) sees.
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { gzip, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { db } from '../db.ts';
import { DATA_DIR } from './runtime.ts';

const gzipAsync = promisify(gzip);

// ── Recordings: store a match's frame stream once, replay it instead of re-simulating ──
// Files (gzipped NDJSON on disk) rather than a DB blob, so the store scales toward object
// storage and the sqlite file stays small; the DB row is metadata + a relative path.
export type RecKind = 'fixture' | 'cup';
export interface Recording { kind: RecKind; refId: number; path: string; homeScore: number; awayScore: number; frames: number; bytes: number }

export const recRel = (kind: RecKind, refId: number): string => `recordings/${kind}-${refId}.ndjson.gz`;
export const eventsRel = (kind: RecKind, refId: number): string => `recordings/${kind}-${refId}.events.json`;

// A match is recorded iff it has a human stakeholder — a human manager on either side (even if
// they aren't watching) or, later, a spectator. Pure AI-vs-AI stays the lightweight --summary
// path, so an idle matchday (and the engine benchmark, which never touches this layer) never
// pays the full-frame capture cost.
export function hasHumanStake(homeTeamId: number, awayTeamId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id IN (?, ?) AND user_id IS NOT NULL').get(homeTeamId, awayTeamId) as { n: number };
  return row.n > 0;
}

// Upsert the metadata row (idempotent — re-recording REPLACES via the unique kind+ref_id index).
export function upsertRecordingRow(kind: RecKind, refId: number, homeScore: number, awayScore: number, rel: string, frames: number, bytes: number, format = 1): void {
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

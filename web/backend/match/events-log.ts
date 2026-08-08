// The event-sourced command log: a live match's canonical INPUTS (base spec + timestamped
// shouts), the pure shaping that turns them back into a self-contained re-sim spec, and the
// flat-out timeline replay that proves the round-trip is byte-identical.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ENGINE, DATA_DIR, SPEC_DIR } from './runtime.ts';
import { type RecKind, eventsRel } from './recordings.ts';

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

// World state for turn-based + autonomous mode. A world is the set of leagues sharing world_id (see
// season.ts worldLeagues); this module owns the `worlds` side-table (turn cadence, mode, join state,
// the durable advance lock). It only reads/writes that table + the leagues/teams rows — no engine, no
// match logic. The turn driver (index.ts advanceWorld / runDueTicks) uses these helpers.
import { db } from './db.ts';

export type WorldMode = 'solo' | 'shared';
export interface WorldRow {
  worldId: number; name: string; mode: WorldMode; joinOpen: boolean;
  turn: number; lastAdvanced: number | null; intervalMin: number; advancing: boolean;
}

// The world_id key for any league in a world (COALESCE(world_id, id) — matches worldLeagues()).
export function worldRootId(leagueId: number): number {
  const r = db.prepare('SELECT COALESCE(world_id, id) AS wid FROM leagues WHERE id = ?').get(leagueId) as { wid: number } | undefined;
  return r?.wid ?? leagueId;
}

// The world a team belongs to (via its league). NULL if the team/league is missing.
export function worldForTeam(teamId: number): number | null {
  const r = db.prepare('SELECT COALESCE(l.world_id, l.id) AS wid FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?').get(teamId) as { wid: number } | undefined;
  return r?.wid ?? null;
}

const rowToWorld = (r: { world_id: number; name: string; mode: string; join_open: number; turn: number; last_advanced: number | null; interval_min: number; advancing: number }): WorldRow =>
  ({ worldId: r.world_id, name: r.name, mode: r.mode === 'shared' ? 'shared' : 'solo', joinOpen: !!r.join_open, turn: r.turn, lastAdvanced: r.last_advanced, intervalMin: r.interval_min, advancing: !!r.advancing });

export function getWorld(worldId: number): WorldRow | null {
  const r = db.prepare('SELECT world_id, name, mode, join_open, turn, last_advanced, interval_min, advancing FROM worlds WHERE world_id = ?').get(worldId) as any;
  return r ? rowToWorld(r) : null;
}

// Register a world's state row (idempotent). Called at world creation (newSeasonForUser / createSharedWorld).
export function registerWorld(worldId: number, name: string, mode: WorldMode, opts: { joinOpen?: boolean; intervalMin?: number } = {}): void {
  db.prepare(`INSERT OR IGNORE INTO worlds (world_id, name, mode, join_open, interval_min, created_at) VALUES (?,?,?,?,?,?)`)
    .run(worldId, name, mode, opts.joinOpen ? 1 : 0, opts.intervalMin ?? 720, Date.now());
}

// The world's row for a given league (backfilled at startup, but be defensive: register on the fly).
export function ensureWorldForLeague(leagueId: number): WorldRow {
  const wid = worldRootId(leagueId);
  let w = getWorld(wid);
  if (!w) {
    const nm = (db.prepare('SELECT name FROM leagues WHERE id = ?').get(wid) as { name: string } | undefined)?.name ?? `World ${wid}`;
    registerWorld(wid, nm, 'solo');
    w = getWorld(wid)!;
  }
  return w;
}

// Shared worlds that are open to new human managers, with a count of unclaimed (AI) teams.
export interface JoinableWorld { worldId: number; name: string; season: number; turn: number; intervalMin: number; unclaimed: number; total: number }
export function listJoinableWorlds(): JoinableWorld[] {
  const worlds = db.prepare("SELECT world_id, name, turn, interval_min FROM worlds WHERE mode = 'shared' AND join_open = 1 ORDER BY world_id").all() as { world_id: number; name: string; turn: number; interval_min: number }[];
  return worlds.map(w => {
    const season = (db.prepare('SELECT season FROM leagues WHERE COALESCE(world_id, id) = ? ORDER BY tier LIMIT 1').get(w.world_id) as { season: number } | undefined)?.season ?? 1;
    const counts = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN t.user_id IS NULL THEN 1 ELSE 0 END) AS unclaimed FROM teams t JOIN leagues l ON l.id = t.league_id WHERE COALESCE(l.world_id, l.id) = ?').get(w.world_id) as { total: number; unclaimed: number };
    return { worldId: w.world_id, name: w.name, season, turn: w.turn, intervalMin: w.interval_min, unclaimed: counts.unclaimed ?? 0, total: counts.total ?? 0 };
  });
}

// Shared worlds due for a scheduled advance (never advanced, or interval elapsed) and not mid-advance.
export function dueSharedWorlds(now: number): WorldRow[] {
  const rows = db.prepare("SELECT world_id, name, mode, join_open, turn, last_advanced, interval_min, advancing FROM worlds WHERE mode = 'shared' AND advancing = 0 AND (last_advanced IS NULL OR ? - last_advanced >= interval_min * 60000) ORDER BY COALESCE(last_advanced, 0) ASC").all(now) as any[];
  return rows.map(rowToWorld);
}

// Durable advance lock: claim returns true only if we flipped 0→1 (so two ticks can't both advance a world).
export function claimAdvanceLock(worldId: number): boolean {
  const res = db.prepare('UPDATE worlds SET advancing = 1 WHERE world_id = ? AND advancing = 0').run(worldId);
  return res.changes > 0;
}
export function releaseAdvanceLock(worldId: number): void {
  db.prepare('UPDATE worlds SET advancing = 0 WHERE world_id = ?').run(worldId);
}
// On a successful turn: bump the counter + stamp the time, and release the lock.
export function recordWorldAdvanced(worldId: number, now: number): void {
  db.prepare('UPDATE worlds SET turn = turn + 1, last_advanced = ?, advancing = 0 WHERE world_id = ?').run(now, worldId);
}

// Backroom staff (coaches / physios / scouts). A shared per-world hire pool the club signs from for
// a one-off fee; the squad keeps no wage gate (the fee IS the cost). Effects, all aggregated from a
// role's combined quality and capped: coaches speed training growth, physios cut injury risk + speed
// condition recovery, scouts deepen the pre-match scouting report. With no staff every effect is the
// identity, so existing saves / the engine-free regressions are byte-for-byte unaffected.
import { db } from './db.ts';
import { randomPlayerName } from './names.ts';

export type StaffRole = 'coach' | 'physio' | 'scout';
export interface StaffRow { id: number; role: StaffRole; name: string; rating: number; cost: number; }

const ROLES: StaffRole[] = ['coach', 'physio', 'scout'];
export const MAX_STAFF = 8;     // a club can employ at most this many
const POOL_SIZE = 12;           // candidates kept available per world

// Convex hire fee: a journeyman (~45) is cheap, an elite (~88) is dear.
function ratingToCost(rating: number): number {
  return Math.round((Math.pow(Math.max(0, rating - 40) / 10, 2) * 0.4 + 0.3) * 1_000_000);
}

function worldOf(teamId: number): number | null {
  const r = db.prepare('SELECT l.world_id AS w FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { w: number | null } | undefined;
  return r?.w ?? null;
}

// Top the world's hire pool back up to POOL_SIZE (idempotent — only inserts the shortfall).
export function seedStaffPool(worldId: number): void {
  const have = (db.prepare('SELECT COUNT(*) AS n FROM staff WHERE world_id = ? AND team_id IS NULL').get(worldId) as { n: number }).n;
  const ins = db.prepare('INSERT INTO staff (world_id, team_id, role, name, rating, cost) VALUES (?, NULL, ?, ?, ?, ?)');
  for (let i = have; i < POOL_SIZE; i++) {
    const role = ROLES[i % ROLES.length];
    const rating = 45 + Math.floor(Math.random() * 44);   // 45..88
    ins.run(worldId, role, randomPlayerName(), rating, ratingToCost(rating));
  }
}

export function getStaffView(teamId: number): { staff: StaffRow[]; pool: StaffRow[]; budget: number; max: number; effects: ReturnType<typeof staffEffectsSummary> } {
  const wid = worldOf(teamId);
  if (wid != null) seedStaffPool(wid);
  const mine = db.prepare('SELECT id, role, name, rating, cost FROM staff WHERE team_id = ? ORDER BY role, rating DESC').all(teamId) as unknown as StaffRow[];
  const pool = wid == null ? [] : db.prepare('SELECT id, role, name, rating, cost FROM staff WHERE world_id = ? AND team_id IS NULL ORDER BY role, rating DESC').all(wid) as unknown as StaffRow[];
  const budget = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
  return { staff: mine, pool, budget, max: MAX_STAFF, effects: staffEffectsSummary(teamId) };
}

export function hireStaff(teamId: number, staffId: number): { ok: boolean; error?: string; name?: string } {
  const wid = worldOf(teamId);
  const s = db.prepare('SELECT id, world_id, team_id, name, cost FROM staff WHERE id = ?')
    .get(staffId) as { id: number; world_id: number; team_id: number | null; name: string; cost: number } | undefined;
  if (!s || s.team_id != null || (wid != null && s.world_id !== wid)) return { ok: false, error: 'that member is not available to you' };
  const count = (db.prepare('SELECT COUNT(*) AS n FROM staff WHERE team_id = ?').get(teamId) as { n: number }).n;
  if (count >= MAX_STAFF) return { ok: false, error: `you already employ the maximum of ${MAX_STAFF} staff` };
  const budget = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
  if (budget < s.cost) return { ok: false, error: 'not enough budget for the hiring fee' };
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(s.cost, teamId);
    db.prepare('UPDATE staff SET team_id = ? WHERE id = ?').run(teamId, staffId);
    db.exec('COMMIT');
  } catch (err) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw err; }
  return { ok: true, name: s.name };
}

export function fireStaff(teamId: number, staffId: number): { ok: boolean; error?: string } {
  const s = db.prepare('SELECT team_id FROM staff WHERE id = ?').get(staffId) as { team_id: number | null } | undefined;
  if (!s || s.team_id !== teamId) return { ok: false, error: 'not your staff member' };
  db.prepare('UPDATE staff SET team_id = NULL WHERE id = ?').run(staffId);   // returns to the pool, no refund
  return { ok: true };
}

// ── effects (each capped; identity when the club has no staff of that role) ──
// Combined quality of a role: each member contributes (rating−40)/50, so an elite (~90) ≈ +1.
function strength(teamId: number, role: StaffRole): number {
  const rows = db.prepare('SELECT rating FROM staff WHERE team_id = ? AND role = ?').all(teamId, role) as { rating: number }[];
  return rows.reduce((sum, r) => sum + Math.max(0, r.rating - 40) / 50, 0);
}

export function coachingFactor(teamId: number): number { return 1 + Math.min(0.30, strength(teamId, 'coach') * 0.10); }
export function physioEffect(teamId: number): { injuryMult: number; recoverBonus: number } {
  const s = strength(teamId, 'physio');
  return { injuryMult: Math.max(0.55, 1 - Math.min(0.45, s * 0.15)), recoverBonus: Math.min(15, Math.round(s * 5)) };
}
export function scoutDepth(teamId: number): number { return Math.min(3, Math.round(strength(teamId, 'scout'))); }

function staffEffectsSummary(teamId: number): { training: number; injuryReduction: number; recoverBonus: number; scoutDepth: number } {
  const pe = physioEffect(teamId);
  return {
    training: Math.round((coachingFactor(teamId) - 1) * 100),   // +X% training growth
    injuryReduction: Math.round((1 - pe.injuryMult) * 100),     // −X% injury risk
    recoverBonus: pe.recoverBonus,                              // +condition for rested players
    scoutDepth: scoutDepth(teamId),                            // extra key players revealed
  };
}

// Backroom staff (coaches / physios / scouts). A shared per-world hire pool the club signs from for
// a one-off fee; the squad keeps no wage gate (the fee IS the cost). Effects, all aggregated from a
// role's combined quality and capped: coaches speed training growth, physios cut injury risk + speed
// condition recovery, scouts deepen the pre-match scouting report. With no staff every effect is the
// identity, so existing saves / the engine-free regressions are byte-for-byte unaffected.
import { db } from './db.ts';
import { randomPlayerName } from './names.ts';
import { recordFinance } from './finances.ts';

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
  // A legacy single-league club (world_id NULL) has no hire pool, so it can hire nothing — and the
  // world-equality check is unconditional, so no club can ever hire another world's candidate (review fix).
  if (wid == null) return { ok: false, error: 'no hire pool for this club' };
  const s = db.prepare('SELECT id, world_id, team_id, name, cost FROM staff WHERE id = ?')
    .get(staffId) as { id: number; world_id: number; team_id: number | null; name: string; cost: number } | undefined;
  if (!s || s.team_id != null || s.world_id !== wid) return { ok: false, error: 'that member is not available to you' };
  const count = (db.prepare('SELECT COUNT(*) AS n FROM staff WHERE team_id = ?').get(teamId) as { n: number }).n;
  if (count >= MAX_STAFF) return { ok: false, error: `you already employ the maximum of ${MAX_STAFF} staff` };
  const budget = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
  if (budget < s.cost) return { ok: false, error: 'not enough budget for the hiring fee' };
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(s.cost, teamId);
    db.prepare('UPDATE staff SET team_id = ? WHERE id = ?').run(teamId, staffId);
    recordFinance(teamId, 'staff', -s.cost, `Hired ${s.name}`);
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

// ── Training & Coaches: per-category coach quality (the FM-style specialist-coach layer) ──────────────
// Each of the four coaching categories maps to one coach attribute. A category's development multiplier comes
// from the coaches ASSIGNED to it; when a category is UNASSIGNED (or the club has no coach_assignment at all) it
// FALLS BACK to the flat club-wide coachingFactor — the golden-safe identity path, so a club that never touches
// coach assignment develops byte-identically to today.
const CATEGORY_COACH_ATTR: Record<string, string> = {
  Attacking: 'attacking', Possession: 'technical', Defending: 'defending', Fitness: 'fitness',
};
const COACH_CAPACITY = 8;   // players one coach can effectively cover in a category

interface CoachRow { id: number; role: StaffRole; rating: number; specialty: string | null; attrs: string | null; }

// A coach's 7-dimension attrs — parsed from staff.attrs, or lazily spread from his flat rating (byte-safe legacy).
export function coachAttrs(s: { rating: number; attrs?: string | null }): Record<string, number> {
  if (s.attrs) { try { const j = JSON.parse(s.attrs) as Record<string, number>; if (j && typeof j === 'object') return j; } catch { /* fall through to backfill */ } }
  const r = s.rating;
  return { attacking: r, defending: r, technical: r, tactical: r, fitness: r, gk: r, youth: r };
}

// The coaches a club has assigned to a category (parsed from teams.coach_assignment JSON).
function assignedCoaches(teamId: number, assignment: string | null, category: string): CoachRow[] {
  if (!assignment) return [];
  let map: Record<string, number[]>;
  try { map = JSON.parse(assignment) as Record<string, number[]>; } catch { return []; }
  const ids = map[category];
  if (!Array.isArray(ids) || !ids.length) return [];
  return db.prepare(`SELECT id, role, rating, specialty, attrs FROM staff WHERE team_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(teamId, ...ids) as unknown as CoachRow[];
}

// Star rating 0.5..5.0 for a category — the weighted mean of the assigned coaches' relevant attr (50 → 2.5★, 100 → 5★).
// An assistant_manager is a generalist (0.6 weight); specialists pull full weight. No coaches → a neutral 2.5★.
export function categoryStars(teamId: number, assignment: string | null, category: string): number {
  const coaches = assignedCoaches(teamId, assignment, category);
  if (!coaches.length) return 2.5;
  const attrKey = CATEGORY_COACH_ATTR[category] ?? 'technical';
  let sum = 0, w = 0;
  for (const c of coaches) {
    const val = coachAttrs(c)[attrKey] ?? c.rating;
    const weight = c.specialty === 'assistant_manager' ? 0.6 : 1.0;
    sum += val * weight; w += weight;
  }
  return Math.max(0.5, Math.min(5, (sum / Math.max(1e-6, w)) / 20));
}

// Coverage 0.55..1.0 — how well the assigned coaches cover the squad's load in this category (a lone coach spread
// across a big squad covers less than a dedicated one). Load is proxied by an even split of the squad over 4 categories.
export function categoryCoverage(teamId: number, assignment: string | null, category: string): number {
  const coaches = assignedCoaches(teamId, assignment, category);
  if (!coaches.length) return 0.55;
  const squad = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(teamId) as { n: number }).n;
  const load = Math.max(1, Math.round(squad / 4));
  return Math.max(0.55, Math.min(1, (coaches.length * COACH_CAPACITY) / load));
}

// The per-category development multiplier [0.90, 1.30]. UNASSIGNED (NULL coach_assignment, or no coaches for the
// category) FALLS BACK to the flat club-wide coachingFactor — the byte-identical legacy path. A great coach lifts
// toward 1.30, a poor one toward 0.90; a neutral 2.5★ at full coverage is exactly 1.0 (no change).
export function categoryCoachFactor(teamId: number, assignment: string | null, category: string): number {
  if (!assignment || !assignedCoaches(teamId, assignment, category).length) return coachingFactor(teamId);
  const stars = categoryStars(teamId, assignment, category);
  const coverage = categoryCoverage(teamId, assignment, category);
  return Math.max(0.90, Math.min(1.30, 1 + ((stars - 2.5) / 2.5) * 0.30 * coverage));
}

// A suggested category→coach assignment by specialty, for the staff screen's default view. Does NOT persist —
// development keeps using the flat coachingFactor until the manager explicitly saves an assignment.
export function suggestCoachAssignment(teamId: number): Record<string, number[]> {
  const coaches = db.prepare("SELECT id, specialty FROM staff WHERE team_id = ? AND role = 'coach'")
    .all(teamId) as { id: number; specialty: string | null }[];
  const map: Record<string, number[]> = {};
  for (const c of coaches) {
    const spec = c.specialty ?? 'first_team_coach';
    const cats = spec === 'fitness_coach' ? ['Fitness']
      : spec === 'gk_coach' || spec === 'set_piece_coach' ? []   // GK / set-piece categories deferred in the MVP
      : spec === 'assistant_manager' ? ['Attacking', 'Possession', 'Defending', 'Fitness']
      : ['Attacking', 'Possession', 'Defending'];                // first_team_coach → the outfield categories
    for (const cat of cats) (map[cat] ??= []).push(c.id);
  }
  return map;
}

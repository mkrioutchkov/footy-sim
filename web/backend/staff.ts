// Backroom staff (coaches / physios / scouts). A shared per-world hire pool the club signs from for
// a one-off fee; the squad keeps no wage gate (the fee IS the cost). Effects, all aggregated from a
// role's combined quality and capped: coaches speed training growth, physios cut injury risk + speed
// condition recovery, scouts deepen the pre-match scouting report. With no staff every effect is the
// identity, so existing saves / the engine-free regressions are byte-for-byte unaffected.
import { db } from './db.ts';
import { randomPlayerName } from './names.ts';
import { recordFinance } from './finances.ts';

export type StaffRole = 'coach' | 'physio' | 'scout';
export interface StaffRow { id: number; role: StaffRole; name: string; rating: number; cost: number; specialty?: string | null; }

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
  const countOf = db.prepare('SELECT COUNT(*) AS n FROM staff WHERE world_id = ? AND team_id IS NULL AND role = ?');
  for (let i = have; i < POOL_SIZE; i++) {
    // Replace what is MISSING. The old ROLES[i % 3] keyed the role on the pool COUNT,
    // so a pool sitting one short always regrew the same role — at 11/12 every top-up
    // was a scout, hired coaches were never replaced, and a world's coach supply was
    // finite (found by _ai_test). Refill the role the pool is thinnest on instead.
    const counts = ROLES.map(r => (countOf.get(worldId, r) as { n: number }).n);
    const role = ROLES[counts.indexOf(Math.min(...counts))];
    const rating = 45 + Math.floor(Math.random() * 44);   // 45..88
    ins.run(worldId, role, randomPlayerName(), rating, ratingToCost(rating));
  }
}

export function getStaffView(teamId: number): {
  staff: StaffRow[]; pool: StaffRow[]; budget: number; max: number; effects: ReturnType<typeof staffEffectsSummary>;
  categories: CategoryBoard[]; suggestion: Record<string, number[]>; assignmentSet: boolean;
} {
  const wid = worldOf(teamId);
  if (wid != null) seedStaffPool(wid);
  const mine = db.prepare('SELECT id, role, name, rating, cost, specialty FROM staff WHERE team_id = ? ORDER BY role, rating DESC').all(teamId) as unknown as StaffRow[];
  const pool = wid == null ? [] : db.prepare('SELECT id, role, name, rating, cost, specialty FROM staff WHERE world_id = ? AND team_id IS NULL ORDER BY role, rating DESC').all(wid) as unknown as StaffRow[];
  const budget = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
  // One backroom load feeds the effects summary, the board AND the suggestion (Round-perf note on
  // loadClubStaff below); the assignment is read once and shared with categoryBoard rather than re-read
  // for `assignmentSet`. `mine`'s own SELECT is left alone deliberately — it is the payload the staff
  // screen renders, and widening its column list would change the JSON the API returns.
  const club = loadClubStaff(teamId);
  const assignment = getCoachAssignment(teamId);
  // the 4-category coaching board + a by-specialty suggestion + whether the manager has explicitly assigned (vs flat)
  return { staff: mine, pool, budget, max: MAX_STAFF, effects: staffEffectsSummary(club),
    categories: boardFrom(club, assignment), suggestion: suggestFrom(club), assignmentSet: assignment != null };
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

// ── the club's backroom, loaded ONCE ────────────────────────────────────────
// Round-perf: every figure below (role strengths, the per-category board, the by-specialty suggestion)
// is a projection of the SAME row set, but each used to fetch its own slice. One staff screen ran
// ~30 queries for one club: `... AND id IN (...)` five times per category (categoryStars, categoryCoverage,
// and categoryCoachFactor re-deriving both), a squad COUNT twice per category, three `SELECT rating`
// strength scans and two `SELECT coach_assignment`. Measured on a 30-matchday workload that was 57k of
// the read burst's 75k statements. Load the club's staff once and project in JS instead.
//
// Kept faithful to the SQL it replaces: `ORDER BY id` reproduces the ascending-rowid order an index scan
// on idx_staff_team already yielded (suggestFrom's output order is PERSISTED by ai.ts, so it is not free
// to change), and `wantedIds` runs candidate ids through Number() the way SQLite's INTEGER column
// affinity did for `id IN (...)`.
interface CoachRow { id: number; role: StaffRole; rating: number; specialty: string | null; attrs: string | null; }
type ClubStaff = { teamId: number; rows: CoachRow[]; squad: number | null };

function loadClubStaff(teamId: number): ClubStaff {
  const rows = db.prepare('SELECT id, role, rating, specialty, attrs FROM staff WHERE team_id = ? ORDER BY id')
    .all(teamId) as unknown as CoachRow[];
  return { teamId, rows, squad: null };
}

// Squad size is only needed by a category that HAS coaches, so it stays lazy — an unassigned club
// still runs no COUNT at all, exactly as before.
function squadSize(club: ClubStaff): number {
  if (club.squad == null) {
    club.squad = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(club.teamId) as { n: number }).n;
  }
  return club.squad;
}

// ── effects (each capped; identity when the club has no staff of that role) ──
// Combined quality of a role: each member contributes (rating−40)/50, so an elite (~90) ≈ +1.
// The formulas live here ONCE; the two access paths below differ only in where the ratings come from —
// a narrow per-role query (for the one-shot callers in fitness/rotation/market/scout/training) or the
// club's already-loaded row set (for the staff screen, which needs all three roles anyway).
const ratingWeight = (rating: number): number => Math.max(0, rating - 40) / 50;
const coachFactorOfStrength = (s: number): number => 1 + Math.min(0.30, s * 0.10);
const physioOfStrength = (s: number): { injuryMult: number; recoverBonus: number } =>
  ({ injuryMult: Math.max(0.55, 1 - Math.min(0.45, s * 0.15)), recoverBonus: Math.min(15, Math.round(s * 5)) });
const scoutOfStrength = (s: number): number => Math.min(3, Math.round(s));

function strength(teamId: number, role: StaffRole): number {
  const rows = db.prepare('SELECT rating FROM staff WHERE team_id = ? AND role = ?').all(teamId, role) as { rating: number }[];
  return rows.reduce((sum, r) => sum + ratingWeight(r.rating), 0);
}
function strengthOf(club: ClubStaff, role: StaffRole): number {
  return club.rows.reduce((sum, r) => sum + (r.role === role ? ratingWeight(r.rating) : 0), 0);
}

export function coachingFactor(teamId: number): number { return coachFactorOfStrength(strength(teamId, 'coach')); }
function coachingFactorOf(club: ClubStaff): number { return coachFactorOfStrength(strengthOf(club, 'coach')); }
export function physioEffect(teamId: number): { injuryMult: number; recoverBonus: number } { return physioOfStrength(strength(teamId, 'physio')); }
export function scoutDepth(teamId: number): number { return scoutOfStrength(strength(teamId, 'scout')); }

function staffEffectsSummary(club: ClubStaff): { training: number; injuryReduction: number; recoverBonus: number; scoutDepth: number } {
  const pe = physioOfStrength(strengthOf(club, 'physio'));
  return {
    training: Math.round((coachingFactorOf(club) - 1) * 100),   // +X% training growth
    injuryReduction: Math.round((1 - pe.injuryMult) * 100),     // −X% injury risk
    recoverBonus: pe.recoverBonus,                              // +condition for rested players
    scoutDepth: scoutOfStrength(strengthOf(club, 'scout')),     // extra key players revealed
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

// A coach's 7-dimension attrs — parsed from staff.attrs, or lazily spread from his flat rating (byte-safe legacy).
export function coachAttrs(s: { rating: number; attrs?: string | null }): Record<string, number> {
  if (s.attrs) { try { const j = JSON.parse(s.attrs) as Record<string, number>; if (j && typeof j === 'object') return j; } catch { /* fall through to backfill */ } }
  const r = s.rating;
  return { attacking: r, defending: r, technical: r, tactical: r, fitness: r, gk: r, youth: r };
}

// The assignment travels as raw JSON across the exported seam (categoryStars/Coverage/CoachFactor take the
// string the caller read off teams.coach_assignment) and as an already-parsed object internally, so the
// board parses it once instead of once per category.
type AssignmentJson = string | Record<string, number[]> | null;

// The ids a category is assigned, parsed from teams.coach_assignment JSON. Number() mirrors the INTEGER
// column affinity SQLite applied when these ids were bound into `id IN (...)`, so a numeric string still
// resolves to the same coach it always did.
function wantedIds(assignment: AssignmentJson, category: string): Set<number> | null {
  if (!assignment) return null;
  let map: Record<string, number[]>;
  if (typeof assignment === 'string') {
    try { map = JSON.parse(assignment) as Record<string, number[]>; } catch { return null; }
  } else { map = assignment; }
  const ids = map[category];
  if (!Array.isArray(ids) || !ids.length) return null;
  return new Set(ids.map(Number));
}

// The coaches a club has assigned to a category. Filtering the club's one loaded row set reproduces
// `... WHERE team_id = ? AND id IN (...)` exactly: same membership (an id the club does not own is simply
// absent), same de-duplication (a repeated id yields one row either way), same ascending-id order.
function assignedFrom(club: ClubStaff, assignment: AssignmentJson, category: string): CoachRow[] {
  const want = wantedIds(assignment, category);
  if (want == null) return [];
  return club.rows.filter(r => want.has(r.id));
}

// Star rating 0.5..5.0 for a category — the weighted mean of the assigned coaches' relevant attr (50 → 2.5★, 100 → 5★).
// An assistant_manager is a generalist (0.6 weight); specialists pull full weight. No coaches → a neutral 2.5★.
function starsFrom(coaches: CoachRow[], category: string): number {
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
export function categoryStars(teamId: number, assignment: string | null, category: string): number {
  if (!assignment) return 2.5;                                   // no load needed for the unassigned path
  return starsFrom(assignedFrom(loadClubStaff(teamId), assignment, category), category);
}

// Coverage 0.55..1.0 — how well the assigned coaches cover the squad's load in this category (a lone coach spread
// across a big squad covers less than a dedicated one). Load is proxied by an even split of the squad over 4 categories.
function coverageFrom(club: ClubStaff, coaches: CoachRow[]): number {
  if (!coaches.length) return 0.55;
  const load = Math.max(1, Math.round(squadSize(club) / 4));
  return Math.max(0.55, Math.min(1, (coaches.length * COACH_CAPACITY) / load));
}
export function categoryCoverage(teamId: number, assignment: string | null, category: string): number {
  if (!assignment) return 0.55;
  const club = loadClubStaff(teamId);
  return coverageFrom(club, assignedFrom(club, assignment, category));
}

// The per-category development multiplier [0.90, 1.30]. UNASSIGNED (NULL coach_assignment, or no coaches for the
// category) FALLS BACK to the flat club-wide coachingFactor — the byte-identical legacy path. A great coach lifts
// toward 1.30, a poor one toward 0.90; a neutral 2.5★ at full coverage is exactly 1.0 (no change).
function factorFrom(club: ClubStaff, assignment: AssignmentJson, category: string): number {
  const coaches = assignedFrom(club, assignment, category);
  if (!coaches.length) return coachingFactorOf(club);
  const stars = starsFrom(coaches, category);
  const coverage = coverageFrom(club, coaches);
  return Math.max(0.90, Math.min(1.30, 1 + ((stars - 2.5) / 2.5) * 0.30 * coverage));
}
export function categoryCoachFactor(teamId: number, assignment: string | null, category: string): number {
  return factorFrom(loadClubStaff(teamId), assignment, category);
}

// A suggested category→coach assignment by specialty, for the staff screen's default view. Does NOT persist —
// development keeps using the flat coachingFactor until the manager explicitly saves an assignment.
function suggestFrom(club: ClubStaff): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  for (const c of club.rows) {
    if (c.role !== 'coach') continue;
    const spec = c.specialty ?? 'first_team_coach';
    const cats = spec === 'fitness_coach' ? ['Fitness']
      : spec === 'gk_coach' || spec === 'set_piece_coach' ? []   // GK / set-piece categories deferred in the MVP
      : spec === 'assistant_manager' ? ['Attacking', 'Possession', 'Defending', 'Fitness']
      : ['Attacking', 'Possession', 'Defending'];                // first_team_coach → the outfield categories
    for (const cat of cats) (map[cat] ??= []).push(c.id);
  }
  return map;
}
export function suggestCoachAssignment(teamId: number): Record<string, number[]> {
  return suggestFrom(loadClubStaff(teamId));
}

// The current persisted coach assignment (parsed), or null when unassigned (flat development — byte-identical).
export function getCoachAssignment(teamId: number): Record<string, number[]> | null {
  const row = db.prepare('SELECT coach_assignment FROM teams WHERE id = ?').get(teamId) as { coach_assignment: string | null } | undefined;
  if (!row?.coach_assignment) return null;
  try { return JSON.parse(row.coach_assignment) as Record<string, number[]>; } catch { return null; }
}

// Validate + persist a category→coach assignment (the manager's explicit choice — this is what ACTIVATES per-category
// development). Each category must be a real coaching category and each id a coach the club owns; anything else is
// dropped. An empty result stores NULL → reverts to the flat coachingFactor (byte-identical development).
export function saveCoachAssignment(teamId: number, assignment: Record<string, number[]> | null): { ok: boolean } {
  const own = new Set((db.prepare("SELECT id FROM staff WHERE team_id = ? AND role = 'coach'").all(teamId) as { id: number }[]).map(r => r.id));
  const clean: Record<string, number[]> = {};
  if (assignment && typeof assignment === 'object') {
    for (const cat of Object.keys(CATEGORY_COACH_ATTR)) {
      const ids = Array.isArray(assignment[cat]) ? assignment[cat].map(Number).filter(id => own.has(id)) : [];
      if (ids.length) clean[cat] = [...new Set(ids)];
    }
  }
  db.prepare('UPDATE teams SET coach_assignment = ? WHERE id = ?').run(Object.keys(clean).length ? JSON.stringify(clean) : null, teamId);
  return { ok: true };
}

// The 4-category coaching board for the staff screen: stars / coverage / development factor + the assigned coach ids.
export interface CategoryBoard { category: string; stars: number; coverage: number; factor: number; assigned: number[]; }
function boardFrom(club: ClubStaff, assignment: Record<string, number[]> | null): CategoryBoard[] {
  return Object.keys(CATEGORY_COACH_ATTR).map(category => {
    const coaches = assignedFrom(club, assignment, category);
    return {
      category,
      stars: starsFrom(coaches, category),
      coverage: coverageFrom(club, coaches),
      factor: factorFrom(club, assignment, category),
      assigned: assignment?.[category] ?? [],
    };
  });
}
export function categoryBoard(teamId: number): CategoryBoard[] {
  return boardFrom(loadClubStaff(teamId), getCoachAssignment(teamId));
}

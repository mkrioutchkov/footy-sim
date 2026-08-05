// AI managers (pillar 4). Each matchday every AI club makes management decisions so the
// league world manages itself: it sets a training focus and fields its strongest XI.
// (Transfers are the market's job — marketTick in market.ts signs the AI's weakest role
// and buys listed players.) Rule-based + cheap; no LLM in the hot path. AI-only — a human
// manager's training focus and hand-picked lineup are never touched.
import { db } from './db.ts';
import { overall, ROLE_SLOTS } from './game.ts';
import { TRAINABLE } from './training.ts';
import { seedStaffPool, hireStaff, suggestCoachAssignment, saveCoachAssignment, MAX_STAFF } from './staff.ts';

// Re-pack an AI squad so its strongest role-correct XI fills slots 0..10 (the default-path
// starting XI) and the rest sit on the bench. Each XI slot takes the best unused player of
// that slot's role, falling back to the best unused player of any role when there's no cover.
// Keeps AI sides fielding their best team as transfers + development reshape the squad.
export function optimizeLineup(teamId: number): void {
  const players = db.prepare('SELECT id, role, attrs FROM players WHERE team_id = ?').all(teamId) as { id: number; role: string; attrs: string }[];
  if (players.length < 11) return;
  const pool = players.map(p => ({ id: p.id, role: p.role, ovr: overall(JSON.parse(p.attrs), p.role) }));
  const used = new Set<number>();
  const order: number[] = [];                                   // player ids in slot order
  for (let i = 0; i < 11; i++) {
    const want = ROLE_SLOTS[i];
    const byRole = pool.filter(p => !used.has(p.id) && p.role === want);
    const pick = (byRole.length ? byRole : pool.filter(p => !used.has(p.id))).sort((a, b) => b.ovr - a.ovr)[0];
    used.add(pick.id); order.push(pick.id);
  }
  for (const p of pool.filter(p => !used.has(p.id)).sort((a, b) => b.ovr - a.ovr)) order.push(p.id);
  const upd = db.prepare('UPDATE players SET slot = ? WHERE id = ?');
  order.forEach((id, slot) => upd.run(slot, id));
}

// AI development philosophy (pillar-4, Phase 2). Each AI club carries a coaching_style that shapes
// how it develops — a developer pushes squad growth (specialises readily + builds a deep coaching
// staff), a conservation club plays it safe (steady balanced training, a lean backroom), balanced is
// the middle. The style is derived deterministically from the club id so a league shows a stable mix,
// and persisted into teams.coaching_style (the column the spec wires) the first time it's touched.
const AI_STYLES = ['developer', 'balanced', 'conservation'] as const;
export type CoachingStyle = (typeof AI_STYLES)[number];
const STYLE_COACH_TARGET: Record<CoachingStyle, number> = { developer: 3, balanced: 2, conservation: 1 };
const STYLE_FOCUS_GAP: Record<CoachingStyle, number> = { developer: 4, balanced: 8, conservation: 99 };  // gap needed before specialising (conservation never does)

export function aiCoachingStyle(teamId: number): CoachingStyle {
  const row = db.prepare('SELECT coaching_style, user_id FROM teams WHERE id = ?').get(teamId) as { coaching_style: string | null; user_id: number | null } | undefined;
  if (row && (row.coaching_style === 'developer' || row.coaching_style === 'balanced' || row.coaching_style === 'conservation') && row.coaching_style !== 'balanced') return row.coaching_style;
  // 'balanced'/NULL is the un-assigned default — give AI clubs a stable deterministic style derived from id.
  if (row && row.user_id == null) {
    const style = AI_STYLES[teamId % AI_STYLES.length];
    db.prepare('UPDATE teams SET coaching_style = ? WHERE id = ?').run(style, teamId);
    return style;
  }
  return 'balanced';
}

// An AI club trains its outfield XI's weakest attribute (shore up the gap), or 'balanced'
// when the squad is even. Excludes the keeper so his low shooting/passing doesn't skew it.
// A developer specialises on a smaller gap; a conservation club stays balanced (its philosophy).
export function pickTrainingFocus(teamId: number): string {
  const xi = db.prepare('SELECT attrs FROM players WHERE team_id = ? ORDER BY slot LIMIT 11').all(teamId) as { attrs: string }[];
  const outfield = xi.slice(1).map(p => JSON.parse(p.attrs) as Record<string, number>);
  if (outfield.length < 5) return 'balanced';
  // 'handling' is keeper-only (developAttrs gates it to GKs) and this scan is over the
  // OUTFIELD — including it made the keeper's skill a perpetual outfield trough, so the
  // AI's one specialisation pick could land on a focus no outfielder trains (_ai_test).
  const clubFoci = TRAINABLE.filter(k => k !== 'handling');
  const avg: Record<string, number> = {};
  for (const k of clubFoci) avg[k] = outfield.reduce((s, a) => s + (a[k] ?? 0), 0) / outfield.length;
  let lo: string = clubFoci[0], hi: string = clubFoci[0];
  for (const k of clubFoci) { if (avg[k] < avg[lo]) lo = k; if (avg[k] > avg[hi]) hi = k; }
  const gap = STYLE_FOCUS_GAP[aiCoachingStyle(teamId)];
  return (avg[hi] - avg[lo]) > gap ? lo : 'balanced';             // only specialise once the gap clears the style's threshold
}

// Closes "AI clubs are forever under-coached": an AI club builds a coaching staff so its squad
// develops through the SAME per-category coach factor a human club gets, instead of the flat
// no-staff identity. It hires up to its style's target of coaches when it can comfortably afford
// it (keeping a transfer cushion), then assigns them by specialty so per-category development
// activates. Idempotent — won't over-hire past the target, and re-assigns the current staff each
// time. A club with no hire pool (a legacy single-league world) is a safe no-op.
const AI_BUDGET_CUSHION = 8_000_000;   // leave this much for transfers before spending on staff
export function aiManagerStaff(teamId: number): void {
  const info = db.prepare('SELECT t.user_id AS user_id, t.budget AS budget, l.world_id AS world_id FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { user_id: number | null; budget: number; world_id: number | null } | undefined;
  if (!info || info.user_id != null || info.world_id == null) return;   // humans + pool-less worlds untouched
  const style = aiCoachingStyle(teamId);
  const target = STYLE_COACH_TARGET[style];
  seedStaffPool(info.world_id);
  const have = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE team_id = ? AND role = 'coach'").get(teamId) as { n: number };
  let budget = info.budget;
  let total = (db.prepare('SELECT COUNT(*) AS n FROM staff WHERE team_id = ?').get(teamId) as { n: number }).n;
  // hire the best AFFORDABLE pool coaches up to the style target (one per tick keeps spend gradual).
  if (have.n < target && total < MAX_STAFF) {
    const cand = db.prepare("SELECT id, cost FROM staff WHERE world_id = ? AND team_id IS NULL AND role = 'coach' AND cost <= ? ORDER BY rating DESC LIMIT 1")
      .get(info.world_id, Math.max(0, budget - AI_BUDGET_CUSHION)) as { id: number; cost: number } | undefined;
    if (cand) { const r = hireStaff(teamId, cand.id); if (r.ok) { budget -= cand.cost; total++; } }
  }
  // assign whatever coaches the club now has, by specialty, so the per-category factor drives development.
  const suggestion = suggestCoachAssignment(teamId);
  if (Object.keys(suggestion).length) saveCoachAssignment(teamId, suggestion);
}

// One management cycle for every AI club in a division: pick a training focus + field the
// strongest XI. Skips human-managed teams entirely.
export function aiManagerTick(leagueId: number): { teams: number } {
  const ais = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL').all(leagueId) as { id: number }[];
  for (const { id } of ais) {
    aiManagerStaff(id);          // build/assign a coaching staff so the AI squad isn't under-coached
    db.prepare('UPDATE teams SET training_focus = ? WHERE id = ?').run(pickTrainingFocus(id), id);
    optimizeLineup(id);
  }
  return { teams: ais.length };
}

// AI managers (pillar 4). Each matchday every AI club makes management decisions so the
// league world manages itself: it sets a training focus and fields its strongest XI.
// (Transfers are the market's job — marketTick in market.ts signs the AI's weakest role
// and buys listed players.) Rule-based + cheap; no LLM in the hot path. AI-only — a human
// manager's training focus and hand-picked lineup are never touched.
import { db } from './db.ts';
import { overall, ROLE_SLOTS } from './game.ts';
import { TRAINABLE } from './training.ts';

// Re-pack an AI squad so its strongest role-correct XI fills slots 0..10 (the default-path
// starting XI) and the rest sit on the bench. Each XI slot takes the best unused player of
// that slot's role, falling back to the best unused player of any role when there's no cover.
// Keeps AI sides fielding their best team as transfers + development reshape the squad.
export function optimizeLineup(teamId: number): void {
  const players = db.prepare('SELECT id, role, attrs FROM players WHERE team_id = ?').all(teamId) as { id: number; role: string; attrs: string }[];
  if (players.length < 11) return;
  const pool = players.map(p => ({ id: p.id, role: p.role, ovr: overall(JSON.parse(p.attrs)) }));
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

// An AI club trains its outfield XI's weakest attribute (shore up the gap), or 'balanced'
// when the squad is even. Excludes the keeper so his low shooting/passing doesn't skew it.
export function pickTrainingFocus(teamId: number): string {
  const xi = db.prepare('SELECT attrs FROM players WHERE team_id = ? ORDER BY slot LIMIT 11').all(teamId) as { attrs: string }[];
  const outfield = xi.slice(1).map(p => JSON.parse(p.attrs) as Record<string, number>);
  if (outfield.length < 5) return 'balanced';
  const avg: Record<string, number> = {};
  for (const k of TRAINABLE) avg[k] = outfield.reduce((s, a) => s + (a[k] ?? 0), 0) / outfield.length;
  let lo: string = TRAINABLE[0], hi: string = TRAINABLE[0];
  for (const k of TRAINABLE) { if (avg[k] < avg[lo]) lo = k; if (avg[k] > avg[hi]) hi = k; }
  return (avg[hi] - avg[lo]) > 8 ? lo : 'balanced';                // only specialise if there's a real gap
}

// One management cycle for every AI club in a division: pick a training focus + field the
// strongest XI. Skips human-managed teams entirely.
export function aiManagerTick(leagueId: number): { teams: number } {
  const ais = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL').all(leagueId) as { id: number }[];
  for (const { id } of ais) {
    db.prepare('UPDATE teams SET training_focus = ? WHERE id = ?').run(pickTrainingFocus(id), id);
    optimizeLineup(id);
  }
  return { teams: ais.length };
}

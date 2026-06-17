// Training / development (pillar 2). Between matchdays every player's attributes drift
// toward their potential, modulated by age and the professionalism/consistency traits,
// with the club's training focus nudging one attribute. Pure + deterministic: given
// (attrs, age, potential, traits, focus) the next-tick attrs are fixed, so a test can
// assert exact values. The tick fires once per matchday from /api/advance.
import { db } from './db.ts';
import { overall } from './game.ts';
import { moraleDevFactor } from './morale.ts';
import { coachingFactor } from './staff.ts';
import { getSquadHarmony, harmonyFactor } from './harmony.ts';

export const TRAINABLE = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'] as const;
export const VALID_FOCUS = new Set<string>(['balanced', ...TRAINABLE]);
const PHYSICAL = new Set<string>(['speed', 'stamina']);   // first to fade with age

// OVR points of drift per matchday before trait/focus scaling: growth while young,
// a prime plateau, then decline. TASTE: see GAME_LAYER_NOTES.md.
function ageDrift(age: number): number {
  if (age <= 20) return 1.5;
  if (age <= 23) return 1.0;
  if (age <= 27) return 0.5;
  if (age <= 30) return 0.0;
  if (age <= 33) return -0.6;
  return -1.2;
}

// Attributes after one matchday of training. Growth is capped by the headroom to
// potential (so a player converges on, never blows past, their ceiling); decline ignores
// headroom and hits the legs hardest; the focus attribute trains ~80% faster (only while
// the player still has room to grow). Stored to 1 decimal so sub-point progress isn't lost.
export function developAttrs(
  attrs: Record<string, number>, age: number, potential: number,
  traits: { professionalism?: number; consistency?: number } | null | undefined,
  focus: string | null, morale = 65, coachFactor = 1, harmonyF = 1,
): Record<string, number> {
  const prof = (traits?.professionalism ?? 50) / 100;
  const cons = (traits?.consistency ?? 50) / 100;
  const diligence = 0.6 + 0.8 * ((prof + cons) / 2);          // 0.6..1.4
  let drift = ageDrift(age) * diligence * moraleDevFactor(morale);   // age x diligence x morale
  if (drift > 0) drift *= coachFactor * harmonyF;             // good coaches + a settled room accelerate growth, not decline
  const move = drift >= 0 ? Math.min(drift, Math.max(0, potential - overall(attrs))) : drift;
  const out: Record<string, number> = { ...attrs };
  for (const k of TRAINABLE) {
    if (typeof out[k] !== 'number') continue;
    let d = move;
    if (move < 0 && PHYSICAL.has(k)) d *= 1.6;                                       // legs go first
    if (move > 0 && focus && focus !== 'balanced' && k === focus) d = move * 1.8;    // train this skill hard
    out[k] = Math.max(30, Math.min(95, Math.round((out[k] + d) * 10) / 10));
  }
  return out;
}

// Develop every player in a league one matchday. Not idempotent by design — it's a
// progression, fired once per /api/advance round. Skips any player whose potential is
// still NULL (backfillPotentials runs at startup to prevent that).
export function developmentTick(leagueId: number): { players: number } {
  const rows = db.prepare(`
    SELECT p.id, p.team_id AS team_id, p.attrs, p.age, p.potential, p.personality, p.morale, t.training_focus AS focus
    FROM players p JOIN teams t ON t.id = p.team_id
    WHERE t.league_id = ?`).all(leagueId) as
    { id: number; team_id: number; attrs: string; age: number; potential: number | null; personality: string | null; morale: number; focus: string | null }[];
  const upd = db.prepare('UPDATE players SET attrs = ? WHERE id = ?');
  const coachCache = new Map<number, number>();   // team -> coaching factor (1 for AI/no-staff clubs)
  const coachOf = (tid: number): number => { let v = coachCache.get(tid); if (v === undefined) { v = coachingFactor(tid); coachCache.set(tid, v); } return v; };
  const harmonyCache = new Map<number, number>(); // team -> harmony factor (1.0 for a settled squad)
  const harmonyOf = (tid: number): number => { let v = harmonyCache.get(tid); if (v === undefined) { const h = getSquadHarmony(tid); v = h ? harmonyFactor(h.harmony) : 1; harmonyCache.set(tid, v); } return v; };
  let n = 0;
  for (const r of rows) {
    if (r.potential == null) continue;
    let traits: { professionalism?: number; consistency?: number } | null = null;
    try { traits = r.personality ? (JSON.parse(r.personality).traits ?? null) : null; } catch { /* neutral */ }
    upd.run(JSON.stringify(developAttrs(JSON.parse(r.attrs), r.age, r.potential, traits, r.focus, r.morale, coachOf(r.team_id), harmonyOf(r.team_id))), r.id);
    n++;
  }
  return { players: n };
}

export function setTrainingFocus(teamId: number, focus: string): { ok: boolean; focus: string } {
  const f = VALID_FOCUS.has(focus) ? focus : 'balanced';
  db.prepare('UPDATE teams SET training_focus = ? WHERE id = ?').run(f, teamId);
  return { ok: true, focus: f };
}

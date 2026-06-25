// Training / development (pillar 2). Between matchdays every player's attributes drift
// toward their potential, modulated by age and the professionalism/consistency traits,
// with the club's training focus nudging one attribute. Pure + deterministic: given
// (attrs, age, potential, traits, focus) the next-tick attrs are fixed, so a test can
// assert exact values. The tick fires once per matchday from /api/advance.
//
// Audit §2.7: the tick now also records a per-matchday training REPORT for human-managed
// clubs (attribute drift per player + the factors that drove it), each player can carry an
// individual focus that overrides the club focus, and a 'position' focus biases growth toward
// the attributes that matter for a player's role. The numeric drift for the pre-§2.7 inputs
// ('balanced' / a single-attribute focus, no role) is BYTE-IDENTICAL, so existing saves and the
// engine-free regressions are unaffected.
import { db } from './db.ts';
import { overall } from './game.ts';
import { moraleDevFactor } from './morale.ts';
import { coachingFactor, categoryCoachFactor } from './staff.ts';
import { getSquadHarmony, harmonyFactor } from './harmony.ts';

export const TRAINABLE = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'] as const;
// 'position' = role-matched drills (audit §2.7); the rest are the club-wide foci.
export const VALID_FOCUS = new Set<string>(['balanced', 'position', ...TRAINABLE]);
const PHYSICAL = new Set<string>(['speed', 'stamina']);   // first to fade with age

// ── Training & Coaches: categories, determinism anchor, intensity (the FM-style development feature) ──
// The four MVP coaching categories live in CODE (not a table) so the attrs→spec→engine flow is untouched.
// Each maps onto the trainable attrs; a specialist coach in a category accelerates exactly those attrs.
export const CATEGORY_ATTRS: Record<string, readonly string[]> = {
  Attacking:  ['shooting', 'creativity'],
  Possession: ['passing', 'creativity'],
  Defending:  ['tackling', 'positioning'],
  Fitness:    ['speed', 'stamina'],
};
export const TRAINING_CATEGORIES = ['Attacking', 'Possession', 'Defending', 'Fitness'] as const;
// Each trainable attr's ONE primary category — used to resolve a player's coach factor from his focus.
export const ATTR_PRIMARY_CATEGORY: Record<string, string> = {
  shooting: 'Attacking', creativity: 'Possession', passing: 'Possession',
  tackling: 'Defending', positioning: 'Defending', speed: 'Fitness', stamina: 'Fitness',
};

// Deterministic growth quantum in [0,1) from a stable tuple — the determinism anchor for any NEW per-tick
// randomness (trait progression, future jitter). NEVER Math.random in the development path, so recordings,
// replays and the golden match stay byte-stable. FNV-1a over the tuple → 32-bit uint → [0,1).
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function seededGrowth(playerId: number, season: number, round: number, worldId: number): number {
  return (fnv1a(`${playerId}|${season}|${round}|${worldId}`) % 1_000_000) / 1_000_000;
}

// Training intensity → a growth / injury / load triple. 'normal' (and a legacy NULL) is the IDENTITY
// (growthMul 1, injuryMul 1, loadAdd 0) so the default development path stays byte-identical; harder
// training grows faster but raises injury risk + load, lighter/rest trades growth for recovery.
export type TrainIntensity = 'double' | 'normal' | 'half' | 'rest';
export interface IntensityFactors { growthMul: number; injuryMul: number; loadAdd: number; }
export function intensityFactor(level: string | null | undefined): IntensityFactors {
  switch (level) {
    case 'double': return { growthMul: 1.4, injuryMul: 1.6, loadAdd: 15 };
    case 'half':   return { growthMul: 0.6, injuryMul: 0.6, loadAdd: -8 };
    case 'rest':   return { growthMul: 0.0, injuryMul: 0.3, loadAdd: -20 };
    default:       return { growthMul: 1.0, injuryMul: 1.0, loadAdd: 0 };   // 'normal' / NULL = identity
  }
}

// Phase 2: the CLUB-WIDE training intensity dial (a gentler scale than the per-player override). 'normal'
// (and a legacy NULL) is the IDENTITY so the default development + injury path stays byte-identical; the
// whole squad trains harder/lighter unless a player carries his own per-player intensity (which wins).
export type TeamIntensity = 'light' | 'normal' | 'heavy';
export const VALID_TEAM_INTENSITY = new Set<string>(['light', 'normal', 'heavy']);
export function teamIntensityFactor(level: string | null | undefined): IntensityFactors {
  switch (level) {
    case 'light': return { growthMul: 0.7, injuryMul: 0.8, loadAdd: -6 };
    case 'heavy': return { growthMul: 1.4, injuryMul: 1.4, loadAdd: 10 };
    default:      return { growthMul: 1.0, injuryMul: 1.0, loadAdd: 0 };    // 'normal' / NULL = identity
  }
}
// The effective intensity for a player: his per-player override (double|half|rest) if set, else the club
// dial (light|heavy). Both default to identity, so an un-touched club is byte-identical to before Phase 2.
export function resolveIntensity(playerLevel: string | null | undefined, teamLevel: string | null | undefined): IntensityFactors {
  if (playerLevel && VALID_INTENSITY.has(playerLevel)) return intensityFactor(playerLevel);
  return teamIntensityFactor(teamLevel);
}

// Phase 2: one-click training SCHEDULES — a named (focus + club-intensity) combo, FM's preset buttons.
// Each is just a shortcut over the two existing controls (no new development math), so 'balanced'/normal
// is the byte-identical default. The focus values are all in VALID_FOCUS; the intensity in VALID_TEAM_INTENSITY.
export interface TrainingPreset { focus: string; intensity: TeamIntensity; label: string; }
export const TRAINING_PRESETS: Record<string, TrainingPreset> = {
  balanced:   { focus: 'balanced', intensity: 'normal', label: 'Balanced' },
  attacking:  { focus: 'shooting', intensity: 'normal', label: 'Attacking' },
  possession: { focus: 'passing',  intensity: 'normal', label: 'Possession' },
  defending:  { focus: 'tackling', intensity: 'normal', label: 'Defending' },
  fitness:    { focus: 'stamina',  intensity: 'heavy',  label: 'Fitness' },     // build conditioning hard
  recovery:   { focus: 'balanced', intensity: 'light',  label: 'Recovery' },    // taper / freshen the legs
};
export function resolvePreset(name: string): TrainingPreset | null {
  return Object.prototype.hasOwnProperty.call(TRAINING_PRESETS, name) ? TRAINING_PRESETS[name] : null;
}
// Apply a preset = set both the club focus + the club intensity dial in one write (the per-player
// overrides are untouched — a preset is a club-wide schedule). Returns the resolved preset.
export function applyTrainingPreset(teamId: number, name: string): { ok: boolean; preset?: TrainingPreset; error?: string } {
  const p = resolvePreset(name);
  if (!p) return { ok: false, error: 'unknown preset' };
  setTrainingFocus(teamId, p.focus);
  setTeamTrainingIntensity(teamId, p.intensity);
  return { ok: true, preset: p };
}

// The trainable attributes that matter most for each role — a 'position' focus concentrates
// growth here (and de-emphasises the rest), so a striker sharpens his shooting and a centre-back
// his defending rather than spreading thin. Keys outside TRAINABLE (e.g. a keeper's handling) are
// not trainable here, so a role leans on the trainable attributes closest to its job.
const ROLE_KEY: Record<string, readonly string[]> = {
  GK: ['positioning', 'speed'],
  FB: ['speed', 'stamina', 'tackling', 'positioning'],
  CB: ['tackling', 'positioning', 'stamina'],
  CM: ['passing', 'creativity', 'stamina', 'positioning'],
  WM: ['speed', 'creativity', 'passing', 'stamina'],
  CF: ['shooting', 'speed', 'creativity'],
};

// Per-attribute multipliers for a 'position' focus. A focused player develops faster than a balanced
// one (specialisation) — exactly as a single-attribute focus already does: a single focus pours a
// +0.8×move bonus into ONE attribute (the legacy 1.8× = 1.0 baseline + 0.8) on top of every
// attribute's full 1.0×. 'position' delivers the SAME total bonus but SPREADS it across the role's
// key attributes, lifting the whole role profile instead of one skill; the non-key attributes keep
// their full 1.0× (never clawed back). So balanced / single-attr / position are genuine trade-offs —
// the two focused options grow the same total OVR, distributed differently — rather than one strictly
// dominating another. Returns null for an unknown role → no weighting (identity), so the caller is safe.
const FOCUS_BONUS = 0.8;                          // a single-attr focus is 1.8× = 1.0 baseline + this bonus
function positionWeights(role: string | undefined): Record<string, number> | null {
  const keys = role ? ROLE_KEY[role] : undefined;
  if (!keys || !keys.length) return null;
  const key = new Set<string>(keys);
  const keyW = 1 + FOCUS_BONUS / key.size;        // the shared focus bonus, split evenly across the role's keys
  const out: Record<string, number> = {};
  for (const k of TRAINABLE) out[k] = key.has(k) ? keyW : 1;
  return out;
}

// A player's primary training category — from his focus when it's a specific attr, else his role's dominant
// category (used only to look up the per-category coach factor for a club that has assigned coaches).
function primaryCategoryOf(focus: string, role: string | undefined): string {
  const direct = ATTR_PRIMARY_CATEGORY[focus];
  if (direct) return direct;
  const keys = role ? ROLE_KEY[role] : undefined;            // balanced/position → the role's most-common category
  if (keys && keys.length) {
    const counts: Record<string, number> = {};
    for (const k of keys) { const c = ATTR_PRIMARY_CATEGORY[k]; if (c) counts[c] = (counts[c] ?? 0) + 1; }
    let best = 'Fitness', bestN = 0;
    for (const c of Object.keys(counts)) if (counts[c] > bestN) { best = c; bestN = counts[c]; }
    return best;
  }
  return 'Fitness';
}

// Burnout (Phase 2): accumulated training_load taps the brakes on development once it passes a
// threshold — over-training a squad on 'heavy'/'double' for weeks yields diminishing returns (on top of
// the higher injury risk). Load 0 (the default) is the IDENTITY (1.0), so an un-pushed squad is unaffected.
export const LOAD_DECAY = 0.8;             // each matchday a player bleeds 20% of his accumulated load
export function loadDampen(load: number): number {
  if (load <= 40) return 1;                                  // a manageable load costs nothing
  return Math.max(0.6, 1 - (load - 40) / 150);              // load 40→1.0 … 100→0.6 (floored)
}

// Position retrain (Phase 2): a player learning a NEW role is unsettled — he develops a touch slower until
// he's comfortable, and his role_familiarity climbs each matchday (faster between related roles). Familiarity
// 100 (the default) = fully settled → penalty 1.0, so a squad that never retrains is byte-identical.
export const RETRAIN_ROLES = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'] as const;
export const RETRAIN_START_FAMILIARITY = 25;   // a fresh retrainee starts here and climbs
const ROLE_BAND: Record<string, string> = { GK: 'GK', FB: 'D', CB: 'D', CM: 'M', WM: 'M', CF: 'A' };
// familiarity gained per matchday while retraining — a switch within a band (FB↔CB) settles faster than across (CB→CF).
export function roleAdaptation(oldRole: string | undefined, newRole: string): number {
  if (!oldRole || oldRole === newRole) return 12;
  return ROLE_BAND[oldRole] === ROLE_BAND[newRole] ? 9 : 5;
}
// growth multiplier while adapting: 0% familiar → 0.7×, fully settled (100) → 1.0× (identity).
export function retrainPenalty(familiarity: number): number {
  const f = Math.max(0, Math.min(100, familiarity));
  return 0.7 + 0.3 * (f / 100);
}

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
  role?: string, growthMul = 1, loadDampenF = 1, retrainPenaltyF = 1,
): Record<string, number> {
  const prof = (traits?.professionalism ?? 50) / 100;
  const cons = (traits?.consistency ?? 50) / 100;
  const diligence = 0.6 + 0.8 * ((prof + cons) / 2);          // 0.6..1.4
  let drift = ageDrift(age) * diligence * moraleDevFactor(morale);   // age x diligence x morale
  // growthMul = training intensity (1 = normal/identity); coaches + a settled room accelerate growth, not
  // decline; loadDampenF (1 = no burnout) trims gains when load is high; retrainPenaltyF (1 = settled) trims
  // gains while a player adapts to a new role. All default to 1.
  if (drift > 0) drift *= growthMul * coachFactor * harmonyF * loadDampenF * retrainPenaltyF;
  const move = drift >= 0 ? Math.min(drift, Math.max(0, potential - overall(attrs))) : drift;
  // A 'position' focus weights growth by role (spreads a single focus's bonus across the role's key
  // attributes); any other focus keeps the original single-attribute path → byte-identical drift for
  // pre-§2.7 inputs.
  const posW = move > 0 && focus === 'position' ? positionWeights(role) : null;
  const out: Record<string, number> = { ...attrs };
  for (const k of TRAINABLE) {
    if (typeof out[k] !== 'number') continue;
    let d = move;
    if (move < 0 && PHYSICAL.has(k)) d *= 1.6;                                       // legs go first
    if (move > 0) {
      if (posW) d = move * posW[k];                                                  // role-matched drills
      else if (focus && focus !== 'balanced' && k === focus) d = move * 1.8;         // train this skill hard
    }
    out[k] = Math.max(30, Math.min(95, Math.round((out[k] + d) * 10) / 10));
  }
  return out;
}

// ── Training report (audit §2.7) ────────────────────────────────────────────
export interface TrainAttrDelta { key: string; before: number; after: number; delta: number; }
export interface TrainLine {
  slot: number; name: string; role: string;
  age: number; focus: string;            // the EFFECTIVE focus (player override or club focus)
  individual: boolean;                   // true if the player carries his own focus
  ovrBefore: number; ovrAfter: number; ovrDelta: number;
  attrs: TrainAttrDelta[];               // attributes that actually moved (largest first)
  factors: string[];                     // the plain-English "why" behind the drift
}

// The plain-English drivers behind a player's drift this matchday — the "why did X improve" the
// audit asked for. Pure: derived from the same inputs developAttrs saw, so the explanation can't
// drift from the numbers. Order roughly mirrors impact (age phase first, then the modifiers).
function trainingFactors(
  age: number, traits: { professionalism?: number; consistency?: number } | null | undefined,
  focus: string, morale: number, coachFactor: number, harmonyF: number, growing: boolean, loadDampenF = 1,
): string[] {
  const f: string[] = [];
  f.push(age <= 20 ? 'Young — rapid growth' : age <= 23 ? 'Developing' : age <= 27 ? 'Approaching prime'
    : age <= 30 ? 'In his peak years' : age <= 33 ? 'Past 30 — starting to decline' : 'Veteran in decline');
  const dil = ((traits?.professionalism ?? 50) + (traits?.consistency ?? 50)) / 2;
  if (dil >= 75) f.push('Model professional — learns fast');
  else if (dil <= 35) f.push('Poor application holds him back');
  if (morale >= 80) f.push('Buoyant mood lifts his work');
  else if (morale < 50) f.push('Low morale is stalling progress');
  if (growing && coachFactor > 1) f.push(`Coaching staff +${Math.round((coachFactor - 1) * 100)}%`);
  if (growing && harmonyF > 1) f.push('Settled dressing room');
  else if (growing && harmonyF < 1) f.push('Unsettled dressing room drags');
  if (growing && focus === 'position') f.push('Position-specific drills');
  else if (growing && focus && focus !== 'balanced') f.push(`Focused on ${focus}`);
  if (growing && loadDampenF < 1) f.push(`Heavy workload — gains tapering (−${Math.round((1 - loadDampenF) * 100)}%)`);
  return f;
}

// Build one player's report line by diffing the attrs developAttrs produced against the originals.
export function explainTraining(
  before: Record<string, number>, after: Record<string, number>,
  p: { slot: number; name: string; role: string }, age: number,
  traits: { professionalism?: number; consistency?: number } | null | undefined,
  focus: string, individual: boolean, morale: number, coachFactor: number, harmonyF: number, loadDampenF = 1,
): TrainLine {
  const ovrBefore = overall(before), ovrAfter = overall(after);
  const attrs: TrainAttrDelta[] = [];
  for (const k of TRAINABLE) {
    if (typeof before[k] !== 'number' || typeof after[k] !== 'number') continue;
    const delta = Math.round((after[k] - before[k]) * 10) / 10;
    if (delta !== 0) attrs.push({ key: k, before: before[k], after: after[k], delta });
  }
  attrs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    slot: p.slot, name: p.name, role: p.role, age, focus, individual,
    ovrBefore, ovrAfter, ovrDelta: ovrAfter - ovrBefore,
    attrs,
    factors: trainingFactors(age, traits, focus, morale, coachFactor, harmonyF, ovrAfter >= ovrBefore, loadDampenF),
  };
}

// Develop every player in a league one matchday. Not idempotent by design — it's a
// progression, fired once per /api/advance round. Skips any player whose potential is
// still NULL (backfillPotentials runs at startup to prevent that). For human-managed clubs
// it also records a training report (the latest per club is kept) so the manager can see why
// each player moved.
export function developmentTick(leagueId: number): { players: number } {
  const rows = db.prepare(`
    SELECT p.id, p.team_id AS team_id, p.slot, p.name, p.role, p.attrs, p.age, p.potential,
           p.personality, p.morale, p.train_focus AS player_focus, p.train_intensity AS train_intensity,
           p.training_load AS training_load, p.retrain_role AS retrain_role, p.role_familiarity AS role_familiarity,
           t.user_id AS user_id, t.training_focus AS focus, t.coach_assignment AS coach_assignment,
           t.training_intensity AS team_intensity
    FROM players p JOIN teams t ON t.id = p.team_id
    WHERE t.league_id = ?
    ORDER BY p.team_id, p.slot`).all(leagueId) as
    { id: number; team_id: number; slot: number; name: string; role: string; attrs: string; age: number;
      potential: number | null; personality: string | null; morale: number; player_focus: string | null;
      train_intensity: string | null; training_load: number | null; retrain_role: string | null; role_familiarity: number | null;
      user_id: number | null; focus: string | null; coach_assignment: string | null;
      team_intensity: string | null }[];
  const upd = db.prepare('UPDATE players SET attrs = ?, training_load = ? WHERE id = ?');
  const retrainUpd = db.prepare('UPDATE players SET role = ?, retrain_role = ?, role_familiarity = ? WHERE id = ?');
  const coachCache = new Map<number, number>();   // team -> coaching factor (1 for AI/no-staff clubs)
  const coachOf = (tid: number): number => { let v = coachCache.get(tid); if (v === undefined) { v = coachingFactor(tid); coachCache.set(tid, v); } return v; };
  const harmonyCache = new Map<number, number>(); // team -> harmony factor (1.0 for a settled squad)
  const harmonyOf = (tid: number): number => { let v = harmonyCache.get(tid); if (v === undefined) { const h = getSquadHarmony(tid); v = h ? harmonyFactor(h.harmony) : 1; harmonyCache.set(tid, v); } return v; };
  const catFactorCache = new Map<string, number>();   // `${team}|${category}` -> per-category coach factor (assigned clubs only)
  const categoryFactorOf = (tid: number, assignment: string, cat: string): number => {
    const key = `${tid}|${cat}`; let v = catFactorCache.get(key);
    if (v === undefined) { v = categoryCoachFactor(tid, assignment, cat); catFactorCache.set(key, v); }
    return v;
  };
  // Collect report lines per human-managed team as we develop their players.
  const reports = new Map<number, { focus: string; lines: TrainLine[] }>();
  let n = 0;
  for (const r of rows) {
    if (r.potential == null) continue;
    let traits: { professionalism?: number; consistency?: number } | null = null;
    try { traits = r.personality ? (JSON.parse(r.personality).traits ?? null) : null; } catch { /* neutral */ }
    const before = JSON.parse(r.attrs) as Record<string, number>;
    const clubFocus = r.focus ?? 'balanced';
    const focus = r.player_focus ?? clubFocus;       // a per-player focus overrides the club focus
    // Coach factor: an assigned, human-managed club uses the per-category specialist factor; everyone else
    // (unassigned, AI, legacy) falls back to the flat club-wide factor — byte-identical to before this feature.
    const coachF = (r.coach_assignment != null && r.user_id != null)
      ? categoryFactorOf(r.team_id, r.coach_assignment, primaryCategoryOf(focus, r.role))
      : coachOf(r.team_id);
    const harmonyF = harmonyOf(r.team_id);
    const iFac = resolveIntensity(r.train_intensity, r.team_intensity);   // player override else club dial; both default to identity
    const load = r.training_load ?? 0;
    const dampen = loadDampen(load);                                      // burnout: high accumulated load trims this tick's gains (1 = none)
    const retrainPen = r.retrain_role ? retrainPenalty(r.role_familiarity ?? 100) : 1;   // unsettled players develop a little slower (1 = settled)
    const after = developAttrs(before, r.age, r.potential, traits, focus, r.morale, coachF, harmonyF, r.role, iFac.growthMul, dampen, retrainPen);
    // accrue/bleed the load: it decays each matchday and rises with the intensity's loadAdd (0 at normal).
    const nextLoad = Math.max(0, Math.min(120, load * LOAD_DECAY + iFac.loadAdd));
    upd.run(JSON.stringify(after), nextLoad, r.id);
    // position retrain: climb familiarity in the target role; once fully comfortable, commit the new role.
    if (r.retrain_role) {
      const fam = Math.min(100, (r.role_familiarity ?? 0) + roleAdaptation(r.role, r.retrain_role));
      if (fam >= 100) retrainUpd.run(r.retrain_role, null, 100, r.id);   // settled — he IS a <new role> now
      else retrainUpd.run(r.role, r.retrain_role, fam, r.id);            // still adapting
    }
    n++;
    if (r.user_id != null) {
      let rep = reports.get(r.team_id);
      if (!rep) { rep = { focus: clubFocus, lines: [] }; reports.set(r.team_id, rep); }
      rep.lines.push(explainTraining(before, after, r, r.age, traits, focus, r.player_focus != null, r.morale, coachF, harmonyF, dampen));
    }
  }
  if (reports.size) {
    const round = (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ? AND played = 1').get(leagueId) as { r: number | null }).r ?? 0;
    const season = (db.prepare('SELECT season FROM leagues WHERE id = ?').get(leagueId) as { season: number } | undefined)?.season ?? 1;
    for (const [teamId, rep] of reports) recordTrainingReport(teamId, season, round, rep.focus, rep.lines, coachOf(teamId), harmonyOf(teamId));
  }
  return { players: n };
}

// Persist (and prune to) the latest training report for a club. Latest-only keeps the table tiny
// and matches the screen (which shows the most recent session).
function recordTrainingReport(teamId: number, season: number, round: number, teamFocus: string, lines: TrainLine[], coachFactor: number, harmonyF: number): void {
  db.prepare('DELETE FROM training_reports WHERE team_id = ?').run(teamId);
  db.prepare(`INSERT INTO training_reports (team_id, season, round, team_focus, coach_factor, harmony_factor, lines, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(teamId, season, round, teamFocus, coachFactor, harmonyF, JSON.stringify(lines), Date.now());
}

export interface TrainingReport {
  season: number; round: number; teamFocus: string; coachBoost: number; harmonyFactor: number; lines: TrainLine[];
}

// The latest training report for a club (null until the first matchday develops the squad).
export function getTrainingReport(teamId: number): TrainingReport | null {
  const row = db.prepare('SELECT season, round, team_focus, coach_factor, harmony_factor, lines FROM training_reports WHERE team_id = ? ORDER BY id DESC LIMIT 1')
    .get(teamId) as { season: number; round: number; team_focus: string; coach_factor: number; harmony_factor: number; lines: string } | undefined;
  if (!row) return null;
  let lines: TrainLine[] = [];
  try { lines = JSON.parse(row.lines) as TrainLine[]; } catch { lines = []; }
  return {
    season: row.season, round: row.round, teamFocus: row.team_focus,
    coachBoost: Math.round((row.coach_factor - 1) * 100), harmonyFactor: row.harmony_factor, lines,
  };
}

export function setTrainingFocus(teamId: number, focus: string): { ok: boolean; focus: string } {
  const f = VALID_FOCUS.has(focus) ? focus : 'balanced';
  db.prepare('UPDATE teams SET training_focus = ? WHERE id = ?').run(f, teamId);
  return { ok: true, focus: f };
}

// Per-player focus (audit §2.7). '' / 'club' / an invalid value clears the override (the player
// follows the club focus again); any valid focus is stored. Returns the stored value (null = follows
// the club). Scoped to the caller's squad by the slot lookup, so a bad slot is a silent no-op.
export function setPlayerTrainingFocus(teamId: number, slot: number, focus: string): { ok: boolean; focus: string | null } {
  const clear = focus === '' || focus === 'club' || !VALID_FOCUS.has(focus);
  const f = clear ? null : focus;
  const res = db.prepare('UPDATE players SET train_focus = ? WHERE team_id = ? AND slot = ?').run(f, teamId, slot);
  if (!res.changes) return { ok: false, focus: null };
  return { ok: true, focus: f };
}

export const VALID_INTENSITY = new Set<string>(['double', 'normal', 'half', 'rest']);
// Per-player training intensity. '' / 'normal' / invalid → NULL (the normal default → byte-identical growth + injury).
// Scoped to the caller's squad by the slot lookup, so a bad slot is a silent no-op.
export function setPlayerTrainingIntensity(teamId: number, slot: number, value: string): { ok: boolean; intensity: string | null } {
  const clear = value === '' || value === 'normal' || !VALID_INTENSITY.has(value);
  const v = clear ? null : value;
  const res = db.prepare('UPDATE players SET train_intensity = ? WHERE team_id = ? AND slot = ?').run(v, teamId, slot);
  if (!res.changes) return { ok: false, intensity: null };
  return { ok: true, intensity: v };
}

// The CLUB-WIDE training intensity dial (Phase 2). An invalid value falls back to 'normal' (the
// byte-identical default). The whole squad trains at this level unless a player has his own override.
export function setTeamTrainingIntensity(teamId: number, level: string): { ok: boolean; intensity: string } {
  const v = VALID_TEAM_INTENSITY.has(level) ? level : 'normal';
  db.prepare('UPDATE teams SET training_intensity = ? WHERE id = ?').run(v, teamId);
  return { ok: true, intensity: v };
}

// Start (or clear) a position RETRAIN for one player (Phase 2). An empty value, an invalid role, or the
// player's CURRENT role clears the retrain (he settles, familiarity back to 100 → byte-identical growth).
// A valid different role starts the retrain from a low familiarity that climbs each matchday. Scoped to the
// caller's squad by the slot lookup, so a bad slot is a silent no-op.
export function setPlayerRetrain(teamId: number, slot: number, role: string): { ok: boolean; retrainRole: string | null } {
  const p = db.prepare('SELECT id, role FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number; role: string } | undefined;
  if (!p) return { ok: false, retrainRole: null };
  const clear = role === '' || role === p.role || !(RETRAIN_ROLES as readonly string[]).includes(role);
  if (clear) { db.prepare('UPDATE players SET retrain_role = NULL, role_familiarity = 100 WHERE id = ?').run(p.id); return { ok: true, retrainRole: null }; }
  db.prepare('UPDATE players SET retrain_role = ?, role_familiarity = ? WHERE id = ?').run(role, RETRAIN_START_FAMILIARITY, p.id);
  return { ok: true, retrainRole: role };
}

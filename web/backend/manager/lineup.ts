// manager_ai — DETERMINISTIC formation + XI selection (no rng / no Math.random / no LLM).
//
// The two heuristic decisions that write `teams.formation` + `teams.lineup`:
//   1. pickFormation — choose a FORMATIONS key that suits the squad's SHAPE + STRENGTH.
//   2. buildXI       — fill that formation's 11 slots with the best role-fit players,
//      producing the int[11] mapping (formationSlot -> squad-slot index) specForTeam reads.
//
// Both are pure functions of the squad (passed in), so a synchronous caller can run them
// without ever touching the LLM, and a deterministic match sim can never drift on replay.
// We REUSE buildLineup + roleFit (lineup.ts / formations.ts) for the assignment so the same
// role-fit logic the human's lineup compiler uses also drives the AI — no duplicate model.
import { FORMATIONS, DEFAULT_FORMATION, roleFit, type Slot } from '../formations.ts';
import { buildLineup, type Squad } from '../lineup.ts';
import type { PlayerRow } from '../game.ts';
import type { Role } from '../game.ts';

// A compact view of one squad player the heuristic needs. Built from getTeamWithPlayers'
// PlayerRow, but kept minimal so the heuristic is trivially unit-testable in isolation.
export interface ManagerPlayer { name: string; role: string; attrs: Record<string, number>; }

const toSquad = (players: ManagerPlayer[]): Squad => ({
  players: players.map(p => ({ name: p.name, role: p.role, attrs: p.attrs })),
});

// How well a whole squad fits a given formation: the total role-fit of its OPTIMAL
// assignment to that shape's slots (i.e. the assignment buildXI would make). The keeper
// slot (0) is excluded — every shape has exactly one GK, so it never discriminates.
// Higher = the squad's strengths line up with where this shape needs them.
function squadFitForShape(players: ManagerPlayer[], slots: Slot[]): number {
  // Greedy max-fit over the 11 outfield+GK slots, mirroring lineup.ts assign(): take the
  // highest (slot,player) role-fit pair repeatedly. Deterministic (stable tie-break on index).
  const xi = players.slice(0, 11);
  if (xi.length < 11) return -1;
  const pairs: { si: number; pi: number; fit: number }[] = [];
  for (let si = 1; si < slots.length; si++) {        // skip GK slot 0
    for (let pi = 0; pi < xi.length; pi++) {
      pairs.push({ si, pi, fit: roleFit(xi[pi].attrs, slots[si].role) });
    }
  }
  // stable: higher fit first, then lower slot, then lower player — fully deterministic
  pairs.sort((a, b) => b.fit - a.fit || a.si - b.si || a.pi - b.pi);
  const usedS = new Set<number>([0]);
  const usedP = new Set<number>();
  let total = 0;
  for (const p of pairs) {
    if (usedS.has(p.si) || usedP.has(p.pi)) continue;
    usedS.add(p.si); usedP.add(p.pi); total += p.fit;
  }
  return total;
}

// Count squad players whose STORED role is in a family — informs the shape choice so we
// don't pick a back-three shape for a squad full of full-backs, etc.
function roleCount(players: ManagerPlayer[], roles: Set<string>): number {
  return players.slice(0, Math.min(players.length, 16)).filter(p => roles.has(p.role)).length;
}

// The candidate shapes the AI manager will consider — a sane, well-formed spread (NOT the
// whole auto-generated registry, which includes deliberately silly 6-0-4 / 5-5-0 shapes
// the AI should never field). Ordered; ties break toward the EARLIER (more orthodox) shape.
const CANDIDATE_FORMATIONS = [
  '4-3-3', '4-2-3-1', '4-4-2', '4-1-2-1-2', '4-5-1',
  '3-5-2', '3-4-3', '5-3-2', '5-4-1', '4-4-1-1',
] as const;

// Choose the formation that best fits the squad. Deterministic: scores each candidate by
// total role-fit, with a small structural nudge so a squad with three natural centre-backs
// and no spare full-backs leans to a back-three, and a thin-at-the-back squad leans to a
// back-four. Falls back to the default 4-3-3 if nothing scores (an impossible <11 squad).
export function pickFormation(players: ManagerPlayer[]): string {
  const xi = players.slice(0, 11);
  if (xi.length < 11) return DEFAULT_FORMATION;
  const cbs = roleCount(players, new Set(['CB']));
  const fbs = roleCount(players, new Set(['FB']));
  const forwards = roleCount(players, new Set(['CF']));

  let best = DEFAULT_FORMATION, bestScore = -Infinity;
  for (const key of CANDIDATE_FORMATIONS) {
    const slots = FORMATIONS[key];
    if (!slots) continue;
    let score = squadFitForShape(xi, slots);
    if (score < 0) continue;
    // Structural nudges (small, so they only tip near-ties — role-fit stays primary):
    const backThree = slots.slice(1, 6).filter(s => s.role === 'CB').length >= 3 && slots.slice(1, 6).filter(s => s.role === 'FB').length <= 2;
    // a genuine surplus of centre-backs (4+) and few full-backs (<=1) -> reward a back three
    if (backThree && cbs >= 4 && fbs <= 1) score += 40;
    // plenty of full-backs but only two centre-backs -> reward a back four (penalise back three)
    if (backThree && fbs >= 3 && cbs <= 2) score -= 40;
    // two natural strikers available -> a small reward for a two-striker shape
    const twoUpTop = slots.filter(s => s.role === 'CF').length >= 2;
    if (twoUpTop && forwards >= 2) score += 20;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return best;
}

// Build the int[11] lineup for a chosen formation: formationSlot i -> squad-slot index.
// REUSES buildLineup (the same deterministic role-fit assignment the human's lineup compiler
// uses) with no manual overrides, so the AI fields its best role-correct XI for that shape.
// Returns null when the natural slot order already equals the identity XI on the DEFAULT shape
// (so we persist NULL and keep the byte-identical default path), else the explicit array.
export function buildXI(players: ManagerPlayer[], formationKey: string): number[] | null {
  const built = buildLineup(toSquad(players), formationKey, []);
  const lineup = built.slots.map(s => (s.fromSlot >= 0 ? s.fromSlot : 0));
  // Guard: if anything went wrong (a duplicate/-1), fall back to identity so the row stays legal.
  const seen = new Set(lineup);
  if (lineup.length !== 11 || seen.size !== 11 || lineup.some(n => n < 0 || n >= players.length)) {
    return players.length >= 11 ? Array.from({ length: 11 }, (_, i) => i) : null;
  }
  return lineup;
}

// Is this lineup the identity XI (slot i filled by squad player i)? specForTeam treats NULL
// as identity and emits the byte-identical default spec, so we persist NULL in that case.
export function isIdentityLineup(lineup: number[]): boolean {
  return lineup.every((v, i) => v === i);
}

// Re-export the PlayerRow -> ManagerPlayer projection so index.ts builds the heuristic input
// from the canonical getTeamWithPlayers shape in one place.
export function managerPlayers(rows: PlayerRow[]): ManagerPlayer[] {
  return rows.map(p => ({ name: p.name, role: p.role, attrs: p.attrs }));
}

// Re-export Role for callers that want it without importing game.ts directly.
export type { Role };

// Fitness & rotation guidance (audit §2.10). Read-only advice + a one-click swap. The match engine
// already punishes a manager who never rotates a tired squad — playing a low-fitness man carries a
// rising injury risk (fitness.ts startInjuryRisk) — but nothing surfaced that risk or suggested who to
// rest. This turns it into legible guidance: per-player fitness band + injury-risk %, and concrete
// "rest X, start Y" suggestions (a fitter bench player of the SAME role), with an apply that edits the
// stored XI directly (no LLM). Read functions are pure of side effects; applyRotation writes teams.lineup.
import { db } from './db.ts';
import { getTeamWithPlayers } from './game.ts';
import { startInjuryRisk } from './fitness.ts';
import { physioEffect } from './staff.ts';
import { DEFAULT_FORMATION } from './formations.ts';

export type FitnessBand = 'injured' | 'fresh' | 'ok' | 'tired' | 'exhausted';
const REST_THRESHOLD = 70;        // a non-injured starter below this is a rotation candidate
const SWAP_MARGIN = 12;           // a replacement must be at least this much fitter to be worth it

export interface RotationPlayer {
  slot: number; name: string; role: string; fitness: number; injured: boolean; injuredMatches: number;
  risk: number; band: FitnessBand; starter: boolean;
}
export interface RotationSuggestion {
  outSlot: number; outName: string; outFitness: number;
  inSlot: number; inName: string; inFitness: number;
  role: string; reason: string; urgent: boolean;
}
export interface RotationView {
  players: RotationPlayer[]; suggestions: RotationSuggestion[];
  atRisk: number; expectedInjuries: number; physioMitigation: number;
}

function bandOf(fitness: number, injured: boolean): FitnessBand {
  if (injured) return 'injured';
  if (fitness >= 85) return 'fresh';
  if (fitness >= REST_THRESHOLD) return 'ok';
  if (fitness >= 55) return 'tired';
  return 'exhausted';
}

// The squad slots that make up the intended XI: the stored lineup (formation slot -> squad slot) or
// the identity first-eleven. (Injured men in the XI are auto-subbed at kickoff, but the manager's
// INTENDED XI is what the guidance reasons about — that's what he can act on here.)
function xiSlots(lineup: number[] | null): Set<number> {
  return new Set(lineup ?? Array.from({ length: 11 }, (_, i) => i));
}

export function getRotationView(teamId: number): RotationView | null {
  const t = getTeamWithPlayers(teamId);
  if (!t) return null;
  const injuryMult = physioEffect(teamId).injuryMult;
  const xi = xiSlots(t.lineup);
  const players: RotationPlayer[] = t.players.map(p => {
    const injured = (p.injuredMatches ?? 0) > 0;
    const fitness = p.fitness ?? 100;
    return {
      slot: p.slot, name: p.name, role: p.role, fitness, injured, injuredMatches: p.injuredMatches ?? 0,
      risk: injured ? 0 : startInjuryRisk(fitness, injuryMult), band: bandOf(fitness, injured), starter: xi.has(p.slot),
    };
  });

  // Suggestions: each starter who is injured, or tired enough to be worth resting, paired with the
  // fittest unused bench player of the same role who is a clear upgrade. Neediest starters first, and a
  // bench player can only be offered once (no double-booking a single replacement against two starters).
  const bench = t.players.filter(p => !xi.has(p.slot) && (p.injuredMatches ?? 0) === 0);
  const usedBench = new Set<number>();
  const candidates = players
    .filter(p => p.starter && (p.injured || p.fitness < REST_THRESHOLD))
    .sort((a, b) => (a.injured === b.injured ? a.fitness - b.fitness : a.injured ? -1 : 1));
  const suggestions: RotationSuggestion[] = [];
  for (const s of candidates) {
    const minFit = s.injured ? 0 : s.fitness + SWAP_MARGIN;   // injured → any fit cover; tired → a clear upgrade
    const pick = bench
      .filter(b => b.role === s.role && !usedBench.has(b.slot) && (b.fitness ?? 100) >= minFit)
      .sort((a, b) => (b.fitness ?? 100) - (a.fitness ?? 100))[0];
    if (!pick) continue;
    usedBench.add(pick.slot);
    suggestions.push({
      outSlot: s.slot, outName: s.name, outFitness: s.fitness,
      inSlot: pick.slot, inName: pick.name, inFitness: pick.fitness ?? 100, role: s.role,
      urgent: s.injured,
      reason: s.injured
        ? `${s.name} is injured — ${pick.name} (${pick.fitness ?? 100}% fit) can cover at ${s.role}`
        : `${s.name} is down to ${s.fitness}% (${Math.round(startInjuryRisk(s.fitness, injuryMult) * 100)}% injury risk) — rest him for ${pick.name} (${pick.fitness ?? 100}%)`,
    });
  }

  const starters = players.filter(p => p.starter);
  return {
    players,
    suggestions,
    atRisk: starters.filter(p => p.injured || p.fitness < REST_THRESHOLD).length,
    expectedInjuries: Math.round(starters.reduce((s, p) => s + p.risk, 0) * 100) / 100,
    physioMitigation: Math.round((1 - injuryMult) * 100),
  };
}

// Swap one starter for one bench player in the stored XI (formation kept). Direct int[11] edit — no LLM,
// no formation change — so it's the cheap inverse of "set the whole lineup". Validates that out is in the
// XI and in is not, so the result stays a clean 11-permutation. Scoped to the caller's squad by teamId.
export function applyRotation(teamId: number, outSlot: number, inSlot: number): { ok: boolean; error?: string; lineup: number[] | null } {
  const t = getTeamWithPlayers(teamId);
  if (!t) return { ok: false, error: 'no team', lineup: null };
  const n = t.players.length;
  if (!Number.isInteger(outSlot) || !Number.isInteger(inSlot) || outSlot === inSlot) return { ok: false, error: 'pick two different players', lineup: t.lineup };
  if (outSlot < 0 || outSlot >= n || inSlot < 0 || inSlot >= n) return { ok: false, error: 'unknown player', lineup: t.lineup };
  const base = t.lineup ?? Array.from({ length: 11 }, (_, i) => i);   // formation slot -> squad slot
  const pos = base.indexOf(outSlot);
  if (pos < 0) return { ok: false, error: 'that player is not in your XI', lineup: t.lineup };
  if (base.includes(inSlot)) return { ok: false, error: 'that player is already in your XI', lineup: t.lineup };
  const next = base.slice();
  next[pos] = inSlot;
  // Storing the default 4-3-3 identity as NULL keeps the byte-identical spec path (mirrors PUT /api/lineup).
  const isDefault = (t.formation ?? DEFAULT_FORMATION) === DEFAULT_FORMATION && next.every((v, i) => v === i);
  db.prepare('UPDATE teams SET lineup = ? WHERE id = ?').run(isDefault ? null : JSON.stringify(next), teamId);
  return { ok: true, lineup: isDefault ? null : next };
}

// Injuries & match fitness (core stream). Each matchday the XI that played loses condition
// while the rest recover; standing injuries heal a matchday; then the players who started
// risk a fresh injury — a risk that RISES as their fitness falls, so a manager who never
// rotates a tired squad gets bitten. Injured players can't be selected (specForTeam draws
// the XI from fit men first), so depth + rotation matter. Fired once per matchday from
// /api/advance, BEFORE the market/AI ticks so "who played" reflects the XI as it lined up.
import { db } from './db.ts';
import { fieldedXIIndices } from './game.ts';
import { DEFAULT_FORMATION } from './formations.ts';
import { physioEffect } from './staff.ts';

const DRAIN_MIN = 10, DRAIN_VAR = 8;        // condition a starter loses (10..17)
const RECOVER = 20;                          // condition a rested player regains
const INJURY_BASE = 0.03, INJURY_TIRED = 0.10;   // per-start injury chance: 3% fresh, up to 13% exhausted
const INJURY_MIN = 1, INJURY_VAR = 5;        // matchdays sidelined (1..5)

export interface InjuryEvent { teamId: number; player: string; matches: number }

// The chance a fit starter picks up a fresh injury this matchday — rises as match fitness falls
// (3% fresh → 13% exhausted) then cut by the club's physios (injuryMult ≤ 1). THE single source of
// truth: fitnessTick rolls against exactly this, and the rotation guidance (rotation.ts) shows
// exactly this, so the warning can never diverge from the dice. Clamped to [0,1].
export function startInjuryRisk(fitness: number, injuryMult = 1): number {
  const f = Math.max(0, Math.min(100, fitness));
  return Math.max(0, Math.min(1, (INJURY_BASE + (1 - f / 100) * INJURY_TIRED) * injuryMult));
}

export function fitnessTick(leagueId: number): InjuryEvent[] {
  const events: InjuryEvent[] = [];
  const setFit = db.prepare('UPDATE players SET fitness = ? WHERE id = ?');
  const setInj = db.prepare('UPDATE players SET injured_matches = ? WHERE id = ?');
  for (const t of db.prepare('SELECT id, formation, lineup FROM teams WHERE league_id = ?').all(leagueId) as { id: number; formation: string | null; lineup: string | null }[]) {
    const id = t.id;
    const players = db.prepare('SELECT id, name, fitness, injured_matches FROM players WHERE team_id = ? ORDER BY slot').all(id) as
      { id: number; name: string; fitness: number; injured_matches: number }[];
    // who played = exactly the XI specForTeam fields — same shared selection (fieldedXIIndices), now
    // lineup-aware, so a rotated/custom XI drains the men who actually played, not the identity eleven.
    // Validate the stored lineup like getTeamWithPlayers (a clean 11-perm of valid squad indices, else
    // the identity XI), so the selection matches the match byte-for-byte.
    let lineup: number[] | null = null;
    try {
      const l = t.lineup ? JSON.parse(t.lineup) : null;
      if (Array.isArray(l) && l.length === 11) {
        const nums = l.map(Number);
        if (nums.every(n => Number.isInteger(n) && n >= 0 && n < players.length) && new Set(nums).size === 11) lineup = nums;
      }
    } catch { /* ignore — identity XI */ }
    const xiIdx = fieldedXIIndices(players, p => p.injured_matches > 0, t.formation ?? DEFAULT_FORMATION, lineup);
    const starterIds = new Set(xiIdx.map(i => players[i].id));
    const physio = physioEffect(id);   // identity (injuryMult 1, recoverBonus 0) for a club with no physios
    // 1. drain the starters, recover everyone else (a good physio recovers the rested faster)
    for (const p of players) {
      const next = starterIds.has(p.id) ? p.fitness - (DRAIN_MIN + Math.floor(Math.random() * DRAIN_VAR)) : p.fitness + RECOVER + physio.recoverBonus;
      setFit.run(Math.max(0, Math.min(100, next)), p.id);
    }
    // 2. standing injuries heal a matchday
    for (const p of players) if (p.injured_matches > 0) setInj.run(p.injured_matches - 1, p.id);
    // 3. fresh injuries for fit players who started — likelier the more tired they were, cut by physios
    //    (rolls against startInjuryRisk on their pre-match fitness — the same number the UI warns with)
    for (const p of players) {
      if (!starterIds.has(p.id) || p.injured_matches > 0) continue;
      if (Math.random() < startInjuryRisk(p.fitness, physio.injuryMult)) {
        const matches = INJURY_MIN + Math.floor(Math.random() * INJURY_VAR);
        setInj.run(matches, p.id);
        events.push({ teamId: id, player: p.name, matches });
      }
    }
  }
  return events;
}

// Pre-season: everyone reports back fit and fully recovered. Called at rollover.
export function resetFitness(leagueId: number): void {
  db.prepare('UPDATE players SET fitness = 100, injured_matches = 0 WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(leagueId);
}

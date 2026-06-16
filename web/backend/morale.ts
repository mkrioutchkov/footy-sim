// Morale (LLM stream). Persistent squad morale (0..100) that drifts with results and is moved
// by press conferences (morale.ts owns the result drift + the development effect; the press
// conference judging lives in press.ts). Morale modulates development — a happy squad improves
// faster, an unhappy one stalls. Neutral at the default 65 (dev factor exactly 1.0) so existing
// saves are unaffected.
import { db } from './db.ts';

// Development multiplier from morale: 65 -> 1.0, 100 -> 1.25, 0 -> ~0.54. TASTE — see notes.
export function moraleDevFactor(morale: number): number {
  return 1 + (Math.max(0, Math.min(100, morale)) - 65) / 35 * 0.25;
}

const RESULT = { win: 8, draw: 2, loss: -7 };
const DRIFT = 0.85;   // each matchday morale pulls 15% back toward neutral (50)

// Once per matchday: every club's squad morale drifts toward neutral and shifts with the
// latest league result (a win lifts the room, a defeat sours it). Per-player so a press
// conference's individual nudges persist relative to the team move. (Cup results don't move
// morale yet — a future refinement.)
export function moraleTick(leagueId: number): void {
  for (const { id } of db.prepare('SELECT id FROM teams WHERE league_id = ?').all(leagueId) as { id: number }[]) {
    const fx = db.prepare(`SELECT home_team_id, home_score, away_score FROM fixtures
      WHERE league_id = ? AND played = 1 AND (home_team_id = ? OR away_team_id = ?)
      ORDER BY round DESC, id DESC LIMIT 1`).get(leagueId, id, id) as { home_team_id: number; home_score: number; away_score: number } | undefined;
    let delta = 0;
    if (fx) {
      const home = fx.home_team_id === id;
      const my = home ? fx.home_score : fx.away_score, opp = home ? fx.away_score : fx.home_score;
      delta = my > opp ? RESULT.win : my < opp ? RESULT.loss : RESULT.draw;
    }
    const players = db.prepare('SELECT id, morale FROM players WHERE team_id = ?').all(id) as { id: number; morale: number }[];
    const upd = db.prepare('UPDATE players SET morale = ? WHERE id = ?');
    for (const p of players) upd.run(Math.max(0, Math.min(100, Math.round(p.morale * DRIFT + 50 * (1 - DRIFT) + delta))), p.id);
  }
}

// Pre-season: morale resets to neutral optimism. Called at rollover.
export function resetMorale(leagueId: number): void {
  db.prepare('UPDATE players SET morale = 65 WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(leagueId);
}

// Cup competition (core stream). A single-elimination knockout of every club in the world,
// run alongside the league each season. Round 1 pairs all 16 (or 8) clubs at random — so a
// Championship side can draw, and beat, a Premier League one (a giant-killing comes straight
// from the engine result). Winners advance up the bracket to the final. Drawn ties are settled
// by a deterministic seeded shootout. This module is the bracket LOGIC (testable without the
// engine); playing a tie through live.exe lives in match.ts (playCupTie).
import { db } from './db.ts';

const ROUND_NAMES: Record<number, string> = { 1: 'Round 1', 2: 'Quarter-final', 3: 'Semi-final', 4: 'Final' };

interface World { worldId: number; season: number; leagueIds: number[] }
function worldOf(leagueId: number): World | null {
  const lg = db.prepare('SELECT id, world_id, season FROM leagues WHERE id = ?').get(leagueId) as { id: number; world_id: number | null; season: number } | undefined;
  if (!lg) return null;
  const worldId = lg.world_id ?? lg.id;
  const leagueIds = lg.world_id == null ? [lg.id] : (db.prepare('SELECT id FROM leagues WHERE world_id = ?').all(lg.world_id) as { id: number }[]).map(l => l.id);
  return { worldId, season: lg.season, leagueIds };
}
const teamIdsIn = (leagueIds: number[]): number[] =>
  (db.prepare(`SELECT id FROM teams WHERE league_id IN (${leagueIds.map(() => '?').join(',')}) ORDER BY id`).all(...leagueIds) as { id: number }[]).map(t => t.id);
const seed = () => 1 + Math.floor(Math.random() * 99999);

// total rounds for N clubs (N a power of 2): 16 -> 4, 8 -> 3.
export function roundName(round: number, totalRounds: number): string {
  // anchor the last few rounds to Final/SF/QF regardless of bracket size
  const fromEnd = totalRounds - round;          // 0 = final
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return ROUND_NAMES[round] ?? `Round ${round}`;
}

// Create this season's cup: pair every club at random into round-1 ties. Idempotent — if the
// world already has a cup this season, leaves it. Needs a power-of-two field (8 or 16 here).
export function createCup(leagueId: number): void {
  const w = worldOf(leagueId); if (!w) return;
  if ((db.prepare('SELECT COUNT(*) AS n FROM cup_ties WHERE world_id = ? AND season = ?').get(w.worldId, w.season) as { n: number }).n > 0) return;
  const teams = teamIdsIn(w.leagueIds);
  if (teams.length < 2 || (teams.length & (teams.length - 1)) !== 0) return;
  for (let i = teams.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  const ins = db.prepare('INSERT INTO cup_ties (world_id, season, round, slot, home_team_id, away_team_id, seed) VALUES (?, ?, 1, ?, ?, ?, ?)');
  for (let i = 0; i < teams.length / 2; i++) ins.run(w.worldId, w.season, i, teams[2 * i], teams[2 * i + 1], seed());
}

interface CupTie { id: number; round: number; slot: number; home_team_id: number; away_team_id: number; seed: number; played: number; home_score: number | null; away_score: number | null; home_pens: number | null; away_pens: number | null; winner_team_id: number | null }

// The winner of a played tie. A draw is broken by a deterministic seeded shootout.
function tieWinner(t: CupTie): number {
  if ((t.home_score ?? 0) > (t.away_score ?? 0)) return t.home_team_id;
  if ((t.away_score ?? 0) > (t.home_score ?? 0)) return t.away_team_id;
  if (t.home_pens != null && t.away_pens != null && t.home_pens !== t.away_pens)
    return t.home_pens > t.away_pens ? t.home_team_id : t.away_team_id;
  // Preserve an already-recorded legacy winner; otherwise old unadvanced draws keep seed parity.
  if (t.winner_team_id === t.home_team_id || t.winner_team_id === t.away_team_id) return t.winner_team_id;
  return t.seed % 2 === 0 ? t.home_team_id : t.away_team_id;
}

// The next round that still has unplayed ties (with both teams set), or null if the cup is done.
export function pendingCupRound(leagueId: number): { round: number; tieIds: number[] } | null {
  const w = worldOf(leagueId); if (!w) return null;
  const r = (db.prepare('SELECT MIN(round) AS r FROM cup_ties WHERE world_id = ? AND season = ? AND played = 0 AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL').get(w.worldId, w.season) as { r: number | null }).r;
  if (r == null) return null;
  const tieIds = (db.prepare('SELECT id FROM cup_ties WHERE world_id = ? AND season = ? AND round = ? AND played = 0').all(w.worldId, w.season, r) as { id: number }[]).map(t => t.id);
  return { round: r, tieIds };
}

export interface CupAdvance { round: number; winners: number[]; champion: number | null }

// Resolve a fully-played round: record each tie's winner and pair the winners into the next
// round (or crown the champion if that was the final). Returns null if the round isn't complete.
export function advanceCupRound(leagueId: number, round: number): CupAdvance | null {
  const w = worldOf(leagueId); if (!w) return null;
  const ties = db.prepare('SELECT * FROM cup_ties WHERE world_id = ? AND season = ? AND round = ? ORDER BY slot').all(w.worldId, w.season, round) as unknown as CupTie[];
  if (!ties.length || ties.some(t => !t.played)) return null;
  const upd = db.prepare('UPDATE cup_ties SET winner_team_id = ? WHERE id = ?');
  const winners = ties.map(t => { const win = tieWinner(t); upd.run(win, t.id); return win; });
  if (winners.length >= 2) {
    // idempotent: only seed the next round if it isn't already there (guards a double/retried
    // advance from duplicating ties — also enforced by the uq_cup_tie unique index).
    const nextExists = (db.prepare('SELECT COUNT(*) AS n FROM cup_ties WHERE world_id = ? AND season = ? AND round = ?').get(w.worldId, w.season, round + 1) as { n: number }).n > 0;
    if (!nextExists) {
      const ins = db.prepare('INSERT INTO cup_ties (world_id, season, round, slot, home_team_id, away_team_id, seed) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < winners.length / 2; i++) ins.run(w.worldId, w.season, round + 1, i, winners[2 * i], winners[2 * i + 1], seed());
    }
    return { round, winners, champion: null };
  }
  return { round, winners, champion: winners[0] ?? null };
}

// A team's result in a given cup round (for the advance summary) — null if they weren't in it.
export function cupTieFor(teamId: number, leagueId: number, round: number): { homeScore: number; awayScore: number; homePens: number | null; awayPens: number | null; opponent: string; won: boolean } | null {
  const w = worldOf(leagueId); if (!w) return null;
  const t = db.prepare('SELECT * FROM cup_ties WHERE world_id = ? AND season = ? AND round = ? AND (home_team_id = ? OR away_team_id = ?)')
    .get(w.worldId, w.season, round, teamId, teamId) as CupTie | undefined;
  if (!t || !t.played) return null;
  const oppId = t.home_team_id === teamId ? t.away_team_id : t.home_team_id;
  const opponent = (db.prepare('SELECT name FROM teams WHERE id = ?').get(oppId) as { name: string } | undefined)?.name ?? 'Opponent';
  return { homeScore: t.home_score ?? 0, awayScore: t.away_score ?? 0, homePens: t.home_pens, awayPens: t.away_pens, opponent, won: t.winner_team_id === teamId };
}

export interface CupTieView { id: number; round: number; slot: number; home: string | null; away: string | null; homeTeamId: number | null; awayTeamId: number | null; played: boolean; homeScore: number | null; awayScore: number | null; homePens: number | null; awayPens: number | null; winnerTeamId: number | null }

// The whole bracket for the world's current-season cup (for the cup screen).
export function cupView(leagueId: number): { rounds: { round: number; name: string; ties: CupTieView[] }[]; totalRounds: number; champion: string | null; championTeamId: number | null } {
  const w = worldOf(leagueId);
  if (!w) return { rounds: [], totalRounds: 0, champion: null, championTeamId: null };
  const ties = db.prepare('SELECT * FROM cup_ties WHERE world_id = ? AND season = ? ORDER BY round, slot').all(w.worldId, w.season) as unknown as CupTie[];
  const names = new Map((db.prepare(`SELECT id, name FROM teams WHERE league_id IN (${w.leagueIds.map(() => '?').join(',')})`).all(...w.leagueIds) as { id: number; name: string }[]).map(t => [t.id, t.name]));
  // total rounds derives from the round-1 size (8 ties -> 4 rounds, 4 ties -> 3 rounds)
  const r1 = ties.filter(t => t.round === 1).length;
  const total = r1 ? Math.round(Math.log2(r1 * 2)) : ties.reduce((m, t) => Math.max(m, t.round), 0);
  const byRound = new Map<number, CupTieView[]>();
  for (const t of ties) {
    const arr = byRound.get(t.round) ?? [];
    arr.push({ id: t.id, round: t.round, slot: t.slot, home: t.home_team_id != null ? names.get(t.home_team_id) ?? null : null, away: t.away_team_id != null ? names.get(t.away_team_id) ?? null : null, homeTeamId: t.home_team_id, awayTeamId: t.away_team_id, played: !!t.played, homeScore: t.home_score, awayScore: t.away_score, homePens: t.home_pens, awayPens: t.away_pens, winnerTeamId: t.winner_team_id });
    byRound.set(t.round, arr);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b).map(round => ({ round, name: roundName(round, total), ties: byRound.get(round)! }));
  const finalTie = ties.find(t => t.round === total);
  const championTeamId = finalTie?.winner_team_id ?? null;
  const champion = championTeamId != null ? (names.get(championTeamId) ?? null) : null;
  return { rounds, totalRounds: total, champion, championTeamId };
}

// Season history / honours archive. recordSeasonHistory writes one row per club per finished
// season (called inside the rollover tx, before the old fixtures are purged and the season
// counter advances — that data is otherwise lost). getHistory reads a club's archive for the
// History screen + trophy cabinet. See season_history in db.ts.
import { db } from './db.ts';
import type { Standing } from './game.ts';

export interface SeasonHistoryRow {
  season: number; tier: number; division: string; position: number;
  played: number; won: number; drawn: number; lost: number; gf: number; ga: number; points: number;
  champion: boolean; promoted: boolean; relegated: boolean; cupWon: boolean; pots: string | null;
}

// Archive a club's just-finished season. Idempotent per (team, season) via INSERT OR IGNORE +
// the unique index, so a re-run (or a double rollover) can never duplicate a row.
export function recordSeasonHistory(opts: {
  teamId: number; season: number; tier: number; division: string;
  table: Standing[];   // the division's FINAL table — position is index + 1
  promoted: boolean; relegated: boolean; cupWon: boolean;
}): void {
  const idx = opts.table.findIndex(s => s.teamId === opts.teamId);
  if (idx < 0) return;   // the club isn't in this division's table
  const s = opts.table[idx];
  const pots = (db.prepare(
    "SELECT player_name FROM player_news WHERE team_id = ? AND season = ? AND type = 'pots' ORDER BY id DESC LIMIT 1",
  ).get(opts.teamId, opts.season) as { player_name: string } | undefined)?.player_name ?? null;
  db.prepare(
    `INSERT OR IGNORE INTO season_history
       (team_id, season, tier, division, position, played, won, drawn, lost, gf, ga, points,
        champion, promoted, relegated, cup_won, pots, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    opts.teamId, opts.season, opts.tier, opts.division, idx + 1,
    s.played, s.won, s.drawn, s.lost, s.gf, s.ga, s.points,
    idx === 0 ? 1 : 0, opts.promoted ? 1 : 0, opts.relegated ? 1 : 0, opts.cupWon ? 1 : 0,
    pots, Date.now(),
  );
}

export function getHistory(teamId: number): SeasonHistoryRow[] {
  const rows = db.prepare('SELECT * FROM season_history WHERE team_id = ? ORDER BY season DESC').all(teamId) as {
    season: number; tier: number; division: string; position: number; played: number; won: number; drawn: number;
    lost: number; gf: number; ga: number; points: number; champion: number; promoted: number; relegated: number;
    cup_won: number; pots: string | null;
  }[];
  return rows.map(r => ({
    season: r.season, tier: r.tier, division: r.division, position: r.position,
    played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, gf: r.gf, ga: r.ga, points: r.points,
    champion: !!r.champion, promoted: !!r.promoted, relegated: !!r.relegated, cupWon: !!r.cup_won, pots: r.pots,
  }));
}

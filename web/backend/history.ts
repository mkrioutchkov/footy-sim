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
  objective: { kind: string; target: number; met: boolean } | null;
  board: { tone: string; message: string; confidence: number } | null;
}

// Archive a club's just-finished season. Idempotent per (team, season) via INSERT OR IGNORE +
// the unique index, so a re-run (or a double rollover) can never duplicate a row.
export function recordSeasonHistory(opts: {
  teamId: number; season: number; tier: number; division: string;
  table: Standing[];   // the division's FINAL table — position is index + 1
  promoted: boolean; relegated: boolean; cupWon: boolean;
  objective?: { kind: string; target: number; met: boolean } | null;   // the board target for this season + verdict
  board?: { tone: string; message: string; confidence: number } | null;   // the board's end-of-season verdict
}): void {
  const idx = opts.table.findIndex(s => s.teamId === opts.teamId);
  if (idx < 0) return;   // the club isn't in this division's table
  const s = opts.table[idx];
  const pots = (db.prepare(
    "SELECT player_name FROM player_news WHERE team_id = ? AND season = ? AND type = 'pots' ORDER BY id DESC LIMIT 1",
  ).get(opts.teamId, opts.season) as { player_name: string } | undefined)?.player_name ?? null;
  const obj = opts.objective ?? null;
  const bd = opts.board ?? null;
  db.prepare(
    `INSERT OR IGNORE INTO season_history
       (team_id, season, tier, division, position, played, won, drawn, lost, gf, ga, points,
        champion, promoted, relegated, cup_won, pots, objective_kind, objective_target, objective_met,
        board_tone, board_message, board_confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    opts.teamId, opts.season, opts.tier, opts.division, idx + 1,
    s.played, s.won, s.drawn, s.lost, s.gf, s.ga, s.points,
    idx === 0 ? 1 : 0, opts.promoted ? 1 : 0, opts.relegated ? 1 : 0, opts.cupWon ? 1 : 0,
    pots, obj?.kind ?? null, obj?.target ?? null, obj == null ? null : obj.met ? 1 : 0,
    bd?.tone ?? null, bd?.message ?? null, bd?.confidence ?? null, Date.now(),
  );
}

export interface ClubRecords {
  seasons: number; titles: number; promotions: number; relegations: number; cups: number;
  bestFinish: { position: number; tier: number; season: number } | null;
  mostPoints: { points: number; season: number } | null;
  mostGoals: { gf: number; season: number } | null;
}

// All-time club records — a pure reduction over the season archive (no new storage).
export function getClubRecords(teamId: number): ClubRecords {
  const h = getHistory(teamId);
  const base: ClubRecords = { seasons: h.length, titles: 0, promotions: 0, relegations: 0, cups: 0, bestFinish: null, mostPoints: null, mostGoals: null };
  if (!h.length) return base;
  base.titles = h.filter(r => r.champion).length;
  base.promotions = h.filter(r => r.promoted).length;
  base.relegations = h.filter(r => r.relegated).length;
  base.cups = h.filter(r => r.cupWon).length;
  // best finish = highest tier first (lower number), then highest position (lower number)
  const best = h.reduce((b, r) => (r.tier < b.tier || (r.tier === b.tier && r.position < b.position)) ? r : b, h[0]);
  const pts = h.reduce((m, r) => r.points > m.points ? r : m, h[0]);
  const gls = h.reduce((m, r) => r.gf > m.gf ? r : m, h[0]);
  base.bestFinish = { position: best.position, tier: best.tier, season: best.season };
  base.mostPoints = { points: pts.points, season: pts.season };
  base.mostGoals = { gf: gls.gf, season: gls.season };
  return base;
}

export function getHistory(teamId: number): SeasonHistoryRow[] {
  const rows = db.prepare('SELECT * FROM season_history WHERE team_id = ? ORDER BY season DESC').all(teamId) as {
    season: number; tier: number; division: string; position: number; played: number; won: number; drawn: number;
    lost: number; gf: number; ga: number; points: number; champion: number; promoted: number; relegated: number;
    cup_won: number; pots: string | null; objective_kind: string | null; objective_target: number | null; objective_met: number | null;
    board_tone: string | null; board_message: string | null; board_confidence: number | null;
  }[];
  return rows.map(r => ({
    season: r.season, tier: r.tier, division: r.division, position: r.position,
    played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, gf: r.gf, ga: r.ga, points: r.points,
    champion: !!r.champion, promoted: !!r.promoted, relegated: !!r.relegated, cupWon: !!r.cup_won, pots: r.pots,
    objective: r.objective_kind != null && r.objective_target != null
      ? { kind: r.objective_kind, target: r.objective_target, met: r.objective_met === 1 } : null,
    board: r.board_tone != null ? { tone: r.board_tone, message: r.board_message ?? '', confidence: r.board_confidence ?? 0 } : null,
  }));
}

// ── Per-player career archive (see player_season_stats in db.ts) ─────────────
export interface PlayerSeasonStat { season: number; club: string; role: string; goals: number; assists: number; apps: number; avgRating: number }

// Archive one club's players' just-finished season stats, called inside the rollover tx BEFORE the
// live season_* columns reset (season.ts). Only players who actually appeared (apps > 0) get a row —
// a squad filler who never played leaves no career line. Idempotent per (player, season) via
// INSERT OR IGNORE + the unique index, so a double rollover can't duplicate.
export function recordSeasonPlayerStats(teamId: number, season: number): void {
  const club = (db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId) as { name: string } | undefined)?.name ?? 'Club';
  const rows = db.prepare(
    'SELECT id, name, role, season_goals, season_assists, season_apps, season_rating_sum FROM players WHERE team_id = ? AND season_apps > 0',
  ).all(teamId) as { id: number; name: string; role: string; season_goals: number; season_assists: number; season_apps: number; season_rating_sum: number }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO player_season_stats
       (player_id, team_id, season, name, club, role, goals, assists, apps, rating_sum, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  for (const p of rows) ins.run(p.id, teamId, season, p.name, club, p.role, p.season_goals ?? 0, p.season_assists ?? 0, p.season_apps ?? 0, p.season_rating_sum ?? 0, now);
}

// A player's archived seasons, newest first (avg rating rounded to 1dp; guarded against apps=0).
export function getPlayerCareer(playerId: number): PlayerSeasonStat[] {
  const rows = db.prepare('SELECT season, club, role, goals, assists, apps, rating_sum FROM player_season_stats WHERE player_id = ? ORDER BY season DESC')
    .all(playerId) as { season: number; club: string; role: string; goals: number; assists: number; apps: number; rating_sum: number }[];
  return rows.map(r => ({ season: r.season, club: r.club, role: r.role, goals: r.goals, assists: r.assists, apps: r.apps, avgRating: r.apps > 0 ? Math.round((r.rating_sum / r.apps) * 10) / 10 : 0 }));
}

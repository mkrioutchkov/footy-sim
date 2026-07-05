// League stat leaders — the division-wide top scorers + top assisters this season (an FM staple).
// Goals/assists are tallied for BOTH clubs at play time (tallyFixtureStats, from the --summary per-player
// stats every fixture already produces), guarded per-fixture by fixtures.stats_tallied so a watch-then-
// advance can't double-count. Reset at rollover (season.ts). Engine-free; no money, no squad changes.
//
// Coverage note: the tally runs inside playFixture (the chokepoint for advance + quick-watch). A user's
// match played in ⚡ LIVE mode bypasses playFixture (the coordinator persists it), so that one fixture's
// goals aren't counted — a small, known gap; every simmed/quick-watched fixture is counted exactly once.
import { db } from './db.ts';
import { ROLE_SLOTS } from './game.ts';

// Tally one played fixture's per-player goals/assists into the season leaderboard, once. Players are matched
// to DB rows by (side → team) + UNIQUE name within that club (a duplicate name is skipped rather than
// mis-credited, mirroring news.ts). Idempotent via stats_tallied.
export function tallyFixtureStats(
  fixtureId: number,
  players: { name: string; team: 'home' | 'away'; goals: number; assists: number }[],
): void {
  const fx = db.prepare('SELECT home_team_id, away_team_id, stats_tallied FROM fixtures WHERE id = ?')
    .get(fixtureId) as { home_team_id: number; away_team_id: number; stats_tallied: number } | undefined;
  if (!fx || fx.stats_tallied) return;
  const uniqueNameMap = (teamId: number): Map<string, number> => {
    const rows = db.prepare('SELECT id, name FROM players WHERE team_id = ?').all(teamId) as { id: number; name: string }[];
    const cnt = new Map<string, number>();
    for (const r of rows) cnt.set(r.name, (cnt.get(r.name) ?? 0) + 1);
    return new Map(rows.filter(r => cnt.get(r.name) === 1).map(r => [r.name, r.id] as const));
  };
  const homeMap = uniqueNameMap(fx.home_team_id), awayMap = uniqueNameMap(fx.away_team_id);
  const upd = db.prepare('UPDATE players SET season_goals = season_goals + ?, season_assists = season_assists + ? WHERE id = ?');
  for (const p of players) {
    const g = Math.max(0, Math.round(p.goals || 0)), a = Math.max(0, Math.round(p.assists || 0));
    if (!g && !a) continue;
    const id = (p.team === 'home' ? homeMap : awayMap).get(p.name);
    if (id != null) upd.run(g, a, id);
  }
  db.prepare('UPDATE fixtures SET stats_tallied = 1 WHERE id = ?').run(fixtureId);
}

export interface LeaderRow { name: string; club: string; role: string; value: number; isMine: boolean }
export interface LeadersView { division: string; scorers: LeaderRow[]; assists: LeaderRow[]; ratings: LeaderRow[]; teamOfSeason: LeaderRow[] }

const MIN_RATED_APPS = 3;   // matches played before a player qualifies for the rating boards

// The current-division leaderboards for the user's world division: top scorers, top assisters, best average
// match rating, and the division "Team of the Season" (best-rated player per role of the default shape).
export function leagueLeaders(teamId: number, limit = 12): LeadersView | null {
  const t = db.prepare('SELECT league_id FROM teams WHERE id = ?').get(teamId) as { league_id: number } | undefined;
  if (!t) return null;
  const division = (db.prepare('SELECT name FROM leagues WHERE id = ?').get(t.league_id) as { name: string } | undefined)?.name ?? 'Division';
  const top = (col: 'season_goals' | 'season_assists'): LeaderRow[] =>
    (db.prepare(`SELECT p.name, p.role, tm.name AS club, tm.id AS club_id, p.${col} AS v
       FROM players p JOIN teams tm ON tm.id = p.team_id
       WHERE tm.league_id = ? AND p.${col} > 0 ORDER BY v DESC, p.name ASC LIMIT ?`)
      .all(t.league_id, limit) as { name: string; role: string; club: string; club_id: number; v: number }[])
      .map(r => ({ name: r.name, club: r.club, role: r.role, value: r.v, isMine: r.club_id === teamId }));

  // qualified players with an average match rating (division-wide, min apps)
  const rated = (db.prepare(`SELECT p.name, p.role, tm.name AS club, tm.id AS club_id, p.season_rating_sum AS sum, p.season_apps AS apps
      FROM players p JOIN teams tm ON tm.id = p.team_id
      WHERE tm.league_id = ? AND p.season_apps >= ?`)
    .all(t.league_id, MIN_RATED_APPS) as { name: string; role: string; club: string; club_id: number; sum: number; apps: number }[])
    .map(r => ({ name: r.name, role: r.role, club: r.club, isMine: r.club_id === teamId, avg: r.sum / r.apps }))
    .sort((a, b) => b.avg - a.avg);
  const ratings: LeaderRow[] = rated.slice(0, limit).map(r => ({ name: r.name, club: r.club, role: r.role, value: Math.round(r.avg * 10) / 10, isMine: r.isMine }));

  // Team of the Season: fill the default shape's role slots with the best-rated unused player of each role
  // (fallback to the best remaining if a role is short). Unique by name+club so no one appears twice.
  const used = new Set<string>();
  const teamOfSeason: LeaderRow[] = [];
  for (const role of ROLE_SLOTS) {
    const key = (r: { name: string; club: string }) => `${r.name}@${r.club}`;
    const pick = rated.find(r => !used.has(key(r)) && r.role === role) ?? rated.find(r => !used.has(key(r)));
    if (pick) { used.add(key(pick)); teamOfSeason.push({ name: pick.name, club: pick.club, role, value: Math.round(pick.avg * 10) / 10, isMine: pick.isMine }); }
  }

  return { division, scorers: top('season_goals'), assists: top('season_assists'), ratings, teamOfSeason };
}

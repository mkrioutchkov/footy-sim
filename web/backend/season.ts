// Seasons / divisions (pillar 3). A world is one or more divisions (leagues) linked by
// world_id and ranked by tier (1 = top). When every fixture in every division is played,
// the season rolls over: prize money is paid, the bottom of each division swaps with the
// top of the one below (promotion/relegation), every player ages a year, fixtures are
// regenerated and the free-agent pools refreshed. A legacy single league (world_id NULL)
// rolls over as a lone division — carryover + prize money + ageing, no promotion.
import { db } from './db.ts';
import { standings, generateFixtures, seedFreeAgents, type Standing } from './game.ts';
import { tickContracts, type ContractEvent } from './contracts.ts';

export const PROMOTE = 2;          // bottom N of a division swap with the top N below it
const FA_REFRESH = true;           // refresh each division's free-agent pool every season

// Prize money by tier + final position. Injected into budgets each season so clubs can
// keep trading. TASTE: see GAME_LAYER_NOTES.md.
export function prizeMoney(tier: number, position: number, size: number): number {
  const top = tier === 1 ? 40_000_000 : 18_000_000;
  const bottom = tier === 1 ? 12_000_000 : 4_000_000;
  const frac = size > 1 ? (position - 1) / (size - 1) : 0;       // 0 at 1st place, 1 at last
  return Math.round((top - (top - bottom) * frac) / 100_000) * 100_000;
}
const PROMOTION_BONUS = 15_000_000;   // windfall for going up a division

function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

export interface WorldLeague { id: number; tier: number; season: number; name: string; }

// Every division of a world (by world_id), top tier first. A legacy single league
// (world_id NULL) returns just itself.
export function worldLeagues(leagueId: number): WorldLeague[] {
  const lg = db.prepare('SELECT id, world_id FROM leagues WHERE id = ?').get(leagueId) as { id: number; world_id: number | null } | undefined;
  if (!lg) return [];
  if (lg.world_id == null) return [db.prepare('SELECT id, tier, season, name FROM leagues WHERE id = ?').get(leagueId) as unknown as WorldLeague];
  return db.prepare('SELECT id, tier, season, name FROM leagues WHERE world_id = ? ORDER BY tier').all(lg.world_id) as unknown as WorldLeague[];
}

// Fixture ids to play on the next matchday across the whole world: each division's
// EARLIEST round that still has an unplayed fixture. Using the earliest incomplete round
// (not "the user's next round") means a fixture the user pre-played by watching it gets
// its round completed rather than orphaned, and divisions that drift out of step each
// catch up one round per advance. Empty once the whole world is played out.
export function pendingMatchday(leagueId: number): number[] {
  const ids: number[] = [];
  for (const l of worldLeagues(leagueId)) {
    const nr = db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(l.id) as { r: number | null };
    if (nr.r == null) continue;
    for (const f of db.prepare('SELECT id FROM fixtures WHERE league_id = ? AND round = ? AND played = 0 ORDER BY id').all(l.id, nr.r) as { id: number }[]) ids.push(f.id);
  }
  return ids;
}

// True once every fixture in every division of the world has been played.
export function seasonComplete(leagueId: number): boolean {
  const leagues = worldLeagues(leagueId);
  if (!leagues.length) return false;
  for (const l of leagues) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ? AND played = 0').get(l.id) as { n: number };
    if (n.n > 0) return false;
  }
  return true;
}

export interface RolloverResult {
  season: number;                                                 // the NEW season number
  divisions: { tier: number; name: string; champion: string }[];
  promoted: { teamId: number; team: string; fromTier: number; toTier: number }[];
  relegated: { teamId: number; team: string; fromTier: number; toTier: number }[];
  prizeMoney: { teamId: number; team: string; amount: number }[];
  contracts: ContractEvent[];
}

// Roll the world's season over. Returns a summary, or null if the season isn't complete.
export function rolloverSeason(leagueId: number): RolloverResult | null {
  const leagues = worldLeagues(leagueId);
  if (!leagues.length || !seasonComplete(leagueId)) return null;
  // snapshot final tables BEFORE any mutation
  const finals = leagues.map(l => ({ league: l, table: standings(l.id) }));

  return tx(() => {
    const out: RolloverResult = { season: (leagues[0].season ?? 1) + 1, divisions: [], promoted: [], relegated: [], prizeMoney: [], contracts: [] };

    // 1. prize money by final position
    for (const { league, table } of finals) {
      table.forEach((s, i) => {
        const amount = prizeMoney(league.tier, i + 1, table.length);
        db.prepare('UPDATE teams SET budget = budget + ? WHERE id = ?').run(amount, s.teamId);
        out.prizeMoney.push({ teamId: s.teamId, team: s.name, amount });
      });
      out.divisions.push({ tier: league.tier, name: league.name, champion: table[0]?.name ?? '' });
    }

    // 2. promotion / relegation between each adjacent tier pair (finals is tier-ascending)
    for (let i = 0; i < finals.length - 1; i++) {
      const upper = finals[i], lower = finals[i + 1];
      const goingDown = upper.table.slice(-PROMOTE);          // bottom N of the upper division
      const goingUp = lower.table.slice(0, PROMOTE);          // top N of the lower division
      for (const s of goingDown) {
        db.prepare('UPDATE teams SET league_id = ? WHERE id = ?').run(lower.league.id, s.teamId);
        out.relegated.push({ teamId: s.teamId, team: s.name, fromTier: upper.league.tier, toTier: lower.league.tier });
      }
      for (const s of goingUp) {
        db.prepare('UPDATE teams SET league_id = ?, budget = budget + ? WHERE id = ?').run(upper.league.id, PROMOTION_BONUS, s.teamId);
        out.promoted.push({ teamId: s.teamId, team: s.name, fromTier: lower.league.tier, toTier: upper.league.tier });
      }
    }

    // 3. age every player in the world a year
    const ids = leagues.map(l => l.id);
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE players SET age = age + 1 WHERE team_id IN (SELECT id FROM teams WHERE league_id IN (${ph}))`).run(...ids);

    // 4. new season: bump the counter, refresh each division's free-agent pool (a fresh
    //    transfer-window crop), then tick contracts (expiring players join that fresh pool),
    //    and finally regenerate fixtures against the settled rosters.
    for (const l of leagues) {
      db.prepare('UPDATE leagues SET season = season + 1 WHERE id = ?').run(l.id);
      if (FA_REFRESH) { db.prepare('DELETE FROM free_agents WHERE league_id = ?').run(l.id); seedFreeAgents(l.id); }
      out.contracts.push(...tickContracts(l.id));
      db.prepare('DELETE FROM fixtures WHERE league_id = ?').run(l.id);
      generateFixtures(l.id);
    }
    return out;
  });
}

// Compact standings for every division of the world (for the league screen's
// "other divisions" peek). Reads the live tables — call before a rollover.
export function worldStandings(leagueId: number): { tier: number; name: string; season: number; standings: Standing[] }[] {
  return worldLeagues(leagueId).map(l => ({ tier: l.tier, name: l.name, season: l.season, standings: standings(l.id) }));
}

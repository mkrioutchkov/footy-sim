// Seasons / divisions (pillar 3). A world is one or more divisions (leagues) linked by
// world_id and ranked by tier (1 = top). When every fixture in every division is played,
// the season rolls over: prize money is paid, the bottom of each division swaps with the
// top of the one below (promotion/relegation), every player ages a year, fixtures are
// regenerated and the free-agent pools refreshed. A legacy single league (world_id NULL)
// rolls over as a lone division — carryover + prize money + ageing, no promotion.
import { db } from './db.ts';
import { standings, generateFixtures, seedFreeAgents, tierFinance, type Standing } from './game.ts';
import { tickContracts, type ContractEvent } from './contracts.ts';
import { youthAndRetirement, type YouthEvent } from './youth.ts';
import { resetFitness } from './fitness.ts';
import { resetMorale } from './morale.ts';
import { createCup, cupView } from './cup.ts';
import { purgeRecordings } from './match.ts';
import { purgeReports } from './report.ts';
import { returnLoans } from './market.ts';
import { recordSeasonAwards } from './news.ts';
import { recordSeasonHistory } from './history.ts';
import { getObjective, setSeasonObjective, deriveObjective, objectiveMet } from './objectives.ts';
import { settleConfidenceAtRollover, boardVerdictAtRollover, type BoardTone } from './confidence.ts';
import { recordFinance } from './finances.ts';

export const PROMOTE = 2;          // bottom N of a division swap with the top N below it
const FA_REFRESH = true;           // refresh each division's free-agent pool every season

// Prize money (TV + merit) by tier + final position — roughly real-world: the Premier League
// (tier 1) pays a huge, relatively flat purse (~£160M champion down to a ~£100M floor — even
// last place banks the TV windfall); the Championship (tier 2) pays a modest £12M→£3M. This
// is the income that funds transfers. TASTE: see GAME_LAYER_NOTES.md.
export function prizeMoney(tier: number, position: number, size: number): number {
  const top = tier === 1 ? 160_000_000 : 12_000_000;
  const bottom = tier === 1 ? 100_000_000 : 3_000_000;
  const frac = size > 1 ? (position - 1) / (size - 1) : 0;       // 0 at 1st place, 1 at last
  return Math.round((top - (top - bottom) * frac) / 1_000_000) * 1_000_000;
}
const PROMOTION_BONUS = 40_000_000;   // a promoted club's summer war chest (the windfall of going up)

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
  youth: YouthEvent[];
  board: { teamId: number; tone: BoardTone; message: string }[];   // the board's verdict per human club
}

// Roll the world's season over. Returns a summary, or null if the season isn't complete.
export function rolloverSeason(leagueId: number): RolloverResult | null {
  const leagues = worldLeagues(leagueId);
  if (!leagues.length || !seasonComplete(leagueId)) return null;
  // snapshot final tables BEFORE any mutation
  const finals = leagues.map(l => ({ league: l, table: standings(l.id) }));

  return tx(() => {
    const out: RolloverResult = { season: (leagues[0].season ?? 1) + 1, divisions: [], promoted: [], relegated: [], prizeMoney: [], contracts: [], youth: [], board: [] };

    // 0. loans are season-long: send every loaned-in player in THIS world back to his parent club
    //    (before ageing / contract ticking, so he's home on the books for the new campaign).
    returnLoans(leagues.map(l => l.id));

    // 0b. season awards for each human-managed club, from the rating tally (before it resets in
    //     the per-league loop below). endSeason = the campaign that just finished.
    const endSeason = leagues[0].season ?? 1;
    const lph = leagues.map(() => '?').join(',');
    const humanTeams = db.prepare(`SELECT id FROM teams WHERE league_id IN (${lph}) AND user_id IS NOT NULL`).all(...leagues.map(l => l.id)) as { id: number }[];
    for (const t of humanTeams) recordSeasonAwards(t.id, endSeason);

    // 1. prize money by final position
    for (const { league, table } of finals) {
      table.forEach((s, i) => {
        const amount = prizeMoney(league.tier, i + 1, table.length);
        db.prepare('UPDATE teams SET budget = budget + ? WHERE id = ?').run(amount, s.teamId);
        recordFinance(s.teamId, 'prize', amount, `Prize money — ${i + 1}${i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'} in ${league.name}`);   // no-op for AI
        out.prizeMoney.push({ teamId: s.teamId, team: s.name, amount });
      });
      out.divisions.push({ tier: league.tier, name: league.name, champion: table[0]?.name ?? '' });
    }

    // 2. promotion / relegation between each adjacent tier pair (finals is tier-ascending)
    for (let i = 0; i < finals.length - 1; i++) {
      const upper = finals[i], lower = finals[i + 1];
      const goingDown = upper.table.slice(-PROMOTE);          // bottom N of the upper division
      const goingUp = lower.table.slice(0, PROMOTE);          // top N of the lower division
      // relegation drops the club to the lower tier's (smaller) wage budget; promotion lifts
      // it to the upper tier's wage budget AND hands a transfer windfall (the riches of going up).
      for (const s of goingDown) {
        db.prepare('UPDATE teams SET league_id = ?, wage_budget = ? WHERE id = ?').run(lower.league.id, tierFinance(lower.league.tier).wageBudget, s.teamId);
        out.relegated.push({ teamId: s.teamId, team: s.name, fromTier: upper.league.tier, toTier: lower.league.tier });
      }
      for (const s of goingUp) {
        db.prepare('UPDATE teams SET league_id = ?, wage_budget = ?, budget = budget + ? WHERE id = ?').run(upper.league.id, tierFinance(upper.league.tier).wageBudget, PROMOTION_BONUS, s.teamId);
        out.promoted.push({ teamId: s.teamId, team: s.name, fromTier: lower.league.tier, toTier: upper.league.tier });
      }
    }

    // 2b. archive each human club's finished season for the History screen — BEFORE the fixtures
    //     are purged + the season counter advances (that data is otherwise unrecoverable). The
    //     cup still reflects the just-finished campaign here (createCup runs later, in step 4).
    const cupChampionTeamId = cupView(leagues[0].id).championTeamId;
    for (const t of humanTeams) {
      const fin = finals.find(f => f.table.some(s => s.teamId === t.id));
      if (!fin) continue;
      const pos = fin.table.findIndex(s => s.teamId === t.id) + 1;
      const promo = out.promoted.find(p => p.teamId === t.id);
      const releg = out.relegated.find(r => r.teamId === t.id);
      // the board target set for the season that just finished → its verdict, archived with the row
      const finishedObj = getObjective(t.id);
      const objForHistory = finishedObj && finishedObj.season === endSeason
        ? { kind: finishedObj.kind, target: finishedObj.target, met: objectiveMet(finishedObj.target, pos) } : null;
      recordSeasonHistory({
        teamId: t.id, season: endSeason, tier: fin.league.tier, division: fin.league.name, table: fin.table,
        promoted: !!promo, relegated: !!releg,
        // attribute the cup by team id, not name — club names aren't unique (no UNIQUE constraint),
        // so a same-named club winning it must not phantom-award this club (review fix).
        cupWon: cupChampionTeamId != null && cupChampionTeamId === t.id,
        objective: objForHistory,
      });
      // board confidence settles on the season verdict (objective + finish + promotion/relegation),
      // then the board delivers its verdict (escalating if confidence stays at-risk season on season)
      const newConfidence = settleConfidenceAtRollover({
        teamId: t.id, finalPosition: pos, size: fin.table.length,
        promoted: !!promo, relegated: !!releg, objectiveMet: objForHistory ? objForHistory.met : null,
      });
      out.board.push({ teamId: t.id, ...boardVerdictAtRollover(t.id, newConfidence, objForHistory ? objForHistory.met : null) });
      // set the board's expectation for the coming season, from the club's NEW tier (promotion/
      // relegation already moved league_id at step 2) + how it just finished.
      const newTier = promo ? promo.toTier : releg ? releg.toTier : fin.league.tier;
      setSeasonObjective(t.id, out.season, deriveObjective({
        tier: newTier, size: fin.table.length, promote: PROMOTE, prevPosition: pos,
        justPromoted: !!promo, justRelegated: !!releg, isTopTier: newTier === 1,
      }));
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
      out.youth.push(...youthAndRetirement(l.id));     // retire veterans + bring through prospects
      resetFitness(l.id);                              // pre-season: everyone reports back fit
      resetMorale(l.id);                               // and morale resets to fresh optimism
      db.prepare('UPDATE players SET season_rating_sum = 0, season_apps = 0 WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(l.id);   // fresh rating tally
      // the old fixtures are about to vanish — drop their recordings + cached reports too, so
      // those tables don't accumulate rows (and gzip files) keyed to dead fixture ids.
      const oldFixtures = (db.prepare('SELECT id FROM fixtures WHERE league_id = ?').all(l.id) as { id: number }[]).map(r => r.id);
      purgeRecordings('fixture', oldFixtures);
      purgeReports('fixture', oldFixtures);
      db.prepare('DELETE FROM fixtures WHERE league_id = ?').run(l.id);
      generateFixtures(l.id);
    }
    createCup(leagues[0].id);                            // a fresh cup for the new season
    return out;
  });
}

// Compact standings for every division of the world (for the league screen's
// "other divisions" peek). Reads the live tables — call before a rollover.
export function worldStandings(leagueId: number): { tier: number; name: string; season: number; standings: Standing[] }[] {
  return worldLeagues(leagueId).map(l => ({ tier: l.tier, name: l.name, season: l.season, standings: standings(l.id) }));
}

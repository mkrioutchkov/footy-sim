// Season-history archive test (no engine). Drives rolloverSeason directly after marking every
// world fixture played synthetically (user wins all → champion + promoted), and asserts the
// season_history archive accumulates correctly, most-recent-first, with honours + POTS + cup +
// idempotency. Never spawns the engine binary.
//
//   npx tsx tools/_history_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-history-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const season = await import('../web/backend/season.ts');
const history = await import('../web/backend/history.ts');
const obj = await import('../web/backend/objectives.ts');

// ── deriveObjective unit cases (pure) ─────────────────────────────────────────────────────────
check(obj.deriveObjective({ tier: 2, size: 8, promote: 2, isTopTier: false }).kind === 'promotion', 'fresh lower-tier club → promotion');
check(obj.deriveObjective({ tier: 2, size: 8, promote: 2, isTopTier: false }).target === 2, 'promotion target = promote count');
check(obj.deriveObjective({ tier: 1, size: 8, promote: 2, justPromoted: true, isTopTier: true }).kind === 'survival', 'just promoted → survival (consolidate)');
check(obj.deriveObjective({ tier: 1, size: 8, promote: 2, justPromoted: true, isTopTier: true }).target === 6, 'survival target = size − promote');
check(obj.deriveObjective({ tier: 2, size: 8, promote: 2, justRelegated: true, isTopTier: false }).kind === 'promotion', 'just relegated → promotion (bounce back)');
check(obj.deriveObjective({ tier: 1, size: 8, promote: 2, prevPosition: 1, isTopTier: true }).kind === 'title', 'top-tier title holder → title');
check(obj.deriveObjective({ tier: 1, size: 8, promote: 2, prevPosition: 7, isTopTier: true }).kind === 'survival', 'top-tier near-bottom → survival');
check(obj.objectiveMet(2, 1) === true && obj.objectiveMet(2, 3) === false, 'objectiveMet = finalPos <= target');

const u = registerUser('historian', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'History FC', game.DEFAULT_TACTICS);

// the board sets an opening objective for a fresh tier-2 club
const initObj = obj.getObjective(teamId);
check(initObj != null && initObj.season === 1 && initObj.kind === 'promotion', 'a fresh club gets a season-1 promotion objective');

// Mark every fixture in the user's current world played: the user wins all (3-0), everyone else
// draws (0-0) — so the user tops their division. Returns the user's current leagueId.
function completeSeasonUserChampion(): number {
  const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
  const worlds = season.worldLeagues(leagueId);
  const ids = worlds.map(l => l.id);
  const ph = ids.map(() => '?').join(',');
  const fx = db.prepare(`SELECT id, home_team_id, away_team_id FROM fixtures WHERE league_id IN (${ph}) AND played = 0`)
    .all(...ids) as { id: number; home_team_id: number; away_team_id: number }[];
  const set = db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?');
  for (const f of fx) {
    if (f.home_team_id === teamId) set.run(3, 0, f.id);
    else if (f.away_team_id === teamId) set.run(0, 3, f.id);
    else set.run(0, 0, f.id);
  }
  return leagueId;
}

// ── empty before any season completes ────────────────────────────────────────────────────────
check(history.getHistory(teamId).length === 0, 'history is empty before any season is rolled over');

// ── season 1: user champions their division ──────────────────────────────────────────────────
const league1 = completeSeasonUserChampion();
// a synthetic Player-of-the-Season for season 1 (recordSeasonAwards crowns no one — no rated games)
db.prepare(`INSERT INTO player_news (team_id, player_slot, player_name, type, headline, ref_id, season, created_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(teamId, 9, 'Synthetic Star', 'pots', 'Player of the Season', 0, 1, 1);
// drive the cup so the user lifts it: install a self-contained single-tie cup (round 1 = final
// when there's one tie) the user won, for this world+season — robust to the bracket layout.
const lg1 = db.prepare('SELECT world_id, season FROM leagues WHERE id = ?').get(league1) as { world_id: number | null; season: number };
check(lg1.world_id != null, 'the user is in a multi-division world (world_id set)');
if (lg1.world_id != null) {
  db.prepare('DELETE FROM cup_ties WHERE world_id = ? AND season = ?').run(lg1.world_id, lg1.season);
  db.prepare(`INSERT INTO cup_ties (world_id, season, round, slot, home_team_id, away_team_id, seed, played, home_score, away_score, winner_team_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(lg1.world_id, lg1.season, 1, 0, teamId, teamId, 1, 1, 2, 1, teamId);
}

const expectedStanding = game.standings(league1);
const expectedPos = expectedStanding.findIndex(s => s.teamId === teamId) + 1;
const roll1 = season.rolloverSeason(league1);
check(roll1 != null, 'season 1 rolls over once every fixture is played');

const h1 = history.getHistory(teamId);
check(h1.length === 1, 'one history row after the first rollover');
check(h1[0].season === 1, 'the archived season is the one that just finished (1)');
check(h1[0].position === expectedPos && expectedPos === 1, 'archived position matches the live final table (1st)');
check(h1[0].champion === true, 'champion flag set for finishing 1st');
check(h1[0].promoted === true, 'promoted flag set (champion of tier 2 goes up)');
check(h1[0].relegated === false, 'not relegated');
check(h1[0].won > 0 && h1[0].played === h1[0].won + h1[0].drawn + h1[0].lost, 'W/D/L tally is internally consistent');
check(h1[0].pots === 'Synthetic Star', 'POTS name pulled from the season-1 award news');
check(h1[0].cupWon === true, 'cup-won flag set when the user lifts the cup');
check(h1[0].objective != null && h1[0].objective.kind === 'promotion' && h1[0].objective.met === true,
  'the finished season-1 objective (promotion) is archived as MET (champions → promoted)');
const obj2 = obj.getObjective(teamId);
check(obj2 != null && obj2.season === 2 && obj2.kind === 'survival', 'after promotion, the new objective is season-2 survival (consolidate up a tier)');
check(h1[0].board != null && h1[0].board.tone === 'backed' && h1[0].board.confidence > 55, 'the board verdict (backed) + settled confidence are archived in history');

// ── idempotency: re-recording the same (team, season) does not duplicate ──────────────────────
history.recordSeasonHistory({ teamId, season: 1, tier: 2, division: 'X', table: expectedStanding, promoted: false, relegated: false, cupWon: false });
check(history.getHistory(teamId).filter(r => r.season === 1).length === 1, 're-recording season 1 is a no-op (INSERT OR IGNORE)');

// ── season 2: champion again, archive accumulates most-recent-first ────────────────────────────
const league2 = completeSeasonUserChampion();
const roll2 = season.rolloverSeason(league2);
check(roll2 != null, 'season 2 rolls over');
const h2 = history.getHistory(teamId);
check(h2.length === 2, 'two history rows after the second rollover');
check(h2[0].season === 2 && h2[1].season === 1, 'history is ordered most-recent-first');
check(h2[1].pots === 'Synthetic Star', 'the earlier season keeps its POTS after a later rollover');
check(h2[0].objective != null && h2[0].objective.kind === 'survival' && h2[0].objective.met === true,
  'the season-2 survival objective is archived as MET (won the top tier → safely up)');
// ── all-time club records (pure reduction over the archive) ────────────────────────────────────
const recs = history.getClubRecords(teamId);
check(recs.seasons === 2 && recs.titles === 2, 'club records count seasons + titles across the archive');
check(recs.promotions >= 1 && recs.bestFinish?.position === 1, 'records capture promotions + a best finish of 1st');
check(recs.mostPoints != null && recs.mostGoals != null && recs.cups >= 1, 'records compute most points / goals / cups');
const obj3 = obj.getObjective(teamId);
check(obj3 != null && obj3.season === 3 && obj3.kind === 'title', 'a top-tier champion is next set a title objective');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// tools/_season_test.ts — engine-free regression for web/backend/season.ts + history.ts
// (pillar 3: seasons / divisions / rollover + the honours archive). Recreated from the
// GAME_LAYER_NOTES.md ledger entries:
//
//   "Pillar 3 — Seasons & divisions. A new user's world is now TWO divisions ... an 8-team
//    Championship-style league below, stronger Division 1 above. season.ts: worldLeagues,
//    pendingMatchday (each division's EARLIEST round that still has an unplayed fixture ...
//    a fixture the user pre-played by watching it gets its round completed rather than
//    orphaned), seasonComplete, and rolloverSeason (one tx: prize money by position,
//    [promotion/relegation], every player ages +1, season++, fixtures regenerated,
//    free-agent pools refreshed). ... Verified by tools/_season_test.ts (34 assertions)"
//
//   "Season history / honours archive (history.ts, season_history table ...). One row per
//    club per finished season, written inside the rollover tx (step 2b, BEFORE fixtures are
//    purged + the season counter advances — recordSeasonHistory, idempotent via INSERT OR
//    IGNORE on a unique (team, season) index): final position/record, champion/promoted/
//    [relegated/cup/pots]. Verified by tools/_history_test.ts ... + the 8-season multiseason
//    regression" — the rollover-side half of that archive is asserted here.
//
// The world is seeded with Math.random (rosters, fixture seeds), so emergent values (scores,
// who wins) are asserted as INVARIANTS (conservation, bounds, arithmetic), never exactly.
// Matches resolve through the REAL playFixture path with FOOTY_FAST_SIM=1 (the deterministic
// fast-resolve tier that exists exactly so a headless season is cheap — see fastsim.ts).
//
// Run: cd <repo> && npx tsx tools/_season_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run + chdir into the scratchpad BEFORE importing any
// backend module, so match.ts's spec scratch (cwd/web/backend/data/specs) lands in the
// scratchpad too — the repo's web/backend/data/ is never touched.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.ts resolves FOOTY_DB at IMPORT time and match.ts resolves its spec dir from process.cwd()
// at IMPORT time — so pin both BEFORE any backend module loads (all backend imports are dynamic).
const SCRATCH = path.join(os.tmpdir(), 'footy-test');
const TESTDB_DIR = path.join(SCRATCH, 'testdb');
const CWD_DIR = path.join(SCRATCH, `season_cwd_${process.pid}`);
mkdirSync(TESTDB_DIR, { recursive: true });
mkdirSync(CWD_DIR, { recursive: true });
process.chdir(CWD_DIR);
const DB_PATH = path.join(TESTDB_DIR, `season_${process.pid}_${Date.now()}.sqlite`);
process.env.FOOTY_DB = DB_PATH;
process.env.FOOTY_FAST_SIM = '1';

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const season = await import('../web/backend/season.ts');
const history = await import('../web/backend/history.ts');
const objectives = await import('../web/backend/objectives.ts');
const match = await import('../web/backend/match.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

const count = (sql: string, ...args: (number | string)[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);
const budgetOf = (teamId: number): number =>
  Number((db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget);

// Play every remaining matchday of the world; returns the number of advances (matchdays)
// and the pendingMatchday batch sizes seen along the way.
async function playOutSeason(leagueId: number): Promise<{ advances: number; batchSizes: number[] }> {
  const batchSizes: number[] = [];
  for (;;) {
    const ids = season.pendingMatchday(leagueId);
    if (!ids.length) break;
    batchSizes.push(ids.length);
    for (const id of ids) { await match.playFixture(id); }
  }
  return { advances: batchSizes.length, batchSizes };
}

try {
  // ── WORLD SHAPE ─────────────────────────────────────────────────────────────
  // Ledger: "A new user's world is now TWO divisions: the user starts in an 8-team
  // Championship-style league below, stronger Division 1 above" / "The two leagues share a
  // world_id (= the tier-1 league id) so promotion/relegation + rollover can move teams".
  const userId = Number(db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('season_test', 'x', 'x', 0)").run().lastInsertRowid);
  const { leagueId, teamId: humanTeamId, worldId } = game.newSeasonForUser(userId, 'season_test', 'Test United', game.DEFAULT_TACTICS);

  const leagues = season.worldLeagues(leagueId);
  assert(leagues.length === 2 && leagues[0].tier === 1 && leagues[1].tier === 2, `worldLeagues returns the two divisions tier-ascending (got ${JSON.stringify(leagues.map(l => l.tier))})`);
  assert(leagues[0].season === 1 && leagues[1].season === 1, 'both divisions start at season 1');
  const div1Id = leagues[0].id, div2Id = leagues[1].id;
  assert(div1Id === worldId && div2Id === leagueId, 'tier 1 league id IS the world_id; the user league is the tier-2 division');
  const fromTop = season.worldLeagues(div1Id);
  assert(fromTop.length === 2 && fromTop[0].id === div1Id && fromTop[1].id === div2Id, 'worldLeagues from the tier-1 id resolves the SAME world (world_id linkage)');
  assert(count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div1Id) === game.LEAGUE_SIZE
      && count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div2Id) === game.LEAGUE_SIZE, 'each division holds exactly LEAGUE_SIZE (8) clubs');
  const humanLeague = (db.prepare('SELECT league_id AS l FROM teams WHERE id = ?').get(humanTeamId) as { l: number }).l;
  assert(humanLeague === div2Id, 'the human club starts in the second division (the first goal is promotion)');
  // 8 clubs, double round-robin: 14 rounds x 4 matches = 56 fixtures per division
  const FIX = 56, ROUNDS = 14;
  assert(count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ?', div1Id) === FIX
      && count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ?', div2Id) === FIX
      && count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id IN (?, ?) AND played = 1', div1Id, div2Id) === 0,
    'each division gets a 56-fixture double round-robin, all unplayed');
  assert(season.worldLeagues(99999).length === 0 && season.seasonComplete(99999) === false && season.rolloverSeason(99999) === null,
    'an unknown league resolves to no world: seasonComplete false, rollover null');

  // ── PENDING MATCHDAY ────────────────────────────────────────────────────────
  // Ledger: "pendingMatchday (each division's EARLIEST round that still has an unplayed
  // fixture ... a fixture the user pre-played by watching it gets its round completed
  // rather than orphaned, and divisions that drift out of step each catch up one round)".
  const first = season.pendingMatchday(leagueId);
  const roundOf = (id: number): number => (db.prepare('SELECT round FROM fixtures WHERE id = ?').get(id) as { round: number }).round;
  assert(first.length === 8 && first.every(id => roundOf(id) === 1), `the first matchday is both divisions' round 1 (8 fixtures; got ${first.length})`);

  const prePlayId = (db.prepare('SELECT id FROM fixtures WHERE league_id = ? AND round = 2 ORDER BY id LIMIT 1').get(div2Id) as { id: number }).id;
  const pre = await match.playFixture(prePlayId);
  assert(pre.alreadyPlayed === false && season.pendingMatchday(leagueId).join(',') === first.join(','),
    'a pre-played round-2 fixture does not disturb the pending matchday (still the same 8 round-1 fixtures)');
  const again = await match.playFixture(prePlayId);
  assert(again.alreadyPlayed === true && again.homeScore === pre.homeScore && again.awayScore === pre.awayScore,
    'replaying a played fixture is idempotent (same recorded score)');
  assert(season.seasonComplete(leagueId) === false && season.rolloverSeason(leagueId) === null,
    'rolloverSeason refuses to run while the season is incomplete (returns null)');

  // ── PLAY THE SEASON OUT (fastsim) ───────────────────────────────────────────
  const s1 = await playOutSeason(leagueId);
  assert(s1.advances === ROUNDS, `the world plays out in exactly 14 advances (got ${s1.advances})`);
  assert(s1.batchSizes[1] === 7, `the catch-up advance completes the pre-played round: 4 + 3 fixtures (got ${s1.batchSizes[1]})`);
  assert(count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id IN (?, ?) AND played = 0', div1Id, div2Id) === 0
      && season.seasonComplete(leagueId) === true, 'seasonComplete once every fixture in every division is played');

  // ── TABLE INTEGRITY ─────────────────────────────────────────────────────────
  // Ledger: "worldStandings ... every division's table" — assert the frozen final tables'
  // arithmetic (played counts, points, conservation) in both divisions.
  const finals = season.worldLeagues(leagueId).map(l => ({ league: l, table: game.standings(l.id) }));
  for (const { league, table } of finals) {
    assert(table.length === 8 && table.every(s => s.played === ROUNDS && s.won + s.drawn + s.lost === s.played),
      `${league.name}: every club played 14 with W+D+L == played`);
    assert(table.every(s => s.points === 3 * s.won + s.drawn && s.gd === s.gf - s.ga),
      `${league.name}: points == 3W + D and gd == gf - ga for every row`);
    const sum = (k: 'gf' | 'ga' | 'won' | 'lost' | 'drawn' | 'points'): number => table.reduce((a, s) => a + s[k], 0);
    assert(sum('gf') === sum('ga') && sum('won') === sum('lost'), `${league.name}: goals and wins conserve inside the division`);
    assert(sum('points') === 3 * FIX - sum('drawn') / 2, `${league.name}: total points == 168 - drawn matches (got ${sum('points')})`);
    assert(table.every((s, i) => i === 0 || (table[i - 1].points > s.points
        || (table[i - 1].points === s.points && (table[i - 1].gd > s.gd
        || (table[i - 1].gd === s.gd && table[i - 1].gf >= s.gf))))),
      `${league.name}: the table sorts by points, then gd, then gf`);
  }

  // ── PRIZE MONEY (pure fn) ───────────────────────────────────────────────────
  // Ledger: "prize money by position" / season.ts: tier 1 pays ~£160M champion down to a
  // ~£100M floor; tier 2 £12M → £3M.
  assert(season.prizeMoney(1, 1, 8) === 160_000_000 && season.prizeMoney(1, 8, 8) === 100_000_000, 'tier-1 purse: £160M champion, £100M floor');
  assert(season.prizeMoney(2, 1, 8) === 12_000_000 && season.prizeMoney(2, 8, 8) === 3_000_000, 'tier-2 purse: £12M champion, £3M floor');
  for (const tier of [1, 2]) {
    let mono = true;
    for (let p = 2; p <= 8; p++) { if (season.prizeMoney(tier, p, 8) > season.prizeMoney(tier, p - 1, 8)) { mono = false; } }
    assert(mono, `tier-${tier} prize money is non-increasing down the table`);
  }

  // ── SEED THE ROLLOVER-VISIBLE STATE ─────────────────────────────────────────
  // (test fixtures, not gameplay: a veteran to retire, two award-worthy rating tallies —
  // playFixture's summary path doesn't bump season_apps; that belongs to the aftermath tick)
  const vetClubId = finals[0].table[2].teamId;                          // a tier-1 club that stays up
  const vetId = Number((db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY id LIMIT 1').get(vetClubId) as { id: number }).id);
  db.prepare('UPDATE players SET age = 40 WHERE id = ?').run(vetId);    // ages to 41 → past RETIRE_AGE (37)
  db.prepare("UPDATE players SET name = 'Award Senior', season_apps = 10, season_rating_sum = 82 WHERE team_id = ? AND slot = 0").run(humanTeamId);
  db.prepare("UPDATE players SET name = 'Award Junior', age = 19, season_apps = 8, season_rating_sum = 60 WHERE team_id = ? AND slot = 1").run(humanTeamId);
  const seniorId = Number((db.prepare("SELECT id FROM players WHERE team_id = ? AND slot = 0").get(humanTeamId) as { id: number }).id);

  const ageBefore = new Map((db.prepare('SELECT p.id, p.age FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (?, ?)')
    .all(div1Id, div2Id) as { id: number; age: number }[]).map(r => [r.id, r.age]));
  const stayClub = finals[0].table[3];                                  // tier-1 4th place: stays, pure prize delta
  const upClub = finals[1].table[0];                                    // tier-2 champion: promoted, prize + windfall
  const stayBudget = budgetOf(stayClub.teamId), upBudget = budgetOf(upClub.teamId);
  const maxFaBefore = Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM free_agents').get() as { m: number }).m);
  const maxFixBefore = Number((db.prepare('SELECT MAX(id) AS m FROM fixtures').get() as { m: number }).m);
  const humanFinal = finals[1].table.find(s => s.teamId === humanTeamId)!;
  const humanPos = finals[1].table.indexOf(humanFinal) + 1;

  // ── ROLLOVER ────────────────────────────────────────────────────────────────
  // Ledger: "rolloverSeason (one tx: prize money by position, promotion/relegation, every
  // player ages +1, season++, fixtures regenerated, free-agent pools refreshed)".
  const res = season.rolloverSeason(leagueId);
  assert(res !== null && res.season === 2, 'a complete season rolls over to season 2');
  const r = res!;
  assert(r.divisions.length === 2 && r.divisions[0].champion === finals[0].table[0].name && r.divisions[1].champion === finals[1].table[0].name,
    'the summary crowns each division\'s champion from the frozen final tables');

  // Ledger (pillar-3 spec): "promote bottom of Div 1 ↔ relegate top of Div 2 (e.g. swap 2
  // teams)" — PROMOTE = 2 of 8.
  assert(season.PROMOTE === 2, 'the documented swap size: 2 clubs promoted / 2 relegated');
  const upIds = finals[1].table.slice(0, 2).map(s => s.teamId).sort().join(',');
  const downIds = finals[0].table.slice(-2).map(s => s.teamId).sort().join(',');
  assert(r.promoted.length === 2 && r.promoted.map(p => p.teamId).sort().join(',') === upIds
      && r.promoted.every(p => p.fromTier === 2 && p.toTier === 1),
    'exactly the top 2 of Division 2 go up (2 → 1)');
  assert(r.relegated.length === 2 && r.relegated.map(p => p.teamId).sort().join(',') === downIds
      && r.relegated.every(p => p.fromTier === 1 && p.toTier === 2),
    'exactly the bottom 2 of Division 1 go down (1 → 2)');
  const leagueOf = (id: number): number => (db.prepare('SELECT league_id AS l FROM teams WHERE id = ?').get(id) as { l: number }).l;
  assert(r.promoted.every(p => leagueOf(p.teamId) === div1Id) && r.relegated.every(p => leagueOf(p.teamId) === div2Id)
      && count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div1Id) === 8
      && count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div2Id) === 8,
    'the four movers actually swapped divisions and both divisions still hold 8 clubs');
  const wageOf = (id: number): number => (db.prepare('SELECT wage_budget AS w FROM teams WHERE id = ?').get(id) as { w: number }).w;
  assert(r.promoted.every(p => wageOf(p.teamId) === game.TIER_FINANCE[1].wageBudget)
      && r.relegated.every(p => wageOf(p.teamId) === game.TIER_FINANCE[2].wageBudget),
    'promotion lifts a club to the tier-1 wage budget; relegation drops it to tier-2');

  assert(r.prizeMoney.length === 16 && new Set(r.prizeMoney.map(p => p.teamId)).size === 16,
    'every club in the world banks prize money exactly once');
  assert(budgetOf(stayClub.teamId) - stayBudget === season.prizeMoney(1, 4, 8),
    `a staying tier-1 club's budget moves by exactly its positional prize (got ${budgetOf(stayClub.teamId) - stayBudget})`);
  assert(budgetOf(upClub.teamId) - upBudget === season.prizeMoney(2, 1, 8) + 40_000_000,
    'a promoted club banks its tier-2 prize PLUS the £40M promotion windfall');
  const humanPrize = db.prepare("SELECT amount FROM finance_entries WHERE team_id = ? AND kind = 'prize' AND note LIKE 'Prize money%'").all(humanTeamId) as { amount: number }[];
  assert(humanPrize.length === 1 && humanPrize[0].amount === season.prizeMoney(2, humanPos, 8),
    'the human club\'s prize is recorded in the finance ledger at the exact positional amount');

  // ── AGEING / RETIREMENT / YOUTH ─────────────────────────────────────────────
  // Ledger: "every player ages +1" / youth: "retire veterans + bring through prospects"
  // hooked "inside the rollover" ("Verified by tools/_youth_test.ts (17) + season (36)").
  const after = db.prepare('SELECT p.id, p.age, p.team_id FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (?, ?)')
    .all(div1Id, div2Id) as { id: number; age: number; team_id: number }[];
  const survivors = after.filter(p => ageBefore.has(p.id));
  assert(survivors.every(p => p.age === ageBefore.get(p.id)! + 1), 'every surviving player aged exactly +1');
  assert(survivors.length === ageBefore.size - 1 && !after.some(p => p.id === vetId),
    'exactly one player left the game: the 40-y/o veteran retired');
  assert(r.youth.some(e => e.type === 'retired' && e.teamId === vetClubId && e.age === 41),
    'the rollover summary reports his retirement at 41');
  assert(r.youth.filter(e => e.type === 'intake').length === 32, `youth intake: 2 prospects per club, 16 clubs (got ${r.youth.filter(e => e.type === 'intake').length})`);
  const squadSizes = db.prepare('SELECT t.id, t.user_id, COUNT(p.id) AS n FROM teams t JOIN players p ON p.team_id = t.id WHERE t.league_id IN (?, ?) GROUP BY t.id')
    .all(div1Id, div2Id) as { id: number; user_id: number | null; n: number }[];
  assert(squadSizes.every(s => s.user_id != null ? s.n === 17 : s.n === (s.id === vetClubId ? 18 : 19)),
    'AI intake lands in the squad (17 → 19; the retiree club 18); the HUMAN intake goes to the academy, squad stays 17');
  assert(count('SELECT COUNT(*) AS n FROM youth_prospects WHERE team_id = ?', humanTeamId) === 2,
    'the human club\'s 2 prospects sit in the visible academy (youth_prospects)');

  // ── NEW SEASON STARTS CLEAN ─────────────────────────────────────────────────
  // Ledger: "season++, fixtures regenerated, free-agent pools refreshed" / fitness:
  // "resetFitness at rollover (pre-season)" / "fresh rating + goal/assist tally".
  const leagues2 = season.worldLeagues(leagueId);
  assert(leagues2.every(l => l.season === 2), 'both divisions advanced to season 2');
  assert(count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ?', div1Id) === FIX
      && count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ?', div2Id) === FIX
      && count('SELECT COUNT(*) AS n FROM fixtures WHERE league_id IN (?, ?) AND played = 1', div1Id, div2Id) === 0
      && Number((db.prepare('SELECT MIN(id) AS m FROM fixtures').get() as { m: number }).m) > maxFixBefore,
    'fixtures are regenerated from scratch: 56 fresh unplayed fixtures per division, all new rows');
  const fresh = game.standings(div2Id);
  assert(fresh.every(s => s.played === 0 && s.points === 0 && s.gf === 0 && s.ga === 0), 'the new season\'s table is all zeroes');
  assert(season.seasonComplete(leagueId) === false && season.pendingMatchday(leagueId).length === 8,
    'the new season is live again: incomplete, with a fresh round-1 matchday pending');
  assert(after.length === count('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (?, ?) AND p.fitness = 100 AND p.injured_matches = 0 AND p.morale = 65', div1Id, div2Id),
    'pre-season reset: every player reports back fit (100), uninjured, at neutral morale (65)');
  assert(count('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (?, ?) AND (p.season_apps != 0 OR p.season_goals != 0 OR p.season_assists != 0 OR p.season_rating_sum != 0)', div1Id, div2Id) === 0,
    'the season rating + goal/assist tallies reset to zero');
  assert(count('SELECT COUNT(*) AS n FROM free_agents WHERE league_id = ?', div1Id) === game.FREE_AGENT_COUNT
      && count('SELECT COUNT(*) AS n FROM free_agents WHERE league_id = ?', div2Id) === game.FREE_AGENT_COUNT
      && Number((db.prepare('SELECT MIN(id) AS m FROM free_agents').get() as { m: number }).m) > maxFaBefore,
    'each division\'s free-agent pool is refreshed: a brand-new crop of 28');
  assert(count('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id IN (?, ?) AND (p.contract_years < 1 OR p.contract_years > 5)', div1Id, div2Id) === 0,
    'after the contract tick nobody is out of contract (every deal 1..5 years)');
  assert(count('SELECT COUNT(*) AS n FROM cup_ties WHERE world_id = ? AND season = 2 AND round = 1', worldId) === 8,
    'a fresh 16-club cup is drawn for the new season (8 round-1 ties)');
  assert(season.rolloverSeason(leagueId) === null, 'a double rollover is impossible: the fresh season is incomplete, so the guard returns null');

  // ── SEASON HISTORY / HONOURS ────────────────────────────────────────────────
  // Ledger: "One row per club per finished season, written inside the rollover tx (step 2b,
  // BEFORE fixtures are purged + the season counter advances): final position/record,
  // champion/promoted/[relegated/cup/pots]" — human clubs only.
  assert(count('SELECT COUNT(*) AS n FROM season_history') === 1, 'exactly one archive row is written: the human club (AI clubs are not archived)');
  const h = history.getHistory(humanTeamId);
  assert(h.length === 1 && h[0].season === 1 && h[0].tier === 2 && h[0].division === leagues[1].name,
    'the row archives season 1 in the tier-2 division by name');
  assert(h[0].position === humanPos && h[0].played === 14 && h[0].won === humanFinal.won && h[0].drawn === humanFinal.drawn
      && h[0].lost === humanFinal.lost && h[0].gf === humanFinal.gf && h[0].ga === humanFinal.ga && h[0].points === humanFinal.points,
    'the archived record matches the frozen final table exactly (pos/P/W/D/L/GF/GA/Pts)');
  const humanUp = r.promoted.some(p => p.teamId === humanTeamId);
  assert(h[0].champion === (humanPos === 1) && h[0].promoted === humanUp && h[0].relegated === false && h[0].cupWon === false,
    'the honour flags match the finish (champion iff 1st, promoted iff top 2; no cup was decided)');

  // Ledger: "recordSeasonAwards at rollover (step 0b, before ageing + before the tally
  // resets) crowns the club's Player of the Season + Young Player of the Season (U-21)".
  assert(r.awards.some(a => a.type === 'pots' && a.player === 'Award Senior' && a.teamId === humanTeamId)
      && r.awards.some(a => a.type === 'young_pots' && a.player === 'Award Junior'),
    'the rating tally crowns Player of the Season (avg 8.2) + Young Player (19, avg 7.5) before it resets');
  assert(h[0].pots === 'Award Senior', 'the archive row carries the Player of the Season name');

  // Ledger (objectives): "the finished season's target + verdict are archived into
  // season_history alongside the honours" — a fresh tier-2 club's opening target is promotion.
  assert(h[0].objective !== null && h[0].objective!.kind === 'promotion' && h[0].objective!.target === 2
      && h[0].objective!.met === (humanPos <= 2),
    'the board\'s season-1 promotion target is archived with the right verdict');
  // Ledger (confidence): "the rollover board verdict (tone/message/confidence) persisted on
  // season_history" + surfaced in the rollover summary.
  assert(h[0].board !== null && h[0].board!.message.length > 0
      && h[0].board!.confidence >= 0 && h[0].board!.confidence <= 100,
    'the board\'s end-of-season verdict rides on the archive row (tone/message/confidence)');
  assert(r.board.length === 1 && r.board[0].teamId === humanTeamId && r.board[0].message.length > 0,
    'the rollover summary delivers exactly one board verdict — the human club\'s');

  // Ledger (history.ts): per-player career archive "written at rollover ... BEFORE the live
  // season_* columns reset. Only players who actually appeared (apps > 0) get a row".
  assert(count('SELECT COUNT(*) AS n FROM player_season_stats WHERE team_id = ?', humanTeamId) === 2,
    'only the two players with apps > 0 get a career line');
  const career = history.getPlayerCareer(seniorId);
  assert(career.length === 1 && career[0].season === 1 && career[0].club === 'Test United'
      && career[0].apps === 10 && career[0].avgRating === 8.2,
    'the career line snapshots club/apps and derives the average rating (82 / 10 = 8.2)');

  // Ledger: "idempotent via INSERT OR IGNORE on a unique (team, season) index, so a re-run
  // (or a double rollover) can never duplicate a row".
  history.recordSeasonHistory({ teamId: humanTeamId, season: 1, tier: 2, division: 'Bogus', table: finals[1].table, promoted: !humanUp, relegated: true, cupWon: true });
  const h2 = history.getHistory(humanTeamId);
  assert(h2.length === 1 && h2[0].division === leagues[1].name && h2[0].cupWon === false && h2[0].points === humanFinal.points,
    'a re-recorded (team, season) is ignored — the original row stands untouched');
  history.recordSeasonHistory({ teamId: finals[0].table[0].teamId, season: 1, tier: 2, division: 'X', table: finals[1].table, promoted: false, relegated: false, cupWon: false });
  assert(history.getHistory(finals[0].table[0].teamId).length === 0,
    'a club absent from the passed table writes no row (recordSeasonHistory returns early)');

  // Ledger: "A History nav button opens a trophy cabinet (titles/cups/promotions/seasons)".
  const rec = history.getClubRecords(humanTeamId);
  assert(rec.seasons === 1 && rec.titles === (humanPos === 1 ? 1 : 0) && rec.promotions === (humanUp ? 1 : 0)
      && rec.relegations === 0 && rec.cups === 0,
    'the trophy cabinet reduces over the archive (seasons/titles/promotions)');
  assert(rec.bestFinish !== null && rec.bestFinish!.position === humanPos && rec.bestFinish!.tier === 2 && rec.bestFinish!.season === 1
      && rec.mostPoints!.points === humanFinal.points && rec.mostGoals!.gf === humanFinal.gf,
    'best finish / most points / most goals all point at the lone archived season');

  // Ledger (objectives): the objective for the COMING season is set "at each rollover (for
  // the NEW tier)" — cross-check against deriveObjective on the club's new circumstances.
  const newObj = objectives.getObjective(humanTeamId);
  const expectObj = objectives.deriveObjective({
    tier: humanUp ? 1 : 2, size: 8, promote: season.PROMOTE, prevPosition: humanPos,
    justPromoted: humanUp, justRelegated: false, isTopTier: humanUp,
  });
  assert(newObj !== null && newObj.season === 2 && newObj.kind === expectObj.kind && newObj.target === expectObj.target,
    `the season-2 board target matches deriveObjective for the new tier (${expectObj.kind} <= ${expectObj.target})`);

  // ── SECOND SEASON: THE REGENERATED WORLD IS PLAYABLE ────────────────────────
  // Ledger: "squads now renew across seasons" / the 8-season multiseason regression —
  // asserted here for one further cycle so the regenerated fixtures + swapped divisions
  // demonstrably play out and archive again.
  const s2 = await playOutSeason(leagueId);
  assert(s2.advances === ROUNDS && season.seasonComplete(leagueId), 'the regenerated season plays out in 14 advances');
  const res2 = season.rolloverSeason(leagueId);
  assert(res2 !== null && res2.season === 3 && res2.promoted.length === 2 && res2.relegated.length === 2
      && count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div1Id) === 8
      && count('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?', div2Id) === 8,
    'the second rollover swaps 2 up / 2 down again and keeps both divisions at 8');
  const h3 = history.getHistory(humanTeamId);
  assert(h3.length === 2 && h3[0].season === 2 && h3[1].season === 1 && history.getClubRecords(humanTeamId).seasons === 2,
    'the archive accumulates: one row per finished season, newest first');
  assert(count('SELECT COUNT(*) AS n FROM youth_prospects WHERE team_id = ?', humanTeamId) === 4,
    'the academy develops across seasons: last year\'s 2 prospects (now a year older) + 2 new');

  console.log(`_season_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
  rmSync(CWD_DIR, { recursive: true, force: true });
}

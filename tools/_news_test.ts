// Dynamic player-news test (LLM stream). Throwaway FOOTY_DB; no engine, no LLM key (so the
// deterministic cue-append + keyword re-derive run). A synthetic recording of the user's match
// (a hat-trick + a red card) plus a long injury should: create news rows, EVOLVE each player's
// backstory, and RE-DERIVE his dials in the right direction (the text↔dial coupling). Idempotent
// per matchday.
//
//   npx tsx tools/_news_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-news-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';   // deterministic story evolution

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const match = await import('../web/backend/match.ts');
const news = await import('../web/backend/news.ts');

const u = registerUser('hack', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Newsy FC', game.DEFAULT_TACTICS);
const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
const squad = game.getTeamWithPlayers(teamId)!.players;
const A = squad[0].name, B = squad[1].name, C = squad[2].name;   // scorer, sent-off, injured
const traitsOf = (slot: number) => JSON.parse((db.prepare('SELECT personality FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { personality: string | null }).personality ?? '{"traits":{}}').traits ?? {};

const fx = db.prepare('SELECT id, home_team_id FROM fixtures WHERE league_id = ? AND (home_team_id = ? OR away_team_id = ?) ORDER BY round LIMIT 1').get(leagueId, teamId, teamId) as { id: number; home_team_id: number };
const userSide: 'home' | 'away' = fx.home_team_id === teamId ? 'home' : 'away';
const oppSide = userSide === 'home' ? 'away' : 'home';
const min = (n: number) => n * 60000;
const P = (id: number, name: string, team: 'home' | 'away', role: string, goals = 0, sentOff = false) =>
  ({ id, name, team, role, goals, assists: 0, shots: goals, tackles: 0, passes: 0, passesCompleted: 0, yellow: 0, sentOff });
const frame = (clockMs: number, userScore: number, players: ReturnType<typeof P>[], state = 'live') =>
  JSON.stringify({ clockMs, homeScore: userSide === 'home' ? userScore : 0, awayScore: userSide === 'away' ? userScore : 0, matchState: state, possessionPct: 50, homeShots: 5, awayShots: 5, shotsOnTarget: 5, saves: 3, cornersAwarded: 5, players });
const opp = P(11, 'Opp One', oppSide, 'CF');
// A scores three (each goal lifts the user score), B is sent off on 55', C does nothing notable
const lines = [
  frame(0, 0, [P(0, A, userSide, 'CF'), P(1, B, userSide, 'CB'), P(2, C, userSide, 'CM'), opp]),
  frame(min(20), 1, [P(0, A, userSide, 'CF', 1), P(1, B, userSide, 'CB'), P(2, C, userSide, 'CM'), opp]),
  frame(min(40), 2, [P(0, A, userSide, 'CF', 2), P(1, B, userSide, 'CB'), P(2, C, userSide, 'CM'), opp]),
  frame(min(55), 2, [P(0, A, userSide, 'CF', 2), P(1, B, userSide, 'CB', 0, true), P(2, C, userSide, 'CM'), opp]),
  frame(min(60), 3, [P(0, A, userSide, 'CF', 3), P(1, B, userSide, 'CB', 0, true), P(2, C, userSide, 'CM'), opp]),
  frame(min(90), 3, [P(0, A, userSide, 'CF', 3), P(1, B, userSide, 'CB', 0, true), P(2, C, userSide, 'CM'), opp], 'finished'),
];
await match.persistRecording('fixture', fx.id, lines);

// before: capture the would-be-evolved dials + morale
const before = { bigGameA: traitsOf(0).bigGame, tempB: traitsOf(1).temperament };
const moraleOf = (s: number) => (db.prepare('SELECT morale FROM players WHERE team_id = ? AND slot = ?').get(teamId, s) as { morale: number }).morale;
const mA0 = moraleOf(0), mB0 = moraleOf(1);

// ── process the matchday aftermath from the --summary per-player stats (the final state) + a long
//    injury for C from the fitness tick. The aftermath rates off these stats, NOT the frame recording. ──
db.prepare('UPDATE fixtures SET home_score = ?, away_score = ? WHERE id = ?').run(userSide === 'home' ? 3 : 0, userSide === 'away' ? 3 : 0, fx.id);
const summaryPlayers = [P(0, A, userSide, 'CF', 3), P(1, B, userSide, 'CB', 0, true), P(2, C, userSide, 'CM'), opp];
const headlines = await news.processMatchAftermath(teamId, fx.id, [{ teamId, player: C, matches: 4 }], summaryPlayers);
check(headlines.some(h => h.includes(A)) && headlines.some(h => h.includes(B)) && headlines.some(h => h.includes(C)), 'all three players make the headlines');

const rows = db.prepare('SELECT player_name, type FROM player_news WHERE team_id = ?').all(teamId) as { player_name: string; type: string }[];
check(rows.some(r => r.player_name === A && r.type === 'hat_trick'), 'a hat-trick is detected from the --summary stats (3 goals)');
check(rows.some(r => r.player_name === B && r.type === 'red_card'), 'a sending-off is detected');
check(rows.some(r => r.player_name === C && r.type === 'long_injury'), 'a long injury becomes news');
check(rows.length === 3, `exactly three news items this matchday (got ${rows.length})`);

// ── the events EVOLVED the players: story rewritten + dials re-derived in the right direction ──
const aStory = JSON.parse((db.prepare('SELECT personality FROM players WHERE team_id = ? AND slot = 0').get(teamId) as { personality: string }).personality);
check(/hat-trick/i.test(aStory.backstory), "the scorer's backstory now mentions the hat-trick");
check(traitsOf(0).bigGame > (before.bigGameA ?? 50), `the hat-trick lifts the scorer's big-game dial (${before.bigGameA ?? 50} → ${traitsOf(0).bigGame})`);
check(traitsOf(1).temperament > (before.tempB ?? 50), `the red card raises the offender's temperament dial (${before.tempB ?? 50} → ${traitsOf(1).temperament})`);
check(traitsOf(2).praiseResponse > 50 || traitsOf(2).consistency < 50, "the long injury leaves the player needing encouragement / more fragile");

// ── ratings → morale: the standout's morale rose, the sent-off player's fell; the tally records it ──
check(moraleOf(0) > mA0, `the hat-trick hero's morale rose (${mA0} → ${moraleOf(0)})`);
check(moraleOf(1) < mB0, `the sent-off player's morale fell (${mB0} → ${moraleOf(1)})`);
check((db.prepare('SELECT season_apps FROM players WHERE team_id = ? AND slot = 0').get(teamId) as { season_apps: number }).season_apps === 1, 'the season rating tally records the appearance');

// ── idempotent per matchday (re-processing the same fixture does nothing) ─────────────────────
const bigGameAfter = traitsOf(0).bigGame, mAfterA = moraleOf(0);
const again = await news.processMatchAftermath(teamId, fx.id, [{ teamId, player: C, matches: 4 }]);
check(again.length === 0, 're-processing the same matchday yields no new news');
check((db.prepare('SELECT COUNT(*) AS n FROM player_news WHERE team_id = ?').get(teamId) as { n: number }).n === 3, 'still exactly three news rows (no duplicates)');
check(traitsOf(0).bigGame === bigGameAfter && moraleOf(0) === mAfterA, 'no double-apply on re-process (dials + morale unchanged)');
check((db.prepare('SELECT season_apps FROM players WHERE team_id = ? AND slot = 0').get(teamId) as { season_apps: number }).season_apps === 1, 'the tally is not double-counted either');

check(news.recentNews(teamId).length === 3, 'recentNews returns the feed');

// ── review fix #1: an opponent's red card must NOT evolve a same-named user player ───────────
const fixtures = db.prepare('SELECT id, home_team_id FROM fixtures WHERE league_id = ? AND (home_team_id = ? OR away_team_id = ?) ORDER BY round').all(leagueId, teamId, teamId) as { id: number; home_team_id: number }[];
const f = (clockMs: number, hs: number, as: number, players: ReturnType<typeof P>[], state = 'live') =>
  JSON.stringify({ clockMs, homeScore: hs, awayScore: as, matchState: state, possessionPct: 50, homeShots: 0, awayShots: 0, shotsOnTarget: 0, saves: 0, cornersAwarded: 0, players });
const fx2 = fixtures[1]; const s2: 'home' | 'away' = fx2.home_team_id === teamId ? 'home' : 'away'; const o2 = s2 === 'home' ? 'away' : 'home';
const D = squad[3].name;   // a user player who shares a name with a sent-off OPPONENT
await match.persistRecording('fixture', fx2.id, [
  f(0, 0, 0, [P(0, D, s2, 'CM'), P(11, D, o2, 'CF')]),
  f(min(50), 0, 0, [P(0, D, s2, 'CM'), P(11, D, o2, 'CF', 0, true)], 'finished'),
]);
db.prepare('UPDATE fixtures SET home_score = 0, away_score = 0 WHERE id = ?').run(fx2.id);
await news.processMatchAftermath(teamId, fx2.id, [], [P(0, D, s2, 'CM'), P(11, D, o2, 'CF', 0, true)]);
check(!db.prepare("SELECT 1 FROM player_news WHERE team_id = ? AND ref_id = ? AND type = 'red_card'").get(teamId, fx2.id), "an opponent's red card does NOT create a red_card for a same-named user player (filtered by team)");
check((db.prepare('SELECT personality FROM players WHERE team_id = ? AND slot = 3').get(teamId) as { personality: string | null }).personality === null, "the same-named user player's story is left untouched");

// ── review fix #2: a duplicate squad name drops the event rather than evolving the wrong twin ─
db.prepare('UPDATE players SET name = ? WHERE team_id = ? AND slot IN (4, 5)').run('Twin Name', teamId);
const fx3 = fixtures[2]; const s3: 'home' | 'away' = fx3.home_team_id === teamId ? 'home' : 'away';
const sc = (n: number): [number, number] => (s3 === 'home' ? [n, 0] : [0, n]);
const oppT = P(11, 'Opp Two', s3 === 'home' ? 'away' : 'home', 'CF');
await match.persistRecording('fixture', fx3.id, [
  f(0, ...sc(0), [P(4, 'Twin Name', s3, 'CF', 0), oppT]),
  f(min(20), ...sc(1), [P(4, 'Twin Name', s3, 'CF', 1), oppT]),
  f(min(40), ...sc(2), [P(4, 'Twin Name', s3, 'CF', 2), oppT]),
  f(min(60), ...sc(3), [P(4, 'Twin Name', s3, 'CF', 3), oppT], 'finished'),
]);
await news.processMatchAftermath(teamId, fx3.id, []);
check(!db.prepare('SELECT 1 FROM player_news WHERE team_id = ? AND ref_id = ?').get(teamId, fx3.id), 'a duplicate squad name drops the event (no mis-attributed news)');
check((db.prepare('SELECT personality FROM players WHERE team_id = ? AND slot = 4').get(teamId) as { personality: string | null }).personality === null
  && (db.prepare('SELECT personality FROM players WHERE team_id = ? AND slot = 5').get(teamId) as { personality: string | null }).personality === null, 'neither same-named twin is evolved');

// ── season awards: the highest-average eligible player (>= 3 games) is crowned, + a young one ─
db.prepare('UPDATE players SET season_rating_sum = ?, season_apps = ?, age = 27 WHERE team_id = ? AND slot = 6').run(40, 5, teamId);   // avg 8.0
db.prepare('UPDATE players SET season_rating_sum = ?, season_apps = ?, age = 19 WHERE team_id = ? AND slot = 7').run(36, 5, teamId);   // avg 7.2, U-21
const returned = news.recordSeasonAwards(teamId, 1);
// §2.14: the awards are also RETURNED (so the rollover can surface them as a celebration moment)
check(returned.find(a => a.type === 'pots')?.player === squad[6].name, 'recordSeasonAwards returns the Player of the Season');
check(returned.find(a => a.type === 'young_pots')?.player === squad[7].name, 'recordSeasonAwards returns the Young Player of the Season');
const awards = db.prepare("SELECT type, player_name FROM player_news WHERE team_id = ? AND type IN ('pots','young_pots')").all(teamId) as { type: string; player_name: string }[];
check(awards.find(a => a.type === 'pots')?.player_name === squad[6].name, 'Player of the Season is the highest-rated eligible player (avg 8.0)');
check(awards.find(a => a.type === 'young_pots')?.player_name === squad[7].name, 'Young Player of the Season is the best eligible U-21');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

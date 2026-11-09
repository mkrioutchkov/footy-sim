// Opponent scouting-report test (no engine, no LLM). Builds a season, then asserts the report
// targets the OPPONENT, reads its dials into approach phrases, flags one danger man, and reflects
// synthesised form (fixtures marked played directly — never via the engine binary).
//
//   npx tsx tools/_scout_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-scout-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const scout = await import('../web/backend/scout.ts');

const u = registerUser('scout', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Scout FC', game.DEFAULT_TACTICS);

// an upcoming fixture the user is in
const fx = db.prepare('SELECT id, league_id, home_team_id, away_team_id, round FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round LIMIT 1')
  .get(teamId, teamId) as { id: number; home_team_id: number; away_team_id: number; round: number } | undefined;
check(!!fx, 'the user has an upcoming fixture to scout');
const oppId = fx!.home_team_id === teamId ? fx!.away_team_id : fx!.home_team_id;

// ── the report is about the OPPONENT ────────────────────────────────────────────────────────
const r = scout.buildScoutReport(fx!.id, teamId)!;
check(!!r, 'buildScoutReport returns a report');
check(r.opponent.teamId === oppId, 'the report targets the opponent, not the user');
check(r.opponent.name === game.getTeamWithPlayers(oppId)!.name, 'opponent name matches the squad');
check(r.venue === (fx!.home_team_id === teamId ? 'home' : 'away'), 'venue reflects where the USER plays');
check(r.round === fx!.round, 'round matches the fixture');
check(typeof r.opponent.position === 'number' && r.opponent.position! >= 1, 'opponent has a table position');

// ── key players: OVR-sorted, exactly one danger man (imminent match → up to 6 identified) ──────
check(r.keyPlayers.length > 0 && r.keyPlayers.length <= 6, 'up to 6 key players for the imminent match');
check(r.roundsAway === 0, 'the next fixture is the imminent one (0 rounds away)');
check(r.keyPlayers.every((p, i, a) => i === 0 || a[i - 1].overall >= p.overall), 'key players sorted by OVR desc');
check(r.keyPlayers.filter(p => p.danger).length === 1, 'exactly one danger man flagged');
check(r.form.length === 0, 'no form before any games are played');

// ── §2.8 bench tier: the imminent match reveals the squad behind the XI (names/OVR even with no scouts) ──
check(r.bench.length > 0, 'the bench tier surfaces the squad behind the XI for the imminent match');
check(r.bench.every(p => p.attrs === null), 'with no scouts, bench attributes stay hidden (names/OVR only)');
check(r.bench.every((p, i, a) => i === 0 || a[i - 1].overall >= p.overall), 'bench is OVR-sorted');
check(new Set([...r.keyPlayers, ...r.bench].map(p => p.name)).size <= game.getTeamWithPlayers(oppId)!.players.length, 'XI + bench never exceeds the squad');

// ── attribute fog: scouts reveal ranges that tighten with depth ───────────────────────────────
check(r.keyPlayers[0].attrs === null, 'with no scouts, opponent attributes are hidden');
const wid = (db.prepare('SELECT world_id AS w FROM leagues WHERE id = ?').get(game.getTeamWithPlayers(teamId)!.leagueId) as { w: number }).w;
const insScout = (rating: number) => db.prepare('INSERT INTO staff (world_id, team_id, role, name, rating, cost) VALUES (?,?,?,?,?,?)').run(wid, teamId, 'scout', 'sc', rating, 1);
insScout(90);   // depth 1
const rScout1 = scout.buildScoutReport(fx!.id, teamId)!;
check(rScout1.keyPlayers[0].attrs != null && rScout1.keyPlayers[0].attrs!.length === 7, 'one scout reveals all 7 attributes');
check(rScout1.keyPlayers[0].attrs!.some(a => a.hi > a.lo), 'a shallow scout report shows attribute RANGES, not exact values');
// §2.8: a scout opens up the bench tier too — but a fog-step fuzzier than the XI
const xiRange = rScout1.keyPlayers[0].attrs![0].hi - rScout1.keyPlayers[0].attrs![0].lo;
const benchRange = rScout1.bench[0].attrs ? rScout1.bench[0].attrs[0].hi - rScout1.bench[0].attrs[0].lo : -1;
check(rScout1.bench[0].attrs != null, 'a scout reveals bench attributes as ranges');
check(benchRange > xiRange, 'the bench tier reads fuzzier than the XI (wider ranges)');
insScout(90); insScout(90); insScout(90); insScout(90);   // total 5 scouts → depth 3
const rScout3 = scout.buildScoutReport(fx!.id, teamId)!;
check(rScout3.keyPlayers[0].attrs!.every(a => a.lo === a.hi), 'deep scouting reveals exact attributes (lo === hi)');
db.prepare('DELETE FROM staff WHERE team_id = ?').run(teamId);   // reset before the remaining checks

// ── approach is derived from the opponent's dials ────────────────────────────────────────────
db.prepare('UPDATE teams SET tactics = ? WHERE id = ?').run(
  JSON.stringify({ aggression: 90, passingDirectness: 90, overlapFrequency: 90, midfieldFreedom: 90, defensiveLineHeight: 90 }), oppId);
const r2 = scout.buildScoutReport(fx!.id, teamId)!;
check(r2.approach.some(a => /press high/i.test(a)), 'high aggression → a "press high" phrase');
check(r2.approach.some(a => /high defensive line/i.test(a)), 'high line → a "high defensive line" phrase');
db.prepare('UPDATE teams SET tactics = ? WHERE id = ?').run(
  JSON.stringify({ aggression: 20, passingDirectness: 20, overlapFrequency: 50, midfieldFreedom: 20, defensiveLineHeight: 20 }), oppId);
const r2b = scout.buildScoutReport(fx!.id, teamId)!;
check(r2b.approach.some(a => /sit off|low block/i.test(a)), 'low aggression/line → a defensive phrase');

// ── form reflects synthesised played games (no engine) ───────────────────────────────────────
const oppFx = db.prepare('SELECT id, home_team_id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND id != ? ORDER BY round LIMIT 2')
  .all(oppId, oppId, fx!.id) as { id: number; home_team_id: number }[];
// game 1: a win for the opponent; game 2: a loss
db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?')
  .run(oppFx[0].home_team_id === oppId ? 3 : 0, oppFx[0].home_team_id === oppId ? 0 : 3, oppFx[0].id);
db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?')
  .run(oppFx[1].home_team_id === oppId ? 0 : 2, oppFx[1].home_team_id === oppId ? 2 : 0, oppFx[1].id);
const r3 = scout.buildScoutReport(fx!.id, teamId)!;
check(r3.form.length === 2, 'two played games now appear in form');
check(r3.form.some(f => f.result === 'W') && r3.form.some(f => f.result === 'L'), 'form captures the win and the loss');
check(r3.form[0].round >= r3.form[1].round, 'form is most-recent-first');
check(r3.opponent.played >= 2 && r3.opponent.won >= 1 && r3.opponent.lost >= 1, 'opponent record reflects the games');

// ── negatives ────────────────────────────────────────────────────────────────────────────────
check(scout.buildScoutReport(999999, teamId) === null, 'a missing fixture → null');
const otherFx = db.prepare('SELECT id FROM fixtures WHERE home_team_id != ? AND away_team_id != ? LIMIT 1').get(teamId, teamId) as { id: number } | undefined;
check(!otherFx || scout.buildScoutReport(otherFx.id, teamId) === null, 'a fixture not involving the user → null');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

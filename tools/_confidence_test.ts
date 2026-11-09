// Board confidence / job security test (no engine). Unit checks on the status bands + the per-match
// drift + the rollover settle, plus an integration roll where a champion's confidence soars.
//
//   npx tsx tools/_confidence_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-conf-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const season = await import('../web/backend/season.ts');
const conf = await import('../web/backend/confidence.ts');

// ── status bands ──────────────────────────────────────────────────────────────────────────────
check(conf.confidenceStatus(80) === 'secure', '>=75 → secure');
check(conf.confidenceStatus(60) === 'stable', '50..74 → stable');
check(conf.confidenceStatus(30) === 'shaky', '28..49 → shaky');
check(conf.confidenceStatus(27) === 'at_risk', '<28 → at risk');

const u = registerUser('chairman', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Confidence FC', game.DEFAULT_TACTICS);

// ── a fresh club starts neutral ───────────────────────────────────────────────────────────────
check(conf.getConfidence(teamId)?.value === 55, 'a fresh club starts at 55 (neutral)');

// ── per-match drift ───────────────────────────────────────────────────────────────────────────
conf.nudgeConfidence(teamId, 'W');
check(conf.getConfidence(teamId)!.value === 57, 'a win nudges confidence +2');
conf.nudgeConfidence(teamId, 'L'); conf.nudgeConfidence(teamId, 'L');
check(conf.getConfidence(teamId)!.value === 53, 'losses nudge −2 each');
conf.nudgeConfidence(teamId, 'D');
check(conf.getConfidence(teamId)!.value === 53, 'a draw is neutral');
db.prepare('UPDATE teams SET board_confidence = 55 WHERE id = ?').run(teamId);   // reset

// ── rollover settle (direct) ──────────────────────────────────────────────────────────────────
db.prepare('UPDATE teams SET board_confidence = 50 WHERE id = ?').run(teamId);
let v = conf.settleConfidenceAtRollover({ teamId, finalPosition: 7, size: 8, promoted: false, relegated: false, objectiveMet: false });
check(v === 28, 'objective missed (−16) + bottom-third finish (−6) from 50 → 28');
db.prepare('UPDATE teams SET board_confidence = 60 WHERE id = ?').run(teamId);
v = conf.settleConfidenceAtRollover({ teamId, finalPosition: 8, size: 8, promoted: false, relegated: true, objectiveMet: false });
check(v === 14, 'relegation (−30) + objective missed (−16), no double bottom-third penalty: 60 → 14');
db.prepare('UPDATE teams SET board_confidence = 95 WHERE id = ?').run(teamId);
v = conf.settleConfidenceAtRollover({ teamId, finalPosition: 1, size: 8, promoted: true, relegated: false, objectiveMet: true });
check(v === 100, 'a triumphant season clamps at 100 (no overflow)');
db.prepare('UPDATE teams SET board_confidence = 10 WHERE id = ?').run(teamId);
v = conf.settleConfidenceAtRollover({ teamId, finalPosition: 8, size: 8, promoted: false, relegated: true, objectiveMet: false });
check(v === 0, 'a disastrous season clamps at 0 (no underflow)');
check(conf.confidenceStatus(0) === 'at_risk', '0 confidence reads as at risk');

// ── board verdict + escalating at-risk streak ─────────────────────────────────────────────────
db.prepare('UPDATE teams SET low_confidence_streak = 0 WHERE id = ?').run(teamId);
check(conf.boardVerdictAtRollover(teamId, 80, true).tone === 'backed', 'secure confidence → the board backs the manager');
check(conf.boardVerdictAtRollover(teamId, 60, false).tone === 'satisfied', 'stable confidence → the board stays supportive');
check(conf.boardVerdictAtRollover(teamId, 35, false).tone === 'concerned', 'shaky confidence → the board is concerned');
check(conf.boardVerdictAtRollover(teamId, 20, false).tone === 'warned', 'first at-risk season → a warning');
check(conf.boardVerdictAtRollover(teamId, 18, false).tone === 'final_warning', 'a second straight at-risk season → a final warning');
check(conf.boardVerdictAtRollover(teamId, 15, false).tone === 'sacked', 'a third straight at-risk season → SACKED (§2.5)');
check((db.prepare('SELECT sacked FROM teams WHERE id = ?').get(teamId) as { sacked: number }).sacked === 1, 'a sacking sets teams.sacked = 1');
db.prepare('UPDATE teams SET sacked = 0, low_confidence_streak = 0 WHERE id = ?').run(teamId);   // reset for the recovery checks
check(conf.boardVerdictAtRollover(teamId, 70, true).tone === 'satisfied', 'recovering above at-risk resets the streak');
check(conf.boardVerdictAtRollover(teamId, 20, false).tone === 'warned', 'after recovery the warning ladder starts again at a warning');
db.prepare('UPDATE teams SET low_confidence_streak = 0 WHERE id = ?').run(teamId);

// ── board mood + recruitment backing (pure presentation) ──────────────────────────────────────
check(conf.boardMood('secure', true).length > 0 && conf.boardMood('at_risk', false).length > 0, 'boardMood returns a line for every band');
check(conf.boardMood('shaky', true) !== conf.boardMood('shaky', false), 'boardMood reflects whether the club is on track');
check(conf.recruitmentBacking('secure', 'title') !== conf.recruitmentBacking('at_risk', 'title'), 'recruitmentBacking reflects confidence');
check(conf.recruitmentBacking('stable', 'survival') !== conf.recruitmentBacking('stable', 'title'), 'recruitmentBacking reflects the objective');
check(conf.recruitmentBacking('at_risk', 'promotion').toLowerCase().includes('reckless'), 'an at-risk board warns against reckless spending');

// ── integration: champion + promoted + objective met soars from 55 ───────────────────────────
db.prepare('UPDATE teams SET board_confidence = 55 WHERE id = ?').run(teamId);
const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
const worlds = season.worldLeagues(leagueId).map(l => l.id);
const ph = worlds.map(() => '?').join(',');
const fx = db.prepare(`SELECT id, home_team_id, away_team_id FROM fixtures WHERE league_id IN (${ph}) AND played = 0`).all(...worlds) as { id: number; home_team_id: number; away_team_id: number }[];
const set = db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?');
for (const f of fx) { if (f.home_team_id === teamId) set.run(3, 0, f.id); else if (f.away_team_id === teamId) set.run(0, 3, f.id); else set.run(0, 0, f.id); }
const roll = season.rolloverSeason(leagueId);
const after = conf.getConfidence(teamId)!;
check(after.value === 97, 'champion + promoted + objective met: 55 +22 +14 +6 = 97');
check(after.status === 'secure', 'and the board is now "secure"');
check(roll!.board.find(b => b.teamId === teamId)?.tone === 'backed', 'the rollover board verdict for a triumphant season is "backed"');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

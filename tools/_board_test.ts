// Board-interaction test. Throwaway FOOTY_DB. Asserts the once-a-season board meeting: a secure board
// grants the requested backing (added to budget/wages), an at-risk board denies it, the audience is
// consumed regardless of outcome, and a new season re-opens it.
//
//   npx tsx tools/_board_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-brd-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const board = await import('../web/backend/board.ts');

const u = registerUser('chairman', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Boardroom FC', game.DEFAULT_TACTICS);

// ── a secure board backs you: the funds request lands in the budget ──────────
db.prepare('UPDATE teams SET board_confidence = 80, budget = 50000000, board_request_season = NULL WHERE id = ?').run(teamId);
check(board.boardMeetingAvailable(teamId), 'the board meeting is open at the start of the season');
const m = board.getBoardMeeting(teamId);
check(m.confidence?.status === 'secure' && m.grants.funds === 20_000_000, `getBoardMeeting previews the secure-tier funds grant (got £${(m.grants.funds / 1e6)}M)`);
const r1 = board.requestBoardBacking(teamId, 'funds');
check(r1.granted && r1.amount === 20_000_000, 'a secure board grants the funds request');
const budget = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
check(budget === 70_000_000, `the grant is added to the transfer budget (50M → ${budget / 1e6}M)`);
check(!board.boardMeetingAvailable(teamId), 'the meeting is consumed — one audience per season');
check(!board.requestBoardBacking(teamId, 'wages').ok, 'a second request the same season is blocked');

// ── an at-risk board says no — and the audience is still spent ────────────────
db.prepare('UPDATE teams SET board_confidence = 20, board_request_season = NULL WHERE id = ?').run(teamId);
check(board.getBoardMeeting(teamId).grants.wages === 0, 'getBoardMeeting previews a 0 grant when the board is at risk');
const wbBefore = (db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number }).wage_budget;
const r3 = board.requestBoardBacking(teamId, 'wages');
check(r3.ok && !r3.granted && r3.amount === 0, 'an at-risk board denies the request (no grant)');
check((db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number }).wage_budget === wbBefore, 'a denied request does not change the wage budget');
check(!board.boardMeetingAvailable(teamId), 'a denied request still consumes the season meeting');

// ── a new season re-opens the audience ───────────────────────────────────────
db.prepare('UPDATE leagues SET season = season + 1 WHERE id = (SELECT league_id FROM teams WHERE id = ?)').run(teamId);
check(board.boardMeetingAvailable(teamId), 'a new season re-opens the board meeting');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

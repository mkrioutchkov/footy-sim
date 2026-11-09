// Press → news story-arc test (§P2#8). A press-conference TONE is remembered, and the NEXT match's
// aftermath turns it into a follow-up headline that vindicates or undermines the stance, then clears the
// one-shot marker. Covers the pure pressArcHeadline matrix AND the real processMatchAftermath integration
// (temp DB, no LLM key → deterministic).
//   npx tsx tools/_press_arc_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-arc-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const press = await import('../web/backend/press.ts');
const news = await import('../web/backend/news.ts');
const season = await import('../web/backend/season.ts');
const toneOf = (tid: number): string | null => (db.prepare('SELECT last_press_tone AS t FROM teams WHERE id=?').get(tid) as { t: string | null }).t;

// ── pure fn: tone × outcome → headline ──
check(/vindicated/i.test(press.pressArcHeadline('defiant', 'W') ?? ''), 'defiant + W → defiance vindicated');
check(/backfires/i.test(press.pressArcHeadline('defiant', 'L') ?? ''), 'defiant + L → defiance backfires');
check(/faith repaid/i.test(press.pressArcHeadline('back_players', 'W') ?? ''), 'back_players + W → faith repaid');
check(/falls flat/i.test(press.pressArcHeadline('demand_more', 'L') ?? ''), 'demand_more + L → call for more falls flat');
check(press.pressArcHeadline('unknown_tone', 'W') === null, 'an unknown tone → no arc headline (null)');
check((['back_players', 'demand_more', 'accountable', 'defiant', 'calm'] as const).every(t =>
  (['W', 'D', 'L'] as const).every(o => typeof press.pressArcHeadline(t, o) === 'string')), 'every known tone has a headline for W/D/L');

// ── integration: presser tone → next result → follow-up headline + one-shot clear ──
const u = registerUser('arcmgr', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Arc FC', game.DEFAULT_TACTICS);
db.prepare('UPDATE teams SET last_press_tone = ? WHERE id = ?').run('defiant', teamId);   // as applyPressResponse('defiant') would

const fx = db.prepare('SELECT id, home_team_id FROM fixtures WHERE (home_team_id=? OR away_team_id=?) ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number; home_team_id: number };
const home = fx.home_team_id === teamId;
db.prepare('UPDATE fixtures SET played=1, home_score=?, away_score=?, aftermath_done=0 WHERE id=?').run(home ? 2 : 0, home ? 0 : 2, fx.id);   // a 2-0 WIN for the team
await news.processMatchAftermath(teamId, fx.id, [], []);
const arcRow = db.prepare("SELECT headline FROM player_news WHERE team_id=? AND type='press' ORDER BY id DESC LIMIT 1").get(teamId) as { headline: string } | undefined;
check(!!arcRow && /vindicated/i.test(arcRow.headline), `a win after a defiant presser writes the vindication headline ("${arcRow?.headline ?? 'none'}")`);
check(((db.prepare('SELECT last_press_tone AS t FROM teams WHERE id=?').get(teamId) as { t: string | null }).t) === null, 'the press tone is cleared after the arc fires (one-shot)');

// ── re-running the same fixture's aftermath does NOT double-write (idempotent guard) ──
const cntAfterFirst = (db.prepare("SELECT COUNT(*) AS n FROM player_news WHERE team_id=? AND type='press'").get(teamId) as { n: number }).n;
await news.processMatchAftermath(teamId, fx.id, [], []);
check((db.prepare("SELECT COUNT(*) AS n FROM player_news WHERE team_id=? AND type='press'").get(teamId) as { n: number }).n === cntAfterFirst, 're-firing the aftermath adds no second arc (aftermath_done guard + cleared tone)');

// ── a result with NO presser since the last match → no arc ──
const fx2 = db.prepare('SELECT id, home_team_id FROM fixtures WHERE (home_team_id=? OR away_team_id=?) AND played=0 ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number; home_team_id: number };
const before = (db.prepare("SELECT COUNT(*) AS n FROM player_news WHERE team_id=? AND type='press'").get(teamId) as { n: number }).n;
const home2 = fx2.home_team_id === teamId;
db.prepare('UPDATE fixtures SET played=1, home_score=?, away_score=?, aftermath_done=0 WHERE id=?').run(home2 ? 0 : 1, home2 ? 1 : 0, fx2.id);   // a loss, no tone stored
await news.processMatchAftermath(teamId, fx2.id, [], []);
check((db.prepare("SELECT COUNT(*) AS n FROM player_news WHERE team_id=? AND type='press'").get(teamId) as { n: number }).n === before, 'no presser since the last match → no arc headline');

// ── the REAL write site: applyPressResponse persists the chosen tone (not a raw UPDATE) ──
await press.applyPressResponse(teamId, 'I demand more from this group — one or two must step up.', 'demand_more');
check(toneOf(teamId) === 'demand_more', 'applyPressResponse persists the chosen tone for the next match');
// a DRAW after demand_more → the "half-answer" draw headline (the D outcomes were untested end-to-end)
const fx3 = db.prepare('SELECT id, home_team_id FROM fixtures WHERE (home_team_id=? OR away_team_id=?) AND played=0 ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number; home_team_id: number };
db.prepare('UPDATE fixtures SET played=1, home_score=1, away_score=1, aftermath_done=0 WHERE id=?').run(fx3.id);
await news.processMatchAftermath(teamId, fx3.id, [], []);
const drawRow = db.prepare("SELECT headline FROM player_news WHERE team_id=? AND type='press' ORDER BY id DESC LIMIT 1").get(teamId) as { headline: string } | undefined;
check(!!drawRow && /half-answer/i.test(drawRow.headline), `a draw after demand_more writes the draw headline ("${drawRow?.headline ?? 'none'}")`);
// a tone-LESS press response (free-text path) stores NULL → no arc
await press.applyPressResponse(teamId, 'No comment today.', undefined);
check(toneOf(teamId) === null, 'a tone-less press response stores NULL (free-text → no arc)');

// ── rollover clears a pending tone (no cross-season stale arc — the review's lead finding) ──
db.prepare('UPDATE teams SET last_press_tone = ? WHERE id = ?').run('defiant', teamId);
const lid = (db.prepare('SELECT league_id AS l FROM teams WHERE id = ?').get(teamId) as { l: number }).l;
for (const wl of season.worldLeagues(lid)) db.prepare('UPDATE fixtures SET played=1, home_score=1, away_score=1 WHERE league_id = ?').run(wl.id);   // complete the world
check(season.rolloverSeason(lid) !== null, 'rolloverSeason proceeds once the world is complete');
check(toneOf(teamId) === null, 'rollover clears a pending press-arc tone (no cross-season stale arc)');

db.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort; OS temp dir */ }
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

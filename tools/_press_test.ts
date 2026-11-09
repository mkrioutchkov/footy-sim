// Press-conference test (LLM stream, part B). Throwaway FOOTY_DB; no LLM key, so the
// deterministic keyword judge runs. Asserts that a statement's tone moves each player's morale
// THROUGH their dials — praise lifts the praise-hungry + big egos; a public rocket lifts the
// criticism-responsive but dents the sensitive + hot-heads — that deltas clamp, and that
// applyPressConference persists the morale changes.
//
//   npx tsx tools/_press_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-prs-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const press = await import('../web/backend/press.ts');

const PRAISE = 'I am so proud of these players — the best squad, brilliant lads, I believe in them.';
const CRITICISM = 'Not good enough. I am disappointed — that was unacceptable. They must do better.';

// dials: A = praise-hungry big ego; B = thrives on a rocket; C = sensitive hot-head
const A = { criticismResponse: 0, praiseResponse: 100, ego: 80, temperament: 50 };
const B = { criticismResponse: 100, praiseResponse: 0, ego: 20, temperament: 50 };
const C = { criticismResponse: 0, praiseResponse: 50, ego: 50, temperament: 100 };
const squad = [{ slot: 0, name: 'Ace', traits: A }, { slot: 1, name: 'Rocky', traits: B }, { slot: 2, name: 'Hothead', traits: C }];
const byName = (rs: { name: string; delta: number }[], n: string) => rs.find(r => r.name === n)!.delta;

// ── praise lifts the praise-hungry most ──────────────────────────────────────
const pr = await press.judgePressConference(PRAISE, squad);
check(byName(pr, 'Ace') > 0 && byName(pr, 'Rocky') > 0, 'a backing statement lifts the squad');
check(byName(pr, 'Ace') > byName(pr, 'Rocky'), `the praise-hungry ego lifts more than the indifferent one (${byName(pr, 'Ace')} vs ${byName(pr, 'Rocky')})`);
check(pr.every(r => r.delta <= 15 && r.delta >= -15), 'deltas are clamped to ±15');

// ── criticism: lifts the responsive, dents the sensitive (hot-head most) ──────
const cr = await press.judgePressConference(CRITICISM, squad);
check(byName(cr, 'Rocky') > 0, 'a public rocket lifts the criticism-responsive player');
check(byName(cr, 'Ace') < 0, 'the same rocket dents the sensitive (low criticism-response) player');
check(byName(cr, 'Hothead') < byName(cr, 'Ace'), `the hot-head reacts worst of all (${byName(cr, 'Hothead')} vs ${byName(cr, 'Ace')})`);

// ── applyPressConference persists morale through the dials ────────────────────
const u = registerUser('mouth', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Presser FC', game.DEFAULT_TACTICS);
// give slots 0/1 the praise-hungry / criticism-responsive personalities; start at morale 50
db.prepare('UPDATE players SET personality = ?, morale = 50 WHERE team_id = ? AND slot = 0').run(JSON.stringify({ traits: A, nationality: '', backstory: 'x', tagline: '' }), teamId);
db.prepare('UPDATE players SET personality = ?, morale = 50 WHERE team_id = ? AND slot = 1').run(JSON.stringify({ traits: B, nationality: '', backstory: 'x', tagline: '' }), teamId);
const res = await press.applyPressConference(teamId, PRAISE);
check(res.reactions.length === game.getTeamWithPlayers(teamId)!.players.length, 'every squad member reacts');
check(res.lifted > 0, `the backing statement lifted ${res.lifted} players`);
const after = game.getTeamWithPlayers(teamId)!.players;
check(after.find(p => p.slot === 0)!.morale > 50, "the praise-hungry player's morale rose and persisted");
check(after.every(p => p.morale >= 0 && p.morale <= 100), 'persisted morale stays within 0..100');

// empty statement -> no-op-safe (handled at the endpoint; judge returns neutral fallback)
check((await press.judgePressConference('the weather is fine today', squad)).every(r => r.delta === 0), 'a toneless statement leaves morale unchanged');

// ── cadence: one presser per match (no morale farming) ───────────────────────
check(press.pressAvailable(teamId), 'the media room is open before any match');
press.recordPress(teamId);
check(!press.pressAvailable(teamId), 'after one presser the room is shut until the next match');
const fx = db.prepare('SELECT id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number };
db.prepare('UPDATE fixtures SET played = 1, home_score = 1, away_score = 0 WHERE id = ?').run(fx.id);
check(press.pressAvailable(teamId), 'playing the next match re-opens the media room');

// ── interactive press: tone → board confidence + the question generator ──────
check(press.boardDeltaForTone('accountable') === 3 && press.boardDeltaForTone('defiant') === -4 && press.boardDeltaForTone('calm') === 1, 'tone → board delta (accountable +3, defiant -4, calm +1)');
check(press.boardDeltaForTone('nonsense') === 0, 'an unknown tone is board-neutral');
const q = await press.generatePressQuestion({ form: 'LLL', lastResult: 'L', position: 18, teams: 20, objective: 'avoid relegation', nextOpponent: 'Rivals FC' });
check(typeof q.question === 'string' && q.question.length > 0 && q.options.length >= 4, `generatePressQuestion (no LLM) → a question + ${q.options.length} tone options`);
check(q.options.every(o => ['back_players', 'demand_more', 'accountable', 'defiant', 'calm'].includes(o.tone) && o.text.length > 0), 'every option carries a valid tone + a response line');
// applyPressResponse: morale (dials) AND board confidence (the chosen tone)
db.prepare('UPDATE teams SET board_confidence = 50, last_press_round = NULL WHERE id = ?').run(teamId);
const pr2 = await press.applyPressResponse(teamId, CRITICISM, 'defiant');
const conf = (db.prepare('SELECT board_confidence FROM teams WHERE id = ?').get(teamId) as { board_confidence: number }).board_confidence;
check(pr2.boardDelta === -4 && conf === 46, `a defiant response drops board confidence (50 → ${conf})`);
check(Array.isArray(pr2.reactions) && pr2.reactions.length > 0, 'the same response still moves player morale (reactions returned)');
// the press conference leaves a 🎤 headline in Club news (a club-level news row, tone-keyed)
const pressNews = db.prepare("SELECT headline FROM player_news WHERE team_id = ? AND type = 'press'").get(teamId) as { headline: string } | undefined;
check(!!pressNews && /defiant/i.test(pressNews.headline), `the press conference leaves a news headline ("${pressNews?.headline ?? 'none'}")`);

// ── post-match depth: the question reacts to the actual scoreline + opponent (no-LLM fallback) ──
const pmWin = await press.generatePressQuestion({ form: 'WWW', lastResult: 'W', lastMatch: { result: 'W', gf: 3, ga: 0, opponent: 'Rivals FC', home: true }, position: 3, teams: 20 });
check(/3-0/.test(pmWin.question) && /Rivals FC/.test(pmWin.question), `post-match WIN question names the scoreline + opponent ("${pmWin.question}")`);
const pmLoss = await press.generatePressQuestion({ form: 'LL', lastResult: 'L', lastMatch: { result: 'L', gf: 0, ga: 2, opponent: 'City', home: false }, position: 15, teams: 20 });
check(/0-2/.test(pmLoss.question) && /City/.test(pmLoss.question) && /wrong|run/i.test(pmLoss.question), `post-match LOSS question names the result + probes ("${pmLoss.question}")`);
const pmDraw = await press.generatePressQuestion({ form: 'D', lastResult: 'D', lastMatch: { result: 'D', gf: 1, ga: 1, opponent: 'United', home: true }, position: 8, teams: 20 });
check(/1-1/.test(pmDraw.question) && /United/.test(pmDraw.question), `post-match DRAW question names the scoreline + opponent ("${pmDraw.question}")`);
check((await press.generatePressQuestion({ form: '', position: 1, teams: 20 })).options.length >= 4, 'no lastMatch → still a valid fallback question + options');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

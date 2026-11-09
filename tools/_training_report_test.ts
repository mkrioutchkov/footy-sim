// Audit §2.7 — training report + per-player/position focus (no engine, no LLM). Covers the new
// 'position' (role-matched) focus weighting + its OVR-neutrality + backward compatibility, the
// explainTraining factor breakdown, the per-player focus override, and that developmentTick records
// a report for HUMAN clubs only (latest-only) with the right round/season.
//
//   npx tsx tools/_training_report_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-trnrep-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(cond: boolean, msg: string): void { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const training = await import('../web/backend/training.ts');

const SKILLS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
const flat = (v: number) => Object.fromEntries(SKILLS.map(k => [k, v])) as Record<string, number>;
const ovr = (a: Record<string, number>) => Math.round(SKILLS.reduce((s, k) => s + a[k], 0) / SKILLS.length);
const pro = { professionalism: 90, consistency: 85 };

// ── 'position' focus lifts the role's key attrs without clawing back the rest, and the two focused
//    options grow the same TOTAL (neither strictly dominates) — both more than balanced ───────────
const bal = training.developAttrs(flat(60), 19, 95, pro, 'balanced', 65, 1, 1, 'CF');
const pos = training.developAttrs(flat(60), 19, 95, pro, 'position', 65, 1, 1, 'CF');
const shoFocus = training.developAttrs(flat(60), 19, 95, pro, 'shooting', 65, 1, 1, 'CF');
const grow = (a: Record<string, number>) => SKILLS.reduce((s, k) => s + (a[k] - 60), 0);
check(pos.shooting > bal.shooting && pos.speed > bal.speed && pos.creativity > bal.creativity,
  `a CF on position-training sharpens his key attrs (SHO ${pos.shooting} vs ${bal.shooting})`);
check(pos.passing === bal.passing && pos.tackling === bal.tackling && pos.positioning === bal.positioning,
  `non-key attrs keep their full balanced growth — not clawed back (PAS ${pos.passing} == ${bal.passing})`);
check(grow(pos) > grow(bal) && Math.abs(grow(pos) - grow(shoFocus)) < 0.6,
  `position grows as much OVR as a single focus, more than balanced (pos ${grow(pos).toFixed(1)} ≈ focus ${grow(shoFocus).toFixed(1)} > balanced ${grow(bal).toFixed(1)})`);

// a CB keys on defending, not shooting (role-matched, not a fixed attr set)
const cbPos = training.developAttrs(flat(60), 19, 95, pro, 'position', 65, 1, 1, 'CB');
check(cbPos.tackling > cbPos.shooting && cbPos.positioning > cbPos.shooting, 'a CB on position-training trains defending hardest, not shooting');

// unknown role under 'position' → identity (no weighting), so it can never crash or distort
const unk = training.developAttrs(flat(60), 19, 95, pro, 'position', 65, 1, 1, 'ZZ');
check(JSON.stringify(unk) === JSON.stringify(training.developAttrs(flat(60), 19, 95, pro, 'balanced', 65, 1, 1)),
  'position-training with an unknown role falls back to balanced (identity)');

// ── backward compatibility: the role param is IGNORED for non-position foci ──────────────────────
check(JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'shooting', 65, 1, 1, 'CF'))
   === JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'shooting', 65, 1, 1)),
  'passing a role does not change a single-attribute focus (byte-identical)');
check(JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'balanced', 65, 1, 1, 'CF'))
   === JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'balanced')),
  'a balanced focus is byte-identical with or without a role (pre-§2.7 drift unchanged)');

// ── explainTraining: the "why" breakdown ────────────────────────────────────────────────────────
const before = flat(60), after = training.developAttrs(before, 19, 95, pro, 'position', 80, 1.2, 1.06, 'CF');
const line = training.explainTraining(before, after, { slot: 9, name: 'Wonderkid', role: 'CF' }, 19, pro, 'position', false, 80, 1.2, 1.06);
check(line.ovrDelta > 0 && line.ovrAfter === ovr(after), 'a growing player has a positive OVR delta');
check(line.attrs.length > 0 && line.attrs.every(a => a.delta !== 0), 'the report lists only the attributes that actually moved');
check(Math.abs(line.attrs[0].delta) >= Math.abs(line.attrs[line.attrs.length - 1].delta), 'attribute deltas are ordered largest-first');
check(line.factors.some(f => f.includes('Young')), 'factors explain the age phase');
check(line.factors.some(f => f.includes('Model professional')), 'factors flag a diligent learner');
check(line.factors.some(f => f.includes('Coaching staff +20%')), 'factors credit the coaching boost');
check(line.factors.some(f => f.toLowerCase().includes('position-specific')), 'factors note position-specific drills');
// a declining veteran: growth-only factors (coach / focus) are suppressed
const vBefore = flat(75), vAfter = training.developAttrs(vBefore, 34, 80, pro, 'shooting', 65, 1.2, 1);
const vLine = training.explainTraining(vBefore, vAfter, { slot: 4, name: 'Old Stager', role: 'CB' }, 34, pro, 'shooting', false, 65, 1.2, 1);
check(vLine.ovrDelta < 0, 'a veteran shows a negative OVR delta');
check(!vLine.factors.some(f => f.includes('Coaching') || f.includes('Focused')), 'growth-only factors are hidden while a player declines');
check(vLine.factors.some(f => f.toLowerCase().includes('decline')), 'a declining veteran is flagged as such');

// ── developmentTick records a report for HUMAN clubs only ────────────────────────────────────────
const u = registerUser('gaffer', 'secret');
const { leagueId, teamId } = game.newSeasonForUser(u.id, u.username, 'Report FC', game.DEFAULT_TACTICS);
const aiTeamId = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL LIMIT 1').get(leagueId) as { id: number }).id;
// mark a fixture played so the report's round is meaningful
db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ? AND round = (SELECT MIN(round) FROM fixtures WHERE league_id = ?)').run(leagueId, leagueId);
const playedRound = (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ? AND played = 1').get(leagueId) as { r: number }).r;

check(training.getTrainingReport(teamId) === null, 'no training report before the first development tick');
training.developmentTick(leagueId);
const rep = training.getTrainingReport(teamId);
check(rep !== null, 'a report is recorded after developmentTick');
check(training.getTrainingReport(aiTeamId) === null, 'AI clubs get NO training report (human-only)');
check(rep!.round === playedRound && rep!.season >= 1, `the report carries the matchday round (${rep!.round}) + season`);
const squadSize = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(teamId) as { n: number }).n;
check(rep!.lines.length === squadSize, `the report has a line per squad player (${rep!.lines.length}/${squadSize})`);
check(rep!.teamFocus === 'balanced' && rep!.coachBoost === 0, 'report meta snapshots the club focus + (no) coach boost');

// latest-only: a second tick replaces the row, never accumulates
training.developmentTick(leagueId);
check((db.prepare('SELECT COUNT(*) AS n FROM training_reports WHERE team_id = ?').get(teamId) as { n: number }).n === 1, 'only the latest report is kept (older pruned)');

// ── per-player focus overrides the club focus ────────────────────────────────────────────────────
training.setTrainingFocus(teamId, 'balanced');
// a young, high-potential CF with room to grow, so a focus is visible
db.prepare("UPDATE players SET age = 19, potential = 92, role = 'CF', attrs = ?, personality = ? WHERE team_id = ? AND slot = 9")
  .run(JSON.stringify(flat(64)), JSON.stringify({ traits: pro }), teamId);
const setRes = training.setPlayerTrainingFocus(teamId, 9, 'shooting');
check(setRes.ok && setRes.focus === 'shooting', 'setPlayerTrainingFocus stores an individual focus');
check(game.getTeamWithPlayers(teamId)!.players.find(p => p.slot === 9)!.trainFocus === 'shooting', 'the per-player focus is exposed on the team');
training.developmentTick(leagueId);
const repLine = training.getTrainingReport(teamId)!.lines.find(l => l.slot === 9)!;
check(repLine.focus === 'shooting' && repLine.individual === true, 'the report line shows the player following his own focus');
const sho = repLine.attrs.find(a => a.key === 'shooting');
check(!!sho && sho.delta >= Math.max(...repLine.attrs.filter(a => a.key !== 'shooting').map(a => a.delta)), 'the individually-focused attribute grew the most');

// clearing the override + the validation sentinels
check(training.setPlayerTrainingFocus(teamId, 9, '').focus === null, 'an empty focus clears the override');
check(game.getTeamWithPlayers(teamId)!.players.find(p => p.slot === 9)!.trainFocus === null, 'the cleared override follows the club again');
check(training.setPlayerTrainingFocus(teamId, 9, 'club').focus === null, "'club' is a clear sentinel");
check(training.setPlayerTrainingFocus(teamId, 9, 'nonsense').focus === null, 'an invalid focus clears rather than corrupting');
check(!training.setPlayerTrainingFocus(teamId, 999, 'shooting').ok, 'a bad slot is a no-op (not in your squad)');
check(training.setPlayerTrainingFocus(teamId, 9, 'position').focus === 'position', "'position' is a valid per-player focus");

// ── 'position' is a valid club focus ─────────────────────────────────────────────────────────────
check(training.setTrainingFocus(teamId, 'position').focus === 'position', "'position' is a valid club focus");
check(training.VALID_FOCUS.has('position'), 'VALID_FOCUS includes position');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

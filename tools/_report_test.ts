// tools/_report_test.ts — engine-free regression for web/backend/report.ts (match reports /
// ratings off a frame recording), pinning the 2026-08 substitutionLog fix:
//
//   GAME_LAYER_NOTES.md (2026-08-05 contract audit): "`substitutionLog` has no TypeScript
//   consumer — engine commit 573675e added per-sub `outTally` precisely so substituted players
//   keep their stats, but report.ts still builds ratings from the final frame's 22 slots.
//   Measured seed 151 @90': 26 men played, 22 rating rows, 5 of 7 goals credited to the wrong
//   player." A substitution is an IN-PLACE slot swap (engine_squad.cpp substituteSlot): the slot
//   keeps its id/role, is renamed to the arrival in the same tick, and its tally is zeroed — so
//   the slot id identifies a SHIRT, not a person. report.ts now splits slots into stints on the
//   frame-borne substitutionLog: goal credit follows whoever held the slot at the goal's clock,
//   and each record's outTally becomes the departed man's own rating row.
//
// Fixtures are synthetic frames shaped EXACTLY like the wire (field-for-field per engine.cpp
// getJSON: players[] engine.cpp:1282, substitutionLog engine.cpp:1317-1330, added_time overload
// engine.cpp:590), persisted through the backend's own machinery (match.ts persistRecording →
// match_recordings row + gzipped NDJSON) and read back through the real buildMatchReport — no
// forked copy of report logic.
//
// It also pins the two follow-ups that fix left open:
//   * the --summary path had the SAME bug class — match.ts mapped the engine's final 22 slots and
//     never read the substitutionLog, so every man who came off vanished from the aftermath
//     (season_goals / season_apps / ratings / morale). withSubstitutionStints folds him back in.
//   * match_reports rows are written once and read forever, so a report generated BEFORE the fix
//     kept its 22 wrong rows for the life of the save. Rows now carry REPORT_FORMAT_VERSION inside
//     `facts` and an older stamp regenerates lazily on read (no boot-time cache purge).
//
// Run: cd <repo> && npx tsx tools/_report_test.ts   (exits non-zero on any failure).

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// db.ts resolves FOOTY_DB at IMPORT time; match.ts resolves its recordings dir from FOOTY_DB's
// dirname and its spec scratch from process.cwd() at IMPORT time — pin all three BEFORE any
// backend module loads (all backend imports are dynamic).
const WORK = path.join(os.tmpdir(), `report_test_${process.pid}_${Date.now()}`);
const CWD_DIR = path.join(WORK, 'cwd');
mkdirSync(CWD_DIR, { recursive: true });
process.chdir(CWD_DIR);
const DB_PATH = path.join(WORK, 'report_test.sqlite');
process.env.FOOTY_DB = DB_PATH;
// Force the deterministic template narrative: provider 'http' with no API key makes
// llmReady() report not-ready, so writeNarrative never attempts a network/CLI call.
process.env.TACTICS_LLM_PROVIDER = 'http';
delete process.env.TACTICS_LLM_API_KEY;
delete process.env.TACTICS_LLM_LIVE_PROVIDER;

const { db } = await import('../web/backend/db.ts');
const match = await import('../web/backend/match.ts');
const report = await import('../web/backend/report.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

// ── Wire-exact frame builders ────────────────────────────────────────────────
// Player object: the exact key set engine.cpp:1282 pushes into players[] (values synthetic).
// Fixed-22 invariant: home = ids 0-10, away = 11-21; 4-3-3 role order per types.ts FORMATIONS.
const ROLES = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'];
type Stat = { goals: number; assists: number; shots: number; tackles: number; yellow: number; passes: number; passesCompleted: number; sentOff: boolean };
const zero = (): Stat => ({ goals: 0, assists: 0, shots: 0, tackles: 0, yellow: 0, passes: 0, passesCompleted: 0, sentOff: false });
const names: string[] = [];
const stats: Stat[] = [];
for (let i = 0; i < 22; i++) { names.push(i < 11 ? `H${i} Home${i}` : `A${i} Away${i}`); stats.push(zero()); }

// One substitution record, exactly as engine.cpp:1317-1330 serializes SubstitutionRecord
// (clockMs rounded, team as "home"/"away", the outTally flattened to out* ints).
interface SubRec { clockMs: number; slotId: number; team: string; outName: string; inName: string; outGoals: number; outAssists: number; outShots: number; outTackles: number; outPasses: number; outPassesCompleted: number }
const subLog: SubRec[] = [];

let homeScore = 0, awayScore = 0;
function frame(clockMs: number, opts: { matchState?: string; events?: unknown[] } = {}): string {
  return JSON.stringify({
    clockMs, matchState: opts.matchState ?? 'running', half: clockMs < 2_700_000 ? 1 : 2,
    addedTime: false, addedTimeAnnouncedMin: 0, version: 'test', speed: 1,
    homeScore, awayScore,
    ball: { x: 525, y: 340, vx: 0, vy: 0, z: 0, curl: 0, cutback: false, controllerId: null, intendedReceiverId: null, lastTouchTeam: 'home', lastToucherId: null },
    players: names.map((name, i) => ({
      id: i, name, team: i < 11 ? 'home' : 'away', role: ROLES[i % 11], x: 100 + i, y: 340, vx: 0, vy: 0,
      targetX: 100 + i, targetY: 340, stamina: 80, facing: 0, dribbleType: 0, tackleAnim: 0, headingAnim: 0,
      diveAnim: 0, wall: false, slide: false, goals: stats[i].goals, assists: stats[i].assists,
      shots: stats[i].shots, tackles: stats[i].tackles, yellow: stats[i].yellow, passes: stats[i].passes,
      passesCompleted: stats[i].passesCompleted, injured: false, sentOff: stats[i].sentOff,
    })),
    events: opts.events ?? [],
    substitutionLog: subLog.map(s => ({ ...s })),   // cumulative log-so-far, like getJSON
    possessionPct: 55, homeShots: 9, awayShots: 4, shotsOnTarget: 6, saves: 3, cornersAwarded: 5,
  });
}
// A substitution, engine_squad.cpp substituteSlot semantics: append the departing man's tally
// to the log, rename the slot to the arrival, zero the slot's counters AND cards.
function substitute(clockMs: number, slotId: number, inName: string, outTally: Partial<Stat>): void {
  const t = { ...zero(), ...outTally };
  subLog.push({
    clockMs, slotId, team: slotId < 11 ? 'home' : 'away', outName: names[slotId], inName,
    outGoals: t.goals, outAssists: t.assists, outShots: t.shots, outTackles: t.tackles,
    outPasses: t.passes, outPassesCompleted: t.passesCompleted,
  });
  names[slotId] = inName;
  stats[slotId] = zero();
}

// ── The match: 3 subs, 4 goals (one own), a card, an added_time overload ────
const lines: string[] = [];
lines.push(frame(0));

// 4': slot 9 (H9 Home9, CF) scores.
stats[9].goals = 1; stats[9].shots = 1; homeScore = 1;
lines.push(frame(240_000));

// 10': the same starter is booked.
stats[9].yellow = 1;
lines.push(frame(600_000));

// 25': slot 9 substituted. His outTally (engine snapshot at the swap) carries stats the kept
// frames never showed (they accrued between frames) — the outTally is authoritative.
substitute(1_450_000, 9, 'H9 Gomez', { goals: 1, assists: 2, shots: 5, tackles: 3, passes: 20, passesCompleted: 18 });
lines.push(frame(1_500_000));

// 50': the REPLACEMENT in slot 9 scores — same slot id, different man.
stats[9].goals = 1; stats[9].shots = 2; homeScore = 2;
lines.push(frame(3_000_000));

// 55': own goal — away's score rises with NO away-side per-player increment.
awayScore = 1;
lines.push(frame(3_300_000));

// 65': goal AND substitution inside one frame gap (a thinned recording): slot 7's starter
// scored, then went off, between kept frames — the slot counter was zeroed before any frame
// showed the goal, so the credit must come from the outTally delta (outGoals 1 vs 0 seen).
substitute(3_850_000, 7, 'H7 Fresh', { goals: 1, shots: 3, tackles: 6, passes: 30, passesCompleted: 27 });
homeScore = 3;
lines.push(frame(3_900_000));

// 70': an away substitution, assists/shots/tackles in the outTally.
substitute(4_150_000, 15, 'A15 Fresh', { assists: 1, shots: 2, tackles: 4, passes: 25, passesCompleted: 20 });
lines.push(frame(4_200_000));

// 75': an added_time announce (engine.cpp:590): playerId is the announced MINUTES (4) and
// targetId the HALF (2) — an id-field overload that must not crash or reach the timeline —
// plus an untouched-ball woodwork (playerId null) exercising the transient-event path.
lines.push(frame(4_500_000, { events: [
  { type: 'added_time', x: 525, y: 20, age: 0, playerId: 4, targetId: 2, ownGoal: false },
  { type: 'woodwork', x: 1000, y: 340, age: 30, playerId: null, targetId: null, ownGoal: false },
] }));

// Full time.
lines.push(frame(5_400_000, { matchState: 'finished' }));

try {
  // ── Through the real analysis ─────────────────────────────────────────────
  const facts = report.analyzeRecording(lines);

  // Stint splitting: a row per MAN — 22 slots + 3 substitutions = 25 rows, no slot doubled up.
  assert(facts.ratings.length === 25, `a 3-sub match rates 25 men, one row each (got ${facts.ratings.length})`);
  const rowsByName = new Map(facts.ratings.map(r => [r.name, r]));
  assert(rowsByName.size === 25, 'every man appears exactly once (names unique across stints)');
  assert(facts.homeScore === 3 && facts.awayScore === 1, `facts carry the final score 3-1 (got ${facts.homeScore}-${facts.awayScore})`);

  // Goal attribution follows WHO HELD THE SLOT at the goal's clock, not the slot id.
  const starter = rowsByName.get('H9 Home9')!;
  const gomez = rowsByName.get('H9 Gomez')!;
  assert(starter !== undefined && starter.goals === 1, `the 4' goal stays with the departed starter (H9 Home9: ${starter?.goals} goals)`);
  assert(gomez !== undefined && gomez.goals === 1, `the 50' goal goes to the replacement (H9 Gomez: ${gomez?.goals} goals)`);
  assert(starter.id === 9 && gomez.id === 9, 'both stints keep the engine slot id (9) — same shirt, two men');

  // outTally folds into the departed man's own row (assists/shots/tackles the final frame lost).
  assert(starter.assists === 2 && starter.shots === 5 && starter.tackles === 3,
    `the outTally is the departed man's row: a2 s5 t3 (got a${starter.assists} s${starter.shots} t${starter.tackles})`);
  const wing = rowsByName.get('A15 Away15')!;
  assert(wing !== undefined && wing.assists === 1 && wing.shots === 2 && wing.tackles === 4,
    'the away departed man keeps his outTally line too');

  // The thinned-gap goal (goal + sub between kept frames): credited to the DEPARTED slot-7 man
  // via the outTally delta, and to nobody else.
  const mid = rowsByName.get('H7 Home7')!;
  const fresh = rowsByName.get('H7 Fresh')!;
  assert(mid.goals === 1, `the 65' gap goal credits the departed H7 starter (got ${mid?.goals})`);
  assert(fresh.goals === 0, 'the man who replaced him gets nothing for it');

  // Own-goal exclusion still holds: 4 timeline goals, only 3 credited to players.
  const goalEvents = facts.timeline.filter(e => e.type === 'goal');
  assert(goalEvents.length === 4, `timeline carries all 4 goals (got ${goalEvents.length})`);
  assert(goalEvents.some(e => e.name === 'Own goal' && e.team === 'away'), 'the unmatched away goal is labeled "Own goal"');
  const creditSum = facts.ratings.reduce((a, r) => a + r.goals, 0);
  assert(creditSum === 3, `own goals earn no rating credit: 3 of 4 goals credited (got ${creditSum})`);

  // Timeline scorer names are the slot's holder AT THE GOAL FRAME.
  const scorerNames = goalEvents.map(e => e.name);
  assert(scorerNames.join('|') === 'H9 Home9|H9 Gomez|Own goal|H7 Home7',
    `timeline scorers in order (got ${scorerNames.join('|')})`);

  // The card stays with the man who earned it; the sub does not inherit or re-trigger it.
  const yellows = facts.timeline.filter(e => e.type === 'yellow');
  assert(yellows.length === 1 && yellows[0].name === 'H9 Home9', 'exactly one booking, the departed starter\'s');

  // added_time never reaches the timeline (its playerId=4 is MINUTES, not a player), and the
  // woodwork transient still does.
  assert(!facts.timeline.some(e => (e as { type: string }).type === 'added_time'), 'added_time is not a timeline event');
  assert(facts.timeline.some(e => e.type === 'woodwork' && e.name === 'Woodwork'), 'the null-player woodwork still lands as "Woodwork"');

  // Ratings stay on the 1-10 scale for every stint row.
  assert(facts.ratings.every(r => r.rating >= 1 && r.rating <= 10), 'every rating is clamped to 1.0-10.0');

  // ── Through the real report machinery (recording on disk → buildMatchReport) ──
  const REF = 424242;
  const persisted = await match.persistRecording('fixture', REF, lines);
  assert(persisted.homeScore === 3 && persisted.awayScore === 1 && persisted.frames === lines.length,
    'persistRecording derives the 3-1 score and keeps every line');
  const rep = await report.buildMatchReport('fixture', REF, 'Home FC', 'Away FC');
  assert(rep !== null && rep.ratings.length === 25, `buildMatchReport rates all 25 men (got ${rep?.ratings.length})`);
  assert(rep!.headline === 'Home FC 3–1 Away FC', `the headline is the deterministic scoreline (got "${rep!.headline}")`);
  assert(rep!.facts.ratings.length === 25 && rep!.body.length > 0, 'facts + narrative ride on the report');
  const again = await report.buildMatchReport('fixture', REF, 'Home FC', 'Away FC');
  assert(again !== null && JSON.stringify(again.ratings) === JSON.stringify(rep!.ratings),
    'the cached report round-trips the 25 stint rows intact');

  // ── Degradation: a recording that PREDATES substitutionLog (engine < 573675e) ──
  const legacy = lines.map(l => { const f = JSON.parse(l); delete f.substitutionLog; return JSON.stringify(f); });
  const legacyFacts = report.analyzeRecording(legacy);
  assert(legacyFacts.ratings.length === 22, `no substitutionLog -> the old 22-row behaviour (got ${legacyFacts.ratings.length})`);
  assert(legacyFacts.homeScore === 3 && legacyFacts.awayScore === 1, 'legacy analysis still reads the score');

  // ── THE --summary PATH (match.ts withSubstitutionStints) ────────────────────
  // Same bug class, other path: runEngineSummary mapped the engine's FINAL 22 slots and dropped the
  // substitutionLog, so every man who came off vanished from the aftermath (tallyFixtureStats'
  // season_goals, processMatchAftermath's season_apps/morale, tallyDivisionRatings). Measured on a
  // real fixture (seed 19960, 7-3, 5 substitutions): 9 of 10 goals tallied, 9 season_apps for the
  // human club's 11 DB-resolvable men, 8 for the AI club's 11. This pins the fold that fixed it.
  const finalSlots = Array.from({ length: 22 }, (_, i) => ({
    id: i, name: `Final${i}`, role: ROLES[i % 11], team: (i < 11 ? 'home' : 'away') as 'home' | 'away',
    goals: i === 3 ? 2 : 0, assists: 0, shots: 1, tackles: 2, passes: 10, passesCompleted: 8, yellow: i === 4 ? 1 : 0, sentOff: false,
  }));
  // Wire-shaped records (engine.cpp:1317-1330). Slot 20's man was booked before he came off — the
  // outTally has no card field, so that booking is NOT recoverable from a --summary run.
  const wireLog = [
    { clockMs: 3_660_000, slotId: 9, team: 'home', outName: 'Departed Nine', inName: 'H9 Bench', outGoals: 2, outAssists: 1, outShots: 6, outTackles: 4, outPasses: 40, outPassesCompleted: 33 },
    { clockMs: 4_200_000, slotId: 20, team: 'away', outName: 'Departed Twenty', inName: 'A20 Bench', outGoals: 0, outAssists: 3, outShots: 2, outTackles: 9, outPasses: 51, outPassesCompleted: 44 },
    { clockMs: 4_800_000, slotId: 2, team: 'home', outName: 'Departed Two', inName: 'H2 Bench', outGoals: 1, outAssists: 0, outShots: 1, outTackles: 12, outPasses: 60, outPassesCompleted: 55 },
  ];
  const folded = match.withSubstitutionStints(finalSlots, wireLog);
  assert(folded.length === 25, `a 3-sub --summary yields 22 final slots + 3 departed men = 25 rows (got ${folded.length})`);
  assert(folded.slice(0, 22).every((p, i) => p === finalSlots[i]),
    'rows 0..21 are still the 22 FINAL slot holders, untouched and in engine-id order');
  assert(folded.find(p => p.id === 9)!.name === 'Final9',
    'find-by-slot-id still resolves to the slot\'s FINAL holder (the departed rows sit after all 22)');
  const dep9 = folded.slice(22).find(p => p.name === 'Departed Nine')!;
  assert(dep9 !== undefined && dep9.id === 9 && dep9.team === 'home' && dep9.role === ROLES[9],
    'the departed man keeps his slot id + team and inherits the slot\'s role (the role stays with the shirt)');
  assert(dep9.goals === 2 && dep9.assists === 1 && dep9.shots === 6 && dep9.tackles === 4 && dep9.passes === 40 && dep9.passesCompleted === 33,
    'the outTally becomes the departed man\'s own stat line, field for field');
  const dep20 = folded.slice(22).find(p => p.name === 'Departed Twenty')!;
  assert(dep20.team === 'away' && dep20.id === 20 && dep20.assists === 3 && dep20.tackles === 9,
    'the away departed man folds in with his own line too');
  assert(folded.slice(22).every(p => p.yellow === 0 && p.sentOff === false),
    'a departed row carries no card: the outTally has no card fields (sentOff is exact — pickSubstitutions skips a sent-off man, engine_squad.cpp:354)');
  const summaryGoals = folded.reduce((a, p) => a + p.goals, 0);
  assert(summaryGoals === 5 && finalSlots.reduce((a, p) => a + p.goals, 0) === 2,
    `every goal is attributable again: 5 with the fold vs 2 on the final slots alone (got ${summaryGoals})`);
  // Degradation + hostile input: no log ⇒ the exact 22-slot array back; junk records identify
  // nobody and must be skipped rather than minted onto slot 0 (numF(undefined) === 0).
  assert(match.withSubstitutionStints(finalSlots, []) === finalSlots && match.withSubstitutionStints(finalSlots, undefined) === finalSlots,
    'no substitutionLog (pre-573675e engine / fast-sim) -> the untouched 22-slot list');
  const junk = match.withSubstitutionStints(finalSlots, [{ outName: 'No Slot' }, { slotId: 4 }, { slotId: -1, outName: 'Bad Slot' }, null]);
  assert(junk.length === 22, `a record with no slotId / no outName is skipped, never minted onto slot 0 (got ${junk.length} rows)`);

  // ── CACHE CORRECTNESS: a pre-fix report row regenerates ON READ ─────────────
  // match_reports is written once and read forever, so before this a report generated by an older
  // (wrong) analyzeRecording kept its rows for the life of the save. Rows now carry the format
  // version inside `facts`; an older stamp regenerates lazily on the next read.
  assert(rep!.facts.version === report.REPORT_FORMAT_VERSION && report.REPORT_FORMAT_VERSION >= 2,
    `a freshly built report is stamped with the current format version (got ${rep!.facts.version})`);
  const storedVersion = () => JSON.parse((db.prepare('SELECT facts FROM match_reports WHERE kind = ? AND ref_id = ?').get('fixture', REF) as { facts: string }).facts).version;
  assert(storedVersion() === report.REPORT_FORMAT_VERSION, 'the stamp is persisted on the cache row, not just on the returned object');

  // A CURRENT row is served as-is and never regenerated — prove it by poisoning the cached prose:
  // if it came back rewritten, the cache had been re-derived from the recording.
  db.prepare('UPDATE match_reports SET body = ? WHERE kind = ? AND ref_id = ?').run('CACHED-PROSE-MARKER', 'fixture', REF);
  const cacheHit = await report.buildMatchReport('fixture', REF, 'Home FC', 'Away FC');
  assert(cacheHit!.body === 'CACHED-PROSE-MARKER', 'a row at the current version is served from cache untouched (the expensive narrative is not re-paid)');

  // Now age the row exactly as a pre-fix save looks: format 1, the old 22 slot-keyed rating rows.
  const oldFacts = { ...JSON.parse(JSON.stringify(rep!.facts)), version: 1, ratings: rep!.facts.ratings.slice(0, 22) };
  db.prepare('UPDATE match_reports SET headline = ?, body = ?, ratings = ?, facts = ? WHERE kind = ? AND ref_id = ?')
    .run('STALE HEADLINE', 'STALE PROSE', JSON.stringify(oldFacts.ratings), JSON.stringify(oldFacts), 'fixture', REF);
  const staleRead = db.prepare('SELECT ratings FROM match_reports WHERE kind = ? AND ref_id = ?').get('fixture', REF) as { ratings: string };
  assert(JSON.parse(staleRead.ratings).length === 22, 'the aged row really does hold the old 22-row shape before the read');
  const regenerated = await report.buildMatchReport('fixture', REF, 'Home FC', 'Away FC');
  assert(regenerated !== null && regenerated.ratings.length === 25,
    `reading an older-format row regenerates it: 22 stale rows -> 25 stint rows (got ${regenerated?.ratings.length})`);
  assert(regenerated!.headline === 'Home FC 3–1 Away FC' && regenerated!.body !== 'STALE PROSE',
    'the narrative is regenerated too — a pre-fix body was written from the wrong facts');
  assert(storedVersion() === report.REPORT_FORMAT_VERSION && JSON.parse((db.prepare('SELECT ratings FROM match_reports WHERE kind = ? AND ref_id = ?').get('fixture', REF) as { ratings: string }).ratings).length === 25,
    'the regenerated report is written back, so the next read is a plain cache hit');

  // A row with NO version at all is a pre-versioning row -> treated as format 1 -> regenerated.
  const noVersion = JSON.parse(JSON.stringify(rep!.facts)) as Record<string, unknown>;
  delete noVersion.version;
  db.prepare('UPDATE match_reports SET ratings = ?, facts = ? WHERE kind = ? AND ref_id = ?')
    .run(JSON.stringify(rep!.facts.ratings.slice(0, 22)), JSON.stringify({ ...noVersion, ratings: rep!.facts.ratings.slice(0, 22) }), 'fixture', REF);
  const unversioned = await report.buildMatchReport('fixture', REF, 'Home FC', 'Away FC');
  assert(unversioned !== null && unversioned.ratings.length === 25, `an unstamped (pre-versioning) row regenerates too (got ${unversioned?.ratings.length})`);

  // Availability guard: a stale row whose RECORDING is gone can't be regenerated — it must still
  // serve the old report rather than degrade a played match to "no report available".
  const REF_NOREC = 424243;
  await match.persistRecording('fixture', REF_NOREC, lines);
  const orphan = await report.buildMatchReport('fixture', REF_NOREC, 'Home FC', 'Away FC');
  assert(orphan !== null && orphan.ratings.length === 25, 'the second match reports normally while its recording exists');
  db.prepare('UPDATE match_reports SET facts = ? WHERE kind = ? AND ref_id = ?')
    .run(JSON.stringify({ ...JSON.parse(JSON.stringify(orphan!.facts)), version: 1 }), 'fixture', REF_NOREC);
  db.prepare('DELETE FROM match_recordings WHERE kind = ? AND ref_id = ?').run('fixture', REF_NOREC);
  const rescued = await report.buildMatchReport('fixture', REF_NOREC, 'Home FC', 'Away FC');
  assert(rescued !== null && rescued.ratings.length === 25 && rescued.headline === 'Home FC 3–1 Away FC',
    'an out-of-date report whose recording is gone still serves the cached copy (never null)');
  assert(await report.buildMatchReport('fixture', 999999, 'Home FC', 'Away FC') === null,
    'a match with neither a cached report nor a recording is still null');

  console.log(`_report_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  rmSync(WORK, { recursive: true, force: true });
}

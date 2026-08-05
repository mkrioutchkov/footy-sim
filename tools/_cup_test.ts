// tools/_cup_test.ts — engine-free regression for web/backend/cup.ts (the knockout cup bracket).
// Recreated from the GAME_LAYER_NOTES.md ledger entry:
//
//   "Cup competition (cup.ts). A single-elimination knockout of every world club (16, or 8 for
//    a legacy single league), drawn at random each season ... Drawn ties → a deterministic
//    seeded shootout. createCup (idempotent) at world creation + each rollover; advanceCupRound
//    (idempotent, won't duplicate a round — also a uq_cup_tie unique index); cupView/
//    pendingCupRound/cupTieFor. ... Verified by tools/_cup_test.ts (incl. idempotency + the
//    draw shootout + a full 16→1 run) + HTTP smoke."
//
// cup.ts is the bracket LOGIC ("testable without the engine" — its own header); playing a tie
// through live.exe lives in match.ts (playCupTie). Ties here are "played" by writing scores
// directly, every winner chosen by the test, so the run is deterministic even though createCup's
// draw is Math.random-driven: the draw gets invariant assertions (coverage / uniqueness /
// halving / row-identity idempotency), crafted rows + the pure cupTieWinnerId get exact ones.
//
// NOT covered (a gap, not hacked around): the kind='cup' recording of a played tie. That
// enqueue is private to match.ts playCupTie and fires only AFTER runEngineSummary (a live.exe
// run), so it is unreachable module-side without the engine; the HTTP smoke owns that path.
// Likewise the round-R-at-matchday-R×3 scheduling is /api/advance wiring (index.ts), not cup.ts.
//
// Run: cd <repo> && npx tsx tools/_cup_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run under the OS temp dir — web/backend/data/ untouched.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// db.ts resolves FOOTY_DB at import time, so it MUST be set before ANY backend module loads —
// hence every backend import below this block is dynamic. Unique file per run (pid), pre-wiped.
const dbDir = path.join(os.tmpdir(), 'footy-testdb');
mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, `cup-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
process.env.FOOTY_DB = dbPath;

const { db } = await import('../web/backend/db.ts');
const { roundName, createCup, cupTieWinnerId, pendingCupRound, advanceCupRound, cupTieFor, cupView } =
  await import('../web/backend/cup.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

// ── Fixture builders ─────────────────────────────────────────────────────────
// cup.ts reads leagues (id/world_id/season), teams (id/league_id/name) and cup_ties only —
// no players needed, no engine. Multi-league worlds follow game.ts createWorldLeagues: the
// tier-1 league's id IS the world_id and every division of the world carries it.
function makeLeague(name: string, worldId?: number): number {
  return Number(db.prepare('INSERT INTO leagues (name, season, status, tier, world_id) VALUES (?, 1, ?, ?, ?)')
    .run(name, 'running', worldId == null ? 1 : 2, worldId ?? null).lastInsertRowid);
}
let clubCount = 0;
function makeTeams(leagueId: number, n: number, prefix: string): number[] {
  const ins = db.prepare("INSERT INTO teams (league_id, name, manager, tactics, created_at) VALUES (?, ?, 'AI', '{}', 0)");
  return Array.from({ length: n }, () => Number(ins.run(leagueId, `${prefix} FC ${++clubCount}`).lastInsertRowid));
}

interface CupTieRow { id: number; world_id: number; season: number; round: number; slot: number; home_team_id: number | null; away_team_id: number | null; seed: number; played: number; home_score: number | null; away_score: number | null; home_pens: number | null; away_pens: number | null; winner_team_id: number | null }

function tiesOf(worldId: number, round?: number): CupTieRow[] {
  return (round == null
    ? db.prepare('SELECT * FROM cup_ties WHERE world_id = ? ORDER BY round, slot').all(worldId)
    : db.prepare('SELECT * FROM cup_ties WHERE world_id = ? AND round = ? ORDER BY slot').all(worldId, round)
  ) as unknown as CupTieRow[];
}
const dumpCup = (worldId: number): string => JSON.stringify(tiesOf(worldId));
function playTie(id: number, hs: number, as: number, hp: number | null = null, ap: number | null = null): void {
  db.prepare('UPDATE cup_ties SET played = 1, home_score = ?, away_score = ?, home_pens = ?, away_pens = ? WHERE id = ?')
    .run(hs, as, hp, ap, id);
}
// Multiset equality (sorted-array compare) — catches a duplicated participant, not just a missing one.
const sortedJson = (xs: number[]): string => JSON.stringify([...xs].sort((a, b) => a - b));
const setEq = (a: number[], b: number[]): boolean => sortedJson(a) === sortedJson(b);

// Play every tie of a round with test-chosen results, so the expected winner of each slot is
// known exactly: slot 0 is always the DRAW tie (1-1, pens 4-2 → home via the shootout), other
// even slots a 2-0 home win, odd slots a 1-3 away win — both advancement sides and the shootout
// path are exercised in every round (including a final decided on penalties).
function playRound(worldId: number, round: number): number[] {
  const expected: number[] = [];
  for (const t of tiesOf(worldId, round)) {
    if (t.slot === 0) { playTie(t.id, 1, 1, 4, 2); expected.push(t.home_team_id as number); }
    else if (t.slot % 2 === 0) { playTie(t.id, 2, 0); expected.push(t.home_team_id as number); }
    else { playTie(t.id, 1, 3); expected.push(t.away_team_id as number); }
  }
  return expected;
}

// ── roundName ────────────────────────────────────────────────────────────────
// "anchor the last few rounds to Final/SF/QF regardless of bracket size" (cup.ts) — the 16-club
// world names 4 rounds, the 8-club legacy field 3 (its ROUND 1 is already the quarter-final).
assert(roundName(4, 4) === 'Final', `roundName(4,4) = Final, got ${roundName(4, 4)}`);
assert(roundName(3, 4) === 'Semi-final', `roundName(3,4) = Semi-final, got ${roundName(3, 4)}`);
assert(roundName(2, 4) === 'Quarter-final', `roundName(2,4) = Quarter-final, got ${roundName(2, 4)}`);
assert(roundName(1, 4) === 'Round 1', `roundName(1,4) = Round 1, got ${roundName(1, 4)}`);
assert(roundName(3, 3) === 'Final', '8-club cup: round 3 is the Final');
assert(roundName(2, 3) === 'Semi-final', '8-club cup: round 2 is the Semi-final');
assert(roundName(1, 3) === 'Quarter-final', '8-club cup: round 1 anchors to Quarter-final');
assert(roundName(1, 1) === 'Final', 'a 2-club cup has only a Final');
assert(roundName(5, 5) === 'Final' && roundName(1, 5) === 'Round 1', 'a 32-club bracket still anchors its ends');
// DISCREPANCY (latent, beyond the shipped 8/16 fields): roundName(2,5) falls through to the
// legacy ROUND_NAMES table and answers 'Quarter-final' for what would be a round of 16 —
// createCup accepts ANY power of two, so a 32-club world would mislabel round 2. Current
// behaviour asserted; flagged in the test report.
assert(roundName(2, 5) === 'Quarter-final', `roundName(2,5) falls through ROUND_NAMES to Quarter-final, got ${roundName(2, 5)}`);
assert(roundName(6, 9) === 'Round 6', 'rounds with no legacy name fall back to "Round N"');

// ── cupTieWinnerId: score → pens → recorded legacy winner → seed parity ──────
// LEDGER: "Drawn ties → a deterministic seeded shootout." The stored pens decide a drawn tie;
// cup.ts: "Preserve an already-recorded legacy winner; otherwise old unadvanced draws keep
// seed parity." Pure function, so every precedence step is asserted exactly.
type TieProbe = Parameters<typeof cupTieWinnerId>[0];
const probe = (over: Partial<TieProbe>): TieProbe =>
  ({ home_team_id: 101, away_team_id: 202, seed: 2, home_score: null, away_score: null, home_pens: null, away_pens: null, winner_team_id: null, ...over });
assert(cupTieWinnerId(probe({ home_score: 2, away_score: 1 })) === 101, 'higher home score wins the tie');
assert(cupTieWinnerId(probe({ home_score: 0, away_score: 3 })) === 202, 'higher away score wins the tie');
assert(cupTieWinnerId(probe({ home_score: 2, away_score: 1, home_pens: 0, away_pens: 5 })) === 101,
  'a decisive score outranks stray pens');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, home_pens: 4, away_pens: 3 })) === 101,
  'a drawn tie is decided by the shootout: home pens 4-3');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, home_pens: 3, away_pens: 4 })) === 202,
  'a drawn tie is decided by the shootout: away pens 3-4');
assert(cupTieWinnerId(probe({ home_score: 0, away_score: 0, home_pens: 5, away_pens: 3 })) === 101,
  'a 0-0 draw still reaches the shootout');
assert(cupTieWinnerId(probe({ seed: 2 })) === 101, 'NULL scores read as 0-0: even seed keeps home parity');
assert(cupTieWinnerId(probe({ seed: 3 })) === 202, 'NULL scores read as 0-0: odd seed keeps away parity');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, home_pens: 3, away_pens: 3, seed: 3 })) === 202,
  'level pens (impossible live, tolerated here) fall through to seed parity');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, home_pens: 4, seed: 2 })) === 101,
  'a one-sided pens record is ignored — both legs required');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, winner_team_id: 202, seed: 2 })) === 202,
  'an already-recorded legacy winner is preserved over seed parity');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, winner_team_id: 101, seed: 3 })) === 101,
  'a recorded home winner is preserved too');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, winner_team_id: 999, seed: 2 })) === 101
  && cupTieWinnerId(probe({ home_score: 1, away_score: 1, winner_team_id: 999, seed: 3 })) === 202,
  'a recorded winner that is NEITHER team is ignored — parity applies');
assert(cupTieWinnerId(probe({ home_score: 1, away_score: 1, home_pens: 4, away_pens: 2, winner_team_id: 202 })) === 101,
  'stored pens outrank a contradictory recorded winner');

// ── createCup on a 16-club two-division world ────────────────────────────────
// LEDGER: "A single-elimination knockout of every world club (16 ...), drawn at random each
// season (so a Championship side can draw + dump out a PL one)" — the draw mixes BOTH divisions
// into one field of 16, every club exactly once. The draw itself is random, so these are
// invariant assertions.
const d1 = makeLeague('Cup World — Division 1');
db.prepare('UPDATE leagues SET world_id = ? WHERE id = ?').run(d1, d1);   // tier-1 id IS the world id
const d2 = makeLeague('Cup World — Division 2', d1);
const clubs = [...makeTeams(d1, 8, 'Prem'), ...makeTeams(d2, 8, 'Champ')];
createCup(d2);   // game.ts finalizeWorld calls it with the SECOND division's league id
const r1 = tiesOf(d1, 1);
assert(r1.length === 8, `16 clubs pair into 8 round-1 ties, got ${r1.length}`);
assert(tiesOf(d1).length === 8, 'only round 1 is seeded at creation — later rounds wait on results');
assert(r1.every(t => t.world_id === d1 && t.season === 1), 'ties carry the world id + current season');
assert(r1.map(t => t.slot).join(',') === '0,1,2,3,4,5,6,7', 'round-1 slots are 0..7 in bracket order');
assert(r1.every(t => !t.played && t.home_score == null && t.away_score == null && t.winner_team_id == null),
  'freshly drawn ties are unplayed with no scores or winner');
assert(setEq(r1.flatMap(t => [t.home_team_id as number, t.away_team_id as number]), clubs),
  'the draw covers every club of BOTH divisions exactly once');
assert(r1.every(t => t.seed >= 1 && t.seed <= 99999 && Number.isInteger(t.seed)),
  'every tie carries an integer engine seed in 1..99999');

// LEDGER: "createCup (idempotent) at world creation + each rollover" — a re-draw within the
// same season is a no-op from EITHER division's league id: byte-identical rows, no reshuffle.
const drawBefore = dumpCup(d1);
createCup(d2);
assert(dumpCup(d1) === drawBefore, 're-createCup from the second division does not reshuffle the draw');
createCup(d1);
assert(dumpCup(d1) === drawBefore, 're-createCup from the top division resolves the same world — still a no-op');

// LEDGER: "cupView/pendingCupRound/cupTieFor" — the pending round is visible from every league
// of the world and lists exactly the unplayed ties.
const pend1a = pendingCupRound(d2);
assert(pend1a != null && pend1a.round === 1 && pend1a.tieIds.length === 8, 'round 1 is pending with all 8 ties');
const pend1b = pendingCupRound(d1);
assert(pend1b != null && setEq(pend1b.tieIds, pend1a?.tieIds ?? []), 'both divisions see the same pending world cup round');

// ── Playing round 1: partial rounds, the advance guard ───────────────────────
assert(advanceCupRound(d2, 1) === null, 'an unplayed round cannot be advanced');
// Play slots 0..2 by the fixed scheme (slot 0 = the shootout draw), leaving 5 ties open.
const expect1: number[] = [];
for (const t of r1) {
  if (t.slot === 0) expect1.push(t.home_team_id as number);
  else if (t.slot % 2 === 0) expect1.push(t.home_team_id as number);
  else expect1.push(t.away_team_id as number);
}
playTie(r1[0].id, 1, 1, 4, 2);
playTie(r1[1].id, 1, 3);
playTie(r1[2].id, 2, 0);
const pendMid = pendingCupRound(d2);
assert(pendMid != null && pendMid.round === 1 && pendMid.tieIds.length === 5, 'a half-played round stays pending with only the unplayed ties');
assert(setEq(pendMid?.tieIds ?? [], r1.slice(3).map(t => t.id)), 'the pending list is exactly the 5 open ties');
assert(advanceCupRound(d2, 1) === null, 'a half-played round still cannot be advanced');
for (const t of r1.slice(3)) {
  if (t.slot % 2 === 0) playTie(t.id, 2, 0); else playTie(t.id, 1, 3);
}
// Between the last result and the advance there is no next round yet, so nothing is pending —
// /api/advance runs advanceCupRound in the same tick to seed it.
assert(pendingCupRound(d2) === null, 'a fully-played round with no next round seeded leaves nothing pending');

// ── advanceCupRound: winners recorded, next round paired, idempotent ─────────
// LEDGER: "advanceCupRound (idempotent, won't duplicate a round — also a uq_cup_tie unique
// index)". Winners are recorded on the round-1 rows and paired into round 2 in slot order.
const adv1 = advanceCupRound(d2, 1);
assert(adv1 != null && adv1.round === 1 && adv1.champion === null, 'advancing round 1 crowns nobody yet');
assert(JSON.stringify(adv1?.winners) === JSON.stringify(expect1), 'round-1 winners are exactly the test-chosen ones, in slot order');
const r1After = tiesOf(d1, 1);
assert(r1After.every((t, i) => t.winner_team_id === expect1[i]), 'each round-1 row records its winner');
// LEDGER: "the draw shootout" — the slot-0 tie was 1-1 and its 4-2 pens winner advanced.
assert(r1After[0].home_score === 1 && r1After[0].away_score === 1
  && r1After[0].home_pens === 4 && r1After[0].away_pens === 2
  && r1After[0].winner_team_id === r1After[0].home_team_id,
  'a drawn tie produced a winner via the recorded shootout');
const r2 = tiesOf(d1, 2);
assert(r2.length === 4, `8 winners pair into 4 quarter-finals, got ${r2.length}`);
assert(r2.every((t, i) => t.slot === i && t.home_team_id === expect1[2 * i] && t.away_team_id === expect1[2 * i + 1]),
  'round 2 pairs winners in bracket order: slot i = winners[2i] vs winners[2i+1]');
assert(r2.every(t => !t.played && t.winner_team_id == null), 'the next round starts unplayed');
const bracketBefore = dumpCup(d1);
const adv1b = advanceCupRound(d2, 1);
assert(adv1b != null && JSON.stringify(adv1b?.winners) === JSON.stringify(expect1), 'a re-advance reports the same winners');
assert(dumpCup(d1) === bracketBefore, 're-advancing round 1 duplicates nothing and reshuffles no seeds');
assert(tiesOf(d1, 2).length === 4, 'round 2 still has exactly 4 ties after the retried advance');
const pend2 = pendingCupRound(d2);
assert(pend2 != null && pend2.round === 2 && pend2.tieIds.length === 4, 'round 2 is now the pending round');

// ── A full run to a champion (16 → 1) ────────────────────────────────────────
// LEDGER: "a full 16→1 run". Rounds 2..4 play by the same scheme — every round's slot-0 tie
// (including the FINAL) is decided by the shootout, and round sizes halve to a final.
let champion: number | null = null;
for (let round = 2; round <= 4; round++) {
  const pend = pendingCupRound(d2);
  assert(pend != null && pend.round === round, `round ${round} is pending after the previous advance`);
  assert((pend?.tieIds.length ?? 0) === 16 / 2 ** round, `round ${round} has ${16 / 2 ** round} ties`);
  const expected = playRound(d1, round);
  const adv = advanceCupRound(d2, round);
  assert(adv != null && JSON.stringify(adv?.winners) === JSON.stringify(expected),
    `round ${round} advances exactly the chosen winners`);
  if (round < 4) {
    assert(adv?.champion === null, `no champion before the final (round ${round})`);
  } else {
    champion = adv?.champion ?? null;
  }
}
const finalRow = tiesOf(d1, 4)[0];
assert(champion != null && champion === finalRow.winner_team_id, 'advancing the final crowns the recorded final winner');
assert(champion === finalRow.home_team_id && finalRow.home_pens === 4 && finalRow.away_pens === 2,
  'the final itself was drawn and the champion won it on penalties');
assert(clubs.includes(champion as number), 'the champion is one of the 16 world clubs');
assert(pendingCupRound(d2) === null, 'a finished cup has no pending round');
assert(advanceCupRound(d2, 5) === null, 'there is no round beyond the final to advance');

// Whole-bracket invariants: sizes halve 8→4→2→1; every winner came from the tie; each round's
// field is EXACTLY the previous round's winners; eliminated clubs never reappear.
const rounds = [1, 2, 3, 4].map(r => tiesOf(d1, r));
assert(rounds.map(r => r.length).join(',') === '8,4,2,1', 'round sizes halve to a final');
assert(rounds.every(rr => rr.every(t => t.played === 1 && (t.winner_team_id === t.home_team_id || t.winner_team_id === t.away_team_id))),
  'every tie in the bracket is played and won by one of its own two teams');
const eliminated = new Set<number>();
for (let r = 0; r < 4; r++) {
  const field = rounds[r].flatMap(t => [t.home_team_id as number, t.away_team_id as number]);
  assert(field.every(id => !eliminated.has(id)), `no eliminated club reappears in round ${r + 1}`);
  if (r > 0) {
    assert(setEq(field, rounds[r - 1].map(t => t.winner_team_id as number)),
      `round ${r + 1}'s field is exactly the round-${r} winners`);
  }
  for (const t of rounds[r]) eliminated.add((t.winner_team_id === t.home_team_id ? t.away_team_id : t.home_team_id) as number);
}
assert(eliminated.size === 15 && !eliminated.has(champion as number),
  'a 16-club knockout eliminates exactly 15 clubs and never the champion');

// ── cupView + cupTieFor over the finished bracket ────────────────────────────
// LEDGER: "cupView/pendingCupRound/cupTieFor" + "/api/cup + a #/cup bracket screen".
const view = cupView(d2);
assert(view.totalRounds === 4, `a 16-club cup renders 4 rounds, got ${view.totalRounds}`);
assert(view.rounds.map(r => r.name).join('|') === 'Round 1|Quarter-final|Semi-final|Final',
  `round names anchor to the final, got ${view.rounds.map(r => r.name).join('|')}`);
assert(view.rounds.map(r => r.ties.length).join(',') === '8,4,2,1', 'the view shows the halving bracket');
assert(view.rounds.every(r => r.ties.every(t => typeof t.home === 'string' && typeof t.away === 'string')),
  'every tie resolves both club names across divisions');
const champName = (db.prepare('SELECT name FROM teams WHERE id = ?').get(champion) as unknown as { name: string }).name;
assert(view.championTeamId === champion && view.champion === champName,
  'the view names the champion from the final tie');
const viewTop = cupView(d1);
assert(viewTop.championTeamId === champion && viewTop.totalRounds === 4,
  'both divisions view the same world cup');
const slot0View = view.rounds[0].ties[0];
assert(slot0View.played && slot0View.homePens === 4 && slot0View.awayPens === 2,
  'the view carries the shootout score of a drawn tie');

const runnerUp = (finalRow.home_team_id === champion ? finalRow.away_team_id : finalRow.home_team_id) as number;
const champFinal = cupTieFor(champion as number, d1, 4);
assert(champFinal != null && champFinal.won === true, 'cupTieFor: the champion won the final');
assert(champFinal?.homeScore === 1 && champFinal?.awayScore === 1 && champFinal?.homePens === 4 && champFinal?.awayPens === 2,
  'cupTieFor reports the drawn final with its pens');
assert(champFinal?.opponent === (db.prepare('SELECT name FROM teams WHERE id = ?').get(runnerUp) as unknown as { name: string }).name,
  'cupTieFor names the runner-up as the opponent');
const loserFinal = cupTieFor(runnerUp, d2, 4);
assert(loserFinal != null && loserFinal.won === false, 'cupTieFor: the runner-up lost the final');
assert(cupTieFor(champion as number, d2, 5) === null, 'cupTieFor of a nonexistent round is null');

// ── The 8-club legacy single league ──────────────────────────────────────────
// LEDGER: "(16, or 8 for a legacy single league)" — world_id NULL keys the cup by the league's
// own id; 8 clubs make a 3-round cup whose FIRST round is already the Quarter-final.
const l8 = makeLeague('Legacy Single League');
const legacyClubs = makeTeams(l8, 8, 'Legacy');
createCup(l8);
const legacyR1 = tiesOf(l8, 1);
assert(legacyR1.length === 4 && legacyR1.every(t => t.world_id === l8),
  'a lone league is its own world: 8 clubs, 4 ties keyed by the league id');
assert(setEq(legacyR1.flatMap(t => [t.home_team_id as number, t.away_team_id as number]), legacyClubs),
  'the legacy draw covers all 8 clubs exactly once');
const legacyView = cupView(l8);
assert(legacyView.totalRounds === 3 && legacyView.rounds[0].name === 'Quarter-final',
  'an 8-club cup renders 3 rounds starting at the Quarter-final');
assert(cupTieFor(legacyClubs[0], l8, 1) === null, 'cupTieFor of an UNPLAYED tie is null');
// Cross-world isolation: neither world's cup admits the other's clubs.
assert(cupTieFor(legacyClubs[0], d2, 1) === null, 'a legacy club has no tie in the 16-club world cup');
assert(cupTieFor(champion as number, l8, 1) === null, 'the world champion has no tie in the legacy cup');
let legacyChampion: number | null = null;
for (let round = 1; round <= 3; round++) {
  playRound(l8, round);
  legacyChampion = advanceCupRound(l8, round)?.champion ?? null;
}
assert(legacyChampion != null && legacyClubs.includes(legacyChampion as number),
  'the 8-club cup also runs 8→1 to a champion of its own clubs');
assert([1, 2, 3].map(r => tiesOf(l8, r).length).join(',') === '4,2,1', 'the legacy bracket halves 4→2→1');
assert(cupView(d2).championTeamId === champion, 'the legacy cup leaves the world cup untouched');

// ── Field-size guards + unknown leagues ──────────────────────────────────────
// cup.ts: "Needs a power-of-two field (8 or 16 here)" — anything else refuses to draw.
const l6 = makeLeague('Six A Side'); makeTeams(l6, 6, 'Six');
createCup(l6);
assert(tiesOf(l6).length === 0, 'a 6-club field is not a power of two — no cup is drawn');
const l1 = makeLeague('Lonely League'); makeTeams(l1, 1, 'Solo');
createCup(l1);
assert(tiesOf(l1).length === 0, 'one club cannot have a cup');
const l0 = makeLeague('Empty League');
createCup(l0);
assert(tiesOf(l0).length === 0, 'an empty league cannot have a cup');
createCup(999999);   // unknown league: worldOf is null — must not throw
assert(pendingCupRound(999999) === null, 'an unknown league has no pending cup round');
assert(advanceCupRound(999999, 1) === null, 'an unknown league cannot advance a cup round');
assert(cupTieFor(1, 999999, 1) === null, 'an unknown league has no cup ties');
const ghost = cupView(999999);
assert(ghost.rounds.length === 0 && ghost.totalRounds === 0 && ghost.champion === null && ghost.championTeamId === null,
  'cupView of an unknown league is the empty bracket');

// pendingCupRound requires BOTH teams set — a half-seeded tie (NULL side) is never pending.
const lp = makeLeague('Half Seeded'); const [pendClub] = makeTeams(lp, 2, 'Pend');
db.prepare('INSERT INTO cup_ties (world_id, season, round, slot, home_team_id, away_team_id, seed) VALUES (?, 1, 1, 0, ?, NULL, 7)')
  .run(lp, pendClub);
assert(pendingCupRound(lp) === null, 'a tie missing a team is not pending');

// ── The minimal field + a season rollover redraw ─────────────────────────────
// LEDGER: "createCup (idempotent) at world creation + each rollover" — same season: no-op
// (asserted above); NEW season: a fresh draw alongside the archived one. And with 2 clubs the
// only round IS the final, so a drawn final's shootout crowns the champion directly.
const l2 = makeLeague('Two Club World'); const duo = makeTeams(l2, 2, 'Duo');
createCup(l2);
const duoTie = tiesOf(l2, 1)[0];
assert(tiesOf(l2).length === 1 && setEq([duoTie.home_team_id as number, duoTie.away_team_id as number], duo),
  'two clubs draw one tie — the final');
assert(cupView(l2).totalRounds === 1 && cupView(l2).rounds[0].name === 'Final', 'a 2-club cup is a bare Final');
playTie(duoTie.id, 0, 0, 5, 3);
const duoAdv = advanceCupRound(l2, 1);
assert(duoAdv != null && duoAdv.champion === duoTie.home_team_id,
  'a single-tie round advances straight to a champion — the shootout winner of a 0-0 final');
assert(cupView(l2).championTeamId === duoTie.home_team_id, 'the view crowns the shootout champion');
db.prepare('UPDATE leagues SET season = 2 WHERE id = ?').run(l2);
createCup(l2);
const l2All = tiesOf(l2);
assert(l2All.length === 2, 'a season rollover redraws the cup instead of no-opping');
const s2Tie = l2All.find(t => t.season === 2);
assert(s2Tie != null && !s2Tie.played && s2Tie.winner_team_id == null, "the new season's tie starts fresh");
assert(l2All.some(t => t.season === 1 && t.winner_team_id === duoTie.home_team_id),
  "last season's final is archived untouched");
assert(cupView(l2).championTeamId === null && (pendingCupRound(l2)?.round ?? 0) === 1,
  "the view + pending now track the NEW season's cup");

// ── Seed parity + legacy-winner preservation THROUGH advanceCupRound ─────────
// Hand-inserted draws with chosen seeds (bypassing the random draw) prove the tie-break wiring
// inside the advance itself: "old unadvanced draws keep seed parity", recorded winners survive.
const l4 = makeLeague('Parity World'); const [pa, pb, pc, pd] = makeTeams(l4, 4, 'Par');
const insTie = db.prepare('INSERT INTO cup_ties (world_id, season, round, slot, home_team_id, away_team_id, seed, played, home_score, away_score) VALUES (?, 1, 1, ?, ?, ?, ?, 1, ?, ?)');
insTie.run(l4, 0, pa, pb, 2, 1, 1);   // even seed → home (pa) on the legacy no-pens draw
insTie.run(l4, 1, pc, pd, 3, 2, 2);   // odd seed → away (pd)
const parityAdv = advanceCupRound(l4, 1);
assert(parityAdv != null && JSON.stringify(parityAdv?.winners) === JSON.stringify([pa, pd]),
  'legacy no-pens draws advance by seed parity: even → home, odd → away');
const parityFinal = tiesOf(l4, 2)[0];
assert(parityFinal.home_team_id === pa && parityFinal.away_team_id === pd, 'the parity winners meet in the final');
assert(parityFinal.home_team_id !== pb && parityFinal.away_team_id !== pb
  && parityFinal.home_team_id !== pc && parityFinal.away_team_id !== pc,
  'the parity losers (pb, pc) never reach the final');
// Record the winner parity would NOT pick, then advance: the recorded winner must be preserved.
const parityPick = parityFinal.seed % 2 === 0 ? pa : pd;
const recorded = parityPick === pa ? pd : pa;
db.prepare('UPDATE cup_ties SET played = 1, home_score = 0, away_score = 0, winner_team_id = ? WHERE id = ?')
  .run(recorded, parityFinal.id);
const legacyAdv = advanceCupRound(l4, 2);
assert(legacyAdv != null && legacyAdv.champion === recorded,
  'an already-recorded winner on a no-pens draw survives the advance over seed parity');

console.log(`_cup_test: ${assertions} assertions passed`);

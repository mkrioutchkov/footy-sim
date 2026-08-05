// tools/_loans_test.ts — engine-free verification of the loan system in web/backend/market.ts:
// loanIn (borrow a listed player for the season — no fee, window-gated, guards on both squads),
// endLoan (§2.12 early give-back, window-independent), and returnLoans (season rollover sends
// every loanee in the rolling-over WORLD home — world-scoped, not global), plus the guards that
// make a loanee untouchable (not a transfer target, not biddable, not listable, not re-loanable).
//
// Recreated 2026-08-05: the original lived only in a session scratch dir (GAME_LAYER_NOTES.md
// ledger: "Verified by tools/_loans_test.ts (18 — no-fee move with id preserved, owner-min
// refusal, the guards, window gating, return-to-parent + idempotent)") and was never committed.
// SPEC = GAME_LAYER_NOTES.md — each covered ledger claim is quoted above its assertion group.
// Where the ledger and the code disagree, the CURRENT code behaviour is asserted and the drift
// is flagged `// DISCREPANCY:`.
//
//   npx tsx tools/_loans_test.ts
//
// The test builds TWO throwaway sqlite worlds under the OS temp dir (world B exists to prove
// returnLoans is world-scoped); it deliberately IGNORES an inherited FOOTY_DB so it can never
// run against a real save, chdirs into a scratch cwd BEFORE importing any backend module (so
// match.ts's cwd-relative spec dir lands in temp too), and never touches web/backend/data/.
// Exits non-zero on failure.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// db.ts resolves FOOTY_DB at import time and match.ts (pulled in by season.ts for the rollover)
// resolves its spec scratch from process.cwd() at import time — pin BOTH before any backend
// module loads, hence every backend import below this block is dynamic. Unique file per run.
const tmpRoot = process.env.FOOTY_LOANS_TEST_DIR ?? path.join(os.tmpdir(), 'footy-testdb');
const cwdDir = path.join(tmpRoot, `loans-cwd-${process.pid}`);
mkdirSync(cwdDir, { recursive: true });
process.chdir(cwdDir);
const dbPath = path.join(tmpRoot, `loans-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
process.env.FOOTY_DB = dbPath;

// World generation draws on Math.random; pin it (mulberry32) so every run builds the identical
// worlds. Assertions still target INVARIANTS (ids, flags, conservation, contiguity) — the seed
// only makes a green run reproducible, it is never itself asserted on.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(20260805);

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');
const season = await import('../web/backend/season.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(`_loans_test FAILED: ${message}`); }
  assertions += 1;
}

function one<T>(sql: string, ...args: (string | number)[]): T {
  return db.prepare(sql).get(...args) as T;
}
function all<T>(sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}
interface LoanRow { id: number; team_id: number; slot: number; name: string; role: string; wage: number | null; parent_team_id: number | null; loan_until: number | null; listed: number; ask_price: number | null }
const playerRow = (id: number): LoanRow =>
  one<LoanRow>('SELECT id, team_id, slot, name, role, wage, parent_team_id, loan_until, listed, ask_price FROM players WHERE id = ?', id);
const teamName = (id: number): string => one<{ name: string }>('SELECT name FROM teams WHERE id = ?', id).name;
const teamBudget = (id: number): number => one<{ v: number }>('SELECT budget AS v FROM teams WHERE id = ?', id).v;
const squadCount = (id: number): number => one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', id).n;
const wageBillOf = (id: number): number => one<{ v: number }>('SELECT COALESCE(SUM(wage), 0) AS v FROM players WHERE team_id = ?', id).v;
const contiguous = (id: number): boolean =>
  all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', id).every((r, i) => r.slot === i);

// ── 0. Two worlds ──────────────────────────────────────────────────────────────────────────────
// World A: the borrower under test. World B: a second, independent world whose loans must
// SURVIVE world A's returns/rollover (ledger: "review fix: world-scoped, not global").
db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('loans_tester', 'x', 'x', 0)").run();
const userA = one<{ id: number }>("SELECT id FROM users WHERE username = 'loans_tester'").id;
const A = game.newSeasonForUser(userA, 'loans_tester', 'Loan Test FC', game.DEFAULT_TACTICS);
db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('loans_tester_b', 'x', 'x', 0)").run();
const userB = one<{ id: number }>("SELECT id FROM users WHERE username = 'loans_tester_b'").id;
const B = game.newSeasonForUser(userB, 'loans_tester_b', 'World B FC', game.DEFAULT_TACTICS);

const myTeam = A.teamId;                       // human club, tier 2 of world A
const LA1 = A.worldId, LA2 = A.leagueId;       // world A: tier-1 league id IS the world id
const LB1 = B.worldId, LB2 = B.leagueId;
const aiA2 = all<{ id: number }>('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id', LA2).map(t => t.id);
const aiA1 = all<{ id: number }>('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id', LA1).map(t => t.id);
const aiB2 = all<{ id: number }>('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id', LB2).map(t => t.id);
assert(aiA2.length === 7 && aiA1.length === 8 && aiB2.length === 7, 'two seeded worlds: 7+8 AI clubs in A, 7 in B');

const ownerO = aiA2[0];    // lends his GK to the human club (the main loan under test)
const thirdT = aiA2[1];    // tries to re-loan the loanee
const S = aiA2[6];         // shrunk to the 11-man floor for the owner-min refusal
const ownerC = aiA1[0], borrowerD = aiA1[1];   // the AI→AI loan that rides into the rollover
const ownerB = aiB2[0], ownerB2 = aiB2[1];     // world B lenders

// Loans are gated on wage headroom; seeded bills are emergent, so give every BORROWER a huge
// wage budget up front (the headroom REFUSAL below shrinks it deliberately, then restores it).
for (const id of [myTeam, borrowerD, B.teamId]) db.prepare('UPDATE teams SET wage_budget = 500000000 WHERE id = ?').run(id);

const w0 = market.transferWindow(LA2);
assert(w0.open && w0.window === 'summer' && w0.current === 1, 'summer window open before matchday 1 (loans possible)');

// ── 1. loanIn refusals ─────────────────────────────────────────────────────────────────────────
// Ledger: "loanIn(borrower, targetPlayerId) borrows another club's player for the season — no
// fee, window-gated, the owner must keep a legal squad, the borrower needs room + wage headroom".
// DISCREPANCY: the ledger's loans entry never mentions the LISTED gate — the code (§1.16)
// refuses to loan any player who isn't transfer-listed, even a clause-armed transfer target;
// asserted below as the code behaves.
const gkId = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 0', ownerO).id;
let r = market.loanIn(999999, gkId);
assert(!r.ok && r.error === 'team not found', 'unknown borrower refused');
r = market.loanIn(myTeam, 99999999);
assert(!r.ok && r.error === 'player not found', 'unknown target refused');
const ownPid = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 0', myTeam).id;
r = market.loanIn(myTeam, ownPid);
assert(!r.ok && r.error === 'already your player', 'cannot borrow your own man');
r = market.loanIn(myTeam, gkId);
assert(!r.ok && (r.error ?? '').endsWith("isn't available to loan"), 'an UNLISTED player cannot be loaned (§1.16 gate — beyond the ledger text)');

assert(market.listPlayer(ownerO, 0).ok === true, "the lender's starting GK is listed (loanable)");
const bPid = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 12', ownerB).id;
assert(market.listPlayer(ownerB, 12).ok === true, 'a world-B player is listed');
r = market.loanIn(myTeam, bPid);
assert(!r.ok && r.error === 'player is outside your world', "another world's player cannot be borrowed");

// "the owner must keep a legal squad" — a lender at the 11-man floor refuses.
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(S);
assert(squadCount(S) === market.SQUAD_MIN, 'refusal probe: a lender at the 11-man floor');
assert(market.listPlayer(S, 5).ok === true, 'the floor club still lists him (listing is just a flag)');
const sPid = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 5', S).id;
r = market.loanIn(myTeam, sPid);
assert(!r.ok && (r.error ?? '').includes('squad is at the minimum'), "a club won't loan out down to the minimum squad");

// "the borrower needs room + wage headroom".
const insDummy = db.prepare("INSERT INTO players (team_id, slot, name, role, attrs, age, wage, contract_years) VALUES (?, ?, ?, 'CM', ?, 24, 25000, 4)");
const flat40 = JSON.stringify({ speed: 40, passing: 40, creativity: 40, shooting: 40, tackling: 40, positioning: 40, stamina: 40 });
for (let i = 0; i < market.SQUAD_MAX - 17; i++) { insDummy.run(myTeam, 17 + i, `ZZ Dummy ${i}`, flat40); }
r = market.loanIn(myTeam, gkId);
assert(!r.ok && r.error === `squad full (max ${market.SQUAD_MAX})`, 'the 24-man cap blocks a loan');
db.prepare("DELETE FROM players WHERE team_id = ? AND name LIKE 'ZZ Dummy%'").run(myTeam);
db.prepare('UPDATE teams SET wage_budget = ? WHERE id = ?').run(wageBillOf(myTeam), myTeam);
r = market.loanIn(myTeam, gkId);
assert(!r.ok && r.error === 'not enough wage budget for his wages', 'no wage headroom -> no loan (he carries the loanee\'s wage)');
db.prepare('UPDATE teams SET wage_budget = 500000000 WHERE id = ?').run(myTeam);
assert(playerRow(gkId).team_id === ownerO && squadCount(myTeam) === 17 && squadCount(ownerO) === 17,
  'the whole refusal battery moved nobody');

// ── 2. A clean loanIn: no fee, in place, wage responsibility ──────────────────────────────────
// Ledger: "no fee"; deferred-list note: "loans are currently free, borrower pays full wage".
// Ledger: "players.parent_team_id (owner) + loan_until track it; relocatePlayer moves him IN
// PLACE (keeping his row id, so the link survives a clean return — unlike a transfer, which
// deletes + re-inserts) and backfills the club he leaves."
const gk0 = playerRow(gkId);
const gkWage = gk0.wage ?? 0;
const myBudget0 = teamBudget(myTeam), oBudget0 = teamBudget(ownerO);
const myBill0 = wageBillOf(myTeam), oBill0 = wageBillOf(ownerO);
const sumA0 = one<{ v: number }>('SELECT SUM(budget) AS v FROM teams WHERE league_id IN (?, ?)', LA1, LA2).v;
r = market.loanIn(myTeam, gkId);
assert(r.ok === true && r.player === gk0.name && r.from === teamName(ownerO), 'the loan goes through, naming player + lender');
assert(teamBudget(myTeam) === myBudget0 && teamBudget(ownerO) === oBudget0
  && one<{ v: number }>('SELECT SUM(budget) AS v FROM teams WHERE league_id IN (?, ?)', LA1, LA2).v === sumA0,
  'NO fee: neither budget moves, world money conserved (loans are currently free)');
const gk1 = playerRow(gkId);
assert(gk1.team_id === myTeam && gk1.id === gkId, 'the SAME row moved in place — id preserved, no delete + re-insert');
assert(gk1.parent_team_id === ownerO && gk1.loan_until === 1, 'parent_team_id = the lender; loan_until = the current season (1)');
assert(gk1.listed === 0 && gk1.ask_price === null, 'his listing is cleared on arrival');
assert(gk1.slot === 17 && squadCount(myTeam) === 18, 'the loanee joins the borrower\'s bench (appended at the last slot)');
assert(squadCount(ownerO) === 16 && contiguous(ownerO), 'the lender is one man down, slots renumbered contiguously');
assert(one<{ role: string }>('SELECT role FROM players WHERE team_id = ? AND slot = 0', ownerO).role === 'GK',
  'the lender\'s vacated XI slot is backfilled ON-ROLE from the bench (relocatePlayer backfills the club he leaves)');
// "the borrower … carries the loanee's wage" — the wage rides on the row, so the bill follows team_id.
assert(wageBillOf(myTeam) === myBill0 + gkWage, 'the borrower\'s wage bill takes on his FULL wage');
assert(wageBillOf(ownerO) === oBill0 - gkWage, 'the lender\'s wage bill sheds it (no wage-split — deferred)');

// Ledger: "the squad view flags onLoan".
const mv = market.getMarket(myTeam)!;
const loaneeView = mv.squad.find(p => p.slot === 17)!;
assert(loaneeView.onLoan === true && loaneeView.loanFrom === teamName(ownerO) && loaneeView.loanUntil === 1,
  'getMarket flags the loanee: onLoan + loanFrom + loanUntil');
assert(mv.squad.filter(p => p.onLoan).length === 1 && mv.wageBill === myBill0 + gkWage,
  'exactly one loanee in the view; the market view bills his wage to the borrower');

// ── 3. The guards while he is out on loan ─────────────────────────────────────────────────────
// Ledger: "Guards: a loaned player is excluded from transfer targets and can't be bid for,
// listed, or re-loaned".
const lp = market.listPlayer(myTeam, 17);
assert(!lp.ok && lp.error === "he's only here on loan — you can't sell him", 'the borrower cannot LIST a loanee');
let rb = market.bidForPlayer(ownerO, gkId, 5_000_000);
assert(!rb.ok && (rb.error ?? '').includes('out on loan — not available to buy'), 'nobody can BID for a loanee (not even his owner)');
// Force the listed flag on to prove the parent_team_id guards hold on their own.
db.prepare('UPDATE players SET listed = 1, ask_price = 1000000 WHERE id = ?').run(gkId);
assert(!market.transferTargets(ownerO).some(t => t.id === gkId), 'a loanee never surfaces as a transfer TARGET, listed or not');
assert(!market.searchPlayers(ownerO).players.some(p => p.id === gkId), 'the scouting centre excludes loaned-in players too');
r = market.loanIn(thirdT, gkId);
assert(!r.ok && (r.error ?? '').endsWith('is already out on loan'), 'a loanee cannot be RE-LOANED to a third club');
db.prepare('UPDATE players SET listed = 0, ask_price = NULL WHERE id = ?').run(gkId);
// The assignment's "unavailable to the owner meanwhile": he is off the owner's books entirely.
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND id = ?', ownerO, gkId).n === 0
  && !market.getMarket(ownerO)!.squad.some(p => p.name === gk0.name),
  'the owner has no such player meanwhile — he cannot field, list or sell him');

// ── 4. Two more live loans (they ride into the returnLoans / rollover checks) ─────────────────
assert(market.listPlayer(ownerC, 12).ok === true, 'an AI tier-1 bench man is listed');
const pidA = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 12', ownerC).id;
r = market.loanIn(borrowerD, pidA);
assert(r.ok === true && playerRow(pidA).team_id === borrowerD && playerRow(pidA).parent_team_id === ownerC,
  'an AI→AI loan in world A is live (rides into the rollover)');
r = market.loanIn(B.teamId, bPid);
assert(r.ok === true && playerRow(bPid).team_id === B.teamId && playerRow(bPid).parent_team_id === ownerB,
  'a world-B loan is live (must survive world A\'s returns)');

// ── 5. Window gating, then endLoan (§2.12) while the window is SHUT ───────────────────────────
// Ledger: loans are "window-gated" (loanIn). endLoan (code §2.12): "send a loaned-in player
// back to his parent club EARLY … Window-independent — it's a give-back, not a signing."
// DISCREPANCY: endLoan is not in the ledger's loans entry at all (nor is loanOut — the
// deferred list still marks loan-OUT "NOT YET" although market.ts now ships both).
db.prepare('UPDATE fixtures SET played = 1, home_score = 1, away_score = 0 WHERE league_id = ? AND round = 1').run(LA2);
assert(!market.transferWindow(LA2).open, 'matchday 1 played: the summer window is shut');
r = market.loanIn(myTeam, 1);
assert(!r.ok && r.error === 'the transfer window is shut', 'loanIn is window-gated');

r = market.endLoan(myTeam, 99);
assert(!r.ok && r.error === 'no such player', 'endLoan on an empty slot refused');
r = market.endLoan(myTeam, 0);
assert(!r.ok && (r.error ?? '').endsWith("isn't on loan"), 'endLoan on an owned player refused');
db.prepare('DELETE FROM players WHERE team_id = ? AND slot BETWEEN 10 AND 16').run(myTeam);
assert(squadCount(myTeam) === market.SQUAD_MIN, 'endLoan probe: borrower shrunk to the 11-man floor');
r = market.endLoan(myTeam, 17);
assert(!r.ok && (r.error ?? '').includes(`can't drop below ${market.SQUAD_MIN}`), 'the borrower must keep a legal squad to give him back');
insDummy.run(myTeam, 10, 'ZZ Cover Man', flat40);

const oCount5 = squadCount(ownerO);
r = market.endLoan(myTeam, 17);
assert(r.ok === true && r.player === gk0.name && r.from === teamName(ownerO),
  'endLoan works while the window is SHUT — a give-back, not a signing (§2.12)');
const gk2 = playerRow(gkId);
assert(gk2.team_id === ownerO && gk2.parent_team_id === null && gk2.loan_until === null,
  'ownership restored: back at the parent club, loan link cleared');
assert(gk2.id === gkId && gk2.slot === oCount5, 'the same row went home, appended to the owner\'s bench');
assert(squadCount(ownerO) === oCount5 + 1 && contiguous(ownerO), 'owner squad + slots restored contiguously');
assert(squadCount(myTeam) === 11 && contiguous(myTeam), 'the borrower renumbers contiguously after the give-back');
assert(wageBillOf(ownerO) === oBill0, 'his wage lands back on the owner\'s bill');
assert(teamBudget(myTeam) === myBudget0 && teamBudget(ownerO) === oBudget0, 'the give-back is free too — no fee either way');
r = market.endLoan(myTeam, 17);
assert(!r.ok && r.error === 'no such player', 'the return is settled — nothing left to give back');

// ── 6. returnLoans: world-scoped + idempotent ─────────────────────────────────────────────────
// Ledger: "returnLoans(leagueIds) sends every loanee in the rolling-over world home at season
// rollover (review fix: world-scoped, not global)".
assert(market.returnLoans([]).length === 0, 'no leagues -> no-op');
const retB = market.returnLoans([LB1, LB2]);
assert(retB.length === 1 && retB[0].player === playerRow(bPid).name && retB[0].to === teamName(ownerB),
  'world B\'s rollover returns exactly its own loanee, reporting player + destination');
assert(playerRow(bPid).team_id === ownerB && playerRow(bPid).parent_team_id === null && playerRow(bPid).loan_until === null,
  'the world-B loanee is home with the loan link cleared');
assert(playerRow(pidA).team_id === borrowerD && playerRow(pidA).parent_team_id === ownerC,
  'world A\'s live loan is UNTOUCHED by world B\'s return (world-scoped, not global)');
assert(market.returnLoans([LB1, LB2]).length === 0, 'returning again is a no-op (idempotent)');

// A fresh world-B loan that must survive world A's REAL rollover below.
assert(market.listPlayer(ownerB2, 12).ok === true, 'another world-B player is listed');
const bPid2 = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 12', ownerB2).id;
r = market.loanIn(B.teamId, bPid2);
assert(r.ok === true && playerRow(bPid2).parent_team_id === ownerB2, 'a second world-B loan is live');

// ── 7. The real rollover path brings the world-A loanee home ──────────────────────────────────
// Ledger: rolloverSeason "step 0. loans are season-long: send every loaned-in player in THIS
// world back to his parent club" (season.ts wires returnLoans inside the rollover tx).
// Fixtures are stuffed 1-0 via SQL (deterministic tables); contracts are padded so expiry /
// retirement noise can't evict the players under test mid-assertion.
db.prepare('UPDATE players SET contract_years = 4 WHERE team_id IN (SELECT id FROM teams WHERE league_id IN (?, ?))').run(LA1, LA2);
db.prepare('UPDATE players SET age = 24 WHERE id = ?').run(pidA);
db.prepare('UPDATE fixtures SET played = 1, home_score = 1, away_score = 0 WHERE league_id IN (?, ?) AND played = 0').run(LA1, LA2);
assert(season.seasonComplete(LA2) === true, 'world A season complete (world B untouched)');
const res = season.rolloverSeason(LA2);
assert(res !== null && res.season === 2, 'world A rolls over to season 2');
const pA = playerRow(pidA);
assert(pA.team_id === ownerC && pA.parent_team_id === null && pA.loan_until === null,
  'the rollover sent the world-A loanee home to his parent club, loan link cleared');
assert(one<{ n: number }>(
  'SELECT COUNT(*) AS n FROM players WHERE parent_team_id IS NOT NULL AND team_id IN (SELECT id FROM teams WHERE league_id IN (?, ?))',
  LA1, LA2).n === 0, 'no loanee anywhere in world A survives its rollover');
assert(playerRow(bPid2).team_id === B.teamId && playerRow(bPid2).parent_team_id === ownerB2 && playerRow(bPid2).loan_until === 1,
  'world B\'s mid-season loan SURVIVES world A\'s rollover (the review fix, through the real path)');

console.log(`_loans_test: ${assertions} assertions passed`);

// Transfer windows + club-to-club negotiation test (core stream). Throwaway FOOTY_DB; no engine.
// Asserts: the window opens summer (pre-season) + winter (mid-season) and is shut otherwise; a bid
// is rejected / countered / accepted by AI valuation with money conserved + squads moved; an
// unlisted player needs a premium; a club at the minimum squad won't sell; and club-to-club deals
// (user bid + AI buy_listed) are blocked outside a window.
//
//   npx tsx tools/_transfer_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-trf-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('boss', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Bidders FC', game.DEFAULT_TACTICS);
const team = game.getTeamWithPlayers(teamId)!;
const leagueId = team.leagueId;
const sellerId = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id LIMIT 1').get(leagueId) as { id: number }).id;
const sellerName = (db.prepare('SELECT name FROM teams WHERE id = ?').get(sellerId) as { name: string }).name;
// P1 now seeds a 17-man squad; trim the controlled buyer + seller to the starting XI so this test's
// precise depth scenario (seller builds to 12, sells back to a legal 11) holds as written.
for (const tid of [teamId, sellerId]) db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(tid);

const ATTRS = JSON.stringify({ speed: 55, passing: 55, creativity: 55, shooting: 55, tackling: 55, positioning: 55, stamina: 55 });
function addPlayer(tid: number, name: string, role: string, listed = false, ask: number | null = null): number {
  const maxSlot = (db.prepare('SELECT COALESCE(MAX(slot), -1) AS s FROM players WHERE team_id = ?').get(tid) as { s: number }).s;
  const info = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(tid, maxSlot + 1, name, role, ATTRS, 25, null, null, listed ? 1 : 0, ask, 1_000_000, 3);
  return Number(info.lastInsertRowid);
}
const budgetOf = (tid: number) => (db.prepare('SELECT budget FROM teams WHERE id = ?').get(tid) as { budget: number }).budget;
const squadSize = (tid: number) => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(tid) as { n: number }).n;
const maxRound = (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
const mid = Math.max(2, Math.floor(maxRound / 2));
const playUpTo = (r: number) => db.prepare('UPDATE fixtures SET played = 1, home_score = 1, away_score = 0 WHERE league_id = ? AND round < ?').run(leagueId, r);

// ── window: a fresh season is in the summer window ───────────────────────────────────────────
const w0 = market.transferWindow(leagueId);
check(w0.open && w0.window === 'summer', `pre-season is the summer window (open, got ${w0.window})`);

// give the AI seller bench depth (12) so it can sell, then list a player at a known ask ─────────
const askId = addPlayer(sellerId, 'Listed Lars', 'CM', true, 5_000_000);
db.prepare('UPDATE players SET contract_years = 1 WHERE id = ?').run(askId);   // 1 year left, to prove it's carried
check(squadSize(sellerId) === 12, 'seller has squad depth (12) so it can sell');

// transferTargets surfaces the listing to the buyer
const targets = market.transferTargets(teamId);
check(targets.some(t => t.id === askId && t.club === sellerName && t.askPrice === 5_000_000), 'a listed player at another club appears as a transfer target');

// ── §2.1 negotiation: a bid is a PENDING offer resolved at the matchday tick (reject/counter/accept) ──
const offerStatus = (pid: number) => market.offersForTeam(teamId).find(o => o.playerId === pid)?.status;
market.bidForPlayer(teamId, askId, 1_000_000); market.processOffers(leagueId);
check(offerStatus(askId) === 'rejected', 'a lowball bid (<80% of ask) is rejected at the tick');
market.bidForPlayer(teamId, askId, 4_500_000); market.processOffers(leagueId);
const counter = market.offersForTeam(teamId).find(o => o.playerId === askId);
check(counter?.status === 'countered' && counter?.counterFee === 5_000_000, 'a near-miss bid is countered at the asking price');

const buyerBefore = budgetOf(teamId), sellerBefore = budgetOf(sellerId), buyerSq = squadSize(teamId);
market.bidForPlayer(teamId, askId, 5_000_000); market.processOffers(leagueId);
check(offerStatus(askId) === 'accepted', 'a bid at the asking price is accepted at the tick');
check(squadSize(teamId) === buyerSq + 1 && squadSize(sellerId) === 11, 'the player moves: buyer +1, seller back to 11');
check(budgetOf(teamId) === buyerBefore - 5_000_000 && budgetOf(sellerId) === sellerBefore + 5_000_000, 'the fee is conserved (debit buyer, credit seller)');
check(!!db.prepare('SELECT 1 FROM players WHERE name = ? AND team_id = ?').get('Listed Lars', teamId), 'the bought player is now in the buyer squad');
const boughtContract = db.prepare('SELECT contract_years FROM players WHERE name = ? AND team_id = ?').get('Listed Lars', teamId) as { contract_years: number };
check(boughtContract.contract_years === 1, 'the bought player keeps his remaining contract (1yr), not a reset to 3');

// ── unlisted player needs a premium over value ───────────────────────────────────────────────
const unId = addPlayer(sellerId, 'Quiet Quinn', 'CM', false, null);   // seller back to 12, this one not listed
const val = game.playerValue(JSON.parse(ATTRS), 25, null);
market.bidForPlayer(teamId, unId, Math.round(val)); market.processOffers(leagueId);
check(offerStatus(unId) !== 'accepted', "a value-only bid for an UNLISTED player isn't enough");
market.bidForPlayer(teamId, unId, Math.round(val * 1.4) + 1); market.processOffers(leagueId);
check(offerStatus(unId) === 'accepted', 'a premium bid prises an unlisted player away');

// ── a club at the minimum squad refuses to sell ──────────────────────────────────────────────
const thinId = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL AND id != ? ORDER BY id LIMIT 1').get(leagueId, sellerId) as { id: number }).id;
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(thinId);   // trim the third club to a bare 11
const thinPlayer = (db.prepare('SELECT id FROM players WHERE team_id = ? LIMIT 1').get(thinId) as { id: number }).id;
db.prepare('UPDATE players SET listed = 1, ask_price = 1000000 WHERE id = ?').run(thinPlayer);
check(squadSize(thinId) === 11, 'the other AI club is at the minimum squad (11)');
market.bidForPlayer(teamId, thinPlayer, 5_000_000); market.processOffers(leagueId);
check((db.prepare('SELECT team_id FROM players WHERE id = ?').get(thinPlayer) as { team_id: number }).team_id === thinId, "a club at the minimum squad won't sell even to a big bid (player stays)");

// ── windows progress: shut once underway → winter at mid-season → shut again ─────────────────
if (mid >= 3) { playUpTo(2); check(!market.transferWindow(leagueId).open, 'the window shuts once the season is underway'); }
playUpTo(mid); const wW = market.transferWindow(leagueId);
check(wW.open && wW.window === 'winter', `the winter window opens at mid-season (matchday ${mid})`);
playUpTo(mid + 2); check(!market.transferWindow(leagueId).open, 'the window shuts again after winter');

// ── club-to-club deals are blocked outside a window (user bid + AI buy_listed) ───────────────
const reAdd = addPlayer(sellerId, 'Window Will', 'CM', true, 2_000_000);   // a fresh listing while shut
check(market.bidForPlayer(teamId, reAdd, 5_000_000).status === 'error', 'a bid is refused while the window is shut');
const evs = market.marketTick(leagueId);
check(evs.every(e => e.type !== 'buy_listed'), 'the AI makes no club-to-club buys while the window is shut');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

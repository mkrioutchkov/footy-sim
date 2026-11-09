// §2.1 signing-drama lifecycle test (no engine, no LLM). Bids create PENDING offers; processOffers
// (the matchday tick) resolves them — reject / counter / accept — with an auction (highest wins),
// counter-matching, expiry, and budget conservation.
//
//   npx tsx tools/_offers_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-offers-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('boss', 'secret');
const { teamId: buyer } = game.newSeasonForUser(u.id, u.username, 'Buyer FC', game.DEFAULT_TACTICS);
const leagueId = (db.prepare('SELECT league_id FROM teams WHERE id = ?').get(buyer) as { league_id: number }).league_id;
const seller = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id LIMIT 1').get(leagueId) as { id: number }).id;
const buyer2 = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL AND id != ? ORDER BY id LIMIT 1').get(leagueId, seller) as { id: number }).id;

// fresh season → unplayed fixtures → summer window OPEN
check(market.transferWindow(leagueId).open, 'transfer window is open on a fresh season');
db.prepare('UPDATE teams SET budget = ?, wage_budget = ? WHERE id IN (?, ?)').run(500_000_000, 500_000_000, buyer, buyer2);

const ATTRS = JSON.stringify({ speed: 60, passing: 60, creativity: 60, shooting: 60, tackling: 60, positioning: 60, stamina: 60, height: 54, handling: 30 });
// insert seller players ABOVE the seeded squad (P1 seeds a 17-man squad, so slot 11 is now occupied)
let benchSlot = (db.prepare('SELECT COALESCE(MAX(slot), -1) + 1 AS s FROM players WHERE team_id = ?').get(seller) as { s: number }).s;
function listSellerPlayer(name: string, ask: number): number {
  const slot = benchSlot++;
  db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, listed, ask_price, wage, contract_years) VALUES (?, ?, ?, ?, ?, 25, 70, 1, ?, ?, 3)')
    .run(seller, slot, name, 'CM', ATTRS, ask, 50_000);
  return (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(seller, slot) as { id: number }).id;
}

// ── bid creates a PENDING offer (not instant) ──
const p1 = listSellerPlayer('Lowball Target', 10_000_000);
const r1 = market.bidForPlayer(buyer, p1, 1_000_000);   // well below the floor
check(r1.ok && r1.status === 'pending', 'a bid creates a PENDING offer (no instant deal)');
check((db.prepare('SELECT team_id FROM players WHERE id = ?').get(p1) as { team_id: number }).team_id === seller, 'the player has NOT moved yet (still the seller’s)');

// ── processOffers rejects a too-low bid ──
market.processOffers(leagueId);
check(market.offersForTeam(buyer).find(o => o.playerId === p1)?.status === 'rejected', 'a bid below the floor is rejected at the tick');

// ── counter then match → accepted, budget conserved ──
const p2 = listSellerPlayer('Fair Target', 10_000_000);
const buyerBudget0 = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(buyer) as { budget: number }).budget;
const sellerBudget0 = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(seller) as { budget: number }).budget;
market.bidForPlayer(buyer, p2, 8_500_000);   // within COUNTER_FLOOR (0.8 × 10M) but below ask
market.processOffers(leagueId);
const o2 = market.offersForTeam(buyer).find(o => o.playerId === p2)!;
check(o2.status === 'countered' && o2.counterFee === 10_000_000, 'a near-miss bid is countered at the ask');
const matched = market.matchCounter(buyer, o2.id);
check(matched.ok && matched.status === 'accepted', 'matching the counter completes the deal');
check((db.prepare("SELECT team_id FROM players WHERE name = 'Fair Target'").get() as { team_id: number } | undefined)?.team_id === buyer, 'the bought player (a new row after transfer) is now the buyer’s');
const buyerBudget1 = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(buyer) as { budget: number }).budget;
const sellerBudget1 = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(seller) as { budget: number }).budget;
check(buyerBudget0 - buyerBudget1 === 10_000_000 && sellerBudget1 - sellerBudget0 === 10_000_000, 'budget conserved: buyer −fee, seller +fee');

// ── auction: two buyers, one player → highest qualifying bid wins, the other is rejected ──
const p3 = listSellerPlayer('Contested Target', 10_000_000);
market.bidForPlayer(buyer, p3, 11_000_000);    // higher
market.bidForPlayer(buyer2, p3, 10_500_000);   // lower, also ≥ ask
market.processOffers(leagueId);
check((db.prepare("SELECT team_id FROM players WHERE name = 'Contested Target'").get() as { team_id: number } | undefined)?.team_id === buyer, 'the auction sells to the HIGHEST bidder');
check(market.offersForTeam(buyer).find(o => o.playerId === p3)?.status === 'accepted', 'winning bid accepted');
check(market.offersForTeam(buyer2).find(o => o.playerId === p3)?.status === 'rejected', 'the outbid offer is rejected');

// ── expiry: a pending offer past its expires_round lapses ──
const p4 = listSellerPlayer('Stale Target', 10_000_000);
market.bidForPlayer(buyer, p4, 10_000_000);
db.prepare("UPDATE transfer_offers SET expires_round = 0 WHERE player_id = ? AND status = 'pending'").run(p4);   // force it stale
market.processOffers(leagueId);
check((db.prepare('SELECT status FROM transfer_offers WHERE player_id = ? AND buyer_team_id = ?').get(p4, buyer) as { status: string } | undefined)?.status === 'expired', 'a stale pending offer expires (and does not complete)');
check((db.prepare('SELECT team_id FROM players WHERE id = ?').get(p4) as { team_id: number }).team_id === seller, 'an expired offer leaves the player where he was');

// ── withdraw a live offer ──
const p5 = listSellerPlayer('Withdraw Target', 10_000_000);
market.bidForPlayer(buyer, p5, 5_000_000);
const liveId = market.offersForTeam(buyer).find(o => o.playerId === p5)!.id;
check(market.withdrawOffer(buyer, liveId).ok, 'a live offer can be withdrawn');
check(!market.offersForTeam(buyer).some(o => o.id === liveId), 'a withdrawn offer drops off the list');

db.close();
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* windows temp lock */ }
process.exit(fail === 0 ? 0 : 1);

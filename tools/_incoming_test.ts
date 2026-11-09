// §2.1 incoming offers test (no engine). An AI bidding for the HUMAN's listed player is now a PENDING
// INCOMING offer the manager resolves — not an instant sale. Covers: marketTick never instant-buys a
// human listing; processOffers does NOT auto-resolve an incoming bid (the human decides); accept sells
// + conserves money; reject; the auction (accept one rejects rivals); and expiry of an ignored bid.
//
//   npx tsx tools/_incoming_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-incoming-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('seller', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Selling FC', game.DEFAULT_TACTICS);
const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
const aiTeams = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id', ).all(leagueId) as { id: number }[]).map(t => t.id);
const budgetOf = (tid: number) => (db.prepare('SELECT budget FROM teams WHERE id = ?').get(tid) as { budget: number }).budget;
const teamOfName = (name: string) => (db.prepare('SELECT team_id FROM players WHERE name = ? ORDER BY id DESC LIMIT 1').get(name) as { team_id: number } | undefined)?.team_id;
const cur = () => market.transferWindow(leagueId).current;

// fresh season → summer window open; give the AI buyers money
db.prepare('UPDATE teams SET budget = 500000000, wage_budget = 500000000 WHERE user_id IS NULL').run();
check(market.transferWindow(leagueId).open, 'the summer window is open on a fresh season');

// list a few of the human's bench players
const benchSlots = game.getTeamWithPlayers(teamId)!.players.filter(p => p.slot >= 11).map(p => p.slot);
for (const s of benchSlots.slice(0, 3)) market.listPlayer(teamId, s, 4_000_000);

// ── marketTick never INSTANT-buys a human's listing (only AI-to-AI is instant) ──────────────────
const listedNames = new Set(game.getTeamWithPlayers(teamId)!.players.filter(p => p.slot >= 11 && p.listed).map(p => p.name));
const ev = market.marketTick(leagueId);
check(!ev.some(e => e.type === 'buy_listed' && e.from === game.getTeamWithPlayers(teamId)!.name), 'no AI instant-buys a human listing (no buy_listed FROM the human)');
const stillMine = game.getTeamWithPlayers(teamId)!.players.filter(p => listedNames.has(p.name)).length;
check(stillMine === listedNames.size, 'after one tick the human still owns every listed player (sales need the manager to accept)');

// ── set up a controlled incoming bid (an AI tables a pending offer for a human player) ───────────
const target = game.getTeamWithPlayers(teamId)!.players.find(p => p.slot >= 11)!;
const pid = (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, target.slot) as { id: number }).id;
market.listPlayer(teamId, target.slot, 6_000_000);
const buyerA = aiTeams[0], buyerB = aiTeams[1];
const mkOffer = (buyer: number, fee: number) => db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)")
  .run(buyer, teamId, pid, fee, cur(), cur() + 2, 1).lastInsertRowid as number;
const offA = mkOffer(buyerA, 6_000_000);

const inc = market.incomingOffersForTeam(teamId);
check(inc.some(o => o.id === offA && o.status === 'pending' && o.fee === 6_000_000 && o.playerSlot === target.slot), 'incomingOffersForTeam surfaces the bid for the human to resolve');

// processOffers must NOT auto-resolve an incoming (human-seller) offer — the manager decides
market.processOffers(leagueId);
check((db.prepare('SELECT status FROM transfer_offers WHERE id = ?').get(offA) as { status: string }).status === 'pending', 'processOffers leaves an incoming bid PENDING (it never auto-resolves a human-seller offer)');
check((db.prepare('SELECT team_id FROM players WHERE id = ?').get(pid) as { team_id: number }).team_id === teamId, 'the player has not moved');

// ── reject ────────────────────────────────────────────────────────────────────────────────────
check(market.rejectIncomingOffer(teamId, offA).ok, 'the manager can reject an incoming bid');
check((db.prepare('SELECT status FROM transfer_offers WHERE id = ?').get(offA) as { status: string }).status === 'rejected', 'the rejected bid is off the table');
check(!market.rejectIncomingOffer(teamId, offA).ok, 'a resolved bid cannot be rejected again');

// ── accept → the sale completes + money is conserved ────────────────────────────────────────────
const offA2 = mkOffer(buyerA, 6_000_000);
const hb0 = budgetOf(teamId), ab0 = budgetOf(buyerA);
const acc = market.acceptIncomingOffer(teamId, offA2);
check(acc.ok && acc.fee === 6_000_000 && acc.club === (db.prepare('SELECT name FROM teams WHERE id = ?').get(buyerA) as { name: string }).name, 'accepting an incoming bid sells the player to the bidding club');
check(teamOfName(target.name) === buyerA, 'the player now belongs to the buyer');
check(budgetOf(teamId) === hb0 + 6_000_000 && budgetOf(buyerA) === ab0 - 6_000_000, 'money conserved: seller +fee, buyer −fee');

// ── auction: two clubs bid, accepting one rejects the rival ──────────────────────────────────────
const target2 = game.getTeamWithPlayers(teamId)!.players.find(p => p.slot >= 11)!;
const pid2 = (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, target2.slot) as { id: number }).id;
market.listPlayer(teamId, target2.slot, 3_000_000);
const bid1 = db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)").run(buyerA, teamId, pid2, 3_000_000, cur(), cur() + 2, 1).lastInsertRowid as number;
const bid2 = db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)").run(buyerB, teamId, pid2, 3_500_000, cur(), cur() + 2, 1).lastInsertRowid as number;
// Match the two bids by id: the bench players listed at £4M above draw a random number of AI bids,
// so this player can already carry pending bids of his own and a plain count of 2 was flaky.
const auction = market.incomingOffersForTeam(teamId).filter(o => (o.id === bid1 || o.id === bid2) && o.status === 'pending');
check(auction.length === 2 && auction.every(o => o.playerSlot === target2.slot), 'two clubs can bid for the same player (an auction)');
market.acceptIncomingOffer(teamId, bid2);   // accept the higher bid
check((db.prepare('SELECT status FROM transfer_offers WHERE id = ?').get(bid2) as { status: string }).status === 'accepted', 'the accepted bid completes');
check((db.prepare('SELECT status FROM transfer_offers WHERE id = ?').get(bid1) as { status: string }).status === 'rejected', 'the rival pending bid on the sold player is rejected');

// ── expiry: an ignored incoming bid lapses past its window (uses a bench player, so run before trimming) ──
const target3 = game.getTeamWithPlayers(teamId)!.players.find(p => p.slot >= 11)!;
const pid3 = (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, target3.slot) as { id: number }).id;
market.listPlayer(teamId, target3.slot, 2_000_000);
const stale = db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',0,1,1)").run(buyerA, teamId, pid3, 2_000_000).lastInsertRowid as number;
db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ? AND round <= 3').run(leagueId);   // push current well past expires_round 1
market.processOffers(leagueId);
check((db.prepare('SELECT status FROM transfer_offers WHERE id = ?').get(stale) as { status: string }).status === 'expired', 'an ignored incoming bid lapses past its window');

// ── seller floor: accepting a bid can't drop the squad below the 11-man minimum (review fix) ─────
db.prepare('UPDATE fixtures SET played = 0 WHERE league_id = ?').run(leagueId);   // re-open the summer window
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(teamId);   // trim to a bare 11
const floorPid = (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = 5').get(teamId) as { id: number }).id;
market.listPlayer(teamId, 5, 1_000_000);
const floorOffer = db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)").run(buyerA, teamId, floorPid, 1_000_000, cur(), cur() + 2, 1).lastInsertRowid as number;
check(market.transferWindow(leagueId).open, 'the window is open for the floor check');
const fr = market.acceptIncomingOffer(teamId, floorOffer);
check(!fr.ok, 'cannot accept a bid that would drop the squad below the 11-man floor');
check((db.prepare('SELECT team_id FROM players WHERE id = ?').get(floorPid) as { team_id: number }).team_id === teamId, 'the floor-protected player stays put');

// ── window gate: accepting an incoming bid is refused once the window has shut (review fix) ───────
db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ? AND round <= 2').run(leagueId);   // current > 1 → shut
check(!market.transferWindow(leagueId).open, 'the window is now shut');
const shutOffer = db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)").run(buyerA, teamId, floorPid, 1_000_000, cur(), cur() + 5, 1).lastInsertRowid as number;
const wr = market.acceptIncomingOffer(teamId, shutOffer);
check(!wr.ok && /window/i.test(wr.error ?? ''), 'accepting an incoming bid is refused when the window is shut');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

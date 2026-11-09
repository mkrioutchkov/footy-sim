// Deadline-day / listing-expiry test (audit §2.4, no engine). The transferWindow countdown fields
// (deadline / closesIn / deadlineDay across summer / winter / shut), listPlayer stamping listed_until,
// and marketTick lapsing an unsold listing once its window closes (with a 'listing_expired' event) —
// but NOT on deadline day itself, plus the backstop stamp for a listing made while shut.
//
//   npx tsx tools/_deadline_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-deadline-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('seller', 'secret');
const { leagueId, teamId } = game.newSeasonForUser(u.id, u.username, 'Deadline FC', game.DEFAULT_TACTICS);
const total = (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
const mid = Math.max(2, Math.floor(total / 2));
// drive the "current" matchday: current = MIN(round WHERE played=0), so play rounds < K to reach K
const setCurrent = (k: number) => db.prepare('UPDATE fixtures SET played = (round < ?) WHERE league_id = ?').run(k, leagueId);
const listingOf = (slot: number) => db.prepare('SELECT listed, ask_price, listed_until FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { listed: number; ask_price: number | null; listed_until: number | null };

// ── transferWindow countdown fields ─────────────────────────────────────────────────────────────
setCurrent(1);   // pre-season → summer
let w = market.transferWindow(leagueId);
check(w.open && w.window === 'summer' && w.deadline === 1 && w.deadlineDay === true && w.closesIn === 1, 'summer window: deadline day, closes in 1');
setCurrent(mid);   // winter opens
w = market.transferWindow(leagueId);
check(w.open && w.window === 'winter' && w.deadline === mid + 1 && w.deadlineDay === false && w.closesIn === 2, 'winter first day: closes in 2, not yet deadline day');
setCurrent(mid + 1);   // winter deadline day
w = market.transferWindow(leagueId);
check(w.open && w.deadlineDay === true && w.closesIn === 1, 'winter deadline day: closes in 1');
setCurrent(mid + 2);   // shut again
w = market.transferWindow(leagueId);
check(!w.open && w.deadline === null && w.closesIn === 0 && w.deadlineDay === false, 'shut window: no deadline / closesIn 0');
setCurrent(3 <= mid - 1 ? 3 : mid - 1);   // a clearly-shut mid-gap matchday (2..mid-1)
check(!market.transferWindow(leagueId).open, 'a mid-gap matchday is shut');

// ── listPlayer stamps listed_until from the open window's deadline ───────────────────────────────
setCurrent(mid);   // winter open, deadline = mid+1
market.listPlayer(teamId, 9, 999_000_000);   // huge ask so no AI ever buys it (isolates the expiry path)
check(listingOf(9).listed === 1 && listingOf(9).listed_until === mid + 1, 'listing during an open window stamps listed_until = the deadline');
setCurrent(mid + 2);   // shut
market.listPlayer(teamId, 7, 999_000_000);
check(listingOf(7).listed === 1 && listingOf(7).listed_until === null, 'listing while the window is shut leaves listed_until NULL (no deadline yet)');
market.unlistPlayer(teamId, 7);   // clear it so it doesn't interfere with later ticks

// ── no premature lapse: a listing survives its own deadline day ──────────────────────────────────
setCurrent(mid + 1);   // deadline day, still open
market.marketTick(leagueId);
check(listingOf(9).listed === 1, 'a listing is NOT lapsed on its deadline day (window still open)');

// ── lapse: once the window closes, the unsold listing auto-unlists with an event ─────────────────
setCurrent(mid + 2);   // window now shut (past the deadline)
const ev = market.marketTick(leagueId);
check(listingOf(9).listed === 0 && listingOf(9).ask_price === null && listingOf(9).listed_until === null, 'an unsold listing lapses (auto-unlisted) once its window closes');
const lapse = ev.find(e => e.type === 'listing_expired' && e.teamId === teamId);
check(!!lapse && lapse.player.length > 0, 'a listing_expired event is emitted for the human club');

// ── backstop stamp: a shut-time listing gets a deadline when the next window opens ───────────────
setCurrent(mid + 2);   // shut — list now, with no deadline
market.listPlayer(teamId, 8, 999_000_000);
check(listingOf(8).listed_until === null, 'the shut-time listing starts with no deadline');
setCurrent(mid);   // a window opens
market.marketTick(leagueId);
check(listingOf(8).listed === 1 && listingOf(8).listed_until === mid + 1, 'the shut-time listing gets stamped (and not lapsed) when a window opens');

// ── no-op safety: a tick with no live listings emits no expiry events ─────────────────────────────
market.unlistPlayer(teamId, 8);
check(listingOf(8).listed === 0 && listingOf(8).listed_until === null, 'unlisting clears the deadline too');
setCurrent(mid + 2);
check(market.marketTick(leagueId).every(e => e.type !== 'listing_expired'), 'no listings → no expiry events');

// ── ordering: a deadline-day bid at the ask still completes when the window closes that tick ──────
// (processOffers must run BEFORE expireListings, else the lapsing listing re-prices the live bid)
db.prepare('UPDATE teams SET budget = 200000000, wage_budget = 200000000 WHERE id = ?').run(teamId);
for (let i = 0; i < 2; i++) { const m = market.getMarket(teamId)!; const a = [...m.freeAgents].sort((x, y) => x.value - y.value)[0]; if (a) market.buyFreeAgent(teamId, a.id); }   // squad depth so a sale keeps a legal XI
const buyer = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL LIMIT 1').get(leagueId) as { id: number };
db.prepare('UPDATE teams SET budget = 200000000, wage_budget = 200000000 WHERE id = ?').run(buyer.id);
setCurrent(mid + 1);   // winter deadline day (window open)
const listed = market.listPlayer(teamId, 10);   // default ask = value
const ask = listed.askPrice ?? 0;
const pid = (db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, 10) as { id: number }).id;
db.prepare("INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at) VALUES (?,?,?,?,'pending',?,?,?)")
  .run(buyer.id, teamId, pid, ask, mid + 1, mid + 3, 1);
setCurrent(mid + 2);   // window now shut — the listing (listed_until = mid+1) would lapse this tick
market.marketTick(leagueId);
const off = db.prepare('SELECT status FROM transfer_offers WHERE player_id = ? ORDER BY id DESC LIMIT 1').get(pid) as { status: string } | undefined;
// §2.1 incoming offers superseded the old auto-resolve-at-deadline: an AI's bid on the HUMAN's listed
// player is now a PENDING incoming offer the manager resolves — and it must SURVIVE the deadline tick (the
// listing lapsing must not drop or expire it early), so the manager can still accept it next matchday.
check(off?.status === 'pending', "an AI's deadline-day bid on your listed player survives the lapse as a pending incoming offer (you resolve it; §2.1)");

// ── degenerate 2-round season: the winter deadline is clamped to the last matchday ───────────────
check(market.transferWindow(leagueId).deadline! <= total, 'the winter deadline never overshoots the final matchday');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

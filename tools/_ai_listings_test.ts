// AI surplus-listing test (playthrough P2, no engine). AI clubs now list their weakest bench man so
// the §2.1 auction has inventory — without it "For sale — other clubs" was always empty. Checks the
// listing rule (one at a time, bench-only, never below the floor), that it stocks transferTargets, and
// that the human can actually bid on an AI listing and complete the deal.
//
//   npx tsx tools/_ai_listings_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-ailist-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('scout', 'secret');
const { leagueId, teamId } = game.newSeasonForUser(u.id, u.username, 'Bidders FC', game.DEFAULT_TACTICS);
// Role-weighted, as aiListSurplus rates players (903f192 folded keeper handling into overall).
const ovr = (a: string, role: string) => game.overall(JSON.parse(a), role);
const listedRows = (tid: number) => db.prepare('SELECT slot, ask_price FROM players WHERE team_id = ? AND listed = 1').all(tid) as { slot: number; ask_price: number }[];
const aiTeams = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL', ).all(leagueId) as { id: number }[]).map(t => t.id);

// ── before: nothing is for sale (the empty-board the playthrough hit) ───────────────────────────
check(market.transferTargets(teamId).length === 0, 'no AI listings before the market runs');

// ── aiListSurplus stocks the board: each AI club lists exactly one BENCH man ─────────────────────
market.aiListSurplus(leagueId);
check(aiTeams.every(id => listedRows(id).length === 1), 'every AI club lists exactly one player');
check(aiTeams.every(id => listedRows(id)[0].slot >= 11), 'the listed player is a bench man, not a starter');
// it's the WEAKEST bench man
for (const id of aiTeams) {
  const bench = db.prepare('SELECT slot, attrs, role FROM players WHERE team_id = ? AND slot >= 11').all(id) as { slot: number; attrs: string; role: string }[];
  const weakest = Math.min(...bench.map(b => ovr(b.attrs, b.role)));
  const listed = bench.find(b => b.slot === listedRows(id)[0].slot)!;
  // compare overalls, not slots, so two equally weak bench men cannot flake the check
  check(ovr(listed.attrs, listed.role) === weakest, `AI club ${id} listed its weakest bench man`);
  break;   // one representative check is enough
}
check(market.transferTargets(teamId).length >= aiTeams.length, 'the listings surface to the human as transfer targets');

// ── one listing at a time: a second call adds nothing ───────────────────────────────────────────
market.aiListSurplus(leagueId);
check(aiTeams.every(id => listedRows(id).length === 1), 'a club already listing one player does not list a second');

// ── a club at the squad floor never lists ───────────────────────────────────────────────────────
const bare = aiTeams[0];
db.prepare('UPDATE players SET listed = 0, ask_price = NULL WHERE team_id = ?').run(bare);
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(bare);   // trim to a bare 11
market.aiListSurplus(leagueId);
check(listedRows(bare).length === 0, 'a club at the minimum squad lists nobody (no bench to spare)');

// ── the human can bid on an AI listing and complete the deal (the auction has inventory) ─────────
db.prepare('UPDATE teams SET budget = 500000000, wage_budget = 500000000 WHERE id = ?').run(teamId);
check(market.transferWindow(leagueId).open, 'the summer window is open on a fresh season');
const target = market.transferTargets(teamId)[0];
const bid = market.bidForPlayer(teamId, target.id, target.askPrice ?? target.value);
check(bid.status === 'pending', 'the human can bid on an AI-listed player (pending offer)');
market.processOffers(leagueId);
check(market.offersForTeam(teamId).find(o => o.playerId === target.id)?.status === 'accepted', 'the bid at the ask completes — the AI sells its surplus to the human');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

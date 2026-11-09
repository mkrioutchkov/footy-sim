// Contract renewal negotiation test (audit §2.2, no engine, no LLM). The player verdict
// (evaluateRenewalOffer — ego/morale-driven demand → accept/counter/reject), proposeRenewal
// (one live offer per player), processContractOffers (the 1-matchday consider delay, accept-commits,
// counter, reject, budget-collapse, expiry), matchContractCounter + withdrawContractOffer, and that
// the tick is a no-op (changes nothing) when there are no offers.
//
//   npx tsx tools/_contract_offers_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-contract-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const contracts = await import('../web/backend/contracts.ts');

const SKILLS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
const flat = (v: number) => Object.fromEntries(SKILLS.map(k => [k, v])) as Record<string, number>;
const persona = (ego: number) => ({ traits: { ego } });

// ── evaluateRenewalOffer: the player verdict ────────────────────────────────────────────────────
const attrs = flat(70), age = 24;
const fair = game.playerWage(attrs, age, null);   // ego 50 default → demand == fair
check(contracts.evaluateRenewalOffer(attrs, age, null, 65, fair, 3).decision === 'accept', 'a fair offer (≥ demand) is accepted');
check(contracts.evaluateRenewalOffer(attrs, age, null, 65, fair + 1, 3).decision === 'accept', 'an above-demand offer is accepted');
const low = contracts.evaluateRenewalOffer(attrs, age, null, 65, Math.round(fair * 0.7), 3);
check(low.decision === 'counter' && low.counterWage === low.demand, 'a below-demand offer is countered at the demand');
check(low.demand === fair, 'a neutral (ego 50, mid-morale) player demands exactly the fair wage');
// ego lifts the demand (up to +15%); the same fair offer is no longer enough
const egoV = contracts.evaluateRenewalOffer(attrs, age, persona(100), 65, fair, 3);
check(egoV.decision === 'counter' && egoV.demand > fair, `a big ego demands a premium (${egoV.demand} > ${fair})`);
check(contracts.evaluateRenewalOffer(attrs, age, persona(100), 65, egoV.demand, 3).decision === 'accept', 'meeting the ego-inflated demand is accepted');
// mood: an unhappy man wants more, a buoyant one a touch less
check(contracts.evaluateRenewalOffer(attrs, age, null, 30, fair * 0.8, 3).decision === 'reject', 'a deeply unhappy player rejects a lowball (would rather leave)');
check(contracts.evaluateRenewalOffer(attrs, age, null, 30, Math.round(fair * 1.5), 3).decision === 'accept', 'a generous offer still lands an unhappy player');
check(contracts.evaluateRenewalOffer(attrs, age, null, 90, fair, 3).demand < fair, 'a buoyant player shaves his demand below fair');
check(contracts.evaluateRenewalOffer(attrs, age, null, 65, fair, 9).counterYears === 5, 'offered length is clamped to 1..5');

// ── live squad: set up a controllable player at slot 9 ──────────────────────────────────────────
const u = registerUser('gaffer', 'secret');
const { leagueId, teamId } = game.newSeasonForUser(u.id, u.username, 'Contract FC', game.DEFAULT_TACTICS);
db.prepare('UPDATE teams SET wage_budget = 999000000 WHERE id = ?').run(teamId);
const setPlayer = (slot: number, ovr: number, ageV: number, ego: number, morale: number, wage: number, years: number) =>
  db.prepare('UPDATE players SET attrs = ?, age = ?, personality = ?, morale = ?, wage = ?, contract_years = ? WHERE team_id = ? AND slot = ?')
    .run(JSON.stringify(flat(ovr)), ageV, JSON.stringify(persona(ego)), morale, wage, years, teamId, slot);
const playerOf = (slot: number) => db.prepare('SELECT id, wage, contract_years AS years FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number; wage: number; years: number };
// direct DB status of a slot's latest offer (contractOffersForTeam hides expired/withdrawn from the UI)
const dbStatus = (slot: number) => (db.prepare('SELECT o.status FROM contract_offers o JOIN players p ON p.id = o.player_id WHERE p.team_id = ? AND p.slot = ? ORDER BY o.id DESC LIMIT 1').get(teamId, slot) as { status: string } | undefined)?.status;
const setRound = (r: number) => db.prepare('UPDATE fixtures SET played = (round <= ?) WHERE league_id = ?').run(r, leagueId);

setPlayer(9, 70, 24, 50, 65, 50000, 2);
const fair9 = game.playerWage(flat(70), 24, persona(50));
setRound(0);   // no matchday played yet

// ── proposeRenewal: one live offer per player ────────────────────────────────────────────────────
const prop = contracts.proposeRenewal(teamId, 9, fair9, 4);
check(prop.ok && prop.offers!.length === 1 && prop.offers![0].status === 'pending', 'proposeRenewal creates a pending offer');
contracts.proposeRenewal(teamId, 9, fair9 + 1000, 3);
check(contracts.contractOffersForTeam(teamId).filter(o => o.status === 'pending').length === 1, 'a second proposal supersedes the first (one live offer per player)');
check(!contracts.proposeRenewal(teamId, 99, 50000, 3).ok, 'cannot propose to a non-squad slot');
check(!contracts.proposeRenewal(teamId, 9, 0, 3).ok, 'the offered wage must be positive');

// ── the 1-matchday consider delay ────────────────────────────────────────────────────────────────
check(contracts.processContractOffers(leagueId).length === 0, 'a fresh offer is NOT resolved in the same matchday (the agent considers it)');
check(contracts.contractOffersForTeam(teamId)[0].status === 'pending', 'it stays pending until a matchday passes');

// ── accept: a fair offer, once considered, commits at the offered terms ─────────────────────────
setRound(1);   // a matchday has now passed
const ev1 = contracts.processContractOffers(leagueId);
check(ev1.some(e => e.result === 'accepted'), 'a fair offer is accepted after a matchday');
const after = playerOf(9);
check(after.wage === fair9 + 1000 && after.years === 3, 'the accepted deal committed at the OFFERED wage + length');

// ── counter: a lowball comes back at the demand ─────────────────────────────────────────────────
setPlayer(8, 72, 25, 60, 65, 40000, 2);
const fair8demand = contracts.evaluateRenewalOffer(flat(72), 25, persona(60), 65, 1, 3).demand;
contracts.proposeRenewal(teamId, 8, Math.round(fair8demand * 0.6), 3);   // created at round 1
setRound(2);
contracts.processContractOffers(leagueId);
const co = contracts.contractOffersForTeam(teamId).find(o => o.playerSlot === 8)!;
check(co.status === 'countered' && co.counterWage === fair8demand, 'a lowball is countered at the player’s demand');
check(playerOf(8).wage === 40000, 'a countered (unmatched) offer does NOT change the contract yet');

// ── matchContractCounter: strike it at his terms ────────────────────────────────────────────────
const matched = contracts.matchContractCounter(teamId, co.id);
check(matched.ok && matched.wage === fair8demand, 'matching the counter strikes the deal at his price');
check(playerOf(8).wage === fair8demand, 'the matched renewal updated the contract wage');
check(!contracts.matchContractCounter(teamId, co.id).ok, 'a counter can only be matched once');

// ── reject: a deeply unhappy player turns down a lowball ────────────────────────────────────────
setPlayer(7, 75, 27, 70, 25, 60000, 1);
const d7 = contracts.evaluateRenewalOffer(flat(75), 27, persona(70), 25, 1, 3).demand;
contracts.proposeRenewal(teamId, 7, Math.round(d7 * 0.8), 3);
setRound(3);
contracts.processContractOffers(leagueId);
check(contracts.contractOffersForTeam(teamId).find(o => o.playerSlot === 7)!.status === 'rejected', 'an unsettled player rejects a lowball');

// ── budget collapse: the player accepts but the wage bill can't bear it → the deal falls through ──
setPlayer(6, 70, 24, 50, 65, 50000, 2);
const bill = (db.prepare('SELECT COALESCE(SUM(wage),0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
db.prepare('UPDATE teams SET wage_budget = ? WHERE id = ?').run(bill, teamId);   // zero headroom
contracts.proposeRenewal(teamId, 6, 50_000_000, 3);   // huge wage → he'd accept, but it busts the budget
setRound(4);
contracts.processContractOffers(leagueId);
check(contracts.contractOffersForTeam(teamId).find(o => o.playerSlot === 6)!.status === 'rejected', 'an accepted deal the budget cannot bear collapses (rejected)');
check(playerOf(6).wage === 50000, 'the collapsed deal left the wage unchanged');
db.prepare('UPDATE teams SET wage_budget = 999000000 WHERE id = ?').run(teamId);

// ── withdraw a live offer ───────────────────────────────────────────────────────────────────────
setPlayer(5, 68, 23, 50, 65, 45000, 2);
const wprop = contracts.proposeRenewal(teamId, 5, 45000, 3);
check(contracts.withdrawContractOffer(teamId, wprop.offers![0].id).ok, 'a pending offer can be withdrawn');
check(!contracts.contractOffersForTeam(teamId).some(o => o.playerSlot === 5 && (o.status === 'pending' || o.status === 'countered')), 'the withdrawn offer is off the table');
check(!contracts.withdrawContractOffer(teamId, 999999).ok, 'cannot withdraw a non-existent offer');

// ── pending offer that outlived its expiry window lapses ─────────────────────────────────────────
// (current matchday is round 4 from the budget test; force the offer's window into the past)
setPlayer(4, 70, 24, 50, 65, 50000, 2);
const ep = contracts.proposeRenewal(teamId, 4, 50000, 3);
db.prepare('UPDATE contract_offers SET created_round = 1, expires_round = 2 WHERE id = ?').run(ep.offers![0].id);
contracts.processContractOffers(leagueId);   // round 4 > expires 2 → lapses
check(dbStatus(4) === 'expired', 'a pending offer past its expiry window lapses');
check(!contracts.contractOffersForTeam(teamId).some(o => o.playerSlot === 4), 'an expired offer is hidden from the negotiations list');

// ── a live offer for a departed player is reaped (no stuck ghost) ───────────────────────────────
setPlayer(3, 70, 24, 50, 65, 50000, 2);
const ghost = contracts.proposeRenewal(teamId, 3, 50000, 3);
const ghostId = ghost.offers![0].id;
db.prepare('DELETE FROM players WHERE team_id = ? AND slot = ?').run(teamId, 3);   // simulate a sale/release
contracts.processContractOffers(leagueId);
check((db.prepare('SELECT status FROM contract_offers WHERE id = ?').get(ghostId) as { status: string }).status === 'expired', 'a pending offer for a departed player is reaped (expired), not left stuck');

// ── season rollover lapses every live negotiation (round numbers reset) ─────────────────────────
const { tickContracts } = contracts;
setPlayer(2, 70, 24, 50, 65, 50000, 4); setPlayer(1, 72, 25, 60, 65, 40000, 4);
const pend = contracts.proposeRenewal(teamId, 2, 50000, 3).offers!.find(o => o.playerSlot === 2)!;
const cReq = contracts.evaluateRenewalOffer(flat(72), 25, persona(60), 65, 1, 3).demand;
const cnt = contracts.proposeRenewal(teamId, 1, Math.round(cReq * 0.6), 3).offers!.find(o => o.playerSlot === 1)!;
db.prepare('UPDATE contract_offers SET created_round = 0 WHERE id IN (?, ?)').run(pend.id, cnt.id);   // make them resolvable
setRound(1); contracts.processContractOffers(leagueId);   // cnt -> countered, pend likely accepted
db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ?').run(leagueId);   // season complete
tickContracts(leagueId);   // rollover contract tick
check(!contracts.contractOffersForTeam(teamId).some(o => o.status === 'pending' || o.status === 'countered'), 'rollover lapses every live renewal negotiation');

// ── no-op safety: with no live offers, the tick changes nothing ──────────────────────────────────
const billBefore = (db.prepare('SELECT COALESCE(SUM(wage),0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
check(contracts.processContractOffers(leagueId).length === 0, 'processContractOffers is a no-op with no pending offers');
check((db.prepare('SELECT COALESCE(SUM(wage),0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w === billBefore, 'a no-op tick leaves the wage bill untouched');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

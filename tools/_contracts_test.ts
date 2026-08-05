// tools/_contracts_test.ts — engine-free regression for web/backend/contracts.ts: pillar 5.2
// (contracts & wages), the §2.2 renewal NEGOTIATION (propose → the agent deliberates a matchday →
// accept / counter / reject, with an expiry countdown), season-end contract resolution
// (tickContracts: AI force-renew, human release-worst-first-to-the-pool, the legal-XI floor), the
// releasePlayerToFreeAgents handoff into the market's free-agent pool, and the market interplay
// ("Signing is gated by BOTH a fee and wage headroom").
//
// Recreated 2026-08-05: the original lived only in a session scratch dir (GAME_LAYER_NOTES.md
// ledger: "Verified by tools/_contracts_test.ts (18)") and was never committed. SPEC =
// GAME_LAYER_NOTES.md — each covered ledger claim is quoted above its assertion group. Where the
// ledger and the code disagree, the CURRENT code behaviour is asserted and the drift is flagged
// `// DISCREPANCY:`. The §2.2 negotiation has no ledger prose of its own (the ledger's STILL-TODO
// list even predates it), so those groups quote the contracts.ts spec comments instead.
//
//   npx tsx tools/_contracts_test.ts
//
// Isolation: a throwaway sqlite under the OS temp dir, unique per run (pid), pre-wiped —
// web/backend/data/ is never touched. Fully deterministic: the world is hand-inserted row by row
// (no Math.random anywhere on the asserted paths), so every figure is asserted EXACTLY against
// the same pure formulae (game.playerWage / playerValue) the code uses. Exits non-zero on failure.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// db.ts resolves FOOTY_DB at IMPORT time, so it MUST be set before ANY backend module loads —
// hence every backend import below this block is dynamic.
const dbDir = path.join(os.tmpdir(), 'footy-testdb');
mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, `contracts-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
process.env.FOOTY_DB = dbPath;

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');
const contracts = await import('../web/backend/contracts.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(`_contracts_test FAILED: ${message}`); }
  assertions += 1;
}
const near = (x: number, y: number, tol: number): boolean => Math.abs(x - y) <= tol;
const flat = (v: number): Record<string, number> =>
  ({ speed: v, passing: v, creativity: v, shooting: v, tackling: v, positioning: v, stamina: v });

function one<T>(sql: string, ...args: (string | number)[]): T {
  return db.prepare(sql).get(...args) as T;
}
function all<T>(sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}

// ── Fixture builders ───────────────────────────────────────────────────────────────────────────
const mkLeague = (name: string): number =>
  Number(db.prepare('INSERT INTO leagues (name) VALUES (?)').run(name).lastInsertRowid);
const mkTeam = (leagueId: number, name: string, userId: number | null, budget: number, wageBudget: number): number =>
  Number(db.prepare(
    "INSERT INTO teams (user_id, league_id, name, manager, tactics, budget, wage_budget, created_at) VALUES (?, ?, ?, 'Boss', '{}', ?, ?, 0)",
  ).run(userId, leagueId, name, budget, wageBudget).lastInsertRowid);
interface MkPlayer { slot: number; name: string; ovr: number; age?: number; wage?: number | null; cy?: number; morale?: number; personality?: string | null; potential?: number | null; }
function mkPlayer(teamId: number, p: MkPlayer): number {
  return Number(db.prepare(
    "INSERT INTO players (team_id, slot, name, role, attrs, age, wage, contract_years, morale, personality, potential) VALUES (?, ?, ?, 'CM', ?, ?, ?, ?, ?, ?, ?)",
  ).run(teamId, p.slot, p.name, JSON.stringify(flat(p.ovr)), p.age ?? 24,
    p.wage === undefined ? game.playerWage(flat(p.ovr), p.age ?? 24, null) : p.wage,
    p.cy ?? 3, p.morale ?? 65, p.personality ?? null, p.potential ?? null).lastInsertRowid);
}
// leagueRound(leagueId) = MAX(round) of PLAYED fixtures — advance the matchday clock by inserting
// one played self-fixture at the target round (no engine, no scheduler).
const setRound = (leagueId: number, round: number, teamId: number): void => {
  db.prepare('INSERT INTO fixtures (league_id, round, home_team_id, away_team_id, seed, played) VALUES (?, ?, ?, ?, 0, 1)')
    .run(leagueId, round, teamId, teamId);
};
interface OfferRow { id: number; team_id: number; player_id: number; wage: number; years: number; status: string; counter_wage: number | null; counter_years: number | null; created_round: number; expires_round: number; }
const offerFor = (playerId: number): OfferRow =>
  one<OfferRow>('SELECT id, team_id, player_id, wage, years, status, counter_wage, counter_years, created_round, expires_round FROM contract_offers WHERE player_id = ? ORDER BY id DESC LIMIT 1', playerId);
interface PSnap { wage: number | null; contract_years: number; }
const pSnap = (id: number): PSnap => one<PSnap>('SELECT wage, contract_years FROM players WHERE id = ?', id);
const squadCount = (teamId: number): number => one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', teamId).n;
const wageBill = (teamId: number): number => one<{ w: number }>('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?', teamId).w;
const setWageBudget = (teamId: number, v: number): void => { db.prepare('UPDATE teams SET wage_budget = ? WHERE id = ?').run(v, teamId); };

const ego100 = JSON.stringify({ traits: { ego: 100 } });

// ── 1. Wage model tie-in (pure — no DB) ────────────────────────────────────────────────────────
// Ledger 5.2: "Every player draws an annual wage (≈8% of the ego-neutral value × an ego premium —
// a diva costs more to PAY) and holds a contract_years deal; each club has a wage_budget (40M)
// separate from the transfer kitty."
// DISCREPANCY: the code's playerWage (game.ts) is 10% of the ego-neutral value, not ≈8% — the
// economy note's 10% superseded the 5.2 entry. And 40M is only the DB column DEFAULT / the tier-2
// figure; tier-1 clubs get 140M (TIER_FINANCE).
const w85 = game.playerWage(flat(85), 25, null);
assert(near(w85, game.playerValue(flat(85), 25, null) * 0.10, 25_000), 'wage ≈ 10% of ego-neutral value (ledger "≈8%" is stale)');
assert(game.playerWage(flat(85), 25, { traits: { ego: 100 } })
  === Math.max(25_000, Math.round(game.playerValue(flat(85), 25, null) * 0.10 * 1.25 / 25_000) * 25_000),
  'a maxed ego lifts the demand +25% (applied before the £25k rounding) — a diva costs more to PAY');
const defLeague = mkLeague('Default League');
const defTeam = Number(db.prepare("INSERT INTO teams (league_id, name, tactics, created_at) VALUES (?, 'Defaults FC', '{}', 0)").run(defLeague).lastInsertRowid);
assert(one<{ wage_budget: number }>('SELECT wage_budget FROM teams WHERE id = ?', defTeam).wage_budget === 40_000_000,
  'wage_budget defaults to 40M (the ledger figure = the column default / tier-2 money)');
assert(one<{ contract_years: number; morale: number }>(
  "SELECT contract_years, morale FROM players WHERE id = ?",
  mkPlayer(defTeam, { slot: 0, name: 'Default Dan', ovr: 50, cy: undefined as unknown as number })).contract_years === 3,
  'every player holds a contract_years deal (column default 3)');

// ── 2. evaluateRenewalOffer — the player's verdict (pure + deterministic) ─────────────────────
// contracts.ts §2.2 spec: "his DEMAND is the fair wage (from ability/age — the same playerWage the
// value model uses) lifted by ego (a big ego wants up to +15%) and by mood (an unhappy man wants a
// premium to stay, a buoyant one shaves a little). He accepts at or above his demand, counters at
// it otherwise — and a deeply unhappy player rejects a lowball outright."
const a70 = flat(70);
const fair70 = game.playerWage(a70, 25, null);
let v = contracts.evaluateRenewalOffer(a70, 25, null, 65, fair70, 3);
assert(v.decision === 'accept' && v.demand === fair70, 'neutral man, settled mood: demand = the fair playerWage; at-demand offer accepted');
assert(v.counterYears === 3, 'an accepted offer echoes the offered length');
v = contracts.evaluateRenewalOffer(a70, 25, null, 65, fair70 - 1, 3);
assert(v.decision === 'counter' && v.counterWage === v.demand && v.demand === fair70,
  'one pound short of demand: he counters AT his demand');
const p100 = { traits: { ego: 100 } };
const fairEgo = game.playerWage(a70, 25, p100);
v = contracts.evaluateRenewalOffer(a70, 25, p100, 65, 1, 3);
assert(v.demand === Math.round(fairEgo * 1.15), 'ego 100 lifts demand by exactly +15% over HIS (ego-premium) fair wage');
v = contracts.evaluateRenewalOffer(a70, 25, { traits: { ego: 20 } }, 65, 1, 3);
assert(v.demand === game.playerWage(a70, 25, { traits: { ego: 20 } }) && v.demand === fair70,
  'ego below 50 never discounts demand (factor floors at 1.0)');
v = contracts.evaluateRenewalOffer(a70, 25, { nationality: 'XX' }, 65, fair70, 3);
assert(v.decision === 'accept' && v.demand === fair70, 'a personality without traits defaults to ego 50 (neutral)');
// Mood bands: <40 wants +10% to stay, >=80 shaves 3%, 40..79 neutral.
assert(contracts.evaluateRenewalOffer(a70, 25, null, 39, 1, 3).demand === Math.round(fair70 * 1.10), 'morale 39: +10% premium to stay');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 40, 1, 3).demand === fair70, 'morale 40: no unhappiness premium (strict < 40)');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 79, 1, 3).demand === fair70, 'morale 79: still neutral');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 80, 1, 3).demand === Math.round(fair70 * 0.97), 'morale 80: a buoyant man shaves 3%');
// "a deeply unhappy player rejects a lowball outright (he'd rather run his deal down)".
const unhappyDemand = Math.round(fair70 * 1.10);
v = contracts.evaluateRenewalOffer(a70, 25, null, 34, unhappyDemand, 3);
assert(v.decision === 'reject' && v.demand === unhappyDemand,
  'morale 34: even an AT-demand offer is rejected (anything under demand × 1.2 reads as a lowball)');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 34, Math.ceil(unhappyDemand * 1.2), 3).decision === 'accept',
  'morale 34: a 20% premium over demand buys him back');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 35, 1, 3).decision === 'counter',
  'morale 35 is NOT deeply unhappy (strict < 35): a lowball draws a counter, not a walkout');
// Length clamps (1..5, NaN-safe → the default 3).
assert(contracts.evaluateRenewalOffer(a70, 25, null, 65, fair70, 9).counterYears === 5, 'offered length clamps at 5 years');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 65, fair70, 0).counterYears === 1, 'offered length floors at 1 year');
assert(contracts.evaluateRenewalOffer(a70, 25, null, 65, fair70 - 1, NaN).counterYears === 3, 'NaN length falls back to the 3-year default');

// ── 3. previewRenewal + renewContract (the instant path tickContracts uses) ───────────────────
// Ledger 5.2: "`PUT /api/player/:slot/renew` recomputes the wage and commits a new deal
// (budget-gated)." §1.14: "the renewed wage can DROP for an ageing player or jump for a developed
// one — the manager should see it before clicking Renew."
// DISCREPANCY: the instant PUT endpoint is GONE from index.ts — replaced by the §2.2 negotiation
// (POST /api/player/:slot/renew-offer + /api/contract-offer/:id/match|withdraw, and GET
// /api/player/:slot/renew-preview). renewContract survives as the internal engine (tickContracts,
// asserted directly here); the recompute + budget gate it describes still hold.
const L1 = mkLeague('Contracts League 1');
const T_renew = mkTeam(L1, 'Renewal FC', null, 0, 1_000_000_000);
const r1Id = mkPlayer(T_renew, { slot: 0, name: 'Gate Case', ovr: 60, wage: 100_000, cy: 2 });
const r2Id = mkPlayer(T_renew, { slot: 1, name: 'Faded Vet', ovr: 70, age: 34, wage: game.playerWage(flat(70), 26, null), cy: 2 });
const r3Id = mkPlayer(T_renew, { slot: 2, name: 'Grown Kid', ovr: 70, age: 20, wage: game.playerWage(flat(55), 18, null), cy: 2 });
const r4Id = mkPlayer(T_renew, { slot: 3, name: 'Null Wage', ovr: 60, wage: null, cy: 2, potential: 88 });

let pv = contracts.previewRenewal(T_renew, 99);
assert(!pv.ok && pv.error === 'player not found', 'preview: unknown slot refused');
pv = contracts.previewRenewal(T_renew, 1);
const vetNew = game.playerWage(flat(70), 34, null);
assert(pv.ok && pv.currentWage === game.playerWage(flat(70), 26, null) && pv.newWage === vetNew,
  'preview recomputes the wage from CURRENT attrs/age via the same playerWage the value model uses');
assert(pv.delta === vetNew - (pv.currentWage ?? 0) && (pv.delta ?? 0) < 0,
  'the renewed wage DROPS for an ageing player (§1.14) — surfaced as a negative delta');
assert(pv.affordable === true && pv.years === 3, 'preview carries affordability + the default 3-year term');
pv = contracts.previewRenewal(T_renew, 2);
assert(pv.ok && (pv.delta ?? 0) > 0 && pv.newWage === game.playerWage(flat(70), 20, null),
  'and JUMPS for a developed youngster (§1.14)');
assert(pSnap(r3Id).wage === game.playerWage(flat(55), 18, null),
  'the youngster still EARNS his old deal until a renewal commits');
assert(contracts.previewRenewal(T_renew, 1, 10).years === 5, 'preview clamps the term like the commit will');
setWageBudget(T_renew, 0);
assert(contracts.previewRenewal(T_renew, 1).affordable === false, 'preview flags an unaffordable renewal');
assert(pSnap(r2Id).wage === game.playerWage(flat(70), 26, null) && pSnap(r2Id).contract_years === 2,
  'preview commits NOTHING — the row is untouched');

// renewContract: "gated by the wage budget" — bill − oldWage + newWage must fit, at exactly <=.
let rr = contracts.renewContract(T_renew, 99);
assert(!rr.ok && rr.error === 'player not found', 'renew: unknown slot refused');
const gateNew = game.playerWage(flat(60), 24, null);
setWageBudget(T_renew, wageBill(T_renew) - 100_000 + gateNew - 1);
rr = contracts.renewContract(T_renew, 0);
assert(!rr.ok && rr.error === 'not enough wage budget to renew', 'one pound over budget: the renewal is refused');
assert(pSnap(r1Id).wage === 100_000 && pSnap(r1Id).contract_years === 2, 'a refused renewal mutates nothing');
setWageBudget(T_renew, wageBill(T_renew) - 100_000 + gateNew);
rr = contracts.renewContract(T_renew, 0);
assert(rr.ok && rr.wage === gateNew && rr.years === 3, 'exactly at budget the deal commits (gate is >, not >=) at the default 3 years');
assert(pSnap(r1Id).wage === gateNew && pSnap(r1Id).contract_years === 3, 'the recomputed wage + fresh term are persisted');
assert(contracts.renewContract(T_renew, 0, 9).years === 5 && pSnap(r1Id).contract_years === 5, 'term clamps at 5');
assert(contracts.renewContract(T_renew, 0, 0).years === 1, 'term floors at 1');
assert(contracts.renewContract(T_renew, 0, NaN).years === 3, 'NaN term falls back to 3 (NaN-safe)');
// "a forced one … is honoured even if it strains the budget, because the club must field a team."
setWageBudget(T_renew, 0);
assert(contracts.renewContract(T_renew, 0, 4, true).ok === true && pSnap(r1Id).contract_years === 4,
  'force=true renews straight through a zero wage budget');
rr = contracts.renewContract(T_renew, 0, 4, false);
assert(!rr.ok, 'the same renewal without force is refused — the gate only yields to force');
setWageBudget(T_renew, 1_000_000_000);

// ── 4. releasePlayerToFreeAgents — the free-agency handoff ────────────────────────────────────
// Ledger 5.2: expiring players "are released to the pool"; market.ts: "Release one player onto the
// free-agent pool (contract expiry). Snapshots them into free_agents (attrs/age/potential/
// personality/value/wage) then removes them from the squad."
assert(market.releasePlayerToFreeAgents(T_renew, 99) === false, 'release: unknown slot refused');
assert(market.releasePlayerToFreeAgents(999_999, 0) === false, 'release: unknown team refused');
assert(market.releasePlayerToFreeAgents(T_renew, 3) === true, 'the null-wage man is released');
interface FaRow { id: number; league_id: number; name: string; role: string; attrs: string; age: number; potential: number | null; value: number; wage: number | null; }
const faNull = one<FaRow>("SELECT id, league_id, name, role, attrs, age, potential, value, wage FROM free_agents WHERE name = 'Null Wage'");
assert(faNull.league_id === L1 && faNull.role === 'CM' && faNull.age === 24 && faNull.potential === 88,
  "the snapshot lands in HIS league's pool with role/age/potential carried");
assert(JSON.stringify(JSON.parse(faNull.attrs)) === JSON.stringify(flat(60)), 'attrs ride the handoff byte-for-byte');
assert(faNull.value === game.playerValue(flat(60), 24, null), 'pool value = the live playerValue formula, snapshotted');
assert(faNull.wage === game.playerWage(flat(60), 24, null), 'a NULL stored wage is recomputed for the pool (wage ?? playerWage fallback)');
assert(squadCount(T_renew) === 3 && one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE id = ?', r4Id).n === 0,
  'the released man is gone from the squad');

// ── 5. proposeRenewal → the matchday tick — the §2.2 negotiation lifecycle ────────────────────
// contracts.ts: "A voluntary renewal is a NEGOTIATION, not an instant click: the manager proposes
// a wage + length, the player (agent) considers it for a matchday, then accepts / counters /
// rejects." OFFER_EXPIRY = 3: "matchdays a contract offer / counter stays live before it lapses"
// — the expiry countdown.
const H1 = mkTeam(L1, 'Negotiate United', null, 0, 100_000_000);
const baseWage = game.playerWage(flat(60), 24, null);
const names = ['S0', 'S1', 'S2', 'S3', 'S4', 'Left Man', 'Orphan Man', 'Ctr2 Man', 'Exp Man', 'Wd Man', 'Poor Man', 'Acc Man', 'Ctr Man', 'Rej Man'];
const h1Ids: number[] = [];
for (let s = 0; s < 14; s++) {
  h1Ids.push(mkPlayer(H1, {
    slot: s, name: names[s], ovr: 60, cy: 2,
    morale: names[s] === 'Rej Man' ? 30 : 65,
    personality: ['Ctr Man', 'Ctr2 Man', 'Left Man'].includes(names[s]) ? ego100 : null,
  }));
}
const idOf = (name: string): number => h1Ids[names.indexOf(name)];
const egoDemand = Math.round(game.playerWage(flat(60), 24, { traits: { ego: 100 } }) * 1.15);

let pr = contracts.proposeRenewal(H1, 99, 100_000, 3);
assert(!pr.ok && pr.error === 'player not found', 'propose: unknown slot refused');
assert(contracts.proposeRenewal(H1, 11, 0, 3).error === 'offer a positive wage'
  && contracts.proposeRenewal(H1, 11, -5, 3).error === 'offer a positive wage'
  && contracts.proposeRenewal(H1, 11, NaN, 3).error === 'offer a positive wage',
  'propose: zero / negative / NaN wages all refused');
pr = contracts.proposeRenewal(H1, 11, baseWage - 100_000, 3);
assert(pr.ok === true && pr.offers?.[0]?.status === 'pending' && pr.offers[0].playerSlot === 11,
  'a proposal opens a pending negotiation (and returns the offers view)');
let o = offerFor(idOf('Acc Man'));
assert(o.created_round === 0 && o.expires_round === 3,
  'the offer is stamped with the matchday clock: created now, lapses OFFER_EXPIRY=3 matchdays out');
// "supersedes any prior live offer for the same player (one negotiation at a time)".
assert(contracts.proposeRenewal(H1, 11, baseWage, 4).ok === true, 'a re-proposal is accepted');
assert(one<{ n: number }>("SELECT COUNT(*) AS n FROM contract_offers WHERE player_id = ? AND status IN ('pending','countered')", idOf('Acc Man')).n === 1
  && one<{ n: number }>("SELECT COUNT(*) AS n FROM contract_offers WHERE player_id = ? AND status = 'withdrawn'", idOf('Acc Man')).n === 1,
  'the prior live offer is withdrawn — one negotiation at a time');
// Figure hygiene: wage rounded, term clamped, NaN term defaulted.
contracts.proposeRenewal(H1, 9, 123_456.7, 9);
o = offerFor(idOf('Wd Man'));
assert(o.wage === 123_457 && o.years === 5, 'the proposed wage is rounded and the term clamped at 5');
contracts.proposeRenewal(H1, 9, 100_000, NaN);
o = offerFor(idOf('Wd Man'));
assert(o.years === 3 && one<{ status: string }>('SELECT status FROM contract_offers WHERE id = ?', o.id - 1).status === 'withdrawn',
  'NaN term defaults to 3; the re-proposal superseded the clamped one');
// withdrawContractOffer: "Pull a live (pending/countered) renewal offer off the table."
assert(contracts.withdrawContractOffer(H1, o.id).ok === true && offerFor(idOf('Wd Man')).status === 'withdrawn',
  'a live offer withdraws cleanly');
assert(contracts.withdrawContractOffer(H1, o.id).error === 'offer not found or already resolved'
  && contracts.withdrawContractOffer(H1, 999_999).error === 'offer not found or already resolved',
  'a resolved or unknown offer cannot be withdrawn');

// "the agent considers it for a matchday before replying" — a same-round tick resolves nothing.
assert(contracts.processContractOffers(L1).length === 0 && offerFor(idOf('Acc Man')).status === 'pending',
  'no resolution on the round the offer was tabled');

// Table the four verdict scenarios, then play a matchday.
contracts.proposeRenewal(H1, 12, baseWage, 2);            // Ctr Man: ego demand > his fair wage → counter
contracts.proposeRenewal(H1, 13, 1, 3);                   // Rej Man: morale 30 + lowball → walkout
contracts.proposeRenewal(H1, 10, 200_000_000, 3);         // Poor Man: meets demand but blows the wage budget
assert(contracts.evaluateRenewalOffer(flat(60), 24, null, 65, 200_000_000, 3).decision === 'accept',
  "Poor Man's verdict IS accept — so the rejection below can only be the budget gate");
setRound(L1, 1, H1);
const evs1 = contracts.processContractOffers(L1);
assert(evs1.length === 4, 'every live offer resolves at the matchday tick');
const acc = evs1.find(e => e.player === 'Acc Man');
assert(acc?.result === 'accepted' && acc.wage === baseWage && acc.years === 4,
  'an at-demand offer is accepted at the OFFERED terms');
assert(pSnap(idOf('Acc Man')).wage === baseWage && pSnap(idOf('Acc Man')).contract_years === 4
  && offerFor(idOf('Acc Man')).status === 'accepted',
  'the accepted deal commits: negotiated wage + length on the player, offer settled');
const ctr = evs1.find(e => e.player === 'Ctr Man');
assert(ctr?.result === 'countered' && ctr.counterWage === egoDemand && ctr.counterYears === 2,
  'an under-demand offer draws a counter at HIS demand (ego-lifted), keeping the offered length');
o = offerFor(idOf('Ctr Man'));
assert(o.status === 'countered' && o.counter_wage === egoDemand && o.counter_years === 2, 'the counter is persisted on the offer');
assert(pSnap(idOf('Ctr Man')).wage === baseWage && pSnap(idOf('Ctr Man')).contract_years === 2,
  'a counter commits nothing — his old deal stands until matched');
assert(evs1.find(e => e.player === 'Rej Man')?.result === 'rejected' && offerFor(idOf('Rej Man')).status === 'rejected',
  'the deeply unhappy man rejects the lowball outright');
// "agreed, but the wage budget can't bear it" — the accept path re-checks the bill in commitRenewal.
assert(evs1.find(e => e.player === 'Poor Man')?.result === 'rejected' && offerFor(idOf('Poor Man')).status === 'rejected',
  'an agreed deal the budget cannot bear lands as rejected — voluntary renewals never overdraw wages');
assert(pSnap(idOf('Poor Man')).wage === baseWage && pSnap(idOf('Poor Man')).contract_years === 2, 'and commits nothing');

// ── 6. matchContractCounter — strike the deal at HIS terms (budget permitting) ────────────────
const ctrId = offerFor(idOf('Ctr Man')).id;
assert(contracts.matchContractCounter(H1, 999_999).error === 'no counter to match', 'unknown offer: no counter to match');
assert(contracts.matchContractCounter(H1, offerFor(idOf('Acc Man')).id).error === 'no counter to match',
  'an accepted offer is not matchable');
setWageBudget(H1, 1);
const mc0 = contracts.matchContractCounter(H1, ctrId);
assert(!mc0.ok && mc0.error === 'not enough wage budget to match the counter — sell or release first'
  && offerFor(idOf('Ctr Man')).status === 'countered',
  'matching is wage-budget gated; a refused match leaves the counter live');
setWageBudget(H1, 100_000_000);
const mc = contracts.matchContractCounter(H1, ctrId);
assert(mc.ok === true && mc.player === 'Ctr Man' && mc.wage === egoDemand && mc.years === 2,
  "matching strikes the renewal at the player's counter terms");
assert(pSnap(idOf('Ctr Man')).wage === egoDemand && pSnap(idOf('Ctr Man')).contract_years === 2,
  'the matched deal is on the player');
o = offerFor(idOf('Ctr Man'));
assert(o.status === 'accepted' && o.wage === egoDemand && o.years === 2, 'the offer row records the struck terms');
assert(contracts.matchContractCounter(H1, ctrId).error === 'no counter to match', 'a settled counter cannot be matched twice');

// contractOffersForTeam: "live + recently-resolved, newest first" — withdrawn/expired excluded.
const view = contracts.contractOffersForTeam(H1);
assert(view.length > 0 && view.every(x => ['pending', 'countered', 'accepted', 'rejected'].includes(x.status)),
  'the UI view carries live + resolved negotiations only (no withdrawn/expired)');
assert(view.every((x, i) => i === 0 || view[i - 1].id > x.id), 'newest first');
const viewCtr = view.find(x => x.playerName === 'Ctr Man');
assert(viewCtr?.wage === egoDemand && viewCtr.counterWage === egoDemand && viewCtr.playerSlot === 12,
  'the matched negotiation shows the struck wage + the counter that produced it');

// ── 7. The expiry countdown — pending and countered offers both lapse ─────────────────────────
// "a countered offer the manager never matches lapses at its expiry"; OFFER_EXPIRY = 3.
contracts.proposeRenewal(H1, 8, baseWage, 3);             // Exp Man: created 1, expires 4 — never ticked in time
o = offerFor(idOf('Exp Man'));
assert(o.created_round === 1 && o.expires_round === 4, 'the countdown restamps from the CURRENT round');
setRound(L1, 5, H1);
const evs5 = contracts.processContractOffers(L1);
assert(evs5.length === 1 && evs5[0].player === 'Exp Man' && evs5[0].result === 'expired',
  'a pending offer past its expiry lapses loudly (an expired event)');
assert(offerFor(idOf('Exp Man')).status === 'expired'
  && pSnap(idOf('Exp Man')).wage === baseWage && pSnap(idOf('Exp Man')).contract_years === 2,
  'a lapsed offer commits nothing');
contracts.proposeRenewal(H1, 7, baseWage, 3);             // Ctr2 Man (ego): created 5, expires 8
setRound(L1, 6, H1);
assert(contracts.processContractOffers(L1).some(e => e.player === 'Ctr2 Man' && e.result === 'countered'),
  'the ego man counters again');
setRound(L1, 8, H1);
assert(contracts.processContractOffers(L1).length === 0 && offerFor(idOf('Ctr2 Man')).status === 'countered',
  'ON its expiry round the counter is still live (matchable to the deadline — sweep is strict <)');
setRound(L1, 9, H1);
assert(contracts.processContractOffers(L1).length === 0 && offerFor(idOf('Ctr2 Man')).status === 'expired',
  'past the deadline the unmatched counter lapses — silently (no event; unlike a pending lapse)');
assert(contracts.matchContractCounter(H1, offerFor(idOf('Ctr2 Man')).id).error === 'no counter to match',
  'a lapsed counter is no longer matchable');

// ── 8. Departed players mid-negotiation — the orphan reap + the honest error ──────────────────
// "a player with a live offer may have been sold/released this tick (his row is gone) … Lapse
// those"; matchContractCounter: "give a true reason, not a budget red herring".
contracts.proposeRenewal(H1, 6, baseWage, 3);             // Orphan Man
contracts.proposeRenewal(H1, 5, baseWage, 3);             // Left Man (ego → will counter)
db.prepare('DELETE FROM players WHERE id = ?').run(idOf('Orphan Man'));
setRound(L1, 10, H1);
const evs10 = contracts.processContractOffers(L1);
assert(evs10.length === 1 && evs10[0].player === 'Left Man' && evs10[0].result === 'countered',
  'the survivor still negotiates; the orphan produces no event');
assert(offerFor(idOf('Orphan Man')).status === 'expired',
  'an offer whose player has gone is reaped as expired — even mid-countdown (expiry 13 > round 10)');
const leftCtr = offerFor(idOf('Left Man'));
db.prepare('DELETE FROM players WHERE id = ?').run(idOf('Left Man'));
const mcLeft = contracts.matchContractCounter(H1, leftCtr.id);
assert(!mcLeft.ok && mcLeft.error === 'that player has left the club',
  'matching a departed man gives the true reason, not a budget red herring');
assert(offerFor(idOf('Left Man')).status === 'expired', 'and the stale counter is expired on the spot');

// ── 9. tickContracts — season-end resolution for a division ───────────────────────────────────
// Ledger 5.2: "At season rollover tickContracts (in contracts.ts) ticks every deal down: AI clubs
// force-renew (stable world); a human's expiring players are released to the pool worst-first but
// never below a legal XI (the rest are force-renewed)."
const L2 = mkLeague('Contracts League 2');
db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('contracts_tester', 'x', 'x', 0)").run();
const userId = one<{ id: number }>("SELECT id FROM users WHERE username = 'contracts_tester'").id;
const H2 = mkTeam(L2, 'Human Athletic', userId, 0, 0);        // zero wage budget: the floor renewals must FORCE through
const A2 = mkTeam(L2, 'AI Rovers', null, 0, 0);
let e4Id = 0;
for (let s = 0; s < 11; s++) {
  const id = s === 2 ? mkPlayer(H2, { slot: 2, name: 'Keep Mid', ovr: 70, cy: 1, wage: 300_000 })
    : s === 5 ? mkPlayer(H2, { slot: 5, name: 'Keep Star', ovr: 80, cy: 1, wage: 400_000 })
      : mkPlayer(H2, { slot: s, name: `H2 S${s}`, ovr: 65, cy: 3 });
  if (s === 2) e4Id = id;
}
mkPlayer(H2, { slot: 11, name: 'Rel A', ovr: 40, cy: 1, wage: 125_000, potential: 77 });
mkPlayer(H2, { slot: 12, name: 'Rel B', ovr: 44, cy: 1, wage: 150_000 });
mkPlayer(H2, { slot: 13, name: 'Rel C', ovr: 48, cy: 1, wage: 175_000 });
for (let s = 0; s < 12; s++) {
  mkPlayer(A2, { slot: s, name: `A2 P${s}`, ovr: 55, cy: s === 4 || s === 11 ? 1 : 3, wage: s === 4 || s === 11 ? 25_000 : undefined });
}
// §2.2: "lapse any live renewal negotiation at season's end" — pending + countered die, settled stay.
const insOffer = db.prepare(
  "INSERT INTO contract_offers (team_id, player_id, wage, years, status, counter_wage, counter_years, created_round, expires_round, created_at) VALUES (?, ?, 300000, 3, ?, NULL, NULL, 0, 3, 0)");
const oPend = Number(insOffer.run(H2, e4Id, 'pending').lastInsertRowid);
const oCtr = Number(insOffer.run(H2, e4Id, 'countered').lastInsertRowid);
const oAcc = Number(insOffer.run(H2, e4Id, 'accepted').lastInsertRowid);
const l1Years = one<{ s: number }>('SELECT SUM(contract_years) AS s FROM players WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)', L1).s;

const tickEvs = contracts.tickContracts(L2);
const status = (id: number): string => one<{ status: string }>('SELECT status FROM contract_offers WHERE id = ?', id).status;
assert(status(oPend) === 'expired' && status(oCtr) === 'expired' && status(oAcc) === 'accepted',
  "season's end lapses live negotiations (stale round-numbers) but never rewrites settled ones");
const h2Evs = tickEvs.filter(e => e.teamId === H2);
const a2Evs = tickEvs.filter(e => e.teamId === A2);
assert(tickEvs.length === 7 && h2Evs.length === 5 && a2Evs.length === 2, 'exactly the expiring men produce events');
// Human: "released to the pool worst-first but never below a legal XI (the rest are force-renewed)".
assert(h2Evs.filter(e => e.type === 'released').map(e => e.player).join(',') === 'Rel A,Rel B,Rel C',
  'releases run worst-first (ovr 40, 44, 48) and stop at the floor');
assert(market.SQUAD_MIN === 11 && squadCount(H2) === market.SQUAD_MIN,
  'the human squad is held at exactly the legal-XI floor');
assert(all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', H2).every((row, i) => row.slot === i),
  'the squad renumbers contiguously 0..10 after the releases');
assert(new Set(h2Evs.filter(e => e.type === 'renewed').map(e => e.player)).size === 2
  && h2Evs.some(e => e.type === 'renewed' && e.player === 'Keep Mid')
  && h2Evs.some(e => e.type === 'renewed' && e.player === 'Keep Star'),
  'the expiring men kept for the floor are renewed, not released');
const keepMid = one<PSnap>("SELECT wage, contract_years FROM players WHERE team_id = ? AND name = 'Keep Mid'", H2);
assert(keepMid.contract_years === 1 && keepMid.wage === game.playerWage(flat(70), 24, null),
  'a floor-hold renewal is a 1-year extension at the recomputed wage — forced through the zero budget');
assert(one<{ n: number }>("SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND name = 'H2 S0' AND contract_years = 2", H2).n === 1,
  'every non-expiring deal ticked down (3 → 2)');
// AI: "keep its squad together — force-renew every expiring player (… an AI never lets a player walk)".
assert(a2Evs.every(e => e.type === 'renewed') && new Set(a2Evs.map(e => e.player)).size === 2,
  'both expiring AI men are renewed; an AI never lets a player walk');
const aiRenewed = all<PSnap>("SELECT wage, contract_years FROM players WHERE team_id = ? AND name IN ('A2 P4', 'A2 P11')", A2);
assert(aiRenewed.length === 2 && aiRenewed.every(p => p.contract_years === 3 && p.wage === game.playerWage(flat(55), 24, null)),
  'AI renewals are fresh 3-year deals at the recomputed wage — through a zero wage budget (forced)');
assert(squadCount(A2) === 12 && one<{ n: number }>('SELECT COUNT(*) AS n FROM free_agents WHERE league_id = ?', L2).n === 3,
  'the AI squad is intact; only the human releases reached the pool');
// Scoping: the other division is untouched.
assert(one<{ s: number }>('SELECT SUM(contract_years) AS s FROM players WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)', L1).s === l1Years
  && offerFor(idOf('Acc Man')).status === 'accepted',
  "ticking one division never touches another's deals or negotiations");
// The handoff snapshot: "the free-agent pool must already be (re)seeded so released players join
// the new window's pool" — value recomputed, the WAGE he was on carried.
const faA = one<FaRow>("SELECT id, league_id, name, role, attrs, age, potential, value, wage FROM free_agents WHERE name = 'Rel A'");
assert(faA.league_id === L2 && faA.value === game.playerValue(flat(40), 24, null) && faA.wage === 125_000
  && faA.potential === 77 && JSON.stringify(JSON.parse(faA.attrs)) === JSON.stringify(flat(40)),
  'the released man joins the pool at his computed value, carrying his wage/attrs/potential');

// ── 10. Market interplay: "Signing is gated by BOTH a fee and wage headroom" ──────────────────
// Ledger 5.2: "(market.ts, AI included)" — the AI's marketTick signs through this same
// buyFreeAgent, so the gates asserted here bind both paths. Closing the loop: the man contracts
// released is re-signable from the pool.
db.prepare('UPDATE teams SET budget = ?, wage_budget = ? WHERE id = ?').run(faA.value - 1, 1_000_000_000, H2);
let buy = market.buyFreeAgent(H2, faA.id);
assert(!buy.ok && buy.error === 'not enough budget', 'gate 1: one pound short on the FEE blocks the signing');
assert(squadCount(H2) === 11 && one<{ n: number }>('SELECT COUNT(*) AS n FROM free_agents WHERE id = ?', faA.id).n === 1,
  'a refused signing touches nothing');
db.prepare('UPDATE teams SET budget = ?, wage_budget = ? WHERE id = ?').run(faA.value, wageBill(H2) + 125_000 - 1, H2);
buy = market.buyFreeAgent(H2, faA.id);
assert(!buy.ok && buy.error === 'not enough wage budget', 'gate 2: the fee covered, one pound short of wage HEADROOM still blocks');
db.prepare('UPDATE teams SET wage_budget = ? WHERE id = ?').run(wageBill(H2) + 125_000, H2);
buy = market.buyFreeAgent(H2, faA.id);
assert(buy.ok === true && buy.value === faA.value && buy.placed === 'bench', 'both gates cleared: the released man re-signs');
const backRow = one<{ slot: number; wage: number; contract_years: number }>(
  "SELECT slot, wage, contract_years FROM players WHERE team_id = ? AND name = 'Rel A'", H2);
assert(backRow.slot === 11 && backRow.wage === 125_000 && backRow.contract_years === 3,
  'he rejoins on the bench at his pool wage, on a fresh 3-year deal');
assert(one<{ budget: number }>('SELECT budget FROM teams WHERE id = ?', H2).budget === 0
  && one<{ n: number }>('SELECT COUNT(*) AS n FROM free_agents WHERE id = ?', faA.id).n === 0,
  'the fee is debited exactly and he leaves the pool — contracts → market → contracts, closed loop');

console.log(`_contracts_test: ${assertions} assertions passed`);

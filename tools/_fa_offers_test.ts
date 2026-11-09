// §2.1 free-agent contract offers (consider delay). Throwaway FOOTY_DB; no engine. Asserts: offering a
// free agent terms tables a PENDING offer (no instant signing); the agent answers at the next matchday —
// accepting a fair wage (signs at the offered terms, leaves the pool, pays the fee) or turning down a
// lowball; window-gated; one live offer per agent; and an ignored offer lapses.
//
//   npx tsx tools/_fa_offers_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-fa-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('scout', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Bargains FC', game.DEFAULT_TACTICS);
const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
db.prepare('UPDATE teams SET budget = 500000000, wage_budget = 500000000 WHERE id = ?').run(teamId);   // deep pockets
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(teamId);   // room to sign

const squadSize = () => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(teamId) as { n: number }).n;
const budgetOf = () => (db.prepare('SELECT budget AS b FROM teams WHERE id = ?').get(teamId) as { b: number }).b;
const faExists = (id: number) => !!db.prepare('SELECT 1 FROM free_agents WHERE id = ?').get(id);
const squadHas = (name: string) => !!db.prepare('SELECT 1 FROM players WHERE team_id = ? AND name = ?').get(teamId, name);
const freeAgent = (skip: number[] = []) => market.getMarket(teamId)!.freeAgents.find(a => a.wage >= 2 && !skip.includes(a.id))!;

// ── an offer tables a pending negotiation — NOT an instant signing ────────────────────────────
const fa = freeAgent();
check(market.transferWindow(leagueId).open, 'window open (precondition)');
const r = market.offerToFreeAgent(teamId, fa.id, fa.wage, 3);
check(r.ok && r.player === fa.name, 'offerToFreeAgent tables an offer');
check(!squadHas(fa.name), 'the agent is NOT signed instantly — he is considering it');
check(faExists(fa.id), 'the agent is still in the pool while he considers');
const pending = market.freeAgentOffersForTeam(teamId);
check(pending.length === 1 && pending[0].agentId === fa.id && pending[0].wage === fa.wage && pending[0].years === 3, 'the offer shows in the negotiations list with its terms');
check(market.offerToFreeAgent(teamId, 999999, fa.wage, 3).ok === false, 'cannot offer a non-existent agent');

// ── a fair offer (>= his demand) is accepted at the next matchday ─────────────────────────────
const sq0 = squadSize(), bud0 = budgetOf();
const ev = market.resolveFreeAgentOffers(leagueId).filter(e => e.teamId === teamId);
check(ev.some(e => e.type === 'fa_signed' && e.player === fa.name), 'a fair offer is accepted at the matchday');
check(squadHas(fa.name) && !faExists(fa.id), 'the agent joins the squad and leaves the pool');
check(squadSize() === sq0 + 1 && budgetOf() === bud0 - fa.value, 'squad +1 and the signing-on fee is paid');
const signed = db.prepare('SELECT wage, contract_years FROM players WHERE team_id = ? AND name = ?').get(teamId, fa.name) as { wage: number; contract_years: number };
check(signed.wage === fa.wage && signed.contract_years === 3, 'he signs on the OFFERED wage + length');
check(market.freeAgentOffersForTeam(teamId).length === 0, 'no pending offers remain after acceptance');

// ── a lowball offer (< his demand) is turned down; he stays a free agent ──────────────────────
const fa2 = freeAgent();
market.offerToFreeAgent(teamId, fa2.id, fa2.wage - 1, 2);
const ev2 = market.resolveFreeAgentOffers(leagueId).filter(e => e.teamId === teamId);
check(ev2.some(e => e.type === 'fa_rejected' && e.player === fa2.name), 'a lowball offer is turned down');
check(!squadHas(fa2.name) && faExists(fa2.id), 'the rejected agent stays a free agent');

// ── budget guards at offer time ───────────────────────────────────────────────────────────────
const fa3 = freeAgent();
db.prepare('UPDATE teams SET wage_budget = 1 WHERE id = ?').run(teamId);
check(market.offerToFreeAgent(teamId, fa3.id, fa3.wage, 3).ok === false, 'an offer over the wage budget is refused');
db.prepare('UPDATE teams SET wage_budget = 500000000 WHERE id = ?').run(teamId);

// ── one live offer per agent: a new offer supersedes the prior pending one ─────────────────────
const fa4 = freeAgent();
market.offerToFreeAgent(teamId, fa4.id, fa4.wage, 3);
market.offerToFreeAgent(teamId, fa4.id, fa4.wage + 1000, 4);
const ofs = market.freeAgentOffersForTeam(teamId).filter(o => o.agentId === fa4.id);
check(ofs.length === 1 && ofs[0].years === 4, 'a new offer supersedes the prior pending one');

// ── poach race: a rival signs the agent before he answers → the manager is TOLD (fa_gone), not silence ──
const fa7 = freeAgent([fa4.id]);
market.offerToFreeAgent(teamId, fa7.id, fa7.wage, 3);
db.prepare('DELETE FROM free_agents WHERE id = ?').run(fa7.id);   // simulate an AI club signing him first (marketTick runs before the resolver)
const evPoach = market.resolveFreeAgentOffers(leagueId).filter(e => e.teamId === teamId);
check(evPoach.some(e => e.type === 'fa_gone' && e.player === fa7.name), 'losing the race to a rival emits an fa_gone event (no silent disappearance)');
check((db.prepare('SELECT status FROM free_agent_offers WHERE buyer_team_id = ? AND free_agent_id = ?').get(teamId, fa7.id) as { status: string }).status === 'rejected', 'the lost offer is closed out');
check(!squadHas(fa7.name), 'the poached agent did NOT also land in your squad (no phantom double-sign)');

// ── an ignored offer lapses past its window ────────────────────────────────────────────────────
const fa5 = freeAgent([fa4.id]);
market.offerToFreeAgent(teamId, fa5.id, fa5.wage, 3);
const total = (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
const closedRound = Math.max(2, Math.floor(total / 2)) + 2;   // a round in the closed mid-season gap, well past the offer's expiry
db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ? AND round <= ?').run(leagueId, closedRound);
market.resolveFreeAgentOffers(leagueId);
check((db.prepare('SELECT status FROM free_agent_offers WHERE buyer_team_id = ? AND free_agent_id = ?').get(teamId, fa5.id) as { status: string }).status === 'expired', 'an ignored offer lapses past its window');
check(faExists(fa5.id), 'the un-signed agent stays in the pool');

// ── free agents are signable ANY TIME — no transfer-window gate (matches buyFreeAgent + the AI path) ──
check(!market.transferWindow(leagueId).open, 'window now shut (fixtures played)');
const fa6 = freeAgent([fa4.id, fa5.id]);
check(market.offerToFreeAgent(teamId, fa6.id, fa6.wage, 3).ok === true, 'a free agent can be offered terms even when the transfer window is shut');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// tools/_market_test.ts — engine-free verification of web/backend/market.ts: the pillar-1
// transfer market (seeding, value curve, buy/list/sell, money conservation, squad caps), the
// later windows + club-to-club negotiation (§2.1 pending offers / auctions / release clauses /
// incoming bids), §2.4 deadline listings, and the contracts interplay (a signing is gated by
// BOTH a fee and wage headroom; wage + remaining deal ride every move).
//
// Recreated 2026-08-05: the original lived only in a session scratch dir (GAME_LAYER_NOTES.md
// ledger: "46 assertions", later "(53)") and was never committed. SPEC = GAME_LAYER_NOTES.md —
// each covered ledger claim is quoted above its assertion group. Where the ledger and the code
// disagree, the CURRENT code behaviour is asserted and the drift is flagged `// DISCREPANCY:`.
//
//   npx tsx tools/_market_test.ts
//
// The test builds its own throwaway sqlite world under the OS temp dir (override the directory
// with FOOTY_MARKET_TEST_DIR); it deliberately IGNORES an inherited FOOTY_DB so it can never
// run against a real save, and it never touches web/backend/data/. Exits non-zero on failure.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// db.ts resolves FOOTY_DB at import time, so it MUST be set before ANY backend module loads —
// hence every backend import below this block is dynamic. Unique file per run (pid), pre-wiped.
const dbDir = process.env.FOOTY_MARKET_TEST_DIR ?? path.join(os.tmpdir(), 'footy-testdb');
mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, `market-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
process.env.FOOTY_DB = dbPath;

// World generation draws on Math.random; pin it (mulberry32) so every run builds the identical
// world. Assertions still target INVARIANTS (bounds, conservation, exact formulae) — the seed
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
const formations = await import('../web/backend/formations.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(`_market_test FAILED: ${message}`); }
  assertions += 1;
}
const near = (x: number, y: number, tol: number): boolean => Math.abs(x - y) <= tol;
const flat = (v: number): Record<string, number> =>
  ({ speed: v, passing: v, creativity: v, shooting: v, tackling: v, positioning: v, stamina: v });
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function one<T>(sql: string, ...args: (string | number)[]): T {
  return db.prepare(sql).get(...args) as T;
}
function all<T>(sql: string, ...args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}

// ── 1. Value / wage curve (pure functions — no DB) ─────────────────────────────────────────────
// Ledger: "Economy scale (now PL/Championship-based, 2026-06-16): value = ((ovr−30)/65)^4 × 130M
// × age × personality (95-rated ≈ £130M, 85 ≈ £67M, 70 ≈ £19M, 50 ≈ £1.2M); wage ≈ 10% of the
// ego-neutral value + ego premium."
// DISCREPANCY: two older ledger lines still describe superseded curves — pillar-1's
// "(overall/100)^3 * 60M … rounded to the nearest 100k" and the taste footer's
// "(ovr/100)^3 × 55M". The code implements the 2026-06-16 curve, rounded to 50k (not 100k).
assert(game.overall(flat(80)) === 80, 'overall = mean of the 7 skill attrs');
assert(game.overall({ ...flat(80), height: 30 }) === 80, 'height never counts toward overall');
assert(game.overall({ ...flat(60), handling: 92 }, 'GK') === 64, "a keeper's handling counts for him");
assert(game.overall({ ...flat(60), handling: 92 }, 'CF') === 60, 'handling ignored for outfielders');

const v = (ovr: number, age: number, personality: unknown = null): number => game.playerValue(flat(ovr), age, personality);
assert(v(95, 25) === 130_000_000, '95-rated prime star = exactly £130M');
assert(near(v(85, 25), 67_000_000, 1_500_000), '85-rated ≈ £67M');
assert(near(v(70, 25), 19_000_000, 1_000_000), '70-rated ≈ £19M');
assert(near(v(50, 25), 1_200_000, 200_000), '50-rated squad filler ≈ £1.2M');
assert(v(85, 25) - v(70, 25) > v(70, 25) - v(55, 25), 'curve is convex in overall');
assert(v(30, 25) === 25_000, 'value floors at £25k');
assert(v(85, 25) % 50_000 === 0, 'value rounds to £50k steps (ledger "nearest 100k" is stale)');

// Pillar-1 design: "age multiplier: peak ~24–26 (×1.0), young prospects discounted slightly …
// 30+ falls off steeply (×0.5 by 33)".
assert(v(80, 24) === v(80, 25) && v(80, 25) === v(80, 26), 'value peaks flat across 24–26');
assert(near(v(80, 18) / v(80, 25), 0.80, 0.02), 'an 18-y/o is discounted to ~×0.80');
assert(near(v(80, 33) / v(80, 25), 0.52, 0.02), 'by 33 value has roughly halved');
assert(v(80, 31) > v(80, 33) && v(80, 33) > v(80, 35), 'value falls monotonically past 30');
assert(near(v(80, 40) / v(80, 25), 0.28, 0.01), 'age multiplier floors at ×0.28');

// Pillar-1 design: "personality nudge: high professionalism+consistency+bigGame up to +15%,
// high ego down to −8%".
const pros = { traits: { professionalism: 100, consistency: 100, bigGame: 100, ego: 50 } };
const diva = { traits: { ego: 100 } };
assert(near(v(80, 25, pros) / v(80, 25), 1.15, 0.01), 'model pros command up to +15%');
assert(near(v(80, 25, diva) / v(80, 25), 0.92, 0.01), 'a maxed ego discounts up to −8%');

// Ledger 5.2: wage ≈ 10% of the ego-neutral value (per the economy note; the 5.2 entry's "≈8%"
// is stale — DISCREPANCY), "a diva costs more to PAY even when worth less to BUY".
const w85 = game.playerWage(flat(85), 25, null);
assert(near(w85, v(85, 25) * 0.10, 25_000), 'wage ≈ 10% of ego-neutral value');
assert(near(game.playerWage(flat(85), 25, diva), w85 * 1.25, 50_000), 'a maxed ego demands ~+25% wages');
assert(game.playerWage(flat(30), 25, null) === 25_000, 'wage floors at £25k');
assert(w85 % 25_000 === 0, 'wage rounds to £25k steps');

// ── 2. World seeding ───────────────────────────────────────────────────────────────────────────
// Ledger pillar 1: "a league-scoped free_agents pool", "playerValue (convex-in-overall × age
// curve × personality)" snapshotted on agents. Economy note: "Premier League (tier 1) £80M
// transfer / £140M wages; Championship (tier 2) £18M / £40M".
// DISCREPANCY: pillar-1's "teams.budget (50M)" predates the tier finances and is stale.
db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('market_tester', 'x', 'x', 0)").run();
const userId = one<{ id: number }>("SELECT id FROM users WHERE username = 'market_tester'").id;
const created = game.newSeasonForUser(userId, 'market_tester', 'Test FC', game.DEFAULT_TACTICS);
const { leagueId, teamId, worldId } = created;

const leagues = all<{ id: number; tier: number; market_seeded: number }>(
  'SELECT id, tier, market_seeded FROM leagues WHERE world_id = ? ORDER BY tier', worldId);
assert(leagues.length === 2 && leagues[0].tier === 1 && leagues[1].tier === 2 && leagues[1].id === leagueId,
  'a world = two divisions sharing world_id; the user starts in tier 2');
assert(leagues.every(l => l.market_seeded === 1), 'both free-agent pools flagged seeded');

interface TeamFin { id: number; budget: number; wage_budget: number; user_id: number | null }
const teamsTop = all<TeamFin>('SELECT id, budget, wage_budget, user_id FROM teams WHERE league_id = ?', worldId);
const teamsSecond = all<TeamFin>('SELECT id, budget, wage_budget, user_id FROM teams WHERE league_id = ?', leagueId);
assert(teamsTop.length === game.LEAGUE_SIZE && teamsSecond.length === game.LEAGUE_SIZE, '8 clubs per division');
assert(teamsTop.every(t => t.user_id === null) && teamsSecond.some(t => t.id === teamId && t.user_id === userId),
  'top division all-AI; the user club sits in the second tier');
assert(game.TIER_FINANCE[1].transferBudget === 80_000_000 && game.TIER_FINANCE[1].wageBudget === 140_000_000
  && game.TIER_FINANCE[2].transferBudget === 18_000_000 && game.TIER_FINANCE[2].wageBudget === 40_000_000,
  'tier finances match the ledger economy note');
assert(teamsTop.every(t => t.budget === 80_000_000 && t.wage_budget === 140_000_000), 'tier-1 clubs on PL money');
assert(teamsSecond.every(t => t.budget === 18_000_000 && t.wage_budget === 40_000_000), 'tier-2 clubs on Championship money');

const allTeams = [...teamsTop, ...teamsSecond];
assert(allTeams.every(t => {
  const slots = all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', t.id).map(r => r.slot);
  return slots.length === 17 && slots.every((s, i) => s === i);
}), 'every club seeds 11 starters + 6 bench, slots contiguous 0..16');
// Contracts interplay (ledger 5.2): every player carries a wage + a deal from birth.
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE wage IS NULL OR wage < 25000').n === 0,
  'every seeded player draws at least the wage floor');
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE contract_years < 2 OR contract_years > 4').n === 0,
  'every seeded player holds a 2–4 year deal');

interface FaRow { id: number; role: string; attrs: string; age: number; value: number; wage: number }
const agents = all<FaRow>('SELECT id, role, attrs, age, value, wage FROM free_agents WHERE league_id IN (?, ?)', worldId, leagueId);
assert(agents.length === 2 * game.FREE_AGENT_COUNT, `each division seeds ${game.FREE_AGENT_COUNT} free agents`);
assert(agents.every(f => f.value === game.playerValue(JSON.parse(f.attrs), f.age, null, f.role)),
  'agent value = the live playerValue formula, snapshotted');
assert(agents.every(f => f.wage === game.playerWage(JSON.parse(f.attrs), f.age, null, f.role)),
  'agent wage demand = the live playerWage formula, snapshotted');
assert(one<{ r: number }>('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ?', leagueId).r === 14
  && one<{ n: number }>('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ?', leagueId).n === 56,
  'double round robin of 8: 14 rounds / 56 fixtures');

const teamBudget = (id: number): number => one<{ v: number }>('SELECT budget AS v FROM teams WHERE id = ?', id).v;
const squadCount = (id: number): number => one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', id).n;
const sumBudgets = (): number => one<{ v: number }>('SELECT SUM(budget) AS v FROM teams WHERE league_id IN (?, ?)', worldId, leagueId).v;
const worldPlayers = (): number => one<{ n: number }>(
  'SELECT COUNT(*) AS n FROM players WHERE team_id IN (SELECT id FROM teams WHERE league_id IN (?, ?))', worldId, leagueId).n;
const offerStatus = (id: number): string => one<{ status: string }>('SELECT status FROM transfer_offers WHERE id = ?', id).status;
const playRound = (r: number): void => { db.prepare('UPDATE fixtures SET played = 1 WHERE league_id = ? AND round = ?').run(leagueId, r); };

// ── 3. Transfer window at matchday 1 ───────────────────────────────────────────────────────────
// Ledger: "transferWindow(leagueId) derives a summer (pre-season) + winter (mid-season) window
// from the fixture rounds".
const w0 = market.transferWindow(leagueId);
assert(w0.open && w0.window === 'summer' && w0.current === 1 && w0.total === 14,
  'summer window open before the opening matchday');
assert(w0.deadline === 1 && w0.closesIn === 1 && w0.deadlineDay, 'summer deadline day = matchday 1');

// ── 4. getMarket view ──────────────────────────────────────────────────────────────────────────
// Ledger: "GET /api/market (budget + free agents + my listings + my squad with values)";
// "getMarket now carries the window + transferTargets"; "The market shows the wage bill/budget".
const mv = market.getMarket(teamId)!;
assert(mv.budget === 18_000_000 && mv.wageBudget === 40_000_000, 'market view carries the club finances');
assert(mv.squadMax === market.SQUAD_MAX && mv.squadMin === market.SQUAD_MIN
  && market.SQUAD_MAX === 24 && market.SQUAD_MIN === 11, '24-man cap / 11-man floor');
assert(mv.freeAgents.length === game.FREE_AGENT_COUNT && mv.squad.length === 17, 'pool + squad surfaced');
assert(mv.window.open === true && mv.transferTargets.length === 0,
  'window rides in the view; nothing is for sale before the AI lists');
assert(mv.squad.slice(0, 11).every(p => p.starter) && mv.squad.slice(11).every(p => !p.starter),
  'the first 11 by slot start');
assert(mv.wageBill === one<{ v: number }>('SELECT COALESCE(SUM(wage),0) AS v FROM players WHERE team_id = ?', teamId).v,
  'wage bill = the squad wage sum');
assert(market.getMarket(999999) === null, 'unknown team -> null');

// ── 5. buyFreeAgent: rejections, then a clean signing ──────────────────────────────────────────
// Ledger pillar 1: "buyFreeAgent (auto-upgrade-into-XI or bench)" + "squad caps".
// Ledger 5.2: "Signing is gated by BOTH a fee and wage headroom (market.ts, AI included)."
let r = market.buyFreeAgent(teamId, 9_999_999);
assert(!r.ok && r.error === 'free agent not available', 'unknown agent refused');
const foreignFa = one<{ id: number }>('SELECT id FROM free_agents WHERE league_id = ? ORDER BY id LIMIT 1', worldId);
r = market.buyFreeAgent(teamId, foreignFa.id);
assert(!r.ok && r.error === 'free agent not available', "another division's pool is not this club's market");

const cheapest = one<{ id: number; name: string; value: number; wage: number }>(
  'SELECT id, name, value, wage FROM free_agents WHERE league_id = ? ORDER BY value ASC, id ASC LIMIT 1', leagueId);
db.prepare('UPDATE teams SET budget = 0 WHERE id = ?').run(teamId);
r = market.buyFreeAgent(teamId, cheapest.id);
assert(!r.ok && r.error === 'not enough budget', 'fee gate holds');
assert(squadCount(teamId) === 17 && teamBudget(teamId) === 0, 'a refused buy touches nothing');

const bill = one<{ v: number }>('SELECT COALESCE(SUM(wage),0) AS v FROM players WHERE team_id = ?', teamId).v;
db.prepare('UPDATE teams SET budget = 500000000, wage_budget = ? WHERE id = ?').run(bill, teamId);
r = market.buyFreeAgent(teamId, cheapest.id);
assert(!r.ok && r.error === 'not enough wage budget', 'wage-headroom gate holds even with the fee covered');

db.prepare('UPDATE teams SET wage_budget = 500000000 WHERE id = ?').run(teamId);
let expectBudget = 500_000_000;
const beforeIds = new Set(all<{ id: number }>('SELECT id FROM players WHERE team_id = ?', teamId).map(p => p.id));
r = market.buyFreeAgent(teamId, cheapest.id);
assert(r.ok === true && r.value === cheapest.value && r.name === cheapest.name, 'agent signed at his snapshot value');
expectBudget -= cheapest.value;
assert(teamBudget(teamId) === expectBudget, 'the fee is debited exactly');
assert(squadCount(teamId) === 18, 'squad grew by one');
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM free_agents WHERE league_id = ?', leagueId).n === game.FREE_AGENT_COUNT - 1,
  'the agent left the pool');
const recruit = all<{ id: number; slot: number; wage: number; contract_years: number }>(
  'SELECT id, slot, wage, contract_years FROM players WHERE team_id = ?', teamId).find(p => !beforeIds.has(p.id))!;
assert(recruit.wage === cheapest.wage && recruit.contract_years === 3,
  'the recruit keeps his scouted wage on a fresh 3-year deal (contracts interplay)');
assert((r.placed === 'xi') === (recruit.slot < 11), 'the placed verdict matches where he actually landed');
assert(one<{ n: number }>("SELECT COUNT(*) AS n FROM finance_entries WHERE team_id = ? AND kind = 'transfer_in' AND amount = ?",
  teamId, -cheapest.value).n === 1, 'a human signing lands in the finances ledger');

const insDummy = db.prepare("INSERT INTO players (team_id, slot, name, role, attrs, age) VALUES (?, ?, ?, 'CM', ?, 24)");
for (let i = 0; i < market.SQUAD_MAX - 18; i++) { insDummy.run(teamId, 18 + i, `ZZ Dummy ${i}`, JSON.stringify(flat(40))); }
const nextFa = one<{ id: number }>('SELECT id FROM free_agents WHERE league_id = ? ORDER BY value ASC, id ASC LIMIT 1', leagueId);
r = market.buyFreeAgent(teamId, nextFa.id);
assert(!r.ok && r.error === `squad full (max ${market.SQUAD_MAX})`, 'the 24-man cap blocks a signing');
db.prepare("DELETE FROM players WHERE team_id = ? AND name LIKE 'ZZ Dummy%'").run(teamId);
assert(squadCount(teamId) === 18, 'cap probe cleaned up');

// ── 6. listPlayer / unlistPlayer ───────────────────────────────────────────────────────────────
// Ledger pillar 1: "LIST / UNLIST one of your players at an asking price (default = computed
// value)". §2.4 (code): a listing made while a window is open is stamped with its deadline.
const benchP = one<{ slot: number; attrs: string; age: number; personality: string | null }>(
  'SELECT slot, attrs, age, personality FROM players WHERE team_id = ? AND slot >= 11 ORDER BY slot LIMIT 1', teamId);
const lRes = market.listPlayer(teamId, benchP.slot);
assert(lRes.ok && lRes.askPrice === lRes.value, 'default ask = his computed value');
assert(lRes.value === game.playerValue(JSON.parse(benchP.attrs), benchP.age, parseJSON(benchP.personality)),
  'listing value = playerValue of his live attrs');
const listedRow = one<{ listed: number; ask_price: number; listed_until: number | null }>(
  'SELECT listed, ask_price, listed_until FROM players WHERE team_id = ? AND slot = ?', teamId, benchP.slot);
assert(listedRow.listed === 1 && listedRow.ask_price === lRes.askPrice, 'listing persisted');
assert(listedRow.listed_until === 1, 'a summer listing is stamped with the summer deadline (§2.4)');
const lRes2 = market.listPlayer(teamId, benchP.slot, 12_345_678.4);
assert(lRes2.ok && lRes2.askPrice === 12_345_678, 'an explicit ask price is rounded and kept');
assert(!market.listPlayer(teamId, 99).ok, 'listing an empty slot refused');
market.unlistPlayer(teamId, benchP.slot);
const unRow = one<{ listed: number; ask_price: number | null; listed_until: number | null }>(
  'SELECT listed, ask_price, listed_until FROM players WHERE team_id = ? AND slot = ?', teamId, benchP.slot);
assert(unRow.listed === 0 && unRow.ask_price === null && unRow.listed_until === null, 'unlisting clears everything');

// ── 7. seedReleaseClauses + aiListSurplus + transferTargets ────────────────────────────────────
// §release-clause (code): "give each AI club's BEST player a release clause — a premium over
// his value … Deterministic + idempotent … human clubs untouched."
market.seedReleaseClauses([worldId, leagueId]);
const aiTeamIds = all<{ id: number }>(
  'SELECT id FROM teams WHERE league_id IN (?, ?) AND user_id IS NULL ORDER BY id', worldId, leagueId).map(t => t.id);
assert(aiTeamIds.length === 15, '15 AI clubs across the world');
interface ClauseRow { team_id: number; release_clause: number; attrs: string; age: number; personality: string | null; role: string }
const clauseRows = all<ClauseRow>(
  'SELECT team_id, release_clause, attrs, age, personality, role FROM players WHERE release_clause IS NOT NULL');
assert(clauseRows.length === 15 && new Set(clauseRows.map(c => c.team_id)).size === 15,
  'exactly one release clause per AI club');
assert(!clauseRows.some(c => c.team_id === teamId), 'the human club gets no clause');
assert(clauseRows.every(c => {
  const val = game.playerValue(JSON.parse(c.attrs), c.age, parseJSON(c.personality), c.role);
  return c.release_clause === Math.round(val * 1.7 / 100000) * 100000;
}), 'clause = value × 1.7 premium, rounded to £100k');
assert(clauseRows.every(c => {
  const best = all<{ attrs: string; role: string }>('SELECT attrs, role FROM players WHERE team_id = ?', c.team_id)
    .reduce((m, p) => Math.max(m, game.overall(JSON.parse(p.attrs), p.role)), 0);
  return game.overall(JSON.parse(c.attrs), c.role) === best;
}), "the clause sits on each club's best player");
market.seedReleaseClauses([worldId, leagueId]);
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE release_clause IS NOT NULL').n === 15,
  'seeding again is a no-op (idempotent)');

// §P2 (code): "AI clubs put a surplus squad player on the market … at most ONE player listed;
// its weakest BENCH man … at his value … No money moves here."
const aiLeagueTeamIds = all<{ id: number }>(
  'SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id', leagueId).map(t => t.id);
const sumBefore7 = sumBudgets();
market.aiListSurplus(leagueId);
assert(sumBudgets() === sumBefore7, 'a listing moves no money');
interface ListedRow { id: number; team_id: number; slot: number; ask_price: number; attrs: string; age: number; personality: string | null }
const listedNow = all<ListedRow>(
  `SELECT id, team_id, slot, ask_price, attrs, age, personality FROM players
   WHERE listed = 1 AND team_id IN (SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL)`, leagueId);
assert(listedNow.length === 7 && new Set(listedNow.map(l => l.team_id)).size === 7,
  'each AI club in the division lists exactly one player');
assert(listedNow.every(l => l.slot >= 11), 'only a bench man is listed, never a starter');
assert(listedNow.every(l => l.ask_price === game.playerValue(JSON.parse(l.attrs), l.age, parseJSON(l.personality))),
  'each listing asks exactly his value');
market.aiListSurplus(leagueId);
assert(one<{ n: number }>(
  'SELECT COUNT(*) AS n FROM players WHERE listed = 1 AND team_id IN (SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL)',
  leagueId).n === 7, 'one listing at a time per club (idempotent)');

// Ledger: "transferTargets (listed players across the world)" + release-clause players.
const targets0 = market.transferTargets(teamId);
assert(targets0.every(t => t.clubTeamId !== teamId && (t.askPrice != null || t.releaseClause != null)),
  'targets = listed or clause-armed players, never your own');
const targetIds = new Set(targets0.map(t => t.id));
assert(listedNow.every(l => targetIds.has(l.id)), 'every AI listing is a biddable target');
assert(targets0.filter(t => t.releaseClause != null).length === 15, 'clause players are buyable across the whole world');

// ── 8. bidForPlayer validations + the pending → accepted flow ──────────────────────────────────
// Ledger: "bidForPlayer … the seller accepts at/above its price (a listed player's ask …),
// counters at that price if the bid is close (≥ 80%), else rejects — and won't sell down to the
// minimum squad … money conserved + squads legal."
// DISCREPANCY: the ledger says "On acceptance the deal runs immediately"; in the CURRENT code a
// bid creates a PENDING offer resolved at the next matchday tick (processOffers, §2.1 signing
// drama), with supersede/withdraw/expiry and an auction — asserted below as it now behaves.
const S = aiLeagueTeamIds[aiLeagueTeamIds.length - 1];   // shrink one AI club to the floor
db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 11').run(S);
assert(squadCount(S) === market.SQUAD_MIN, 'refusal probe: a club at the 11-man floor');
const sPlayerId = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 5', S).id;
let rb = market.bidForPlayer(teamId, sPlayerId, 5_000_000);
assert(!rb.ok && rb.status === 'rejected' && (rb.error ?? '').includes('minimum'),
  "a club won't sell down to the minimum squad");
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM transfer_offers WHERE player_id = ?', sPlayerId).n === 0,
  'the refusal records no offer');

const ownPlayerId = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 0', teamId).id;
rb = market.bidForPlayer(teamId, ownPlayerId, 1_000_000);
assert(!rb.ok && rb.error === 'already your player', 'cannot bid for your own man');
const sellable = market.transferTargets(teamId).filter(t => t.askPrice != null && t.releaseClause == null && t.clubTeamId !== S);
assert(sellable.length === 6 && new Set(sellable.map(t => t.clubTeamId)).size === 6,
  'six clean listings from six different clubs remain biddable');
const [t1, t2, t3] = sellable;
rb = market.bidForPlayer(teamId, t1.id, 0);
assert(!rb.ok && rb.error === 'enter a valid bid', 'zero fee refused');
rb = market.bidForPlayer(teamId, t1.id, teamBudget(teamId) + 1);
assert(!rb.ok && rb.error === 'not enough budget for that fee', 'cannot bid beyond the kitty');
rb = market.bidForPlayer(teamId, 9_999_999, 1_000_000);
assert(!rb.ok && rb.error === 'player not found', 'unknown target refused');

rb = market.bidForPlayer(teamId, t1.id, t1.askPrice!);
assert(rb.ok && rb.status === 'pending' && rb.player === t1.name, 'a bid is pending until the matchday tick');
rb = market.bidForPlayer(teamId, t1.id, t1.askPrice! + 100_000);
assert(rb.ok && rb.status === 'pending', 'a re-bid is accepted');
assert(one<{ n: number }>(
  "SELECT COUNT(*) AS n FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? AND status IN ('pending','countered')",
  teamId, t1.id).n === 1
  && one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? AND status = 'withdrawn'",
    teamId, t1.id).n === 1,
  'a new bid supersedes the old — one live bid per buyer/player');
assert(market.offersForTeam(teamId).some(o => o.playerId === t1.id && o.status === 'pending' && o.fee === t1.askPrice! + 100_000),
  'the outgoing offer is visible to the buyer');

const t1Fee = t1.askPrice! + 100_000;
const sellerBudget0 = teamBudget(t1.clubTeamId);
const sellerCount0 = squadCount(t1.clubTeamId);
const sum8 = sumBudgets();
const np8 = worldPlayers();
const snap8 = one<{ wage: number; contract_years: number; name: string; role: string }>(
  'SELECT wage, contract_years, name, role FROM players WHERE id = ?', t1.id);
const mine8 = new Set(all<{ id: number }>('SELECT id FROM players WHERE team_id = ?', teamId).map(p => p.id));
const evs8 = market.processOffers(leagueId);
const acc8 = evs8.find(e => e.buyerTeamId === teamId && e.result === 'accepted');
assert(acc8 != null && acc8.fee === t1Fee, 'the at-ask bid is accepted at the tick');
expectBudget -= t1Fee;
assert(teamBudget(teamId) === expectBudget, 'buyer debited the fee');
assert(teamBudget(t1.clubTeamId) === sellerBudget0 + t1Fee, 'seller credited the same fee');
assert(sumBudgets() === sum8, 'money conserved club-to-club');
assert(worldPlayers() === np8, 'player headcount conserved');
const moved8 = all<{ id: number; name: string; role: string; wage: number; contract_years: number }>(
  'SELECT id, name, role, wage, contract_years FROM players WHERE team_id = ?', teamId).find(p => !mine8.has(p.id))!;
assert(moved8.name === snap8.name && moved8.role === snap8.role, 'the bought player arrived');
assert(moved8.wage === snap8.wage && moved8.contract_years === snap8.contract_years,
  'he keeps his wage + remaining contract years (contracts interplay)');
assert(squadCount(t1.clubTeamId) === sellerCount0 - 1
  && all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', t1.clubTeamId)
    .every((row, i) => row.slot === i),
  'the seller squad renumbers contiguously after the sale');
assert(one<{ status: string }>(
  'SELECT status FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
  teamId, t1.id).status === 'accepted', 'the offer row is settled');

// ── 9. Counter → matchCounter ──────────────────────────────────────────────────────────────────
// Ledger: "counters at that price if the bid is close (≥ 80%)"; matchCounter completes at the
// seller's named price.
rb = market.bidForPlayer(teamId, t2.id, Math.ceil(t2.askPrice! * 0.85));
assert(rb.ok && rb.status === 'pending', 'a close bid is tabled');
const evs9 = market.processOffers(leagueId);
const ctr9 = evs9.find(e => e.buyerTeamId === teamId && e.result === 'countered');
assert(ctr9 != null && ctr9.counterFee === t2.askPrice!, 'a close bid draws a counter at the ask');
const ctrOffer = one<{ id: number; status: string; counter_fee: number }>(
  'SELECT id, status, counter_fee FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1',
  teamId, t2.id);
assert(ctrOffer.status === 'countered' && ctrOffer.counter_fee === t2.askPrice!, 'the counter is persisted');
const sellerB9 = teamBudget(t2.clubTeamId);
const sum9 = sumBudgets();
const mc = market.matchCounter(teamId, ctrOffer.id);
assert(mc.ok && mc.status === 'accepted' && mc.fee === t2.askPrice!, 'matching the counter completes at once');
expectBudget -= t2.askPrice!;
assert(teamBudget(teamId) === expectBudget && teamBudget(t2.clubTeamId) === sellerB9 + t2.askPrice!
  && sumBudgets() === sum9, 'the matched deal conserves money');
assert(!market.matchCounter(teamId, ctrOffer.id).ok, 'a settled counter cannot be matched twice');

// ── 10. Reject path + withdrawOffer ────────────────────────────────────────────────────────────
// Ledger: "else rejects"; a live pending/countered offer can be pulled.
const rejFee = Math.max(1, Math.floor(t3.askPrice! * 0.5));
rb = market.bidForPlayer(teamId, t3.id, rejFee);
assert(rb.ok && rb.status === 'pending', 'a lowball is still tabled');
const wOfferId = one<{ id: number }>(
  "SELECT id FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? AND status = 'pending'", teamId, t3.id).id;
assert(market.withdrawOffer(teamId, wOfferId).ok === true && offerStatus(wOfferId) === 'withdrawn', 'a live bid withdraws');
assert(market.withdrawOffer(teamId, wOfferId).ok === false, 'a resolved offer cannot be withdrawn again');
rb = market.bidForPlayer(teamId, t3.id, rejFee);
const sum10 = sumBudgets();
const evs10 = market.processOffers(leagueId);
assert(evs10.some(e => e.buyerTeamId === teamId && e.result === 'rejected'), 'a lowball is rejected at the tick');
assert(sumBudgets() === sum10 && teamBudget(teamId) === expectBudget, 'a rejected bid moves no money');

// ── 11. Release clause: binding + instant ──────────────────────────────────────────────────────
// §release-clause (code): "a bid AT OR ABOVE the clause is BINDING — it completes AT ONCE
// (bypassing the club's verdict + the matchday wait) … the buyer's books re-checked."
const clauseCands = all<{ id: number; release_clause: number; team_id: number }>(
  `SELECT p.id, p.release_clause, p.team_id FROM players p JOIN teams t ON t.id = p.team_id
   WHERE t.league_id = ? AND p.release_clause IS NOT NULL AND p.team_id != ? AND p.team_id != ?
   ORDER BY p.release_clause ASC`, leagueId, teamId, S);
assert(clauseCands.length >= 2 && clauseCands[0].release_clause <= teamBudget(teamId),
  'clause targets exist and the cheapest is affordable');
const cpUnder = clauseCands[1];
rb = market.bidForPlayer(teamId, cpUnder.id, cpUnder.release_clause - 50_000);
assert(rb.ok && rb.status === 'pending', 'below the clause it is an ordinary pending bid, not a trigger');
const underOfferId = one<{ id: number }>(
  "SELECT id FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? AND status = 'pending'", teamId, cpUnder.id).id;
assert(market.withdrawOffer(teamId, underOfferId).ok, 'probe bid pulled');
const cp = clauseCands[0];
const cpSellerB = teamBudget(cp.team_id);
const sum11 = sumBudgets();
const nMine11 = squadCount(teamId);
const nSeller11 = squadCount(cp.team_id);
rb = market.bidForPlayer(teamId, cp.id, cp.release_clause);
assert(rb.ok && rb.status === 'accepted' && rb.fee === cp.release_clause
  && (rb.placed === 'xi' || rb.placed === 'bench'), 'a bid at the clause is binding and completes at once');
expectBudget -= cp.release_clause;
assert(teamBudget(teamId) === expectBudget && teamBudget(cp.team_id) === cpSellerB + cp.release_clause,
  'clause fee debited and credited exactly');
assert(sumBudgets() === sum11 && squadCount(teamId) === nMine11 + 1 && squadCount(cp.team_id) === nSeller11 - 1,
  'clause deal conserves money and headcount');

// ── 12. Incoming offers (AI → human): reject, accept, auction settlement ───────────────────────
// §2.1 (code): "An AI club tables a pending bid for the human's listed player … the manager
// resolves it … several clubs may bid on the same man (an auction the human picks from)";
// accepting "Rejects any rival pending bids on the now-sold player."
const mine12 = all<{ id: number; slot: number; name: string; attrs: string; age: number; personality: string | null }>(
  'SELECT id, slot, name, attrs, age, personality FROM players WHERE team_id = ? AND parent_team_id IS NULL', teamId);
const sellRow = mine12
  .map(p => ({ p, val: game.playerValue(JSON.parse(p.attrs), p.age, parseJSON(p.personality)) }))
  .sort((a, b) => a.val - b.val)[0].p;
const lSell = market.listPlayer(teamId, sellRow.slot);
assert(lSell.ok === true, 'the outgoing man is listed');
const sellFee = lSell.askPrice!;
db.prepare('UPDATE teams SET budget = 100000000, wage_budget = 200000000 WHERE id = ?').run(S);   // the buyer's books must clear
const bidderX = S, bidderY = aiLeagueTeamIds[0], bidderZ = aiLeagueTeamIds[1];
const insOffer = db.prepare(
  `INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at)
   VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)`);
const offA = Number(insOffer.run(bidderX, teamId, sellRow.id, sellFee, 1, 3).lastInsertRowid);
const offB = Number(insOffer.run(bidderY, teamId, sellRow.id, sellFee, 1, 3).lastInsertRowid);
assert(market.incomingOffersForTeam(teamId).filter(o => o.playerName === sellRow.name && o.status === 'pending').length === 2,
  'both incoming bids are visible to the manager');
assert(market.rejectIncomingOffer(teamId, offB).ok === true && offerStatus(offB) === 'rejected', 'an incoming bid can be rejected');
assert(market.rejectIncomingOffer(teamId, offB).ok === false, 'a resolved incoming bid cannot be re-rejected');
const offC = Number(insOffer.run(bidderZ, teamId, sellRow.id, sellFee, 1, 3).lastInsertRowid);
const xBudget12 = teamBudget(bidderX);
const sum12 = sumBudgets();
const nMine12 = squadCount(teamId);
const nX12 = squadCount(bidderX);
const rAcc = market.acceptIncomingOffer(teamId, offA);
assert(rAcc.ok === true && rAcc.fee === sellFee && rAcc.player === sellRow.name, 'the manager accepts the incoming bid');
expectBudget += sellFee;
assert(teamBudget(teamId) === expectBudget && teamBudget(bidderX) === xBudget12 - sellFee && sumBudgets() === sum12,
  'the sale conserves money (buyer debited, seller credited)');
assert(squadCount(teamId) === nMine12 - 1 && squadCount(bidderX) === nX12 + 1, 'the player physically moved to the bidder');
assert(offerStatus(offC) === 'rejected', 'auction settlement: the rival pending bid is auto-rejected');
assert(market.acceptIncomingOffer(teamId, 987654).ok === false, 'no such live offer');

// ── 13. Sale mechanics: role-aware starter backfill + upgrade-into-XI ─────────────────────────
// Ledger pillar 1: "a role-aware starter backfill on sales" (one of the two review fixes) and
// "buyFreeAgent (auto-upgrade-into-XI or bench)". renumberSquad (code): a renumber resets a
// custom lineup and prunes slot-keyed per-player plan directives, keeping team-wide ones (§1.1).
const t1Club = one<{ id: number }>('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id LIMIT 1', worldId).id;
db.prepare('UPDATE teams SET lineup = ?, plan_directives = ? WHERE id = ?').run(
  JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 9]),
  JSON.stringify({ summary: 'test plan', directives: [{ teamScope: 1, kind: 'high_press' }, { playerId: 5, kind: 'shoot_on_sight' }] }),
  t1Club);
assert(one<{ role: string }>('SELECT role FROM players WHERE team_id = ? AND slot = 11', t1Club).role === 'GK',
  'seeded bench carries GK cover');
assert(market.removePlayerFromSquad(t1Club, 0) === true, 'the starting GK is removed');
assert(one<{ role: string }>('SELECT role FROM players WHERE team_id = ? AND slot = 0', t1Club).role === 'GK',
  'the vacated XI slot is backfilled ON-ROLE from the bench');
const t1Slots = all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', t1Club).map(row => row.slot);
assert(t1Slots.length === 16 && t1Slots.every((s, i) => s === i), 'the squad renumbers contiguously');
const t1Row = one<{ lineup: string | null; plan_directives: string | null }>(
  'SELECT lineup, plan_directives FROM teams WHERE id = ?', t1Club);
assert(t1Row.lineup === null, 'a custom lineup is reset by the renumber (surfaced, not corrupted)');
const prunedPlan = JSON.parse(t1Row.plan_directives ?? '{}') as { directives?: { teamScope?: number }[] };
assert(prunedPlan.directives?.length === 1 && prunedPlan.directives[0].teamScope === 1,
  'slot-keyed player directives pruned; team-wide tactics kept (§1.1)');
assert(market.removePlayerFromSquad(t1Club, 99) === false, 'removing an empty slot refused');

const insFa = db.prepare(
  'INSERT INTO free_agents (league_id, name, role, attrs, age, potential, value, wage, foot) VALUES (?, ?, ?, ?, 24, 95, ?, ?, 1)');
const starId = Number(insFa.run(leagueId, 'ZZ Star Forward', 'CF', JSON.stringify(flat(95)), 1_000_000, 25_000).lastInsertRowid);
assert(one<{ lineup: string | null }>('SELECT lineup FROM teams WHERE id = ?', teamId).lineup === null,
  'user is on the identity XI (upgrade path armed)');
const nBefore13 = squadCount(teamId);
r = market.buyFreeAgent(teamId, starId);
expectBudget -= 1_000_000;
assert(r.ok === true && r.placed === 'xi', 'an XI-upgrading signing goes straight into the XI');
const starSlot = one<{ slot: number }>("SELECT slot FROM players WHERE team_id = ? AND name = 'ZZ Star Forward'", teamId).slot;
assert(starSlot < 11 && game.ROLE_SLOTS[starSlot] === 'CF', 'he takes the CF formation slot');
assert(squadCount(teamId) === nBefore13 + 1 && teamBudget(teamId) === expectBudget,
  'the displaced starter is benched, not lost; the fee is debited');
const dudId = Number(insFa.run(leagueId, 'ZZ Dud Forward', 'CF', JSON.stringify(flat(31)), 25_000, 25_000).lastInsertRowid);
r = market.buyFreeAgent(teamId, dudId);
expectBudget -= 25_000;
assert(r.ok === true && r.placed === 'bench', 'a non-upgrade joins the bench');
assert(one<{ slot: number }>("SELECT slot FROM players WHERE team_id = ? AND name = 'ZZ Dud Forward'", teamId).slot
  === squadCount(teamId) - 1, 'the bench recruit lands on the last slot');

// ── 14. Window gating, deadline expiry, and the marketTick economy ─────────────────────────────
// Ledger: "free agents are signable any time, but club-to-club deals are window-gated — both
// the user (bidForPlayer) and the AI (marketTick step 2)"; loans "window-gated"; §2.4 (code):
// "once the deadline passes, an unsold listing lapses (auto-unlisted) — a listing_expired
// event for human clubs". acceptIncomingOffer gates acceptance too (review fix).
const bench14 = one<{ slot: number }>(
  'SELECT slot FROM players WHERE team_id = ? AND slot >= 11 AND listed = 0 AND parent_team_id IS NULL ORDER BY slot LIMIT 1',
  teamId).slot;
market.listPlayer(teamId, bench14);
assert(one<{ listed_until: number | null }>('SELECT listed_until FROM players WHERE team_id = ? AND slot = ?', teamId, bench14)
  .listed_until === 1, 'the pre-deadline listing is stamped with the summer deadline');
playRound(1);
let win = market.transferWindow(leagueId);
assert(!win.open && win.window === null && win.current === 2 && win.closesIn === 0 && !win.deadlineDay,
  'the window shuts after matchday 1');
assert(win.label === 'Window shut — reopens matchday 7 (winter)', 'the label names the winter reopening');
rb = market.bidForPlayer(teamId, 1, 1_000_000);
assert(!rb.ok && rb.error === 'the transfer window is shut', 'club-to-club bids are window-gated');
const rLoan = market.loanIn(teamId, 1);
assert(!rLoan.ok && rLoan.error === 'the transfer window is shut', 'loans are window-gated too');
const gateTargetId = one<{ id: number }>('SELECT id FROM players WHERE team_id = ? AND slot = 12', teamId).id;
const offD = Number(insOffer.run(bidderY, teamId, gateTargetId, 1_000_000, 2, 4).lastInsertRowid);
const rAccShut = market.acceptIncomingOffer(teamId, offD);
assert(!rAccShut.ok && rAccShut.error === 'the transfer window is shut', 'accepting an incoming bid is gated (review fix)');
db.prepare("UPDATE transfer_offers SET status = 'withdrawn' WHERE id = ?").run(offD);
const shutFaId = Number(insFa.run(leagueId, 'ZZ Shut Window Signing', 'CM', JSON.stringify(flat(50)), 750_000, 25_000).lastInsertRowid);
r = market.buyFreeAgent(teamId, shutFaId);
expectBudget -= 750_000;
assert(r.ok === true && teamBudget(teamId) === expectBudget, 'free agents are signable while the window is shut');

const sumTick = sumBudgets();
const tickEvents = market.marketTick(leagueId);
assert(tickEvents.some(e => e.type === 'listing_expired' && e.teamId === teamId),
  'an unsold listing lapses once the deadline passes (§2.4)');
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND listed = 1', teamId).n === 0,
  'the lapsed listing is auto-unlisted');
assert(tickEvents.every(e => e.type === 'sign' || e.type === 'listing_expired'),
  'window shut: the AI makes no club-to-club move (marketTick step 2 gated)');
const signFees = tickEvents.filter(e => e.type === 'sign').reduce((s, e) => s + e.fee, 0);
assert(sumBudgets() === sumTick - signFees, 'the tick conserves money exactly — only free-agent fees leave the clubs');
assert(all<{ budget: number }>('SELECT budget FROM teams WHERE league_id IN (?, ?)', worldId, leagueId)
  .every(t => t.budget >= 0), 'no club is overdrawn by AI shopping');
assert(all<{ n: number }>(
  `SELECT COUNT(*) AS n FROM players WHERE listed = 1
   AND team_id IN (SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL) GROUP BY team_id`, leagueId)
  .every(row => row.n === 1), 'after the tick each AI club still holds at most one listing');

for (let round = 2; round <= 6; round++) { playRound(round); }
win = market.transferWindow(leagueId);
assert(win.open && win.window === 'winter' && win.current === 7 && win.deadline === 8, 'winter opens at mid-season');
assert(win.closesIn === 2 && !win.deadlineDay, 'two matchdays of winter remain');
playRound(7);
win = market.transferWindow(leagueId);
assert(win.open && win.window === 'winter' && win.closesIn === 1 && win.deadlineDay, 'winter deadline day');
playRound(8);
win = market.transferWindow(leagueId);
assert(!win.open && win.label === 'Window shut — reopens pre-season', 'winter shuts after its deadline');
for (let round = 9; round <= 14; round++) { playRound(round); }
win = market.transferWindow(leagueId);
assert(!win.open && win.window === null && win.current === 15, 'season complete: no window past the end');

// ── 15. Free-agent contract offers (§2.1, the free-agent half) ─────────────────────────────────
// §2.1 (code): "the manager tables a wage+length offer the free agent considers and answers at
// the next matchday (resolveFreeAgentOffers)" — accepts if the wage meets his demand (signing
// at the OFFERED terms), else rejects; poached agents and stale offers are reported. Explicitly
// NOT window-gated ("free agents are signable any time").
const dudSlotNow = one<{ slot: number }>("SELECT slot FROM players WHERE team_id = ? AND name = 'ZZ Dud Forward'", teamId).slot;
assert(market.removePlayerFromSquad(teamId, dudSlotNow) === true, 'squad room freed (user-club removal path)');
const a1 = Number(insFa.run(leagueId, 'ZZ Agent Lowball', 'WM', JSON.stringify(flat(62)), 2_000_000, 800_000).lastInsertRowid);
const a2 = Number(insFa.run(leagueId, 'ZZ Agent Signs', 'WM', JSON.stringify(flat(62)), 1_500_000, 400_000).lastInsertRowid);
const a3 = Number(insFa.run(leagueId, 'ZZ Agent Poached', 'WM', JSON.stringify(flat(62)), 1_000_000, 300_000).lastInsertRowid);
const a4 = Number(insFa.run(leagueId, 'ZZ Agent Expired', 'WM', JSON.stringify(flat(62)), 1_000_000, 300_000).lastInsertRowid);
let rf = market.offerToFreeAgent(teamId, a1, 500_000, 0);
assert(!rf.ok && (rf.error ?? '').startsWith('contract length'), 'contract length bounds enforced');
rf = market.offerToFreeAgent(teamId, a1, 0, 3);
assert(!rf.ok && rf.error === 'enter a valid wage', 'wage must be positive');
rf = market.offerToFreeAgent(teamId, 9_999_999, 500_000, 3);
assert(!rf.ok && rf.error === 'free agent not available', 'unknown agent refused');
assert(market.offerToFreeAgent(teamId, a1, 500_000, 3).ok === true, 'a lowball offer is tabled (no window gate)');
assert(market.offerToFreeAgent(teamId, a1, 600_000, 3).ok === true, 'a re-offer is tabled');
assert(one<{ n: number }>(
  "SELECT COUNT(*) AS n FROM free_agent_offers WHERE buyer_team_id = ? AND free_agent_id = ? AND status = 'pending'",
  teamId, a1).n === 1, 'one live offer per (team, agent) — the re-offer superseded');
assert(market.offerToFreeAgent(teamId, a2, 400_000, 4).ok === true, 'an at-demand offer is tabled');
assert(market.offerToFreeAgent(teamId, a3, 300_000, 2).ok === true
  && market.offerToFreeAgent(teamId, a4, 300_000, 2).ok === true, 'race + expiry probes tabled');
db.prepare('DELETE FROM free_agents WHERE id = ?').run(a3);                    // a rival signed him first
db.prepare('UPDATE free_agent_offers SET expires_round = 0 WHERE buyer_team_id = ? AND free_agent_id = ?').run(teamId, a4);
const faViews = market.freeAgentOffersForTeam(teamId);
assert(faViews.length === 3 && faViews.find(o => o.agentId === a1)?.demand === 800_000,
  'live negotiations list the wage demand; a poached agent drops off');
const nBefore15 = squadCount(teamId);
const faEvents = market.resolveFreeAgentOffers(leagueId);
assert(faEvents.some(e => e.type === 'fa_rejected' && e.player === 'ZZ Agent Lowball'), 'a lowball is turned down');
assert(faEvents.some(e => e.type === 'fa_signed' && e.player === 'ZZ Agent Signs' && e.wage === 400_000 && e.years === 4),
  'meeting his demand signs him');
assert(faEvents.some(e => e.type === 'fa_gone' && e.player === 'ZZ Agent Poached'), 'losing the race is reported, not silent');
assert(faEvents.some(e => e.type === 'fa_expired' && e.player === 'ZZ Agent Expired'), 'a stale offer lapses loudly');
expectBudget -= 1_500_000;
assert(teamBudget(teamId) === expectBudget, 'the signing-on fee (his value) is debited at resolution');
const signedRow = one<{ wage: number; contract_years: number }>(
  "SELECT wage, contract_years FROM players WHERE team_id = ? AND name = 'ZZ Agent Signs'", teamId);
assert(signedRow.wage === 400_000 && signedRow.contract_years === 4, 'he signs at the OFFERED terms, not his demand');
assert(squadCount(teamId) === nBefore15 + 1, 'exactly one agent joined');
assert(one<{ n: number }>('SELECT COUNT(*) AS n FROM free_agents WHERE id IN (?, ?)', a1, a2).n === 1,
  'the rejected agent stays in the pool; the signed one leaves it');

// ── 16. The always-11 spec invariant ───────────────────────────────────────────────────────────
// Ledger pillar 1: "the always-11 spec invariant … (11/side, byte-identical default, no bench
// leak)" — the selection layer (fieldedXIIndices, shared by specForTeam + fitnessTick) must
// field exactly slots 0-10 from a squad grown far past 11.
const finalSquad = all<{ slot: number }>('SELECT slot FROM players WHERE team_id = ? ORDER BY slot', teamId);
assert(finalSquad.length === 23 && finalSquad.every((row, i) => row.slot === i),
  'the whole flow left a 23-man, contiguously-slotted squad');
const xi = game.fieldedXIIndices(finalSquad, () => false, formations.DEFAULT_FORMATION, null);
assert(xi.length === 11 && new Set(xi).size === 11, 'always exactly 11 distinct players fielded');
assert(xi.every((idx, i) => idx === i), 'default path fields slots 0-10 — byte-identical XI, no bench leak');

console.log(`_market_test: ${assertions} assertions passed`);

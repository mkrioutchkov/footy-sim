// Club finances ledger test (no engine). Record-only ledger: unit (record + aggregate + AI no-op +
// per-season filtering) and the integration hooks (buyFreeAgent logs a transfer; rollover logs prize).
//
//   npx tsx tools/_finances_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-fin-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const season = await import('../web/backend/season.ts');
const market = await import('../web/backend/market.ts');
const fin = await import('../web/backend/finances.ts');

const u = registerUser('accountant', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Finance FC', game.DEFAULT_TACTICS);
const aiId = (db.prepare('SELECT id FROM teams WHERE user_id IS NULL ORDER BY id LIMIT 1').get() as { id: number }).id;
const entryCount = (tid: number) => (db.prepare('SELECT COUNT(*) AS n FROM finance_entries WHERE team_id = ?').get(tid) as { n: number }).n;

// ── fresh club: balance = budget, nothing logged ──────────────────────────────────────────────
const f0 = fin.getFinances(teamId)!;
const budget0 = game.getTeamWithPlayers(teamId)!.budget;
check(f0.balance === budget0, 'finances balance mirrors the team budget');
check(f0.season === 1 && f0.income === 0 && f0.expense === 0, 'a fresh club has a clean season-1 statement');
check(f0.byKind.length === 0 && f0.recent.length === 0, 'no entries yet');
check(f0.wageBudget > 0 && typeof f0.wageBill === 'number' && f0.wageBill >= 0, 'finances reports the wage bill + wage budget');
check(f0.history.length === 0, 'no season history before any entries');

// ── recordFinance is a no-op for AI clubs ─────────────────────────────────────────────────────
fin.recordFinance(aiId, 'prize', 5_000_000, 'should be ignored');
check(entryCount(aiId) === 0, 'recordFinance is a no-op for an AI club');

// ── record + aggregate for the human club ─────────────────────────────────────────────────────
fin.recordFinance(teamId, 'prize', 1_000_000, 'Prize');
fin.recordFinance(teamId, 'transfer_in', -400_000, 'Signing');
fin.recordFinance(teamId, 'staff', -100_000, 'Coach');
const f1 = fin.getFinances(teamId)!;
check(f1.income === 1_000_000, 'income sums the positive entries');
check(f1.expense === -500_000, 'expense sums the negative entries');
check(f1.byKind.length === 3, 'byKind has one row per category');
check(f1.recent.length === 3 && f1.recent[0].note === 'Coach', 'recent is newest-first');
check(f1.byKind[0].kind === 'prize', 'byKind is sorted by amount (income first)');
check(f1.history.length === 1 && f1.history[0].season === 1 && f1.history[0].net === 500_000, 'season history nets income + expense (1M − 500k = 500k)');

// ── per-season filtering: a later season starts a fresh statement, recent still spans seasons ──
db.prepare('UPDATE leagues SET season = 2 WHERE id = (SELECT league_id FROM teams WHERE id = ?)').run(teamId);
fin.recordFinance(teamId, 'prize', 250_000, 'S2 prize');
const f2 = fin.getFinances(teamId)!;
check(f2.season === 2 && f2.income === 250_000 && f2.expense === 0, 'season-2 statement counts only season-2 entries');
check(f2.recent.length === 4, 'recent still spans both seasons');
check(f2.history.length === 2 && f2.history[0].season === 2 && f2.history[1].season === 1, 'season history is most-recent-first across seasons');
db.prepare('UPDATE leagues SET season = 1 WHERE id = (SELECT league_id FROM teams WHERE id = ?)').run(teamId);
db.prepare('DELETE FROM finance_entries WHERE team_id = ?').run(teamId);   // reset for the integration checks

// ── integration: buyFreeAgent logs a transfer_in ──────────────────────────────────────────────
const cheap = [...(db.prepare('SELECT id, name, value FROM free_agents WHERE league_id = (SELECT league_id FROM teams WHERE id = ?) ORDER BY value ASC', ).all(teamId) as { id: number; name: string; value: number }[])][0];
const buy = market.buyFreeAgent(teamId, cheap.id);
check(buy.ok, 'buyFreeAgent succeeds for the cheapest free agent');
const af = fin.getFinances(teamId)!;
check(af.recent[0]?.kind === 'transfer_in' && af.recent[0]?.amount === -cheap.value, 'signing a free agent logs a transfer_in for the fee');

// ── integration: rollover logs prize money for the finished season ─────────────────────────────
db.prepare('DELETE FROM finance_entries WHERE team_id = ?').run(teamId);
const leagueId = game.getTeamWithPlayers(teamId)!.leagueId;
const worlds = season.worldLeagues(leagueId).map(l => l.id);
const ph = worlds.map(() => '?').join(',');
const fx = db.prepare(`SELECT id, home_team_id, away_team_id FROM fixtures WHERE league_id IN (${ph}) AND played = 0`).all(...worlds) as { id: number; home_team_id: number; away_team_id: number }[];
const set = db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?');
for (const x of fx) { if (x.home_team_id === teamId) set.run(3, 0, x.id); else if (x.away_team_id === teamId) set.run(0, 3, x.id); else set.run(0, 0, x.id); }
season.rolloverSeason(leagueId);
const prize = db.prepare("SELECT season, amount FROM finance_entries WHERE team_id = ? AND kind = 'prize'").get(teamId) as { season: number; amount: number } | undefined;
check(!!prize && prize.season === 1 && prize.amount > 0, 'rollover logs prize money for the finished season (1)');

// ── §P2: per-matchday gate & TV income (human only, tier-scaled, real budget credit) ────────────
const leagueId2 = game.getTeamWithPlayers(teamId)!.leagueId;
const tier = (db.prepare('SELECT tier FROM leagues WHERE id = ?').get(leagueId2) as { tier: number }).tier;
const expect = fin.MATCHDAY_INCOME[tier];
const budgetBefore = game.getTeamWithPlayers(teamId)!.budget;
const aiBudgetBefore = (db.prepare('SELECT budget FROM teams WHERE id = ?').get(aiId) as { budget: number }).budget;
const lastEntryId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM finance_entries').get() as { id: number }).id;
const paid = fin.payMatchdayIncome(leagueId2);
check(paid.some(p => p.teamId === teamId && p.amount === expect), `the human earns the tier-scaled matchday income (£${expect})`);
// The matchday tick also pays that day's slice of the wage bill (added after this test was written),
// so the budget moves by the income net of the wages entry this call logged.
const wageSlice = -(db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM finance_entries WHERE team_id = ? AND kind = 'wages' AND id > ?").get(teamId, lastEntryId) as { s: number }).s;
check(wageSlice > 0, 'the matchday also pays its slice of the wage bill');
check(game.getTeamWithPlayers(teamId)!.budget === budgetBefore + expect - wageSlice, 'the income is a real budget credit (net of the wage slice)');
check((db.prepare('SELECT budget FROM teams WHERE id = ?').get(aiId) as { budget: number }).budget === aiBudgetBefore, 'AI clubs earn no matchday income (human-only)');
check(!!db.prepare("SELECT 1 FROM finance_entries WHERE team_id = ? AND kind = 'gate'").get(teamId), 'the income is logged as a gate & TV entry');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

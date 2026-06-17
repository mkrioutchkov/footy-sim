// Club finances ledger. recordFinance logs a cash movement that ALREADY happened (the budget is
// the source of truth — this never moves money); getFinances aggregates it into a statement. Human
// clubs only: recordFinance is a no-op for AI clubs, so the hooks at money-movement sites can call
// it unconditionally. See finance_entries in db.ts.
import { db } from './db.ts';

export type FinanceKind = 'prize' | 'transfer_in' | 'transfer_out' | 'staff' | 'sponsor' | 'other';
export interface FinanceEntry { season: number; kind: FinanceKind; amount: number; note: string; }

// amount is signed: positive = income, negative = expense.
export function recordFinance(teamId: number, kind: FinanceKind, amount: number, note: string): void {
  const row = db.prepare('SELECT t.user_id AS uid, l.season AS season FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { uid: number | null; season: number } | undefined;
  if (!row || row.uid == null) return;   // AI club (or missing) — nothing to log
  db.prepare('INSERT INTO finance_entries (team_id, season, kind, amount, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(teamId, row.season, kind, Math.round(amount), note, Date.now());
}

export interface FinanceSeason { season: number; income: number; expense: number; net: number; }

export function getFinances(teamId: number): {
  balance: number; season: number; income: number; expense: number;
  wageBill: number; wageBudget: number;
  byKind: { kind: string; amount: number }[]; recent: FinanceEntry[]; history: FinanceSeason[];
} | null {
  const team = db.prepare('SELECT t.budget AS budget, t.wage_budget AS wageBudget, l.season AS season FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { budget: number; wageBudget: number; season: number } | undefined;
  if (!team) return null;
  const thisSeason = db.prepare('SELECT kind, amount FROM finance_entries WHERE team_id = ? AND season = ?')
    .all(teamId, team.season) as { kind: string; amount: number }[];
  let income = 0, expense = 0;
  const kindTotals = new Map<string, number>();
  for (const e of thisSeason) {
    if (e.amount >= 0) income += e.amount; else expense += e.amount;
    kindTotals.set(e.kind, (kindTotals.get(e.kind) ?? 0) + e.amount);
  }
  const recent = db.prepare('SELECT season, kind, amount, note FROM finance_entries WHERE team_id = ? ORDER BY id DESC LIMIT 25')
    .all(teamId) as unknown as FinanceEntry[];
  // the current annual wage commitment (read-only — wages aren't deducted; this surfaces the
  // existing wage-budget system on the finances statement)
  const wageBill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  // season-over-season income/expense/net (the season column is already on every entry)
  const history = (db.prepare('SELECT season, SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END) AS income, SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense FROM finance_entries WHERE team_id = ? GROUP BY season ORDER BY season DESC')
    .all(teamId) as { season: number; income: number; expense: number }[])
    .map(r => ({ season: r.season, income: r.income, expense: r.expense, net: r.income + r.expense }));
  return {
    balance: team.budget, season: team.season, income, expense,
    wageBill, wageBudget: team.wageBudget,
    byKind: [...kindTotals.entries()].map(([kind, amount]) => ({ kind, amount })).sort((a, b) => b.amount - a.amount),
    recent, history,
  };
}

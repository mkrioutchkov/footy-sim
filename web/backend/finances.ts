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

export function getFinances(teamId: number): {
  balance: number; season: number; income: number; expense: number;
  byKind: { kind: string; amount: number }[]; recent: FinanceEntry[];
} | null {
  const team = db.prepare('SELECT t.budget AS budget, l.season AS season FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { budget: number; season: number } | undefined;
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
  return {
    balance: team.budget, season: team.season, income, expense,
    byKind: [...kindTotals.entries()].map(([kind, amount]) => ({ kind, amount })).sort((a, b) => b.amount - a.amount),
    recent,
  };
}

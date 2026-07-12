// Club finances ledger. recordFinance logs a cash movement that ALREADY happened (the budget is
// the source of truth — this never moves money); getFinances aggregates it into a statement. Human
// clubs only: recordFinance is a no-op for AI clubs, so the hooks at money-movement sites can call
// it unconditionally. See finance_entries in db.ts.
import { db } from './db.ts';

export type FinanceKind = 'prize' | 'transfer_in' | 'transfer_out' | 'staff' | 'wages' | 'sponsor' | 'gate' | 'other';
export interface FinanceEntry { season: number; kind: FinanceKind; amount: number; note: string; }

// amount is signed: positive = income, negative = expense.
export function recordFinance(teamId: number, kind: FinanceKind, amount: number, note: string): void {
  const row = db.prepare('SELECT t.user_id AS uid, l.season AS season FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = ?')
    .get(teamId) as { uid: number | null; season: number } | undefined;
  if (!row || row.uid == null) return;   // AI club (or missing) — nothing to log
  db.prepare('INSERT INTO finance_entries (team_id, season, kind, amount, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(teamId, row.season, kind, Math.round(amount), note, Date.now());
}

// §P2 (playthrough): per-matchday gate & TV income, scaled by division. Credited to HUMAN clubs each
// matchday from the advance tick — without it the in-season ledger only ever drained (transfers out),
// so finances showed "Income +£0" all season. This is the ONLY place a real (budget-moving) recurring
// income enters; it's deliberately kept out of the season suites' path (they roll over directly, never
// through /api/advance), so the budget-conservation guards are unaffected. AI clubs are untouched (their
// market budgets are already provisioned + they keep no ledger). Returns what each human earned.
export const MATCHDAY_INCOME: Record<number, number> = { 1: 2_500_000, 2: 900_000 };   // gate + TV per matchday, by tier
// Each matchday a human club takes gate & TV income AND pays a slice of its annual wage bill (bill /
// matchdays-in-season), so wages are a REAL running cost — a squad whose wages outrun its income drains
// its balance, making financial management matter instead of budgets only ever rising. AI clubs are
// untouched (their market budgets are provisioned separately + they keep no ledger). `amount` is the gross
// gate income (unchanged for the digest); the wage debit lands on the budget + the finances ledger.
export function payMatchdayIncome(leagueId: number): { teamId: number; amount: number }[] {
  const tier = (db.prepare('SELECT tier FROM leagues WHERE id = ?').get(leagueId) as { tier: number } | undefined)?.tier ?? 2;
  const income = MATCHDAY_INCOME[tier] ?? MATCHDAY_INCOME[2];
  // Spread the annual wage bill over the season's matchdays (the fixture list's round count).
  const matchdays = Math.max(1, (db.prepare('SELECT MAX(round) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number | null }).r ?? 1);
  const humans = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NOT NULL').all(leagueId) as { id: number }[];
  const out: { teamId: number; amount: number }[] = [];
  for (const { id } of humans) {
    const bill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(id) as { w: number }).w;
    const wageSlice = Math.round(bill / matchdays);
    db.prepare('UPDATE teams SET budget = budget + ? - ? WHERE id = ?').run(income, wageSlice, id);
    recordFinance(id, 'gate', income, 'Matchday gate & TV');
    if (wageSlice > 0) recordFinance(id, 'wages', -wageSlice, 'Player wages');
    out.push({ teamId: id, amount: income });
  }
  return out;
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
  // the current annual wage commitment; a per-matchday slice of it is debited in payMatchdayIncome
  // (logged under the 'wages' kind), so this is the yearly figure behind that recurring drain.
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

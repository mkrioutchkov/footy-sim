// manager_ai — DETERMINISTIC transfers + renewals (full tier only; no rng / no LLM).
//
// A fully-AI club fixes its WEAKEST role within budget each matchday and keeps its squad from
// rotting (renew a soon-expiring contract). We REUSE the market helpers (buyFreeAgent) + the
// same weakest-role logic the market already uses, querying free agents directly via db so we
// pick deterministically (best upgrading agent of the weak role, cheapest tie-break).
//
// NEVER called for the 'assistant' tier — we never spend a human's money. The caller gates it.
import { db } from '../db.ts';
import { overall, ROLE_SLOTS, type Role } from '../game.ts';
import { buyFreeAgent, SQUAD_MAX } from '../market.ts';

interface PRow { id: number; slot: number; role: string; attrs: string; wage: number | null; contract_years: number; age: number; }
interface FARow { id: number; role: string; attrs: string; value: number; wage: number | null; }

// The role whose weakest XI starter is poorest — the upgrade target (mirrors market.ts'
// private weakestRole, re-implemented here so manager_ai owns its own copy without exporting
// internals from market.ts). Deterministic: scans the 11 starters by their FORMATION-slot role.
function weakestRole(players: PRow[]): { role: Role; target: number } | null {
  const xi = players.slice(0, 11);
  if (xi.length < 11) return null;
  const worstByRole = new Map<Role, number>();
  xi.forEach((p, i) => {
    const role = ROLE_SLOTS[i];
    const ov = overall(JSON.parse(p.attrs), role);
    worstByRole.set(role, Math.min(worstByRole.get(role) ?? 999, ov));
  });
  let weak: { role: Role; target: number } | null = null;
  for (const [role, t] of worstByRole) if (!weak || t < weak.target || (t === weak.target && role < weak.role)) weak = { role, target: t };
  return weak;
}

export interface TransferOutcome { signed: boolean; player?: string; role?: string; fee?: number; renewed: number; }

// One full-AI club's matchday market activity, DETERMINISTIC:
//   1. RENEWALS — bump any starter whose deal has <=1 year left back to a comfortable length
//      (so the AI doesn't bleed its XI to free agency at rollover). Pure DB write, no spend.
//   2. SIGNING  — sign the best free agent of the weakest role that upgrades the weak link and
//      fits BOTH budgets (transfer + wage). Reuses buyFreeAgent (atomic, validated). At most one.
// Skips a human club entirely (defensive — the caller already gates by tier).
export function manageTransfers(teamId: number): TransferOutcome {
  const team = db.prepare('SELECT id, league_id, budget, wage_budget, user_id FROM teams WHERE id = ?')
    .get(teamId) as { id: number; league_id: number; budget: number; wage_budget: number; user_id: number | null } | undefined;
  if (!team || team.user_id != null) return { signed: false, renewed: 0 };

  const players = db.prepare('SELECT id, slot, role, attrs, wage, contract_years, age FROM players WHERE team_id = ? ORDER BY slot')
    .all(teamId) as unknown as PRow[];

  // 1) Renew the starters running down their contracts. Idempotent: only touches <=1-year deals,
  // and re-running leaves a renewed (3-year) deal alone, so prepareMatchday stays idempotent
  // within a matchday (contract_years only ticks down at season rollover).
  let renewed = 0;
  const renew = db.prepare('UPDATE players SET contract_years = 3 WHERE id = ? AND contract_years <= 1');
  for (const p of players.slice(0, 11)) {
    if (p.contract_years <= 1) { renew.run(p.id); renewed++; }
  }

  // 2) Sign to fix the weakest role.
  if (players.length >= SQUAD_MAX) return { signed: false, renewed };
  const weak = weakestRole(players);
  if (!weak) return { signed: false, renewed };
  const wageBill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  const headroom = team.wage_budget - wageBill;

  // Best (highest-overall) affordable free agent of the weak role that beats the weak link and
  // fits the wage budget. Deterministic ordering: value DESC (proxy for quality) then id ASC.
  const fas = db.prepare('SELECT id, role, attrs, value, wage FROM free_agents WHERE league_id = ? AND role = ? AND value <= ? ORDER BY value DESC, id ASC')
    .all(team.league_id, weak.role, team.budget) as unknown as FARow[];
  const recruit = fas.find(a => overall(JSON.parse(a.attrs), a.role) > weak.target && (a.wage ?? 0) <= headroom);
  if (!recruit) return { signed: false, renewed };

  const r = buyFreeAgent(teamId, recruit.id);
  if (r.ok) return { signed: true, player: r.name, role: recruit.role, fee: r.value, renewed };
  return { signed: false, renewed };
}

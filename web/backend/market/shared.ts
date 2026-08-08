// market/shared.ts — the row shapes, readers and transaction wrapper every market module shares:
// the pre-split market.ts preamble, moved verbatim. market.ts re-exports the public half
// (SQUAD_MAX / SQUAD_MIN) so every existing importer keeps working.
import { db } from '../db.ts';
import { overall, ROLE_SLOTS, type Role } from '../game.ts';

export const SQUAD_MAX = 24;
export const SQUAD_MIN = 11;

export const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// node:sqlite is synchronous + single-threaded; wrap multi-statement mutations so a
// mid-transfer throw can't leave money debited but the player un-moved.
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

export interface TeamRow { id: number; league_id: number; budget: number; wage_budget: number; user_id: number | null; lineup: string | null; name: string; }
export interface PRow { id: number; slot: number; name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; listed: number; ask_price: number | null; wage: number | null; contract_years: number; foot: number | null; }
export interface FARow { id: number; league_id: number; name: string; role: string; attrs: string; personality: string | null; age: number; potential: number | null; value: number; wage: number | null; foot: number | null; }

export const teamRow = (id: number): TeamRow | undefined =>
  db.prepare('SELECT id, league_id, budget, wage_budget, user_id, lineup, name FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
export const teamPlayers = (id: number): PRow[] =>
  db.prepare('SELECT id, slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years, foot FROM players WHERE team_id = ? ORDER BY slot').all(id) as unknown as PRow[];
// Current annual wage commitment; headroom = wage_budget - wageBill gates new signings.
export const wageBill = (teamId: number): number =>
  (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;

// Leagues that share the buyer's world (so the user can buy across divisions). Legacy single
// leagues (world_id NULL) see only themselves.
export function worldLeagueIds(leagueId: number): number[] {
  const w = db.prepare('SELECT world_id FROM leagues WHERE id = ?').get(leagueId) as { world_id: number | null } | undefined;
  if (!w || w.world_id == null) return [leagueId];
  return (db.prepare('SELECT id FROM leagues WHERE world_id = ?').all(w.world_id) as { id: number }[]).map(r => r.id);
}

// The role whose weakest XI starter is poorest — the AI's upgrade target. Scans the 11 starters
// by their FORMATION-slot role. Ties break on the alphabetically-first role, which is the whole
// reason this lives here: it was implemented TWICE (market tick + manager/transfers) with
// DIFFERENT tie-breaks while the manager copy's comment claimed the two mirrored each other, so
// the two AI transfer paths chose a different upgrade role whenever two roles tied. One copy now.
export function weakestRole(players: Pick<PRow, 'attrs'>[]): { role: Role; target: number } | null {
  const xi = players.slice(0, 11);
  if (xi.length < 11) return null;
  const worstByRole = new Map<Role, number>();
  xi.forEach((p, i) => {
    const role = ROLE_SLOTS[i];
    const ov = overall(JSON.parse(p.attrs), role);
    worstByRole.set(role, Math.min(worstByRole.get(role) ?? 999, ov));
  });
  let weak: { role: Role; target: number } | null = null;
  for (const [role, t] of worstByRole) {
    if (!weak || t < weak.target || (t === weak.target && role < weak.role)) { weak = { role, target: t }; }
  }
  return weak;
}

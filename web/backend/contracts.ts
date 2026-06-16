// Contracts (pillar 5.2b). Deals tick down a year each season; expiring players resolve:
// an AI club auto-renews its men (a stable world); a human club's expiring players are
// RELEASED to the free-agent pool — but never below a legal XI (the best expiring players
// are auto-renewed to hold the squad at SQUAD_MIN). Renewal recomputes the wage from the
// player's current attrs/age/personality (a developed youngster earns more, a faded vet
// less) and is gated by the wage budget.
import { db } from './db.ts';
import { overall, playerWage } from './game.ts';
import { releasePlayerToFreeAgents, SQUAD_MIN } from './market.ts';

const RENEWAL_YEARS = 3;
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export interface RenewResult { ok: boolean; error?: string; wage?: number; years?: number; }

// Renew one player's deal: recompute their wage and commit a fresh contract. A voluntary
// renewal (force=false, the user endpoint) is gated by the wage budget; a forced one
// (force=true — the season tick keeping an AI squad together or holding a human XI at the
// floor) is honoured even if it strains the budget, because the club must field a team.
// Single mutation — safe inside or outside a transaction.
export function renewContract(teamId: number, slot: number, years = RENEWAL_YEARS, force = false): RenewResult {
  const team = db.prepare('SELECT wage_budget FROM teams WHERE id = ?').get(teamId) as { wage_budget: number } | undefined;
  const p = db.prepare('SELECT id, attrs, age, personality, wage FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { id: number; attrs: string; age: number; personality: string | null; wage: number | null } | undefined;
  if (!team || !p) return { ok: false, error: 'player not found' };
  const newWage = playerWage(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const bill = (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;
  if (!force && bill - (p.wage ?? 0) + newWage > team.wage_budget) return { ok: false, error: 'not enough wage budget to renew' };
  const yr = Math.max(1, Math.min(5, Math.round(Number.isFinite(years) ? years : RENEWAL_YEARS)));   // NaN-safe
  db.prepare('UPDATE players SET contract_years = ?, wage = ? WHERE id = ?').run(yr, newWage, p.id);
  return { ok: true, wage: newWage, years: yr };
}

export interface ContractEvent { teamId: number; player: string; type: 'renewed' | 'released'; }

// Season-end contract resolution for a division. Decrements every deal, then resolves the
// expiries. Call inside the rollover transaction (does not open its own); the free-agent
// pool must already be (re)seeded so released players join the new window's pool.
export function tickContracts(leagueId: number): ContractEvent[] {
  const events: ContractEvent[] = [];
  db.prepare('UPDATE players SET contract_years = contract_years - 1 WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(leagueId);
  const teams = db.prepare('SELECT id, name, user_id FROM teams WHERE league_id = ?').all(leagueId) as { id: number; name: string; user_id: number | null }[];
  for (const t of teams) {
    const expired = db.prepare('SELECT slot, name, attrs FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { slot: number; name: string; attrs: string }[];
    if (!expired.length) continue;

    if (t.user_id == null) {
      // AI: keep its squad together — force-renew every expiring player (honoured even if
      // it strains the wage budget; an AI never lets a player walk).
      for (const e of expired) { renewContract(t.id, e.slot, RENEWAL_YEARS, true); events.push({ teamId: t.id, player: e.name, type: 'renewed' }); }
      continue;
    }

    // Human: release expiring players (worst first) but never below a legal XI. Track by id
    // and re-resolve the current slot each time — releasePlayerToFreeAgents renumbers, so
    // slots shift after every release.
    const ranked = (db.prepare('SELECT id, name, attrs FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { id: number; name: string; attrs: string }[])
      .map(e => ({ id: e.id, name: e.name, ovr: overall(JSON.parse(e.attrs)) }))
      .sort((a, b) => a.ovr - b.ovr);
    for (const e of ranked) {
      const size = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(t.id) as { n: number }).n;
      if (size <= SQUAD_MIN) break;                       // floor reached — keep (renew) the rest
      const cur = db.prepare('SELECT slot FROM players WHERE id = ?').get(e.id) as { slot: number } | undefined;
      if (!cur) continue;
      releasePlayerToFreeAgents(t.id, cur.slot);
      events.push({ teamId: t.id, player: e.name, type: 'released' });
    }
    // anyone still out of contract was kept for the floor — force a 1-year extension so the
    // club can field a legal XI even if the wage bill is tight.
    const stillExpired = db.prepare('SELECT slot, name FROM players WHERE team_id = ? AND contract_years <= 0').all(t.id) as { slot: number; name: string }[];
    for (const s of stillExpired) { renewContract(t.id, s.slot, 1, true); events.push({ teamId: t.id, player: s.name, type: 'renewed' }); }
  }
  return events;
}

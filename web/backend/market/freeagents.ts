// market/freeagents.ts — the free-agent pool: signing an unattached player (instantly, or through a
// wage negotiation the agent answers at the next matchday), and the release path that puts a player
// INTO the pool when his contract runs out. Deliberately NOT window-gated — only club-to-club deals
// are (see window.ts); a free agent is signable any time.
import { db } from '../db.ts';
import { playerValue, playerWage } from '../game.ts';
import { recordFinance } from '../finances.ts';
import { parseJSON, teamPlayers, teamRow, tx, wageBill, SQUAD_MAX, type FARow } from './shared.ts';
import { transferWindow } from './window.ts';
import { placeRecruit, removePlayerFromSquad, SIGN_CONTRACT_YEARS } from './squad.ts';
import { OFFER_TTL } from './offers.ts';

export interface BuyResult { ok: boolean; error?: string; placed?: 'xi' | 'bench'; value?: number; name?: string; }

// Sign a free agent (used by both the user endpoint and the AI). Validates squad cap
// + budget, places the recruit, debits the fee, removes the agent — all in one tx.
export function buyFreeAgent(teamId: number, agentId: number): BuyResult {
  return tx(() => {
    const team = teamRow(teamId);
    if (!team) return { ok: false, error: 'team not found' };
    const agent = db.prepare('SELECT * FROM free_agents WHERE id = ? AND league_id = ?').get(agentId, team.league_id) as FARow | undefined;
    if (!agent) return { ok: false, error: 'free agent not available' };
    const players = teamPlayers(teamId);
    if (players.length >= SQUAD_MAX) return { ok: false, error: `squad full (max ${SQUAD_MAX})` };
    if (team.budget < agent.value) return { ok: false, error: 'not enough budget' };
    const wage = agent.wage ?? 0;
    if (wageBill(teamId) + wage > team.wage_budget) return { ok: false, error: 'not enough wage budget' };
    const placed = placeRecruit(team, players, { name: agent.name, role: agent.role, attrsJson: agent.attrs, age: agent.age, potential: agent.potential, personalityJson: agent.personality, wage, contractYears: SIGN_CONTRACT_YEARS, foot: agent.foot ?? 1 });
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(agent.value, teamId);
    db.prepare('DELETE FROM free_agents WHERE id = ?').run(agentId);
    recordFinance(teamId, 'transfer_in', -agent.value, `Signed free agent ${agent.name}`);   // no-op for AI
    return { ok: true, placed, value: agent.value, name: agent.name };
  });
}

// ── Free-agent contract offers (§2.1, the free-agent half) ───────────────────────────────────────
// Rather than an instant signing, the manager tables a wage+length offer the free agent "considers" and
// answers at the next matchday (resolveFreeAgentOffers). buyFreeAgent stays as the instant sign mechanism.
export interface FreeAgentOfferView { id: number; agentId: number; name: string; role: string; wage: number; years: number; demand: number; status: string }
export type FreeAgentEventType = 'fa_signed' | 'fa_rejected' | 'fa_expired' | 'fa_gone';
export interface FreeAgentEvent { teamId: number; type: FreeAgentEventType; player: string; role: string; wage: number; years: number }
const FA_OFFER_MIN_YEARS = 1, FA_OFFER_MAX_YEARS = 5;

// Table an offer to a free agent. Window-gated; validates squad room, the signing fee, and that the
// offered wage fits the budget. One live offer per (team, agent) — a new one supersedes the old.
export function offerToFreeAgent(teamId: number, agentId: number, wage: number, years: number): { ok: boolean; error?: string; player?: string; wage?: number; years?: number } {
  return tx(() => {
    const team = teamRow(teamId);
    if (!team) return { ok: false, error: 'team not found' };
    // NB: NO transfer-window gate — free agents are signable any time (matches buyFreeAgent, the AI path,
    // and the "signable any time" market copy). Only club-to-club deals are window-gated.
    const agent = db.prepare('SELECT id, name, role, value, wage FROM free_agents WHERE id = ? AND league_id = ?').get(agentId, team.league_id) as { id: number; name: string; role: string; value: number; wage: number | null } | undefined;
    if (!agent) return { ok: false, error: 'free agent not available' };
    const w = Math.round(wage), y = Math.round(years);
    if (!Number.isFinite(w) || w <= 0) return { ok: false, error: 'enter a valid wage' };
    if (!Number.isFinite(y) || y < FA_OFFER_MIN_YEARS || y > FA_OFFER_MAX_YEARS) return { ok: false, error: `contract length must be ${FA_OFFER_MIN_YEARS}–${FA_OFFER_MAX_YEARS} years` };
    if (teamPlayers(teamId).length >= SQUAD_MAX) return { ok: false, error: `squad full (max ${SQUAD_MAX})` };
    if (team.budget < agent.value) return { ok: false, error: 'not enough budget for his signing-on fee' };
    if (wageBill(teamId) + w > team.wage_budget) return { ok: false, error: 'not enough wage budget for that wage' };
    const cur = transferWindow(team.league_id).current;
    db.prepare("UPDATE free_agent_offers SET status='withdrawn' WHERE buyer_team_id=? AND free_agent_id=? AND status='pending'").run(teamId, agentId);
    db.prepare("INSERT INTO free_agent_offers (buyer_team_id, free_agent_id, player_name, role, wage, years, status, created_round, expires_round, created_at) VALUES (?,?,?,?,?,?,'pending',?,?,?)")
      .run(teamId, agentId, agent.name, agent.role, w, y, cur, cur + OFFER_TTL, Date.now());
    return { ok: true, player: agent.name, wage: w, years: y };
  });
}

// The manager's free-agent negotiations in progress (the agent still in the pool).
export function freeAgentOffersForTeam(teamId: number): FreeAgentOfferView[] {
  return (db.prepare(`SELECT o.id, o.free_agent_id AS agentId, o.wage, o.years, o.status, fa.name, fa.role, fa.wage AS demand
    FROM free_agent_offers o JOIN free_agents fa ON fa.id = o.free_agent_id
    WHERE o.buyer_team_id = ? AND o.status = 'pending' ORDER BY o.id DESC`).all(teamId) as
    { id: number; agentId: number; wage: number; years: number; status: string; name: string; role: string; demand: number | null }[])
    .map(o => ({ id: o.id, agentId: o.agentId, name: o.name, role: o.role, wage: o.wage, years: o.years, demand: o.demand ?? 0, status: o.status }));
}

// Resolve pending free-agent offers at a matchday: the agent accepts if the wage meets his demand (then
// signs at the OFFERED terms), else turns it down; stale offers expire. Call from the advance tick.
export function resolveFreeAgentOffers(leagueId: number): FreeAgentEvent[] {
  return tx(() => {
    const events: FreeAgentEvent[] = [];
    const cur = transferWindow(leagueId).current;
    const offers = db.prepare(`SELECT o.id, o.buyer_team_id, o.free_agent_id, o.player_name, o.role, o.wage, o.years, o.expires_round
      FROM free_agent_offers o JOIN teams t ON t.id = o.buyer_team_id
      WHERE o.status = 'pending' AND t.league_id = ?`).all(leagueId) as
      { id: number; buyer_team_id: number; free_agent_id: number; player_name: string; role: string; wage: number; years: number; expires_round: number }[];
    const setStatus = db.prepare('UPDATE free_agent_offers SET status = ? WHERE id = ?');
    for (const o of offers) {
      if (cur > o.expires_round) { setStatus.run('expired', o.id); events.push({ teamId: o.buyer_team_id, type: 'fa_expired', player: o.player_name, role: o.role, wage: o.wage, years: o.years }); continue; }   // lapsed unanswered — tell the manager (was silent)
      const team = teamRow(o.buyer_team_id);
      const agent = db.prepare('SELECT id, league_id, name, role, attrs, age, potential, personality, value, wage, foot FROM free_agents WHERE id = ?').get(o.free_agent_id) as FARow | undefined;
      if (!team) { setStatus.run('rejected', o.id); continue; }   // buyer team gone (degenerate)
      // the agent left the pool while we deliberated — a rival club (AI recruitment in the same tick) signed
      // him first. Tell the manager he lost the race rather than failing silently (snapshot name/role).
      if (!agent) { setStatus.run('rejected', o.id); events.push({ teamId: o.buyer_team_id, type: 'fa_gone', player: o.player_name, role: o.role, wage: o.wage, years: o.years }); continue; }
      const demand = agent.wage ?? 0;
      // the agent wants his market wage; a lowball is turned down
      if (o.wage < demand) { setStatus.run('rejected', o.id); events.push({ teamId: o.buyer_team_id, type: 'fa_rejected', player: agent.name, role: agent.role, wage: o.wage, years: o.years }); continue; }
      // re-check squad/budget at resolution (state may have shifted since the offer)
      const players = teamPlayers(o.buyer_team_id);
      if (players.length >= SQUAD_MAX || team.budget < agent.value || wageBill(o.buyer_team_id) + o.wage > team.wage_budget) {
        setStatus.run('rejected', o.id); events.push({ teamId: o.buyer_team_id, type: 'fa_rejected', player: agent.name, role: agent.role, wage: o.wage, years: o.years }); continue;
      }
      placeRecruit(team, players, { name: agent.name, role: agent.role, attrsJson: agent.attrs, age: agent.age, potential: agent.potential, personalityJson: agent.personality, wage: o.wage, contractYears: o.years, foot: agent.foot ?? 1 });
      db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(agent.value, o.buyer_team_id);
      db.prepare('DELETE FROM free_agents WHERE id = ?').run(agent.id);
      recordFinance(o.buyer_team_id, 'transfer_in', -agent.value, `Signed free agent ${agent.name}`);
      setStatus.run('accepted', o.id);
      db.prepare("UPDATE free_agent_offers SET status='rejected' WHERE free_agent_id=? AND status='pending' AND id != ?").run(agent.id, o.id);
      events.push({ teamId: o.buyer_team_id, type: 'fa_signed', player: agent.name, role: agent.role, wage: o.wage, years: o.years });
    }
    return events;
  });
}

// Release one player onto the free-agent pool (contract expiry). Snapshots them into
// free_agents (attrs/age/potential/personality/value/wage) then removes them from the squad.
export function releasePlayerToFreeAgents(teamId: number, slot: number): boolean {
  const t = teamRow(teamId); if (!t) return false;
  const p = db.prepare('SELECT name, role, attrs, age, potential, personality, wage, foot FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; wage: number | null; foot: number | null } | undefined;
  if (!p) return false;
  const attrs = JSON.parse(p.attrs);
  const value = playerValue(attrs, p.age, parseJSON(p.personality));
  db.prepare('INSERT INTO free_agents (league_id, name, role, attrs, personality, age, potential, value, wage, foot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.league_id, p.name, p.role, p.attrs, p.personality, p.age, p.potential, value, p.wage ?? playerWage(attrs, p.age, parseJSON(p.personality)), p.foot ?? 1);
  return removePlayerFromSquad(teamId, slot);
}

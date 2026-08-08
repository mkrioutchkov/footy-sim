// Transfer market (pillar 1). Teams have a budget (db.ts); they sign free agents,
// transfer-list their own players, and the AI fills its weakest role each matchday.
//
// Roster model: a squad of 11..24, of which the first 11 by slot start (see
// specForTeam in match.ts). Signing a player who upgrades a starter's role swaps
// them into the XI (displacing the weaker man to the bench) ONLY while the team is
// on the identity XI; otherwise they join the bench so a hand-picked lineup is never
// silently rearranged. Selling removes a player and renumbers the squad.
//
// The domain is split across market/ — this file keeps the two READ MODELS the UI renders
// (the club's market screen and the Scouting Centre) and stays the single import seam, so
// every `from './market.ts'` in the backend, the routes and the test suites still resolves:
//   market/shared.ts      row shapes, readers, the tx wrapper, the squad bounds, the world's leagues
//   market/window.ts      WHEN club-to-club business is allowed (transferWindow)
//   market/squad.ts       squad plumbing: place / backfill / renumber / remove / transfer a player
//   market/listings.ts    the for-sale board: list, unlist, targets, release clauses, AI restocking
//   market/offers.ts      the club-to-club offer lifecycle (§2.1 signing drama), both directions
//   market/freeagents.ts  the free-agent pool: instant signings, wage negotiations, releases
//   market/loans.ts       loanIn / loanOut / endLoan / returnLoans
//   market/tick.ts        one matchday's market: the §2.4 deadline sweep + the AI's transfers
import { db } from './db.ts';
import { overall, playerValue, ROLE_SLOTS } from './game.ts';
import { scoutDepth } from './staff.ts';
import { fogAttrs, scoutWidthForDepth, type ScoutAttr } from './scout.ts';
import { shortlistIds } from './shortlist.ts';
import { parseJSON, teamRow, wageBill, worldLeagueIds, SQUAD_MAX, SQUAD_MIN, type PRow } from './market/shared.ts';
import { transferWindow, type TransferWindow } from './market/window.ts';
import { transferTargets, type TransferTarget } from './market/listings.ts';

// ── Scouting Centre: search the whole player population of the buyer's world ──────────────────────
// FM's recruitment hub: hunt targets by role/age/overall/value/name across every club in the world,
// not just the handful currently transfer-listed. Attributes come back FOGGED to the club's scout
// depth (reusing the opponent-report fog), so better scouting means a sharper read. `buyable` marks the
// players you can actually bid for right now (listed or with a release clause) — the rest are viewable
// and shortlistable but "not for sale", exactly as FM lets you scout anyone. Loaned-in players and the
// buyer's own squad are excluded. Capped and ordered by overall.
export interface PlayerSearchFilters { role?: string; maxAge?: number; minOverall?: number; maxValue?: number; name?: string; onlyShortlisted?: boolean; limit?: number }
export interface ScoutedPlayer {
  id: number; name: string; club: string; clubTeamId: number; role: string; age: number;
  overall: number; potential: number | null; value: number; wage: number;
  askPrice: number | null; releaseClause: number | null; buyable: boolean; shortlisted: boolean;
  attrs: ScoutAttr[] | null;   // fogged to the club's scout depth (null = no picture at all)
}
export function searchPlayers(teamId: number, f: PlayerSearchFilters = {}): { depth: number; players: ScoutedPlayer[] } {
  const team = teamRow(teamId); if (!team) return { depth: 0, players: [] };
  const leagueIds = worldLeagueIds(team.league_id);
  const ph = leagueIds.map(() => '?').join(',');
  // SQL-level filters that are cheap + indexable (role/age/name); overall + value are computed from
  // attrs in JS below (they're derived, not stored). Own club + loaned-in players excluded up front.
  const conds: string[] = [`t.league_id IN (${ph})`, 'p.team_id != ?', 'p.parent_team_id IS NULL'];
  const params: (string | number)[] = [...leagueIds, teamId];
  const role = typeof f.role === 'string' && (ROLE_SLOTS as readonly string[]).includes(f.role) ? f.role : null;
  if (role) { conds.push('p.role = ?'); params.push(role); }
  if (Number.isFinite(f.maxAge)) { conds.push('p.age <= ?'); params.push(Math.round(f.maxAge!)); }
  if (typeof f.name === 'string' && f.name.trim()) { conds.push('p.name LIKE ?'); params.push(`%${f.name.trim().replace(/[%_]/g, '')}%`); }
  const rows = db.prepare(`SELECT p.id, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.release_clause, p.wage,
      t.id AS club_team_id, t.name AS club
    FROM players p JOIN teams t ON t.id = p.team_id
    WHERE ${conds.join(' AND ')}`).all(...params) as unknown as
    (PRow & { release_clause: number | null; club_team_id: number; club: string })[];
  const shortlisted = new Set(shortlistIds(teamId));
  const onlyShort = !!f.onlyShortlisted;
  const minOverall = Number.isFinite(f.minOverall) ? Math.round(f.minOverall!) : null;
  const maxValue = Number.isFinite(f.maxValue) ? f.maxValue! : null;
  const width = scoutWidthForDepth(scoutDepth(teamId));
  const limit = Math.min(80, Math.max(1, Math.round(f.limit ?? 40)));
  const out: ScoutedPlayer[] = [];
  for (const r of rows) {
    if (onlyShort && !shortlisted.has(r.id)) continue;
    const attrs = JSON.parse(r.attrs);
    const ov = overall(attrs, r.role);
    if (minOverall != null && ov < minOverall) continue;
    const value = playerValue(attrs, r.age, parseJSON(r.personality), r.role);
    if (maxValue != null && value > maxValue) continue;
    out.push({
      id: r.id, name: r.name, club: r.club, clubTeamId: r.club_team_id, role: r.role, age: r.age,
      overall: ov, potential: r.potential, value, wage: r.wage ?? 0,
      askPrice: r.ask_price, releaseClause: r.release_clause,
      buyable: r.listed === 1 || r.release_clause != null, shortlisted: shortlisted.has(r.id),
      attrs: fogAttrs(attrs, width),
    });
  }
  // best players first; buyable ones tie-break up so actionable targets surface. Cap AFTER sorting.
  out.sort((a, b) => b.overall - a.overall || Number(b.buyable) - Number(a.buyable) || a.value - b.value);
  return { depth: scoutDepth(teamId), players: out.slice(0, limit) };
}

export interface MarketView {
  budget: number; wageBudget: number; wageBill: number; squadMax: number; squadMin: number;
  window: TransferWindow;
  freeAgents: { id: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number }[];
  squad: { slot: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; contractYears: number; listed: boolean; askPrice: number | null; starter: boolean; onLoan: boolean; loanFrom: string | null; loanUntil: number | null }[];
  transferTargets: TransferTarget[];
}

export function getMarket(teamId: number): MarketView | null {
  const team = teamRow(teamId);
  if (!team) return null;
  const freeAgents = (db.prepare('SELECT id, name, role, attrs, age, potential, value, wage FROM free_agents WHERE league_id = ? ORDER BY value DESC').all(team.league_id) as
    { id: number; name: string; role: string; attrs: string; age: number; potential: number | null; value: number; wage: number | null }[])
    .map(a => ({ id: a.id, name: a.name, role: a.role, age: a.age, overall: overall(JSON.parse(a.attrs), a.role), potential: a.potential, value: a.value, wage: a.wage ?? 0 }));
  const players = db.prepare(`SELECT p.slot, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.wage, p.contract_years, p.parent_team_id, p.loan_until, pt.name AS loan_from
    FROM players p LEFT JOIN teams pt ON pt.id = p.parent_team_id WHERE p.team_id = ? ORDER BY p.slot`)
    .all(teamId) as unknown as (PRow & { contract_years: number; parent_team_id: number | null; loan_until: number | null; loan_from: string | null })[];
  const squad = players.map((p, i) => {
    const attrs = JSON.parse(p.attrs);
    return { slot: p.slot, name: p.name, role: p.role, age: p.age, overall: overall(attrs, p.role), potential: p.potential, value: playerValue(attrs, p.age, parseJSON(p.personality), p.role), wage: p.wage ?? 0, contractYears: p.contract_years, listed: !!p.listed, askPrice: p.ask_price, starter: i < 11, onLoan: p.parent_team_id != null, loanFrom: p.loan_from, loanUntil: p.loan_until };
  });
  return { budget: team.budget, wageBudget: team.wage_budget, wageBill: wageBill(teamId), squadMax: SQUAD_MAX, squadMin: SQUAD_MIN, window: transferWindow(team.league_id), freeAgents, squad, transferTargets: transferTargets(teamId) };
}

// ── The import seam ───────────────────────────────────────────────────────────────────────────────
// Exactly the surface market.ts exported before the split — same names, same signatures, same
// semantics — so routes/market.ts, season.ts, youth.ts, concerns.ts, contracts.ts, manager/
// transfers.ts, routes/world.ts, routes/manager.ts, routes/team.ts and the tools/_*_test.ts suites
// need no change. Module-private helpers (createIncomingOffer, OFFER_TTL, …) stay unexported here.
export { SQUAD_MAX, SQUAD_MIN } from './market/shared.ts';
export { transferWindow } from './market/window.ts';
export type { TransferWindow } from './market/window.ts';
export { backfillStarterSlot, removePlayerFromSquad } from './market/squad.ts';
export { listPlayer, unlistPlayer, transferTargets, seedReleaseClauses, aiListSurplus } from './market/listings.ts';
export type { TransferTarget } from './market/listings.ts';
export { bidForPlayer, processOffers, incomingOffersForTeam, acceptIncomingOffer, rejectIncomingOffer, offersForTeam, withdrawOffer, matchCounter } from './market/offers.ts';
export type { BidResult, OfferEvent, OfferView, IncomingOfferView } from './market/offers.ts';
export { buyFreeAgent, offerToFreeAgent, freeAgentOffersForTeam, resolveFreeAgentOffers, releasePlayerToFreeAgents } from './market/freeagents.ts';
export type { BuyResult, FreeAgentOfferView, FreeAgentEventType, FreeAgentEvent } from './market/freeagents.ts';
export { loanIn, loanOut, endLoan, returnLoans } from './market/loans.ts';
export type { LoanResult } from './market/loans.ts';
export { marketTick } from './market/tick.ts';
export type { MarketEvent } from './market/tick.ts';

// market/tick.ts — one matchday's market: the deadline sweep that lapses unsold listings (§2.4) and
// the AI clubs' own transfer activity. This is the only module that decides anything on its own
// initiative; every other market module reacts to something a manager asked for. It orchestrates
// the rest (offers → listings upkeep → per-club recruitment → restock), so it sits at the top of
// the dependency order and nothing imports it back.
import { db } from '../db.ts';
import { overall } from '../game.ts';
import { teamPlayers, teamRow, tx, wageBill, SQUAD_MAX, SQUAD_MIN, type FARow, type PRow, weakestRole } from './shared.ts';
import { transferWindow, type TransferWindow } from './window.ts';
import { transferListed } from './squad.ts';
import { aiListSurplus, seedReleaseClauses } from './listings.ts';
import { createIncomingOffer, processOffers } from './offers.ts';
import { buyFreeAgent } from './freeagents.ts';

// The role whose weakest XI starter is poorest — the AI's upgrade target.

export interface MarketEvent { teamId: number; teamName: string; type: 'sign' | 'buy_listed' | 'listing_expired' | 'incoming_bid'; player: string; role: string; fee: number; from?: string; }

// §2.4: maintain transfer listings against the deadline. While a window is open, stamp any live listing
// with that window's deadline; once the deadline passes, an unsold listing lapses (auto-unlisted) — a
// 'listing_expired' event for human clubs (AI never lists). Cross-season-safe: a listing made while shut
// has listed_until NULL until the next open window stamps it here.
function expireListings(leagueId: number, win: TransferWindow): MarketEvent[] {
  if (win.open && win.deadline != null) {
    db.prepare('UPDATE players SET listed_until = ? WHERE listed = 1 AND listed_until IS NULL AND team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(win.deadline, leagueId);
  }
  const lapsed = db.prepare(`SELECT p.name, p.role, t.id AS team_id, t.name AS team_name FROM players p JOIN teams t ON t.id = p.team_id
      WHERE p.listed = 1 AND p.listed_until IS NOT NULL AND p.listed_until < ? AND t.league_id = ? AND t.user_id IS NOT NULL`)
    .all(win.current, leagueId) as { name: string; role: string; team_id: number; team_name: string }[];
  db.prepare('UPDATE players SET listed = 0, ask_price = NULL, listed_until = NULL WHERE listed = 1 AND listed_until IS NOT NULL AND listed_until < ? AND team_id IN (SELECT id FROM teams WHERE league_id = ?)').run(win.current, leagueId);
  return lapsed.map(l => ({ teamId: l.team_id, teamName: l.team_name, type: 'listing_expired' as const, player: l.name, role: l.role, fee: 0 }));
}

// One matchday's AI market activity: each AI team makes at most one move — sign the
// best affordable free agent that upgrades its weakest role, else buy a (cheaper,
// upgrading) transfer-listed player of that role from another team. Keeps the world
// alive and gives the user's listings a buyer. Re-reads state per team so earlier
// buys are seen by later ones.
export function marketTick(leagueId: number): MarketEvent[] {
  const events: MarketEvent[] = [];
  seedReleaseClauses([leagueId]);   // §release-clause: ensure each AI club's best man carries a clause (idempotent)
  processOffers(leagueId);   // §2.1: resolve the human's pending club-to-club bids FIRST (against the live ask price), so a
  events.push(...expireListings(leagueId, transferWindow(leagueId)));   // §2.4: deadline-day bid still completes before its listing lapses below
  const aiTeams = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id').all(leagueId) as { id: number }[];
  for (const { id } of aiTeams) {
    const team = teamRow(id); if (!team) continue;
    const players = teamPlayers(id);
    if (players.length >= SQUAD_MAX) continue;
    const weak = weakestRole(players); if (!weak) continue;
    const headroom = team.wage_budget - wageBill(id);          // wages the club can still take on

    // 1) Best free agent of the weak role that beats the weak link AND fits both budgets.
    const fas = db.prepare('SELECT * FROM free_agents WHERE league_id = ? AND role = ? AND value <= ? ORDER BY value DESC')
      .all(leagueId, weak.role, team.budget) as unknown as FARow[];
    const recruit = fas.find(a => overall(JSON.parse(a.attrs), a.role) > weak.target && (a.wage ?? 0) <= headroom);
    if (recruit) {
      const r = buyFreeAgent(id, recruit.id);
      if (r.ok) { events.push({ teamId: id, teamName: team.name, type: 'sign', player: recruit.name, role: recruit.role, fee: recruit.value }); continue; }
    }

    // 2) Else a transfer-listed player of the weak role from another team (seller must
    // keep a legal XI), cheapest first, that upgrades the weak link + fits the wage budget.
    // Club-to-club deals only when the window is open (free-agent signings above are not gated).
    if (!transferWindow(leagueId).open) continue;
    const listings = db.prepare(`
      SELECT p.id, p.slot, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.wage, p.contract_years, p.foot,
             p.team_id AS seller_id, t.name AS seller_name, t.user_id AS seller_user_id,
             (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
      FROM players p JOIN teams t ON t.id = p.team_id
      WHERE t.league_id = ? AND p.listed = 1 AND p.team_id != ? AND p.role = ? AND p.ask_price <= ?
      ORDER BY p.ask_price ASC`).all(leagueId, id, weak.role, team.budget) as unknown as (PRow & { seller_id: number; seller_name: string; seller_user_id: number | null; seller_count: number })[];
    const pick = listings.find(l => l.seller_count > SQUAD_MIN && overall(JSON.parse(l.attrs), l.role) > weak.target && (l.wage ?? 0) <= headroom);
    if (pick && pick.seller_user_id != null) {
      // §2.1: an AI can't just take a HUMAN's listed player — it tables a PENDING INCOMING offer the
      // manager accepts / rejects (the other half of the signing drama). Multiple AIs = an auction.
      if (createIncomingOffer(id, pick.seller_id, pick.id, pick.ask_price!, leagueId))
        events.push({ teamId: pick.seller_id, teamName: pick.seller_name, type: 'incoming_bid', player: pick.name, role: pick.role, fee: pick.ask_price!, from: team.name });
    } else if (pick) {
      tx(() => transferListed(id, pick.seller_id, pick, pick.ask_price!));   // AI-to-AI: still instant
      events.push({ teamId: id, teamName: team.name, type: 'buy_listed', player: pick.name, role: pick.role, fee: pick.ask_price!, from: pick.seller_name });
    }
  }
  aiListSurplus(leagueId);   // §P2: keep the for-sale market stocked so the human always has someone to bid for
  return events;
}

// market/offers.ts — the club-to-club offer lifecycle (§2.1 signing drama), both directions: the
// human's outgoing bid, the AI seller's verdict at the matchday tick, the auction when several
// clubs chase one man, the AI's INCOMING bid for a human's listed player, and the withdraw /
// match-counter / accept / reject endpoints. Everything here trades in `transfer_offers` rows;
// the actual squad+money move is transferListed (squad.ts), reached only via completeOffer.
import { db } from '../db.ts';
import { playerValue } from '../game.ts';
import { parseJSON, teamPlayers, teamRow, tx, wageBill, worldLeagueIds, SQUAD_MAX, SQUAD_MIN, type PRow } from './shared.ts';
import { transferWindow } from './window.ts';
import { transferListed } from './squad.ts';

export interface BidResult { ok: boolean; status: 'pending' | 'accepted' | 'countered' | 'rejected' | 'error'; error?: string; counterFee?: number; player?: string; club?: string; fee?: number; placed?: 'xi' | 'bench' }

// Bid for another club's player (§2.1 signing drama). A bid is NO LONGER instant: it creates a
// PENDING offer the selling club resolves at the NEXT matchday tick (processOffers) — accept,
// counter, or reject — with a short round-based expiry, and multiple bids on one player become an
// auction. Here we only validate intent + a budget sanity check and record the pending offer; the
// buyer's books are RE-checked at acceptance, since state can move first. Window-gated.
const UNLISTED_PREMIUM = 1.4;   // multiple of value to prise away a player his club hasn't listed
const COUNTER_FLOOR = 0.8;      // bids within this fraction of the ask get a counter, not a rejection
export const OFFER_TTL = 2;     // matchdays a pending/countered offer survives before it lapses
export function bidForPlayer(buyerTeamId: number, targetPlayerId: number, fee: number): BidResult {
  const buyer = teamRow(buyerTeamId);
  if (!buyer) return { ok: false, status: 'error', error: 'team not found' };
  if (!transferWindow(buyer.league_id).open) return { ok: false, status: 'error', error: 'the transfer window is shut' };
  if (!Number.isFinite(fee) || fee <= 0) return { ok: false, status: 'error', error: 'enter a valid bid' };
  const bid = Math.round(fee);
  const t = db.prepare(`SELECT p.id, p.team_id, p.name, p.parent_team_id, p.release_clause, tm.name AS club, tm.league_id AS seller_league,
      (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
    FROM players p JOIN teams tm ON tm.id = p.team_id WHERE p.id = ?`)
    .get(targetPlayerId) as { id: number; team_id: number; name: string; parent_team_id: number | null; release_clause: number | null; club: string; seller_league: number; seller_count: number } | undefined;
  if (!t) return { ok: false, status: 'error', error: 'player not found' };
  if (t.team_id === buyerTeamId) return { ok: false, status: 'error', error: 'already your player' };
  if (t.parent_team_id != null) return { ok: false, status: 'error', error: `${t.name} is out on loan — not available to buy` };
  if (!worldLeagueIds(buyer.league_id).includes(t.seller_league)) return { ok: false, status: 'error', error: 'player is outside your world' };
  if (t.seller_count <= SQUAD_MIN) return { ok: false, status: 'rejected', club: t.club, player: t.name, error: `${t.club} won't sell ${t.name} — their squad is at the minimum` };
  if (buyer.budget < bid) return { ok: false, status: 'error', error: 'not enough budget for that fee' };
  if (teamPlayers(buyerTeamId).length >= SQUAD_MAX) return { ok: false, status: 'error', error: `squad full (max ${SQUAD_MAX})` };
  const cur = transferWindow(buyer.league_id).current;
  // one live bid per (buyer, player): a new bid supersedes a prior pending/countered one.
  db.prepare("UPDATE transfer_offers SET status='withdrawn' WHERE buyer_team_id=? AND player_id=? AND status IN ('pending','countered')").run(buyerTeamId, t.id);
  const info = db.prepare(`INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(buyerTeamId, t.team_id, t.id, bid, cur, cur + OFFER_TTL, Date.now());
  // §release-clause: a bid AT OR ABOVE the clause is BINDING — it completes AT ONCE (bypassing the club's
  // verdict + the matchday wait, FM's clause trigger), still window-gated with the buyer's books re-checked.
  if (t.release_clause != null && bid >= t.release_clause) {
    const offerId = Number(info.lastInsertRowid);
    const o = db.prepare('SELECT * FROM transfer_offers WHERE id = ?').get(offerId) as unknown as OfferRow;
    const done = completeOffer(o);
    if (!done.ok) {
      db.prepare("UPDATE transfer_offers SET status='rejected' WHERE id = ?").run(offerId);
      return { ok: false, status: 'error', error: 'the clause deal fell through — check your budget + wage room.' };
    }
    db.prepare("UPDATE transfer_offers SET status='accepted' WHERE id = ?").run(offerId);
    return { ok: true, status: 'accepted', player: t.name, club: t.club, fee: bid, placed: done.placed };
  }
  return { ok: true, status: 'pending', player: t.name, club: t.club, fee: bid };
}

interface OfferRow { id: number; buyer_team_id: number; seller_team_id: number; player_id: number; fee: number; status: string; counter_fee: number | null; created_round: number; expires_round: number }
export interface OfferEvent { buyerTeamId: number; player: string; result: 'accepted' | 'countered' | 'rejected' | 'expired'; fee: number; counterFee?: number; club?: string }
export interface OfferView { id: number; playerId: number; playerName: string; club: string; fee: number; status: string; counterFee: number | null }

// The selling club's verdict on a pending bid — re-fetch the player (it may have moved/been sold),
// then the same threshold logic the old instant bid used: accept >= ask/premium, counter within
// COUNTER_FLOOR, else reject. Pure read.
function evaluateOffer(o: OfferRow): { result: 'accept' | 'counter' | 'reject'; counter?: number } {
  const p = db.prepare(`SELECT p.attrs, p.age, p.personality, p.listed, p.ask_price, p.parent_team_id, p.team_id,
      (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count FROM players p WHERE p.id = ?`)
    .get(o.player_id) as { attrs: string; age: number; personality: string | null; listed: number; ask_price: number | null; parent_team_id: number | null; team_id: number; seller_count: number } | undefined;
  if (!p || p.team_id !== o.seller_team_id || p.parent_team_id != null || p.seller_count <= SQUAD_MIN) return { result: 'reject' };
  const value = playerValue(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const threshold = p.listed && p.ask_price ? p.ask_price : Math.round(value * UNLISTED_PREMIUM);
  if (o.fee >= threshold) return { result: 'accept' };
  if (o.fee >= Math.round(threshold * COUNTER_FLOOR)) return { result: 'counter', counter: threshold };
  return { result: 'reject' };
}

// Execute an accepted/matched offer — RE-check the buyer's books (state may have moved since the
// bid), then run the proven transferListed completion. Returns ok=false (deal collapses) if not.
function completeOffer(o: OfferRow): { ok: boolean; placed?: 'xi' | 'bench'; player?: string; club?: string } {
  const buyer = teamRow(o.buyer_team_id);
  const p = db.prepare(`SELECT p.*, (SELECT name FROM teams WHERE id = ?) AS club FROM players p WHERE p.id = ?`)
    .get(o.seller_team_id, o.player_id) as (PRow & { team_id: number; parent_team_id: number | null; club: string }) | undefined;
  if (!buyer || !p || p.team_id !== o.seller_team_id || p.parent_team_id != null) return { ok: false };
  // the SELLER must keep a legal XI — re-checked at COMPLETION, not just at offer creation, so accepting
  // a second incoming bid (or any stale offer) can't drop the squad below SQUAD_MIN (review fix).
  if (teamPlayers(o.seller_team_id).length <= SQUAD_MIN) return { ok: false };
  if (buyer.budget < o.fee || teamPlayers(o.buyer_team_id).length >= SQUAD_MAX || wageBill(o.buyer_team_id) + (p.wage ?? 0) > buyer.wage_budget) return { ok: false };
  const placed = tx(() => transferListed(o.buyer_team_id, o.seller_team_id, p as PRow, o.fee));
  return { ok: true, placed, player: p.name, club: p.club };
}

// Resolve pending club-to-club offers from buyers in this league at the matchday tick. AUCTION:
// per target player the highest qualifying fee wins, the rest are rejected; near-misses get a
// counter; stale pending/countered offers expire. Called at the start of marketTick.
export function processOffers(leagueId: number): OfferEvent[] {
  const events: OfferEvent[] = [];
  const cur = transferWindow(leagueId).current;
  const setStatus = db.prepare('UPDATE transfer_offers SET status = ? WHERE id = ?');
  // Only AUTO-resolve offers whose SELLER is AI (the seller's verdict is automated). An offer on a HUMAN's
  // listed player is an INCOMING bid the manager resolves himself (acceptIncomingOffer) — skip it here.
  const pending = db.prepare(`SELECT o.*, COALESCE(pl.name, '') AS player_name FROM transfer_offers o
      JOIN teams b ON b.id = o.buyer_team_id JOIN teams st ON st.id = o.seller_team_id LEFT JOIN players pl ON pl.id = o.player_id
      WHERE o.status = 'pending' AND b.league_id = ? AND st.user_id IS NULL ORDER BY o.player_id, o.fee DESC, o.id ASC`)
    .all(leagueId) as unknown as (OfferRow & { player_name: string })[];
  const sold = new Set<number>();
  for (const o of pending) {
    const ev = (result: OfferEvent['result'], counterFee?: number, club?: string): void => { events.push({ buyerTeamId: o.buyer_team_id, player: o.player_name, result, fee: o.fee, counterFee, club }); };
    if (cur > o.expires_round) { setStatus.run('expired', o.id); ev('expired'); continue; }
    if (sold.has(o.player_id)) { setStatus.run('rejected', o.id); ev('rejected'); continue; }   // outbid in this auction
    const d = evaluateOffer(o);
    if (d.result === 'accept') {
      const done = completeOffer(o);
      if (done.ok) { sold.add(o.player_id); setStatus.run('accepted', o.id); ev('accepted', undefined, done.club); }
      else { setStatus.run('rejected', o.id); ev('rejected'); }
    } else if (d.result === 'counter') {
      db.prepare("UPDATE transfer_offers SET status='countered', counter_fee=? WHERE id=?").run(d.counter ?? o.fee, o.id); ev('countered', d.counter);
    } else { setStatus.run('rejected', o.id); ev('rejected'); }
  }
  // a countered offer the buyer never matched also lapses
  db.prepare("UPDATE transfer_offers SET status='expired' WHERE status='countered' AND expires_round < ? AND buyer_team_id IN (SELECT id FROM teams WHERE league_id = ?)").run(cur, leagueId);
  // §2.1: an INCOMING bid (seller = human) the manager left unanswered past its window also lapses
  db.prepare("UPDATE transfer_offers SET status='expired' WHERE status = 'pending' AND expires_round < ? AND seller_team_id IN (SELECT id FROM teams WHERE league_id = ? AND user_id IS NOT NULL)").run(cur, leagueId);
  return events;
}

// §2.1 incoming offers (AI → HUMAN). An AI club tables a pending bid for the human's listed player
// (createIncomingOffer, from marketTick); the manager resolves it. One live bid per buyer/player so the
// board doesn't spam, but several clubs may bid on the same man (an auction the human picks from).
export function createIncomingOffer(buyerId: number, sellerId: number, playerId: number, fee: number, leagueId: number): boolean {
  if (db.prepare("SELECT 1 FROM transfer_offers WHERE buyer_team_id = ? AND player_id = ? AND status IN ('pending','countered')").get(buyerId, playerId)) return false;
  const cur = transferWindow(leagueId).current;
  db.prepare(`INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(buyerId, sellerId, playerId, fee, cur, cur + OFFER_TTL, Date.now());
  return true;
}

export interface IncomingOfferView { id: number; club: string; playerSlot: number | null; playerName: string; fee: number; status: string; }
// The club's incoming bids (other clubs bidding for YOUR listed players): live + recently-resolved.
export function incomingOffersForTeam(teamId: number): IncomingOfferView[] {
  return (db.prepare(`SELECT o.id, b.name AS club, o.fee, o.status, COALESCE(pl.name, '(sold / departed)') AS player_name, pl.slot AS player_slot
      FROM transfer_offers o JOIN teams b ON b.id = o.buyer_team_id LEFT JOIN players pl ON pl.id = o.player_id
      WHERE o.seller_team_id = ? AND o.status IN ('pending','accepted','rejected') ORDER BY o.id DESC LIMIT 20`)
    .all(teamId) as unknown as { id: number; club: string; fee: number; status: string; player_name: string; player_slot: number | null }[])
    .map(r => ({ id: r.id, club: r.club, playerSlot: r.player_slot, playerName: r.player_name, fee: r.fee, status: r.status }));
}

// Accept an incoming bid — sell the player to the bidding club at his fee (the buyer's books are
// re-checked, since they may have moved). Rejects any rival pending bids on the now-sold player.
export function acceptIncomingOffer(teamId: number, offerId: number): { ok: boolean; error?: string; club?: string; player?: string; fee?: number } {
  const o = db.prepare("SELECT * FROM transfer_offers WHERE id = ? AND seller_team_id = ? AND status = 'pending'").get(offerId, teamId) as unknown as OfferRow | undefined;
  if (!o) return { ok: false, error: 'no such live offer' };
  // a club-to-club sale needs an open window — a late-landing bid can outlive the window by OFFER_TTL,
  // so gate ACCEPTANCE too (every other transfer path is window-gated; review fix).
  const seller = teamRow(teamId);
  if (seller && !transferWindow(seller.league_id).open) return { ok: false, error: 'the transfer window is shut' };
  const player = (db.prepare('SELECT name FROM players WHERE id = ?').get(o.player_id) as { name: string } | undefined)?.name;
  const buyerName = (db.prepare('SELECT name FROM teams WHERE id = ?').get(o.buyer_team_id) as { name: string } | undefined)?.name;
  const done = completeOffer(o);
  if (!done.ok) return { ok: false, error: 'the deal fell through — the bidding club’s books moved' };
  db.prepare("UPDATE transfer_offers SET status = 'accepted' WHERE id = ?").run(offerId);
  db.prepare("UPDATE transfer_offers SET status = 'rejected' WHERE player_id = ? AND status = 'pending' AND id != ?").run(o.player_id, offerId);
  return { ok: true, club: buyerName, player, fee: o.fee };
}

export function rejectIncomingOffer(teamId: number, offerId: number): { ok: boolean; error?: string } {
  const o = db.prepare("SELECT id FROM transfer_offers WHERE id = ? AND seller_team_id = ? AND status = 'pending'").get(offerId, teamId) as { id: number } | undefined;
  if (!o) return { ok: false, error: 'no such live offer' };
  db.prepare("UPDATE transfer_offers SET status = 'rejected' WHERE id = ?").run(offerId);
  return { ok: true };
}

// A buyer's recent offers (outgoing) for the UI: live + recently-resolved, newest first.
export function offersForTeam(teamId: number): OfferView[] {
  return (db.prepare(`SELECT o.id, o.player_id, o.fee, o.status, o.counter_fee, COALESCE(pl.name, '(left the club)') AS player_name, s.name AS club
      FROM transfer_offers o JOIN teams s ON s.id = o.seller_team_id LEFT JOIN players pl ON pl.id = o.player_id
      WHERE o.buyer_team_id = ? AND o.status IN ('pending','countered','accepted','rejected') ORDER BY o.id DESC LIMIT 20`)
    .all(teamId) as unknown as { id: number; player_id: number; fee: number; status: string; counter_fee: number | null; player_name: string; club: string }[])
    .map(r => ({ id: r.id, playerId: r.player_id, playerName: r.player_name, club: r.club, fee: r.fee, status: r.status, counterFee: r.counter_fee }));
}

// Pull a live (pending/countered) offer.
export function withdrawOffer(teamId: number, offerId: number): { ok: boolean; error?: string } {
  const o = db.prepare("SELECT id FROM transfer_offers WHERE id = ? AND buyer_team_id = ? AND status IN ('pending','countered')").get(offerId, teamId) as { id: number } | undefined;
  if (!o) return { ok: false, error: 'offer not found or already resolved' };
  db.prepare("UPDATE transfer_offers SET status='withdrawn' WHERE id = ?").run(offerId);
  return { ok: true };
}

// Match a counter-offer: the seller named their price, so this completes immediately at counter_fee
// (subject to the buyer's books). Window-gated.
export function matchCounter(teamId: number, offerId: number): BidResult {
  const buyer = teamRow(teamId);
  if (buyer && !transferWindow(buyer.league_id).open) return { ok: false, status: 'error', error: 'the transfer window is shut' };
  const o = db.prepare("SELECT * FROM transfer_offers WHERE id = ? AND buyer_team_id = ? AND status = 'countered'").get(offerId, teamId) as unknown as OfferRow | undefined;
  if (!o) return { ok: false, status: 'error', error: 'no counter to match' };
  const fee = o.counter_fee ?? o.fee;
  const done = completeOffer({ ...o, fee });
  if (!done.ok) return { ok: false, status: 'error', error: 'the deal collapsed — check your budget, wage budget and squad size' };
  db.prepare("UPDATE transfer_offers SET status='accepted', fee=? WHERE id=?").run(fee, offerId);
  return { ok: true, status: 'accepted', player: done.player, club: done.club, fee, placed: done.placed };
}

// Transfer market (pillar 1). Teams have a budget (db.ts); they sign free agents,
// transfer-list their own players, and the AI fills its weakest role each matchday.
//
// Roster model: a squad of 11..24, of which the first 11 by slot start (see
// specForTeam in match.ts). Signing a player who upgrades a starter's role swaps
// them into the XI (displacing the weaker man to the bench) ONLY while the team is
// on the identity XI; otherwise they join the bench so a hand-picked lineup is never
// silently rearranged. Selling removes a player and renumbers the squad.
import { db } from './db.ts';
import { overall, playerValue, playerWage, ROLE_SLOTS, type Role } from './game.ts';
import { recordFinance } from './finances.ts';

export const SQUAD_MAX = 24;
export const SQUAD_MIN = 11;

const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// node:sqlite is synchronous + single-threaded; wrap multi-statement mutations so a
// mid-transfer throw can't leave money debited but the player un-moved.
function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}

interface TeamRow { id: number; league_id: number; budget: number; wage_budget: number; user_id: number | null; lineup: string | null; name: string; }
interface PRow { id: number; slot: number; name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; listed: number; ask_price: number | null; wage: number | null; contract_years: number; }
interface FARow { id: number; league_id: number; name: string; role: string; attrs: string; personality: string | null; age: number; potential: number | null; value: number; wage: number | null; }

const teamRow = (id: number): TeamRow | undefined =>
  db.prepare('SELECT id, league_id, budget, wage_budget, user_id, lineup, name FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
const teamPlayers = (id: number): PRow[] =>
  db.prepare('SELECT id, slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years FROM players WHERE team_id = ? ORDER BY slot').all(id) as unknown as PRow[];
// Current annual wage commitment; headroom = wage_budget - wageBill gates new signings.
const wageBill = (teamId: number): number =>
  (db.prepare('SELECT COALESCE(SUM(wage), 0) AS w FROM players WHERE team_id = ?').get(teamId) as { w: number }).w;

// Transfer windows: club-to-club deals are allowed only when a window is open — the pre-season
// "summer" window (before the opening matchday) and a mid-season "winter" window. Free agents
// (unattached) can be signed any time. Derived from the league's fixture rounds, so it needs no
// new state and lines up with the matchday the user is about to play.
export interface TransferWindow { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string; deadline: number | null; closesIn: number; deadlineDay: boolean }
export function transferWindow(leagueId: number): TransferWindow {
  const total = (db.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
  const unplayed = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(leagueId) as { r: number | null }).r;
  const current = unplayed ?? total + 1;                 // season complete -> just past the end
  const mid = Math.max(2, Math.floor(total / 2));
  let window: 'summer' | 'winter' | null = null;
  if (current <= 1) window = 'summer';
  else if (current <= total && (current === mid || current === mid + 1)) window = 'winter';   // not after the season ends
  const open = window != null;
  // The last matchday the window stays open (summer = matchday 1; winter = mid+1). closesIn counts the
  // matchdays left including this one; deadlineDay = it's the final chance before the window shuts.
  const deadline = window === 'summer' ? 1 : window === 'winter' ? Math.min(total, mid + 1) : null;   // clamp: a degenerate 2-round season has mid+1 > total
  const closesIn = open && deadline != null ? Math.max(1, deadline - current + 1) : 0;
  const deadlineDay = open && deadline != null && current >= deadline;
  const label = open
    ? `${window === 'summer' ? 'Summer' : 'Winter'} window open`
    : current < mid ? `Window shut — reopens matchday ${mid} (winter)`
      : 'Window shut — reopens pre-season';
  return { open, window, current, total, label, deadline, closesIn, deadlineDay };
}

// Leagues that share the buyer's world (so the user can buy across divisions). Legacy single
// leagues (world_id NULL) see only themselves.
function worldLeagueIds(leagueId: number): number[] {
  const w = db.prepare('SELECT world_id FROM leagues WHERE id = ?').get(leagueId) as { world_id: number | null } | undefined;
  if (!w || w.world_id == null) return [leagueId];
  return (db.prepare('SELECT id FROM leagues WHERE world_id = ?').all(w.world_id) as { id: number }[]).map(r => r.id);
}

// Compact slots to a contiguous 0..N-1 in slot order (so a hole from a sale closes
// and the first 11 stay the XI). Resets a custom lineup to identity — the index→slot
// mapping is invalidated by a removal, and silently corrupting it is worse than the
// (surfaced) reset to the default XI.
function renumberSquad(teamId: number): void {
  const rows = db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY slot, id').all(teamId) as { id: number }[];
  const upd = db.prepare('UPDATE players SET slot = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i, r.id));
  db.prepare('UPDATE teams SET lineup = NULL WHERE id = ?').run(teamId);
  pruneStalePlayerDirectives(teamId);
}

// A standing plan's PER-PLAYER directives are keyed by positional slot ids (0-10), which a
// renumber just invalidated — exactly like `lineup`. Left intact, "id5 shoot_on_sight" would land
// on whoever now occupies slot 5 (possibly the GK), bypassing compile-time validation. So drop the
// per-player orders here, but KEEP team-wide tactics (high_press etc. carry no player id, so they
// stay correct). The manager re-issues any individual orders after a transfer. (§1.1)
function pruneStalePlayerDirectives(teamId: number): void {
  const row = db.prepare('SELECT plan_directives FROM teams WHERE id = ?').get(teamId) as { plan_directives: string | null } | undefined;
  if (!row?.plan_directives) return;
  let plan: { summary?: string; directives?: { teamScope?: number }[] };
  try { plan = JSON.parse(row.plan_directives); } catch { return; }
  if (!Array.isArray(plan.directives)) return;
  const teamWide = plan.directives.filter(d => d.teamScope === 0 || d.teamScope === 1);
  if (teamWide.length !== plan.directives.length) {
    db.prepare('UPDATE teams SET plan_directives = ? WHERE id = ?').run(JSON.stringify({ ...plan, directives: teamWide }), teamId);
  }
}

// When a STARTER (slot < 11) leaves, the default match path assigns formation roles by
// slot order (slot i -> ROLE_SLOTS[i]). Blind compaction would shift an arbitrary bench
// player into the vacated XI slot, possibly off-role (a CF lining up as a winger). So
// first promote the best bench player of the slot's role into the hole (falling back to
// the best bench player of any role only if there's no such cover), keeping the XI shape
// sensible. The caller renumbers afterwards to close the bench gap. (Exported for tests.)
export function backfillStarterSlot(teamId: number, slot: number): void {
  const want = ROLE_SLOTS[slot];
  const bench = db.prepare('SELECT id, role, attrs FROM players WHERE team_id = ? AND slot >= 11').all(teamId) as
    { id: number; role: string; attrs: string }[];
  if (!bench.length) return;
  const ofRole = bench.filter(b => b.role === want);
  const pool = (ofRole.length ? ofRole : bench).sort((a, b) => overall(JSON.parse(b.attrs)) - overall(JSON.parse(a.attrs)));
  db.prepare('UPDATE players SET slot = ? WHERE id = ?').run(slot, pool[0].id);
}

// Insert a recruit into a squad. Upgrade-into-XI only on the identity lineup; else bench.
const SIGN_CONTRACT_YEARS = 3;   // a new signing's deal length
function placeRecruit(
  team: TeamRow, players: PRow[],
  recruit: { name: string; role: string; attrsJson: string; age: number; potential: number | null; personalityJson: string | null; wage: number; contractYears: number },
): 'xi' | 'bench' {
  const maxSlot = players.reduce((m, p) => Math.max(m, p.slot), -1);
  const recOvr = overall(JSON.parse(recruit.attrsJson));
  const ins = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)');
  // The XI starter of this role with the lowest overall is the upgrade target.
  let occupant: PRow | null = null, occOvr = 0;
  players.slice(0, 11).forEach((p, i) => {
    if (ROLE_SLOTS[i] !== recruit.role) return;
    const ov = overall(JSON.parse(p.attrs));
    if (!occupant || ov < occOvr) { occupant = p; occOvr = ov; }
  });
  if (!team.lineup && occupant && recOvr > occOvr) {
    const occ = occupant as PRow;
    db.prepare('UPDATE players SET slot = ? WHERE id = ?').run(maxSlot + 1, occ.id);     // bench the weaker man
    ins.run(team.id, occ.slot, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.potential, recruit.personalityJson, recruit.wage, recruit.contractYears);
    return 'xi';
  }
  ins.run(team.id, maxSlot + 1, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.potential, recruit.personalityJson, recruit.wage, recruit.contractYears);
  return 'bench';
}

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
    const placed = placeRecruit(team, players, { name: agent.name, role: agent.role, attrsJson: agent.attrs, age: agent.age, potential: agent.potential, personalityJson: agent.personality, wage, contractYears: SIGN_CONTRACT_YEARS });
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(agent.value, teamId);
    db.prepare('DELETE FROM free_agents WHERE id = ?').run(agentId);
    recordFinance(teamId, 'transfer_in', -agent.value, `Signed free agent ${agent.name}`);   // no-op for AI
    return { ok: true, placed, value: agent.value, name: agent.name };
  });
}

export function listPlayer(teamId: number, slot: number, price?: number): { ok: boolean; error?: string; askPrice?: number; value?: number } {
  const p = db.prepare('SELECT id, attrs, age, personality, parent_team_id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as
    { id: number; attrs: string; age: number; personality: string | null; parent_team_id: number | null } | undefined;
  if (!p) return { ok: false, error: 'player not found' };
  if (p.parent_team_id != null) return { ok: false, error: "he's only here on loan — you can't sell him" };
  const value = playerValue(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const ask = Number.isFinite(price) && (price as number) > 0 ? Math.round(price as number) : value;
  // §2.4: stamp the listing with the open window's deadline so it lapses if unsold (marketTick). Listed
  // while shut → NULL for now; the next open window's marketTick stamps it (cross-season-safe).
  const win = transferWindow((db.prepare('SELECT league_id AS l FROM teams WHERE id = ?').get(teamId) as { l: number }).l);
  const until = win.open && win.deadline != null ? win.deadline : null;
  db.prepare('UPDATE players SET listed = 1, ask_price = ?, listed_until = ? WHERE id = ?').run(ask, until, p.id);
  return { ok: true, askPrice: ask, value };
}

export function unlistPlayer(teamId: number, slot: number): { ok: boolean } {
  db.prepare('UPDATE players SET listed = 0, ask_price = NULL, listed_until = NULL WHERE team_id = ? AND slot = ?').run(teamId, slot);
  return { ok: true };
}

export interface TransferTarget { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; askPrice: number | null; wage: number }

// Transfer-listed players at OTHER clubs in the buyer's world — the players the user can bid for.
export function transferTargets(teamId: number): TransferTarget[] {
  const team = teamRow(teamId); if (!team) return [];
  const leagueIds = worldLeagueIds(team.league_id);
  const ph = leagueIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT p.id, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.ask_price, p.wage,
      t.id AS club_team_id, t.name AS club
    FROM players p JOIN teams t ON t.id = p.team_id
    WHERE t.league_id IN (${ph}) AND p.team_id != ? AND p.listed = 1 AND p.parent_team_id IS NULL
    ORDER BY p.ask_price ASC`).all(...leagueIds, teamId) as unknown as
    (PRow & { club_team_id: number; club: string })[];
  return rows.map(r => {
    const attrs = JSON.parse(r.attrs);
    return { id: r.id, name: r.name, club: r.club, clubTeamId: r.club_team_id, role: r.role, age: r.age, overall: overall(attrs), potential: r.potential, value: playerValue(attrs, r.age, parseJSON(r.personality)), askPrice: r.ask_price, wage: r.wage ?? 0 };
  });
}

export interface BidResult { ok: boolean; status: 'pending' | 'accepted' | 'countered' | 'rejected' | 'error'; error?: string; counterFee?: number; player?: string; club?: string; fee?: number; placed?: 'xi' | 'bench' }

// Bid for another club's player (§2.1 signing drama). A bid is NO LONGER instant: it creates a
// PENDING offer the selling club resolves at the NEXT matchday tick (processOffers) — accept,
// counter, or reject — with a short round-based expiry, and multiple bids on one player become an
// auction. Here we only validate intent + a budget sanity check and record the pending offer; the
// buyer's books are RE-checked at acceptance, since state can move first. Window-gated.
const UNLISTED_PREMIUM = 1.4;   // multiple of value to prise away a player his club hasn't listed
const COUNTER_FLOOR = 0.8;      // bids within this fraction of the ask get a counter, not a rejection
const OFFER_TTL = 2;            // matchdays a pending/countered offer survives before it lapses
export function bidForPlayer(buyerTeamId: number, targetPlayerId: number, fee: number): BidResult {
  const buyer = teamRow(buyerTeamId);
  if (!buyer) return { ok: false, status: 'error', error: 'team not found' };
  if (!transferWindow(buyer.league_id).open) return { ok: false, status: 'error', error: 'the transfer window is shut' };
  if (!Number.isFinite(fee) || fee <= 0) return { ok: false, status: 'error', error: 'enter a valid bid' };
  const bid = Math.round(fee);
  const t = db.prepare(`SELECT p.id, p.team_id, p.name, p.parent_team_id, tm.name AS club, tm.league_id AS seller_league,
      (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
    FROM players p JOIN teams tm ON tm.id = p.team_id WHERE p.id = ?`)
    .get(targetPlayerId) as { id: number; team_id: number; name: string; parent_team_id: number | null; club: string; seller_league: number; seller_count: number } | undefined;
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
  db.prepare(`INSERT INTO transfer_offers (buyer_team_id, seller_team_id, player_id, fee, status, created_round, expires_round, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(buyerTeamId, t.team_id, t.id, bid, cur, cur + OFFER_TTL, Date.now());
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
function createIncomingOffer(buyerId: number, sellerId: number, playerId: number, fee: number, leagueId: number): boolean {
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
      if (cur > o.expires_round) { setStatus.run('expired', o.id); continue; }   // lapsed unanswered
      const team = teamRow(o.buyer_team_id);
      const agent = db.prepare('SELECT id, league_id, name, role, attrs, age, potential, personality, value, wage FROM free_agents WHERE id = ?').get(o.free_agent_id) as FARow | undefined;
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
      placeRecruit(team, players, { name: agent.name, role: agent.role, attrsJson: agent.attrs, age: agent.age, potential: agent.potential, personalityJson: agent.personality, wage: o.wage, contractYears: o.years });
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

// ── Loans: borrow a player for the season (no fee), returning to his parent club at rollover ──
export interface LoanResult { ok: boolean; error?: string; player?: string; from?: string }

// Move a player between squads IN PLACE — keeping his row id, so the loan ownership link (and a
// clean return) survives, unlike a transfer (which deletes + re-inserts). Clears any listing, and
// backfills + renumbers the club he leaves so its XI stays legal + on-role.
function relocatePlayer(playerId: number, fromTeamId: number, toTeamId: number, parentTeamId: number | null, loanUntil: number | null): void {
  const p = db.prepare('SELECT slot FROM players WHERE id = ?').get(playerId) as { slot: number } | undefined;
  if (!p) return;
  const toMax = (db.prepare('SELECT COALESCE(MAX(slot), -1) AS s FROM players WHERE team_id = ?').get(toTeamId) as { s: number }).s;
  db.prepare('UPDATE players SET team_id = ?, slot = ?, parent_team_id = ?, loan_until = ?, listed = 0, ask_price = NULL WHERE id = ?')
    .run(toTeamId, toMax + 1, parentTeamId, loanUntil, playerId);
  if (p.slot < 11) backfillStarterSlot(fromTeamId, p.slot);
  renumberSquad(fromTeamId);
}

// Borrow another club's player for the season. Window-gated; the owner must keep a legal squad,
// the borrower must have room + wage headroom (he carries the loanee's wage while here). No fee.
export function loanIn(borrowerTeamId: number, targetPlayerId: number): LoanResult {
  return tx(() => {
    const borrower = teamRow(borrowerTeamId);
    if (!borrower) return { ok: false, error: 'team not found' };
    if (!transferWindow(borrower.league_id).open) return { ok: false, error: 'the transfer window is shut' };
    const t = db.prepare(`SELECT p.id, p.team_id, p.name, p.parent_team_id, p.wage, p.listed, tm.name AS club, tm.league_id AS owner_league,
        (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS owner_count
      FROM players p JOIN teams tm ON tm.id = p.team_id WHERE p.id = ?`)
      .get(targetPlayerId) as { id: number; team_id: number; name: string; parent_team_id: number | null; wage: number | null; listed: number; club: string; owner_league: number; owner_count: number } | undefined;
    if (!t) return { ok: false, error: 'player not found' };
    if (t.team_id === borrowerTeamId) return { ok: false, error: 'already your player' };
    if (!t.listed) return { ok: false, error: `${t.name} isn't available to loan` };   // §1.16: gate to transfer-listed (the UI already only offers listed players)
    if (t.parent_team_id != null) return { ok: false, error: `${t.name} is already out on loan` };
    if (!worldLeagueIds(borrower.league_id).includes(t.owner_league)) return { ok: false, error: 'player is outside your world' };
    if (t.owner_count <= SQUAD_MIN) return { ok: false, error: `${t.club} won't loan ${t.name} out — their squad is at the minimum` };
    if (teamPlayers(borrowerTeamId).length >= SQUAD_MAX) return { ok: false, error: `squad full (max ${SQUAD_MAX})` };
    if (wageBill(borrowerTeamId) + (t.wage ?? 0) > borrower.wage_budget) return { ok: false, error: 'not enough wage budget for his wages' };
    const season = (db.prepare('SELECT season FROM leagues WHERE id = ?').get(borrower.league_id) as { season: number }).season;
    relocatePlayer(t.id, t.team_id, borrowerTeamId, t.team_id, season);   // parent = his current club; returns at rollover
    return { ok: true, player: t.name, from: t.club };
  });
}

// §2.12: send a loaned-in player back to his parent club EARLY (before rollover). Frees the borrower's
// slot + wage; the borrower must keep a legal XI. Window-independent — it's a give-back, not a signing.
export function endLoan(borrowerTeamId: number, slot: number): LoanResult {
  return tx(() => {
    const p = db.prepare(`SELECT p.id, p.name, p.parent_team_id, t.name AS parent_name
      FROM players p LEFT JOIN teams t ON t.id = p.parent_team_id WHERE p.team_id = ? AND p.slot = ?`)
      .get(borrowerTeamId, slot) as { id: number; name: string; parent_team_id: number | null; parent_name: string | null } | undefined;
    if (!p) return { ok: false, error: 'no such player' };
    if (p.parent_team_id == null) return { ok: false, error: `${p.name} isn't on loan` };
    if (teamPlayers(borrowerTeamId).length <= SQUAD_MIN) return { ok: false, error: `you can't drop below ${SQUAD_MIN} players — sign cover first` };
    relocatePlayer(p.id, borrowerTeamId, p.parent_team_id, null, null);
    return { ok: true, player: p.name, from: p.parent_name ?? 'his parent club' };
  });
}

// Return every loaned-in player (sitting at a club in the given leagues) to his parent club.
// Loans are season-long, so rollover ends them all. Scoped to the rolling-over WORLD's leagues so
// a second world's still-active loans aren't yanked back mid-season. NO tx of its own — call
// inside the rollover transaction. Idempotent (no loans -> no-op).
export function returnLoans(leagueIds: number[]): { player: string; to: string }[] {
  if (!leagueIds.length) return [];
  const ph = leagueIds.map(() => '?').join(',');
  const loans = db.prepare(`SELECT p.id, p.team_id, p.name, p.parent_team_id, t.name AS parent_name
    FROM players p JOIN teams t ON t.id = p.parent_team_id
    WHERE p.parent_team_id IS NOT NULL AND p.team_id IN (SELECT id FROM teams WHERE league_id IN (${ph}))`)
    .all(...leagueIds) as { id: number; team_id: number; name: string; parent_team_id: number; parent_name: string }[];
  const out: { player: string; to: string }[] = [];
  for (const l of loans) {
    relocatePlayer(l.id, l.team_id, l.parent_team_id, null, null);
    out.push({ player: l.name, to: l.parent_name });
  }
  return out;
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
    .map(a => ({ id: a.id, name: a.name, role: a.role, age: a.age, overall: overall(JSON.parse(a.attrs)), potential: a.potential, value: a.value, wage: a.wage ?? 0 }));
  const players = db.prepare(`SELECT p.slot, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.wage, p.contract_years, p.parent_team_id, p.loan_until, pt.name AS loan_from
    FROM players p LEFT JOIN teams pt ON pt.id = p.parent_team_id WHERE p.team_id = ? ORDER BY p.slot`)
    .all(teamId) as unknown as (PRow & { contract_years: number; parent_team_id: number | null; loan_until: number | null; loan_from: string | null })[];
  const squad = players.map((p, i) => {
    const attrs = JSON.parse(p.attrs);
    return { slot: p.slot, name: p.name, role: p.role, age: p.age, overall: overall(attrs), potential: p.potential, value: playerValue(attrs, p.age, parseJSON(p.personality)), wage: p.wage ?? 0, contractYears: p.contract_years, listed: !!p.listed, askPrice: p.ask_price, starter: i < 11, onLoan: p.parent_team_id != null, loanFrom: p.loan_from, loanUntil: p.loan_until };
  });
  return { budget: team.budget, wageBudget: team.wage_budget, wageBill: wageBill(teamId), squadMax: SQUAD_MAX, squadMin: SQUAD_MIN, window: transferWindow(team.league_id), freeAgents, squad, transferTargets: transferTargets(teamId) };
}

// The role whose weakest XI starter is poorest — the AI's upgrade target.
function weakestRole(players: PRow[]): { role: Role; target: number } | null {
  const xi = players.slice(0, 11);
  if (xi.length < 11) return null;
  const worstByRole = new Map<Role, number>();
  xi.forEach((p, i) => {
    const role = ROLE_SLOTS[i];
    const ov = overall(JSON.parse(p.attrs));
    worstByRole.set(role, Math.min(worstByRole.get(role) ?? 999, ov));
  });
  let weak: { role: Role; target: number } | null = null;
  for (const [role, t] of worstByRole) if (!weak || t < weak.target) weak = { role, target: t };
  return weak;
}

// Move a transfer-listed player from one team to another at a fee. The buyer places
// them like a signing (auto-upgrade-or-bench); the seller's squad renumbers + lineup
// resets. Money is conserved (debit buyer, credit seller).
function transferListed(buyerId: number, sellerId: number, player: PRow, fee: number): 'xi' | 'bench' {
  db.prepare('DELETE FROM players WHERE id = ?').run(player.id);
  if (player.slot < 11) backfillStarterSlot(sellerId, player.slot);   // keep the seller's XI on-role
  renumberSquad(sellerId);
  const buyer = teamRow(buyerId)!;
  // the player keeps their existing wage + remaining contract years — both move with them
  const placed = placeRecruit(buyer, teamPlayers(buyerId), { name: player.name, role: player.role, attrsJson: player.attrs, age: player.age, potential: player.potential, personalityJson: player.personality, wage: player.wage ?? 0, contractYears: player.contract_years ?? SIGN_CONTRACT_YEARS });
  db.prepare('UPDATE teams SET budget = budget + ? WHERE id = ?').run(fee, sellerId);
  db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(fee, buyerId);
  recordFinance(sellerId, 'transfer_out', fee, `Sold ${player.name}`);   // no-op for AI clubs
  recordFinance(buyerId, 'transfer_in', -fee, `Signed ${player.name}`);
  return placed;
}

// Remove a player from a squad, keeping it legal: a vacated XI slot is backfilled on-role
// and the squad renumbers. NO tx of its own — call inside one (the rollover) or standalone.
export function removePlayerFromSquad(teamId: number, slot: number): boolean {
  const p = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
  if (!p) return false;
  db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
  if (slot < 11) backfillStarterSlot(teamId, slot);
  renumberSquad(teamId);
  return true;
}

// Release one player onto the free-agent pool (contract expiry). Snapshots them into
// free_agents (attrs/age/potential/personality/value/wage) then removes them from the squad.
export function releasePlayerToFreeAgents(teamId: number, slot: number): boolean {
  const t = teamRow(teamId); if (!t) return false;
  const p = db.prepare('SELECT name, role, attrs, age, potential, personality, wage FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; wage: number | null } | undefined;
  if (!p) return false;
  const attrs = JSON.parse(p.attrs);
  const value = playerValue(attrs, p.age, parseJSON(p.personality));
  db.prepare('INSERT INTO free_agents (league_id, name, role, attrs, personality, age, potential, value, wage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.league_id, p.name, p.role, p.attrs, p.personality, p.age, p.potential, value, p.wage ?? playerWage(attrs, p.age, parseJSON(p.personality)));
  return removePlayerFromSquad(teamId, slot);
}

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
    const recruit = fas.find(a => overall(JSON.parse(a.attrs)) > weak.target && (a.wage ?? 0) <= headroom);
    if (recruit) {
      const r = buyFreeAgent(id, recruit.id);
      if (r.ok) { events.push({ teamId: id, teamName: team.name, type: 'sign', player: recruit.name, role: recruit.role, fee: recruit.value }); continue; }
    }

    // 2) Else a transfer-listed player of the weak role from another team (seller must
    // keep a legal XI), cheapest first, that upgrades the weak link + fits the wage budget.
    // Club-to-club deals only when the window is open (free-agent signings above are not gated).
    if (!transferWindow(leagueId).open) continue;
    const listings = db.prepare(`
      SELECT p.id, p.slot, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.wage, p.contract_years,
             p.team_id AS seller_id, t.name AS seller_name, t.user_id AS seller_user_id,
             (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
      FROM players p JOIN teams t ON t.id = p.team_id
      WHERE t.league_id = ? AND p.listed = 1 AND p.team_id != ? AND p.role = ? AND p.ask_price <= ?
      ORDER BY p.ask_price ASC`).all(leagueId, id, weak.role, team.budget) as unknown as (PRow & { seller_id: number; seller_name: string; seller_user_id: number | null; seller_count: number })[];
    const pick = listings.find(l => l.seller_count > SQUAD_MIN && overall(JSON.parse(l.attrs)) > weak.target && (l.wage ?? 0) <= headroom);
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

// §P2 (playthrough): AI clubs put a surplus squad player on the market so the §2.1 pending-offer auction
// has inventory — without it the human only ever sees the instant free-agent path and "For sale — other
// clubs" is empty. Each AI club keeps at most ONE player listed; it lists its weakest BENCH man (a genuine
// squad-filler, never a starter), at his value, only when it has depth beyond the floor to spare. No money
// moves here (a listing is just a flag), so the economy stays conserved.
export function aiListSurplus(leagueId: number): void {
  const aiTeams = db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL').all(leagueId) as { id: number }[];
  for (const { id } of aiTeams) {
    if (db.prepare('SELECT 1 FROM players WHERE team_id = ? AND listed = 1 LIMIT 1').get(id)) continue;   // one listing at a time
    const players = teamPlayers(id);
    if (players.length <= SQUAD_MIN) continue;                       // never sell below a legal XI
    const bench = players.filter(p => p.slot >= 11);                 // only sell from the bench (keep the XI intact)
    if (!bench.length) continue;
    const cand = bench.map(p => ({ p, ovr: overall(JSON.parse(p.attrs)) })).sort((a, b) => a.ovr - b.ovr)[0];   // weakest bench man
    listPlayer(id, cand.p.slot);                                     // at his value (the default ask); listPlayer no-ops on a loanee
  }
}

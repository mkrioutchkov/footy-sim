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
export interface TransferWindow { open: boolean; window: 'summer' | 'winter' | null; current: number; total: number; label: string }
export function transferWindow(leagueId: number): TransferWindow {
  const total = (db.prepare('SELECT COALESCE(MAX(round), 0) AS r FROM fixtures WHERE league_id = ?').get(leagueId) as { r: number }).r;
  const unplayed = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(leagueId) as { r: number | null }).r;
  const current = unplayed ?? total + 1;                 // season complete -> just past the end
  const mid = Math.max(2, Math.floor(total / 2));
  let window: 'summer' | 'winter' | null = null;
  if (current <= 1) window = 'summer';
  else if (current <= total && (current === mid || current === mid + 1)) window = 'winter';   // not after the season ends
  const open = window != null;
  const label = open
    ? `${window === 'summer' ? 'Summer' : 'Winter'} window open`
    : current < mid ? `Window shut — reopens matchday ${mid} (winter)`
      : 'Window shut — reopens pre-season';
  return { open, window, current, total, label };
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
  db.prepare('UPDATE players SET listed = 1, ask_price = ? WHERE id = ?').run(ask, p.id);
  return { ok: true, askPrice: ask, value };
}

export function unlistPlayer(teamId: number, slot: number): { ok: boolean } {
  db.prepare('UPDATE players SET listed = 0, ask_price = NULL WHERE team_id = ? AND slot = ?').run(teamId, slot);
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

export interface BidResult { ok: boolean; status: 'accepted' | 'countered' | 'rejected' | 'error'; error?: string; counterFee?: number; player?: string; club?: string; fee?: number; placed?: 'xi' | 'bench' }

// Bid for another club's player (club-to-club, with negotiation). The selling club accepts at or
// above its asking price (a listed player's ask, else a premium over value to prise away an
// unlisted one), counters with that price if the bid is close, else rejects; it won't sell down
// to a bare-minimum squad. On acceptance the deal executes immediately (buyer budget/wage/squad
// permitting). Stateless: a counter just tells the user the price, and they re-bid. Window-gated.
const UNLISTED_PREMIUM = 1.4;   // multiple of value to prise away a player his club hasn't listed
const COUNTER_FLOOR = 0.8;      // bids within this fraction of the ask get a counter, not a rejection
export function bidForPlayer(buyerTeamId: number, targetPlayerId: number, fee: number): BidResult {
  const buyer = teamRow(buyerTeamId);
  if (!buyer) return { ok: false, status: 'error', error: 'team not found' };
  if (!transferWindow(buyer.league_id).open) return { ok: false, status: 'error', error: 'the transfer window is shut' };
  if (!Number.isFinite(fee) || fee <= 0) return { ok: false, status: 'error', error: 'enter a valid bid' };
  const t = db.prepare(`SELECT p.id, p.team_id, p.slot, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.listed, p.ask_price, p.wage, p.contract_years, p.parent_team_id,
      tm.name AS club, tm.league_id AS seller_league,
      (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
    FROM players p JOIN teams tm ON tm.id = p.team_id WHERE p.id = ?`)
    .get(targetPlayerId) as (PRow & { team_id: number; parent_team_id: number | null; club: string; seller_league: number; seller_count: number }) | undefined;
  if (!t) return { ok: false, status: 'error', error: 'player not found' };
  if (t.team_id === buyerTeamId) return { ok: false, status: 'error', error: 'already your player' };
  if (t.parent_team_id != null) return { ok: false, status: 'error', error: `${t.name} is out on loan — not available to buy` };
  if (!worldLeagueIds(buyer.league_id).includes(t.seller_league)) return { ok: false, status: 'error', error: 'player is outside your world' };
  if (t.seller_count <= SQUAD_MIN) return { ok: false, status: 'rejected', club: t.club, player: t.name, error: `${t.club} won't sell ${t.name} — their squad is already at the minimum` };

  const attrs = JSON.parse(t.attrs);
  const value = playerValue(attrs, t.age, parseJSON(t.personality));
  const threshold = t.listed && t.ask_price ? t.ask_price : Math.round(value * UNLISTED_PREMIUM);
  const bid = Math.round(fee);
  if (bid < threshold * COUNTER_FLOOR) return { ok: false, status: 'rejected', club: t.club, player: t.name, error: `${t.club} dismissed your bid for ${t.name}` };
  if (bid < threshold) return { ok: false, status: 'countered', club: t.club, player: t.name, counterFee: threshold, error: `${t.club} want ${threshold} for ${t.name}` };

  // Accepted — now the buyer's books must balance, or the deal collapses.
  const wage = t.wage ?? 0;
  if (teamPlayers(buyerTeamId).length >= SQUAD_MAX) return { ok: false, status: 'error', error: `squad full (max ${SQUAD_MAX})` };
  if (buyer.budget < bid) return { ok: false, status: 'error', error: 'not enough budget for that fee' };
  if (wageBill(buyerTeamId) + wage > buyer.wage_budget) return { ok: false, status: 'error', error: 'not enough wage budget for his contract' };
  const placed = tx(() => transferListed(buyerTeamId, t.team_id, t as PRow, bid));
  return { ok: true, status: 'accepted', player: t.name, club: t.club, fee: bid, placed };
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
    const t = db.prepare(`SELECT p.id, p.team_id, p.name, p.parent_team_id, p.wage, tm.name AS club, tm.league_id AS owner_league,
        (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS owner_count
      FROM players p JOIN teams tm ON tm.id = p.team_id WHERE p.id = ?`)
      .get(targetPlayerId) as { id: number; team_id: number; name: string; parent_team_id: number | null; wage: number | null; club: string; owner_league: number; owner_count: number } | undefined;
    if (!t) return { ok: false, error: 'player not found' };
    if (t.team_id === borrowerTeamId) return { ok: false, error: 'already your player' };
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
  squad: { slot: number; name: string; role: string; age: number; overall: number; potential: number | null; value: number; wage: number; contractYears: number; listed: boolean; askPrice: number | null; starter: boolean; onLoan: boolean }[];
  transferTargets: TransferTarget[];
}

export function getMarket(teamId: number): MarketView | null {
  const team = teamRow(teamId);
  if (!team) return null;
  const freeAgents = (db.prepare('SELECT id, name, role, attrs, age, potential, value, wage FROM free_agents WHERE league_id = ? ORDER BY value DESC').all(team.league_id) as
    { id: number; name: string; role: string; attrs: string; age: number; potential: number | null; value: number; wage: number | null }[])
    .map(a => ({ id: a.id, name: a.name, role: a.role, age: a.age, overall: overall(JSON.parse(a.attrs)), potential: a.potential, value: a.value, wage: a.wage ?? 0 }));
  const players = db.prepare('SELECT slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years, parent_team_id FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as unknown as (PRow & { contract_years: number; parent_team_id: number | null })[];
  const squad = players.map((p, i) => {
    const attrs = JSON.parse(p.attrs);
    return { slot: p.slot, name: p.name, role: p.role, age: p.age, overall: overall(attrs), potential: p.potential, value: playerValue(attrs, p.age, parseJSON(p.personality)), wage: p.wage ?? 0, contractYears: p.contract_years, listed: !!p.listed, askPrice: p.ask_price, starter: i < 11, onLoan: p.parent_team_id != null };
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

export interface MarketEvent { teamId: number; teamName: string; type: 'sign' | 'buy_listed'; player: string; role: string; fee: number; from?: string; }

// One matchday's AI market activity: each AI team makes at most one move — sign the
// best affordable free agent that upgrades its weakest role, else buy a (cheaper,
// upgrading) transfer-listed player of that role from another team. Keeps the world
// alive and gives the user's listings a buyer. Re-reads state per team so earlier
// buys are seen by later ones.
export function marketTick(leagueId: number): MarketEvent[] {
  const events: MarketEvent[] = [];
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
             p.team_id AS seller_id, t.name AS seller_name,
             (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
      FROM players p JOIN teams t ON t.id = p.team_id
      WHERE t.league_id = ? AND p.listed = 1 AND p.team_id != ? AND p.role = ? AND p.ask_price <= ?
      ORDER BY p.ask_price ASC`).all(leagueId, id, weak.role, team.budget) as unknown as (PRow & { seller_id: number; seller_name: string; seller_count: number })[];
    const pick = listings.find(l => l.seller_count > SQUAD_MIN && overall(JSON.parse(l.attrs)) > weak.target && (l.wage ?? 0) <= headroom);
    if (pick) {
      tx(() => transferListed(id, pick.seller_id, pick, pick.ask_price!));
      events.push({ teamId: id, teamName: team.name, type: 'buy_listed', player: pick.name, role: pick.role, fee: pick.ask_price!, from: pick.seller_name });
    }
  }
  return events;
}

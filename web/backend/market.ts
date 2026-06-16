// Transfer market (pillar 1). Teams have a budget (db.ts); they sign free agents,
// transfer-list their own players, and the AI fills its weakest role each matchday.
//
// Roster model: a squad of 11..24, of which the first 11 by slot start (see
// specForTeam in match.ts). Signing a player who upgrades a starter's role swaps
// them into the XI (displacing the weaker man to the bench) ONLY while the team is
// on the identity XI; otherwise they join the bench so a hand-picked lineup is never
// silently rearranged. Selling removes a player and renumbers the squad.
import { db } from './db.ts';
import { overall, playerValue, ROLE_SLOTS, type Role } from './game.ts';

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

interface TeamRow { id: number; league_id: number; budget: number; user_id: number | null; lineup: string | null; name: string; }
interface PRow { id: number; slot: number; name: string; role: string; attrs: string; age: number; personality: string | null; listed: number; ask_price: number | null; }
interface FARow { id: number; league_id: number; name: string; role: string; attrs: string; personality: string | null; age: number; value: number; }

const teamRow = (id: number): TeamRow | undefined =>
  db.prepare('SELECT id, league_id, budget, user_id, lineup, name FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
const teamPlayers = (id: number): PRow[] =>
  db.prepare('SELECT id, slot, name, role, attrs, age, personality, listed, ask_price FROM players WHERE team_id = ? ORDER BY slot').all(id) as unknown as PRow[];

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
function placeRecruit(
  team: TeamRow, players: PRow[],
  recruit: { name: string; role: string; attrsJson: string; age: number; personalityJson: string | null },
): 'xi' | 'bench' {
  const maxSlot = players.reduce((m, p) => Math.max(m, p.slot), -1);
  const recOvr = overall(JSON.parse(recruit.attrsJson));
  const ins = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, personality, listed, ask_price) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)');
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
    ins.run(team.id, occ.slot, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.personalityJson);
    return 'xi';
  }
  ins.run(team.id, maxSlot + 1, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.personalityJson);
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
    const placed = placeRecruit(team, players, { name: agent.name, role: agent.role, attrsJson: agent.attrs, age: agent.age, personalityJson: agent.personality });
    db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(agent.value, teamId);
    db.prepare('DELETE FROM free_agents WHERE id = ?').run(agentId);
    return { ok: true, placed, value: agent.value, name: agent.name };
  });
}

export function listPlayer(teamId: number, slot: number, price?: number): { ok: boolean; error?: string; askPrice?: number; value?: number } {
  const p = db.prepare('SELECT id, attrs, age, personality FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as
    { id: number; attrs: string; age: number; personality: string | null } | undefined;
  if (!p) return { ok: false, error: 'player not found' };
  const value = playerValue(JSON.parse(p.attrs), p.age, parseJSON(p.personality));
  const ask = Number.isFinite(price) && (price as number) > 0 ? Math.round(price as number) : value;
  db.prepare('UPDATE players SET listed = 1, ask_price = ? WHERE id = ?').run(ask, p.id);
  return { ok: true, askPrice: ask, value };
}

export function unlistPlayer(teamId: number, slot: number): { ok: boolean } {
  db.prepare('UPDATE players SET listed = 0, ask_price = NULL WHERE team_id = ? AND slot = ?').run(teamId, slot);
  return { ok: true };
}

export interface MarketView {
  budget: number; squadMax: number; squadMin: number;
  freeAgents: { id: number; name: string; role: string; age: number; overall: number; value: number }[];
  squad: { slot: number; name: string; role: string; age: number; overall: number; value: number; listed: boolean; askPrice: number | null; starter: boolean }[];
}

export function getMarket(teamId: number): MarketView | null {
  const team = teamRow(teamId);
  if (!team) return null;
  const freeAgents = (db.prepare('SELECT id, name, role, attrs, age, value FROM free_agents WHERE league_id = ? ORDER BY value DESC').all(team.league_id) as
    { id: number; name: string; role: string; attrs: string; age: number; value: number }[])
    .map(a => ({ id: a.id, name: a.name, role: a.role, age: a.age, overall: overall(JSON.parse(a.attrs)), value: a.value }));
  const squad = teamPlayers(teamId).map((p, i) => {
    const attrs = JSON.parse(p.attrs);
    return { slot: p.slot, name: p.name, role: p.role, age: p.age, overall: overall(attrs), value: playerValue(attrs, p.age, parseJSON(p.personality)), listed: !!p.listed, askPrice: p.ask_price, starter: i < 11 };
  });
  return { budget: team.budget, squadMax: SQUAD_MAX, squadMin: SQUAD_MIN, freeAgents, squad };
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
  const placed = placeRecruit(buyer, teamPlayers(buyerId), { name: player.name, role: player.role, attrsJson: player.attrs, age: player.age, personalityJson: player.personality });
  db.prepare('UPDATE teams SET budget = budget + ? WHERE id = ?').run(fee, sellerId);
  db.prepare('UPDATE teams SET budget = budget - ? WHERE id = ?').run(fee, buyerId);
  return placed;
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

    // 1) Best affordable free agent of the weak role that beats the weak link.
    const fas = db.prepare('SELECT * FROM free_agents WHERE league_id = ? AND role = ? AND value <= ? ORDER BY value DESC')
      .all(leagueId, weak.role, team.budget) as unknown as FARow[];
    const recruit = fas.find(a => overall(JSON.parse(a.attrs)) > weak.target);
    if (recruit) {
      const r = buyFreeAgent(id, recruit.id);
      if (r.ok) { events.push({ teamId: id, teamName: team.name, type: 'sign', player: recruit.name, role: recruit.role, fee: recruit.value }); continue; }
    }

    // 2) Else a transfer-listed player of the weak role from another team (seller must
    // keep a legal XI), cheapest first, that upgrades the weak link.
    const listings = db.prepare(`
      SELECT p.id, p.slot, p.name, p.role, p.attrs, p.age, p.personality, p.listed, p.ask_price,
             p.team_id AS seller_id, t.name AS seller_name,
             (SELECT COUNT(*) FROM players px WHERE px.team_id = p.team_id) AS seller_count
      FROM players p JOIN teams t ON t.id = p.team_id
      WHERE t.league_id = ? AND p.listed = 1 AND p.team_id != ? AND p.role = ? AND p.ask_price <= ?
      ORDER BY p.ask_price ASC`).all(leagueId, id, weak.role, team.budget) as unknown as (PRow & { seller_id: number; seller_name: string; seller_count: number })[];
    const pick = listings.find(l => l.seller_count > SQUAD_MIN && overall(JSON.parse(l.attrs)) > weak.target);
    if (pick) {
      tx(() => transferListed(id, pick.seller_id, pick, pick.ask_price!));
      events.push({ teamId: id, teamName: team.name, type: 'buy_listed', player: pick.name, role: pick.role, fee: pick.ask_price!, from: pick.seller_name });
    }
  }
  return events;
}

// market/squad.ts — squad plumbing: every mutation that adds, removes or moves a player while
// keeping a squad legal (the 11..24 bounds, an on-role XI, contiguous slots, and the slot-keyed
// columns a renumber invalidates). The roster model these functions implement is documented in
// market.ts' header. Every deal path — free agents, club-to-club offers, loans, the AI tick —
// lands here, which is why the invariants live in one place.
import { db } from '../db.ts';
import { overall, ROLE_SLOTS } from '../game.ts';
import { recordFinance } from '../finances.ts';
import { teamPlayers, teamRow, type PRow, type TeamRow } from './shared.ts';

// Compact slots to a contiguous 0..N-1 in slot order (so a hole from a sale closes
// and the first 11 stay the XI). Resets a custom lineup to identity — the index→slot
// mapping is invalidated by a removal, and silently corrupting it is worse than the
// (surfaced) reset to the default XI.
export function renumberSquad(teamId: number): void {
  const rows = db.prepare('SELECT id, slot FROM players WHERE team_id = ? ORDER BY slot, id').all(teamId) as { id: number; slot: number }[];
  const upd = db.prepare('UPDATE players SET slot = ? WHERE id = ?');
  // Only the rows the compaction actually moves need writing — a squad with no hole is already 0..N-1,
  // so the common case writes nothing. (Same reasoning as optimizeLineup in ai.ts.)
  rows.forEach((r, i) => { if (r.slot !== i) { upd.run(i, r.id); } });
  // lineup + set-piece takers are slot-keyed (like the per-player directives below) — a renumber invalidates
  // them, so reset both to the default rather than have a taker silently land on whoever now fills that slot.
  db.prepare('UPDATE teams SET lineup = NULL, set_piece_takers = NULL WHERE id = ?').run(teamId);
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
  const pool = (ofRole.length ? ofRole : bench).sort((a, b) => overall(JSON.parse(b.attrs), b.role) - overall(JSON.parse(a.attrs), a.role));
  db.prepare('UPDATE players SET slot = ? WHERE id = ?').run(slot, pool[0].id);
}

// Insert a recruit into a squad. Upgrade-into-XI only on the identity lineup; else bench.
export const SIGN_CONTRACT_YEARS = 3;   // a new signing's deal length
export function placeRecruit(
  team: TeamRow, players: PRow[],
  recruit: { name: string; role: string; attrsJson: string; age: number; potential: number | null; personalityJson: string | null; wage: number; contractYears: number; foot: number },
): 'xi' | 'bench' {
  const maxSlot = players.reduce((m, p) => Math.max(m, p.slot), -1);
  const recOvr = overall(JSON.parse(recruit.attrsJson), recruit.role);
  // §footedness rides along so a signing keeps the foot he was scouted with (not the default 1).
  const ins = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, listed, ask_price, wage, contract_years, foot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)');
  // The XI starter of this role with the lowest overall is the upgrade target.
  let occupant: PRow | null = null, occOvr = 0;
  players.slice(0, 11).forEach((p, i) => {
    if (ROLE_SLOTS[i] !== recruit.role) return;
    const ov = overall(JSON.parse(p.attrs), p.role);
    if (!occupant || ov < occOvr) { occupant = p; occOvr = ov; }
  });
  if (!team.lineup && occupant && recOvr > occOvr) {
    const occ = occupant as PRow;
    db.prepare('UPDATE players SET slot = ? WHERE id = ?').run(maxSlot + 1, occ.id);     // bench the weaker man
    ins.run(team.id, occ.slot, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.potential, recruit.personalityJson, recruit.wage, recruit.contractYears, recruit.foot);
    return 'xi';
  }
  ins.run(team.id, maxSlot + 1, recruit.name, recruit.role, recruit.attrsJson, recruit.age, recruit.potential, recruit.personalityJson, recruit.wage, recruit.contractYears, recruit.foot);
  return 'bench';
}

// Move a transfer-listed player from one team to another at a fee. The buyer places
// them like a signing (auto-upgrade-or-bench); the seller's squad renumbers + lineup
// resets. Money is conserved (debit buyer, credit seller).
export function transferListed(buyerId: number, sellerId: number, player: PRow, fee: number): 'xi' | 'bench' {
  db.prepare('DELETE FROM players WHERE id = ?').run(player.id);
  if (player.slot < 11) backfillStarterSlot(sellerId, player.slot);   // keep the seller's XI on-role
  renumberSquad(sellerId);
  const buyer = teamRow(buyerId)!;
  // the player keeps their existing wage + remaining contract years — both move with them
  const placed = placeRecruit(buyer, teamPlayers(buyerId), { name: player.name, role: player.role, attrsJson: player.attrs, age: player.age, potential: player.potential, personalityJson: player.personality, wage: player.wage ?? 0, contractYears: player.contract_years ?? SIGN_CONTRACT_YEARS, foot: player.foot ?? 1 });
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

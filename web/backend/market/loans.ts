// market/loans.ts — the loan system: borrowing another club's player (loanIn), sending one of your
// own out (loanOut), the §2.12 early give-back (endLoan), and the rollover sweep that sends every
// loanee home (returnLoans). A loan keeps the player's ROW — only his team_id/slot/parent_team_id
// move — which is what makes the return clean; contrast transferListed (squad.ts), which deletes
// and re-inserts.
import { db } from '../db.ts';
import { teamPlayers, teamRow, tx, wageBill, worldLeagueIds, SQUAD_MAX, SQUAD_MIN } from './shared.ts';
import { transferWindow } from './window.ts';
import { backfillStarterSlot, renumberSquad } from './squad.ts';

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
    // The world check comes BEFORE any error that names the player. players.id is global, so the
    // two `${t.name}` messages below were a cross-tenant read: post another world's id and the
    // rejection told you who he was. Same outcome for a legitimate same-world loan — only the
    // answer given to someone reaching outside their world changes.
    if (!worldLeagueIds(borrower.league_id).includes(t.owner_league)) return { ok: false, error: 'player is outside your world' };
    if (!t.listed) return { ok: false, error: `${t.name} isn't available to loan` };   // §1.16: gate to transfer-listed (the UI already only offers listed players)
    if (t.parent_team_id != null) return { ok: false, error: `${t.name} is already out on loan` };
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

// §loan-out: send one of YOUR OWN players out on loan to another world club for the season (the mirror
// of loanIn). No fee, window-gated; you must keep a legal squad; the destination needs room + wage headroom
// (it carries his wage while he's there). Parent = you, so returnLoans brings him home at rollover. Without
// an explicit destTeamId, pick an AI club that is shortest in his role (then smallest squad) among those
// with room — so the loan reads as "a club that needs him". `from` in the result = the club he joins.
export function loanOut(ownerTeamId: number, slot: number, destTeamId?: number): LoanResult {
  return tx(() => {
    const owner = teamRow(ownerTeamId);
    if (!owner) return { ok: false, error: 'team not found' };
    if (!transferWindow(owner.league_id).open) return { ok: false, error: 'the transfer window is shut' };
    const p = db.prepare('SELECT id, name, role, wage, parent_team_id FROM players WHERE team_id = ? AND slot = ?')
      .get(ownerTeamId, slot) as { id: number; name: string; role: string; wage: number | null; parent_team_id: number | null } | undefined;
    if (!p) return { ok: false, error: 'no such player' };
    if (p.parent_team_id != null) return { ok: false, error: `${p.name} is a loanee — you can't loan him out` };
    if (teamPlayers(ownerTeamId).length <= SQUAD_MIN) return { ok: false, error: `you can't drop below ${SQUAD_MIN} players — sign cover first` };
    const wage = p.wage ?? 0;
    const worldIds = worldLeagueIds(owner.league_id);
    const ph = worldIds.map(() => '?').join(',');
    // candidate AI clubs in the world with room + wage headroom; prefer the one shortest in his role.
    const cands = db.prepare(`SELECT t.id, t.name, t.wage_budget,
        (SELECT COUNT(*) FROM players px WHERE px.team_id = t.id) AS cnt,
        (SELECT COUNT(*) FROM players px WHERE px.team_id = t.id AND px.role = ?) AS role_cnt,
        (SELECT COALESCE(SUM(px.wage), 0) FROM players px WHERE px.team_id = t.id) AS bill
      FROM teams t WHERE t.user_id IS NULL AND t.id != ? AND t.league_id IN (${ph})`)
      .all(p.role, ownerTeamId, ...worldIds) as { id: number; name: string; wage_budget: number; cnt: number; role_cnt: number; bill: number }[];
    const eligible = cands.filter(c => c.cnt < SQUAD_MAX && c.bill + wage <= c.wage_budget);
    if (destTeamId != null && !eligible.some(c => c.id === destTeamId)) return { ok: false, error: 'that club can’t take him on loan' };
    const dest = destTeamId != null
      ? eligible.find(c => c.id === destTeamId)!
      : eligible.sort((a, b) => a.role_cnt - b.role_cnt || a.cnt - b.cnt)[0];
    if (!dest) return { ok: false, error: 'no club can take him on loan right now' };
    const season = (db.prepare('SELECT season FROM leagues WHERE id = ?').get(owner.league_id) as { season: number }).season;
    relocatePlayer(p.id, ownerTeamId, dest.id, ownerTeamId, season);   // parent = you; returns at rollover
    return { ok: true, player: p.name, from: dest.name };
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

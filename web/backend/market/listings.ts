// market/listings.ts — the for-sale board: putting one of your own players up (and taking him
// back down), the list of players you can actually bid for, the release clauses that make an
// otherwise-unavailable star buyable, and the AI's own listing behaviour that keeps the board
// stocked. Nothing here moves a player or any money — a listing is a flag plus an asking price.
// (The §2.4 deadline sweep that lapses an unsold listing runs with the matchday tick — see tick.ts.)
import { db } from '../db.ts';
import { overall, playerValue } from '../game.ts';
import { parseJSON, teamPlayers, teamRow, worldLeagueIds, SQUAD_MIN, type PRow } from './shared.ts';
import { transferWindow } from './window.ts';

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

export interface TransferTarget { id: number; name: string; club: string; clubTeamId: number; role: string; age: number; overall: number; potential: number | null; value: number; askPrice: number | null; releaseClause: number | null; wage: number }

// Transfer-listed players at OTHER clubs in the buyer's world — PLUS any player with a release clause (a
// clause makes an otherwise-unavailable star buyable). These are the players the user can bid for.
export function transferTargets(teamId: number): TransferTarget[] {
  const team = teamRow(teamId); if (!team) return [];
  const leagueIds = worldLeagueIds(team.league_id);
  const ph = leagueIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT p.id, p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.ask_price, p.release_clause, p.wage,
      t.id AS club_team_id, t.name AS club
    FROM players p JOIN teams t ON t.id = p.team_id
    WHERE t.league_id IN (${ph}) AND p.team_id != ? AND (p.listed = 1 OR p.release_clause IS NOT NULL) AND p.parent_team_id IS NULL
    ORDER BY (p.release_clause IS NOT NULL) DESC, p.ask_price ASC, p.release_clause ASC`).all(...leagueIds, teamId) as unknown as
    (PRow & { release_clause: number | null; club_team_id: number; club: string })[];
  return rows.map(r => {
    const attrs = JSON.parse(r.attrs);
    return { id: r.id, name: r.name, club: r.club, clubTeamId: r.club_team_id, role: r.role, age: r.age, overall: overall(attrs, r.role), potential: r.potential, value: playerValue(attrs, r.age, parseJSON(r.personality), r.role), askPrice: r.ask_price, releaseClause: r.release_clause, wage: r.wage ?? 0 };
  });
}

// §release-clause: give each AI club's BEST player (by overall, no clause yet) a release clause — a
// premium over his value, so triggering it is dear but decisive. Deterministic + idempotent (only fills a
// NULL clause), human clubs untouched. Seeded at world creation + each rollover so new stars get clauses.
const RELEASE_CLAUSE_PREMIUM = 1.7;
export function seedReleaseClauses(leagueIds: number[]): void {
  if (!leagueIds.length) return;
  const ph = leagueIds.map(() => '?').join(',');
  const aiTeams = db.prepare(`SELECT id FROM teams WHERE league_id IN (${ph}) AND user_id IS NULL`).all(...leagueIds) as { id: number }[];
  const upd = db.prepare('UPDATE players SET release_clause = ? WHERE id = ?');
  for (const t of aiTeams) {
    const rows = db.prepare('SELECT id, role, attrs, age, personality, release_clause FROM players WHERE team_id = ? AND parent_team_id IS NULL')
      .all(t.id) as { id: number; role: string; attrs: string; age: number; personality: string | null; release_clause: number | null }[];
    if (rows.some(r => r.release_clause != null)) continue;   // this club already has a clause set — leave it
    let best: { id: number; ov: number; value: number } | null = null;
    for (const r of rows) {
      const attrs = JSON.parse(r.attrs);
      const ov = overall(attrs, r.role);
      if (!best || ov > best.ov) best = { id: r.id, ov, value: playerValue(attrs, r.age, parseJSON(r.personality), r.role) };
    }
    if (best) upd.run(Math.round(best.value * RELEASE_CLAUSE_PREMIUM / 100000) * 100000, best.id);
  }
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
    const cand = bench.map(p => ({ p, ovr: overall(JSON.parse(p.attrs), p.role) })).sort((a, b) => a.ovr - b.ovr)[0];   // weakest bench man
    listPlayer(id, cand.p.slot);                                     // at his value (the default ask); listPlayer no-ops on a loanee
  }
}

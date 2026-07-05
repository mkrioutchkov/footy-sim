// Transfer shortlist / watchlist — a per-team list of player ids the manager is tracking (FM's shortlist).
// Stored as a JSON int[] on teams.shortlist (capped, deduped). Reads resolve the ids to each player's CURRENT
// state (club, value, availability) and PRUNE any id that no longer resolves (a player who left the game),
// so the list self-heals. Engine-free; no money, no squad changes.
import { db } from './db.ts';
import { overall, playerValue } from './game.ts';

const MAX_SHORTLIST = 50;
const parseJSON = (s: string | null): unknown => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function readShortlist(teamId: number): number[] {
  const row = db.prepare('SELECT shortlist FROM teams WHERE id = ?').get(teamId) as { shortlist: string | null } | undefined;
  const a = parseJSON(row?.shortlist ?? null);
  return Array.isArray(a) ? a.filter((x): x is number => Number.isInteger(x)) : [];
}
function writeShortlist(teamId: number, ids: number[]): void {
  db.prepare('UPDATE teams SET shortlist = ? WHERE id = ?').run(JSON.stringify([...new Set(ids)].slice(0, MAX_SHORTLIST)), teamId);
}

export interface ShortlistRow {
  id: number; name: string; club: string; role: string; age: number; overall: number; value: number;
  listed: boolean; releaseClause: number | null; mine: boolean; onLoan: boolean;
}

// Resolve the tracked ids to live rows, pruning any that no longer exist. Preserves insertion order.
export function getShortlist(teamId: number): ShortlistRow[] {
  const ids = readShortlist(teamId);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT p.id, p.name, p.role, p.attrs, p.age, p.personality, p.listed, p.release_clause,
      p.parent_team_id, p.team_id, t.name AS club
    FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id IN (${ph})`)
    .all(...ids) as { id: number; name: string; role: string; attrs: string; age: number; personality: string | null; listed: number; release_clause: number | null; parent_team_id: number | null; team_id: number; club: string }[];
  const byId = new Map(rows.map(r => [r.id, r] as const));
  const surviving = ids.filter(id => byId.has(id));
  if (surviving.length !== ids.length) writeShortlist(teamId, surviving);   // prune departed players
  return surviving.map(id => {
    const r = byId.get(id)!;
    const attrs = JSON.parse(r.attrs);
    return {
      id: r.id, name: r.name, club: r.club, role: r.role, age: r.age, overall: overall(attrs),
      value: playerValue(attrs, r.age, parseJSON(r.personality)), listed: !!r.listed,
      releaseClause: r.release_clause, mine: r.team_id === teamId, onLoan: r.parent_team_id != null,
    };
  });
}

// The raw tracked id set (for the market UI's ★ toggle state).
export function shortlistIds(teamId: number): number[] { return readShortlist(teamId); }

// Add or remove a player from the watchlist. Returns whether he's now shortlisted.
export function toggleShortlist(teamId: number, playerId: number, add: boolean): { ok: boolean; shortlisted: boolean } {
  const ids = readShortlist(teamId);
  const has = ids.includes(playerId);
  if (add && !has) writeShortlist(teamId, [...ids, playerId]);
  else if (!add && has) writeShortlist(teamId, ids.filter(x => x !== playerId));
  return { ok: true, shortlisted: add };
}

// routes/shared.ts — the per-request guards + validators every route module shares: the
// pre-split index.ts 'auth helpers' section, moved verbatim (index.ts registers the modules).
import { createSession, getUserBySession, type User } from '../auth.ts';
import { db } from '../db.ts';
import { teamForUser, type Tactics } from '../game.ts';
import { worldForTeam } from '../worlds.ts';

// ── auth helpers ──
export function currentUser(req: any): User | null {
  return getUserBySession(req.cookies?.sid);
}
export function setSession(reply: any, userId: number): void {
  const sid = createSession(userId);
  reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
}
const lastSeenStamp = new Map<number, number>();   // throttle the last_seen write to ≤1/min per user
export function requireUser(req: any, reply: any): User | null {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not logged in' }); return null; }
  // §autonomous: record activity so the assistant manager knows when a human is present vs away.
  const now = Date.now();
  if ((lastSeenStamp.get(u.id) ?? 0) < now - 60000) {
    lastSeenStamp.set(u.id, now);
    // Ambient by design: last_seen only feeds the absent-manager heuristic (world.ts runManagerPrePass),
    // so a failed stamp costs at most one turn of the assistant covering for a manager who is in fact
    // present. Failing the REQUEST over a bookkeeping write would be far worse than that.
    try { db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, u.id); } catch { /* see above */ }
  }
  return u;
}
// Admin-only gate. A non-admin (or logged-out) caller can NEVER pass — the endpoint 404s to
// logged-out and 403s to normal users, so /api/advance is unreachable to a normal user even if
// they hand-craft the request. The frontend also hides the button, but THIS is the real guard.
export function requireAdmin(req: any, reply: any): User | null {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (!u.isAdmin) { reply.code(403).send({ error: 'admin only' }); return null; }
  return u;
}
export function validTactics(t: any): Tactics {
  const clamp = (v: any) => Math.max(0, Math.min(100, Number.isFinite(+v) ? Math.round(+v) : 50));
  return {
    aggression: clamp(t?.aggression), passingDirectness: clamp(t?.passingDirectness),
    overlapFrequency: clamp(t?.overlapFrequency), midfieldFreedom: clamp(t?.midfieldFreedom),
    defensiveLineHeight: clamp(t?.defensiveLineHeight),
  };
}
// The all-but-universal route preamble: require a logged-in user who manages a club, and return
// that club's id (401 logged-out, 404 'no team' otherwise — after which the caller just `return`s).
// The handful of routes that also need the `user` object (admin checks) keep the explicit pair.
export function requireTeam(req: any, reply: any): number | null {
  const user = requireUser(req, reply);
  if (!user) return null;
  const teamId = teamForUser(user.id);
  if (!teamId) { reply.code(404).send({ error: 'no team' }); return null; }
  return teamId;
}

// ── request-parameter validators ──
// Hand-rolled validation is the house style (raw fastify handlers, no schema layer), and the
// pre-split index.ts had drifted into THREE dialects for one check: 'bad slot' (5 routes),
// 'slot required' (4) and 'slot must be an integer' (4) — the last carrying a comment claiming
// it "matches every other slot route", which it did not. idParam is the single boundary check,
// so every module now rejects a malformed id identically, and a MISSING param reads differently
// from a MALFORMED one instead of both landing on one vague line.
// Returns null AFTER replying 400 — the caller just `return`s, exactly like requireTeam.
export function idParam(reply: any, raw: unknown, name: string): number | null {
  if (raw == null || raw === '') { reply.code(400).send({ error: `${name} is required` }); return null; }
  const n = Number(raw);
  if (!Number.isInteger(n)) { reply.code(400).send({ error: `${name} must be a whole number` }); return null; }
  if (n < 0) { reply.code(400).send({ error: `${name} must not be negative` }); return null; }
  return n;
}
// The same check for an OPTIONAL body field: absent → undefined (no reply), present but malformed
// → 400 + null. A caller distinguishes them with `=== null` (the `undefined` case falls through).
export function optionalIdParam(reply: any, raw: unknown, name: string): number | undefined | null {
  if (raw == null || raw === '') return undefined;
  return idParam(reply, raw, name);
}
// The world a stable players.id sits in, or null if he doesn't exist. The cross-tenant boundary for
// any route handed a raw player id: worlds are separate tenants (a solo world is one user's private
// save), so a route must never resolve an id from OUTSIDE the caller's world. Mirrors the guard on
// GET /api/worlds/:id/teams and the market's own 'player is outside your world' check.
export function worldOfPlayer(playerId: number): number | null {
  const r = db.prepare(`SELECT COALESCE(l.world_id, l.id) AS wid FROM players p
    JOIN teams t ON t.id = p.team_id JOIN leagues l ON l.id = t.league_id WHERE p.id = ?`)
    .get(playerId) as { wid: number } | undefined;
  return r?.wid ?? null;
}
// True when `playerId` is a real player inside the same world as `teamId`.
export function playerInMyWorld(teamId: number, playerId: number): boolean {
  const mine = worldForTeam(teamId);
  if (mine == null) return false;
  return worldOfPlayer(playerId) === mine;
}

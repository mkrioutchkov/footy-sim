// routes/shared.ts — the per-request guards + validators every route module shares: the
// pre-split index.ts 'auth helpers' section, moved verbatim (index.ts registers the modules).
import { createSession, getUserBySession, type User } from '../auth.ts';
import { db } from '../db.ts';
import { teamForUser, type Tactics } from '../game.ts';

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
    try { db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, u.id); } catch { /* non-fatal */ }
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

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { registerUser, loginUser, createSession, destroySession, getUserBySession, type User } from './auth.ts';
import { db } from './db.ts';
import {
  newSeasonForUser, getTeamWithPlayers, standings, teamForUser,
  DEFAULT_TACTICS, type Tactics,
} from './game.ts';
import { playFixture, getFixture, writeSpec, MatchStream } from './match.ts';

const PORT = Number.parseInt(process.env.FOOTY_PORT ?? '4000', 10);
const app = Fastify({ logger: false });
await app.register(cookie);

const DIST = path.resolve(process.cwd(), 'dist');
if (existsSync(DIST)) {
  await app.register(fstatic, { root: DIST });
}

// ── auth helpers ──
function currentUser(req: any): User | null {
  return getUserBySession(req.cookies?.sid);
}
function setSession(reply: any, userId: number): void {
  const sid = createSession(userId);
  reply.setCookie('sid', sid, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
}
function requireUser(req: any, reply: any): User | null {
  const u = currentUser(req);
  if (!u) { reply.code(401).send({ error: 'not logged in' }); return null; }
  return u;
}
function validTactics(t: any): Tactics {
  const clamp = (v: any) => Math.max(0, Math.min(100, Number.isFinite(+v) ? Math.round(+v) : 50));
  return {
    aggression: clamp(t?.aggression), passingDirectness: clamp(t?.passingDirectness),
    overlapFrequency: clamp(t?.overlapFrequency), midfieldFreedom: clamp(t?.midfieldFreedom),
    defensiveLineHeight: clamp(t?.defensiveLineHeight),
  };
}

// ── auth routes ──
app.post('/api/register', async (req: any, reply) => {
  const { username, password } = req.body ?? {};
  if (!username || !password || String(username).length < 2 || String(password).length < 4)
    return reply.code(400).send({ error: 'username (2+) and password (4+) required' });
  try {
    const user = registerUser(String(username).trim().slice(0, 32), String(password));
    setSession(reply, user.id);
    return { user };
  } catch { return reply.code(409).send({ error: 'username taken' }); }
});

app.post('/api/login', async (req: any, reply) => {
  const { username, password } = req.body ?? {};
  const user = loginUser(String(username ?? '').trim(), String(password ?? ''));
  if (!user) return reply.code(401).send({ error: 'invalid credentials' });
  setSession(reply, user.id);
  return { user };
});

app.post('/api/logout', async (req: any, reply) => {
  destroySession(req.cookies?.sid);
  reply.clearCookie('sid', { path: '/' });
  return { ok: true };
});

app.get('/api/me', async (req: any) => {
  const user = currentUser(req);
  if (!user) return { user: null };
  return { user, teamId: teamForUser(user.id) };
});

// ── team / league ──
app.post('/api/team', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  if (teamForUser(user.id)) return reply.code(409).send({ error: 'you already have a team' });
  const name = String(req.body?.name ?? '').trim().slice(0, 40) || `${user.username} FC`;
  const tactics = req.body?.tactics ? validTactics(req.body.tactics) : DEFAULT_TACTICS;
  const { teamId, leagueId } = newSeasonForUser(user.id, user.username, name, tactics);
  return { teamId, leagueId };
});

app.get('/api/team', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team yet' });
  return getTeamWithPlayers(teamId);
});

app.put('/api/tactics', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const tactics = validTactics(req.body?.tactics);
  db.prepare('UPDATE teams SET tactics = ? WHERE id = ?').run(JSON.stringify(tactics), teamId);
  return { tactics };
});

app.get('/api/league', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const leagueId = team.leagueId;
  const names = new Map((db.prepare('SELECT id, name FROM teams WHERE league_id = ?').all(leagueId) as { id: number; name: string }[]).map(t => [t.id, t.name]));
  const fixtures = (db.prepare(
    'SELECT id, round, home_team_id, away_team_id, played, home_score, away_score FROM fixtures WHERE league_id = ? ORDER BY round, id',
  ).all(leagueId) as any[]).map(f => ({
    id: f.id, round: f.round,
    home: names.get(f.home_team_id), away: names.get(f.away_team_id),
    homeTeamId: f.home_team_id, awayTeamId: f.away_team_id,
    played: !!f.played, homeScore: f.home_score, awayScore: f.away_score,
    involvesMe: f.home_team_id === teamId || f.away_team_id === teamId,
  }));
  return { leagueId, myTeamId: teamId, standings: standings(leagueId), fixtures };
});

// Play a specific fixture (must be in my league). Returns result + standings.
app.post('/api/fixtures/:id/play', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const fx = getFixture(Number(req.params.id));
  if (!fx) return reply.code(404).send({ error: 'fixture not found' });
  const team = getTeamWithPlayers(teamId)!;
  if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
  const result = await playFixture(fx.id);
  return { result, standings: standings(team.leagueId) };
});

// Advance a matchday: play my next unplayed fixture AND every other unplayed
// fixture in that same round, so the whole league table moves together.
app.post('/api/advance', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const mine = db.prepare(
    `SELECT id, round FROM fixtures WHERE league_id = ? AND played = 0
       AND (home_team_id = ? OR away_team_id = ?) ORDER BY round, id LIMIT 1`,
  ).get(team.leagueId, teamId, teamId) as { id: number; round: number } | undefined;
  if (!mine) return reply.code(404).send({ error: 'season complete' });
  const roundFixtures = db.prepare(
    'SELECT id FROM fixtures WHERE league_id = ? AND round = ? AND played = 0 ORDER BY id',
  ).all(team.leagueId, mine.round) as { id: number }[];
  // Sim the whole matchday concurrently (non-blocking) instead of one-at-a-time.
  const results = await Promise.all(roundFixtures.map(f => playFixture(f.id)));
  const myResult = results.find(r => r.fixtureId === mine.id) ?? null;
  return { round: mine.round, myFixtureId: mine.id, myResult, results, standings: standings(team.leagueId) };
});

// Convenience: play my next unplayed fixture.
app.post('/api/play-next', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const fx = db.prepare(
    `SELECT id FROM fixtures WHERE league_id = ? AND played = 0
       AND (home_team_id = ? OR away_team_id = ?) ORDER BY round, id LIMIT 1`,
  ).get(team.leagueId, teamId, teamId) as { id: number } | undefined;
  if (!fx) return reply.code(404).send({ error: 'no upcoming fixture' });
  const result = await playFixture(fx.id);
  return { fixtureId: fx.id, result, standings: standings(team.leagueId) };
});

// SPA fallback for client-side routing (only if a build exists). Must be
// registered before listen().
if (existsSync(DIST)) {
  app.setNotFoundHandler((req: any, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

const server = app.server;
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`footy game server on http://localhost:${PORT}`);

// ── match-watch WebSocket: /ws/match?fixture=ID (re-runs the deterministic sim) ──
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  if (url.pathname !== '/ws/match') { socket.destroy(); return; }
  const fixtureId = Number(url.searchParams.get('fixture'));
  const fx = getFixture(fixtureId);
  if (!fx) { socket.destroy(); return; }
  // Which side is the human watching? Resolve their team from the session cookie
  // so "we/us/all" and team-wide tactics ("park the bus") target the right side.
  const sid = request.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const user = sid ? getUserBySession(sid) : null;
  const myTeamId = user ? teamForUser(user.id) : null;
  const myTeam: 'home' | 'away' = myTeamId === fx.away_team_id ? 'away' : 'home';
  wss.handleUpgrade(request, socket, head, (ws) => {
    try {
      const specPath = writeSpec(fx);
      const nm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(fx.home_team_id, fx.away_team_id) as { id: number; name: string }[];
      const homeName = nm.find(t => t.id === fx.home_team_id)?.name ?? 'HOME';
      const awayName = nm.find(t => t.id === fx.away_team_id)?.name ?? 'AWAY';
      new MatchStream(ws as any, specPath, fx.seed, homeName, awayName, myTeam);
    } catch (e) { ws.close(); }
  });
});

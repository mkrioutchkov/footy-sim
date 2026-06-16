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
  assignPersonalities, needsPersonalities, backfillFreeAgents, backfillPotentials,
  playerValue, DEFAULT_TACTICS, type Tactics,
} from './game.ts';
import { deriveTraits, defaultPersonality, type Personality } from './personality.ts';
import { playFixture, getFixture, writeSpec, MatchStream } from './match.ts';
import { compileLineup } from './lineup.ts';
import { getMarket, buyFreeAgent, listPlayer, unlistPlayer, marketTick } from './market.ts';
import { developmentTick, setTrainingFocus, TRAINABLE, VALID_FOCUS } from './training.ts';
import { worldLeagues, pendingMatchday, seasonComplete, rolloverSeason, worldStandings } from './season.ts';
import { aiManagerTick } from './ai.ts';

const PORT = Number.parseInt(process.env.FOOTY_PORT ?? '4000', 10);
// Give any pre-market league a free-agent pool + every player a potential (one-time,
// idempotent backfills for saves that predate pillars 1 & 2).
backfillFreeAgents();
backfillPotentials();
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
  // Generate the squad's personalities in the background (best-effort, ~3s) so team
  // creation returns immediately; the dashboard backfills via /api/personalities.
  void assignPersonalities(teamId).catch(() => { /* defaults already stored on failure */ });
  return { teamId, leagueId };
});

// Generate personalities for the user's squad if any are missing (backfills teams
// created before this feature, and resolves the post-creation race). Returns the team.
app.post('/api/personalities', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  if (needsPersonalities(teamId)) await assignPersonalities(teamId);
  return getTeamWithPlayers(teamId);
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

// Set the team's formation / XI from a free-text instruction ("play 4-4-2",
// "AB at left back"). Compiles via the LLM lineup compiler, persists the shape +
// XI on the team (so every match that team plays uses it), and returns the
// resolved XI + note. Storing the default 4-3-3 identity as NULL keeps the
// byte-identical spec path for un-customised teams.
app.put('/api/lineup', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return reply.code(400).send({ error: 'say how you want to line up' });
  const team = getTeamWithPlayers(teamId)!;
  const squad = { players: team.players.slice().sort((a, b) => a.slot - b.slot).map(p => ({ name: p.name, role: p.role, attrs: p.attrs })) };
  const r = await compileLineup(text, squad);
  if (r.error) return reply.code(503).send({ error: r.error });
  if (!r.slots.length) return { formation: team.formation, lineup: team.lineup, slots: [], note: r.note || 'No change made.' };
  const lineup = r.slots.map(s => s.fromSlot);
  const isDefault = r.formation === '4-3-3' && lineup.every((v, i) => v === i);
  db.prepare('UPDATE teams SET formation = ?, lineup = ? WHERE id = ?')
    .run(r.formation, isDefault ? null : JSON.stringify(lineup), teamId);
  return { formation: r.formation, lineup: isDefault ? null : lineup, slots: r.slots, note: r.note };
});

// ── transfer market (pillar 1) ──
app.get('/api/market', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  return getMarket(teamId);
});

app.post('/api/market/buy', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const agentId = Number(req.body?.agentId);
  if (!Number.isInteger(agentId)) return reply.code(400).send({ error: 'agentId required' });
  const r = buyFreeAgent(teamId, agentId);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

app.post('/api/market/list', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  const price = req.body?.price != null ? Number(req.body.price) : undefined;
  const r = listPlayer(teamId, slot, price);
  if (!r.ok) return reply.code(400).send({ error: r.error });
  return { ...r, market: getMarket(teamId) };
});

app.post('/api/market/unlist', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.body?.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'slot required' });
  unlistPlayer(teamId, slot);
  return { ok: true, market: getMarket(teamId) };
});

// Rewrite a player's backstory/tagline and RE-DERIVE their trait dials from the new text
// (the text↔dial coupling: the dials are the story's machine-readable projection, and the
// training rate + transfer value read the dials live, so editing the story changes the
// player's underlying weights). LLM-primary with a deterministic keyword fallback.
app.put('/api/player/:slot/story', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const slot = Number(req.params.slot);
  if (!Number.isInteger(slot)) return reply.code(400).send({ error: 'bad slot' });
  const backstory = String(req.body?.backstory ?? '').trim().slice(0, 400);
  const tagline = String(req.body?.tagline ?? '').trim().slice(0, 80);
  if (!backstory) return reply.code(400).send({ error: 'a backstory is required' });
  const row = db.prepare('SELECT name, role, attrs, age, personality FROM players WHERE team_id = ? AND slot = ?')
    .get(teamId, slot) as { name: string; role: string; attrs: string; age: number; personality: string | null } | undefined;
  if (!row) return reply.code(404).send({ error: 'player not found' });
  let prev: Personality | null = null;
  try { prev = row.personality ? JSON.parse(row.personality) : null; } catch { /* ignore */ }
  const traits = await deriveTraits(row.name, row.role, backstory, tagline);
  const personality: Personality = { traits, nationality: prev?.nationality ?? defaultPersonality(row.name, row.role).nationality, backstory, tagline };
  db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?').run(JSON.stringify(personality), teamId, slot);
  // return the re-derived weights so the UI can show the story drove the numbers
  return { slot, personality, value: playerValue(JSON.parse(row.attrs), row.age, personality) };
});

// Set the club's training focus ('balanced' or a trainable attribute). Drives the
// development tick that runs each matchday.
app.put('/api/training', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const focus = String(req.body?.focus ?? '');
  if (!VALID_FOCUS.has(focus)) return reply.code(400).send({ error: `focus must be one of: balanced, ${TRAINABLE.join(', ')}` });
  return setTrainingFocus(teamId, focus);
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
  const lg = db.prepare('SELECT season, tier, name FROM leagues WHERE id = ?').get(leagueId) as { season: number; tier: number; name: string };
  // world = every division's table (for the "other divisions" peek); the user's row is
  // flagged isUser within each division's standings.
  return {
    leagueId, myTeamId: teamId, standings: standings(leagueId), fixtures,
    season: lg.season, tier: lg.tier, divisionName: lg.name, world: worldStandings(leagueId),
    // gates the "advance" button on the whole world, not just the user's own fixtures:
    // a user who watched all their matches still needs to play out the other games.
    seasonComplete: seasonComplete(leagueId),
  };
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

// Advance a matchday: play my next unplayed round across EVERY division of my world (so
// both tables move together), then run the market + training ticks for each division. If
// that completes the season, roll it over (prize money, promotion/relegation, ageing, new
// fixtures) and return the summary.
app.post('/api/advance', async (req: any, reply) => {
  const user = requireUser(req, reply); if (!user) return;
  const teamId = teamForUser(user.id);
  if (!teamId) return reply.code(404).send({ error: 'no team' });
  const team = getTeamWithPlayers(teamId)!;
  const leagues = worldLeagues(team.leagueId);
  // the round number the user's own division is completing this matchday (for the UI)
  const userRound = (db.prepare('SELECT MIN(round) AS r FROM fixtures WHERE league_id = ? AND played = 0').get(team.leagueId) as { r: number | null }).r;
  const toPlay = pendingMatchday(team.leagueId);
  if (!toPlay.length) return reply.code(404).send({ error: 'season complete' });
  const results = await Promise.all(toPlay.map(id => playFixture(id)));
  // the user's match this matchday (null if they'd already played/watched it ahead)
  const myFx = userRound == null ? null
    : db.prepare('SELECT id FROM fixtures WHERE league_id = ? AND round = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1').get(team.leagueId, userRound, teamId, teamId) as { id: number } | undefined;
  const myResult = myFx ? results.find(r => r.fixtureId === myFx.id) ?? null : null;
  // The world progresses between matchdays: AI clubs trade + manage, then every player
  // trains. (marketTick = transfers; aiManagerTick = training focus + best XI; then dev.)
  const transfers: any[] = [];
  let developed = 0;
  for (const l of leagues) { transfers.push(...marketTick(l.id)); aiManagerTick(l.id); developed += developmentTick(l.id).players; }
  // End of season? Roll it over and report the new standings of whichever division the
  // user now sits in (they may have just been promoted or relegated).
  const rollover = seasonComplete(team.leagueId) ? rolloverSeason(team.leagueId) : null;
  const nowLeagueId = getTeamWithPlayers(teamId)!.leagueId;
  return {
    round: userRound, myFixtureId: myFx?.id ?? null, myResult, results,
    transfers, development: { players: developed }, rollover,
    standings: standings(nowLeagueId),
  };
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

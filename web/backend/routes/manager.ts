// routes/manager.ts — the manager's desk, off the pitch: press conferences, the shortlist +
// scouting search + stat leaders, 1-to-1 player talks, player career/progression views,
// dressing-room concerns, the boardroom, and the manager's own career record. Split out of
// index.ts. (Not the AI manager — that lives in ../manager/.)
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { getTeamWithPlayers, standings } from '../game.ts';
import { applyPressResponse, generatePressQuestion, pressAvailable, recordPress } from '../press.ts';
import { interactWithPlayer, isInteractTone } from '../interaction.ts';
import { leagueLeaders } from '../leaders.ts';
import { getShortlist, shortlistIds, toggleShortlist } from '../shortlist.ts';
import { searchPlayers } from '../market.ts';
import { getConcerns, resolveConcern, type ConcernAction } from '../concerns.ts';
import { getBoardMeeting, requestBoardBacking, type BoardRequestKind } from '../board.ts';
import { getManagerCareer, managerReputation } from '../career.ts';
import { getPlayerCareer } from '../history.ts';
import { getAttrProgression } from '../training.ts';
import { getObjective } from '../objectives.ts';
import { getConfidence } from '../confidence.ts';
import { requireUser, requireTeam, idParam, playerInMyWorld } from './shared.ts';

export function registerManagerRoutes(app: FastifyInstance): void {
  // Hold a press conference: the manager's statement (free text) is judged against each
  // player's personality dials to move squad morale. LLM-primary with a deterministic fallback.
  const pressInFlight = new Set<number>();   // a presser is mid-judge (multi-second LLM await) — see the guard below

  // Interactive press: a context-aware journalist question + tone-keyed response options (LLM, with a
  // deterministic template fallback). The frontend shows the question + lets the manager pick a tone.
  app.get('/api/press', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    if (!pressAvailable(teamId)) return { available: false };
    const team = getTeamWithPlayers(teamId)!;
    const last5 = db.prepare('SELECT home_team_id, away_team_id, home_score, away_score FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 1 ORDER BY round DESC LIMIT 5')
      .all(teamId, teamId) as { home_team_id: number; away_team_id: number; home_score: number | null; away_score: number | null }[];
    const res = (f: typeof last5[number]): 'W' | 'D' | 'L' => {
      const gf = f.home_team_id === teamId ? (f.home_score ?? 0) : (f.away_score ?? 0);
      const ga = f.home_team_id === teamId ? (f.away_score ?? 0) : (f.home_score ?? 0);
      return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    };
    const form = last5.slice().reverse().map(res).join('');   // oldest → newest
    const nextFx = db.prepare('SELECT home_team_id, away_team_id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round LIMIT 1')
      .get(teamId, teamId) as { home_team_id: number; away_team_id: number } | undefined;
    const oppId = nextFx ? (nextFx.home_team_id === teamId ? nextFx.away_team_id : nextFx.home_team_id) : null;
    const nextOpponent = oppId != null ? (db.prepare('SELECT name FROM teams WHERE id = ?').get(oppId) as { name: string } | undefined)?.name : undefined;
    const tbl = standings(team.leagueId);
    const idx = tbl.findIndex(s => (s as { isUser?: boolean }).isUser);
    // the just-played match (scoreline + opponent) → a post-match-style, result-aware press question
    let lastMatch: { result: 'W' | 'D' | 'L'; gf: number; ga: number; opponent: string; home: boolean } | undefined;
    if (last5.length) {
      const f0 = last5[0];
      const home = f0.home_team_id === teamId;
      const oppName = (db.prepare('SELECT name FROM teams WHERE id = ?').get(home ? f0.away_team_id : f0.home_team_id) as { name: string } | undefined)?.name;
      if (oppName) lastMatch = { result: res(f0), gf: home ? (f0.home_score ?? 0) : (f0.away_score ?? 0), ga: home ? (f0.away_score ?? 0) : (f0.home_score ?? 0), opponent: oppName, home };
    }
    const q = await generatePressQuestion({
      form, lastResult: last5.length ? res(last5[0]) : undefined, lastMatch,
      position: idx >= 0 ? idx + 1 : 0, teams: tbl.length,
      objective: getObjective(teamId)?.label, nextOpponent, confidence: getConfidence(teamId)?.status,
    });
    return { available: true, ...q };
  });

  app.post('/api/press', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const text = String(req.body?.text ?? '').trim().slice(0, 400);
    const tone = typeof req.body?.tone === 'string' ? req.body.tone : undefined;   // the chosen option's tone (board effect)
    if (!text) return reply.code(400).send({ error: 'say something to the media' });
    // one presser per match — you can't spam the media to farm morale
    if (!pressAvailable(teamId)) return reply.code(400).send({ error: "you've already faced the media this matchday — nothing new to say until your next game." });
    // Close the double-submit race: pressAvailable() → await → recordPress() lets two concurrent submits both
    // pass the gate before either records, double-applying morale. The check+add below is synchronous (no await
    // between), so on Node's single thread the second submit always sees the in-flight flag and is rejected.
    if (pressInFlight.has(teamId)) return reply.code(409).send({ error: "you're already in front of the media." });
    pressInFlight.add(teamId);
    try {
      const r = await applyPressResponse(teamId, text, tone);   // morale (dials) + board confidence (tone)
      recordPress(teamId);   // only consume the once-per-match cadence on success (a failed judge can be retried)
      return { ...r, confidence: getConfidence(teamId), team: getTeamWithPlayers(teamId) };
    } finally {
      pressInFlight.delete(teamId);
    }
  });

  // §shortlist: the manager's transfer watchlist (resolved to live rows) + the tracked id set for the ★ toggle.
  app.get('/api/shortlist', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { shortlist: getShortlist(teamId), ids: shortlistIds(teamId) };
  });
  app.post('/api/shortlist', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const playerId = idParam(reply, req.body?.playerId, 'playerId'); if (playerId == null) return;
    const add = req.body?.add !== false;   // default to add unless explicitly false
    // World scope. toggleShortlist stores whatever id it is handed and getShortlist resolves ids
    // GLOBALLY, so an unchecked add let any logged-in user read name/club/role/age/overall/value/
    // release-clause for any player in any OTHER user's private solo world by scanning ids — the
    // same enumeration hole GET /api/worlds/:id/teams already gates. searchPlayers (the only place
    // the UI gets an id for this route) is world-scoped, so this rejects nothing the UI can send.
    // Only the ADD is gated: a REMOVE must always work, or an id that predates this check (or a
    // player who has since moved worlds) would be un-deletable from the list.
    if (add && !playerInMyWorld(teamId, playerId)) return reply.code(404).send({ error: 'no such player' });
    const r = toggleShortlist(teamId, playerId, add);
    return { ...r, shortlist: getShortlist(teamId), ids: shortlistIds(teamId) };
  });

  // §scouting-centre: search the whole player population of the user's world by role/age/overall/value/
  // name, with attributes fogged to the club's scout depth. Filters come in as query params (all optional).
  app.get('/api/search', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const q = req.query ?? {};
    const num = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : undefined; };
    return searchPlayers(teamId, {
      role: typeof q.role === 'string' && q.role ? q.role : undefined,
      maxAge: num(q.maxAge),
      minOverall: num(q.minOverall),
      maxValue: num(q.maxValue),
      name: typeof q.name === 'string' ? q.name : undefined,
      onlyShortlisted: q.shortlisted === '1' || q.shortlisted === 'true',
    });
  });

  // §stat-leaders: the current division's top scorers + top assisters this season.
  app.get('/api/leaders', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const l = leagueLeaders(teamId);
    if (!l) return reply.code(404).send({ error: 'no team' });
    return l;
  });

  // §player-interaction: a private 1-to-1 word with one player (praise/encourage/warn/criticise) that moves
  // his morale via his personality dials. One chat per player per matchday (cooldown enforced in the module).
  app.post('/api/player/:slot/interact', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.params?.slot, 'slot'); if (slot == null) return;
    if (!isInteractTone(req.body?.tone)) return reply.code(400).send({ error: 'unknown tone' });
    const r = interactWithPlayer(teamId, slot, req.body.tone);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return r;
  });

  // A squad player's archived career — one row per finished season (goals/assists/apps/avg-rating),
  // resolved slot → stable players.id within the user's own club (career only for players you manage).
  app.get('/api/player/:slot/career', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.params?.slot, 'slot'); if (slot == null) return;
    const row = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such player in your squad' });
    return { career: getPlayerCareer(row.id) };
  });

  // A squad player's attribute-progression series — one snapshot per developed matchday (attr_snapshots),
  // for the Development graph. Same slot → stable players.id resolution as /career (auth boundary).
  app.get('/api/player/:slot/progression', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.params?.slot, 'slot'); if (slot == null) return;
    const row = db.prepare('SELECT id FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { id: number } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such player in your squad' });
    return { progression: getAttrProgression(row.id) };
  });

  // Unsettled players (§2.3 depth) — the dressing-room concerns the manager can act on, + resolving one.
  app.get('/api/concerns', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return { concerns: getConcerns(teamId) };
  });

  app.post('/api/concerns/:slot', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const slot = idParam(reply, req.params?.slot, 'slot'); if (slot == null) return;   // reject a bad param at the boundary (matches every other slot route — see shared.idParam)
    const action = String(req.body?.action ?? '') as ConcernAction;
    if (!['reassure', 'accept', 'reject'].includes(action)) return reply.code(400).send({ error: 'unknown action' });
    const r = resolveConcern(teamId, slot, action);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    return { ...r, concerns: getConcerns(teamId), team: getTeamWithPlayers(teamId) };
  });

  // Board meeting (board interaction) — the once-a-season audience state, and requesting backing.
  app.get('/api/board', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    return getBoardMeeting(teamId);
  });

  app.post('/api/board/request', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const kind = String(req.body?.kind ?? '') as BoardRequestKind;
    if (kind !== 'funds' && kind !== 'wages') return reply.code(400).send({ error: 'kind must be funds or wages' });
    const r = requestBoardBacking(teamId, kind);
    if (!r.ok) return reply.code(400).send({ error: r.message });
    return { ...r, meeting: getBoardMeeting(teamId), team: getTeamWithPlayers(teamId) };
  });

  // The manager's career record (aggregated from season_history across every club they've managed).
  app.get('/api/career', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const career = getManagerCareer(user.id);
    return { ...career, reputation: managerReputation(career) };   // §P2#9 the synthesised media standing
  });
}

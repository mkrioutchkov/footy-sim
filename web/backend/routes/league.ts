// routes/league.ts — the competition dashboards: the cup bracket, the league screen (standings,
// fixtures + weather, board mood/messages, the world turn model) and playing one of your own
// fixtures. Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { getTeamWithPlayers, standings, teamForUser } from '../game.ts';
import { playFixture, getFixture, weatherForSeed } from '../match.ts';
import { cupView } from '../cup.ts';
import { worldStandings, seasonComplete, PROMOTE } from '../season.ts';
import { worldForTeam, getWorld } from '../worlds.ts';
import { getObjective } from '../objectives.ts';
import { getConfidence, boardMood, boardMessages } from '../confidence.ts';
import { pressAvailable } from '../press.ts';
import { requireUser, requireTeam } from './shared.ts';

export function registerLeagueRoutes(app: FastifyInstance): void {
  // The cup bracket for the user's world this season.
  app.get('/api/cup', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const team = getTeamWithPlayers(teamId)!;
    return { ...cupView(team.leagueId), myTeamId: teamId };
  });

  app.get('/api/league', async (req: any, reply) => {
    const user = requireUser(req, reply); if (!user) return;
    const teamId = teamForUser(user.id);
    if (!teamId) return reply.code(404).send({ error: 'no team' });
    const team = getTeamWithPlayers(teamId)!;
    const leagueId = team.leagueId;
    const names = new Map((db.prepare('SELECT id, name FROM teams WHERE league_id = ?').all(leagueId) as { id: number; name: string }[]).map(t => [t.id, t.name]));
    const fixtures = (db.prepare(
      'SELECT id, round, home_team_id, away_team_id, played, home_score, away_score, seed FROM fixtures WHERE league_id = ? ORDER BY round, id',
    ).all(leagueId) as any[]).map(f => ({
      id: f.id, round: f.round,
      home: names.get(f.home_team_id), away: names.get(f.away_team_id),
      homeTeamId: f.home_team_id, awayTeamId: f.away_team_id,
      played: !!f.played, homeScore: f.home_score, awayScore: f.away_score,
      involvesMe: f.home_team_id === teamId || f.away_team_id === teamId,
      weather: weatherForSeed(f.seed),   // §weather: the deterministic per-match condition (forecast / what happened)
    }));
    const lg = db.prepare('SELECT season, tier, name FROM leagues WHERE id = ?').get(leagueId) as { season: number; tier: number; name: string };
    const table = standings(leagueId);
    const objective = getObjective(teamId);
    const confidence = getConfidence(teamId);
    // mid-season board mood: a weekly pulse on the once-a-season verdict, from confidence + whether
    // the club is currently meeting the board's target.
    const myPos = table.findIndex(s => s.teamId === teamId) + 1;
    const onTrack = objective ? (myPos > 0 && myPos <= objective.target) : true;
    const mood = confidence ? boardMood(confidence.status, onTrack) : null;
    // Event-driven board comms: react to my last played match + set expectations for my next one.
    const mine = fixtures.filter(f => f.involvesMe);
    const last = mine.filter(f => f.played).at(-1);
    const lastResult = last ? (() => {
      const home = last.homeTeamId === teamId;
      const gf = (home ? last.homeScore : last.awayScore) ?? 0;
      const ga = (home ? last.awayScore : last.homeScore) ?? 0;
      const outcome: 'W' | 'D' | 'L' = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      return { outcome, gf, ga, opponent: (home ? last.away : last.home) ?? '' };
    })() : null;
    const nextFx = mine.find(f => !f.played);
    const posOf = (tid: number): number => { const i = table.findIndex(s => s.teamId === tid); return i >= 0 ? i + 1 : 0; };
    const nextMatch = nextFx ? {
      opponent: (nextFx.homeTeamId === teamId ? nextFx.away : nextFx.home) ?? '',
      home: nextFx.homeTeamId === teamId,
      myPos, oppPos: posOf(nextFx.homeTeamId === teamId ? nextFx.awayTeamId : nextFx.homeTeamId),
    } : null;
    const messages = boardMessages({ status: confidence?.status ?? null, objectiveKind: objective?.kind ?? null, lastResult, nextMatch });
    // world = every division's table (for the "other divisions" peek); the user's row is
    // flagged isUser within each division's standings.
    return {
      leagueId, myTeamId: teamId, standings: table, fixtures,
      season: lg.season, tier: lg.tier, divisionName: lg.name, world: worldStandings(leagueId),
      // gates the "advance" button on the whole world, not just the user's own fixtures:
      // a user who watched all their matches still needs to play out the other games.
      seasonComplete: seasonComplete(leagueId),
      objective,                         // the board's expectation this season (null if unset)
      promote: PROMOTE,                  // bottom N are relegated — lets the UI place the drop line
      confidence,                        // board confidence / job security
      boardMood: mood,                   // mid-season board mood line (null if no confidence)
      boardMessages: messages,           // event-driven board comms: last-result reaction + next-match expectation
      pressAvailable: pressAvailable(teamId),   // §2.14: can the manager hold a press conference this matchday
      // §autonomous: the world's turn model. 'solo' → the owner advances on demand (show the button);
      // 'shared' → the scheduler advances it, so surface the next-turn ETA instead of a manual button.
      world_turn: (() => {
        const wid = worldForTeam(teamId); const w = wid != null ? getWorld(wid) : null;
        if (!w) return { mode: 'solo' as const, turn: 0, canAdvance: !!user.isAdmin };
        const nextTurnAt = w.mode === 'shared' && w.lastAdvanced != null ? w.lastAdvanced + w.intervalMin * 60000 : null;
        // §autonomous: surface the team's autonomy tier so a shared-world manager can see/toggle whether the
        // assistant only sets tactics+XI ('assistant') or also makes transfers while they're away ('full').
        const autonomy = (db.prepare('SELECT autonomy FROM teams WHERE id = ?').get(teamId) as { autonomy: string | null } | undefined)?.autonomy === 'full' ? 'full' : 'assistant';
        return { mode: w.mode, turn: w.turn, intervalMin: w.intervalMin, lastAdvanced: w.lastAdvanced, nextTurnAt, canAdvance: user.isAdmin || w.mode === 'solo', autonomy };
      })(),
    };
  });

  // Play a specific fixture (must be in my league). Returns result + standings.
  app.post('/api/fixtures/:id/play', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const fx = getFixture(Number(req.params.id));
    if (!fx) return reply.code(404).send({ error: 'fixture not found' });
    const team = getTeamWithPlayers(teamId)!;
    if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
    // Ownership: only YOUR own fixtures can be played here (watching your next match records its result early).
    // Spectating another club's game must NOT pre-play it out of order vs pendingMatchday — that's the advance's job.
    if (fx.home_team_id !== teamId && fx.away_team_id !== teamId) return reply.code(403).send({ error: 'not your fixture' });
    const result = await playFixture(fx.id);
    return { result, standings: standings(team.leagueId) };
  });
}

// routes/reports.ts — reading matches back + club news: the post-match report (league + cup
// with shootout framing), the shout/tactics review, pre-match opponent scouting, the
// player-news feed and the persistent inbox. Split out of index.ts.
import type { FastifyInstance } from 'fastify';
import { db } from '../db.ts';
import { getTeamWithPlayers } from '../game.ts';
import { getFixture, loadEventsLog, tacticsReview } from '../match.ts';
import { cupTieWinnerId } from '../cup.ts';
import { buildMatchReport } from '../report.ts';
import { buildScoutReport } from '../scout.ts';
import { recentNews } from '../news.ts';
import { getInbox, countUnread, markInboxRead } from '../inbox.ts';
import { worldForTeam } from '../worlds.ts';
import { requireTeam } from './shared.ts';

export function registerReportRoutes(app: FastifyInstance): void {
  // Post-match report + ratings for a played fixture (cached; generated from the recording on
  // first view). 404 if the match has no recording (e.g. a distant AI-vs-AI game).
  app.get('/api/report', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    // §cup-report: a cup tie's report (the recording exists for the user's ties). Same builder, kind='cup'.
    if (req.query?.cup != null) {
      const tie = db.prepare('SELECT * FROM cup_ties WHERE id = ?').get(Number(req.query.cup)) as { id: number; world_id: number; home_team_id: number | null; away_team_id: number | null; seed: number; played: number; home_score: number | null; away_score: number | null; home_pens: number | null; away_pens: number | null; winner_team_id: number | null } | undefined;
      if (!tie || !tie.played || tie.home_team_id == null || tie.away_team_id == null) return reply.code(404).send({ error: 'cup tie not found' });
      // The caller's world, via worlds.worldForTeam (COALESCE(world_id, id)) rather than a third
      // hand-rolled copy of that query. The copy this replaces cast its row WITHOUT `| undefined` and
      // then dereferenced it — unreachable today (requireTeam guarantees the team, and a team always
      // has a league) but a 500 waiting for the first schema change that makes it reachable.
      if (tie.world_id !== worldForTeam(teamId)) return reply.code(403).send({ error: 'not your world' });
      const cnm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(tie.home_team_id, tie.away_team_id) as { id: number; name: string }[];
      const chome = cnm.find(t => t.id === tie.home_team_id)?.name ?? 'Home';
      const caway = cnm.find(t => t.id === tie.away_team_id)?.name ?? 'Away';
      const crep = await buildMatchReport('cup', tie.id, chome, caway);
      if (!crep) return reply.code(404).send({ error: 'no recording for this tie' });
      if (tie.home_pens != null && tie.away_pens != null && tie.home_pens !== tie.away_pens) {
        const winner: 'home' | 'away' = cupTieWinnerId({ ...tie, home_team_id: tie.home_team_id, away_team_id: tie.away_team_id }) === tie.home_team_id ? 'home' : 'away';
        const winnerName = winner === 'home' ? chome : caway;
        const winnerPens = winner === 'home' ? tie.home_pens : tie.away_pens;
        const loserPens = winner === 'home' ? tie.away_pens : tie.home_pens;
        const decider = `${winnerName} won ${winnerPens}–${loserPens} on penalties after the tie finished ${crep.facts.homeScore}–${crep.facts.awayScore}.`;
        return {
          homeName: chome, awayName: caway, ...crep,
          headline: `${crep.headline} (${tie.home_pens}–${tie.away_pens} pens)`,
          body: `${decider} ${crep.body}`,
          shootout: { home: tie.home_pens, away: tie.away_pens, winner },
        };
      }
      return { homeName: chome, awayName: caway, ...crep, shootout: null };
    }
    const fx = getFixture(Number(req.query?.fixture));
    if (!fx) return reply.code(404).send({ error: 'fixture not found' });
    const team = getTeamWithPlayers(teamId)!;
    if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
    const nm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(fx.home_team_id, fx.away_team_id) as { id: number; name: string }[];
    const homeName = nm.find(t => t.id === fx.home_team_id)?.name ?? 'Home';
    const awayName = nm.find(t => t.id === fx.away_team_id)?.name ?? 'Away';
    const report = await buildMatchReport('fixture', fx.id, homeName, awayName);
    if (!report) return reply.code(404).send({ error: 'no recording for this match' });
    return { homeName, awayName, ...report };
  });

  // The shout/tactics review for a watched match — the persisted command log digested to
  // {minute, text, what-it-changed}. Empty `shouts` if the match was watched without shouting
  // (or never live-watched). Reads the durable events log MatchStream writes on socket close.
  app.get('/api/tactics', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const fx = getFixture(Number(req.query?.fixture));
    if (!fx) return reply.code(404).send({ error: 'fixture not found' });
    const team = getTeamWithPlayers(teamId)!;
    if (fx.league_id !== team.leagueId) return reply.code(403).send({ error: 'not your league' });
    // PARTICIPANT scope, not league scope (the sibling POST /api/fixtures/:id/play already draws the
    // line here). A shout log is the manager's own in-match instructions in his own words; only the
    // two clubs in the tie ever produce one, so a league-wide guard leaked a RIVAL HUMAN's shouts in
    // a shared world — read straight off the league screen's Report button. Nothing legitimate is
    // lost: for any other fixture there is no log, and the frontend already falls back to an empty
    // review on error (app.ts `api.tactics(...).catch(() => ({ shouts: [] }))`).
    if (fx.home_team_id !== teamId && fx.away_team_id !== teamId) return reply.code(403).send({ error: 'not your fixture' });
    const log = loadEventsLog('fixture', fx.id);
    if (!log) return { shouts: [] };
    return tacticsReview(log);
  });

  // Pre-match opponent scouting report for an upcoming fixture the user is in (form, table
  // position, danger men, a read of how they play). 404 if the fixture isn't the user's.
  app.get('/api/scout', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const report = buildScoutReport(Number(req.query?.fixture), teamId);
    if (!report) return reply.code(404).send({ error: 'no scout report for this fixture' });
    return report;
  });

  // The club's player-news feed (events that evolved a player's story this/past seasons).
  app.get('/api/news', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit) || 20));   // §2.14: the archive asks for more
    return { news: recentNews(teamId, limit) };
  });

  // §inbox: the persistent matchday feed (results/transfers/injuries/contracts/cup/board/awards), newest
  // first + the unread count. Written server-side at /api/advance; survives rollover, grouped by season.
  app.get('/api/inbox', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    const limit = Math.min(200, Math.max(1, Number((req.query as any)?.limit) || 50));
    return { inbox: getInbox(teamId, limit), unread: countUnread(teamId) };
  });
  app.post('/api/inbox/read', async (req: any, reply) => {
    const teamId = requireTeam(req, reply); if (teamId == null) return;
    markInboxRead(teamId, { id: req.body?.id != null ? Number(req.body.id) : undefined, all: !!req.body?.all });
    return { ok: true, unread: countUnread(teamId) };
  });
}

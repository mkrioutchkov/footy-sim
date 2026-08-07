// routes/watch.ts — the match-watch WebSocket (/ws/match): recorded replays, cup replays, the
// shout-log re-sim, the shared live coordinator path, and the classic MatchStream live re-sim.
// registerMatchWatch(server) attaches the upgrade handler to the raw HTTP server, called by
// index.ts right where this block sat pre-split (after listen). Split out of index.ts.
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { db } from '../db.ts';
import { getUserBySession } from '../auth.ts';
import { getTeamWithPlayers, teamForUser } from '../game.ts';
import { getFixture, writeSpec, MatchStream, ReplayStream, EventsReplayStream, recordingFor, loadRecording, hasHumanStake, loadEventsLog } from '../match.ts';
import { joinLiveMatch, liveKey, type Seat } from '../coordinator.ts';
import { worldForTeam, worldRootId } from '../worlds.ts';

// ── match-watch WebSocket: /ws/match?fixture=ID (re-runs the deterministic sim) ──
export function registerMatchWatch(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    if (url.pathname !== '/ws/match') { socket.destroy(); return; }
    // Who is on the other end of this socket? A WS upgrade never reaches a fastify handler, so the
    // session is read straight off the Cookie header. Resolved ONCE up front because BOTH branches
    // below need it — the cup branch for its world guard, the fixture branch for its world guard and
    // for the seat. (Pre-split these were two separate copies of the same three lines, and only the
    // cup one carried a guard; see the fixture branch.)
    const sid = request.headers.cookie?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
    const user = sid ? getUserBySession(sid) : null;
    const myTeamId = user ? teamForUser(user.id) : null;
    const myWorldId = myTeamId != null ? worldForTeam(myTeamId) : null;
    // §cup-watch: replay a recorded cup tie (?cup=TIE_ID). The user's own ties are recorded (human stake);
    // a cup tie with no recording (AI-vs-AI) sends an error frame rather than a blank pitch. Replay-only —
    // cup ties aren't shout-driven, so no live re-sim / coordinator path.
    if (url.searchParams.get('cup')) {
      const tieId = Number(url.searchParams.get('cup'));
      const tie = db.prepare('SELECT id, world_id, home_team_id, away_team_id, seed, played FROM cup_ties WHERE id = ?').get(tieId) as { id: number; world_id: number; home_team_id: number | null; away_team_id: number | null; seed: number; played: number } | undefined;
      if (!tie || !tie.played || tie.home_team_id == null || tie.away_team_id == null) { socket.destroy(); return; }
      // World-scope guard (mirrors the cup-report REST branch's 403): only a manager in the tie's own world
      // may watch it back. Cup ties are personal — only your own club's ties are recorded — so this never
      // blocks a legitimate watch, but it stops another tenant streaming your replay by guessing a tie id.
      if (myWorldId == null || tie.world_id !== myWorldId) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => {
        try {
          const cnm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(tie.home_team_id, tie.away_team_id) as { id: number; name: string }[];
          const chome = cnm.find(t => t.id === tie.home_team_id)?.name ?? 'HOME';
          const caway = cnm.find(t => t.id === tie.away_team_id)?.name ?? 'AWAY';
          const rec = recordingFor('cup', tieId);
          const frames = rec ? loadRecording(rec) : [];
          if (frames.length) { new ReplayStream(ws as any, frames, tie.seed, chome, caway); return; }
          ws.send(JSON.stringify({ error: 'This cup tie wasn’t recorded — only ties your club played can be watched back.' }));
          ws.close();
        } catch (e) {
          // Setting up the replay threw (a missing team row, an unreadable recording file). Say so —
          // both to the watcher, who otherwise sits on a blank pitch, and to the server log, which is
          // the only place a maintainer can see WHY. The inner catch is genuinely ambient: the socket
          // may already be gone, and there is nothing left to do about it either way.
          console.warn(`[watch] cup tie ${tieId} replay failed:`, e);
          try { ws.send(JSON.stringify({ error: 'Could not open this cup tie — the server hit an error setting up the replay.' })); } catch { /* socket already gone */ }
          try { ws.close(); } catch { /* socket already gone */ }
        }
      });
      return;
    }
    const fixtureId = Number(url.searchParams.get('fixture'));
    const fx = getFixture(fixtureId);
    if (!fx) { socket.destroy(); return; }
    // World-scope guard — the SAME check the cup branch above has carried all along, which this path
    // was simply missing (the b9767c0 split put the two branches side by side and made that visible).
    // Without it /ws/match?fixture=N had no ownership check of any kind: an ANY-world user, or a socket
    // with no session at all, could stream a full match out of another user's private solo save just by
    // guessing a fixture id — and on a fixture with no stored recording the server SPAWNED THE ENGINE to
    // re-simulate it for them. Reproduced pre-fix: an anonymous socket received 74 frames of another
    // tenant's match, while the same probe against ?cup= was refused. World scope (not the narrower
    // league scope) is deliberate: it is what the cup branch uses, and it is strictly wider than the UI
    // needs, since the watch buttons only ever offer fixtures from /api/league (the caller's division).
    if (myWorldId == null || worldRootId(fx.league_id) !== myWorldId) { socket.destroy(); return; }
    // Which side is the human watching? Their team is resolved from the session cookie above, so
    // "we/us/all" and team-wide tactics ("park the bus") target the right side.
    // This socket's seat. A manager of one of the TWO teams in this fixture gets that side (and may
    // shout); anyone else — a manager of a different club in the same world — is a spectator: watch
    // only, NO tactics. (§1.2: the watch socket had no ownership check and defaulted everyone to
    // 'home', so a crafted message could tweak the home team's tactics live. §1.2 called an
    // unauthenticated socket a spectator; the world guard above now refuses it outright, which is
    // strictly stronger — the seat logic below is unchanged and still the guard against shouting.)
    const seat: Seat = myTeamId === fx.home_team_id ? 'home' : myTeamId === fx.away_team_id ? 'away' : 'spectator';
    const myTeam: 'home' | 'away' = seat === 'away' ? 'away' : 'home';
    const canShout = seat !== 'spectator';
    wss.handleUpgrade(request, socket, head, (ws) => {
      try {
        const nm = db.prepare('SELECT id, name FROM teams WHERE id IN (?, ?)').all(fx.home_team_id, fx.away_team_id) as { id: number; name: string }[];
        const homeName = nm.find(t => t.id === fx.home_team_id)?.name ?? 'HOME';
        const awayName = nm.find(t => t.id === fx.away_team_id)?.name ?? 'AWAY';
        // A recorded match replays its stored frames (no engine spawn, no re-sim drift). We load
        // the frames here and only replay if there ARE frames — a metadata row that outlived its
        // file (manual disk clear, an interrupted prune) falls through to the live re-sim instead
        // of hanging the watch on a blank pitch. No recording at all → live re-sim (with shouts).
        const rec = recordingFor('fixture', fixtureId);
        const frames = rec ? loadRecording(rec) : [];
        if (frames.length) { new ReplayStream(ws as any, frames, fx.seed, homeName, awayName); return; }
        // "▶ Replay from your shouts" (?shouts=1): a shout-driven match that wasn't frame-recorded still
        // has a persisted command log — stream a PACED re-sim from it (deterministic), rather than the
        // live re-sim which would start from an empty plan. (A frame-recorded match already replays its
        // shouts via ReplayStream above.)
        if (url.searchParams.get('shouts') === '1') {
          const log = loadEventsLog('fixture', fixtureId);
          if (log) { new EventsReplayStream(ws as any, log, fx.seed, homeName, awayName); return; }
        }
        // Seed the live shout box from the manager's persisted standing plan (team-relative ids;
        // MatchStream resolves them to this watch's roster) so shouts edit the standing plan.
        const seedPlan = canShout ? (getTeamWithPlayers(myTeamId!)?.plan ?? null) : null;
        // `?live=1` (opt-in) routes to the SHARED resident coordinator (docs/LIVE_MATCH_ARCHITECTURE.md
        // §2): one engine per fixture, both managers + spectators attach, shouts inject live (no
        // kill-respawn). The default path (no live flag) is unchanged → byte-identical. NOTE: needs
        // Boris's engine Phase 1 (FOOTY_LIVE) to actually run; until then this branch is build-ahead.
        if (url.searchParams.get('live') === '1') {
          const seedPlans = {
            home: getTeamWithPlayers(fx.home_team_id)?.plan ?? null,
            away: getTeamWithPlayers(fx.away_team_id)?.plan ?? null,
          };
          joinLiveMatch(liveKey('fixture', fixtureId), ws as any, seat, {
            specPath: writeSpec(fx), seed: fx.seed, homeName, awayName,
            homeTeamId: fx.home_team_id, awayTeamId: fx.away_team_id,
            kind: 'fixture', refId: fixtureId, record: hasHumanStake(fx.home_team_id, fx.away_team_id), seedPlans,
          });
          return;
        }
        new MatchStream(ws as any, writeSpec(fx), fx.seed, homeName, awayName, myTeam, seedPlan, canShout, 'fixture', fixtureId);
      } catch (e) {
        // This bound-but-unused `e` was the whole bug: a throw anywhere in the setup above (writeSpec
        // failing to reach the engine binary, a missing team row, the coordinator refusing a seat) closed
        // the socket with NO frame and NO log. The watcher got the frontend's generic "The match could not
        // be started." and a maintainer got nothing at all. Ambient this is not — it is the one place a
        // watch can fail outright, so name the fixture in the log and tell the client what happened.
        console.warn(`[watch] fixture ${fixtureId} watch failed:`, e);
        try { ws.send(JSON.stringify({ error: 'Could not start this match — the server hit an error setting up the stream.' })); } catch { /* socket already gone */ }
        try { ws.close(); } catch { /* socket already gone */ }
      }
    });
  });

}

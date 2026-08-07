import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { seedAdminUser } from './auth.ts';
import { backfillFreeAgents, backfillPotentials, reconcileGkPotentials, backfillContracts } from './game.ts';
import { backfillNationalities } from './nations.ts';
import { fastSimEnabled } from './fastsim.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerTeamRoutes } from './routes/team.ts';
import { registerMarketRoutes } from './routes/market.ts';
import { registerPlayerRoutes } from './routes/players.ts';
import { registerManagerRoutes } from './routes/manager.ts';
import { registerTrainingRoutes } from './routes/training.ts';
import { registerLeagueRoutes } from './routes/league.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerClubRoutes } from './routes/club.ts';
import { registerWorldRoutes, runDueTicks } from './routes/world.ts';
import { registerMatchWatch } from './routes/watch.ts';

// PORT: prefer FOOTY_PORT, then the platform-injected PORT (Render/Heroku/Cloud Run set this),
// else 4000 for local dev.
const PORT = Number.parseInt(process.env.FOOTY_PORT ?? process.env.PORT ?? '4000', 10);
// Bind host: defaults to loopback (safe for local dev). Set FOOTY_HOST=0.0.0.0 to expose the
// server on the LAN (play from your phone over Wi-Fi) or inside a container/deploy.
const HOST = process.env.FOOTY_HOST ?? '127.0.0.1';
// Give any pre-market league a free-agent pool + every player a potential (one-time,
// idempotent backfills for saves that predate pillars 1 & 2).
backfillFreeAgents();
backfillPotentials();
reconcileGkPotentials();   // GK potentials predate handling counting toward OVR — re-derive so keepers aren't frozen
backfillContracts();
backfillNationalities();   // §national-teams: every player/free-agent gets a fixed-list nation + flag
const app = Fastify({ logger: false });
await app.register(cookie);

const DIST = path.resolve(process.cwd(), 'dist');
if (existsSync(DIST)) {
  await app.register(fstatic, { root: DIST });
}

// ── API routes — split by domain under routes/ (routes/shared.ts holds the per-request guards) ──
// Modules register in the EXACT order the routes appeared in the pre-split monolith, between the
// static plugin above and the SPA fallback below — keep these calls in sequence.
registerAuthRoutes(app);       // register / login / logout / me
registerTeamRoutes(app);       // club, squad, captain, team talk, academy, plans, tactics, lineup
registerMarketRoutes(app);     // transfer market, bids, loans, free agents, offers
registerPlayerRoutes(app);     // player story rewrite + contract renewals
registerManagerRoutes(app);    // press, shortlist/search/leaders, 1-to-1s, concerns, board, career
registerTrainingRoutes(app);   // training focus / intensity / presets / retrain / report
registerLeagueRoutes(app);     // cup bracket, league dashboard, play a fixture
registerReportRoutes(app);     // match report, tactics review, scout, news, inbox
registerClubRoutes(app);       // staff, finances, harmony, rotation, history
registerWorldRoutes(app);      // advance / tick turn engine, internationals, worlds lobby, play-next

// SPA fallback for client-side routing (only if a build exists). Must be
// registered before listen().
if (existsSync(DIST)) {
  app.setNotFoundHandler((req: any, reply) => {
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

// Ensure the default admin (maxk/maxk) exists so a tester / headless run can advance the world.
// Idempotent; disable in prod with FOOTY_NO_ADMIN_SEED=1. See auth.seedAdminUser.
seedAdminUser();

const server = app.server;
await app.listen({ port: PORT, host: HOST });
console.log(`footy game server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
  + (HOST === '0.0.0.0' ? ` (also reachable on this machine's LAN IP:${PORT})` : ''));
if (fastSimEnabled()) console.log('⚡ FOOTY_FAST_SIM on — matches resolve via the fast statistical model (no engine spawn). Headless/bulk mode; watched matches lose full-engine fidelity.');

// ── Autonomous turn scheduler (opt-in) ──────────────────────────────────────
// When FOOTY_AUTO_TICK_MIN is set, the server self-drives: every N minutes it advances every shared
// world whose cadence (worlds.interval_min, default 720 = 2/day) is due. Off by default so dev/tests and
// solo play are unaffected; a self-hosted autonomous deployment sets e.g. FOOTY_AUTO_TICK_MIN=30. An
// external cron / the CCR trigger can drive POST /api/tick instead (same runDueTicks path).
let tickInFlight = false;
const AUTO_TICK_MIN = Number(process.env.FOOTY_AUTO_TICK_MIN);
if (Number.isFinite(AUTO_TICK_MIN) && AUTO_TICK_MIN > 0) {
  const everyMs = AUTO_TICK_MIN * 60000;
  setInterval(() => {
    if (tickInFlight) return;   // a slow tick must not stack on the next interval
    tickInFlight = true;
    runDueTicks(Date.now()).then(r => { if (r.advanced.length) console.log(`[tick] advanced ${r.advanced.length} world(s)`); }).catch(e => console.warn('[tick] failed', e)).finally(() => { tickInFlight = false; });
  }, everyMs);
  console.log(`[tick] auto-scheduler ON — every ${AUTO_TICK_MIN} min (shared worlds; cadence per world)`);
}

// ── match-watch WebSocket — the /ws/match upgrade handler lives in routes/watch.ts ──
registerMatchWatch(server);

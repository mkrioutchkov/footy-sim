// tools/_http_smoke.ts — end-to-end HTTP smoke against the REAL backend. Recreated from the
// GAME_LAYER_NOTES.md ledger, where this file is cited beside every feature's unit suite and
// grows from "tools/_http_smoke.ts (15 assertions: the live pillar 1+2 endpoints on a temp-DB
// backend)" to "smoke (57)" by the harmony entry. Each assertion group below quotes the ledger
// claim it covers.
//
// The REAL server is booted as a subprocess (npx tsx web/backend/index.ts) on a loopback port
// with a fresh temp sqlite, and the core loop is exercised over fetch(): register/login,
// create a club, read dashboard/squad/table endpoints, set tactics via the STRUCTURED board
// endpoints (the no-LLM path), sign a free agent, bid for a listed player, advance a matchday
// (twice) and check the table/fixtures/money moved consistently. LLM-backed routes are hit only
// to assert they degrade gracefully with no key configured.
//
// Isolation: the subprocess runs with cwd = a scratch sandbox (holding a symlink to the repo's
// build/ so the engine resolves), because match.ts writes its spec scratch under
// <cwd>/web/backend/data/specs — this keeps every byte the server writes out of the repo's
// web/backend/data/. FOOTY_MINUTES=5 keeps a full two-division matchday (8 engine sims) inside
// the runtime budget while still exercising the real engine spawn -> --summary -> parse path.
//
// Run: cd <repo> && npx tsx tools/_http_smoke.ts   (exits non-zero on any failure).

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const startedAt = Date.now();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = '/tmp/claude-0/-home-user-footy-sim/710ecd1a-f780-5b5f-a4ef-27543513423b/scratchpad';
// Per-RUN directory, not a shared one: the backend writes recordings alongside the DB, so two
// concurrent smoke runs raced on one recordings/ path and each could rename away the other's
// in-flight .tmp — surfacing as a bogus 'the match report became available' failure.
const TESTDB_DIR = path.join(SCRATCH, 'testdb', `run_${process.pid}`);
const SANDBOX = path.join(SCRATCH, `httpsmoke_${process.pid}`);
const DB_PATH = path.join(TESTDB_DIR, `http_smoke_${process.pid}.sqlite`);
const PORT = 14000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(TESTDB_DIR, { recursive: true });
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
// The engine binary the backend resolves via engine-path.ts (build/live on posix, build/live.exe
// as the fallback). Symlinked into the sandbox so ENGINE = <cwd>/build/<name> still resolves.
if (!existsSync(path.join(REPO, 'build', 'live')) && !existsSync(path.join(REPO, 'build', 'live.exe'))) {
  throw new Error('engine binary missing — build it first (npm run native:build:posix)');
}
symlinkSync(path.join(REPO, 'build'), path.join(SANDBOX, 'build'), 'dir');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Boot the real server ─────────────────────────────────────────────────────
// No LLM key in the child env — the LLM-primary routes must take their deterministic
// fallbacks, and the pure-LLM routes must fail gracefully (asserted below). FOOTY_* knobs
// that would change the default advance path (fast-sim, auto-tick, manager-ai) are cleared.
const env: Record<string, string | undefined> = { ...process.env };
for (const k of [
  'TACTICS_LLM_API_KEY', 'TACTICS_LLM_PROVIDER', 'TACTICS_LLM_BASE_URL', 'TACTICS_LLM_MODEL', 'TACTICS_LLM_CLAUDE_BIN',
  'TACTICS_LLM_LIVE_PROVIDER', 'TACTICS_LLM_LIVE_API_KEY', 'TACTICS_LLM_LIVE_BASE_URL', 'TACTICS_LLM_LIVE_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'FOOTY_FAST_SIM', 'FOOTY_AUTO_TICK_MIN', 'FOOTY_NO_ADMIN_SEED', 'FOOTY_MANAGER_AI', 'FOOTY_ABSENT_HOURS',
  'FOOTY_MINUTES', 'FOOTY_MATCH_CONCURRENCY', 'FOOTY_RECORD_ALL', 'PORT',
]) { delete env[k]; }
env.FOOTY_DB = DB_PATH;
env.FOOTY_PORT = String(PORT);
env.FOOTY_HOST = '127.0.0.1';
env.FOOTY_MINUTES = '5';   // short real-engine matches: a whole matchday stays ~10s

const serverLog: string[] = [];
function capture(chunk: Buffer): void {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim()) { serverLog.push(line); }
  }
  if (serverLog.length > 400) { serverLog.splice(0, serverLog.length - 400); }
}

let serverExited = false;
const server: ChildProcess = spawn(
  path.join(REPO, 'node_modules', '.bin', 'tsx'),
  [path.join(REPO, 'web', 'backend', 'index.ts')],
  { cwd: SANDBOX, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
server.stdout!.on('data', capture);
server.stderr!.on('data', capture);
server.on('exit', () => { serverExited = true; });

function killServer(): void {
  if (server.pid != null && !serverExited) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

// ── Tiny HTTP client (manual cookie jar — the sid cookie is the session) ─────
interface Res { status: number; body: any; setCookie: string | null; }
async function req(method: string, p: string, body?: unknown, sid?: string | null): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) { headers['content-type'] = 'application/json'; }
  if (sid) { headers['cookie'] = `sid=${sid}`; }
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let parsed: any = null;
  try { parsed = await r.json(); } catch { /* non-JSON body */ }
  return { status: r.status, body: parsed, setCookie: r.headers.get('set-cookie') };
}
const GET = (p: string, sid?: string | null) => req('GET', p, undefined, sid);
const POST = (p: string, body: unknown, sid?: string | null) => req('POST', p, body, sid);
const PUT = (p: string, body: unknown, sid?: string | null) => req('PUT', p, body, sid);
const sidOf = (r: Res): string => {
  const m = r.setCookie?.match(/sid=([^;]+)/);
  if (!m) { throw new Error('no sid cookie in response'); }
  return m[1];
};

async function waitReady(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (serverExited) { throw new Error('server exited before becoming ready'); }
    try {
      const r = await GET('/api/me');
      if (r.status === 200) { return; }
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  throw new Error('server did not become ready within 45s');
}

// Local mirror of game.overall (mean of the core skills; handling counts for a GK only) so squad
// invariants can be checked without importing backend code into this black-box test.
const SKILLS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
function overallOf(attrs: Record<string, number>, role: string): number {
  const keys = role === 'GK' ? [...SKILLS, 'handling'] : SKILLS;
  let s = 0, n = 0;
  for (const k of keys) { if (typeof attrs[k] === 'number') { s += attrs[k]; n++; } }
  return n ? Math.round(s / n) : 50;
}
const ROLES = new Set(['GK', 'FB', 'CB', 'CM', 'WM', 'CF']);

async function main(): Promise<void> {
  await waitReady();

  // ── Auth (auth.ts: register/login/session flow) ────────────────────────────
  let r = await GET('/api/me');
  assert(r.status === 200 && r.body.user === null, 'logged-out /api/me is 200 {user: null}');
  r = await POST('/api/register', { username: 'x', password: 'y' });
  assert(r.status === 400 && typeof r.body.error === 'string', 'short credentials are rejected with a 400 + error');
  r = await POST('/api/register', { username: 'smokey', password: 'smoke-pass' });
  assert(r.status === 200 && typeof r.body.user?.id === 'number' && r.body.user.username === 'smokey', 'register returns the created user');
  assert(r.body.user.isAdmin === false, 'self-registration never grants admin');
  assert(/sid=/.test(r.setCookie ?? '') && /HttpOnly/i.test(r.setCookie ?? ''), 'register sets an HttpOnly sid session cookie');
  let sid = sidOf(r);
  const userId: number = r.body.user.id;
  r = await POST('/api/register', { username: 'smokey', password: 'other-pass' });
  assert(r.status === 409, 'a taken username registers as 409');
  r = await GET('/api/me', sid);
  assert(r.body.user?.id === userId && r.body.teamId === null, 'authed /api/me returns the user and a null teamId pre-club');
  r = await GET('/api/team');
  assert(r.status === 401, 'a team route without a session is 401');
  r = await POST('/api/logout', {}, sid);
  assert(r.body?.ok === true, 'logout acks');
  r = await GET('/api/me', sid);
  assert(r.body.user === null, 'the destroyed session no longer authenticates');
  r = await POST('/api/login', { username: 'smokey', password: 'wrong' });
  assert(r.status === 401, 'a bad password is 401');
  r = await POST('/api/login', { username: 'smokey', password: 'smoke-pass' });
  assert(r.status === 200 && r.body.user.id === userId, 'login round-trips the same user');
  sid = sidOf(r);
  // LEDGER: "Ensure the default admin (maxk/maxk) exists so a tester / headless run can advance
  // the world" (auth.seedAdminUser) + the admin-only gate on the scheduler tick.
  r = await POST('/api/login', { username: 'maxk', password: 'maxk' });
  assert(r.status === 200 && r.body.user.isAdmin === true, 'the seeded maxk admin exists and logs in as admin');
  r = await POST('/api/tick', {}, sid);
  assert(r.status === 403, 'POST /api/tick is admin-only — a normal user gets 403');
  r = await POST('/api/advance', {});
  assert(r.status === 401, 'POST /api/advance without a session is 401');

  // ── Club creation ──────────────────────────────────────────────────────────
  r = await GET('/api/team', sid);
  assert(r.status === 404, 'no club yet: /api/team is 404');
  r = await POST('/api/team', { name: 'Smoke Test FC' }, sid);
  assert(r.status === 200 && typeof r.body.teamId === 'number' && typeof r.body.leagueId === 'number', 'club creation returns teamId + leagueId');
  const teamId: number = r.body.teamId;
  r = await POST('/api/team', { name: 'Second FC' }, sid);
  assert(r.status === 409, 'a second club is refused with 409');
  r = await GET('/api/me', sid);
  assert(r.body.teamId === teamId, '/api/me now carries the claimed teamId');

  // LEDGER (pillar 3 + 5.2): the user starts in Division 2 on Championship-tier finances
  // (transfer budget 18M, wage budget 40M) with an 11+6 squad; every player carries age,
  // potential (>= current OVR), a wage and a contract ("Potential threads through every signing").
  r = await GET('/api/team', sid);
  const team0 = r.body;
  assert(r.status === 200 && team0.id === teamId && team0.name === 'Smoke Test FC', '/api/team returns my club');
  assert(team0.budget === 18_000_000 && team0.wageBudget === 40_000_000, 'a new club starts on tier-2 finances (18M transfer / 40M wage)');
  assert(Array.isArray(team0.players) && team0.players.length === 17, 'a fresh squad is 17 strong (XI + 6 bench)');
  assert(team0.players.every((p: any, i: number) => p.slot === i), 'squad slots are contiguous 0..16 in order');
  assert(team0.players.every((p: any) => ROLES.has(p.role)), 'every player carries a real engine role');
  assert(team0.players[0].role === 'GK', 'slot 0 is the keeper');
  assert(team0.players.every((p: any) => SKILLS.every(k => typeof p.attrs[k] === 'number' && p.attrs[k] >= 0 && p.attrs[k] <= 100)), 'every player has numeric 0-100 skill attrs');
  assert(team0.players.every((p: any) => p.age >= 16 && p.age <= 40), 'ages are in the 16..40 band');
  assert(team0.players.every((p: any) => typeof p.potential === 'number' && p.potential <= 95 && p.potential >= overallOf(p.attrs, p.role)), 'potential is a ceiling: <= 95 and never below current OVR');
  assert(team0.players.every((p: any) => p.wage >= 25_000 && p.contractYears >= 2 && p.contractYears <= 4), 'every player draws a wage and holds a 2-4 year deal');
  assert(team0.wageBill === team0.players.reduce((s: number, p: any) => s + p.wage, 0), 'wageBill is the sum of squad wages');
  assert(team0.formation === '4-3-3' && team0.lineup === null, 'a fresh club is on the default 4-3-3 identity XI (lineup NULL)');

  // ── League / world shape ───────────────────────────────────────────────────
  // LEDGER (pillar 3): "/api/league carries season/tier/division + every division's table" —
  // a new world is TWO divisions, the user starting in Division 2 with Division 1 above.
  r = await GET('/api/league', sid);
  const lg0 = r.body;
  assert(r.status === 200 && lg0.leagueId === team0.leagueId && lg0.myTeamId === teamId, '/api/league is scoped to my club');
  assert(lg0.season === 1 && lg0.tier === 2 && /Division 2/.test(lg0.divisionName), 'season 1, tier 2, named Division 2');
  assert(Array.isArray(lg0.standings) && lg0.standings.length === 8, 'my division holds 8 clubs');
  assert(lg0.standings.filter((s: any) => s.isUser).length === 1 && lg0.standings.some((s: any) => s.isUser && s.name === 'Smoke Test FC'), 'exactly one row is mine');
  assert(lg0.standings.every((s: any) => s.played === 0 && s.points === 0), 'nobody has played before the first advance');
  assert(Array.isArray(lg0.fixtures) && lg0.fixtures.length === 56, 'a double round-robin of 8 clubs is 56 fixtures');
  assert(lg0.fixtures.every((f: any) => f.round >= 1 && f.round <= 14 && f.played === false && f.homeScore === null), '14 rounds, all unplayed');
  assert(lg0.fixtures.filter((f: any) => f.involvesMe).length === 14, 'I play 14 of them');
  assert(Array.isArray(lg0.world) && lg0.world.length === 2 && lg0.world.map((w: any) => w.tier).sort().join(',') === '1,2', 'the world view carries both divisions');
  assert(lg0.world.every((w: any) => Array.isArray(w.standings) && w.standings.length === 8), 'each division table holds 8 clubs');
  assert(lg0.seasonComplete === false && typeof lg0.promote === 'number', 'season incomplete + the promotion line is published');
  // LEDGER (board objectives): "The board sets a season expectation ... Set at club creation";
  // a strong fresh second-tier club is expected to go up.
  assert(lg0.objective?.kind === 'promotion' && lg0.objective.target === lg0.promote && typeof lg0.objective.label === 'string', 'the opening board objective is promotion');
  // LEDGER (board confidence): "0-100 board rating of the manager" + status band.
  assert(typeof lg0.confidence?.value === 'number' && lg0.confidence.value >= 0 && lg0.confidence.value <= 100
    && ['secure', 'stable', 'under-pressure', 'at-risk'].includes(lg0.confidence.status), 'board confidence is a 0-100 value + band');
  assert(lg0.world_turn?.mode === 'solo' && lg0.world_turn.canAdvance === true, 'a fresh world is solo and owner-advanceable');

  // ── Read-only club endpoints ───────────────────────────────────────────────
  // LEDGER (harmony): "Returns a 0-100 harmony + status (united/settled/restless/fractured)".
  r = await GET('/api/harmony', sid);
  assert(r.status === 200 && r.body.harmony >= 0 && r.body.harmony <= 100
    && ['united', 'settled', 'restless', 'fractured'].includes(r.body.status) && Array.isArray(r.body.players), 'harmony returns a 0-100 score + band + notables');
  assert(r.body.avgMorale === 65, 'a fresh squad sits at the neutral 65 morale');
  // LEDGER (finances): "A RECORD-ONLY statement ... balance + this-season income/expense".
  r = await GET('/api/finances', sid);
  assert(r.status === 200 && r.body.balance === 18_000_000 && r.body.income === 0 && r.body.expense === 0
    && Array.isArray(r.body.recent) && r.body.recent.length === 0, 'the fresh ledger is empty and the balance mirrors the budget');
  // LEDGER (staff): "A shared per-world hire pool the club signs coaches/physios/scouts from".
  r = await GET('/api/staff', sid);
  assert(r.status === 200 && Array.isArray(r.body.staff) && r.body.staff.length === 0
    && Array.isArray(r.body.pool) && r.body.pool.length > 0 && typeof r.body.max === 'number', 'no staff yet but a stocked world hire pool');
  assert(r.body.pool.every((s: any) => ['coach', 'physio', 'scout'].includes(s.role) && s.cost > 0 && s.rating > 0), 'pool staff carry role/rating/cost');
  // LEDGER (history): "One row per club per finished season" — none before the first rollover.
  r = await GET('/api/history', sid);
  assert(r.status === 200 && Array.isArray(r.body.history) && r.body.history.length === 0, 'the honours archive is empty before a rollover');
  // LEDGER (cup): "createCup ... a knockout cup of all 16 clubs" at world creation.
  r = await GET('/api/cup', sid);
  assert(r.status === 200 && r.body.totalRounds === 4 && r.body.champion === null && r.body.myTeamId === teamId, 'a 16-club cup: 4 rounds, no champion yet');
  const cupR1 = r.body.rounds.find((x: any) => x.round === 1);
  assert(cupR1 && cupR1.ties.length === 8 && cupR1.ties.some((t: any) => t.home === 'Smoke Test FC' || t.away === 'Smoke Test FC'), 'round 1 holds 8 ties and my club is drawn in one');
  // LEDGER (stat leaders): "the current division's top scorers + top assisters this season".
  r = await GET('/api/leaders', sid);
  assert(r.status === 200 && Array.isArray(r.body.scorers) && r.body.scorers.length === 0 && Array.isArray(r.body.assists), 'the leaderboards are empty before a ball is kicked');
  r = await GET('/api/formations', sid);
  assert(r.status === 200 && typeof r.body.pitchW === 'number' && Array.isArray(r.body.formations['4-3-3']) && Array.isArray(r.body.formations['4-4-2']), 'the formation registry serves the visual board');
  r = await GET('/api/inbox', sid);
  assert(r.status === 200 && r.body.inbox.length === 0 && r.body.unread === 0, 'the inbox is empty before the first matchday');
  r = await GET('/api/training-report', sid);
  assert(r.status === 200 && r.body.report === null, 'no training report until the first matchday develops the squad');

  const myRound1 = lg0.fixtures.find((f: any) => f.involvesMe && f.round === 1);
  const notMine1 = lg0.fixtures.find((f: any) => !f.involvesMe && f.round === 1);
  // LEDGER (scouting): "For an upcoming fixture the user is in: the opponent's table position +
  // last-5 form ... and the top-5 key players" — and only for the user's own fixtures.
  r = await GET(`/api/scout?fixture=${myRound1.id}`, sid);
  assert(r.status === 200 && typeof r.body.opponent?.name === 'string' && r.body.round === 1
    && Array.isArray(r.body.approach) && r.body.approach.length > 0 && Array.isArray(r.body.keyPlayers) && r.body.keyPlayers.length > 0, 'my next fixture scouts: opponent + approach + key players');
  r = await GET(`/api/scout?fixture=${notMine1.id}`, sid);
  assert(r.status === 404, 'a fixture I am not in yields no scout report');
  // LEDGER (2.13 team talk): preview how a tone lands across the squad for an upcoming fixture.
  r = await GET(`/api/teamtalk?fixture=${myRound1.id}&tone=fire_up`, sid);
  assert(r.status === 200 && r.body.tone === 'fire_up' && r.body.pending === null
    && Array.isArray(r.body.tones) && r.body.tones.length === 4
    && Array.isArray(r.body.reactions) && r.body.reactions.length === 17, 'the team-talk preview lists tones + a per-player reaction');

  // ── Structured tactics board (the no-LLM path) ─────────────────────────────
  // LEDGER: "DETERMINISTIC formation + XI from the tactics board (no LLM) ... An omitted or
  // invalid lineup falls back to the strongest role-fit XI for that shape."
  r = await POST('/api/lineup/set', { formation: '4-4-2' }, sid);
  assert(r.status === 200 && r.body.formation === '4-4-2', 'the board sets a 4-4-2 instantly');
  assert(Array.isArray(r.body.lineup) && r.body.lineup.length === 11 && new Set(r.body.lineup).size === 11
    && r.body.lineup.every((n: number) => Number.isInteger(n) && n >= 0 && n < 17), 'the auto-picked XI is a clean 11-permutation of squad slots');
  r = await GET('/api/team', sid);
  assert(r.body.formation === '4-4-2' && Array.isArray(r.body.lineup), 'the shape + XI persisted on the club');
  r = await POST('/api/lineup/set', { formation: '9-9-9' }, sid);
  assert(r.status === 400, 'an unknown formation is refused');
  // LEDGER: "Storing the default 4-3-3 identity as NULL keeps the byte-identical spec path".
  r = await POST('/api/lineup/set', { formation: '4-3-3', lineup: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, sid);
  assert(r.status === 200 && r.body.formation === '4-3-3' && r.body.lineup === null, 'the default 4-3-3 identity persists as NULL');
  // LEDGER: "DETERMINISTIC structured tactics from the board (sliders/menus) — the no-LLM sibling
  // of POST /api/team/plan ... Sanitised against VALID_KINDS (man_mark dropped — live-only)".
  r = await POST('/api/team/plan-structured', {
    summary: 'Press and shoot',
    directives: [
      { kind: 'high_press', intensity: 1 },
      { kind: 'shoot_on_sight', playerId: 9 },
      { kind: 'man_mark', playerId: 3 },
      { kind: 'not_a_kind', playerId: 2 },
    ],
  }, sid);
  assert(r.status === 200 && r.body.planText === 'Press and shoot' && r.body.plan.directives.length === 2, 'valid board directives survive; man_mark + unknown kinds are dropped');
  assert(r.body.plan.directives.some((d: any) => d.kind === 'high_press' && d.teamScope === 0)
    && r.body.plan.directives.some((d: any) => d.kind === 'shoot_on_sight' && d.playerId === 9), 'team-wide orders take teamScope 0; player orders keep their slot');
  r = await GET('/api/team', sid);
  assert(r.body.plan?.directives?.length === 2 && r.body.planText === 'Press and shoot', 'the structured plan persisted exactly as compiled');

  // ── LLM routes degrade gracefully with no key ──────────────────────────────
  // LEDGER: "POST /api/team/plan (graceful no-key: text saved, empty directives + note)".
  r = await POST('/api/team/plan', { text: 'press high up the pitch' }, sid);
  assert(r.status === 200 && r.body.planText === 'press high up the pitch' && r.body.plan.directives.length === 0, 'the plain-English plan saves its text with no directives when the compiler is unreachable');
  assert(typeof r.body.error === 'string' && r.body.error.includes('TACTICS_LLM_API_KEY'), 'the no-key failure names the missing key');
  r = await PUT('/api/lineup', { text: 'play four four two' }, sid);
  assert(r.status === 503 && typeof r.body.error === 'string' && r.body.error.includes('TACTICS_LLM_API_KEY'), 'the free-text lineup compiler fails as a clean 503 without a key');
  // Restore the structured plan (the advance below plays with the board-set tactics).
  r = await POST('/api/team/plan-structured', { summary: 'Press and shoot', directives: [{ kind: 'high_press', intensity: 1 }] }, sid);
  assert(r.status === 200 && r.body.plan.directives.length === 1, 'the board re-arms the standing plan');

  // ── Training (pillar 2) ────────────────────────────────────────────────────
  // LEDGER: "PUT /api/training, a #/training screen ... Drives the development tick that runs
  // each matchday."
  r = await PUT('/api/training', { focus: 'shooting' }, sid);
  assert(r.status === 200 && r.body.ok === true && r.body.focus === 'shooting', 'the club training focus is set');
  r = await GET('/api/team', sid);
  assert(r.body.trainingFocus === 'shooting', 'the focus persisted on the club');
  r = await PUT('/api/training', { focus: 'juggling' }, sid);
  assert(r.status === 400, 'an unknown focus is refused');

  // ── Contracts (5.2) ────────────────────────────────────────────────────────
  // LEDGER: "PUT /api/player:slot/renew recomputes the wage" — the preview half, without committing.
  r = await GET('/api/player/0/renew-preview', sid);
  assert(r.status === 200 && r.body.ok === true && r.body.currentWage > 0 && r.body.newWage > 0
    && r.body.delta === r.body.newWage - r.body.currentWage && typeof r.body.affordable === 'boolean', 'the renewal preview recomputes the wage + affordability');

  // ── Story-driven traits (5.1) ──────────────────────────────────────────────
  // LEDGER: "PUT /api/player:slot/story rewrites a backstory and re-derives" the 8 dials
  // (deterministic keyword projection with no LLM key).
  r = await PUT('/api/player/0/story', { backstory: 'A fierce leader who trains harder than anyone.', tagline: 'The captain' }, sid);
  assert(r.status === 200 && r.body.slot === 0 && r.body.personality.backstory === 'A fierce leader who trains harder than anyone.', 'the backstory is rewritten on the player');
  const dials = Object.values(r.body.personality.traits as Record<string, number>);
  assert(dials.length === 8 && dials.every(v => typeof v === 'number' && v >= 0 && v <= 100), 'the 8 trait dials are re-derived in 0..100');
  assert(typeof r.body.value === 'number' && r.body.value > 0, 'the transfer value moves with the story');
  r = await PUT('/api/player/0/story', { backstory: '' }, sid);
  assert(r.status === 400, 'an empty backstory is refused');

  // ── Transfer market (pillar 1 + windows + negotiation) ─────────────────────
  // LEDGER: "a summer (pre-season) + winter (mid-season) window ... free agents are signable
  // any time, but club-to-club deals are window-gated"; the fresh market is stocked with 28
  // free agents + AI clubs' for-sale listings ("not an empty board").
  r = await GET('/api/market', sid);
  const mkt0 = r.body;
  assert(r.status === 200 && mkt0.window.open === true && mkt0.window.window === 'summer' && mkt0.window.current === 1 && mkt0.window.total === 14, 'the pre-season summer window is open on matchday 1 of 14');
  assert(mkt0.freeAgents.length === 28, 'the league free-agent pool is seeded with 28');
  assert(mkt0.freeAgents.every((a: any, i: number) => i === 0 || mkt0.freeAgents[i - 1].value >= a.value), 'free agents come sorted by value');
  assert(mkt0.freeAgents.every((a: any) => typeof a.overall === 'number' && a.value >= 25_000 && a.wage >= 25_000 && ROLES.has(a.role)), 'each agent carries overall/value/wage/role');
  assert(mkt0.squad.length === 17 && mkt0.squad.filter((p: any) => p.starter).length === 11, 'the market squad view flags the XI');
  assert(mkt0.transferTargets.length > 0, 'AI clubs list surplus players so the for-sale board is never empty');
  assert('backing' in mkt0 && mkt0.backing !== null, 'the board frames recruitment (confidence-derived backing)');

  // Sign the cheapest free agent (instant path; budget + wage headroom debited exactly).
  const cheapFA = mkt0.freeAgents[mkt0.freeAgents.length - 1];
  assert(cheapFA.value <= mkt0.budget && mkt0.wageBill + cheapFA.wage <= mkt0.wageBudget, 'the cheapest agent is affordable in fee + wages');
  r = await POST('/api/market/buy', { agentId: cheapFA.id }, sid);
  assert(r.status === 200 && r.body.ok === true && ['xi', 'bench'].includes(r.body.placed) && r.body.name === cheapFA.name, 'the free agent signs');
  assert(r.body.market.budget === 18_000_000 - cheapFA.value, 'the fee left the budget exactly');
  assert(r.body.market.freeAgents.length === 27 && !r.body.market.freeAgents.some((a: any) => a.id === cheapFA.id), 'the signed agent left the pool');
  assert(r.body.market.squad.length === 18, 'the squad grew to 18');
  r = await POST('/api/market/buy', { agentId: 99_999_999 }, sid);
  assert(r.status === 400, 'a bogus agent id is a clean 400');

  // List / unlist my own player (§2.4 listings lapse at the window deadline — checked after
  // the advance below).
  r = await POST('/api/market/list', { slot: 17, price: 777_777 }, sid);
  assert(r.status === 200 && r.body.ok === true && r.body.askPrice === 777_777, 'listing names my ask price');
  assert(r.body.market.squad.find((p: any) => p.slot === 17)?.listed === true, 'the market view shows him listed');
  r = await POST('/api/market/unlist', { slot: 17 }, sid);
  assert(r.status === 200 && r.body.market.squad.find((p: any) => p.slot === 17)?.listed === false, 'unlisting clears the flag');
  r = await POST('/api/market/list', { slot: 17 }, sid);
  assert(r.status === 200 && r.body.askPrice > 0, 'relisting without a price asks his value');
  const listedName: string = mkt0.squad.length && r.body.market.squad.find((p: any) => p.slot === 17)?.name;

  // LEDGER (§2.1 signing drama): "A bid is NO LONGER instant: it creates a PENDING offer the
  // selling club resolves at the NEXT matchday tick — accept, counter, or reject." Bid full ask
  // on the cheapest listed player of MY division (resolved before my division's AI moves), and
  // lowball a second target (< 80% of ask -> a rejection).
  const myDivision = new Set(lg0.standings.map((s: any) => s.teamId));
  const targets = mkt0.transferTargets
    .filter((t: any) => myDivision.has(t.clubTeamId) && t.askPrice != null && t.releaseClause == null)
    .sort((a: any, b: any) => a.askPrice - b.askPrice);
  assert(targets.length >= 2, 'my division offers at least two listed players to bid on');
  const [buyTarget, lowTarget] = targets;
  const budgetBeforeBids = 18_000_000 - cheapFA.value;
  assert(buyTarget.askPrice <= budgetBeforeBids, 'the cheapest listing is within budget');
  r = await POST('/api/transfer/bid', { playerId: buyTarget.id, fee: buyTarget.askPrice }, sid);
  assert(r.status === 200 && r.body.status === 'pending' && r.body.fee === buyTarget.askPrice, 'a full-ask bid is recorded as a pending offer');
  assert(r.body.market.budget === budgetBeforeBids, 'no money moves until the seller answers');
  const lowFee = Math.max(1, Math.floor(lowTarget.askPrice * 0.5));
  r = await POST('/api/transfer/bid', { playerId: lowTarget.id, fee: lowFee }, sid);
  assert(r.status === 200 && r.body.status === 'pending', 'the lowball is also tabled as pending');
  r = await POST('/api/transfer/bid', { playerId: buyTarget.id, fee: 0 }, sid);
  assert(r.status === 400, 'a zero-fee bid is a 400, not a negotiation outcome');
  r = await GET('/api/offers', sid);
  assert(r.status === 200 && r.body.offers.length === 2 && r.body.offers.every((o: any) => o.status === 'pending'), 'both outgoing offers sit pending until the matchday');

  // ── Press conference (deterministic no-key fallback) ───────────────────────
  // LEDGER: "Interactive press: a context-aware journalist question + tone-keyed response
  // options (LLM, with a deterministic template fallback)".
  r = await GET('/api/press', sid);
  assert(r.status === 200 && r.body.available === true && typeof r.body.question === 'string' && r.body.question.includes('board'), 'pre-season the press asks about the board objective (template fallback)');
  assert(Array.isArray(r.body.options) && r.body.options.length === 5
    && r.body.options.every((o: any) => typeof o.tone === 'string' && typeof o.text === 'string'), 'five tone-keyed response options ride along');

  // ── Advance matchday 1 ─────────────────────────────────────────────────────
  // LEDGER: "/api/advance plays a matchday across every division" then runs the market /
  // fitness / training ticks; matchday income lands and the pending transfers resolve.
  const teamPre = (await GET('/api/team', sid)).body;
  const wageSlice = Math.round(teamPre.wageBill / 14);
  r = await POST('/api/advance', {}, sid);
  const adv1 = r.body;
  assert(r.status === 200 && adv1.round === 1, 'the first advance plays matchday 1');
  assert(Array.isArray(adv1.results) && adv1.results.length === 8, 'both divisions play: 8 fixtures resolved');
  assert(adv1.myFixtureId === myRound1.id, 'my round-1 fixture is the one that played');
  assert(Number.isInteger(adv1.myResult?.homeScore) && Number.isInteger(adv1.myResult?.awayScore) && adv1.myResult.alreadyPlayed === false, 'my result carries a real scoreline');
  assert(adv1.rollover === null && adv1.cup === null, 'no rollover and no cup round this early (cup round 1 waits for matchday 3)');
  assert(adv1.income === 900_000, 'tier-2 matchday gate & TV income is 900k');
  assert(typeof adv1.digestHeadline === 'string' && adv1.digestHeadline.length > 0 && Array.isArray(adv1.inbox) && adv1.inbox.length > 0, 'the matchday digest + inbox items are returned');
  assert(typeof adv1.development?.players === 'number' && adv1.development.players >= 0, 'the development tick reports how many players moved');
  // LEDGER (§2.4): "once the deadline passes, an unsold listing lapses (auto-unlisted)" — my
  // relisted man was stamped with the summer deadline (matchday 1).
  assert(Array.isArray(adv1.listingsExpired) && adv1.listingsExpired.some((e: any) => e.player === listedName), 'my unsold listing lapsed at the summer deadline');

  // Table + fixtures moved consistently.
  r = await GET('/api/league', sid);
  const lg1 = r.body;
  const round1 = lg1.fixtures.filter((f: any) => f.round === 1);
  assert(round1.every((f: any) => f.played === true && Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore)), 'every round-1 fixture is played with a stored score');
  assert(lg1.fixtures.filter((f: any) => f.round === 2).every((f: any) => f.played === false), 'round 2 is still to play');
  const myFx1 = round1.find((f: any) => f.id === myRound1.id);
  assert(myFx1.homeScore === adv1.myResult.homeScore && myFx1.awayScore === adv1.myResult.awayScore, 'the stored fixture score matches my advance result');
  assert(lg1.standings.every((s: any) => s.played === 1), 'everyone in my division has played exactly once');
  const expPts = round1.reduce((s: number, f: any) => s + (f.homeScore === f.awayScore ? 2 : 3), 0);
  assert(lg1.standings.reduce((s: number, t: any) => s + t.points, 0) === expPts, 'table points add up to 3 per decisive game + 2 per draw');
  assert(lg1.standings.reduce((s: number, t: any) => s + t.gd, 0) === 0, 'goal difference conserves to zero');
  assert(lg1.standings.reduce((s: number, t: any) => s + t.gf, 0) === round1.reduce((s: number, f: any) => s + f.homeScore + f.awayScore, 0), 'goals for equals the goals actually scored');
  assert(lg1.standings.every((s: any, i: number) => i === 0 || lg1.standings[i - 1].points > s.points
    || (lg1.standings[i - 1].points === s.points && (lg1.standings[i - 1].gd > s.gd
    || (lg1.standings[i - 1].gd === s.gd && lg1.standings[i - 1].gf >= s.gf)))), 'the table sorts by points, then gd, then gf');
  const myGf = myFx1.homeTeamId === teamId ? myFx1.homeScore : myFx1.awayScore;
  const myGa = myFx1.homeTeamId === teamId ? myFx1.awayScore : myFx1.homeScore;
  const myRow1 = lg1.standings.find((s: any) => s.teamId === teamId);
  assert(myRow1.won === (myGf > myGa ? 1 : 0) && myRow1.drawn === (myGf === myGa ? 1 : 0) && myRow1.lost === (myGf < myGa ? 1 : 0), 'my W/D/L row matches my scoreline');

  // LEDGER (§2.1): the pending offers resolved at the tick — full-ask accepted, lowball rejected.
  r = await GET('/api/offers', sid);
  const offer = (id: number) => r.body.offers.find((o: any) => o.playerId === id);
  assert(offer(buyTarget.id)?.status === 'accepted', 'the full-ask bid was accepted at the matchday tick');
  assert(offer(lowTarget.id)?.status === 'rejected', 'the lowball (under 80% of ask) was rejected');
  const teamPost = (await GET('/api/team', sid)).body;
  assert(teamPost.players.length === 19 && teamPost.players.some((p: any) => p.name === buyTarget.name), 'the bought player joined my squad');
  // Money conserved exactly: income - wage slice - accepted fee (the fee re-checked + debited at
  // completion, after payMatchdayIncome computed the slice on the pre-transfer bill).
  assert(teamPost.budget === budgetBeforeBids + 900_000 - wageSlice - buyTarget.askPrice, 'the budget moved by exactly income - wages - transfer fee');
  r = await GET('/api/finances', sid);
  assert(r.body.balance === teamPost.budget && r.body.income === 900_000, 'the finance ledger mirrors the budget + gate income');
  assert(r.body.expense === -(wageSlice + cheapFA.value + buyTarget.askPrice), 'the ledger expenses are the wage slice + both signings');

  // LEDGER (windows): "club-to-club deals are window-gated" — matchday 2 is between windows.
  r = await GET('/api/market', sid);
  assert(r.body.window.open === false && r.body.window.current === 2, 'the summer window shut after matchday 1');
  r = await POST('/api/transfer/bid', { playerId: lowTarget.id, fee: lowTarget.askPrice }, sid);
  assert(r.status === 400 && /window/.test(r.body.error), 'bidding with the window shut is refused');

  // Inbox recorded the matchday server-side; mark it read.
  r = await GET('/api/inbox', sid);
  assert(r.body.inbox.length > 0 && r.body.unread > 0 && r.body.inbox.every((it: any) => typeof it.category === 'string' && typeof it.text === 'string'), 'the matchday landed in the persistent inbox unread');
  r = await POST('/api/inbox/read', { all: true }, sid);
  assert(r.body.ok === true && r.body.unread === 0, 'mark-all-read clears the counter');

  // LEDGER (record & replay + reports): my match was frame-recorded in the background and its
  // report is generated lazily from the recording on first GET (deterministic fallback prose).
  let report: Res | null = null;
  for (let i = 0; i < 60; i++) {
    const rr = await GET(`/api/report?fixture=${myRound1.id}`, sid);
    if (rr.status === 200) { report = rr; break; }
    await sleep(500);
  }
  assert(report !== null, 'the match report became available from the background recording');
  assert(typeof report!.body.headline === 'string' && report!.body.headline.length > 0 && typeof report!.body.body === 'string', 'the report carries a headline + narrative');
  assert(report!.body.homeName === myFx1.home && report!.body.awayName === myFx1.away, 'the report names both clubs');
  assert(Number.isInteger(report!.body.facts?.homeScore) && Number.isInteger(report!.body.facts?.awayScore) && Array.isArray(report!.body.facts.timeline), 'the facts block carries a scoreline + timeline');
  // Since the substitutionLog fix, ratings carry one row per STINT — 22 slots plus one
  // extra row per substitution — so the count is >=22 and every man who played is rated.
  assert(Array.isArray(report!.body.ratings) && report!.body.ratings.length >= 22
    && report!.body.ratings.every((p: any) => p.rating >= 1 && p.rating <= 10), 'every man who played draws a 1-10 rating (a row per stint, >=22)');
  r = await GET(`/api/tactics?fixture=${myRound1.id}`, sid);
  assert(r.status === 200 && Array.isArray(r.body.shouts) && r.body.shouts.length === 0, 'an unwatched match has an empty shout review');
  const myRound14 = lg1.fixtures.find((f: any) => f.involvesMe && f.round === 14);
  r = await GET(`/api/report?fixture=${myRound14.id}`, sid);
  assert(r.status === 404, 'an unplayed fixture has no report');

  // ── Advance matchday 2 (concurrently, to prove the per-world advance lock) ─
  // LEDGER: "/api/advance is now per-user-locked (a 409 on a concurrent advance) so overlapping
  // requests can't double-run ticks".
  const [a, b] = await Promise.all([POST('/api/advance', {}, sid), POST('/api/advance', {}, sid)]);
  const winner = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert(winner.status === 200 && loser.status === 409, 'exactly one of two concurrent advances wins; the other 409s');
  assert(winner.body.round === 2 && winner.body.results.length === 8, 'the winning advance plays matchday 2 across the world');
  r = await GET('/api/league', sid);
  assert(r.body.standings.every((s: any) => s.played === 2), 'after two advances everyone has played twice');
  assert(r.body.standings.reduce((s: number, t: any) => s + t.gd, 0) === 0 && r.body.seasonComplete === false, 'the table still conserves and the season runs on');
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(String(e instanceof Error ? e.stack ?? e.message : e));
  console.error(`\n--- server log tail (${Math.min(serverLog.length, 60)} lines) ---`);
  for (const line of serverLog.slice(-60)) { console.error(line); }
} finally {
  killServer();
}
if (failed) { process.exit(1); }

console.log(`_http_smoke: ${assertions} assertions passed (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

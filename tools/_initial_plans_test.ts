// Batched initial-plan compiler test (manager_ai pre-matchday). Proves compileInitialPlans makes
// ONE LLM call for N clubs (was N sequential compileInitialPlan calls) — verified with a stub HTTP
// server — maps plans in order, validates each club's directives via the same single-path validator
// (team-relative ids 0-10, invalid kinds/ids dropped, no opponent → no man_mark), and degrades to
// EMPTY_PLAN+error per club with no key (so manager/plan.ts's fallbackPlan still applies).
//
//   npx tsx tools/_initial_plans_test.ts
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.TACTICS_LLM_PROVIDER = 'http';
process.env.FOOTY_DB = path.join(os.tmpdir(), 'footy-initplans-test.sqlite');   // in case a transitive import opens db

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const plan = await import('../web/backend/plan.ts');

const squad = (prefix: string) => Array.from({ length: 11 }, (_, i) => ({ id: i, name: `${prefix}${i}`, role: 'CM' }));
const jobs = [
  { text: 'Play on the front foot. We press high and hunt the ball back.', squad: squad('A') },
  { text: 'Compact and disciplined. We sit off and stay organised.', squad: squad('B') },
  { text: 'Balanced, controlling the game.', squad: squad('C') },
];

// ── no key: every club degrades to EMPTY_PLAN + error (caller's fallbackPlan applies per club) ──
process.env.TACTICS_LLM_API_KEY = '';
const none = await plan.compileInitialPlans(jobs);
check(none.length === 3, 'no-key: one result per job');
check(none.every(r => !!r.error && r.plan.directives.length === 0), 'no-key: every result is EMPTY_PLAN + error');

// ── with a provider: EXACTLY ONE request for N clubs, validated + mapped in order ──
let requestCount = 0;
const body = JSON.stringify([
  { summary: 'A press', directives: [{ teamScope: 0, kind: 'high_press', intensity: 1 }, { playerId: 15, kind: 'get_forward', intensity: 1 }, { kind: 'nonsense', intensity: 1 }] },
  { summary: 'B sit', directives: [{ teamScope: 0, kind: 'park_the_bus', intensity: 1 }, { playerId: 9, kind: 'get_forward', intensity: 0.8 }] },
  { summary: 'C balance', directives: [{ teamScope: 0, kind: 'keep_it_on_ground', intensity: 1 }] },
]);
const server = createServer((_req, res) => { requestCount++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: body } }] })); });
await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
process.env.TACTICS_LLM_BASE_URL = `http://127.0.0.1:${port}`;
process.env.TACTICS_LLM_API_KEY = 'k';
const got = await plan.compileInitialPlans(jobs);
check(requestCount === 1, `ONE LLM call for ${jobs.length} clubs (was N sequential) — got ${requestCount}`);
check(got.length === 3 && got[0].plan.summary === 'A press' && got[2].plan.summary === 'C balance', 'plans map to clubs in order');
check(got[0].plan.directives.length === 1 && got[0].plan.directives[0].kind === 'high_press', 'club0: valid team directive kept; out-of-XI id (15) + invalid kind dropped by validate');
check(got[1].plan.directives.some(d => d.kind === 'get_forward' && d.playerId === 9), 'club1: per-player order for an in-XI id (9) kept');
check(got[1].plan.directives.some(d => d.kind === 'park_the_bus' && d.teamScope === 0), 'club1: team directive kept');
check(got[2].plan.directives.length === 1 && got[2].plan.directives[0].kind === 'keep_it_on_ground', 'club2: mapped in order');
server.close();

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// manager_ai PAIRED-SEED BALANCE HARNESS (read-only against build/live.exe).
//
// manager_ai is the highest-risk-to-balance subsystem: bad AI tactics silently degrade every
// world at once. This harness confirms manager_ai-managed clubs perform SENSIBLY — not absurdly
// better or worse than the baseline (aiManagerTick: best-XI, no plan) — before its plans go live.
//
// Method (golden-match style, cf. tools/tactics_golden.py): build ONE throwaway world of AI clubs,
// then for the SAME set of fixtures + the SAME seeds simulate each tie TWICE:
//   BASELINE   — aiManagerTick decides (optimizeLineup; default 4-3-3; NO plan/directives).
//   MANAGER_AI — prepareMatchday('full') decides (formation + XI + the deterministic fallback plan;
//                LLM forced OFF so the harness is hermetic + the comparison is apples-to-apples).
// The squads are byte-identical between the two arms (same world, we just re-decide the columns),
// so any scoreline delta is attributable to the manager's DECISIONS alone. We diff goals-for and
// the win rate of the manager_ai-managed HOME side vs baseline and flag an absurd swing.
//
//   npx tsx tools/manager_balance.ts [--seeds N] [--minutes M]
//
// Read-only: it never writes the real save (throwaway FOOTY_DB) and only READS the binary.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
import { resolveEngine } from '../web/backend/engine-path.ts';
const ENGINE = resolveEngine(path.join(ROOT, 'build'));

const argv = process.argv.slice(2);
const argN = (flag: string, d: number): number => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) || d : d; };
const SEED_COUNT = argN('--seeds', 12);
const MINUTES = argN('--minutes', 90);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 1000 + i * 137);   // a fixed spread of paired seeds

if (!existsSync(ENGINE)) {
  console.error(`build/live.exe not found at ${ENGINE} — copy it into the worktree first:\n  New-Item -ItemType Directory -Force build; Copy-Item <main>/build/live.exe build/live.exe`);
  process.exit(2);
}

// Hermetic + no LLM (the deterministic fallback plan) — the comparison must be apples-to-apples.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-mgrbal-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';
process.env.FOOTY_MINUTES = String(MINUTES);
mkdirSync(path.join(tmp, 'specs'), { recursive: true });

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const { DEFAULT_FORMATION } = await import('../web/backend/formations.ts');
const ai = await import('../web/backend/ai.ts');
const match = await import('../web/backend/match.ts');
const mgr = await import('../web/backend/manager/index.ts');

// One AI-only world (use the user's div but immediately reassign the human team to AI so every
// club is fully-AI — we want a pure AI-vs-AI balance read).
const u = registerUser('balance', 'secret');
const { leagueId } = game.newSeasonForUser(u.id, u.username, 'United', game.DEFAULT_TACTICS);
db.prepare('UPDATE teams SET user_id = NULL WHERE league_id = ?').run(leagueId);
const teams = (db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id').all(leagueId) as { id: number }[]).map(t => t.id);

// Pair the clubs up (0v1, 2v3, ...) — each pair plays at both seeds, in both arms.
const pairs: [number, number][] = [];
for (let i = 0; i + 1 < teams.length; i += 2) pairs.push([teams[i], teams[i + 1]]);

// Run a built spec object through the engine (--summary) and return the score.
function sim(spec: Record<string, unknown>, tag: string): { home: number; away: number } {
  const fp = path.join(tmp, 'specs', `${tag}.json`);
  writeFileSync(fp, JSON.stringify(spec));
  const r = spawnSync(ENGINE, ['--match', fp, '--summary', '--no-debug'], { encoding: 'utf8', timeout: 120000 });
  const line = (r.stdout || '').split(/\r?\n/).filter(l => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`no summary for ${tag}: ${r.stderr?.slice(0, 200)}`);
  const d = JSON.parse(line);
  return { home: d.homeScore ?? 0, away: d.awayScore ?? 0 };
}

// Decide every club's columns under a given regime, then build + sim each pair at each seed.
function runArm(decide: (teamId: number) => void, label: string): { goals: number; homeWins: number; ties: number } {
  for (const id of teams) decide(id);
  let goals = 0, homeWins = 0, ties = 0;
  for (const [h, a] of pairs) {
    for (const seed of SEEDS) {
      const spec = match.buildTieSpec(h, a, seed) as Record<string, unknown>;
      const s = sim(spec, `${label}-${h}v${a}-${seed}`);
      goals += s.home + s.away;
      if (s.home > s.away) homeWins++;
      ties++;
    }
  }
  return { goals, homeWins, ties };
}

console.log(`manager_ai balance harness — ${pairs.length} pairs × ${SEEDS.length} seeds = ${pairs.length * SEEDS.length} ties/arm, ${MINUTES}'`);

// BASELINE: aiManagerTick (best XI, default shape, no plan). Clear any plan columns first, then
// let aiManagerTick decide for the whole league at once (a per-league bulk op), then sim.
db.prepare('UPDATE teams SET formation = ?, lineup = NULL, plan_text = NULL, plan_directives = NULL WHERE league_id = ?').run(DEFAULT_FORMATION, leagueId);
ai.aiManagerTick(leagueId);
const baseline = runArm(() => { /* already decided by aiManagerTick */ }, 'baseline');

// MANAGER_AI: prepareMatchday('full') per club (heuristic-only path keeps it synchronous + hermetic;
// the LLM is off, so buildPlan would fall back anyway — prepareMatchdayHeuristic is identical here
// and avoids any network attempt entirely).
const managerai = runArm((id) => mgr.prepareMatchdayHeuristic(id, 'full'), 'managerai');

db.close();
rmSync(tmp, { recursive: true, force: true });

// ── Report + a sane-balance gate ────────────────────────────────────────────────
const n = baseline.ties;
const baseGpg = baseline.goals / n, mgrGpg = managerai.goals / n;
const baseHW = baseline.homeWins / n, mgrHW = managerai.homeWins / n;
const gpgDelta = mgrGpg - baseGpg;
const hwDelta = mgrHW - baseHW;
console.log(`\n              goals/match   home-win%`);
console.log(`  baseline      ${baseGpg.toFixed(2)}         ${(baseHW * 100).toFixed(0)}%`);
console.log(`  manager_ai    ${mgrGpg.toFixed(2)}         ${(mgrHW * 100).toFixed(0)}%`);
console.log(`  Δ             ${gpgDelta >= 0 ? '+' : ''}${gpgDelta.toFixed(2)}        ${hwDelta >= 0 ? '+' : ''}${(hwDelta * 100).toFixed(0)}pp`);

// SANE gate: manager_ai must not wildly inflate/deflate goals (a tactics blow-up symptom) nor
// hand an absurd home-win swing. Thresholds are generous (this is a smoke gate, not a tuned model;
// match goals are noisy < ~48 seeds per the project memory) — they catch a BLOW-UP, not drift.
const GOAL_BAND = 1.5;      // goals/match must stay within ±1.5 of the baseline
const HW_BAND = 0.25;       // home-win rate within ±25pp
const sane = Math.abs(gpgDelta) <= GOAL_BAND && Math.abs(hwDelta) <= HW_BAND;
console.log(`\n${sane ? '✓ SANE' : '✗ OUT OF BAND'} — goals Δ ${gpgDelta.toFixed(2)} (±${GOAL_BAND}), home-win Δ ${(hwDelta * 100).toFixed(0)}pp (±${HW_BAND * 100}pp)`);
if (!sane) console.log('  manager_ai decisions swung balance beyond the smoke band — investigate the formation/XI heuristic before going live.');
process.exit(sane ? 0 : 1);

// manager_ai test. Throwaway FOOTY_DB; no engine; NO LLM (key forced empty -> the deterministic
// no-key fallback path). Exercises prepareMatchday for a 'full' AI club and an 'assistant' human
// club, asserting the four persisted columns are LEGAL + that the tiers behave per the contract.
//
//   npx tsx web/backend/manager/manager_test.ts
//
// Set FOOTY_DB + TACTICS_LLM_API_KEY BEFORE importing db.ts (the imports below resolve them).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-mgr-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';        // force the no-key fallback (hermetic + fast)

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../db.ts');
const { registerUser } = await import('../auth.ts');
const game = await import('../game.ts');
const { FORMATIONS } = await import('../formations.ts');
const { VALID_KINDS } = await import('../tactics.ts');
const mgr = await import('./index.ts');

const u = registerUser('gaffer', 'secret');
const { leagueId: tier2, teamId: humanTeam } = game.newSeasonForUser(u.id, u.username, 'United', game.DEFAULT_TACTICS);
const aiTeams = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id').all(tier2) as { id: number }[]).map(t => t.id);
const aiTeam = aiTeams[0];

// A persisted lineup is legal iff: 11 entries, a permutation of distinct squad indices in range.
function legalLineup(raw: string | null, squadSize: number): boolean {
  if (raw == null) return true;     // NULL = identity XI (always legal)
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(arr) || arr.length !== 11) return false;
  const nums = arr.map(Number);
  return nums.every(n => Number.isInteger(n) && n >= 0 && n < squadSize) && new Set(nums).size === 11;
}
const teamCols = (id: number) => db.prepare('SELECT formation, lineup, plan_text, plan_directives FROM teams WHERE id = ?')
  .get(id) as { formation: string; lineup: string | null; plan_text: string | null; plan_directives: string | null };
const squadSize = (id: number) => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(id) as { n: number }).n;

// directives JSON is a Plan {summary, directives:[]} whose kinds are all in VALID_KINDS.
function legalDirectives(raw: string | null): boolean {
  if (raw == null) return true;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return false; }
  const plan = v as { summary?: unknown; directives?: unknown };
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.directives)) return false;
  return (plan.directives as { kind?: unknown }[]).every(d => d && typeof d === 'object' && VALID_KINDS.has(String(d.kind)));
}

// ── FULL tier (AI club) ───────────────────────────────────────────────────────
await mgr.prepareMatchday(aiTeam, 'full');
const full = teamCols(aiTeam);
check(!!FORMATIONS[full.formation], `full: formation is a real registry key (${full.formation})`);
check(legalLineup(full.lineup, squadSize(aiTeam)), 'full: lineup is a legal 11-permutation (or NULL identity)');
check(!!full.plan_text && full.plan_text.trim().length > 0, 'full: plan_text is non-empty');
check(legalDirectives(full.plan_directives), 'full: plan_directives is a legal Plan with valid directive kinds');
// the no-key fallback plan should have produced at least a summary; directives may be 0..2 team-wide
const fullPlan = JSON.parse(full.plan_directives!) as { directives: { teamScope?: number; kind: string }[] };
check(fullPlan.directives.every(d => d.teamScope === 0), 'full: fallback directives are team-wide, home scope (teamScope 0)');
// the keeper must still hold formation slot 0 in the fielded XI
const fullLineup = full.lineup ? JSON.parse(full.lineup) as number[] : Array.from({ length: 11 }, (_, i) => i);
const fullPlayers = db.prepare('SELECT slot, role FROM players WHERE team_id = ? ORDER BY slot').all(aiTeam) as { slot: number; role: string }[];
check(fullPlayers[fullLineup[0]]?.role === 'GK', 'full: a keeper fills formation slot 0');

// ── ASSISTANT tier (human club) — gaps only, NO transfers ──────────────────────
const humanBudget0 = (db.prepare('SELECT budget AS b FROM teams WHERE id = ?').get(humanTeam) as { b: number }).b;
const humanSquad0 = squadSize(humanTeam);
await mgr.prepareMatchday(humanTeam, 'assistant');
const asst = teamCols(humanTeam);
check(!!FORMATIONS[asst.formation], `assistant: formation is a real registry key (${asst.formation})`);
check(legalLineup(asst.lineup, squadSize(humanTeam)), 'assistant: lineup is a legal 11-permutation (or NULL identity)');
check(!!asst.plan_text && asst.plan_text.trim().length > 0, 'assistant: plan_text is a neutral non-empty plan');
const asstPlan = JSON.parse(asst.plan_directives!) as { directives: unknown[] };
check(Array.isArray(asstPlan.directives) && asstPlan.directives.length === 0, 'assistant: plan is tactically NEUTRAL (no directives)');
check((db.prepare('SELECT budget AS b FROM teams WHERE id = ?').get(humanTeam) as { b: number }).b === humanBudget0, 'assistant: NEVER spends — budget unchanged');
check(squadSize(humanTeam) === humanSquad0, 'assistant: NEVER signs — squad size unchanged');

// ── Idempotency: re-running yields the identical four columns ───────────────────
const beforeFull = JSON.stringify(teamCols(aiTeam));
await mgr.prepareMatchday(aiTeam, 'full');
check(JSON.stringify(teamCols(aiTeam)) === beforeFull, 'full: prepareMatchday is idempotent (same columns on re-run)');
const beforeAsst = JSON.stringify(teamCols(humanTeam));
await mgr.prepareMatchday(humanTeam, 'assistant');
check(JSON.stringify(teamCols(humanTeam)) === beforeAsst, 'assistant: prepareMatchday is idempotent');

// ── No-key fallback explicitly confirmed (the env above forced it) ─────────────
check(process.env.TACTICS_LLM_API_KEY === '', 'ran on the no-key fallback path (LLM never called)');

// ── The synchronous heuristic-only entry sets shape+XI without the LLM ──────────
const aiTeam2 = aiTeams[1];
mgr.prepareMatchdayHeuristic(aiTeam2, 'full');
const sync = teamCols(aiTeam2);
check(!!FORMATIONS[sync.formation], 'sync heuristic: formation is a real registry key');
check(legalLineup(sync.lineup, squadSize(aiTeam2)) && legalDirectives(sync.plan_directives), 'sync heuristic: lineup + plan are legal');

// ── A squad with a surplus of centre-backs leans to a back-three shape ─────────
// Rebuild an AI squad: replace its full-backs with extra centre-backs so the structural nudge fires.
const aiTeam3 = aiTeams[2];
db.prepare("UPDATE players SET role = 'CB' WHERE team_id = ? AND role = 'FB'").run(aiTeam3);
mgr.prepareMatchdayHeuristic(aiTeam3, 'full');
const f3 = teamCols(aiTeam3).formation;
check(f3.startsWith('3-') || f3.startsWith('5-'), `surplus centre-backs -> a back-three/five shape (got ${f3})`);

// ── prepareWorldMatchday: the integration helper preps the right teams at the right tier ──
// Reset the world: clear every team's columns + give the human a blank plan, then prep a matchday.
db.prepare('UPDATE teams SET formation = ?, lineup = NULL, plan_text = NULL, plan_directives = NULL WHERE league_id = ?')
  .run('4-3-3', tier2);
const round1 = db.prepare('SELECT id FROM fixtures WHERE league_id = ? AND round = 1').all(tier2) as { id: number }[];
await mgr.prepareWorldMatchday(round1.map(f => f.id));
// the human (blank plan, idle) got the neutral assistant fill; an AI club got a full setup
const humanAfter = teamCols(humanTeam);
check(!!humanAfter.plan_text && JSON.parse(humanAfter.plan_directives!).directives.length === 0, 'world prep: idle human got the neutral assistant plan');
const aiAfter = teamCols(aiTeam);
check(!!aiAfter.plan_text && legalDirectives(aiAfter.plan_directives), 'world prep: AI club got a full legal setup');
// a human who DID set a plan is left untouched
db.prepare("UPDATE teams SET plan_text = 'my own plan', plan_directives = ? WHERE id = ?").run(JSON.stringify({ summary: 'mine', directives: [] }), humanTeam);
await mgr.prepareWorldMatchday(round1.map(f => f.id));
check(teamCols(humanTeam).plan_text === 'my own plan', 'world prep: a human who set a plan is left untouched');

// ── done ───────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

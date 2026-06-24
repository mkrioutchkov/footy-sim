// NL-tactics compiler COVERAGE harness (§ strategic arc — north-star, TACTICS_DEPTH.md).
// Runs every instruction in .scratch/traces/TACTICS_COVERAGE_CORPUS.md through the REAL plan.ts compiler
// (compileInitialPlan → the same live LLM path the tactics box uses) and dumps, per instruction, the
// compiled directives + summary + note. A human (or SysArch's panel) then tags each
// supported / honestly-declined / silently-dropped and computes coverage% — the ranking of the misses
// drives Boris's behavior-primitive priority. NOT a CI test (LLM-backed, non-deterministic, costs calls);
// it's an on-demand diagnostic. Re-run as primitives land to watch coverage climb.
//
//   npx tsx --env-file-if-exists=web/backend/.env tools/tactics_coverage.ts
//
// Needs the live tactics LLM configured (TACTICS_LLM_LIVE_* in web/backend/.env); with no key the
// compiler no-ops and every line reads as a drop (so the run is only meaningful with a key).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileInitialPlan, type SquadPlayer } from '../web/backend/plan.ts';
import { llmReady } from '../web/backend/llm.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = readFileSync(path.join(root, '.scratch/traces/TACTICS_COVERAGE_CORPUS.md'), 'utf8');
const instructions = corpus.split('\n').map(l => l.match(/^\s*(\d+)\.\s+(.+?)\s*$/)).filter((m): m is RegExpMatchArray => !!m).map(m => ({ n: Number(m[1]), text: m[2] }));

// A representative 4-3-3 squad covering the corpus's role + name references (Tanaka/Bauer named explicitly).
const ROLES: [string, string][] = [
  ['Ortiz', 'GK'], ['Bauer', 'CB'], ['Adebayo', 'CB'], ['Tanaka', 'FB'], ['Walsh', 'FB'],
  ['Cole', 'CM'], ['Diaz', 'CM'], ['Esposito', 'CM'], ['Friedman', 'WM'], ['Gallagher', 'WM'], ['Stone', 'CF'],
];
const squad: SquadPlayer[] = ROLES.map(([name, role], id) => ({ id, name, role, morale: 70 }));

if (!llmReady(true).ok) console.warn('⚠ live tactics LLM not configured (TACTICS_LLM_LIVE_*) — every line will read as a drop. Set the key in web/backend/.env to measure real coverage.\n');

const fmtDir = (d: unknown): string => { try { return JSON.stringify(d); } catch { return String(d); } };
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
// The live tactics LLM (Groq free tier) rate-limits ~30 req/min, so pace the calls + retry the
// "unreachable" failures — otherwise a rapid 42-call burst reads transport errors as false coverage misses.
const DELAY = Number(process.env.COVERAGE_DELAY_MS ?? 2200);
async function compileWithRetry(text: string): Promise<Awaited<ReturnType<typeof compileInitialPlan>>> {
  let last: Awaited<ReturnType<typeof compileInitialPlan>> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2500 * attempt);   // backoff before a retry
    try { const r = await compileInitialPlan(text, squad); if (!r.error) return r; last = r; }
    catch (e) { last = { plan: { summary: '', directives: [] }, changed: '', motivation: [], note: '', error: (e as Error).message }; }
  }
  return last!;
}

let withDirs = 0, empties = 0, errors = 0;
console.log(`# tactics coverage run — ${instructions.length} instructions through compileInitialPlan (delay ${DELAY}ms, 3 attempts each)\n`);
for (const ins of instructions) {
  await sleep(DELAY);
  try {
    const r = await compileWithRetry(ins.text);
    const dirs = r.plan?.directives ?? [];
    if (r.error) errors++;
    if (dirs.length) withDirs++; else empties++;
    console.log(`[${String(ins.n).padStart(2)}] "${ins.text}"`);
    console.log(`     dirs(${dirs.length}): ${dirs.map(fmtDir).join('  ') || '—'}`);
    console.log(`     summary: ${r.plan?.summary ?? ''}`);
    if (r.note && r.note.trim()) console.log(`     note: ${r.note.trim()}`);
    if (r.changed && r.changed.trim() && r.changed !== r.note) console.log(`     changed: ${r.changed.trim()}`);
    if (r.error) console.log(`     ERROR: ${r.error}`);
    console.log('');
  } catch (e) {
    errors++;
    console.log(`[${String(ins.n).padStart(2)}] "${ins.text}"\n     EXCEPTION: ${(e as Error).message}\n`);
  }
}
console.log(`# ${withDirs}/${instructions.length} produced >=1 directive; ${empties} produced none; ${errors} errored.`);
console.log(`# NEXT: read each result above and tag supported / honestly-declined / silently-dropped (a directive present is NOT necessarily faithful — judge intent). coverage% = faithful-supported / ${instructions.length}.`);

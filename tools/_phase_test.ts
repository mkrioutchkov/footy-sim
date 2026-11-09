// Phase-condition gate test (§ phase-channel vocab sync). The plan.ts compiler only honours a
// when:{phase} condition when the shout actually ties an order to a game phase (PHASE_WORDS), mirroring
// the time/score guards so plain orders stay unconditional; and only the engine's known phase values are
// accepted (VALID_PHASES). The LLM-EMIT step is verify-gated on the Groq endpoint — this locks the
// deterministic gate. (plan.ts pulls llm.ts/db.ts on import, so point FOOTY_DB at a throwaway.)
//   npx tsx tools/_phase_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-phase-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { PHASE_WORDS, VALID_PHASES } = await import('../web/backend/plan.ts');

// ── PHASE_WORDS matches real phase-trigger shouts (would let a when:{phase} through) ──
for (const s of [
  'counter-press the second we lose it, swarm the ball',
  'press hard when we lose the ball',
  'sit deeper when out of possession',
  'get forward when we have the ball',
  'spring on the counter the moment we win it back',
  'gegenpress high up',
]) check(PHASE_WORDS.test(s), `phase trigger matched: "${s}"`);

// ── plain orders DON'T match (phase stays omitted — no hallucinated conditions) ──
for (const s of [
  'play him as a target man up top',
  'stick to their number 10 all game',
  'switch the play more',
  'shoot on sight from range',
]) check(!PHASE_WORDS.test(s), `plain order correctly NOT a phase trigger: "${s}"`);

// ── only the engine's known phase values are accepted (main.cpp CondPhase) ──
check(['in_possession', 'attacking', 'out_of_possession', 'defending', 'transition'].every(p => VALID_PHASES.has(p)), 'VALID_PHASES has all engine phase values');
check(!VALID_PHASES.has('bogus') && !VALID_PHASES.has('attacking_third'), 'an unknown phase value is rejected');

const { db } = await import('../web/backend/db.ts');
db.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

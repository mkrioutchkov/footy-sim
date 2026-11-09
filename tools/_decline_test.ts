// honest-decline net test (§ coverage). declineFallback surfaces "couldn't map that" ONLY when the LLM's
// tactical attempt was entirely dropped (an unrecognised kind), with no real directives, no motivation, and no
// note of its own — never clobbering a legit mapping or an existing note. Pure (no LLM/DB), so deterministic.
//   npx tsx tools/_decline_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-dec-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { declineFallback } = await import('../web/backend/plan.ts');
const DECLINE = "I couldn't map that to a tactical setting yet.";

// ── fires ONLY on the silent validated-away no-op (no dirs, no motivation, a dropped kind, no note) ──
check(declineFallback(false, false, true, '') === DECLINE, 'a dropped-kind-only no-op → honest decline note');

// ── suppressed by anything real ──
check(declineFallback(true, false, true, '') === '', 'real directives present → no decline (mapped fine)');
check(declineFallback(false, true, true, '') === '', 'a motivation-only shout → no decline');
check(declineFallback(false, false, false, '') === '', 'nothing dropped (e.g. a clean empty/no-op) → no decline');
check(declineFallback(false, false, true, 'unknown player AB') === 'unknown player AB', "the LLM's own note is preserved, not clobbered");
check(declineFallback(true, true, true, 'note') === 'note', 'a fully-populated result keeps its note unchanged');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// Deterministic offline regression test for web/backend/plan.ts validate().
// The live compile paths (compileInitialPlan / compilePlanEdit) are LLM-backed and
// non-deterministic, so this drives validate() directly with hand-authored raw plans.
// No key needed. Run:  npx tsx tools/test_plan_validate.ts
import { validate } from '../web/backend/plan.ts';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const mine = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const noMot = () => new Map<number, number>();

// ── GAP 1: a man_mark in a STANDING plan (no opponent XI) must surface a note,
// not vanish silently. Simulates the standing-plan compile (oppIds empty).
{
  const raw = { plan: { summary: 'Mark up and press.', directives: [
    { playerId: 7, kind: 'man_mark', targetId: 9, intensity: 1 },   // opponent target, but no opp XI pre-match
    { kind: 'high_press', teamScope: 0, intensity: 0.8 },
  ] } };
  const v = validate(raw, 'home', 'AB marks their 9 and we press high', mine, new Set<number>(), noMot());
  check('GAP1 standing man_mark surfaces a note', /man-?mark/i.test(v.note), `note="${v.note}"`);
  check('GAP1 standing man_mark is dropped from directives',
    !v.plan.directives.some(d => d.kind === 'man_mark'));
  check('GAP1 the co-ordinated high_press still compiles',
    v.plan.directives.some(d => d.kind === 'high_press'));
}

// ── Counter-case: mid-match (oppIds populated) a valid man_mark binds and adds NO
// standing-plan note.
{
  const opp = new Set([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  const raw = { plan: { summary: '', directives: [
    { playerId: 7, kind: 'man_mark', targetId: 19, intensity: 1 },
  ] } };
  const v = validate(raw, 'home', 'AB marks their winger', mine, opp, noMot());
  check('mid-match man_mark binds to the opponent',
    v.plan.directives.some(d => d.kind === 'man_mark' && d.targetId === 19));
  check('mid-match man_mark adds no standing-plan note', !/standing plan/i.test(v.note), `note="${v.note}"`);
}

// ── Counter-case: no man_mark at all → no spurious note.
{
  const raw = { plan: { summary: '', directives: [{ kind: 'high_press', teamScope: 0, intensity: 0.7 }] } };
  const v = validate(raw, 'home', 'press high', mine, new Set<number>(), noMot());
  check('a plan with no man_mark gets no man-mark note', !/man-?mark/i.test(v.note), `note="${v.note}"`);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall plan.validate() checks passed');

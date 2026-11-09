// Training & Coaches MVP — pure-function tests (determinism anchor, intensity model, category model).
// Gitignored (tools/_*_test.ts). Run: npx tsx tools/_training_mvp_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-trainmvp-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');   // opens FOOTY_DB; close before rmSync (Windows EPERM)
db.exec('PRAGMA foreign_keys = OFF');                  // unit test: seed orphan staff/player rows without full team/world graph
db.prepare("INSERT INTO teams (id, name, league_id, user_id, tactics, created_at) VALUES (1, 'Test FC', 1, 1, '{}', 0)").run();   // a team for the coach-assignment read/write
const t = await import('../web/backend/training.ts');
const { seededGrowth, intensityFactor, CATEGORY_ATTRS, ATTR_PRIMARY_CATEGORY, TRAINING_CATEGORIES, TRAINABLE, developAttrs } = t;

// ── seededGrowth: deterministic + in [0,1) + varies with each tuple member ──
check(seededGrowth(1, 1, 5, 1) === seededGrowth(1, 1, 5, 1), 'seededGrowth deterministic (same tuple -> same value)');
check(seededGrowth(1, 1, 5, 1) !== seededGrowth(2, 1, 5, 1), 'seededGrowth varies by playerId');
check(seededGrowth(1, 1, 5, 1) !== seededGrowth(1, 2, 5, 1), 'seededGrowth varies by season');
check(seededGrowth(1, 1, 5, 1) !== seededGrowth(1, 1, 6, 1), 'seededGrowth varies by round');
check(seededGrowth(1, 1, 5, 1) !== seededGrowth(1, 1, 5, 2), 'seededGrowth varies by worldId');
{
  let inRange = true;
  for (let i = 0; i < 800; i++) { const v = seededGrowth(i, 1 + (i % 3), i % 7, 1); if (v < 0 || v >= 1) inRange = false; }
  check(inRange, 'seededGrowth always in [0,1)');
}

// ── intensityFactor: 'normal'/NULL/unknown = identity; ordering double > normal > half > rest ──
const ident = JSON.stringify({ growthMul: 1, injuryMul: 1, loadAdd: 0 });
check(JSON.stringify(intensityFactor('normal')) === ident, "'normal' is the identity triple (byte-safe default)");
check(JSON.stringify(intensityFactor(null)) === ident, 'NULL is the identity triple');
check(JSON.stringify(intensityFactor('garbage')) === ident, 'an unknown intensity falls back to identity');
const g = (l: string) => intensityFactor(l).growthMul;
check(g('double') > g('normal') && g('normal') > g('half') && g('half') > g('rest'), 'growthMul ordering double > normal > half > rest');
check(intensityFactor('rest').growthMul === 0, 'rest grows nothing');
check(intensityFactor('double').injuryMul > 1 && intensityFactor('half').injuryMul < 1, 'harder training raises injury risk, lighter lowers it');

// ── developAttrs growthMul: the new param is TRANSPARENT by default (byte-identical), and it scales growth ──
const dBase = { speed: 50, passing: 50, creativity: 50, shooting: 50, tackling: 50, positioning: 50, stamina: 50 };
const dTr = { professionalism: 50, consistency: 50 };
const dOmit = developAttrs(dBase, 20, 90, dTr, 'balanced', 65, 1, 1, 'CF');           // growthMul omitted
const dOne = developAttrs(dBase, 20, 90, dTr, 'balanced', 65, 1, 1, 'CF', 1);          // growthMul = 1
check(JSON.stringify(dOmit) === JSON.stringify(dOne), 'developAttrs: growthMul omitted === growthMul 1 (BYTE-IDENTICAL default — the slice-2 identity guard)');
check(developAttrs(dBase, 20, 90, dTr, 'balanced', 65, 1, 1, 'CF', 1.4).speed > dOne.speed, 'growthMul 1.4 grows faster than 1.0 (intensity scales growth)');
check(developAttrs(dBase, 20, 90, dTr, 'balanced', 65, 1, 1, 'CF', 0).speed === dBase.speed, 'growthMul 0 (rest) grows nothing for a young player');

// ── category model: 4 categories; every trainable attr has exactly one primary category that contains it ──
check(TRAINING_CATEGORIES.length === 4, 'four training categories');
{
  let everyAttrMapped = true, primaries = new Set<string>();
  for (const a of TRAINABLE) {
    // Keeper-only handling joined TRAINABLE in 903f192 and deliberately maps to no MVP coach
    // category: a handling-focused keeper falls back to his role's dominant category instead.
    if (a === 'handling') continue;
    const cat = ATTR_PRIMARY_CATEGORY[a];
    primaries.add(cat);
    if (!cat || !CATEGORY_ATTRS[cat] || !CATEGORY_ATTRS[cat].includes(a)) everyAttrMapped = false;
  }
  check(everyAttrMapped, 'every outfield trainable attr has a primary category that contains it');
  check([...primaries].every(c => (TRAINING_CATEGORIES as readonly string[]).includes(c)), 'all primary categories are valid');
  check(ATTR_PRIMARY_CATEGORY.handling === undefined, 'keeper-only handling maps to no coach category (role fallback)');
}
check(Object.keys(CATEGORY_ATTRS).every(c => (TRAINING_CATEGORIES as readonly string[]).includes(c)), 'CATEGORY_ATTRS keys are all valid categories');

// ── coach-factor functions (staff.ts) ──
const { coachAttrs, categoryStars, categoryCoverage, categoryCoachFactor, coachingFactor } = await import('../web/backend/staff.ts');
check(coachAttrs({ rating: 70 }).attacking === 70 && coachAttrs({ rating: 70 }).youth === 70, 'coachAttrs backfills every key from rating when attrs NULL');
check(coachAttrs({ rating: 70, attrs: '{"attacking":90}' }).attacking === 90, 'coachAttrs parses staff.attrs JSON');
// FALLBACK (byte-identical): a NULL assignment / unassigned category resolves to the flat coachingFactor.
check(categoryCoachFactor(1, null, 'Attacking') === coachingFactor(1), 'categoryCoachFactor(NULL assignment) === flat coachingFactor (byte-identical fallback)');
check(categoryStars(1, null, 'Attacking') === 2.5, 'categoryStars unassigned = neutral 2.5');
check(categoryCoverage(1, null, 'Defending') === 0.55, 'categoryCoverage unassigned = 0.55 floor');
// Seed a 5-star attacking coach on team 1 + assign him to Attacking (no teams row needed — queries are by team_id).
const ins = db.prepare("INSERT INTO staff (world_id, team_id, role, name, rating, cost, specialty, attrs) VALUES (1,1,'coach',?,?,0,?,?)");
const atk = Number(ins.run('Ace Atk', 92, 'first_team_coach', JSON.stringify({ attacking: 100, defending: 40, technical: 60, tactical: 60, fitness: 50, gk: 50, youth: 50 })).lastInsertRowid);
const assign = JSON.stringify({ Attacking: [atk] });
check(Math.abs(categoryStars(1, assign, 'Attacking') - 5) < 1e-9, 'a 100-attacking coach = 5.0 stars in Attacking');
const atkF = categoryCoachFactor(1, assign, 'Attacking');
check(atkF > 1.0 && atkF <= 1.30, 'a 5-star assigned attacking coach lifts the Attacking factor above flat (toward 1.30)');
check(atkF > categoryCoachFactor(1, assign, 'Defending'), 'assigned Attacking outpaces unassigned Defending (flat fallback) — per-category wiring works');
{
  let inRange = true;
  for (const cat of ['Attacking', 'Possession', 'Defending', 'Fitness']) {
    const f = categoryCoachFactor(1, assign, cat); if (f < 0.90 || f > 1.30) inRange = false;
    const s = categoryStars(1, assign, cat); if (s < 0.5 || s > 5) inRange = false;
    const cov = categoryCoverage(1, assign, cat); if (cov < 0.55 || cov > 1.0) inRange = false;
  }
  check(inRange, 'categoryCoachFactor in [0.90,1.30], stars in [0.5,5], coverage in [0.55,1.0]');
}

// ── saveCoachAssignment + categoryBoard + getCoachAssignment (uses the coach 'atk' seeded above) ──
const { saveCoachAssignment, getCoachAssignment, categoryBoard } = await import('../web/backend/staff.ts');
saveCoachAssignment(1, { Attacking: [atk], Bogus: [999], Defending: [999] });   // bogus category + unowned id dropped
check(JSON.stringify(getCoachAssignment(1)) === JSON.stringify({ Attacking: [atk] }), 'saveCoachAssignment keeps valid Attacking:[coach], drops bogus category + unowned id');
const board = categoryBoard(1);
check(board.length === 4, 'categoryBoard has 4 categories');
check(board.find(b => b.category === 'Attacking')!.factor > board.find(b => b.category === 'Defending')!.factor, 'the assigned Attacking category outranks the unassigned Defending on the board');
saveCoachAssignment(1, null);
check(getCoachAssignment(1) === null, 'saveCoachAssignment(null) clears to unassigned (flat / byte-identical)');

// ── setPlayerTrainingIntensity validation + persistence ──
const { setPlayerTrainingIntensity } = await import('../web/backend/training.ts');
db.prepare("INSERT INTO players (team_id, slot, name, role, attrs, age, potential) VALUES (1, 0, 'Tester', 'CF', '{}', 22, 80)").run();
check(setPlayerTrainingIntensity(1, 0, 'double').intensity === 'double', 'setPlayerTrainingIntensity stores a valid value');
check(setPlayerTrainingIntensity(1, 0, 'garbage').intensity === null, 'an invalid intensity clears to NULL (normal/identity)');
check(setPlayerTrainingIntensity(1, 0, 'normal').intensity === null, "'normal' stores NULL (the identity default)");
check(setPlayerTrainingIntensity(1, 99, 'double').ok === false, 'a non-existent slot is a no-op');

// ── fitness.ts intensity → injury trade-off (the cost of the growthMul boost) ──
const { startInjuryRisk } = await import('../web/backend/fitness.ts');
const riskN = startInjuryRisk(60, intensityFactor('normal').injuryMul);
check(riskN === startInjuryRisk(60, 1), 'normal-intensity injury risk is byte-identical (injuryMul 1)');
check(startInjuryRisk(60, intensityFactor('double').injuryMul) > riskN, 'double intensity raises injury risk (the cost of faster growth)');
check(riskN > startInjuryRisk(60, intensityFactor('rest').injuryMul), 'rest lowers injury risk below normal');

try { db.close(); } catch { /* ignore */ }
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows can hold the file briefly */ }
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

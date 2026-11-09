// Backroom-staff test (no engine, no LLM). Pool seeding + hire/fire flow + budget/cap guards, the
// deterministic effect math (coach/physio/scout), and the integration hooks (developAttrs coach
// factor, buildScoutReport depth). Staff are inserted directly for the effect assertions so ratings
// are fixed; the hire/fire flow uses the seeded pool.
//
//   npx tsx tools/_staff_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-staff-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const staff = await import('../web/backend/staff.ts');
const training = await import('../web/backend/training.ts');
const scout = await import('../web/backend/scout.ts');

const u = registerUser('gaffer', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Staff FC', game.DEFAULT_TACTICS);
const worldId = (db.prepare('SELECT world_id AS w FROM leagues WHERE id = ?').get(game.getTeamWithPlayers(teamId)!.leagueId) as { w: number }).w;
const insStaff = (role: string, rating: number) => db.prepare('INSERT INTO staff (world_id, team_id, role, name, rating, cost) VALUES (?,?,?,?,?,?)').run(worldId, teamId, role, `${role}-${rating}`, rating, 1_000_000);
const clearStaff = () => db.prepare('DELETE FROM staff WHERE team_id = ?').run(teamId);

// ── pool seeds + a fresh club has identity effects ────────────────────────────────────────────
const view = staff.getStaffView(teamId);
check(view.pool.length >= 12, 'the hire pool seeds candidates');
check(view.staff.length === 0, 'a fresh club has no staff');
check(view.effects.training === 0 && view.effects.injuryReduction === 0 && view.effects.recoverBonus === 0 && view.effects.scoutDepth === 0, 'no staff → every effect is the identity');
check(staff.coachingFactor(teamId) === 1 && staff.physioEffect(teamId).injuryMult === 1 && staff.scoutDepth(teamId) === 0, 'identity effect functions with no staff');

// ── hire / fire flow against the pool ─────────────────────────────────────────────────────────
const cheapest = [...view.pool].sort((a, b) => a.cost - b.cost)[0];
const budget0 = view.budget;
const hired = staff.hireStaff(teamId, cheapest.id);
check(hired.ok && hired.name === cheapest.name, 'hireStaff signs a pool candidate');
const afterHire = staff.getStaffView(teamId);
check(afterHire.staff.length === 1 && afterHire.budget === budget0 - cheapest.cost, 'hire adds the member + deducts the fee from budget');
check(!afterHire.pool.some(p => p.id === cheapest.id), 'the hired member leaves the pool');
check(!staff.hireStaff(teamId, cheapest.id).ok, 'cannot hire someone already employed (not in the pool)');
const fired = staff.fireStaff(teamId, cheapest.id);
check(fired.ok && staff.getStaffView(teamId).staff.length === 0, 'fireStaff releases the member');
check(staff.getStaffView(teamId).pool.some(p => p.id === cheapest.id), 'a released member returns to the pool (no refund)');
check(!staff.fireStaff(teamId, 999999).ok, 'cannot fire a non-existent / not-yours member');

// ── deterministic effect math ─────────────────────────────────────────────────────────────────
clearStaff();
insStaff('coach', 65);
check(approx(staff.coachingFactor(teamId), 1.05), 'one 65-rated coach → ×1.05 training');
clearStaff(); insStaff('coach', 90); insStaff('coach', 90); insStaff('coach', 90);
check(approx(staff.coachingFactor(teamId), 1.30), 'three elite coaches cap training at ×1.30');
check(staff.getStaffView(teamId).effects.training === 30, 'effects summary reports +30% training');
clearStaff(); insStaff('physio', 90);
const pe = staff.physioEffect(teamId);
check(approx(pe.injuryMult, 0.85) && pe.recoverBonus === 5, 'one elite physio → ×0.85 injury risk, +5 recovery');
clearStaff(); for (let i = 0; i < 4; i++) insStaff('physio', 90);
const pe4 = staff.physioEffect(teamId);
check(approx(pe4.injuryMult, 0.55) && pe4.recoverBonus === 15, 'physio effects cap (×0.55 injury, +15 recovery)');
clearStaff(); insStaff('scout', 90); insStaff('scout', 90);
check(staff.scoutDepth(teamId) === 2, 'two elite scouts → +2 scouted players');
clearStaff(); for (let i = 0; i < 5; i++) insStaff('scout', 90);
check(staff.scoutDepth(teamId) === 3, 'scout depth caps at +3');

// ── cap + budget guards ───────────────────────────────────────────────────────────────────────
clearStaff();
for (let i = 0; i < staff.MAX_STAFF; i++) insStaff('coach', 50);
const poolMember = staff.getStaffView(teamId).pool[0];
check(!staff.hireStaff(teamId, poolMember.id).ok, `cannot exceed the ${staff.MAX_STAFF}-staff cap`);
clearStaff();
db.prepare('UPDATE teams SET budget = 0 WHERE id = ?').run(teamId);
check(!staff.hireStaff(teamId, poolMember.id).ok, 'cannot hire with no budget for the fee');
db.prepare('UPDATE teams SET budget = 100000000 WHERE id = ?').run(teamId);

// ── integration: coach factor speeds developAttrs; scouts deepen the report ────────────────────
const youngAttrs = { speed: 60, passing: 60, creativity: 60, shooting: 60, tackling: 60, positioning: 60, stamina: 60 };
const base = training.developAttrs(youngAttrs, 20, 90, null, 'balanced', 65, 1);
const coached = training.developAttrs(youngAttrs, 20, 90, null, 'balanced', 65, 1.3);
check(coached.speed > base.speed, 'a higher coach factor grows a young player faster');

clearStaff();
// the soonest fixture is the IMMINENT next match (roundsAway 0), which §2.8 reveals one extra man for —
// so the counts are 5 base + scoutDepth + 1 (imminent): 6 with no scouts, 8 with two.
const fx = db.prepare('SELECT id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round LIMIT 1').get(teamId, teamId) as { id: number };
check(scout.buildScoutReport(fx.id, teamId)!.keyPlayers.length === 6, 'no scouts → 5 key players + 1 for the imminent next opponent (§2.8)');
insStaff('scout', 90); insStaff('scout', 90);   // scoutDepth 2
check(scout.buildScoutReport(fx.id, teamId)!.keyPlayers.length === 8, 'two scouts → 5 + 2 scouted + 1 imminent = 8 revealed');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

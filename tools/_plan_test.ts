// Plain-English standing-plan test (no engine, no LLM key — the compile needs Groq, so this tests
// the deterministic half: persistence + spec injection + team-relative→engine id resolution +
// neutral dials for the human team + AI keeping its dials). A separate HTTP-smoke check covers the
// graceful no-key compile route.
//
//   npx tsx tools/_plan_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-plan-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const match = await import('../web/backend/match.ts');

// ── P0 vocab contract: cutback/contain/stay_back recognised + routed per-player (engine main.cpp parses them) ──
const tactics = await import('../web/backend/tactics.ts');
check(['cutback', 'contain', 'stay_back'].every(k => tactics.VALID_KINDS.has(k)), 'cutback/contain/stay_back are in VALID_KINDS (no longer dropped by validate)');
check(['cutback', 'contain', 'stay_back'].every(k => !tactics.TEAM_KIND_SET.has(k)), 'they are per-player kinds (validate requires playerId, not teamScope)');
check(tactics.VALID_KINDS.has('press_intensity') && tactics.TEAM_KIND_SET.has('press_intensity'), 'press_intensity is a recognised TEAM-WIDE dial (validate keeps it; engine main.cpp:104 routes it to DK::PressIntensity)');

// ── formation registry invariants (11 slots, GK first, valid roles, in-bounds) + the 4 new shapes ──
const formations = await import('../web/backend/formations.ts');
// DM/AM are web-side positional slot roles (bridged to CM for the engine via engineRole()).
const ROLES = new Set(['GK', 'CB', 'FB', 'CM', 'WM', 'CF', 'DM', 'AM']);
const ENGINE_ROLES = new Set(['GK', 'CB', 'FB', 'CM', 'WM', 'CF']);
for (const [name, slots] of Object.entries(formations.FORMATIONS)) {
  check(slots.length === 11, `${name}: 11 slots`);
  check(slots[0].role === 'GK', `${name}: slot 0 is GK`);
  check(slots.every(s => ROLES.has(s.role) && s.x >= 0 && s.x <= 1050 && s.y >= 0 && s.y <= 680), `${name}: every slot is a valid role, in-bounds`);
  // every slot role must collapse to one of the 6 engine roles (never the CF fall-through trap)
  check(slots.every(s => ENGINE_ROLES.has(formations.engineRole(s.role))), `${name}: every slot's engineRole() is a real engine role`);
}
// DM/AM map to CM at the boundary; the 6 engine roles pass through unchanged.
check(formations.engineRole('DM') === 'CM' && formations.engineRole('AM') === 'CM', 'engineRole bridges DM/AM → CM (not the roleFromStr CF fall-through)');
check((['GK', 'CB', 'FB', 'CM', 'WM', 'CF'] as const).every(r => formations.engineRole(r) === r), 'engineRole is identity on the 6 engine roles');
check(['4-2-3-1', '4-2-2-2', '3-4-2-1', 'wide 4-2-3-1'].every(k => formations.FORMATIONS[k].some(s => s.role === 'DM') && formations.FORMATIONS[k].some(s => s.role === 'AM')), 'the 10/pivot shapes carry both a DM and an AM slot');
check(formations.FORMATIONS['4-3-3'].every(s => s.role !== 'DM' && s.role !== 'AM'), 'the default 4-3-3 has NO DM/AM (engine-default shape untouched)');
check(['4-2-2-2', '3-4-2-1', 'wide 4-2-3-1', 'wide diamond'].every(k => formations.FORMATIONS[k]), 'the 4 new formations are registered');
check(formations.normalizeFormation('4222') === '4-2-2-2' && formations.normalizeFormation('3421') === '3-4-2-1', 'the digit-distinct new shapes normalise from bare digits');
check(formations.normalizeFormation('wide 4-2-3-1') === 'wide 4-2-3-1' && formations.normalizeFormation('wide diamond') === 'wide diamond', 'the named wide shapes resolve to themselves (exact-key wins over the digit path) — not collapsed to a digit shape');
check(formations.normalizeFormation('4-2-3-1') === '4-2-3-1' && formations.normalizeFormation('442') === '4-4-2', 'the digit path still works (narrow 4-2-3-1, 442 → 4-4-2)');

const u = registerUser('tactician', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Plan FC', game.DEFAULT_TACTICS);
const aiId = (db.prepare('SELECT id FROM teams WHERE user_id IS NULL ORDER BY id LIMIT 1').get() as { id: number }).id;
const ai2 = (db.prepare('SELECT id FROM teams WHERE user_id IS NULL AND id != ? ORDER BY id LIMIT 1').get(aiId) as { id: number }).id;

// give the user team a (manually compiled, team-relative) standing plan + a non-neutral stored dial
db.prepare('UPDATE teams SET tactics = ? WHERE id = ?').run(JSON.stringify({ aggression: 90, passingDirectness: 10, overlapFrequency: 80, midfieldFreedom: 30, defensiveLineHeight: 70 }), teamId);
const plan = {
  summary: 'High press; full-backs bomb on.',
  directives: [
    { playerId: -1, teamScope: 0, kind: 'high_press', intensity: 1, when: { fromMin: 0, toMin: 1000, scoreState: 'any', scoreBy: 0 } },
    { playerId: 4, kind: 'get_forward', intensity: 1, when: { fromMin: 0, toMin: 1000, scoreState: 'any', scoreBy: 0 } },
  ],
};
db.prepare('UPDATE teams SET plan_text = ?, plan_directives = ? WHERE id = ?').run('high press, full-backs bomb on', JSON.stringify(plan), teamId);

// ── getTeamWithPlayers exposes the plan ──────────────────────────────────────────────────────
const t = game.getTeamWithPlayers(teamId)!;
check(t.planText === 'high press, full-backs bomb on', 'getTeamWithPlayers returns planText');
check(t.plan != null && t.plan.directives.length === 2, 'getTeamWithPlayers parses the compiled plan');

const NEUTRAL = JSON.stringify(game.DEFAULT_TACTICS);
const aiTactics = JSON.stringify(game.getTeamWithPlayers(aiId)!.tactics);

// ── user as HOME: directives at engine ids 0-10, teamScope 0; human dials neutral; AI keeps dials ──
const home = match.buildTieSpec(teamId, aiId, 1) as any;
check(Array.isArray(home.directives) && home.directives.length === 2, 'home spec carries the plan directives');
check(home.directives.some((d: any) => d.kind === 'high_press' && d.teamScope === 0), 'team-wide directive resolves to home teamScope 0');
check(home.directives.some((d: any) => d.kind === 'get_forward' && d.playerId === 4), 'per-player directive keeps id 4 for home');
check(JSON.stringify(home.home.tactics) === NEUTRAL, 'the human team plays NEUTRAL dials (its old 90/10 dials are ignored)');
check(JSON.stringify(home.away.tactics) === aiTactics, 'the AI opponent keeps its own dials');

// ── user as AWAY: ids shift +11, teamScope flips to 1; human dials still neutral ─────────────
const away = match.buildTieSpec(aiId, teamId, 1) as any;
check(away.directives.some((d: any) => d.kind === 'high_press' && d.teamScope === 1), 'team-wide directive resolves to away teamScope 1');
check(away.directives.some((d: any) => d.kind === 'get_forward' && d.playerId === 15), 'per-player directive shifts to engine id 15 (4+11) for away');
check(JSON.stringify(away.away.tactics) === NEUTRAL, 'the human team plays neutral dials whether home or away');
check(JSON.stringify(away.home.tactics) === aiTactics, 'the AI home side keeps its dials');

// ── slot→engine remap (review fix): a non-identity XI retargets per-player directives ────────
// swap slots 4 and 5 in the XI → engine position 5 now holds slot 4, so the get_forward(slot 4)
// directive must resolve to engine id 5, NOT a blind 4.
db.prepare('UPDATE teams SET lineup = ? WHERE id = ?').run(JSON.stringify([0, 1, 2, 3, 5, 4, 6, 7, 8, 9, 10]), teamId);
const reordered = match.buildTieSpec(teamId, aiId, 1) as any;
check(reordered.directives.some((d: any) => d.kind === 'get_forward' && d.playerId === 5), 'a per-player directive for slot 4 retargets to engine id 5 under a swapped XI');
check(!reordered.directives.some((d: any) => d.kind === 'get_forward' && d.playerId === 4), 'the directive is NOT left on the stale slot id 4');
db.prepare('UPDATE teams SET lineup = NULL WHERE id = ?').run(teamId);   // restore identity XI

// ── AI-vs-AI: no plans → no directives, dials unchanged (existing behaviour preserved) ───────
const aiVsAi = match.buildTieSpec(aiId, ai2, 1) as any;
check(aiVsAi.directives === undefined, 'an AI-vs-AI spec carries NO directives block (unchanged from before)');
check(JSON.stringify(aiVsAi.home.tactics) === aiTactics, 'AI-vs-AI keeps dial-based tactics');

// ── clearing the plan removes the directives + neutral persists ──────────────────────────────
db.prepare('UPDATE teams SET plan_text = NULL, plan_directives = NULL WHERE id = ?').run(teamId);
check(game.getTeamWithPlayers(teamId)!.plan === null, 'clearing plan_directives → no plan');
const cleared = match.buildTieSpec(teamId, aiId, 1) as any;
check(cleared.directives === undefined, 'a human team with no plan emits no directives (plays the neutral base)');
check(JSON.stringify(cleared.home.tactics) === NEUTRAL, 'human dials stay neutral even with no plan');

// ── §3 takers-via-prompt: the LLM "setPieceTakers" field parses to a PARTIAL taker edit ───────
const planMod = await import('../web/backend/plan.ts');
const xi = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);   // my fielded XI ids (0-10)
check(planMod.takersFromRaw(null, xi) === null && planMod.takersFromRaw({}, xi) === null, 'no/empty setPieceTakers → null (no change)');
const t1 = planMod.takersFromRaw({ fk: 9, corner: 9, pen: 7 }, xi)!;
check(t1.fk === 9 && t1.corner === 9 && t1.pen === 7 && !('longThrow' in t1), 'named roles map to slots; an UNnamed role stays absent (so a merge leaves it untouched)');
const tClear = planMod.takersFromRaw({ pen: null }, xi)!;
check('pen' in tClear && tClear.pen === null, 'an explicit null is kept as a CLEAR for that role');
const t2 = planMod.takersFromRaw({ fk: 15, corner: 3 }, xi)!;   // 15 isn't in my XI (opponent / bench)
check(!('fk' in t2) && t2.corner === 3, 'a taker not in my XI is dropped; the valid one is kept');
// merge semantics that /api/team/plan applies: absent role preserved, named overwritten, null cleared
const base = { fk: null, corner: null, pen: null, longThrow: null };
const cur = { ...base, fk: 2, pen: 5 };
const merged = { ...base, ...cur, ...planMod.takersFromRaw({ corner: 9, pen: null }, xi) };
check(merged.fk === 2 && merged.corner === 9 && merged.pen === null && merged.longThrow === null, 'merge: keep fk(2), add corner(9), clear pen, longThrow stays default');

// ── §2 quick-tactics: deterministic one-tap presets compose engine-supported team-wide kinds ──
const allout = planMod.buildQuickPlan('allout', 0);
check(allout.directives.length === 3 && allout.directives.every(d => d.playerId === -1 && d.teamScope === 0 && (d.intensity ?? 0) > 0 && (d.intensity ?? 0) <= 1 && tactics.TEAM_KIND_SET.has(d.kind)),
  'all-out preset → 3 valid team-wide dials (scope 0, intensity in (0,1], all real team kinds)');
check(allout.directives.some(d => d.kind === 'mentality') && allout.directives.some(d => d.kind === 'press_intensity') && allout.directives.some(d => d.kind === 'line_height'), 'all-out uses the gradated FM trio (mentality + press_intensity + line_height)');
check(planMod.buildQuickPlan('balanced', 0).directives.length === 0 && !!planMod.buildQuickPlan('balanced', 0).summary, 'balanced preset → no directives (neutral) but a descriptive summary');
check(planMod.buildQuickPlan('defensive', 1).directives.every(d => d.teamScope === 1), 'the preset honours the team scope (away = 1)');
check(Object.keys(planMod.QUICK_TACTICS).every(k => planMod.QUICK_TACTICS[k as keyof typeof planMod.QUICK_TACTICS].dirs.every(([kind]) => tactics.VALID_KINDS.has(kind))), 'every quick-tactic preset uses only VALID_KINDS (engine-recognised)');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// Morale-foundation test (LLM stream, part A). Throwaway FOOTY_DB; no engine. Exercises
// moraleDevFactor, developAttrs' morale modifier (+ backward compatibility), moraleTick
// (results lift/sour the room + drift toward neutral), the league development tick reading
// morale, and resetMorale.
//
//   npx tsx tools/_morale_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-mor-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const training = await import('../web/backend/training.ts');
const morale = await import('../web/backend/morale.ts');

const SKILLS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'];
const flat = (v: number) => Object.fromEntries(SKILLS.map(k => [k, v])) as Record<string, number>;
const ovr = (a: Record<string, number>) => Math.round(SKILLS.reduce((s, k) => s + a[k], 0) / SKILLS.length);
const pro = { professionalism: 80, consistency: 80 };
const moraleAll = (teamId: number) => game.getTeamWithPlayers(teamId)!.players.map(p => p.morale);

// ── moraleDevFactor: neutral at the default 65 ────────────────────────────────
check(morale.moraleDevFactor(65) === 1, 'morale 65 (default) is a neutral 1.0 dev factor');
check(morale.moraleDevFactor(100) > 1, 'high morale speeds development');
check(morale.moraleDevFactor(0) < 1, 'low morale slows development');

// ── developAttrs honours morale, and defaults to neutral (backward compatible) ─
// compare a raw attr (fractional) — a single tick's morale gap is real but can round to the same OVR
const hi = training.developAttrs(flat(70), 20, 90, pro, 'balanced', 95).speed;
const lo = training.developAttrs(flat(70), 20, 90, pro, 'balanced', 40).speed;
check(hi > lo, `a happy young player develops faster than an unhappy one (speed ${hi} vs ${lo})`);
check(JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'balanced')) === JSON.stringify(training.developAttrs(flat(70), 20, 90, pro, 'balanced', 65)),
  'omitting morale behaves exactly like the neutral 65 (backward compatible)');

// ── world + moraleTick (results + drift) ──────────────────────────────────────
const u = registerUser('gaffer', 'secret');
const { leagueId: tier2, teamId } = game.newSeasonForUser(u.id, u.username, 'Morale FC', game.DEFAULT_TACTICS);
check(moraleAll(teamId).every(m => m === 65), 'a fresh squad starts at the neutral 65');

const fx = db.prepare('SELECT id, home_team_id FROM fixtures WHERE league_id = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1').get(tier2, teamId, teamId) as { id: number; home_team_id: number };
const userHome = fx.home_team_id === teamId;
// a win lifts the room
db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(userHome ? 3 : 0, userHome ? 0 : 3, fx.id);
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(tier2);
check(moraleAll(teamId).every(m => m > 50), 'a win lifts squad morale');
// a defeat sours it
db.prepare('UPDATE fixtures SET home_score = ?, away_score = ? WHERE id = ?').run(userHome ? 0 : 3, userHome ? 3 : 0, fx.id);
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(tier2);
check(moraleAll(teamId).every(m => m < 50), 'a defeat sours squad morale');
// extreme morale drifts back toward neutral
db.prepare('UPDATE players SET morale = 95 WHERE team_id = ?').run(teamId);   // result is still a loss this tick
morale.moraleTick(tier2);
check(moraleAll(teamId).every(m => m < 95), 'morale drifts back toward neutral over time');

// ── league development tick reads morale ──────────────────────────────────────
// two identical young prospects, one happy / one miserable
const setProspect = (slot: number, m: number) => db.prepare("UPDATE players SET attrs=?, age=19, potential=90, personality=?, morale=? WHERE team_id=? AND slot=?")
  .run(JSON.stringify(flat(68)), JSON.stringify({ traits: pro }), m, teamId, slot);
setProspect(9, 95); setProspect(8, 30);
training.developmentTick(tier2);
const happy = game.getTeamWithPlayers(teamId)!.players.find(p => p.slot === 9)!;
const sad = game.getTeamWithPlayers(teamId)!.players.find(p => p.slot === 8)!;
check(happy.attrs.speed > sad.attrs.speed, `the happy prospect develops faster in the league tick (speed ${happy.attrs.speed} vs ${sad.attrs.speed})`);
void ovr;

// ── resetMorale (pre-season) ──────────────────────────────────────────────────
db.prepare('UPDATE players SET morale = 25 WHERE team_id = ?').run(teamId);
morale.resetMorale(tier2);
check(moraleAll(teamId).every(m => m === 65), 'resetMorale returns the squad to neutral optimism');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

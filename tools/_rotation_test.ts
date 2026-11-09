// Fitness & rotation guidance test (audit §2.10, no engine). The injury-risk formula (shared with
// fitnessTick), the fitness bands, the rotation suggestions (same-role fittest upgrade, injured-first,
// no double-booking), applyRotation's direct XI edit + validation + identity-NULL restore, and the
// physio mitigation tie-in.
//
//   npx tsx tools/_rotation_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-rot-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const market = await import('../web/backend/market.ts');
const fitness = await import('../web/backend/fitness.ts');
const rotation = await import('../web/backend/rotation.ts');

// ── injury-risk formula (the single source of truth fitnessTick rolls against) ──────────────────
check(approx(fitness.startInjuryRisk(100, 1), 0.03), 'a fully-fit starter carries the 3% base injury risk');
check(approx(fitness.startInjuryRisk(0, 1), 0.13), 'an exhausted starter peaks at 13% risk');
check(approx(fitness.startInjuryRisk(50, 1), 0.08), 'risk scales linearly with tiredness (50% → 8%)');
check(approx(fitness.startInjuryRisk(50, 0.5), 0.04), 'a physio multiplier cuts the risk');
check(fitness.startInjuryRisk(100, 1) < fitness.startInjuryRisk(50, 1) && fitness.startInjuryRisk(50, 1) < fitness.startInjuryRisk(0, 1), 'risk rises monotonically as fitness falls');

const u = registerUser('rotator', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Rotation FC', game.DEFAULT_TACTICS);
db.prepare('UPDATE teams SET wage_budget = 400000000, budget = 400000000 WHERE id = ?').run(teamId);
// build bench depth (slots 11+) so there are rotation options
for (let i = 0; i < 4; i++) { const m = market.getMarket(teamId)!; const a = [...m.freeAgents].sort((x, y) => x.value - y.value)[0]; if (a) market.buyFreeAgent(teamId, a.id); }
const squad = game.getTeamWithPlayers(teamId)!.players;
check(squad.length >= 14, `squad has bench depth for rotation (${squad.length})`);
const benchSlots = squad.filter(p => p.slot >= 11).map(p => p.slot).sort((a, b) => a - b);

// Scenario (identity XI = slots 0..10):
//  slot 9  = tired CF starter (40%)        -> should be rested for the fittest CF bench
//  slot 11 = fit CF bench (95%)            -> the chosen replacement
//  slot 12 = mediocre CF bench (50%)       -> NOT chosen over slot 11
//  slot 5  = injured CB starter            -> urgent suggestion
//  slot 13 = fit CB bench (90%)            -> covers the injured CB
const set = (slot: number, role: string, fit: number, inj = 0) =>
  db.prepare('UPDATE players SET role = ?, fitness = ?, injured_matches = ? WHERE team_id = ? AND slot = ?').run(role, fit, inj, teamId, slot);
set(9, 'CF', 40); set(5, 'CB', 100, 2);
set(benchSlots[0], 'CF', 95); set(benchSlots[1], 'CF', 50); set(benchSlots[2], 'CB', 90);
// neutralise any further bench depth to GK so the only CF/CB cover options are the ones set above
for (const extra of benchSlots.slice(3)) set(extra, 'GK', 100);
const [b11, b12, b13] = benchSlots;

const view = rotation.getRotationView(teamId)!;
// ── bands + risk + starter flags ──────────────────────────────────────────────────────────────
const P = (slot: number) => view.players.find(p => p.slot === slot)!;
check(P(9).band === 'exhausted' && P(b11).band === 'fresh', 'fitness bands classify exhausted vs fresh');
check(P(5).band === 'injured' && P(5).risk === 0, 'an injured player is its own band with no start-risk');
check(approx(P(9).risk, fitness.startInjuryRisk(40, 1)), 'a player risk matches the shared formula');
check(P(9).starter === true && P(b11).starter === false, 'the XI (slots 0-10) are starters, the rest bench');
check(view.physioMitigation === 0, 'no physios → zero mitigation');
check(view.expectedInjuries > 0, 'expected-injuries aggregates the starters’ risk');

// ── suggestions: same-role fittest upgrade, injured first, no double-book ────────────────────────
const sCF = view.suggestions.find(s => s.outSlot === 9);
check(!!sCF && sCF.inSlot === b11, 'the tired CF is paired with the FITTEST CF bench option (not the mediocre one)');
const sCB = view.suggestions.find(s => s.outSlot === 5);
check(!!sCB && sCB.inSlot === b13 && sCB.urgent === true, 'the injured CB gets an urgent cover suggestion');
check(view.suggestions.every(s => view.players.find(p => p.slot === s.inSlot)!.role === view.players.find(p => p.slot === s.outSlot)!.role), 'every suggestion swaps like-for-like role');
check(new Set(view.suggestions.map(s => s.inSlot)).size === view.suggestions.length, 'no bench player is offered to two starters at once');
check(view.atRisk >= 2, 'the at-risk count includes the tired + injured starters');
// a fresh starter with no fitter cover gets no suggestion
check(!view.suggestions.some(s => s.outSlot === 0), 'a fresh starter is not flagged for rotation');

// ── applyRotation: direct XI edit + validation ──────────────────────────────────────────────────
const lineupRow = () => (db.prepare('SELECT lineup FROM teams WHERE id = ?').get(teamId) as { lineup: string | null }).lineup;
check(lineupRow() === null, 'the XI starts as the identity (NULL) lineup');
const applied = rotation.applyRotation(teamId, 9, b11);
check(applied.ok && applied.lineup !== null, 'applyRotation swaps a starter for a bench player');
const after = rotation.getRotationView(teamId)!;
const aP = (slot: number) => after.players.find(p => p.slot === slot)!;
check(aP(b11).starter === true && aP(9).starter === false, 'after the swap the bench man starts and the tired man is benched');

check(!rotation.applyRotation(teamId, 9, 9).ok, 'cannot swap a player with himself');
check(!rotation.applyRotation(teamId, 999, b12).ok, 'cannot swap an out-of-range slot');
check(!rotation.applyRotation(teamId, b12, 9).ok, 'cannot bench a player who is not in the XI');   // b12 is bench
check(!rotation.applyRotation(teamId, 0, b11).ok, 'cannot bring in a player already in the XI (b11 now starts)');

// ── identity restore: swapping back yields the NULL (default) lineup again ───────────────────────
const back = rotation.applyRotation(teamId, b11, 9);
check(back.ok && back.lineup === null && lineupRow() === null, 'swapping back to the original XI restores the NULL identity lineup');

// ── the swap actually changes who is drained/risk-rolled (fitnessTick honours the custom XI) ────────
// Regression for the inverted-effect blocker: after benching a starter for a bench player, fitnessTick
// must drain the man who PLAYED (the rotated-in sub) and recover the one RESTED (the tired starter).
const leagueId2 = game.getTeamWithPlayers(teamId)!.leagueId;
db.prepare('UPDATE players SET fitness = 60, injured_matches = 0 WHERE team_id = ?').run(teamId);   // mid-condition, both directions visible
db.prepare('UPDATE players SET fitness = 100 WHERE team_id = ? AND slot = ?').run(teamId, b11);     // the fresh sub
rotation.applyRotation(teamId, 9, b11);   // bench slot 9, start bench b11 (both CF)
fitness.fitnessTick(leagueId2);
const fitOf = (slot: number) => (db.prepare('SELECT fitness AS f FROM players WHERE team_id = ? AND slot = ?').get(teamId, slot) as { f: number }).f;
check(fitOf(b11) < 100, 'the rotated-IN sub (who actually played) is drained, not rested');
check(fitOf(9) > 60, 'the rested starter (benched via the swap) recovers condition');
rotation.applyRotation(teamId, b11, 9);   // restore identity XI for the remaining checks

// ── physio mitigation tie-in ────────────────────────────────────────────────────────────────────
db.prepare('UPDATE players SET fitness = 50, injured_matches = 0 WHERE team_id = ? AND slot = ?').run(teamId, 9);
const noPhysioRisk = rotation.getRotationView(teamId)!.players.find(p => p.slot === 9)!.risk;
const worldId = (db.prepare('SELECT world_id AS w FROM leagues WHERE id = ?').get(game.getTeamWithPlayers(teamId)!.leagueId) as { w: number }).w;
db.prepare('INSERT INTO staff (world_id, team_id, role, name, rating, cost) VALUES (?,?,?,?,?,?)').run(worldId, teamId, 'physio', 'Doc', 90, 1);
const withPhysio = rotation.getRotationView(teamId)!;
check(withPhysio.physioMitigation === 15, 'a top physio reports a 15% risk mitigation');
check(withPhysio.players.find(p => p.slot === 9)!.risk < noPhysioRisk, 'a physio lowers every player’s shown risk');

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

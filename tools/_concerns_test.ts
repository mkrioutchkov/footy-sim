// Unsettled-player concerns test (§2.3 depth). Throwaway FOOTY_DB. Asserts the three concern kinds are
// detected from morale/ego/bench/contract, and the three manager responses move state correctly:
// reassure (morale up, once-per-match cooldown), accept (transfer-list + morale relief), reject (morale dent).
//
//   npx tsx tools/_concerns_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-cnc-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const concerns = await import('../web/backend/concerns.ts');

const u = registerUser('gaffer', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Unsettled FC', game.DEFAULT_TACTICS);

// slot 0: deeply unhappy starter (morale 20). slot 12: benched big ego (ego 85, morale 50).
// slot 1: running his deal down + unsettled (1y, morale 40). slot 5: explicitly settled. Rest = default.
const bigEgo = JSON.stringify({ traits: { ego: 85, praiseResponse: 70, temperament: 40 }, nationality: '', backstory: 'x', tagline: '' });
db.prepare('UPDATE players SET morale = 20 WHERE team_id = ? AND slot = 0').run(teamId);
db.prepare('UPDATE players SET morale = 50, personality = ? WHERE team_id = ? AND slot = 12').run(bigEgo, teamId);
db.prepare('UPDATE players SET morale = 40, contract_years = 1 WHERE team_id = ? AND slot = 1').run(teamId);
db.prepare('UPDATE players SET morale = 70 WHERE team_id = ? AND slot = 5').run(teamId);

// ── detection: the three kinds, nothing spurious ──────────────────────────────
const list = concerns.getConcerns(teamId);
const bySlot = (s: number) => list.find(c => c.slot === s);
check(bySlot(0)?.kind === 'unsettled', 'a deeply unhappy player is flagged unsettled');
check(bySlot(12)?.kind === 'benched_star', 'a benched big ego is flagged benched_star');
check(bySlot(1)?.kind === 'wantaway', 'a running-down-deal unsettled player is flagged wantaway');
check(list.length === 3, `exactly the three set-up players are concerns (got ${list.length})`);
check(list[0].slot === 0, 'most acute (lowest morale) leads the list');

// ── reassure: morale up, then a cooldown until the next match ──────────────────
const r1 = concerns.resolveConcern(teamId, 0, 'reassure');
check(r1.ok && (r1.moraleDelta ?? 0) > 0, `reassure lifts morale (+${r1.moraleDelta})`);
check((concerns.getConcerns(teamId).find(c => c.slot === 0)?.canReassure) === false, 'after reassuring, canReassure flips false');
const r1b = concerns.resolveConcern(teamId, 0, 'reassure');
check(!r1b.ok && /already had a word/.test(r1b.error ?? ''), 'a second reassure is blocked by the once-per-match cooldown');

// ── accept: transfer-list + morale relief, drops off the list ──────────────────
const r2 = concerns.resolveConcern(teamId, 1, 'accept');
check(r2.ok && r2.listed === true && (r2.moraleDelta ?? 0) > 0, 'accept lists the player + lifts morale (relief)');
check((db.prepare('SELECT listed FROM players WHERE team_id = ? AND slot = ?').get(teamId, 1) as { listed: number }).listed === 1, 'the player is persisted as listed');
check(concerns.getConcerns(teamId).every(c => c.slot !== 1), 'a listed player drops off the concerns list');

// ── reject: a morale dent, he stays ───────────────────────────────────────────
const r3 = concerns.resolveConcern(teamId, 12, 'reject');
check(r3.ok && (r3.moraleDelta ?? 0) < 0, `reject dents morale (${r3.moraleDelta})`);

// ── a settled player can't be acted on ────────────────────────────────────────
check(!concerns.resolveConcern(teamId, 5, 'reassure').ok, 'cannot reassure a settled player (no outstanding concern)');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

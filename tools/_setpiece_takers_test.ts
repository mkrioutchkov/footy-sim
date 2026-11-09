// Set-piece takers (user-watch). Throwaway FOOTY_DB; no engine. Asserts: the manager's designated FK/corner/
// pen/long-throw takers ride into the match spec as per-player directives (fk_taker | corner_taker | pen_taker
// | long_throw_taker) with the taker's resolved engine id (away +11); a taker who isn't in the fielded XI is
// dropped (engine falls back to default); and no takers set ⇒ no taker directives ⇒ byte-identical spec.
//
//   npx tsx tools/_setpiece_takers_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-spt-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const match = await import('../web/backend/match.ts');
const market = await import('../web/backend/market.ts');

const u = registerUser('setpiece', 'secret');
const { teamId } = game.newSeasonForUser(u.id, u.username, 'Dead Ball FC', game.DEFAULT_TACTICS);
const fxRow = db.prepare('SELECT id FROM fixtures WHERE (home_team_id = ? OR away_team_id = ?) AND played = 0 ORDER BY round, id LIMIT 1').get(teamId, teamId) as { id: number };
const fx = match.getFixture(fxRow.id)!;
const off = fx.home_team_id === teamId ? 0 : 11;   // away ids shift +11
const dirsOf = (spec: any) => (spec.directives ?? []) as { kind: string; playerId: number }[];
const setTakers = (t: unknown) => db.prepare('UPDATE teams SET set_piece_takers = ? WHERE id = ?').run(t == null ? null : JSON.stringify(t), teamId);

// ── stored + returned ─────────────────────────────────────────────────────────────────────────
setTakers({ fk: 2, corner: 8, pen: 10, longThrow: 4 });
const t = game.getTeamWithPlayers(teamId)!;
check(t.setPieceTakers?.fk === 2 && t.setPieceTakers?.corner === 8 && t.setPieceTakers?.pen === 10 && t.setPieceTakers?.longThrow === 4, 'takers persist + read back via getTeamWithPlayers');

// ── emitted as per-player directives with resolved engine ids ───────────────────────────────────
const dirs = dirsOf(match.buildSpec(fx));
check(dirs.find(d => d.kind === 'fk_taker')?.playerId === 2 + off, 'fk_taker emitted with the taker’s resolved engine id');
check(dirs.find(d => d.kind === 'corner_taker')?.playerId === 8 + off, 'corner_taker resolved');
check(dirs.find(d => d.kind === 'pen_taker')?.playerId === 10 + off, 'pen_taker resolved');
check(dirs.find(d => d.kind === 'long_throw_taker')?.playerId === 4 + off, 'long_throw_taker resolved');
check(dirs.filter(d => /_taker$/.test(d.kind)).length === 4, 'exactly the four set takers are emitted');

// ── a partial selection only emits the set ones ─────────────────────────────────────────────────
setTakers({ fk: 5, corner: null, pen: null, longThrow: null });
const partial = dirsOf(match.buildSpec(fx)).filter(d => /_taker$/.test(d.kind));
check(partial.length === 1 && partial[0].kind === 'fk_taker' && partial[0].playerId === 5 + off, 'only the designated taker is emitted; the rest stay on the engine default');

// ── a benched taker (not in the XI) is dropped ──────────────────────────────────────────────────
setTakers({ fk: 13, corner: null, pen: null, longThrow: null });   // slot 13 = bench (XI is 0-10)
check(!dirsOf(match.buildSpec(fx)).some(d => d.kind === 'fk_taker'), 'a benched taker (slot 13) is dropped — the engine falls back to its default pick');

// ── no takers ⇒ no taker directives ⇒ byte-identical spec ───────────────────────────────────────
setTakers(null);
check(!dirsOf(match.buildSpec(fx)).some(d => /_taker$/.test(d.kind)), 'no takers set ⇒ no taker directives (byte-identical spec)');

// ── a sale renumbers the squad → slot-keyed takers reset to default (no silent mis-target) ───────
setTakers({ fk: 2, corner: 8, pen: null, longThrow: null });
check(game.getTeamWithPlayers(teamId)!.setPieceTakers?.fk === 2, 'takers set before the sale');
market.removePlayerFromSquad(teamId, 14);   // drop a bench player → renumberSquad
check(game.getTeamWithPlayers(teamId)!.setPieceTakers === null, 'selling a player resets the takers to default (slots renumbered, like the lineup)');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

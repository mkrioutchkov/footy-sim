// Lineup compiler (buildLineup, the deterministic half — no network). Asserts the XI assignment over a
// 17-man squad: a pure shape change rearranges only the designated XI (slots 0-10, no bench surprise), the
// GK is pinned to slot 0, and a NAMED bench player (by name or initials) is brought in — closing the P1 gap
// where the compiler treated the squad as "11 players, no bench".
//
//   npx tsx tools/_lineup_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Squad } from '../web/backend/lineup.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-lineup-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');   // lineup.ts → game.ts → db.ts opens a DB on import

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { buildLineup } = await import('../web/backend/lineup.ts');

const SKILLS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina', 'height'];
const attrs = (over: Record<string, number> = {}) => ({ ...Object.fromEntries(SKILLS.map(k => [k, 60])), ...over });
// slots 0-10 = the XI (GK + 10 outfielders), slots 11-16 = the bench.
const squad: Squad = {
  players: [
    { name: 'Keeper One', role: 'GK', attrs: attrs() },
    { name: 'Right Back', role: 'FB', attrs: attrs() },
    { name: 'Centre Halfa', role: 'CB', attrs: attrs() },
    { name: 'Centre Halfb', role: 'CB', attrs: attrs() },
    { name: 'Left Back', role: 'FB', attrs: attrs() },
    { name: 'Midfield One', role: 'CM', attrs: attrs() },
    { name: 'Midfield Two', role: 'CM', attrs: attrs() },
    { name: 'Midfield Three', role: 'CM', attrs: attrs() },
    { name: 'Winger Right', role: 'WM', attrs: attrs() },
    { name: 'Winger Left', role: 'WM', attrs: attrs() },
    { name: 'Striker One', role: 'CF', attrs: attrs() },
    // bench (slot 11+)
    { name: 'Bench Striker', role: 'CF', attrs: attrs({ shooting: 90 }) },
    { name: 'Backup Keeper', role: 'GK', attrs: attrs() },
    { name: 'Reserve Mid', role: 'CM', attrs: attrs() },
    { name: 'Squad Defender', role: 'CB', attrs: attrs() },
    { name: 'Young Winger', role: 'WM', attrs: attrs() },
    { name: 'Fringe Full Back', role: 'FB', attrs: attrs() },
  ],
};

// ── a pure shape change rearranges ONLY the designated XI (no bench surprise) ──────────────────
const base = buildLineup(squad, '4-3-3', []);
check(base.formation === '4-3-3', 'keeps the requested shape');
check(base.slots.length === 11, 'fields exactly 11');
check(base.slots.every(s => s.fromSlot >= 0), 'every slot is filled');
check(base.slots.every(s => s.fromSlot < 11), 'a pure shape change uses only the designated XI (slots 0-10) — no bench player auto-benches a starter');
check(base.slots[0].fromSlot === 0 && base.slots[0].role === 'GK', 'the keeper is pinned to slot 0');

// ── a NAMED bench player is brought in (the closed P1 gap) ─────────────────────────────────────
const withBench = buildLineup(squad, null, [{ player: 'Bench Striker', role: 'CF', side: 'C' }]);
check(withBench.slots.some(s => s.fromSlot === 11), 'a named bench player (slot 11) is brought into the XI');
check(withBench.slots.filter(s => s.fromSlot >= 0).length === 11, 'still exactly 11 — the bench man displaces a starter, not adds a 12th');
check(withBench.slots.some(s => s.playerName === 'Bench Striker'), 'the bench striker appears in the XI by name');
check(withBench.slots[0].fromSlot === 0, 'the keeper stays pinned even with a bench override');

// ── resolve a bench player by INITIALS ────────────────────────────────────────────────────────
const byInits = buildLineup(squad, null, [{ player: 'YW', role: 'WM', side: 'L' }]);   // Young Winger, slot 15
check(byInits.slots.some(s => s.fromSlot === 15 && s.playerName === 'Young Winger'), 'a bench player resolves by initials (YW → Young Winger)');

// ── an unknown name is reported, not substituted ──────────────────────────────────────────────
const unknown = buildLineup(squad, null, [{ player: 'Nobody Here', role: 'CF', side: 'C' }]);
check(/no "nobody here"/i.test(unknown.note), 'an unknown name is flagged in the note');
check(unknown.slots.every(s => s.fromSlot < 11), 'an unknown override leaves the default XI intact');

// ── the keeper can\'t be dragged outfield by an override ───────────────────────────────────────
const dragGk = buildLineup(squad, '4-3-3', [{ player: 'Keeper One', role: 'CF', side: 'C' }]);
check(dragGk.slots[0].fromSlot === 0 && dragGk.slots[0].role === 'GK', 'an override cannot drag the keeper out of goal');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

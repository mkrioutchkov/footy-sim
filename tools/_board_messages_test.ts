// boardMessages test (pure presentation, §P2#7). Asserts the event-driven board comms: a last-result
// REACTION tone-scaled by the confidence band + the result margin, and a next-match EXPECTATION scaled
// by the relative league standing + the season objective + venue. boardMessages is pure (no DB), but
// confidence.ts pulls db.ts on import, so point FOOTY_DB at a throwaway file.
//   npx tsx tools/_board_messages_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-bm-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { boardMessages } = await import('../web/backend/confidence.ts');
const txt = (a: { text: string }[], i = 0): string => a[i]?.text ?? '';
const kind = (a: { kind: string }[], i = 0): string => a[i]?.kind ?? '';

// ── no tracked confidence → the board has no stance yet ──
check(boardMessages({ status: null, objectiveKind: null }).length === 0, 'no confidence → no messages');

// ── reaction: tone scales with confidence band + margin ──
const win3 = boardMessages({ status: 'stable', objectiveKind: null, lastResult: { outcome: 'W', gf: 4, ga: 0, opponent: 'Rovers' } });
check(kind(win3) === 'reaction' && /thrilled/.test(txt(win3)) && /4-0/.test(txt(win3)) && /Rovers/.test(txt(win3)), `a 4-0 win → thrilled, names score + opponent ("${txt(win3)}")`);
check(/pleased with the win/.test(txt(boardMessages({ status: 'secure', objectiveKind: null, lastResult: { outcome: 'W', gf: 2, ga: 1, opponent: 'City' } }))), 'a narrow win, secure board → pleased');
check(/welcome win/.test(txt(boardMessages({ status: 'shaky', objectiveKind: null, lastResult: { outcome: 'W', gf: 1, ga: 0, opponent: 'City' } }))), 'a win under pressure → welcome win, wants more');
check(/all three points/.test(txt(boardMessages({ status: 'at_risk', objectiveKind: null, lastResult: { outcome: 'D', gf: 1, ga: 1, opponent: 'United' } }))), 'a draw under pressure → wanted all three points');
check(/two points dropped/.test(txt(boardMessages({ status: 'stable', objectiveKind: null, lastResult: { outcome: 'D', gf: 0, ga: 0, opponent: 'United' } }))), 'a draw, stable board → two points dropped');
check(/blip/.test(txt(boardMessages({ status: 'secure', objectiveKind: null, lastResult: { outcome: 'L', gf: 0, ga: 1, opponent: 'Town' } }))), 'a loss, secure board → a blip, keeps faith');
check(/questioning your position/.test(txt(boardMessages({ status: 'at_risk', objectiveKind: null, lastResult: { outcome: 'L', gf: 0, ga: 2, opponent: 'Town' } }))), 'a loss, at-risk board → questioning your position');

// ── expectation: relative standing + objective + venue ──
const fav = boardMessages({ status: 'stable', objectiveKind: null, nextMatch: { opponent: 'Strugglers', home: true, myPos: 3, oppPos: 15 } });
check(kind(fav) === 'expectation' && /see off Strugglers at home/.test(txt(fav)), `clear favourite at home → expects to see off ("${txt(fav)}")`);
check(/settle for a point away/.test(txt(boardMessages({ status: 'stable', objectiveKind: 'top_half', nextMatch: { opponent: 'Leaders', home: false, myPos: 14, oppPos: 1 } }))), 'big underdog away → would settle for a point');
check(/statement result/.test(txt(boardMessages({ status: 'stable', objectiveKind: 'title', nextMatch: { opponent: 'Leaders', home: false, myPos: 6, oppPos: 1 } }))), 'a title-chaser facing a higher team → wants a statement result');
check(/Every point counts/.test(txt(boardMessages({ status: 'shaky', objectiveKind: 'survival', nextMatch: { opponent: 'Leaders', home: false, myPos: 18, oppPos: 2 } }))), 'survival fight, tough away game → every point counts');
const close = boardMessages({ status: 'stable', objectiveKind: null, nextMatch: { opponent: 'Rivals', home: true, myPos: 8, oppPos: 9 } });
check(/close one at home against Rivals/.test(txt(close)) && /positive result/.test(txt(close)), `evenly matched → wants a positive result ("${txt(close)}")`);

// ── both together: reaction THEN expectation ──
const both = boardMessages({ status: 'stable', objectiveKind: null,
  lastResult: { outcome: 'W', gf: 2, ga: 0, opponent: 'A' }, nextMatch: { opponent: 'B', home: true, myPos: 5, oppPos: 6 } });
check(both.length === 2 && kind(both, 0) === 'reaction' && kind(both, 1) === 'expectation', 'returns both, reaction first then expectation');

const { db } = await import('../web/backend/db.ts');
db.close();   // release the sqlite handle confidence.ts opened on import (Windows locks the file otherwise)
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort; OS temp dir */ }
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

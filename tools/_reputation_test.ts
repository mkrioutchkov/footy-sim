// managerReputation test (pure synthesis, §P2#9). Asserts the reputation TIER the career CV maps to:
// silverware dominates, promotions / objectives / win% / longevity layer on, relegations dent it; a
// manager with no completed seasons is unproven. Pure (no DB), but career.ts pulls db.ts on import, so
// point FOOTY_DB at a throwaway file.
//   npx tsx tools/_reputation_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ManagerCareer } from '../web/backend/career.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-rep-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { managerReputation } = await import('../web/backend/career.ts');
const cv = (o: Partial<ManagerCareer>): ManagerCareer => ({
  clubs: 1, seasons: 0, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0, winPct: 50,
  titles: 0, promotions: 0, relegations: 0, cups: 0, objectivesMet: 0, objectivesSet: 0, bestFinish: null, spells: [], ...o,
});

// ── tiers from the CV ──
check(managerReputation(cv({ seasons: 0 })).tier === 'unproven', 'a fresh manager (0 seasons) → unproven');
check(/fresh face/.test(managerReputation(cv({ seasons: 0 })).blurb), 'the 0-season blurb is the fresh-face one');
check(managerReputation(cv({ seasons: 0 })).label === 'Unproven', 'the label matches the tier');
check(managerReputation(cv({ seasons: 2, winPct: 44 })).tier === 'unproven', 'a couple of mediocre seasons, no silverware → still unproven');
check(managerReputation(cv({ seasons: 3, promotions: 1, winPct: 50 })).tier === 'promising', 'a first promotion → promising');
check(managerReputation(cv({ seasons: 4, titles: 1, winPct: 50 })).tier === 'respected', 'a league title → respected');
check(managerReputation(cv({ seasons: 6, titles: 2, winPct: 55 })).tier === 'renowned', 'two titles + a good win rate → renowned');
check(managerReputation(cv({ seasons: 8, titles: 4, cups: 1, winPct: 60 })).tier === 'elite', 'four titles + a cup → elite');
check(managerReputation(cv({ seasons: 12, titles: 6, cups: 3, winPct: 65, objectivesMet: 5 })).tier === 'legendary', 'a trophy-laden CV → legendary');

// ── the score reacts the right way ──
check(managerReputation(cv({ seasons: 5, titles: 2 })).score > managerReputation(cv({ seasons: 5, titles: 0 })).score, 'titles raise the score');
check(managerReputation(cv({ seasons: 8, titles: 4, winPct: 60, relegations: 3 })).score < managerReputation(cv({ seasons: 8, titles: 4, winPct: 60 })).score, 'relegations dent the score');
check(managerReputation(cv({ seasons: 8, titles: 4, winPct: 70 })).score > managerReputation(cv({ seasons: 8, titles: 4, winPct: 40 })).score, 'a stronger win rate raises the score');

const { db } = await import('../web/backend/db.ts');
db.close();   // release the sqlite handle career.ts opened on import (Windows locks the file otherwise)
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort; OS temp dir */ }
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

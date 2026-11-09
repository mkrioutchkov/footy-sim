// Manager-career aggregate test. Throwaway FOOTY_DB. Seeds season_history rows across TWO clubs for one
// user (a career spanning a move) + asserts getManagerCareer rolls them up correctly.
//
//   npx tsx tools/_career_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-car-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const career = await import('../web/backend/career.ts');

const u = registerUser('gaffer', 'secret');
const r1 = game.newSeasonForUser(u.id, u.username, 'First Club', game.DEFAULT_TACTICS);
const r2 = game.newSeasonForUser(u.id, u.username, 'Second Club', game.DEFAULT_TACTICS);   // a later club (a sacked manager moves on)

const ins = db.prepare(`INSERT INTO season_history (team_id, season, tier, division, position, played, won, drawn, lost, gf, ga, points, champion, promoted, relegated, cup_won, objective_kind, objective_met, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
ins.run(r1.teamId, 1, 2, 'Division 2', 2, 38, 20, 8, 10, 60, 40, 68, 0, 1, 0, 0, 'promotion', 1, 0);   // promoted, obj met
ins.run(r1.teamId, 2, 1, 'Division 1', 1, 38, 26, 6, 6, 80, 30, 84, 1, 0, 0, 1, 'top_half', 1, 0);     // champion + cup, obj met
ins.run(r2.teamId, 3, 1, 'Division 1', 10, 38, 12, 8, 18, 45, 60, 44, 0, 0, 0, 0, 'top_half', 0, 0);    // mid-table, obj missed

const c = career.getManagerCareer(u.id);
check(c.seasons === 3, `3 seasons aggregated (got ${c.seasons})`);
check(c.clubs === 2, `2 clubs managed (got ${c.clubs})`);
check(c.played === 114 && c.won === 58 && c.drawn === 22 && c.lost === 34, `P/W/D/L summed (got ${c.played}/${c.won}/${c.drawn}/${c.lost})`);
check(c.points === 196 && c.gf === 185 && c.ga === 130, `points/gf/ga summed (got ${c.points}/${c.gf}/${c.ga})`);
check(c.winPct === Math.round(58 / 114 * 100), `winPct = won/played (got ${c.winPct})`);
check(c.titles === 1 && c.promotions === 1 && c.cups === 1 && c.relegations === 0, `trophies: 1 title, 1 promo, 1 cup, 0 releg`);
check(c.objectivesSet === 3 && c.objectivesMet === 2, `objectives 2/3 met (got ${c.objectivesMet}/${c.objectivesSet})`);
check(c.bestFinish?.position === 1 && c.bestFinish?.season === 2, `best finish = 1st in season 2`);
check(c.spells.length === 2 && c.spells[0].team === 'Second Club', `2 spells, most-recent club first (got ${c.spells[0]?.team})`);
check(c.spells.find(s => s.team === 'First Club')?.titles === 1, 'the First Club spell carries its title');

// a manager with a club but no completed seasons → an empty career
const u2 = registerUser('rookie', 'secret');
game.newSeasonForUser(u2.id, u2.username, 'Rookie FC', game.DEFAULT_TACTICS);
const empty = career.getManagerCareer(u2.id);
check(empty.seasons === 0 && empty.clubs === 0 && empty.winPct === 0 && empty.bestFinish === null, 'no completed seasons → empty career');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

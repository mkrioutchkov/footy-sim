// Manual captain test (audit §2.11, no engine, no LLM). Captain resolution (manual slot overrides the
// auto highest-leadership pick), persistence via getTeamWithPlayers, and the moraleTick steadying effect
// (a strong captain lifts morale, a poor one drags it, neutral/no-captain is exactly identity).
//
//   npx tsx tools/_captain_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-captain-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const morale = await import('../web/backend/morale.ts');

const u = registerUser('skipper', 'secret');
const { leagueId, teamId } = game.newSeasonForUser(u.id, u.username, 'Captain FC', game.DEFAULT_TACTICS);
const moraleAll = () => (db.prepare('SELECT morale FROM players WHERE team_id = ?').all(teamId) as { morale: number }[]).map(r => r.morale);
const setLead = (slot: number, lead: number) => db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?').run(JSON.stringify({ traits: { leadership: lead } }), teamId, slot);
const setAllLead = (lead: number) => db.prepare('UPDATE players SET personality = ? WHERE team_id = ?').run(JSON.stringify({ traits: { leadership: lead } }), teamId);

// ── captain resolution ──────────────────────────────────────────────────────────────────────────
check(morale.captainLeadership(teamId) === 50, 'no personality dials → neutral captain leadership (no effect)');
setLead(3, 90); setLead(5, 70);
check(morale.captainLeadership(teamId) === 90, 'auto-captain = the highest-leadership player');
db.prepare('UPDATE teams SET captain_slot = ? WHERE id = ?').run(5, teamId);
check(morale.captainLeadership(teamId) === 70, 'a manually-set captain overrides the auto pick (even if lower-rated)');
check(game.getTeamWithPlayers(teamId)!.captainSlot === 5, 'the chosen captain persists on the team');
db.prepare('UPDATE teams SET captain_slot = NULL WHERE id = ?').run(teamId);
check(morale.captainLeadership(teamId) === 90 && game.getTeamWithPlayers(teamId)!.captainSlot === null, 'clearing the captain returns to auto (highest leadership)');

// ── moraleTick steadying effect (no played fixture this tick → result delta is 0, isolating the bonus) ──
setAllLead(90);   // a strong leader leads the room
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(leagueId);
check(moraleAll().every(m => m === 52), `a strong captain (lead 90) lifts morale +2 (got ${moraleAll()[0]})`);

setAllLead(50);   // a neutral captain
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(leagueId);
check(moraleAll().every(m => m === 50), 'a neutral captain (lead 50) has no morale effect — identity');

setAllLead(0);   // a poor "leader"
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(leagueId);
check(moraleAll().every(m => m === 48), 'a poor leader (lead 0) drags the room −2');

// ── the bonus is capped, and stacks with a result delta ──────────────────────────────────────────
setAllLead(100);
const fx = db.prepare('SELECT id, home_team_id FROM fixtures WHERE league_id = ? AND (home_team_id = ? OR away_team_id = ?) LIMIT 1').get(leagueId, teamId, teamId) as { id: number; home_team_id: number };
const home = fx.home_team_id === teamId;
db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?').run(home ? 3 : 0, home ? 0 : 3, fx.id);   // a win (+8)
db.prepare('UPDATE players SET morale = 50 WHERE team_id = ?').run(teamId);
morale.moraleTick(leagueId);
check(moraleAll().every(m => m === 60), `a max captain (+2, capped) stacks on a win (+8): 50→60 (got ${moraleAll()[0]})`);

// ── done ─────────────────────────────────────────────────────────────────────────────────────────
db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

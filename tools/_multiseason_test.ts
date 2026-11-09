// Multi-season integration test: drive a world through many rollovers (no engine — fixtures
// are force-played) and assert the whole loop stays sound over time. Catches emergent issues
// the per-pillar tests can't: squads drifting out of [11,24], the match-spec 11-invariant
// breaking, fixtures not regenerating, budgets going negative, or the world wedging.
//
//   npx tsx tools/_multiseason_test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-ms-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const season = await import('../web/backend/season.ts');
const market = await import('../web/backend/market.ts');

const xiCount = (teamId: number) => game.getTeamWithPlayers(teamId)!.players.slice(0, 11).length;
function playAll(leagueId: number): void {
  const fxs = db.prepare('SELECT id, home_team_id, away_team_id FROM fixtures WHERE league_id = ? AND played = 0').all(leagueId) as { id: number; home_team_id: number; away_team_id: number }[];
  const upd = db.prepare('UPDATE fixtures SET played = 1, home_score = ?, away_score = ? WHERE id = ?');
  for (const f of fxs) { const hw = f.home_team_id < f.away_team_id; upd.run(hw ? 2 : 0, hw ? 0 : 2, f.id); }
}

const u = registerUser('dynasty', 'secret');
const { worldId } = game.newSeasonForUser(u.id, u.username, 'Dynasty FC', game.DEFAULT_TACTICS);
const leagueIds = season.worldLeagues(worldId).map(l => l.id);   // the two divisions are stable across seasons
check(leagueIds.length === 2, 'world has two persistent divisions');

const SEASONS = 8;
for (let s = 1; s <= SEASONS; s++) {
  for (const id of leagueIds) playAll(id);
  check(season.seasonComplete(worldId), `season ${s} completes after all fixtures are played`);
  const ro = season.rolloverSeason(worldId);
  if (!ro) { check(false, `season ${s} rolled over`); break; }

  // every club in the world stays a legal squad with exactly 11 startable players
  const teams = db.prepare('SELECT id FROM teams WHERE league_id IN (?, ?)').all(leagueIds[0], leagueIds[1]) as { id: number }[];
  check(teams.length === 16, `the world still has 16 clubs after season ${s} (got ${teams.length})`);
  const sizes = teams.map(t => (db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ?').get(t.id) as { n: number }).n);
  check(sizes.every(n => n >= market.SQUAD_MIN && n <= market.SQUAD_MAX), `all squads in [11,24] after season ${s} (range ${Math.min(...sizes)}..${Math.max(...sizes)})`);
  check(teams.every(t => xiCount(t.id) === 11), `every club fields exactly 11 after season ${s}`);

  // fixtures regenerated for the new season; budgets never negative; pool bounded
  for (const id of leagueIds) {
    const unplayed = (db.prepare('SELECT COUNT(*) AS n FROM fixtures WHERE league_id = ? AND played = 0').get(id) as { n: number }).n;
    check(unplayed === 56, `division fixtures regenerated to 56 for season ${s} (got ${unplayed})`);
    const fa = (db.prepare('SELECT COUNT(*) AS n FROM free_agents WHERE league_id = ?').get(id) as { n: number }).n;
    check(fa >= game.FREE_AGENT_COUNT && fa < game.FREE_AGENT_COUNT + 40, `free-agent pool bounded for season ${s} (got ${fa})`);
  }
  check(teams.every(t => (db.prepare('SELECT budget AS b FROM teams WHERE id = ?').get(t.id) as { b: number }).b >= 0), `no negative budgets after season ${s}`);
  // contracts never wedge into deep-negative territory (renewed/released each season)
  const minContract = (db.prepare('SELECT MIN(contract_years) AS c FROM players WHERE team_id IN (?, ?)').get(leagueIds[0], leagueIds[1]) as { c: number }).c;
  check(minContract >= 0, `no player stuck on a deep-negative contract after season ${s} (min ${minContract})`);
}

const finalSeason = (db.prepare('SELECT season AS s FROM leagues WHERE id = ?').get(worldId) as { s: number }).s;
check(finalSeason === SEASONS + 1, `reached season ${SEASONS + 1} (got ${finalSeason})`);
// the world evolved: at least some clubs have players who came through / aged on
const ages = db.prepare('SELECT age FROM players WHERE team_id IN (?, ?)').all(leagueIds[0], leagueIds[1]) as { age: number }[];
check(ages.some(a => a.age <= 20) && ages.some(a => a.age >= 30), 'after several seasons the world has both youth and experience');

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed (${SEASONS} seasons simulated)`);
process.exit(fail === 0 ? 0 : 1);

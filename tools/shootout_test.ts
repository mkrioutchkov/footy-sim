// Hermetic regression coverage for the web-layer knockout resolver.
// Run: npx tsx tools/shootout_test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { simulatePenaltyShootout, MAX_SHOOTOUT_SCORE, type ShootoutPlayer } from '../web/backend/shootout.ts';

const player = (shooting = 65, positioning = 65, role = 'CM'): ShootoutPlayer => ({ role, attrs: { shooting, positioning } });
const squad = (shooting = 65, keeperPositioning = 65): ShootoutPlayer[] => [
  player(20, keeperPositioning, 'GK'),
  ...Array.from({ length: 10 }, () => player(shooting, 65)),
];

const even = squad(72, 74), strong = squad(92, 70), weak = squad(38, 70);
const snapshot = JSON.stringify([even, strong, weak]);
const first = simulatePenaltyShootout(12345, strong, even);
assert.deepEqual(simulatePenaltyShootout(12345, strong, even), first, 'same seed and XIs must replay exactly');
assert.notEqual(first.home, first.away, 'shootout must produce a winner');
assert.equal(JSON.stringify([even, strong, weak]), snapshot, 'resolver must not mutate either XI');

let earlyFinish = false, identicalHomeWins = 0, strongWins = 0;
let goalsVsWeakKeeper = 0, goalsVsStrongKeeper = 0;
const weakKeeper = squad(65, 30), strongKeeper = squad(65, 95);
for (let seed = 1; seed <= 5000; seed++) {
  const level = simulatePenaltyShootout(seed, even, even);
  assert.notEqual(level.home, level.away, `seed ${seed} returned a tied shootout`);
  assert(level.home <= MAX_SHOOTOUT_SCORE && level.away <= MAX_SHOOTOUT_SCORE, 'bounded sudden death exceeded its safety limit');
  if ((level.home === 3 && level.away === 0) || (level.home === 0 && level.away === 3)) earlyFinish = true;
  if (level.home > level.away) identicalHomeWins++;

  if (simulatePenaltyShootout(seed, strong, weak).home > simulatePenaltyShootout(seed, strong, weak).away) strongWins++;
  if (simulatePenaltyShootout(seed, weak, strong).away > simulatePenaltyShootout(seed, weak, strong).home) strongWins++;
  goalsVsWeakKeeper += simulatePenaltyShootout(seed, strong, weakKeeper).home;
  goalsVsStrongKeeper += simulatePenaltyShootout(seed, strong, strongKeeper).home;
}
assert(earlyFinish, 'best-of-five should stop once a side has clinched');
assert(identicalHomeWins > 2250 && identicalHomeWins < 2750, `identical XIs show a home bias (${identicalHomeWins}/5000)`);
assert(strongWins > 6500, `stronger takers should win clearly more often (${strongWins}/10000)`);
assert(goalsVsWeakKeeper > goalsVsStrongKeeper + 500, 'the opposing keeper positioning must materially affect conversion');

const emergencyWeak = [player(20, 25, 'CF'), player(20, 95, 'GK'), ...squad(45, 50).slice(2)];
const emergencyStrong = [player(20, 95, 'CF'), player(20, 25, 'GK'), ...squad(45, 50).slice(2)];
let goalsVsSlotZeroWeak = 0, goalsVsSlotZeroStrong = 0;
for (let seed = 1; seed <= 1500; seed++) {
  goalsVsSlotZeroWeak += simulatePenaltyShootout(seed, strong, emergencyWeak).home;
  goalsVsSlotZeroStrong += simulatePenaltyShootout(seed, strong, emergencyStrong).home;
}
assert(goalsVsSlotZeroWeak > goalsVsSlotZeroStrong, 'formation slot 0, not a later GK-labelled player, must keep goal');
assert.notEqual(simulatePenaltyShootout(Number.NaN, [], []).home, simulatePenaltyShootout(Number.NaN, [], []).away, 'empty/malformed inputs must still resolve safely');

// Start with the old cup schema, then import db.ts: its lightweight migration must add pen columns.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-shootout-'));
const dbPath = path.join(tmp, 'legacy.sqlite');
const legacy = new DatabaseSync(dbPath);
legacy.exec(`CREATE TABLE cup_ties (
  id INTEGER PRIMARY KEY AUTOINCREMENT, world_id INTEGER NOT NULL, season INTEGER NOT NULL,
  round INTEGER NOT NULL, slot INTEGER NOT NULL, home_team_id INTEGER, away_team_id INTEGER,
  seed INTEGER NOT NULL, played INTEGER NOT NULL DEFAULT 0, home_score INTEGER, away_score INTEGER,
  winner_team_id INTEGER
)`);
legacy.close();
process.env.FOOTY_DB = dbPath;

const { db } = await import('../web/backend/db.ts');
try {
  const columns = (db.prepare('PRAGMA table_info(cup_ties)').all() as { name: string }[]).map(c => c.name);
  assert(columns.includes('home_pens') && columns.includes('away_pens'), 'legacy cup table was not migrated');

  const leagueId = Number(db.prepare("INSERT INTO leagues (name, season, status) VALUES ('Test', 1, 'running')").run().lastInsertRowid);
  const addTeam = db.prepare("INSERT INTO teams (league_id, name, manager, tactics, created_at) VALUES (?, ?, 'AI', '{}', 0)");
  const homeId = Number(addTeam.run(leagueId, 'Home FC').lastInsertRowid);
  const awayId = Number(addTeam.run(leagueId, 'Away FC').lastInsertRowid);
  const insertTie = db.prepare(`INSERT INTO cup_ties
    (world_id, season, round, slot, home_team_id, away_team_id, seed, played, home_score, away_score, home_pens, away_pens, winner_team_id)
    VALUES (?, 1, 1, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);

  const cup = await import('../web/backend/cup.ts');
  const playedTieId = Number(insertTie.run(leagueId, homeId, awayId, 200, 1, 1, 2, 4, null).lastInsertRowid); // parity says home; real pens say away
  const decided = cup.advanceCupRound(leagueId, 1);
  assert.equal(decided?.champion, awayId, 'persisted shootout must override the old parity tie-break');
  const view = cup.cupView(leagueId).rounds[0].ties[0];
  assert.equal(view.homePens, 2); assert.equal(view.awayPens, 4); assert.equal(view.winnerTeamId, awayId);
  const mine = cup.cupTieFor(awayId, leagueId, 1);
  assert.deepEqual({ home: mine?.homePens, away: mine?.awayPens, won: mine?.won }, { home: 2, away: 4, won: true });
  const { playCupTie } = await import('../web/backend/match.ts');
  const replay = await playCupTie(playedTieId);
  assert.deepEqual({ already: replay.alreadyPlayed, home: replay.homePens, away: replay.awayPens }, { already: true, home: 2, away: 4 }, 'already-played cup tie must return its stored shootout');

  db.prepare('DELETE FROM cup_ties').run();
  insertTie.run(leagueId, homeId, awayId, 200, 0, 0, null, null, awayId); // preserve an old recorded winner
  assert.equal(cup.advanceCupRound(leagueId, 1)?.champion, awayId, 'retry must preserve a persisted legacy winner');

  db.prepare('DELETE FROM cup_ties').run();
  insertTie.run(leagueId, homeId, awayId, 200, 0, 0, null, null, null); // unadvanced legacy draw
  assert.equal(cup.advanceCupRound(leagueId, 1)?.champion, homeId, 'legacy null-pens draw must retain seed parity');

  const { assembleInboxItems } = await import('../web/backend/inbox.ts');
  const inboxBag = {
    teamId: awayId, myResult: null, myFixtureId: null, myHome: null, myOpponent: '', income: 0, developed: 0,
    injuries: [], transfers: [], incomingBids: [], faOffers: [], listingsExpired: [], contractOffers: [], rollover: null,
    cup: { champion: null, myTie: { homeScore: 1, awayScore: 1, homePens: 2, awayPens: 4, opponent: 'Home FC', won: true } },
  } satisfies Parameters<typeof assembleInboxItems>[0];
  const items = assembleInboxItems(inboxBag);
  assert(items.some(i => i.text.includes('won 4–2 on penalties')), 'inbox must expose the exact shootout result');
  const championItems = assembleInboxItems({ ...inboxBag, cup: { ...inboxBag.cup, champion: awayId } });
  assert(championItems.some(i => i.text.includes('You won the Cup!') && i.text.includes('won 4–2 on penalties')), 'cup-winning inbox item must retain the final shootout result');
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log('shootout tests: ok');

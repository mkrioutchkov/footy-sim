// tools/_training_test.ts — engine-free regression for web/backend/training.ts (pillar 2:
// training / development). Recreated from the GAME_LAYER_NOTES.md ledger entry:
//
//   "Verified by tools/_training_test.ts (25 assertions: convergence, decline, focus,
//    diligence, clamp, backfill, tick, signing-carries-potential)"
//
// Each assertion group quotes the ledger claim it covers. Pure developAttrs behaviour is
// asserted EXACTLY (the ledger: "Deterministic given (attrs, age, potential, traits, focus)
// — no RNG, so a test can assert exact post-tick values"); rows produced with Math.random
// (seeded rosters, genPotential headroom, free agents) are asserted by bounds instead.
//
// Run: cd <repo> && npx tsx tools/_training_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run — web/backend/data/ is never touched.

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// db.ts resolves FOOTY_DB at IMPORT time, so point it at a scratch file BEFORE any backend
// module loads — which is why every backend import below is a dynamic import.
const TESTDB_DIR = '/tmp/claude-0/-home-user-footy-sim/710ecd1a-f780-5b5f-a4ef-27543513423b/scratchpad/testdb';
mkdirSync(TESTDB_DIR, { recursive: true });
const DB_PATH = path.join(TESTDB_DIR, `training_${process.pid}_${Date.now()}.sqlite`);
process.env.FOOTY_DB = DB_PATH;

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const training = await import('../web/backend/training.ts');
const market = await import('../web/backend/market.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

// The 7 outfield trainables (TRAINABLE minus the keeper-only 'handling').
const OUTFIELD = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'] as const;
function attrsAll(v: number): Record<string, number> {
  return { speed: v, passing: v, creativity: v, shooting: v, tackling: v, positioning: v, stamina: v, handling: v, height: 55 };
}
const trainablesEqual = (a: Record<string, number>, b: Record<string, number>): boolean =>
  training.TRAINABLE.every(k => a[k] === b[k]);

try {
  // ── CONVERGENCE ─────────────────────────────────────────────────────────────
  // Ledger: "attrs drift toward potential ... growth caps at potential" / "each player's
  // attrs drift toward potential, deterministically".
  // Age 19 (drift 1.5), neutral traits (diligence 1.0), morale 65 (factor 1.0), balanced.
  const base = attrsAll(60);
  const one = training.developAttrs(base, 19, 70, null, 'balanced', 65, 1, 1, 'CM');
  assert(OUTFIELD.every(k => one[k] === 61.5), `one balanced tick at 19 moves every outfield trainable 60 -> 61.5, got ${JSON.stringify(one)}`);
  assert(one.handling === 60, 'handling is keeper-only: an outfielder\'s handling does not train');
  assert(one.height === 55, 'height is not trainable and never moves');
  assert(base.passing === 60 && base.handling === 60, 'developAttrs is pure — the input attrs object is not mutated');
  const gk = training.developAttrs(attrsAll(60), 19, 90, null, 'balanced', 65, 1, 1, 'GK');
  assert(gk.handling === 61.5, 'a keeper DOES train handling (the GK gate)');

  let cur = attrsAll(60);
  let monotone = true, capped = true;
  for (let i = 0; i < 40; i++) {
    const next = training.developAttrs(cur, 19, 70, null, 'balanced', 65, 1, 1, 'CM');
    if (game.overall(next, 'CM') < game.overall(cur, 'CM')) { monotone = false; }
    if (game.overall(next, 'CM') > 70) { capped = false; }
    cur = next;
  }
  assert(monotone, 'convergence: overall climbs monotonically toward potential');
  assert(capped, 'convergence: overall never blows past the potential ceiling');
  assert(game.overall(cur, 'CM') === 70, `convergence: the fixed point sits exactly at potential (got ${game.overall(cur, 'CM')})`);
  const again = training.developAttrs(cur, 19, 70, null, 'balanced', 65, 1, 1, 'CM');
  assert(trainablesEqual(again, cur), 'at potential (zero headroom) a further tick is a no-op');

  // ── DECLINE ─────────────────────────────────────────────────────────────────
  // Ledger: "the legs fade first with age ... decline floors at 30" / "decline ignores
  // headroom and hits the legs hardest".
  const vet = training.developAttrs(attrsAll(60), 35, 70, null, 'balanced', 65, 1, 1, 'CM');
  assert(vet.passing === 58.8 && vet.shooting === 58.8, `decline at 34+: technical attrs drop 1.2/matchday even with headroom left (got passing ${vet.passing})`);
  assert(vet.speed === 58.1 && vet.stamina === 58.1, `legs go first: speed/stamina decline 1.6x (got speed ${vet.speed})`);
  const vetBoosted = training.developAttrs(attrsAll(60), 35, 70, null, 'balanced', 65, 1.30, 1.06, 'CM', 1.4, 1, 1);
  assert(trainablesEqual(vetBoosted, vet), 'coach/harmony/intensity multipliers accelerate growth only — decline is untouched');
  const peak = training.developAttrs(attrsAll(60), 29, 90, null, 'balanced', 65, 1, 1, 'CM');
  assert(OUTFIELD.every(k => peak[k] === 60), 'plateau: ages 28-30 hold perfectly flat (drift 0)');
  // NOTE: the notes' pillar-2 sketch says "plateau 24-29"; the shipped curve grows 0.5/matchday
  // through 27 and plateaus 28-30. Assert the CODE's behaviour (finding reported by this test).
  const age24 = training.developAttrs(attrsAll(60), 24, 90, null, 'balanced', 65, 1, 1, 'CM');
  assert(age24.passing === 60.5, `ages 24-27 still grow at 0.5/matchday (got ${age24.passing})`);

  // ── FOCUS ───────────────────────────────────────────────────────────────────
  // Ledger: "the focus attr trains ~80% faster" / "the team training_focus attribute gets
  // an extra nudge" (audit §2.7 adds the 'position' focus that spreads the same bonus).
  const foc = training.developAttrs(attrsAll(60), 19, 90, null, 'shooting', 65, 1, 1, 'CF');
  assert(foc.shooting === 62.7, `the focus attribute trains 1.8x: shooting 60 -> 62.7 (got ${foc.shooting})`);
  assert(foc.passing === 61.5 && foc.speed === 61.5, 'non-focus attributes keep their full 1.0x move');
  const vetFoc = training.developAttrs(attrsAll(60), 35, 70, null, 'shooting', 65, 1, 1, 'CF');
  assert(vetFoc.shooting === vetFoc.passing, 'a focus boosts growth only — it never reshapes decline');
  const pos = training.developAttrs(attrsAll(60), 19, 90, null, 'position', 65, 1, 1, 'CF');
  assert(pos.shooting === 61.9 && pos.speed === 61.9 && pos.creativity === 61.9, `'position' focus: a CF's key attrs each take 1 + 0.8/3 of the move (got shooting ${pos.shooting})`);
  assert(pos.tackling === 61.5 && pos.passing === 61.5, "'position' focus: non-key attrs keep their full 1.0x move (never clawed back)");
  const gained = (a: Record<string, number>): number => Math.round(OUTFIELD.reduce((s, k) => s + (a[k] - 60), 0) * 10) / 10;
  assert(gained(pos) === gained(foc), `single-attr and 'position' focus deliver the same total bonus, distributed differently (${gained(foc)} vs ${gained(pos)})`);
  const noRole = training.developAttrs(attrsAll(60), 19, 90, null, 'position', 65, 1, 1, undefined);
  assert(OUTFIELD.every(k => noRole[k] === 61.5), "'position' focus with an unknown role degrades to identity weighting");

  // ── DILIGENCE ───────────────────────────────────────────────────────────────
  // Ledger: "scaled by age + professionalism/consistency" (diligence 0.6..1.4).
  const pro = training.developAttrs(attrsAll(60), 19, 90, { professionalism: 100, consistency: 100 }, 'balanced', 65, 1, 1, 'CM');
  const slack = training.developAttrs(attrsAll(60), 19, 90, { professionalism: 0, consistency: 0 }, 'balanced', 65, 1, 1, 'CM');
  assert(pro.passing === 62.1, `a model professional grows 1.4x: 1.5 -> 2.1/matchday at 19 (got ${pro.passing})`);
  assert(slack.passing === 60.9, `a slacker grows 0.6x: 1.5 -> 0.9/matchday at 19 (got ${slack.passing})`);
  assert(slack.passing < one.passing && one.passing < pro.passing, 'traits order the growth rate: slacker < neutral < professional');
  const proVet = training.developAttrs(attrsAll(60), 35, 70, { professionalism: 100, consistency: 100 }, 'balanced', 65, 1, 1, 'CM');
  assert(proVet.passing === 58.3, `current behaviour: diligence multiplies DECLINE too — a diligent veteran fades 1.68/matchday (got ${proVet.passing})`);

  // ── CLAMP ───────────────────────────────────────────────────────────────────
  // Ledger: "growth caps at potential, decline floors at 30" — plus the hard 30..95
  // per-attribute clamp in developAttrs.
  const ceil = training.developAttrs(attrsAll(94), 19, 99, null, 'balanced', 65, 1, 1, 'CM');
  assert(OUTFIELD.every(k => ceil[k] === 95), 'growth clamps at the 95 attribute ceiling');
  let floor = attrsAll(31);
  for (let i = 0; i < 12; i++) { floor = training.developAttrs(floor, 35, 70, null, 'balanced', 65, 1, 1, 'CM'); }
  assert(OUTFIELD.every(k => floor[k] === 30), 'decline floors at 30 exactly and stays there tick after tick');

  // ── DB fixtures for the backfill / tick / signing groups ────────────────────
  const leagueId = Number(db.prepare("INSERT INTO leagues (name, season, status) VALUES ('Training Test League', 1, 'running')").run().lastInsertRowid);
  const userId = Number(db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('trainer_test', 'x', 'x', 0)").run().lastInsertRowid);
  const humanTeamId = game.createTeam({ leagueId, userId, name: 'Human FC', manager: 'Tester', tactics: game.DEFAULT_TACTICS, base: 60 });
  const aiTeamId = game.createTeam({ leagueId, userId: null, name: 'AI FC', manager: 'AI', tactics: game.DEFAULT_TACTICS, base: 60 });
  const insP = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential) VALUES (?, ?, ?, ?, ?, ?, ?)');

  // ── BACKFILL ────────────────────────────────────────────────────────────────
  // Ledger: "players.potential (youth-weighted ceiling, backfilled for old saves)" /
  // "Backfill potential for players + free agents ... Idempotent — only touches NULL rows".
  const midId = Number(insP.run(humanTeamId, 23, 'Backfill Mid', 'CM', JSON.stringify(attrsAll(50)), 24, null).lastInsertRowid);
  const oldId = Number(insP.run(humanTeamId, 24, 'Backfill Old', 'CM', JSON.stringify(attrsAll(62)), 30, null).lastInsertRowid);
  const faId = Number(db.prepare("INSERT INTO free_agents (league_id, name, role, attrs, age, value) VALUES (?, 'Backfill Agent', 'WM', ?, 26, 100000)")
    .run(leagueId, JSON.stringify(attrsAll(55))).lastInsertRowid);
  const potBefore = (db.prepare('SELECT id, potential FROM players WHERE potential IS NOT NULL').all() as { id: number; potential: number }[])
    .map(r => `${r.id}:${r.potential}`).join(',');
  game.backfillPotentials();
  const potOf = (id: number): number | null => (db.prepare('SELECT potential FROM players WHERE id = ?').get(id) as { potential: number | null }).potential;
  const midPot = potOf(midId);
  assert(midPot !== null && midPot >= 52 && midPot <= 55, `backfill gives a 24-y/o (OVR 50) a youth-weighted ceiling of OVR + 2..5 (got ${midPot})`);
  assert(potOf(oldId) === 62, `backfill at 28+ has zero youth headroom — potential lands exactly on current OVR (got ${potOf(oldId)})`);
  const faPot = (db.prepare('SELECT potential FROM free_agents WHERE id = ?').get(faId) as { potential: number | null }).potential;
  assert(faPot !== null && faPot >= 56 && faPot <= 58, `backfill also fills NULL-potential free agents: 26-y/o OVR 55 -> 56..58 (got ${faPot})`);
  const potAfter = (db.prepare('SELECT id, potential FROM players WHERE id NOT IN (?, ?) AND potential IS NOT NULL').all(midId, oldId) as { id: number; potential: number }[])
    .map(r => `${r.id}:${r.potential}`).join(',');
  assert(potAfter === potBefore, 'backfill is idempotent — rows that already carry a potential are untouched');
  const roster = db.prepare('SELECT role, attrs, potential FROM players WHERE team_id IN (?, ?)').all(humanTeamId, aiTeamId) as { role: string; attrs: string; potential: number | null }[];
  assert(roster.every(r => r.potential !== null && r.potential >= game.overall(JSON.parse(r.attrs), r.role) && r.potential <= 95),
    'every seeded roster player carries potential as a ceiling: >= current OVR, <= 95');

  // ── TICK ────────────────────────────────────────────────────────────────────
  // Ledger: "developmentTick (every league player, once per matchday after the market
  // tick)" / "Skips any player whose potential is still NULL" / "Not idempotent by design —
  // it's a progression" / audit §2.7: the tick "records a per-matchday training REPORT for
  // human-managed clubs (attribute drift per player + the factors that drove it)".
  const youngId = Number(insP.run(humanTeamId, 20, 'Young Prospect', 'CM', JSON.stringify(attrsAll(60)), 19, 90).lastInsertRowid);
  const vetId = Number(insP.run(humanTeamId, 21, 'Old Head', 'CM', JSON.stringify(attrsAll(60)), 35, 70).lastInsertRowid);
  const nullPotId = Number(insP.run(humanTeamId, 22, 'No Ceiling', 'CF', JSON.stringify(attrsAll(40)), 19, null).lastInsertRowid);

  const badFocus = training.setTrainingFocus(humanTeamId, 'dribbling');
  assert(badFocus.focus === 'balanced', 'setTrainingFocus clamps an unknown focus to balanced');
  const setFocus = training.setTrainingFocus(humanTeamId, 'shooting');
  const storedFocus = (db.prepare('SELECT training_focus FROM teams WHERE id = ?').get(humanTeamId) as { training_focus: string }).training_focus;
  assert(setFocus.ok && setFocus.focus === 'shooting' && storedFocus === 'shooting', 'setTrainingFocus stores a valid club focus');

  const attrsOf = (id: number): Record<string, number> => JSON.parse((db.prepare('SELECT attrs FROM players WHERE id = ?').get(id) as { attrs: string }).attrs);
  const eligible = Number((db.prepare('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = ? AND p.potential IS NOT NULL').get(leagueId) as { n: number }).n);
  const humanEligible = Number((db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND potential IS NOT NULL').get(humanTeamId) as { n: number }).n);
  const res1 = training.developmentTick(leagueId);
  assert(res1.players === eligible, `the tick develops every league player with a potential (expected ${eligible}, got ${res1.players})`);
  assert(OUTFIELD.every(k => attrsOf(nullPotId)[k] === 40), 'a NULL-potential player is skipped untouched');
  const young1 = attrsOf(youngId);
  const expectYoung1 = training.developAttrs(attrsAll(60), 19, 90, null, 'shooting', 65, 1, 1, 'CM');
  assert(trainablesEqual(young1, expectYoung1) && young1.shooting === 62.7 && young1.passing === 61.5,
    `tick == developAttrs at identity factors: young CM under the shooting club focus hits 62.7/61.5 exactly (got ${young1.shooting}/${young1.passing})`);
  const vet1 = attrsOf(vetId);
  assert(vet1.passing === 58.8 && vet1.speed === 58.1, `tick applies age decline: veteran passing 58.8, speed 58.1 (got ${vet1.passing}/${vet1.speed})`);
  const allAttrs = db.prepare('SELECT p.attrs FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = ?').all(leagueId) as { attrs: string }[];
  assert(allAttrs.every(r => { const a = JSON.parse(r.attrs) as Record<string, number>; return training.TRAINABLE.every(k => typeof a[k] !== 'number' || (a[k] >= 30 && a[k] <= 95)); }),
    'post-tick, every league player\'s trainables sit inside the [30, 95] clamp');

  const rep1 = training.getTrainingReport(humanTeamId);
  assert(rep1 !== null && rep1.teamFocus === 'shooting' && rep1.season === 1 && rep1.round === 0, 'the human club gets a training report stamped with focus/season/round');
  assert(rep1!.lines.length === humanEligible, `the report holds one line per developed squad member (expected ${humanEligible}, got ${rep1!.lines.length})`);
  assert(training.getTrainingReport(aiTeamId) === null, 'AI clubs record no training report');
  assert(rep1!.coachBoost === 0 && rep1!.harmonyFactor === 1, 'a staff-less, settled club develops at the identity factors');
  const yl1 = rep1!.lines.find(l => l.name === 'Young Prospect');
  assert(yl1 !== undefined && yl1.ovrDelta > 0 && yl1.individual === false && yl1.focus === 'shooting', 'the young player\'s line: positive drift under the club focus, not individual');
  assert(yl1!.factors.includes('Young — rapid growth') && yl1!.factors.includes('Focused on shooting'), 'the line\'s factors explain the drift (age phase + focus)');
  const vl1 = rep1!.lines.find(l => l.name === 'Old Head');
  assert(vl1 !== undefined && vl1.ovrDelta < 0 && vl1.factors.includes('Veteran in decline'), 'the veteran\'s line shows negative drift with the decline factor');
  assert(res1.improved >= 1 && res1.improved <= humanEligible, `improved counts human-club players who gained an attribute (got ${res1.improved})`);
  assert(Object.keys(res1.improvedByTeam).length === 1 && res1.improvedByTeam[humanTeamId] === res1.improved, 'improvedByTeam covers human clubs only');
  const prog1 = training.getAttrProgression(youngId);
  assert(prog1.length === 1 && prog1[0].season === 1 && prog1[0].round === 0 && prog1[0].ovr === game.overall(young1, 'CM'),
    'a development snapshot is recorded for the human-club player');

  training.developmentTick(leagueId);
  const young2 = attrsOf(youngId);
  const expectYoung2 = training.developAttrs(young1, 19, 90, null, 'shooting', 65, 1, 1, 'CM');
  assert(trainablesEqual(young2, expectYoung2) && young2.shooting === 65.4 && young2.passing === 63,
    `the tick is a progression, not idempotent — a second tick develops again from the new attrs (got ${young2.shooting}/${young2.passing})`);
  assert(training.getAttrProgression(youngId).length === 1,
    'snapshots are keyed (player, season, round): replaying the same matchday round cannot double-write');
  assert(Number((db.prepare('SELECT COUNT(*) AS n FROM training_reports WHERE team_id = ?').get(humanTeamId) as { n: number }).n) === 1,
    'the training report is latest-only (pruned each tick)');

  // Audit §2.7 (per the notes' training section): "each player can carry an individual
  // focus that overrides the club focus".
  assert(training.setPlayerTrainingFocus(humanTeamId, 99, 'passing').ok === false, 'a per-player focus on an unknown slot is a silent no-op');
  const override = training.setPlayerTrainingFocus(humanTeamId, 20, 'passing');
  assert(override.ok && override.focus === 'passing', 'a valid per-player focus is stored');
  training.developmentTick(leagueId);
  const young3 = attrsOf(youngId);
  assert(young3.passing === 65.7 && young3.shooting === 66.9,
    `the player focus overrides the club focus: passing now takes the 1.8x, shooting the base move (got ${young3.passing}/${young3.shooting})`);
  const yl3 = training.getTrainingReport(humanTeamId)!.lines.find(l => l.name === 'Young Prospect');
  assert(yl3 !== undefined && yl3.individual === true && yl3.focus === 'passing', 'the report marks the individual focus on his line');

  // ── SIGNING CARRIES POTENTIAL ───────────────────────────────────────────────
  // Ledger: "Potential threads through every signing." + "POT column in the market".
  game.seedFreeAgents(leagueId);
  const agents = db.prepare('SELECT id, role, attrs, age, potential, value FROM free_agents WHERE league_id = ? ORDER BY value ASC').all(leagueId) as
    { id: number; role: string; attrs: string; age: number; potential: number | null; value: number }[];
  assert(agents.length >= game.FREE_AGENT_COUNT, `the seeded pool holds at least FREE_AGENT_COUNT agents (got ${agents.length})`);
  assert(agents.every(a => a.potential !== null && a.potential >= game.overall(JSON.parse(a.attrs), a.role) && a.potential <= 95),
    'every free agent carries a youth-weighted ceiling: >= his OVR, <= 95');
  const target = agents[0];   // the cheapest agent — comfortably inside budget + wage headroom
  const maxIdBefore = Number((db.prepare('SELECT MAX(id) AS m FROM players').get() as { m: number }).m);
  const buy = market.buyFreeAgent(humanTeamId, target.id);
  assert(buy.ok === true, `signing the cheapest free agent must succeed (got: ${buy.error ?? 'ok'})`);
  const signed = db.prepare('SELECT team_id, potential, age FROM players WHERE id > ?').all(maxIdBefore) as { team_id: number; potential: number | null; age: number }[];
  assert(signed.length === 1 && signed[0].team_id === humanTeamId && signed[0].potential === target.potential && signed[0].age === target.age,
    'the signing carries the agent\'s exact potential (and age) onto his players row');

  console.log(`_training_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
}

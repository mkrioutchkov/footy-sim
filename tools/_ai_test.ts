// tools/_ai_test.ts — engine-free regression for web/backend/ai.ts (pillar 4: AI managers).
// Recreated from the GAME_LAYER_NOTES.md ledger entry:
//
//   "Pillar 4 — AI managers. ai.ts: each matchday every AI club (in aiManagerTick, fired per
//    division in /api/advance after the market tick) sets a training focus (pickTrainingFocus
//    — its outfield XI's weakest attribute, else balanced) and fields its strongest
//    role-correct XI (optimizeLineup — best player per role-slot, rest benched). ...
//    Strictly AI-only — a human manager's focus and hand-picked lineup are never touched.
//    Verified by tools/_ai_test.ts (12 assertions)"
//
// and the NOT-YET note: "AI keeps the default 4-3-3 shape. AI optimises WHICH 11 start, not
// the formation." Each assertion group quotes the ledger claim it covers.
//
// Determinism: ai.ts itself contains no Math.random — optimizeLineup, pickTrainingFocus and
// aiCoachingStyle are pure functions of DB state, so those are asserted EXACTLY (including
// repeat-call identity). The staff side (seedStaffPool ratings) IS random, so staff assertions
// stick to invariants (counts, budget conservation, rating bounds). Squads seeded through
// game.createTeam are random too — the tick-level group asserts legality invariants on them.
//
// Run: cd <repo> && npx tsx tools/_ai_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run — web/backend/data/ is never touched.

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// db.ts resolves FOOTY_DB at IMPORT time, so point it at a scratch file BEFORE any backend
// module loads — which is why every backend import below is a dynamic import.
const TESTDB_DIR = '/tmp/claude-0/-home-user-footy-sim/710ecd1a-f780-5b5f-a4ef-27543513423b/scratchpad/testdb';
mkdirSync(TESTDB_DIR, { recursive: true });
const DB_PATH = path.join(TESTDB_DIR, `ai_${process.pid}_${Date.now()}.sqlite`);
process.env.FOOTY_DB = DB_PATH;

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const ai = await import('../web/backend/ai.ts');
const training = await import('../web/backend/training.ts');
const staffMod = await import('../web/backend/staff.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

// Uniform attrs make overall() exact: every skill key = v, so OVR = v for any role.
function attrsAll(v: number, over: Record<string, number> = {}): string {
  return JSON.stringify({ speed: v, passing: v, creativity: v, shooting: v, tackling: v, positioning: v, stamina: v, handling: v, height: 55, ...over });
}

const insLeague = db.prepare("INSERT INTO leagues (name, season, status) VALUES (?, 1, 'running')");
function mkLeague(name: string, withWorld: boolean): number {
  const id = Number(insLeague.run(name).lastInsertRowid);
  if (withWorld) { db.prepare('UPDATE leagues SET world_id = ? WHERE id = ?').run(id, id); }
  return id;
}
const insTeam = db.prepare('INSERT INTO teams (user_id, league_id, name, manager, tactics, created_at) VALUES (?, ?, ?, ?, ?, 0)');
function mkTeam(leagueId: number, userId: number | null, name: string): number {
  return Number(insTeam.run(userId, leagueId, name, 'M', JSON.stringify(game.DEFAULT_TACTICS)).lastInsertRowid);
}
// aiCoachingStyle derives an unassigned club's style from teamId % 3, so some groups need a
// team id in a specific mod-3 class; three consecutive inserts always cover every class.
function mkTeamWithIdMod(leagueId: number, userId: number | null, name: string, mod: number): number {
  for (let i = 0; i < 3; i++) { const id = mkTeam(leagueId, userId, `${name} ${i}`); if (id % 3 === mod) { return id; } }
  throw new Error('unreachable: three consecutive ids cover every mod-3 class');
}
const insPlayer = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs) VALUES (?, ?, ?, ?, ?)');

const slotMap = (teamId: number): string =>
  JSON.stringify(db.prepare('SELECT id, slot FROM players WHERE team_id = ? ORDER BY id').all(teamId));
const teamRow = (teamId: number): string =>
  JSON.stringify(db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId));
const styleOf = (teamId: number): string =>
  (db.prepare('SELECT coaching_style FROM teams WHERE id = ?').get(teamId) as { coaching_style: string }).coaching_style;
const budgetOf = (teamId: number): number =>
  (db.prepare('SELECT budget FROM teams WHERE id = ?').get(teamId) as { budget: number }).budget;
const coachesOf = (teamId: number): { id: number; rating: number; cost: number }[] =>
  db.prepare("SELECT id, rating, cost FROM staff WHERE team_id = ? AND role = 'coach' ORDER BY id").all(teamId) as { id: number; rating: number; cost: number }[];
const staffCount = (teamId: number): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM staff WHERE team_id = ?').get(teamId) as { n: number }).n;
interface PRow { id: number; role: string; attrs: string; slot: number; }
const rowsBySlot = (teamId: number): PRow[] =>
  db.prepare('SELECT id, role, attrs, slot FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as unknown as PRow[];
const ovrOf = (r: PRow): number => game.overall(JSON.parse(r.attrs), r.role);

try {
  // ── OPTIMIZE LINEUP ─────────────────────────────────────────────────────────
  // Ledger: "fields its strongest role-correct XI (optimizeLineup — best player per
  // role-slot, rest benched)". A 17-man squad with hand-set overalls and deliberately
  // scrambled slots must repack to the exact greedy pick, so the assignment is asserted
  // player by player.
  const lgA = mkLeague('Lineup League', false);
  const tA = mkTeam(lgA, null, 'Repack FC');
  const SQUAD: [string, string, number][] = [
    ['gkA', 'GK', 70], ['gkB', 'GK', 54],
    ['fb1', 'FB', 65], ['fb2', 'FB', 60], ['fb3', 'FB', 55],
    ['cb1', 'CB', 68], ['cb2', 'CB', 62], ['cb3', 'CB', 50],
    ['cm1', 'CM', 72], ['cm2', 'CM', 66], ['cm3', 'CM', 61], ['cm4', 'CM', 58],
    ['wm1', 'WM', 64], ['wm2', 'WM', 59], ['wm3', 'WM', 40],
    ['cf1', 'CF', 75], ['cf2', 'CF', 45],
  ];
  const pid: Record<string, number> = {};
  SQUAD.forEach(([key, role, ovr], i) => {
    pid[key] = Number(insPlayer.run(tA, SQUAD.length - 1 - i, key, role, attrsAll(ovr)).lastInsertRowid);
  });
  // The best striker is injured AND exhausted before the repack — optimizeLineup has no
  // availability rule (it scores purely by overall), so he must still start (see FINDINGS).
  db.prepare('UPDATE players SET injured_matches = 4, fitness = 5 WHERE id = ?').run(pid.cf1);
  ai.optimizeLineup(tA);

  const rowsA = rowsBySlot(tA);
  assert(rowsA.length === 17 && new Set(rowsA.map(r => r.slot)).size === 17 && rowsA[0].slot === 0 && rowsA[16].slot === 16,
    'the repack leaves slots as a clean 0..16 permutation (every player exactly one slot)');
  const xiA = rowsA.slice(0, 11);
  assert(xiA.map(r => r.role).join(',') === game.ROLE_SLOTS.join(','),
    `the XI is role-correct: slots 0-10 line up with ROLE_SLOTS (got ${xiA.map(r => r.role).join(',')})`);
  assert(xiA.filter(r => r.role === 'GK').length === 1, 'exactly one keeper starts');
  const expectXI = ['gkA', 'fb1', 'cb1', 'cb2', 'fb2', 'cm1', 'cm2', 'cm3', 'wm1', 'cf1', 'wm2'].map(k => pid[k]);
  assert(xiA.map(r => r.id).join(',') === expectXI.join(','),
    'best player per role-slot: the XI is exactly the greedy highest-overall pick, slot by slot');
  const expectBench = ['cm4', 'fb3', 'gkB', 'cb3', 'cf2', 'wm3'].map(k => pid[k]);
  assert(rowsA.slice(11).map(r => r.id).join(',') === expectBench.join(','),
    'the rest are benched in descending overall order (slots 11..16)');
  assert(rowsA[9].id === pid.cf1,
    'current behaviour: an injured, exhausted top scorer is STILL slotted into the XI — optimizeLineup has no fitness/injury rule');
  const snapA = slotMap(tA);
  ai.optimizeLineup(tA);
  assert(slotMap(tA) === snapA, 'optimizeLineup is deterministic + idempotent: a second run reproduces the identical slot map');

  // Fallback: with no keeper at all, slot 0 falls back to the best unused player of ANY role.
  const tB = mkTeam(lgA, null, 'No Keeper FC');
  const squadB: [string, number][] = [['FB', 66], ['FB', 63], ['CB', 62], ['CB', 61], ['CM', 77], ['CM', 58], ['CM', 57], ['WM', 56], ['WM', 53], ['CF', 52], ['CF', 51]];
  const pidB = squadB.map(([role, ovr], i) => Number(insPlayer.run(tB, 10 - i, `b${i}`, role, attrsAll(ovr)).lastInsertRowid));
  ai.optimizeLineup(tB);
  const rowsB = rowsBySlot(tB);
  assert(rowsB.length === 11 && new Set(rowsB.map(r => r.slot)).size === 11 && rowsB[0].slot === 0 && rowsB[10].slot === 10,
    'a GK-less squad still fills all 11 slots (fallback to best-of-any-role)');
  assert(rowsB.filter(r => r.role === 'GK').length === 0, 'no phantom keeper is invented');
  assert(rowsB[0].id === pidB[4], `the GK slot falls back to the best unused player overall (the 77 CM), got player ${rowsB[0].id}`);

  // A squad under 11 is a no-op (nothing to field).
  const tC = mkTeam(lgA, null, 'Thin FC');
  for (let i = 0; i < 10; i++) { insPlayer.run(tC, 100 + i, `c${i}`, 'CM', attrsAll(50)); }
  const snapC = slotMap(tC);
  ai.optimizeLineup(tC);
  assert(slotMap(tC) === snapC, 'a squad with fewer than 11 players is left untouched (early return)');

  // ── AI COACHING STYLE ───────────────────────────────────────────────────────
  // ai.ts (Phase 2, code contract — NOT in the notes' pillar-4 ledger entry, see FINDINGS):
  // "The style is derived deterministically from the club id so a league shows a stable mix,
  // and persisted into teams.coaching_style ... the first time it's touched."
  const lgS = mkLeague('Style League', false);
  const tD0 = mkTeamWithIdMod(lgS, null, 'Derive Dev', 0);
  assert(ai.aiCoachingStyle(tD0) === 'developer' && styleOf(tD0) === 'developer',
    'an unassigned AI club derives its style from id % 3 (0 -> developer) and persists it');
  assert(ai.aiCoachingStyle(tD0) === 'developer', 'the derived style is stable across calls');
  const tD2 = mkTeamWithIdMod(lgS, null, 'Derive Cons', 2);
  assert(ai.aiCoachingStyle(tD2) === 'conservation' && styleOf(tD2) === 'conservation',
    'id % 3 == 2 -> conservation, persisted');
  const tD0b = mkTeamWithIdMod(lgS, null, 'Sticky', 0);
  db.prepare("UPDATE teams SET coaching_style = 'conservation' WHERE id = ?").run(tD0b);
  assert(ai.aiCoachingStyle(tD0b) === 'conservation',
    'an explicitly assigned non-balanced style wins over the id derivation');
  const uid = Number(db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('ai_test_user', 'x', 'x', 0)").run().lastInsertRowid);
  const tH0 = mkTeamWithIdMod(lgS, uid, 'Human Style', 0);
  assert(ai.aiCoachingStyle(tH0) === 'balanced' && styleOf(tH0) === 'balanced',
    'a HUMAN club never gets a derived style: it stays balanced and nothing is persisted');

  // ── PICK TRAINING FOCUS ─────────────────────────────────────────────────────
  // Ledger: "sets a training focus (pickTrainingFocus — its outfield XI's weakest
  // attribute, else balanced)". Style gates (code contract): a developer specialises on a
  // 4-gap, balanced on an 8-gap, conservation never does.
  const lgF = mkLeague('Focus League', false);
  const tF = mkTeamWithIdMod(lgF, null, 'Focus FC', 1);   // id % 3 == 1 -> derived style 'balanced'
  insPlayer.run(tF, 0, 'gk', 'GK', attrsAll(60, { shooting: 30, handling: 90 }));
  for (let i = 1; i < 11; i++) { insPlayer.run(tF, i, `f${i}`, game.ROLE_SLOTS[i], attrsAll(60, { tackling: 50 })); }
  const setOutfield = (teamId: number, attrsJson: string): void => {
    db.prepare('UPDATE players SET attrs = ? WHERE team_id = ? AND slot > 0').run(attrsJson, teamId);
  };
  assert(ai.aiCoachingStyle(tF) === 'balanced', 'fixture sanity: the focus club derives the balanced style');
  assert(ai.pickTrainingFocus(tF) === 'tackling',
    "the outfield XI's weakest attribute (tackling, 10 under the rest) becomes the club focus");
  assert(ai.pickTrainingFocus(tF) === 'tackling', 'pickTrainingFocus is deterministic: a repeat call agrees');
  setOutfield(tF, attrsAll(60, { tackling: 54 }));
  assert(ai.pickTrainingFocus(tF) === 'balanced',
    'a 6-point gap does not clear the balanced style\'s 8-gap gate -> balanced');
  db.prepare("UPDATE teams SET coaching_style = 'developer' WHERE id = ?").run(tF);
  assert(ai.pickTrainingFocus(tF) === 'tackling', 'a developer specialises on the smaller 4-gap');
  db.prepare("UPDATE teams SET coaching_style = 'conservation' WHERE id = ?").run(tF);
  assert(ai.pickTrainingFocus(tF) === 'balanced', 'a conservation club never specialises (99-gap gate)');
  db.prepare("UPDATE teams SET coaching_style = 'developer' WHERE id = ?").run(tF);
  setOutfield(tF, attrsAll(60));
  assert(ai.pickTrainingFocus(tF) === 'balanced',
    'the keeper is EXCLUDED: a perfectly even outfield stays balanced even though the GK\'s extreme attrs would clear any gap');
  db.prepare("UPDATE teams SET coaching_style = 'balanced' WHERE id = ?").run(tF);   // re-derives (id % 3 == 1) -> balanced
  setOutfield(tF, attrsAll(60, { handling: 40 }));
  // FIXED (was a FINDING): handling is keeper-only (developAttrs gates it to GKs), so the
  // outfield scan now excludes it — an outfield handling trough must NOT become the club
  // focus. With every real club focus dead even, the pick stays balanced.
  assert(ai.pickTrainingFocus(tF) === 'balanced',
    'a keeper-only skill can no longer win the club focus: outfield handling trough -> balanced');
  setOutfield(tF, attrsAll(60, { tackling: 40, handling: 40 }));
  assert(ai.pickTrainingFocus(tF) === 'tackling',
    'with a REAL outfield trough alongside the handling trough, the real one (tackling) wins');
  const tF2 = mkTeam(lgF, null, 'Four Men FC');
  for (let i = 0; i < 4; i++) { insPlayer.run(tF2, i, `t${i}`, 'CM', attrsAll(50, { tackling: 30 })); }
  assert(ai.pickTrainingFocus(tF2) === 'balanced', 'fewer than 5 outfield rows -> balanced (degenerate squad guard)');

  // ── AI MANAGER STAFF ────────────────────────────────────────────────────────
  // ai.ts (Phase 2, code contract — not in the notes' pillar-4 ledger entry, see FINDINGS):
  // "it hires up to its style's target of coaches when it can comfortably afford it (keeping
  // a transfer cushion), then assigns them by specialty ... Idempotent — won't over-hire past
  // the target ... A club with no hire pool (a legacy single-league world) is a safe no-op."
  const lgW = mkLeague('Staff League', true);
  staffMod.seedStaffPool(lgW);
  const pool = db.prepare('SELECT role, rating, cost FROM staff WHERE world_id = ? AND team_id IS NULL').all(lgW) as { role: string; rating: number; cost: number }[];
  assert(pool.length === 12 && pool.filter(s => s.role === 'coach').length === 4,
    `the seeded pool holds 12 candidates, 4 of them coaches (got ${pool.length}/${pool.filter(s => s.role === 'coach').length})`);
  assert(pool.every(s => s.rating >= 45 && s.rating <= 88 && s.cost > 0),
    'pool ratings sit in the 45..88 band with a positive hire fee (rng -> bounds only)');

  const tS3 = mkTeam(lgW, null, 'Skint FC');
  db.prepare('UPDATE teams SET budget = 8000000 WHERE id = ?').run(tS3);
  ai.aiManagerStaff(tS3);
  assert(staffCount(tS3) === 0 && budgetOf(tS3) === 8_000_000,
    'the 8M transfer cushion holds: a club sitting exactly at the cushion hires nobody and spends nothing');

  const tS1 = mkTeam(lgW, null, 'Developer FC');   // schema-default 50M budget: every pool coach affordable
  db.prepare("UPDATE teams SET coaching_style = 'developer' WHERE id = ?").run(tS1);
  const topRating = Math.max(...pool.filter(s => s.role === 'coach').map(s => s.rating));
  ai.aiManagerStaff(tS1);
  const hired1 = coachesOf(tS1);
  assert(hired1.length === 1, 'one hire per tick: the first cycle signs exactly one coach');
  assert(hired1[0].rating === topRating, 'it signs the best affordable pool coach (highest rating)');
  assert(budgetOf(tS1) === 50_000_000 - hired1[0].cost, 'the hire fee comes out of the transfer budget, exactly once');
  const assign1 = JSON.parse((db.prepare('SELECT coach_assignment FROM teams WHERE id = ?').get(tS1) as { coach_assignment: string | null }).coach_assignment ?? 'null') as Record<string, number[]> | null;
  assert(assign1 !== null && ['Attacking', 'Possession', 'Defending'].every(c => (assign1[c] ?? []).includes(hired1[0].id)),
    'the new coach is assigned by specialty (default first_team_coach -> the three outfield categories) so per-category development activates');
  ai.aiManagerStaff(tS1);
  ai.aiManagerStaff(tS1);
  assert(coachesOf(tS1).length === 3, 'a developer builds to its 3-coach target, one hire per cycle');
  const budgetAtTarget = budgetOf(tS1);
  ai.aiManagerStaff(tS1);
  assert(coachesOf(tS1).length === 3 && budgetOf(tS1) === budgetAtTarget,
    'idempotent at target: a further cycle never over-hires or spends');

  // FIXED (was a design-time FINDING): seedStaffPool used to derive the top-up role from the
  // pool COUNT (ROLES[i % 3]), so a pool sitting one short always regrew the same role — at
  // 11/12 every replacement was a scout and hired coaches were never replenished. It now
  // refills the role the pool is thinnest on: after Developer FC's 3 coach hires, a re-seed
  // must restore the coach count, not mint three more scouts.
  staffMod.seedStaffPool(lgW);
  const refilled = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE world_id = ? AND team_id IS NULL AND role = 'coach'").get(lgW) as { n: number };
  assert(refilled.n === 4, `a drained pool regrows COACHES (thinnest role), got ${refilled.n}/4`);

  const tS2 = mkTeam(lgW, null, 'Conserve FC');
  db.prepare("UPDATE teams SET coaching_style = 'conservation' WHERE id = ?").run(tS2);
  ai.aiManagerStaff(tS2);
  ai.aiManagerStaff(tS2);
  assert(coachesOf(tS2).length === 1, 'a conservation club stops at its 1-coach target');

  const tHm = mkTeam(lgW, uid, 'Human Staff FC');
  ai.aiManagerStaff(tHm);
  assert(staffCount(tHm) === 0 && budgetOf(tHm) === 50_000_000, 'a HUMAN club is untouched by the AI staff builder');
  const lgLegacy = mkLeague('Legacy League', false);   // world_id NULL: no hire pool
  const tLeg = mkTeam(lgLegacy, null, 'Legacy FC');
  ai.aiManagerStaff(tLeg);
  assert(staffCount(tLeg) === 0 && budgetOf(tLeg) === 50_000_000, 'a pool-less legacy-world club is a safe no-op');

  // ── AI MANAGER TICK ─────────────────────────────────────────────────────────
  // Ledger: "each matchday every AI club (in aiManagerTick ...) sets a training focus ...
  // and fields its strongest role-correct XI ... Strictly AI-only — a human manager's focus
  // and hand-picked lineup are never touched." Plus the NOT-YET note: "AI keeps the default
  // 4-3-3 shape. AI optimises WHICH 11 start, not the formation."
  const lgT = mkLeague('Tick League', true);
  const tHuman = game.createTeam({ leagueId: lgT, userId: uid, name: 'Human Tick FC', manager: 'Human', tactics: game.DEFAULT_TACTICS, base: 62 });
  const aiIds = [1, 2, 3].map(i =>
    game.createTeam({ leagueId: lgT, userId: null, name: `AI Tick ${i}`, manager: 'AI', tactics: game.DEFAULT_TACTICS, base: 60 }));
  // The human hand-picks everything: a club focus, a plan, a custom lineup + formation, and a
  // deliberately reversed slot order (his hand-picked XI is NOT the strongest one).
  db.prepare("UPDATE teams SET training_focus = 'shooting', plan_text = 'Park the bus', lineup = '[10,9,8,7,6,5,4,3,2,1,0]', formation = '4-4-2', captain_slot = 4 WHERE id = ?").run(tHuman);
  const humanPlayers = db.prepare('SELECT id FROM players WHERE team_id = ? ORDER BY slot').all(tHuman) as { id: number }[];
  const updSlot = db.prepare('UPDATE players SET slot = ? WHERE id = ?');
  humanPlayers.forEach((r, i) => updSlot.run(humanPlayers.length - 1 - i, r.id));
  const humanRowBefore = teamRow(tHuman);
  const humanSlotsBefore = slotMap(tHuman);
  // An AI club in ANOTHER division is outside this tick's scope entirely.
  const lgO = mkLeague('Other League', true);
  const tOther = game.createTeam({ leagueId: lgO, userId: null, name: 'Bystander FC', manager: 'AI', tactics: game.DEFAULT_TACTICS, base: 60 });
  const otherBefore = slotMap(tOther);

  const res = ai.aiManagerTick(lgT);
  assert(res.teams === 3, `the tick visits every AI club in the division and only those (expected 3, got ${res.teams})`);
  assert((db.prepare('SELECT training_focus FROM teams WHERE id = ?').get(tHuman) as { training_focus: string }).training_focus === 'shooting',
    "the human manager's training focus is never touched");
  assert(slotMap(tHuman) === humanSlotsBefore, "the human manager's hand-picked (deliberately weak) XI is never re-packed");
  assert(teamRow(tHuman) === humanRowBefore,
    'the entire human team row (focus, lineup, plan, formation, captain, budget, style) is byte-identical after the tick');
  assert(staffCount(tHuman) === 0, 'the tick hires no staff for the human club');
  assert(slotMap(tOther) === otherBefore, 'an AI club in another division is untouched (per-division scope)');

  const validFocus = new Set<string>(['balanced', ...training.TRAINABLE]);
  for (const t of aiIds) {
    const rows = rowsBySlot(t);
    const n = rows.length;
    assert(new Set(rows.map(r => r.slot)).size === n && rows[0].slot === 0 && rows[n - 1].slot === n - 1,
      `AI club ${t}: post-tick slots are a clean 0..${n - 1} permutation`);
    const xi = rows.slice(0, 11);
    assert(xi.map(r => r.role).join(',') === game.ROLE_SLOTS.join(','),
      `AI club ${t}: the fielded XI is role-correct against ROLE_SLOTS`);
    assert(xi.filter(r => r.role === 'GK').length === 1, `AI club ${t}: exactly one keeper starts`);
    const bench = rows.slice(11);
    const roles = [...new Set<string>(game.ROLE_SLOTS as readonly string[])];
    assert(roles.every(role => {
      const xiR = xi.filter(r => r.role === role), bR = bench.filter(r => r.role === role);
      return !xiR.length || !bR.length || Math.min(...xiR.map(ovrOf)) >= Math.max(...bR.map(ovrOf));
    }), `AI club ${t}: every fielded player out-rates every benched player of his role (strongest XI)`);
    const trow = db.prepare('SELECT training_focus, formation FROM teams WHERE id = ?').get(t) as { training_focus: string; formation: string };
    assert(validFocus.has(trow.training_focus), `AI club ${t}: the tick stored a legal focus ('balanced' or a TRAINABLE key), got '${trow.training_focus}'`);
    assert(trow.formation === '4-3-3', `AI club ${t}: the formation is NOT optimised — the default 4-3-3 shape is kept`);
    assert(coachesOf(t).length === 1, `AI club ${t}: the tick also ran the staff builder (exactly one coach after one cycle)`);
  }

  // Repeat ticks: focus + lineup are pure functions of squad state (no rng), so once the
  // lineup is optimal a further tick must reproduce byte-identical decisions.
  ai.aiManagerTick(lgT);
  const focus2 = JSON.stringify(db.prepare('SELECT id, training_focus FROM teams WHERE league_id = ? ORDER BY id').all(lgT));
  const slots2 = aiIds.map(slotMap).join('|');
  ai.aiManagerTick(lgT);
  const focus3 = JSON.stringify(db.prepare('SELECT id, training_focus FROM teams WHERE league_id = ? ORDER BY id').all(lgT));
  const slots3 = aiIds.map(slotMap).join('|');
  assert(focus3 === focus2 && slots3 === slots2,
    'for a fixed squad state the tick is deterministic: repeat ticks reproduce the same focus + XI for every club');
  assert(teamRow(tHuman) === humanRowBefore && slotMap(tHuman) === humanSlotsBefore,
    'after three ticks the human club is still byte-identical — strictly AI-only, every cycle');

  console.log(`_ai_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
}

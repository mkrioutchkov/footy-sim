// tools/_youth_test.ts — engine-free regression for web/backend/youth.ts (pillar 5.3 youth &
// retirement + audit §2.9 academy). Recreated from the GAME_LAYER_NOTES.md ledger entries:
//
//   "5.3 Youth & retirement. At each rollover (youth.ts, after the contract tick) players
//    aged ≥37 retire (leave the game, floor-guarded to never drop below a legal XI) and every
//    club brings through YOUTH_INTAKE (2) prospects — raw teens (attrs 40–55) with high
//    genPotential upside, a neutral personality to flesh out via the story editor ..., a wage
//    + a 3-yr deal — capped at the 24-man squad. Closes the ageing loop: squads now renew
//    across seasons. market.ts removePlayerFromSquad is shared by retirement + release.
//    Verified by tools/_youth_test.ts (17) + season (36) regression."
//
//   (ledger tail) "retirement + youth intake shipped (youth.ts, release/regeneration at
//    rollover)" — the §2.9 academy half: a HUMAN club's prospects land in a visible ACADEMY
//    (youth_prospects) that develops each season, the manager PROMOTES the ones he wants, and
//    a prospect not promoted by 21 graduates out (the release).
//
//   (newgen entry) "regens start needy" — fresh regens are "created with a blank-backstory
//    neutral personality" so fillMissingPersonalities' needy filter (!p || !p.backstory)
//    targets exactly them.
//
// Each assertion group quotes the ledger claim it covers. Prospect generation is RNG-driven
// (Math.random ages/attrs), so emergent values get INVARIANT assertions (bounds, counts,
// conservation, monotone development); the deterministic paths (wage formula, contract length,
// squad-cap clamps, floor guard, event ordering) are asserted exactly.
//
// KNOWN ASYMMETRY (found by the season fleet, asserted around here — not fought): seedAcademy
// runs only in the index.ts signup route (POST /api/team), NOT in game.newSeasonForUser, so a
// world built through the game-layer API starts with an EMPTY academy until seedAcademy is
// called explicitly.
//
// Run: cd <repo> && npx tsx tools/_youth_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run + chdir into the scratchpad BEFORE importing any
// backend module — the repo's web/backend/data/ is never touched. No matches are played:
// youthAndRetirement only reads teams/players/youth_prospects, so the season stays unplayed.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.ts resolves FOOTY_DB at IMPORT time (and mkdirs cwd/web/backend/data), so pin both
// BEFORE any backend module loads — which is why every backend import below is dynamic.
const SCRATCH = path.join(os.tmpdir(), 'footy-test');
const TESTDB_DIR = path.join(SCRATCH, 'testdb');
const CWD_DIR = path.join(SCRATCH, `youth_cwd_${process.pid}`);
mkdirSync(TESTDB_DIR, { recursive: true });
mkdirSync(CWD_DIR, { recursive: true });
process.chdir(CWD_DIR);
const DB_PATH = path.join(TESTDB_DIR, `youth_${process.pid}_${Date.now()}.sqlite`);
process.env.FOOTY_DB = DB_PATH;

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const youth = await import('../web/backend/youth.ts');
const market = await import('../web/backend/market.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

const count = (sql: string, ...args: (number | string)[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);
const squadSize = (teamId: number): number => count('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', teamId);
const academySize = (teamId: number): number => count('SELECT COUNT(*) AS n FROM youth_prospects WHERE team_id = ?', teamId);
const maxId = (table: string): number => Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m);

// The neutral personality every regen is born with: blank backstory + all-50 dials except the
// GK/CB leadership lean — i.e. exactly what fillMissingPersonalities' needy filter matches.
function isNeedyNeutral(personalityJson: string | null, role: string): boolean {
  if (!personalityJson) return false;
  const p = JSON.parse(personalityJson) as { traits: Record<string, number>; nationality: string; backstory: string; tagline: string };
  const expectLead = role === 'GK' || role === 'CB' ? 60 : 50;
  const keys = ['temperament', 'criticismResponse', 'praiseResponse', 'bigGame', 'consistency', 'leadership', 'professionalism', 'ego'];
  return p.backstory === '' && p.tagline === '' && p.nationality === ''
    && keys.every(k => p.traits[k] === (k === 'leadership' ? expectLead : 50));
}
const attrsInBounds = (attrs: Record<string, number>): boolean =>
  Object.values(attrs).every(v => typeof v === 'number' && v >= 30 && v <= 95);
const sumAttrs = (attrs: Record<string, number>): number => Object.values(attrs).reduce((a, v) => a + v, 0);
const YOUTH_ROLE_SET = new Set(['GK', 'FB', 'CB', 'CM', 'WM', 'CF']);

// Insert a throwaway squad-filler (pads a club toward the 24 cap without touching youth.ts paths).
const insDummy = db.prepare('INSERT INTO players (team_id, slot, name, role, attrs, age, potential, personality, wage, contract_years, foot) VALUES (?, ?, ?, ?, ?, 20, 60, NULL, 25000, 3, 1)');
function padSquad(teamId: number, to: number): number[] {
  const ids: number[] = [];
  for (let s = squadSize(teamId); s < to; s++) {
    const maxSlot = Number((db.prepare('SELECT COALESCE(MAX(slot), -1) AS m FROM players WHERE team_id = ?').get(teamId) as { m: number }).m);
    ids.push(Number(insDummy.run(teamId, maxSlot + 1, `Filler ${teamId}-${s}`, 'CM', JSON.stringify(game.genAttrs('CM', 50))).lastInsertRowid));
  }
  return ids;
}

try {
  // ── WORLD SETUP ─────────────────────────────────────────────────────────────
  const userId = Number(db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('youth_test', 'x', 'x', 0)").run().lastInsertRowid);
  const { leagueId: div2Id, teamId: humanTeamId, worldId: div1Id } = game.newSeasonForUser(userId, 'youth_test', 'Youth United', game.DEFAULT_TACTICS);
  const aiTeams = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id').all(div2Id) as { id: number }[]).map(r => r.id);
  assert(aiTeams.length === 7 && squadSize(humanTeamId) === 17, `sanity: 7 AI clubs beside the human in div 2, fresh squads of 17 (got ${aiTeams.length}/${squadSize(humanTeamId)})`);

  // ── SEEDING + THE KNOWN ASYMMETRY ───────────────────────────────────────────
  // Season-fleet finding (asserted around, not fought): seedAcademy runs only in the index.ts
  // signup route — game.newSeasonForUser leaves the academy EMPTY.
  assert(count('SELECT COUNT(*) AS n FROM youth_prospects') === 0,
    'the asymmetry: newSeasonForUser seeds NO academy (seedAcademy lives in the signup route only)');
  // youth.ts: "Seed a fresh academy (team creation). Idempotent-ish: only tops up to n so a
  // re-call can't flood it."
  youth.seedAcademy(humanTeamId);
  assert(academySize(humanTeamId) === 4, `seedAcademy stocks a starting crop of 4 prospects (got ${academySize(humanTeamId)})`);
  youth.seedAcademy(humanTeamId);
  youth.seedAcademy(humanTeamId, 2);
  assert(academySize(humanTeamId) === 4, 'seedAcademy is a top-up: a re-call (even asking for fewer) neither floods nor trims');

  // Ledger: "raw teens ... with high genPotential upside" — academy generation invariants.
  // (Ledger says "attrs 40–55"; the ACADEMY path actually rolls base 38..53 — the 40..55 range
  // belongs to the AI intake path below. Asserted per the code.)
  const seeded = db.prepare('SELECT id, role, attrs, age, potential, personality, created_at FROM youth_prospects WHERE team_id = ?').all(humanTeamId) as
    { id: number; role: string; attrs: string; age: number; potential: number | null; personality: string | null; created_at: number }[];
  assert(seeded.every(p => p.age >= 15 && p.age <= 18 && YOUTH_ROLE_SET.has(p.role) && p.created_at > 0),
    'every seeded prospect is a 15-18 teen in one of the six engine roles');
  assert(seeded.every(p => attrsInBounds(JSON.parse(p.attrs))), 'prospect attrs (height included) respect the 30..95 clamp');
  assert(seeded.every(p => p.potential !== null && p.potential >= game.overall(JSON.parse(p.attrs), p.role) && p.potential <= 95),
    'genPotential upside: every prospect\'s ceiling is >= his current overall, capped at 95');
  // Newgen ledger: "regens start needy" — blank-backstory neutral personality, dials all 50
  // (leadership 60 only for the GK/CB lean), so fillMissingPersonalities would target them.
  assert(seeded.every(p => isNeedyNeutral(p.personality, p.role)),
    'regens start needy: every prospect carries the blank-backstory neutral personality');

  // ── getAcademy ──────────────────────────────────────────────────────────────
  // youth.ts: "A club's academy prospects — most promising first" (potential DESC, id).
  const academy = youth.getAcademy(humanTeamId);
  assert(academy.length === 4 && academy.every(p => p.overall === game.overall(p.attrs, p.role) && typeof p.attrs === 'object'),
    'getAcademy returns all 4 prospects with attrs parsed and overall derived role-aware');
  assert(academy.every((p, i) => i === 0 || (academy[i - 1].potential ?? 0) > (p.potential ?? 0)
      || ((academy[i - 1].potential ?? 0) === (p.potential ?? 0) && academy[i - 1].id < p.id)),
    'getAcademy sorts most-promising-first (potential DESC, id tiebreak)');

  // ── PROMOTION INTO THE SQUAD ────────────────────────────────────────────────
  // §2.9: "the manager PROMOTES the ones he wants into the senior squad".
  assert(youth.promoteProspect(humanTeamId, 999999).ok === false, 'promoting a nonexistent prospect fails');
  const bad = youth.promoteProspect(aiTeams[0], academy[0].id);
  assert(bad.ok === false && academySize(humanTeamId) === 4,
    'a prospect is team-scoped: another club cannot promote him (and he stays put)');
  const star = academy[0];
  const starRow = seeded.find(p => p.id === star.id)!;
  const promo = youth.promoteProspect(humanTeamId, star.id);
  assert(promo.ok === true && promo.player === star.name && squadSize(humanTeamId) === 18,
    'promoting the top prospect lands him in the senior squad (17 -> 18)');
  const landed = db.prepare('SELECT slot, name, role, attrs, age, potential, personality, wage, contract_years, foot FROM players WHERE team_id = ? ORDER BY id DESC LIMIT 1').get(humanTeamId) as
    { slot: number; name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; wage: number; contract_years: number; foot: number };
  assert(landed.name === star.name && landed.role === star.role && landed.age === star.age
      && landed.attrs === starRow.attrs && landed.potential === star.potential && landed.personality === starRow.personality,
    'the promoted player carries his academy identity verbatim (role/age/attrs/potential/personality)');
  // Ledger: "a wage + a 3-yr deal" — the deal starts at promotion. NOTE (code quirk, asserted
  // as-is): promoteProspect computes the wage WITHOUT passing the role, so a promoted GK is
  // priced off the 7-attr outfielder overall (the AI intake path below does pass the role).
  assert(landed.slot === 17 && landed.contract_years === 3 && [-1, 0, 1].includes(landed.foot)
      && landed.wage === game.playerWage(JSON.parse(landed.attrs), landed.age, JSON.parse(landed.personality ?? 'null')),
    'promotion appends to the bench on a 3-yr deal at the role-less playerWage, with a fresh foot');
  assert(academySize(humanTeamId) === 3 && youth.getAcademy(humanTeamId).every(p => p.id !== star.id),
    'the promoted prospect leaves the academy (4 -> 3)');

  // Ledger: "capped at the 24-man squad" — promotion refuses over the cap.
  const capDummies = padSquad(humanTeamId, market.SQUAD_MAX);
  const full = youth.promoteProspect(humanTeamId, youth.getAcademy(humanTeamId)[0].id);
  assert(full.ok === false && (full.error ?? '').includes(`squad full (max ${market.SQUAD_MAX})`)
      && squadSize(humanTeamId) === market.SQUAD_MAX && academySize(humanTeamId) === 3,
    'a full 24-man squad blocks promotion; the prospect stays in the academy');
  db.prepare(`DELETE FROM players WHERE id IN (${capDummies.map(() => '?').join(',')})`).run(...capDummies);
  assert(squadSize(humanTeamId) === 18, 'cap-test fillers removed cleanly (back to 18, slots 0..17 intact)');

  // ── ROLLOVER PASS 1: RETIREMENT + INTAKE (youthAndRetirement on div 2) ──────
  // Fixture surgery, one behaviour per AI club:
  //   aiA: three vets (39/38/37) — all clear the floor, so all three retire, oldest first.
  //   aiB: cut to 12 men, FIVE vets (40..44) — the floor guard lets exactly one go per season.
  //   aiC: padded to 23 — cap leaves room for exactly 1 intake teen.
  //   aiD: padded to 24 — cap admits 0 (the ledger's "every club brings through 2" bends here).
  //   aiE: the STARTING GK (slot 0) retires — removePlayerFromSquad must backfill the XI on-role.
  const [aiA, aiB, aiC, aiD, aiE, aiF, aiG] = aiTeams;
  const vetAges = [39, 38, 37];
  const aiAVets = db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY slot LIMIT 3').all(aiA) as { id: number; name: string }[];
  aiAVets.forEach((v, i) => db.prepare('UPDATE players SET age = ? WHERE id = ?').run(vetAges[i], v.id));
  db.prepare('DELETE FROM players WHERE team_id = ? AND slot >= 12').run(aiB);   // 17 -> 12 men, slots 0..11
  const aiBVets = db.prepare('SELECT id, name FROM players WHERE team_id = ? AND slot >= 7 ORDER BY slot').all(aiB) as { id: number; name: string }[];
  aiBVets.forEach((v, i) => db.prepare('UPDATE players SET age = ? WHERE id = ?').run(40 + i, v.id));   // 40..44, oldest = slot 11
  padSquad(aiC, 23);
  padSquad(aiD, market.SQUAD_MAX);
  assert((db.prepare('SELECT role FROM players WHERE team_id = ? AND slot = 0').get(aiE) as { role: string }).role === 'GK',
    'sanity: slot 0 is the starting keeper (ROLE_SLOTS)');
  const aiEGk = db.prepare('SELECT id, name FROM players WHERE team_id = ? AND slot = 0').get(aiE) as { id: number; name: string };
  db.prepare('UPDATE players SET age = 41 WHERE id = ?').run(aiEGk.id);
  // Human academy: one prospect ages 20 -> 21 this tick, so he must graduate out (the release).
  const leaver = youth.getAcademy(humanTeamId)[2];
  db.prepare('UPDATE youth_prospects SET age = 20 WHERE id = ?').run(leaver.id);
  const before = new Map((db.prepare('SELECT id, age, attrs, potential FROM youth_prospects WHERE team_id = ?').all(humanTeamId) as
    { id: number; age: number; attrs: string; potential: number | null }[]).map(p => [p.id, p]));
  const maxPlayerBefore = maxId('players');
  const maxProspectBefore = maxId('youth_prospects');
  const maxFaBefore = maxId('free_agents');
  const div1Before = count('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = ?', div1Id);

  const events = youth.youthAndRetirement(div2Id);

  // Ledger: "players aged >=37 retire (leave the game, floor-guarded to never drop below a
  // legal XI)". aiA: all three vets go, oldest first; the retirees vanish from the game
  // entirely (no free-agent row — that path belongs to release, not retirement).
  const retiredOf = (teamId: number) => events.filter(e => e.teamId === teamId && e.type === 'retired');
  const intakeOf = (teamId: number) => events.filter(e => e.teamId === teamId && e.type === 'intake');
  assert(events.every(e => (e.type === 'retired' || e.type === 'intake') && (e.teamId === humanTeamId || aiTeams.includes(e.teamId))),
    'youthAndRetirement reports only retired/intake events, only for the league it was given');
  assert(retiredOf(aiA).map(e => e.age).join(',') === '39,38,37' && retiredOf(aiA).map(e => e.player).join(',') === aiAVets.map(v => v.name).join(','),
    `aiA: all three vets (39/38/37) retire, oldest first (got ${retiredOf(aiA).map(e => e.age).join(',')})`);
  assert(count('SELECT COUNT(*) AS n FROM players WHERE age >= 37 AND team_id != ?', aiB) === 0 && maxId('free_agents') === maxFaBefore,
    'retirees leave the GAME (not the free-agent pool); only aiB\'s floor-protected vets remain anywhere');
  assert(squadSize(aiA) === 16, `aiA: 17 - 3 retired + 2 intake = 16 (got ${squadSize(aiA)})`);

  // The floor guard: 12 men, five vets, but canRetire = 12 - SQUAD_MIN = 1 — only the OLDEST
  // (44) goes; the other four play on past 40 rather than gut the squad.
  const aiBGone = retiredOf(aiB);
  assert(aiBGone.length === 1 && aiBGone[0].age === 44 && aiBGone[0].player === aiBVets[4].name,
    `aiB floor guard: exactly one of five vets retires — the oldest (got ${aiBGone.length} @ ${aiBGone[0]?.age})`);
  assert(count('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND age >= 40', aiB) === 4 && squadSize(aiB) === 13,
    'aiB keeps its four younger vets and refills: 12 - 1 + 2 intake = 13');
  assert(aiTeams.every(t => squadSize(t) >= market.SQUAD_MIN), 'no club ever drops below the legal-XI floor of 11');

  // Ledger: "capped at the 24-man squad" — the AI intake clamp. (Ledger says "EVERY club
  // brings through 2"; a club at the cap actually brings through 0 — asserted per the code.)
  assert(intakeOf(aiC).length === 1 && squadSize(aiC) === market.SQUAD_MAX, 'aiC at 23: the cap admits exactly one intake teen (-> 24)');
  assert(intakeOf(aiD).length === 0 && squadSize(aiD) === market.SQUAD_MAX, 'aiD at 24: the cap admits none');
  assert(aiTeams.every(t => squadSize(t) <= market.SQUAD_MAX), 'no club ends above the 24-man cap');

  // Ledger: "market.ts removePlayerFromSquad is shared by retirement + release" — retiring the
  // slot-0 keeper backfills the XI on-role from the bench and renumbers the squad.
  assert(retiredOf(aiE).length === 1 && retiredOf(aiE)[0].player === aiEGk.name && squadSize(aiE) === 18,
    'aiE: the 41-y/o starting keeper retires (17 - 1 + 2 = 18)');
  assert(count('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND slot < 11 AND role = ?', aiE, 'GK') >= 1,
    'the vacated XI keeper slot is backfilled on-role (removePlayerFromSquad shared with release)');
  for (const t of [...aiTeams, humanTeamId]) {
    const n = squadSize(t);
    assert(count('SELECT COUNT(DISTINCT slot) AS n FROM players WHERE team_id = ? AND slot BETWEEN 0 AND ?', t, n - 1) === n,
      `squad slots renumber contiguously 0..${n - 1} after retirement + intake (team ${t})`);
  }

  // Ledger: "every club brings through YOUTH_INTAKE (2) prospects" — human 2 (to the academy),
  // aiA/aiB/aiE/aiF/aiG 2 each (to the squad), aiC 1, aiD 0 => 13 intake, 5 retirements.
  assert(intakeOf(humanTeamId).length === 2 && [aiF, aiG].every(t => intakeOf(t).length === 2),
    'unconstrained clubs bring through exactly YOUTH_INTAKE (2)');
  assert(events.filter(e => e.type === 'intake').length === 13 && events.filter(e => e.type === 'retired').length === 5,
    `league totals: 13 intake + 5 retired (got ${events.filter(e => e.type === 'intake').length}/${events.filter(e => e.type === 'retired').length})`);

  // AI intake path: "raw teens (attrs 40-55) with high genPotential upside, a neutral
  // personality ..., a wage + a 3-yr deal" — straight onto the bench, wage role-aware.
  const newPlayers = db.prepare('SELECT p.name, p.role, p.attrs, p.age, p.potential, p.personality, p.wage, p.contract_years, p.team_id FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id > ? AND t.league_id = ?').all(maxPlayerBefore, div2Id) as
    { name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; wage: number; contract_years: number; team_id: number }[];
  assert(newPlayers.length === 11 && newPlayers.every(p => p.team_id !== humanTeamId),
    `the 11 AI intake teens land in AI squads; the human intake never touches the senior squad (got ${newPlayers.length})`);
  assert(newPlayers.every(p => p.age >= 16 && p.age <= 18 && YOUTH_ROLE_SET.has(p.role) && attrsInBounds(JSON.parse(p.attrs))),
    'AI intake: 16-18 teens in engine roles within the attr clamp');
  assert(newPlayers.every(p => p.potential !== null && p.potential >= game.overall(JSON.parse(p.attrs), p.role) && p.potential <= 95),
    'AI intake teens carry genPotential upside (ceiling >= overall, <= 95)');
  assert(newPlayers.every(p => p.contract_years === 3 && p.wage === game.playerWage(JSON.parse(p.attrs), p.age, JSON.parse(p.personality ?? 'null'), p.role)),
    'AI intake teens sign the ledger\'s 3-yr deal at the role-aware playerWage');
  assert(newPlayers.every(p => isNeedyNeutral(p.personality, p.role)), 'AI intake regens start needy too (blank-backstory neutral personality)');

  // §2.9 academy at rollover: the tick "develops them each season" toward potential and the
  // 20-y/o graduates out at 21 (the release); then 2 fresh prospects regenerate the crop.
  assert(squadSize(humanTeamId) === 18 && retiredOf(humanTeamId).length === 0,
    'the human senior squad is untouched by the rollover (no vets, intake diverted to the academy)');
  assert(academySize(humanTeamId) === 4 && count('SELECT COUNT(*) AS n FROM youth_prospects WHERE id = ?', leaver.id) === 0,
    'the unpromoted 21-y/o graduates out; 3 - 1 + 2 new = 4 prospects remain');
  const afterTick = db.prepare('SELECT id, role, age, attrs, potential FROM youth_prospects WHERE team_id = ?').all(humanTeamId) as
    { id: number; role: string; age: number; attrs: string; potential: number | null }[];
  const survivors = afterTick.filter(p => before.has(p.id));
  assert(survivors.length === 2 && survivors.every(p => p.age === before.get(p.id)!.age + 1),
    'surviving prospects age exactly +1 in the academy');
  assert(survivors.every(p => sumAttrs(JSON.parse(p.attrs)) > sumAttrs(JSON.parse(before.get(p.id)!.attrs))
      && game.overall(JSON.parse(p.attrs), p.role) <= (p.potential ?? 0) && attrsInBounds(JSON.parse(p.attrs))),
    'the academy develops prospects: attrs drift up, capped by potential, inside the clamp');
  const fresh = afterTick.filter(p => !before.has(p.id));
  assert(fresh.length === 2 && fresh.every(p => p.id > maxProspectBefore && p.age >= 15 && p.age <= 18),
    'two fresh 15-18 regens restock the academy at rollover');
  assert(div1Before === count('SELECT COUNT(*) AS n FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = ?', div1Id),
    'the div-2 rollover never leaks into division 1');

  // ── DIVISION 1 (all-AI): "AI clubs keep the auto-intake-to-squad path" ──────
  const d1events = youth.youthAndRetirement(div1Id);
  assert(d1events.filter(e => e.type === 'intake').length === 16 && d1events.filter(e => e.type === 'retired').length === 0,
    'an all-AI division renews itself: 8 clubs x 2 intake, no fresh-world retirees (genAge caps at 34)');
  assert(count(`SELECT COUNT(*) AS n FROM youth_prospects WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?)`, div1Id) === 0,
    'AI clubs never use the academy table — their intake goes straight to the squad');

  // ── ROLLOVER PASS 2: "squads now renew across seasons" ──────────────────────
  // The floor guard drains a vet backlog gradually (aiB: 13 men now, so canRetire = 2), and
  // the academy keeps developing + regenerating season on season.
  const beforeIds = new Set(afterTick.map(p => p.id));
  const events2 = youth.youthAndRetirement(div2Id);
  const aiBGone2 = events2.filter(e => e.teamId === aiB && e.type === 'retired');
  assert(aiBGone2.map(e => e.age).join(',') === '43,42' && squadSize(aiB) === 13,
    `aiB season 2: headroom for two more retirements (43 then 42), refilled to 13 (got ${aiBGone2.map(e => e.age).join(',')})`);
  const academy2 = db.prepare('SELECT id, age FROM youth_prospects WHERE team_id = ?').all(humanTeamId) as { id: number; age: number }[];
  assert(academy2.length === 6 && academy2.filter(p => beforeIds.has(p.id)).length === 4,
    'season 2 academy: all 4 prospects survive (none reached 21) + 2 new = 6');
  assert(academy2.every(p => p.age < 21), 'the academy never holds a prospect at the leave age (21+ always graduates)');
  youth.seedAcademy(humanTeamId);
  assert(academySize(humanTeamId) === 6, 'seedAcademy after seasons of growth is a no-op (only tops up below 4, never trims)');

  console.log(`_youth_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
  process.chdir(os.tmpdir());   // step out first: Windows refuses to delete the current directory
  rmSync(CWD_DIR, { recursive: true, force: true });
}

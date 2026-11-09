// tools/_newgen_test.ts — engine-free regression for newgen/regeneration: how regens are MINTED
// (web/backend/youth.ts newProspect + the AI intake path, names from names.ts, attr bounds) and how
// they are later ENRICHED (game.ts fillMissingPersonalities). Recreated from the GAME_LAYER_NOTES.md
// ledger entry:
//
//   "Newgen backstories (LLM). game.ts fillMissingPersonalities(teamId) gives an LLM-written
//    backstory + matching dials to players lacking one (fresh academy regens, created with a
//    blank-backstory neutral personality), WITHOUT touching established/hand-edited players.
//    Kicked off in the background after a season rollover (void in /api/advance — off the
//    rollover tx, like team-creation's assignPersonalities). With no LLM, regens stay neutral
//    until the manager writes their story (which re-derives the dials — the coupling).
//    Verified by tools/_newgen_test.ts (targeting + non-destructive + regens start needy).
//    Note: only the user's regens are enriched (AI regens stay neutral — cost)."
//
// Each assertion group quotes the ledger claim it covers. The test pins the NO-LLM environment
// (TACTICS_LLM_PROVIDER=http with no key) so every personality call takes the deterministic
// fallback branch — the LLM-primary path is inherently non-deterministic and is NOT asserted here.
//
// DISCREPANCY vs a common (mis)reading of "targeting" (asserted per the code, see the role-draw
// group): regen minting does NOT target the retiring player's role or the club's weakest spot —
// youth.ts draws the role uniformly at random from YOUTH_ROLES, reading nothing about who retired.
// The ledger's "targeting" is fillMissingPersonalities' needy filter (!p || !p.backstory), which
// IS implemented and asserted below.
//
// Run: cd <repo> && npx tsx tools/_newgen_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run + chdir into the scratchpad BEFORE importing any backend
// module — the repo's web/backend/data/ is never touched. Deterministic: RNG-minted regens get
// invariant assertions (bounds, pool membership, full role support over 120 draws); the no-LLM
// personality paths are exact.

import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// db.ts resolves FOOTY_DB at IMPORT time (and mkdirs cwd/web/backend/data), so pin both BEFORE any
// backend module loads — which is why every backend import below is dynamic. Also pin the NO-LLM
// provider config (read per-call, but set it first for clarity): http provider + no key means
// llmReady() is {ok:false} and every generateSquadPersonalities/deriveTraits call takes the
// deterministic neutral/keyword fallback — the ledger's "With no LLM" branch.
const SCRATCH = path.join(os.tmpdir(), 'footy-test');
const TESTDB_DIR = path.join(SCRATCH, 'testdb');
const CWD_DIR = path.join(SCRATCH, `newgen_cwd_${process.pid}`);
mkdirSync(TESTDB_DIR, { recursive: true });
mkdirSync(CWD_DIR, { recursive: true });
process.chdir(CWD_DIR);
const DB_PATH = path.join(TESTDB_DIR, `newgen_${process.pid}_${Date.now()}.sqlite`);
process.env.FOOTY_DB = DB_PATH;
process.env.TACTICS_LLM_PROVIDER = 'http';
delete process.env.TACTICS_LLM_API_KEY;
delete process.env.TACTICS_LLM_LIVE_PROVIDER;

const { db } = await import('../web/backend/db.ts');
const game = await import('../web/backend/game.ts');
const youth = await import('../web/backend/youth.ts');
const per = await import('../web/backend/personality.ts');
const { randomPlayerName } = await import('../web/backend/names.ts');
const { llmReady } = await import('../web/backend/llm.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

const count = (sql: string, ...args: (number | string)[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);
const totalChanges = (): number => count('SELECT total_changes() AS n');
const squadSize = (teamId: number): number => count('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', teamId);

// ── names.ts pools, parsed from the SOURCE (FIRST/LAST are module-private) ────────────────────
// so "name generation draws from names.ts" is asserted against the real pools, not a stale copy.
const namesSrc = readFileSync(fileURLToPath(new URL('../web/backend/names.ts', import.meta.url)), 'utf8');
function pool(name: string): Set<string> {
  const m = namesSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`names.ts: could not find the ${name} pool`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
}
const FIRST = pool('FIRST');
const LAST = pool('LAST');
const nameFromPools = (name: string): boolean => {
  const sp = name.indexOf(' ');
  return sp > 0 && FIRST.has(name.slice(0, sp)) && LAST.has(name.slice(sp + 1));
};

// The blank-backstory neutral personality every regen is born with — byte-equal to
// defaultPersonality (name is ignored by it), which is also what the no-LLM fallback writes.
const neutralJson = (role: string): string => JSON.stringify(per.defaultPersonality('', role));
// fillMissingPersonalities' needy filter, replicated verbatim: !p || !p.backstory.
const isNeedy = (personalityJson: string | null): boolean => {
  const p = personalityJson ? JSON.parse(personalityJson) as { backstory?: string } : null;
  return !p || !p.backstory;
};
const ATTR_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina', 'handling', 'height'];
const attrsExact = (attrs: Record<string, number>): boolean => {
  const keys = Object.keys(attrs);
  return keys.length === ATTR_KEYS.length && ATTR_KEYS.every(k => Number.isInteger(attrs[k]) && attrs[k] >= 30 && attrs[k] <= 95);
};
const YOUTH_ROLE_SET = new Set(['GK', 'FB', 'CB', 'CM', 'WM', 'CF']);

// Byte-snapshot every player row of a league (all columns, keyed by id) for before/after diffs.
type Row = Record<string, unknown>;
function snapLeague(leagueId: number, dropSlot = false): Map<number, string> {
  const rows = db.prepare('SELECT * FROM players WHERE team_id IN (SELECT id FROM teams WHERE league_id = ?) ORDER BY id')
    .all(leagueId) as unknown as Row[];
  return new Map(rows.map(r => {
    const { slot, ...rest } = r;
    void slot;
    return [Number(r.id), JSON.stringify(dropSlot ? rest : r)];
  }));
}
function snapTeam(teamId: number): Map<number, string> {
  const rows = db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY id').all(teamId) as unknown as Row[];
  return new Map(rows.map(r => [Number(r.id), JSON.stringify(r)]));
}

try {
  // ── SANITY: the no-LLM branch is pinned ─────────────────────────────────────
  // Ledger: "With no LLM, regens stay neutral" — every personality call below must take the
  // deterministic fallback, or nothing else in this file is meaningful.
  assert(llmReady().ok === false, 'no-LLM pinned: llmReady() must be not-ok (http provider, no key)');

  // ── NAME GENERATION DRAWS FROM names.ts ─────────────────────────────────────
  // names.ts: "Fake name pools — no real players/clubs (copyright)." randomPlayerName is the one
  // seam every regen (academy + AI intake) is named through.
  assert(FIRST.size >= 30 && LAST.size >= 30, `names.ts pools parsed and substantial (got ${FIRST.size}/${LAST.size})`);
  const drawn = Array.from({ length: 300 }, () => randomPlayerName());
  assert(drawn.every(nameFromPools), 'every randomPlayerName draw is "<FIRST> <LAST>" from the names.ts pools');
  const firsts = new Set(drawn.map(n => n.slice(0, n.indexOf(' '))));
  const lasts = new Set(drawn.map(n => n.slice(n.indexOf(' ') + 1)));
  assert(firsts.size >= 20 && lasts.size >= 20, `the draw spans the pools, not one constant name (got ${firsts.size}/${lasts.size} distinct)`);

  // ── WORLD SETUP ─────────────────────────────────────────────────────────────
  const userId = Number(db.prepare("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('newgen_test', 'x', 'x', 0)").run().lastInsertRowid);
  const { leagueId: div2Id, teamId: humanTeamId } = game.newSeasonForUser(userId, 'newgen_test', 'Newgen United', game.DEFAULT_TACTICS);
  const aiTeams = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND user_id IS NULL ORDER BY id').all(div2Id) as { id: number }[]).map(r => r.id);
  assert(aiTeams.length === 7 && squadSize(humanTeamId) === 17, `sanity: 7 AI clubs beside the human, 17-man human squad (got ${aiTeams.length}/${squadSize(humanTeamId)})`);
  // game.ts createTeam seeds players with NO personality column at all — so a FRESH world is
  // 100% needy by fillMissingPersonalities' !p arm (this is why claim-a-club backfills: index.ts
  // "they were seeded blank for AI"). assignPersonalities only runs from the HTTP signup route.
  assert(count('SELECT COUNT(*) AS n FROM players WHERE personality IS NOT NULL') === 0,
    'fresh squads are seeded with personality NULL — the entire new world matches the needy filter');
  assert(count('SELECT COUNT(*) AS n FROM players WHERE age >= 37') === 0,
    'sanity: genAge caps at 34, so the first rollover below retires nobody (clean non-destructive pass)');

  // ── REGENS START NEEDY (academy minting path) ───────────────────────────────
  // Ledger: "fresh academy regens, created with a blank-backstory neutral personality". Mint a
  // large sample through the exported seam (seedAcademy tops up to n via newProspect).
  youth.seedAcademy(humanTeamId, 120);
  const prospects = db.prepare('SELECT name, role, attrs, age, potential, personality FROM youth_prospects WHERE team_id = ?').all(humanTeamId) as unknown as
    { name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null }[];
  assert(prospects.length === 120, `seedAcademy(team, 120) minted 120 prospects (got ${prospects.length})`);
  assert(prospects.every(p => nameFromPools(p.name)), 'every regen is named through names.ts (first+last both in the pools)');
  assert(prospects.every(p => p.age >= 15 && p.age <= 18), 'academy regens are 15-18 (the 15 + [0,4) roll)');
  assert(prospects.every(p => YOUTH_ROLE_SET.has(p.role)), 'every regen role is one of the six engine YOUTH_ROLES');
  // DISCREPANCY (asserted per the code): the role is a UNIFORM Math.random draw over YOUTH_ROLES —
  // newProspect reads nothing about the club's needs or any retiring player, so over 120 draws all
  // six roles appear (P(miss) ~ 2e-9). There is no "regen targets the retiree's role" mechanism.
  assert(new Set(prospects.map(p => p.role)).size === 6,
    'the role draw has full uniform support: all six roles appear across 120 mints (no targeting)');
  assert(prospects.every(p => attrsExact(JSON.parse(p.attrs))),
    'attr bounds: exactly the 8 skill attrs + height, integers inside the 30..95 clamp');
  // "regens start needy" in the numeric sense too: base 38..53 + jitter(<6) + the worst role-bias
  // mean (CM ~ +6.6) bounds overall at 66 — far below the 95 cap, real headroom guaranteed.
  const ovOf = (p: { attrs: string; role: string }): number => game.overall(JSON.parse(p.attrs), p.role);
  assert(prospects.every(p => ovOf(p) >= 30 && ovOf(p) <= 66),
    'regens start LOW: academy overall stays in [30, 66] (raw 38..53 base)');
  // genPotential: youth = 28 - age >= 10 at 15..18, headroom = round(youth * (0.4 + rand*0.9)) —
  // so 4..17, and the 95 cap can never bite at these overalls: strict, bounded headroom.
  assert(prospects.every(p => p.potential !== null && p.potential - ovOf(p) >= 4 && p.potential - ovOf(p) <= 17 && p.potential <= 95),
    'regens start with HEADROOM: potential - overall in [4, 17], under the 95 ceiling');
  assert(prospects.every(p => p.personality === neutralJson(p.role)),
    'regens start needy: personality is byte-equal to the blank-backstory neutral defaultPersonality');
  assert(prospects.every(p => isNeedy(p.personality)),
    'and therefore every fresh regen matches fillMissingPersonalities\' needy filter (!p || !p.backstory)');

  // ── NON-DESTRUCTIVE MINTING (AI intake at rollover, nobody retires) ─────────
  // youth.ts: AI clubs "drop raw teenagers straight onto the bench". Snapshot every player row in
  // the division byte-for-byte: minting regens must only APPEND — no existing row may change.
  const beforeQuiet = snapLeague(div2Id);
  const maxIdQuiet = count('SELECT COALESCE(MAX(id), 0) AS n FROM players');
  const quietEvents = youth.youthAndRetirement(div2Id);
  assert(quietEvents.every(e => e.type === 'intake'), 'no retirements fired (fresh world), only intake events');
  const afterQuiet = snapLeague(div2Id);
  assert([...beforeQuiet].every(([id, row]) => afterQuiet.get(id) === row),
    'NON-DESTRUCTIVE: every pre-existing player row is byte-identical after the intake (all columns)');
  const teens = db.prepare('SELECT team_id, name, role, attrs, age, potential, personality, wage, contract_years FROM players WHERE id > ?').all(maxIdQuiet) as unknown as
    { team_id: number; name: string; role: string; attrs: string; age: number; potential: number | null; personality: string | null; wage: number; contract_years: number }[];
  assert(teens.length === 14 && teens.every(t => t.team_id !== humanTeamId),
    `7 AI clubs x 2 intake teens appended, none onto the human squad (got ${teens.length})`);
  assert(teens.every(t => t.age >= 16 && t.age <= 18 && YOUTH_ROLE_SET.has(t.role) && attrsExact(JSON.parse(t.attrs))),
    'AI intake regens: 16-18, engine roles, attrs inside the exact-keys 30..95 clamp');
  assert(teens.every(t => ovOf(t) <= 68 && t.potential !== null && t.potential - ovOf(t) >= 4 && t.potential - ovOf(t) <= 16),
    'AI intake regens are needy too: overall <= 68 (raw 40..55 base) with 4..16 headroom');
  assert(teens.every(t => nameFromPools(t.name)), 'AI intake regens are also named through names.ts');
  assert(teens.every(t => t.personality === neutralJson(t.role) && isNeedy(t.personality)),
    'AI intake regens carry the same blank-backstory neutral personality (needy)');
  assert(teens.every(t => t.contract_years === 3 && t.wage === game.playerWage(JSON.parse(t.attrs), t.age, JSON.parse(t.personality!), t.role)),
    'AI intake regens sign 3-yr deals at the role-aware playerWage');
  assert(squadSize(humanTeamId) === 17 && count('SELECT COUNT(*) AS n FROM youth_prospects WHERE team_id = ?', humanTeamId) === 122,
    'the human intake is diverted to the academy (squad stays 17; 120 + 2 prospects)');

  // ── A RETIREMENT: replacement is appended, everyone else untouched ──────────
  // The regen "replacing" a retiree is just the same untargeted intake: retire one vet and assert
  // the surgery is minimal — only his club's rows change, and only their slot (renumbering).
  const aiX = aiTeams[0];
  const vet = db.prepare('SELECT id, name, role FROM players WHERE team_id = ? AND slot = 0').get(aiX) as { id: number; name: string; role: string };
  db.prepare('UPDATE players SET age = 38 WHERE id = ?').run(vet.id);
  const beforeRet = snapLeague(div2Id);
  const beforeRetNoSlot = snapLeague(div2Id, true);
  const retEvents = youth.youthAndRetirement(div2Id);
  const retired = retEvents.filter(e => e.type === 'retired');
  assert(retired.length === 1 && retired[0].player === vet.name && count('SELECT COUNT(*) AS n FROM players WHERE id = ?', vet.id) === 0,
    'exactly the one 38-y/o vet retires and his row leaves the game');
  const afterRet = snapLeague(div2Id);
  const afterRetNoSlot = snapLeague(div2Id, true);
  const aiXIds = new Set((db.prepare('SELECT id FROM players WHERE team_id = ?').all(aiX) as { id: number }[]).map(r => r.id));
  assert([...beforeRet].every(([id, row]) => id === vet.id || aiXIds.has(id) || afterRet.get(id) === row),
    'NON-DESTRUCTIVE around a retiree: every club except his is byte-identical, slots included');
  assert([...beforeRetNoSlot].every(([id, row]) => id === vet.id || !aiXIds.has(id) || afterRetNoSlot.get(id) === row),
    'his club\'s survivors change ONLY slot (removePlayerFromSquad renumbers; no attr/wage/personality churn)');
  // DISCREPANCY (cont.): the two teens who arrive after a GK retires are the same uniform role
  // draw — nothing reads vet.role. Assert what the code guarantees: pool membership only (plus a
  // statistically-certain spread: 14 draws over 6 roles land on >= 3 distinct, P(fail) ~ 3e-6).
  const maxIdRet = Math.max(...beforeRet.keys());
  const retIntakeRoles = (db.prepare('SELECT role FROM players WHERE id > ?').all(maxIdRet) as { role: string }[]).map(r => r.role);
  assert(retIntakeRoles.length === 14 && retIntakeRoles.every(r => YOUTH_ROLE_SET.has(r)) && new Set(retIntakeRoles).size >= 3,
    'replacement regens draw roles from YOUTH_ROLES with no reference to the retiree\'s role');

  // ── fillMissingPersonalities: TARGETING + NON-DESTRUCTIVE ───────────────────
  // Ledger: "gives ... backstory + matching dials to players LACKING one ... WITHOUT touching
  // established/hand-edited players." Fixture on the all-NULL human squad: two established players
  // (story + coupled dials), one hand-DIALED but story-less player, fourteen untouched NULLs.
  const story0 = 'A model professional who captains every side he plays for.';
  const est0 = JSON.stringify({ traits: per.deriveTraitsFromText(story0, 'Leads.', 'CM'), nationality: 'Testland', backstory: story0, tagline: 'Leads.' });
  const story1 = 'A hothead, streaky, but clutch on the big occasion.';
  const est1 = JSON.stringify({ traits: per.deriveTraitsFromText(story1, '', 'CF'), nationality: 'Elsewhere', backstory: story1, tagline: '' });
  const dialedNoStory = JSON.stringify({ traits: { temperament: 50, criticismResponse: 50, praiseResponse: 50, bigGame: 50, consistency: 50, leadership: 50, professionalism: 50, ego: 90 }, nationality: 'Nowhere', backstory: '', tagline: 'Me first.' });
  const setPer = db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?');
  setPer.run(est0, humanTeamId, 0);
  setPer.run(est1, humanTeamId, 1);
  setPer.run(dialedNoStory, humanTeamId, 2);
  const beforeFill = snapTeam(humanTeamId);
  const beforeFillNoPer = new Map([...beforeFill].map(([id, row]) => { const { personality, ...rest } = JSON.parse(row) as Row; void personality; return [id, JSON.stringify(rest)]; }));
  const aiBeforeFill = snapLeague(div2Id);
  await game.fillMissingPersonalities(humanTeamId);
  const humanRows = db.prepare('SELECT id, slot, role, personality FROM players WHERE team_id = ? ORDER BY slot').all(humanTeamId) as unknown as
    { id: number; slot: number; role: string; personality: string | null }[];
  const afterFill = snapTeam(humanTeamId);
  assert(afterFill.get(humanRows[0].id) === beforeFill.get(humanRows[0].id) && afterFill.get(humanRows[1].id) === beforeFill.get(humanRows[1].id),
    'TARGETING: both established players (backstory present) are byte-identical — never touched');
  assert(humanRows.filter(r => r.slot >= 3).every(r => r.personality === neutralJson(r.role)),
    'every NULL-personality player was filled — with the exact neutral default (the no-LLM fallback), so regens "stay neutral"');
  // DISCREPANCY (asserted per the code): the needy filter is !backstory, so a player with
  // hand-set DIALS but no story is "needy" — and the no-LLM fallback OVERWRITES his dials (ego 90
  // -> 50) and nationality with the neutral default. "Stay neutral" holds only because regens are
  // born neutral; the fill is a real rewrite of every needy row, not a skip.
  assert(humanRows[2].personality === neutralJson(humanRows[2].role),
    'a hand-dialed but story-less player is reset to neutral by the no-LLM fill (the !backstory arm)');
  const afterFillNoPer = new Map([...afterFill].map(([id, row]) => { const { personality, ...rest } = JSON.parse(row) as Row; void personality; return [id, JSON.stringify(rest)]; }));
  assert(beforeFill.size === afterFill.size && [...beforeFillNoPer].every(([id, row]) => afterFillNoPer.get(id) === row),
    'NON-DESTRUCTIVE: the fill changes ONLY the personality column — attrs/age/wage/slot/etc byte-identical, no rows added or lost');
  const aiAfterFill = snapLeague(div2Id);
  assert(aiTeams.every(t => (db.prepare('SELECT id FROM players WHERE team_id = ?').all(t) as { id: number }[]).every(r => aiAfterFill.get(r.id) === aiBeforeFill.get(r.id))),
    'team-scoped: filling the human club leaves every AI club byte-identical ("only the user\'s regens are enriched — AI regens stay neutral")');
  await game.fillMissingPersonalities(humanTeamId);
  const afterFill2 = snapTeam(humanTeamId);
  assert([...afterFill].every(([id, row]) => afterFill2.get(id) === row),
    'a second no-LLM fill is a byte-identical fixed point (blank-backstory rows stay needy but rewrite to the same bytes)');

  // ── THE COUPLING: the manager writes the story → the dials re-derive ────────
  // Ledger: "regens stay neutral until the manager writes their story (which re-derives the dials
  // — the coupling)". PUT /api/player/:slot/story calls deriveTraits (LLM-primary) which, with no
  // LLM, is exactly deriveTraitsFromText — the deterministic keyword projection off the role base.
  assert(per.defaultPersonality('', 'GK').traits.leadership === 60 && per.defaultPersonality('', 'CB').traits.leadership === 60
      && per.defaultPersonality('', 'CM').traits.leadership === 50,
    'the neutral base every regen starts from: all-50 dials with the GK/CB leadership lean at 60');
  const graft = per.deriveTraitsFromText('grafter', '', 'CM');
  assert(graft.professionalism === 68 && graft.temperament === 50 && graft.leadership === 50 && graft.ego === 50,
    'one professionalism cue moves exactly that dial by CUE_STEP (50 -> 68), everything else stays base');
  const cool = per.deriveTraitsFromText('ice-cool', '', 'GK');
  assert(cool.temperament === 32 && cool.leadership === 60,
    'a down-cue subtracts CUE_STEP (temperament 50 -> 32) and the GK leadership lean survives derivation');
  const extreme = per.deriveTraitsFromText('calm composed unflappable serene level-headed, a model pro: professional, disciplined hard work grafter', '', 'CM');
  assert(extreme.temperament === 0 && extreme.professionalism === 100,
    'stacked cues clamp at the 0..100 dial bounds');
  const derived = await per.deriveTraits('Some Regen', 'WM', 'a quiet grafter', 'On his day.');
  assert(JSON.stringify(derived) === JSON.stringify(per.deriveTraitsFromText('a quiet grafter', 'On his day.', 'WM')),
    'with no LLM, deriveTraits IS the keyword projection (the always-available fallback)');
  // Write-through: give a needy regen a story with coupled dials (exactly what the story endpoint
  // persists) — he graduates out of the needy set and later fills leave him byte-identical.
  const slot3 = humanRows[3];
  const regenStory = 'A fiery talisman who thrives on criticism.';
  const regenPer = JSON.stringify({ traits: await per.deriveTraits('x', slot3.role, regenStory, ''), nationality: '', backstory: regenStory, tagline: '' });
  setPer.run(regenPer, humanTeamId, 3);
  await game.fillMissingPersonalities(humanTeamId);
  assert((db.prepare('SELECT personality FROM players WHERE id = ?').get(slot3.id) as { personality: string | null }).personality === regenPer,
    'once the manager writes the story, the regen stops being needy — the next fill leaves him untouched');
  // With EVERY player storied, the fill early-returns: zero writes hit the database.
  for (const r of humanRows) {
    const cur = JSON.parse((db.prepare('SELECT personality FROM players WHERE id = ?').get(r.id) as { personality: string }).personality) as { backstory: string };
    if (!cur.backstory) { cur.backstory = 'Settled in quietly.'; db.prepare('UPDATE players SET personality = ? WHERE id = ?').run(JSON.stringify(cur), r.id); }
  }
  const writesBefore = totalChanges();
  await game.fillMissingPersonalities(humanTeamId);
  assert(totalChanges() === writesBefore,
    'a fully-storied squad early-returns: the fill performs ZERO database writes');

  // ── CONTRAST: assignPersonalities regenerates the WHOLE squad ───────────────
  // Ledger: "like team-creation's assignPersonalities" — but that one is "idempotent-ish:
  // regenerates the whole squad", clobbering established players too. The contrast is exactly why
  // the rollover path calls fillMissingPersonalities and not this.
  const aiY = aiTeams[1];
  db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = 0').run(est0, aiY);
  await game.assignPersonalities(aiY);
  const aiYRows = db.prepare('SELECT role, personality FROM players WHERE team_id = ?').all(aiY) as unknown as { role: string; personality: string | null }[];
  assert(aiYRows.length > 0 && aiYRows.every(r => r.personality === neutralJson(r.role)),
    'assignPersonalities is the blunt tool: it rewrites EVERY player (established included) — fillMissingPersonalities\' targeting is the newgen-safe path');

  console.log(`_newgen_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
  process.chdir(os.tmpdir());   // step out first: Windows refuses to delete the current directory
  rmSync(CWD_DIR, { recursive: true, force: true });
}

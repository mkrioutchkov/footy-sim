// tools/_personality_test.ts — engine-free regression for the PERSONALITY pillar: the 8 trait
// dials themselves (web/backend/personality.ts) and EVERY load-bearing consumer that reads them.
// The last suite recreated after .gitignore's blanket `_*` pattern ate the original test tree.
// Recreated from the GAME_LAYER_NOTES.md ledger entries it pins:
//
//   "5.1 Story-driven traits. The trait dials are now first-class as the machine-readable
//    projection of a player's backstory. personality.ts deriveTraits (LLM primary) +
//    deriveTraitsFromText (deterministic keyword projection) re-derive the 8 dials from the text
//    ... so the training rate (training.ts reads professionalism/consistency) and transfer value
//    (game.ts reads the dials) move with the story. Verified by tools/_personality_test.ts (14)"
//   "personality nudge: high professionalism+consistency+bigGame up to +15%, high ego down to -8%."
//   "wage ≈ 10% of the ego-neutral value + ego premium ... a diva costs more to PAY"
//   "5.2 ... a big ego wants up to +15%" (contracts.ts renewal demand)
//   "§2.11: a strong captain steadies the room" (morale.ts captainLeadership)
//   "each player reacts according to his personality dials" (teamtalk.ts)
//   "the SAME personality-gated math press conferences use" (interaction.ts / press.ts)
//   "A player agitating to leave — deeply unhappy, a benched big ego" (concerns.ts)
//   "Reads the squad's AGGREGATE personality (how bold / aggressive / patient the dressing room
//    is) so different clubs get different default plans without any rng" (manager/plan.ts)
//
// Every group quotes the claim it covers. The LLM-primary branches are inherently
// non-deterministic and are NOT asserted; the suite pins the NO-LLM environment (http provider,
// no key) so every personality call takes its deterministic fallback — which is also the branch
// an offline save actually runs. Nothing here uses Math.random, so every number is EXACT.
//
// SCOPE / non-overlap: harmony's leader-pro-disruptive reading of the dials is pinned by
// _harmony_test.ts; training's diligence band + mirror by _training_test.ts; the newgen fill /
// story-write coupling by _newgen_test.ts; the renewal offer flow by _contracts_test.ts. This
// file pins what those do NOT: the cue table itself, generation/evolution arity + ordering, the
// value/wage split, WHICH dials each consumer is allowed to read, and the five consumers that had
// no regression at all (morale captaincy, team talk, 1-to-1 interaction, concerns, AI identity).
//
// DISCREPANCIES vs the ledger / the code's own comments, asserted PER THE CODE and reported:
//   D1  Four keyword cues are shadowed by their own opposites' substrings and so are DEAD or
//       LEAKY: 'unprofessional' and 'undisciplined' contain the up-cues 'professional' /
//       'disciplin', 'inconsistent' contains the up-cue 'consistent' (all three net to ZERO
//       movement — a backstory calling a man unprofessional reads as perfectly neutral), and
//       'responds to a rocket' contains the consistency up-cue 'rock' (so it moves TWO dials).
//   D2  The notes say the wage is "≈8% of the ego-neutral value" in §5.2 and "≈10%" in the
//       pillar-1 economy section. game.ts uses 0.10. Pinned at 10%.
//   D3  concerns.ts says the reassure lift is "~3..13"; the formula's real range is 1..15 (a
//       maxed praise-hungry ego with an ice-cool head gets 15). Pinned at the formula.
//   D4  manager/plan.ts's prose bands (60/40) and its DIRECTIVE bands (65/35) disagree, and the
//       2-directive cap can drop a directive the prose still promises — so a club can be told to
//       "keep it on the ground" by a brief that emits no keep_it_on_ground. Pinned as-is.
//
// Run: cd <repo> && npx tsx tools/_personality_test.ts   (exits non-zero on any failure).
// NOT YET CHAINED into `npm run test:game` — package.json was outside this change's edit domain.
// Add ` && tsx tools/_personality_test.ts` to that script to make it part of the gate.
// Isolation: a fresh temp sqlite + a scratch cwd pinned BEFORE any backend import, so neither
// web/backend/data/ nor any other suite's database is opened, read or written.

import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Traits } from '../web/backend/personality.ts';
import type { TalkTone } from '../web/backend/teamtalk.ts';
import type { InteractTone } from '../web/backend/interaction.ts';

// db.ts resolves FOOTY_DB and mkdirs <cwd>/web/backend/data at IMPORT time, so pin both BEFORE any
// backend module loads — which is why every backend import below is dynamic. The no-LLM provider
// config (http + no key) is read per call; set here so llmReady() is {ok:false} throughout.
const SCRATCH = '/tmp/claude-0/-home-user-footy-sim/710ecd1a-f780-5b5f-a4ef-27543513423b/scratchpad';
const TESTDB_DIR = path.join(SCRATCH, 'testdb');
const CWD_DIR = path.join(SCRATCH, `personality_cwd_${process.pid}`);
mkdirSync(TESTDB_DIR, { recursive: true });
mkdirSync(CWD_DIR, { recursive: true });
process.chdir(CWD_DIR);
const DB_PATH = path.join(TESTDB_DIR, `personality_${process.pid}_${Date.now()}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
process.env.FOOTY_DB = DB_PATH;
process.env.TACTICS_LLM_PROVIDER = 'http';
delete process.env.TACTICS_LLM_API_KEY;
delete process.env.TACTICS_LLM_LIVE_PROVIDER;

const { db } = await import('../web/backend/db.ts');
const { llmReady } = await import('../web/backend/llm.ts');
const per = await import('../web/backend/personality.ts');
const game = await import('../web/backend/game.ts');
const training = await import('../web/backend/training.ts');
const contracts = await import('../web/backend/contracts.ts');
const moraleMod = await import('../web/backend/morale.ts');
const teamtalk = await import('../web/backend/teamtalk.ts');
const press = await import('../web/backend/press.ts');
const interaction = await import('../web/backend/interaction.ts');
const concerns = await import('../web/backend/concerns.ts');
const mplan = await import('../web/backend/manager/plan.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────
// The canonical dial list, spelled out here rather than imported: a regression that ADDS or
// RENAMES a dial must fail this file, and it cannot do that if the expectation is the code.
const TRAIT_KEYS = ['temperament', 'criticismResponse', 'praiseResponse', 'bigGame',
  'consistency', 'leadership', 'professionalism', 'ego'] as const;
const CUE_STEP = 18;          // personality.ts CUE_STEP (module-private)
const NEUTRAL_BASE = 50;      // defaultPersonality's baseline for every dial
const LEADERLY_ROLES = ['GK', 'CB'];  // the two roles that lean to 60 leadership

const T = (o: Partial<Traits>): Traits => ({
  temperament: 50, criticismResponse: 50, praiseResponse: 50, bigGame: 50,
  consistency: 50, leadership: 50, professionalism: 50, ego: 50, ...o,
});
const P = (o: Partial<Traits>): { traits: Traits } => ({ traits: T(o) });
const flat = (v: number): Record<string, number> => ({
  speed: v, passing: v, creativity: v, shooting: v, tackling: v, positioning: v, stamina: v, handling: v, height: 55,
});
const ATTRS_JSON = JSON.stringify(flat(60));
const dialsWellFormed = (t: Traits): boolean =>
  Object.keys(t).length === TRAIT_KEYS.length
  && TRAIT_KEYS.every(k => Number.isInteger(t[k]) && t[k] >= 0 && t[k] <= 100);
const sameDials = (a: Traits, b: Traits): boolean => TRAIT_KEYS.every(k => a[k] === b[k]);

const count = (sql: string, ...args: (number | string)[]): number =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);
const totalChanges = (): number => count('SELECT total_changes() AS n');
function snapshotAll(): string {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  const dump: Record<string, unknown> = {};
  for (const t of tables) { dump[t.name] = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all(); }
  return JSON.stringify(dump);
}

try {
  // ── 0. THE NO-LLM BRANCH IS PINNED ─────────────────────────────────────────
  // Without this every "deterministic fallback" assertion below could silently be asserting an
  // LLM response instead. It is the precondition for the whole file.
  assert(llmReady().ok === false, 'no-LLM pinned: llmReady() must be not-ok (http provider, no key)');
  assert(process.cwd() === CWD_DIR, 'isolation: the suite runs from its own scratch cwd, so no repo data/ dir is created');

  // ── DB world for the consumer sections (built up front so the read-only proof spans them) ──
  const leagueId = Number(db.prepare("INSERT INTO leagues (name) VALUES ('Personality Test League')").run().lastInsertRowid);
  const insPlayer = db.prepare(
    "INSERT INTO players (team_id, slot, name, role, attrs, personality, morale) VALUES (?, ?, ?, 'CM', ?, ?, ?)",
  );
  let teamSeq = 0;
  function makeTeam(league: number, captainSlot: number | null = null): number {
    teamSeq += 1;
    return Number(db.prepare(
      "INSERT INTO teams (league_id, name, manager, tactics, created_at, captain_slot) VALUES (?, ?, 'AI', '{}', 0, ?)",
    ).run(league, `Personality Test ${teamSeq}`, captainSlot).lastInsertRowid);
  }
  const addPlayer = (teamId: number, slot: number, name: string, traits: Partial<Traits> | null, morale: number): void => {
    insPlayer.run(teamId, slot, name, ATTRS_JSON, traits === null ? null : JSON.stringify(P(traits)), morale);
  };

  // captainLeadership fixtures
  const capNoDials = makeTeam(leagueId);
  for (let i = 0; i < 3; i++) { addPlayer(capNoDials, i, `nd${i}`, null, 65); }
  const capAuto = makeTeam(leagueId);
  addPlayer(capAuto, 0, 'a', { leadership: 30 }, 65);
  addPlayer(capAuto, 1, 'b', { leadership: 90 }, 65);
  addPlayer(capAuto, 2, 'c', { leadership: 70 }, 65);
  const capPicked = makeTeam(leagueId, 0);
  addPlayer(capPicked, 0, 'a', { leadership: 30 }, 65);
  addPlayer(capPicked, 1, 'b', { leadership: 90 }, 65);
  const capPickedBlank = makeTeam(leagueId, 0);
  addPlayer(capPickedBlank, 0, 'a', null, 65);
  addPlayer(capPickedBlank, 1, 'b', { leadership: 90 }, 65);
  const capGone = makeTeam(leagueId, 7);
  addPlayer(capGone, 0, 'a', { leadership: 88 }, 65);
  const capCorrupt = makeTeam(leagueId);
  insPlayer.run(capCorrupt, 0, 'broken', ATTRS_JSON, '{not json', 65);
  addPlayer(capCorrupt, 1, 'b', { leadership: 20 }, 65);

  // moraleTick fixtures live in their OWN league (moraleTick sweeps a whole league).
  const tickLeague = Number(db.prepare("INSERT INTO leagues (name) VALUES ('Captain Tick League')").run().lastInsertRowid);
  const tickTeams = new Map<number, number>();
  // 200 is not a legal dial — deriveTraits/coerce clamp to 0..100 — but personality is a free-form
  // JSON blob, so a hand-edited or off-format one can carry it. It is the ONLY way to reach the
  // leaderBonus clamp (see the assertion below).
  for (const lead of [0, 50, 62, 63, 100, 200]) {
    const id = makeTeam(tickLeague, 0);
    addPlayer(id, 0, 'captain', { leadership: lead }, 65);
    addPlayer(id, 1, 'squad member', {}, 65);
    tickTeams.set(lead, id);
  }

  // team talk fixture
  const talkTeam = makeTeam(leagueId);
  addPlayer(talkTeam, 0, 'Praise Hungry', { praiseResponse: 100 }, 65);
  addPlayer(talkTeam, 1, 'Perfectly Average', {}, 65);
  addPlayer(talkTeam, 2, 'No Dials Yet', null, 65);
  addPlayer(talkTeam, 3, 'Hungry Diva', { praiseResponse: 100, ego: 100 }, 65);
  addPlayer(talkTeam, 4, 'Faint Ego', { ego: 61 }, 65);
  const talkOpponent = makeTeam(leagueId);
  addPlayer(talkOpponent, 0, 'opp', {}, 65);
  const fixtureId = Number(db.prepare(
    'INSERT INTO fixtures (league_id, round, home_team_id, away_team_id, seed) VALUES (?, 1, ?, ?, 1)',
  ).run(leagueId, talkTeam, talkOpponent).lastInsertRowid);

  // interaction fixture
  const chatTeam = makeTeam(leagueId);
  addPlayer(chatTeam, 0, 'Perfectly Average', {}, 50);
  addPlayer(chatTeam, 1, 'No Dials Yet', null, 50);
  addPlayer(chatTeam, 2, 'Thick Skinned', { criticismResponse: 100, temperament: 0 }, 50);
  addPlayer(chatTeam, 3, 'Sensitive Soul', { criticismResponse: 0, temperament: 100 }, 2);
  addPlayer(chatTeam, 4, 'Adoration Junkie', { praiseResponse: 100, ego: 100 }, 95);

  // concerns fixtures: slots 0..10 are the identity XI, 11+ are benched.
  const concernTeam = makeTeam(leagueId);
  addPlayer(concernTeam, 0, 'Starting Ego 80 @59', { ego: 80 }, 59);   // a STARTING big ego, unhappy
  for (let i = 1; i <= 10; i++) { addPlayer(concernTeam, i, `starter${i}`, {}, 70); }
  addPlayer(concernTeam, 11, 'Benched Ego 70', { ego: 70 }, 59);
  addPlayer(concernTeam, 12, 'Benched Ego 69', { ego: 69 }, 59);
  addPlayer(concernTeam, 13, 'Benched Ego 80 @60', { ego: 80 }, 60);
  addPlayer(concernTeam, 14, 'Benched Ego 80 @59', { ego: 80 }, 59);

  const reassureTeam = makeTeam(leagueId);
  for (let i = 0; i <= 10; i++) { addPlayer(reassureTeam, i, `starter${i}`, {}, 70); }
  addPlayer(reassureTeam, 11, 'Plain Ego', { ego: 80 }, 50);
  addPlayer(reassureTeam, 12, 'Max Lift', { ego: 100, praiseResponse: 100, temperament: 0 }, 50);
  addPlayer(reassureTeam, 13, 'Min Lift', { ego: 70, praiseResponse: 0, temperament: 100 }, 50);

  const snapBeforePure = snapshotAll();
  const writesBeforePure = totalChanges();

  // ══ 1. defaultPersonality — the neutral baseline every save falls back to ═══════════════════
  // personality.ts: "A neutral fallback so the game never blocks on the model."
  const dCM = per.defaultPersonality('Anyone', 'CM');
  assert(dialsWellFormed(dCM.traits), `defaultPersonality emits EXACTLY the 8 canonical dials as integers in 0..100 (got ${JSON.stringify(dCM.traits)})`);
  assert(TRAIT_KEYS.filter(k => k !== 'leadership').every(k => dCM.traits[k] === NEUTRAL_BASE) && dCM.traits.leadership === NEUTRAL_BASE,
    'an outfielder\'s neutral personality is all-50 — the identity for every downstream formula');
  assert(LEADERLY_ROLES.every(r => per.defaultPersonality('x', r).traits.leadership === 60),
    'GK and CB lean leaderly: leadership 60, not 50');
  assert(LEADERLY_ROLES.every(r => TRAIT_KEYS.filter(k => k !== 'leadership')
    .every(k => per.defaultPersonality('x', r).traits[k] === NEUTRAL_BASE)),
    'the GK/CB lean touches leadership ONLY — no other dial moves with role');
  assert(['CM', 'CF', 'FB', 'WM', ''].every(r => per.defaultPersonality('x', r).traits.leadership === NEUTRAL_BASE),
    'every other role (and an unknown one) stays on the neutral 50 leadership');
  assert(JSON.stringify(per.defaultPersonality('Alice', 'CM')) === JSON.stringify(per.defaultPersonality('Bob', 'CM')),
    'the name argument is ignored — two players in the same role get byte-identical neutral personalities');
  assert(dCM.nationality === '' && dCM.backstory === '' && dCM.tagline === '',
    'the neutral personality carries NO story: blank nationality/backstory/tagline (which is what makes a regen "needy")');

  // ══ 2. deriveTraitsFromText — the deterministic keyword projection ══════════════════════════
  // Ledger 5.1: "deriveTraitsFromText (deterministic keyword projection) re-derive the 8 dials
  // from the text". This is the always-available half of the text↔dial coupling.
  const proj = (text: string, tagline = '', role = 'CM'): Traits => per.deriveTraitsFromText(text, tagline, role);
  assert(dialsWellFormed(proj('')), 'the projection of empty text is still exactly the 8 well-formed dials');
  assert(sameDials(proj(''), per.defaultPersonality('', 'CM').traits),
    'no cues in the text => the role baseline, unchanged');
  assert(proj('', '', 'GK').leadership === 60, 'the GK role baseline survives the projection (the base is the START, not a reset)');
  const graft = proj('a grafter');
  assert(graft.professionalism === NEUTRAL_BASE + CUE_STEP,
    `one professionalism up-cue moves that dial by exactly CUE_STEP (50 -> 68), got ${graft.professionalism}`);
  assert(TRAIT_KEYS.filter(k => k !== 'professionalism').every(k => graft[k] === NEUTRAL_BASE),
    'and moves NOTHING else — a cue is scoped to its own dial');
  assert(proj('ice-cool').temperament === NEUTRAL_BASE - CUE_STEP,
    'a down-cue subtracts CUE_STEP (temperament 50 -> 32)');
  assert(proj('A GRAFTER, ICE-COOL').professionalism === 68 && proj('A GRAFTER, ICE-COOL').temperament === 32,
    'cue matching is case-insensitive (the text is lowercased first)');
  assert(proj('', 'A born captain.').leadership === 68,
    'the TAGLINE is projected too — backstory and tagline are concatenated before matching');
  assert(proj('a grafter', 'a metronome').professionalism === 68 && proj('a grafter', 'a metronome').consistency === 68,
    'cues from both halves land together');
  const stacked = proj('a model pro: professional, disciplined hard work grafter, meticulous, diligent');
  assert(stacked.professionalism === 100, `stacked up-cues clamp at 100 (got ${stacked.professionalism})`);
  const buried = proj('calm, composed, unflappable, serene, level-headed, ice-cool, a cool head');
  assert(buried.temperament === 0, `stacked down-cues clamp at 0 (got ${buried.temperament})`);
  assert(proj('a model professional').professionalism === 86,
    'two overlapping up-cues both fire: "model professional" hits BOTH \'professional\' and \'model pro\' (+36)');

  // The cue TABLE itself, swept from source. TRAIT_CUES is module-private, so parse it out of
  // personality.ts (the same technique _newgen_test uses for names.ts) and check EVERY entry
  // actually moves its own dial by ±CUE_STEP and nothing else. This is the assertion that would
  // catch a cue filed under the wrong trait, a cue added to `up` that should be `down`, or a new
  // cue shadowed to death by an existing substring.
  const perSrc = readFileSync(fileURLToPath(new URL('../web/backend/personality.ts', import.meta.url)), 'utf8');
  const cueBlock = perSrc.match(/const TRAIT_CUES[^=]*=\s*\{([\s\S]*?)\n\};/);
  assert(cueBlock !== null, 'the TRAIT_CUES table was located in personality.ts (a parse failure must fail LOUDLY, not sweep an empty list)');
  const cueEntries = [...cueBlock![1].matchAll(/(\w+):\s*\{\s*up:\s*\[([^\]]*)\],\s*down:\s*\[([^\]]*)\]\s*\}/g)]
    .map(m => ({ trait: m[1] as keyof Traits, up: [...m[2].matchAll(/'([^']*)'/g)].map(x => x[1]), down: [...m[3].matchAll(/'([^']*)'/g)].map(x => x[1]) }));
  assert(cueEntries.length === TRAIT_KEYS.length && cueEntries.every(e => (TRAIT_KEYS as readonly string[]).includes(e.trait)),
    `the parsed cue table covers all 8 dials and only those (got ${cueEntries.map(e => e.trait).join(',')})`);
  assert(cueEntries.every(e => e.up.length >= 3 && e.down.length >= 3),
    'every dial can be pushed BOTH ways: at least 3 up-cues and 3 down-cues each');
  const allCues = cueEntries.flatMap(e => [...e.up, ...e.down]);
  assert(allCues.length >= 100 && new Set(allCues).size === allCues.length,
    `the table is substantial and duplicate-free (${allCues.length} cues, ${new Set(allCues).size} distinct)`);
  const cmBase = per.defaultPersonality('', 'CM').traits;
  const cueAnomalies: string[] = [];
  for (const e of cueEntries) {
    for (const [dir, list] of [['up', e.up], ['down', e.down]] as [string, string[]][]) {
      for (const cue of list) {
        const got = proj(cue);
        const moved = TRAIT_KEYS.filter(k => got[k] !== cmBase[k])
          .map(k => `${k}${got[k] - cmBase[k] > 0 ? '+' : ''}${got[k] - cmBase[k]}`).join(',');
        const want = `${e.trait}${dir === 'up' ? '+' : '-'}${CUE_STEP}`;
        if (moved !== want) { cueAnomalies.push(`${e.trait}/${dir}/${cue} -> [${moved}]`); }
      }
    }
  }
  // D1 — the four shadowed cues, frozen. A NEW shadowing (or a fix to one of these) fails here.
  assert(cueAnomalies.join(' | ') === [
    'professionalism/down/unprofessional -> []',
    'professionalism/down/undisciplined -> []',
    'consistency/down/inconsistent -> []',
    'criticismResponse/up/responds to a rocket -> [criticismResponse+18,consistency+18]',
  ].join(' | '), `exactly four cues misbehave, and they are the four known substring shadows (got: ${cueAnomalies.join(' | ') || 'none'})`);
  assert(proj('utterly unprofessional and undisciplined').professionalism === NEUTRAL_BASE,
    'D1 in the wild: a backstory calling a man unprofessional AND undisciplined projects to a PERFECTLY NEUTRAL professionalism');
  assert(proj('maddeningly inconsistent').consistency === NEUTRAL_BASE - CUE_STEP,
    'D1 is substring-specific: \'inconsistent\' is dead but \'maddening\' still drops consistency, so the phrase survives');
  assert(proj('he responds to a rocket').consistency === NEUTRAL_BASE + CUE_STEP,
    'D1 leak: the criticism cue \'responds to a rocket\' also lifts CONSISTENCY (it contains the \'rock\' cue)');
  assert(proj('Compared to Diego in his pomp').ego === NEUTRAL_BASE + CUE_STEP,
    'over-trigger pinned: the bare substring \'ego\' fires on any word containing it (e.g. a name like Diego)');
  const corpus = [...allCues, '', 'a hothead, streaky, but clutch', allCues.join(' ')];
  assert(corpus.length > 100 && corpus.every(txt => dialsWellFormed(proj(txt, txt))),
    `the projection is TOTAL: every cue phrase (and all of them at once) yields 8 integer dials inside 0..100 (${corpus.length} texts)`);

  // ══ 3. deriveTraits — the LLM-primary re-derivation, offline ════════════════════════════════
  // Ledger 5.1: "deriveTraits (LLM primary) + deriveTraitsFromText ... re-derive the 8 dials".
  const derived = await per.deriveTraits('Someone', 'WM', 'a quiet grafter', 'On his day.');
  assert(sameDials(derived, proj('a quiet grafter', 'On his day.', 'WM')),
    'with no LLM, deriveTraits IS the keyword projection — same text, same role, same dials');
  assert(derived.professionalism === 68 && derived.leadership === 32 && derived.consistency === 32,
    `and the projection is doing real work here: grafter +18 prof, quiet -18 lead, "on his day" -18 cons (got ${JSON.stringify(derived)})`);
  const fromTagline = await per.deriveTraits('Someone', 'CM', '', 'A born captain.');
  assert(fromTagline.leadership === 68,
    'an empty backstory still re-derives off the TAGLINE (the short-circuit hands the tagline to the fallback)');
  const gkDerived = await per.deriveTraits('Keeper', 'GK', 'commands his box', '');
  assert(gkDerived.leadership === 60 + CUE_STEP,
    `re-derivation starts from the ROLE baseline, so a commanding keeper lands at 78 (got ${gkDerived.leadership})`);

  // ══ 4. generateSquadPersonalities — arity + order, offline ══════════════════════════════════
  // personality.ts: "Always returns exactly players.length entries — any the model omits or
  // mangles fall back to neutral."
  const squadIn = [
    { name: 'Keeper', role: 'GK', attrs: flat(70) },
    { name: 'Anchor', role: 'CM', attrs: flat(65) },
    { name: 'Stopper', role: 'CB', attrs: flat(68) },
    { name: 'Poacher', role: 'CF', attrs: flat(72) },
  ];
  const generated = await per.generateSquadPersonalities(squadIn);
  assert(generated.length === squadIn.length, `exactly one personality per input player (expected ${squadIn.length}, got ${generated.length})`);
  assert(generated.every((g, i) => JSON.stringify(g) === JSON.stringify(per.defaultPersonality(squadIn[i].name, squadIn[i].role))),
    'with no LLM every entry is byte-equal to that player\'s neutral default');
  assert(generated[0].traits.leadership === 60 && generated[2].traits.leadership === 60
      && generated[1].traits.leadership === 50 && generated[3].traits.leadership === 50,
    'entries stay IN ORDER — the GK (0) and CB (2) carry the leaderly lean, the CM (1) and CF (3) do not');
  assert((await per.generateSquadPersonalities([])).length === 0, 'an empty squad generates an empty array (no phantom entry)');

  // ══ 5. evolveSquadStories — the news.ts aftermath re-derivation, offline ════════════════════
  // personality.ts: "deterministic per-event fallback (dev prepended so its cue phrases survive
  // the cap, then the keyword projection) ... Always returns exactly inputs.length entries IN ORDER."
  const redCard = 'Sent off for a wild lunge — a real hothead moment.';
  const evolveIn = [
    { name: 'Cool Head', role: 'CM', backstory: 'A calm and composed midfielder.', tagline: 'Serene.', dev: redCard },
    { name: 'Fresh Face', role: 'GK', backstory: '', tagline: '', dev: 'A model professional in every session.' },
  ];
  const evolved = await per.evolveSquadStories(evolveIn);
  assert(evolved.length === evolveIn.length, `one evolution per input, in order (expected ${evolveIn.length}, got ${evolved.length})`);
  assert(evolved[0].backstory === `${redCard} ${evolveIn[0].backstory}`,
    `the development is PREPENDED to the existing backstory (got "${evolved[0].backstory}")`);
  assert(evolved[0].tagline === 'Serene.' && evolved[1].tagline === '',
    'the tagline is carried through untouched by the deterministic evolution');
  assert(evolved[0].traits.temperament === 14,
    `the dials re-derive from the EVOLVED text: hothead(+18) against calm/composed/serene(-54) = 14 (got ${evolved[0].traits.temperament})`);
  assert(proj(evolveIn[0].backstory, evolveIn[0].tagline, 'CM').temperament === 0
      && evolved[0].traits.temperament > proj(evolveIn[0].backstory, evolveIn[0].tagline, 'CM').temperament,
    'the event genuinely moves the dial: this man projected to a floored 0 temperament BEFORE the red card and to 14 after it');
  assert(sameDials(evolved[0].traits, proj(evolved[0].backstory, evolved[0].tagline, 'CM')),
    'the returned dials are exactly the projection of the returned story (the coupling holds end to end)');
  assert(evolved[1].backstory === evolveIn[1].dev,
    'a player with no backstory yet gets the development VERBATIM as his story (no leading separator)');
  assert(evolved[1].traits.professionalism === 86 && evolved[1].traits.leadership === 60,
    `and it re-derives off his ROLE baseline: a GK keeps leadership 60 (got ${JSON.stringify(evolved[1].traits)})`);
  const hatTrick = 'Scored a hat-trick, a real big-game showman.';
  const capped = await per.evolveSquadStories([{ name: 'Long Story', role: 'CM', backstory: 'x'.repeat(400), tagline: 'tag', dev: hatTrick }]);
  assert(capped[0].backstory.length === 380 && capped[0].backstory.endsWith('…'),
    `an over-long evolved story is capped at 380 chars with an ellipsis (got ${capped[0].backstory.length})`);
  assert(capped[0].backstory.startsWith(hatTrick),
    'the WHOLE POINT of prepending: the newest development survives the cap intact');
  assert(capped[0].traits.bigGame === 68 && capped[0].traits.ego === 68,
    `so its cues still reach the dials after capping (big-game + showman: got ${JSON.stringify(capped[0].traits)})`);
  const uncapped = await per.evolveSquadStories([{ name: 'Exact', role: 'CM', backstory: 'y'.repeat(376), tagline: '', dev: 'abc' }]);
  assert(uncapped[0].backstory.length === 380 && !uncapped[0].backstory.endsWith('…'),
    'a story of exactly 380 chars is NOT capped (the cut is strictly > 380)');
  assert((await per.evolveSquadStories([])).length === 0, 'an empty evolve batch returns an empty array');

  // ══ 6. TRAITS → TRANSFER VALUE ═════════════════════════════════════════════════════════════
  // Ledger: "personality nudge: high professionalism+consistency+bigGame up to +15%, high ego
  // down to -8%." game.ts: "Neutral (or missing) personality => x1.0."
  const a70 = flat(70);
  const VAL_NEUTRAL = 18_650_000;
  assert(game.playerValue(a70, 25, null) === VAL_NEUTRAL,
    `baseline: a 70-OVR 25-y/o with NO personality is worth £${VAL_NEUTRAL} (got ${game.playerValue(a70, 25, null)})`);
  assert(game.playerValue(a70, 25, P({})) === VAL_NEUTRAL,
    'an all-50 personality is the exact identity — a neutral-personality save prices identically to a personality-less one');
  assert(game.playerValue(a70, 25, {}) === VAL_NEUTRAL && game.playerValue(a70, 25, { nationality: 'XX' }) === VAL_NEUTRAL,
    'a personality blob with no traits object also reads as neutral (never NaN, never 0)');
  assert(game.playerValue(a70, 25, P({ professionalism: 100, consistency: 100, bigGame: 100 })) === 21_450_000,
    `a maxed pro/consistent/big-game man carries the full +15% (£21.45M, got ${game.playerValue(a70, 25, P({ professionalism: 100, consistency: 100, bigGame: 100 }))})`);
  assert(game.playerValue(a70, 25, P({ professionalism: 0, consistency: 0, bigGame: 0 })) === 15_850_000,
    `the nudge is SYMMETRIC downward: the zeroed trio takes -15% (£15.85M, got ${game.playerValue(a70, 25, P({ professionalism: 0, consistency: 0, bigGame: 0 }))})`);
  assert(game.playerValue(a70, 25, { traits: { professionalism: 100 } }) === 19_600_000,
    'the three positive dials are AVERAGED (a lone maxed professionalism is only a third of the swing) and missing dials default to 50');
  assert(game.playerValue(a70, 25, P({ ego: 100 })) === 17_150_000,
    `a maxed ego discounts the fee by the full -8% (£17.15M, got ${game.playerValue(a70, 25, P({ ego: 100 }))})`);
  assert(game.playerValue(a70, 25, P({ ego: 60 })) === VAL_NEUTRAL && game.playerValue(a70, 25, P({ ego: 0 })) === VAL_NEUTRAL,
    'the ego discount has a DEAD BAND: ego 60 and below cost nothing (Math.max(0, ego - 60))');
  assert(game.playerValue(a70, 25, P({ ego: 61 })) === 18_600_000,
    `ego 61 is the first pound of discount — the band opens at exactly 60 (got ${game.playerValue(a70, 25, P({ ego: 61 }))})`);
  assert(game.playerValue(a70, 25, P({ professionalism: 100, consistency: 100, bigGame: 100, ego: 100 })) === 19_950_000,
    'premium and discount compose additively on the multiplier (+15% -8% = +7%)');
  assert(game.playerValue(a70, 25, P({ temperament: 100, leadership: 100, criticismResponse: 0, praiseResponse: 0 })) === VAL_NEUTRAL,
    'ISOLATION: temperament / leadership / criticismResponse / praiseResponse are NOT priced — only the four value dials are read');
  assert([0, 25, 50, 75, 100].every((v, i, arr) => i === 0
    || game.playerValue(a70, 25, P({ professionalism: v, consistency: v, bigGame: v }))
      >= game.playerValue(a70, 25, P({ professionalism: arr[i - 1], consistency: arr[i - 1], bigGame: arr[i - 1] }))),
    'value is monotone non-decreasing in the positive trio');
  assert([60, 70, 80, 90, 100].every((v, i, arr) => i === 0
    || game.playerValue(a70, 25, P({ ego: v })) <= game.playerValue(a70, 25, P({ ego: arr[i - 1] }))),
    'and monotone non-increasing in ego across the live part of the band');

  // ══ 7. TRAITS → WAGE ═══════════════════════════════════════════════════════════════════════
  // Ledger 5.2: "Every player draws an annual wage (≈8% of the ego-neutral value × an ego premium
  // — a diva costs more to PAY)". D2: the shipped ratio is 10%, not 8%.
  const WAGE_NEUTRAL = 1_875_000;
  assert(game.playerWage(a70, 25, null) === WAGE_NEUTRAL,
    `D2 pinned at the CODE: the wage is 10% of the ego-neutral value, rounded to 25k (£${WAGE_NEUTRAL}, got ${game.playerWage(a70, 25, null)})`);
  assert(game.playerWage(a70, 25, P({ professionalism: 100, consistency: 100, bigGame: 100 })) === WAGE_NEUTRAL,
    'THE SPLIT: the wage is built off the EGO-NEUTRAL value, so a model professional\'s +15% premium buys him nothing in salary');
  assert(game.playerWage(a70, 25, P({ ego: 100 })) === 2_325_000,
    `a maxed ego adds the full +25% wage premium (£2.325M, got ${game.playerWage(a70, 25, P({ ego: 100 }))})`);
  assert(game.playerWage(a70, 25, P({ ego: 75 })) === 2_100_000,
    `the premium is linear from 50: ego 75 is half of it (£2.1M, got ${game.playerWage(a70, 25, P({ ego: 75 }))})`);
  assert(game.playerWage(a70, 25, P({ ego: 0 })) === WAGE_NEUTRAL && game.playerWage(a70, 25, P({ ego: 50 })) === WAGE_NEUTRAL,
    'a humble player is never CHEAPER than neutral — the premium floors at ego 50');
  assert(game.playerWage(flat(30), 34, P({ ego: 100 })) === 25_000,
    'the 25k wage floor holds even for a worthless veteran with a maxed ego');
  // A SECOND price point, so neither the split nor the paradox can be a coincidence of one curve
  // position. An elite 90-OVR 25-y/o: the maxed pro is worth £14.15M more and paid exactly the same;
  // the maxed diva is worth £7.55M LESS and paid £2.35M/yr MORE.
  const a90 = flat(90), MAXPOS = P({ professionalism: 100, consistency: 100, bigGame: 100 });
  assert(game.playerValue(a90, 25, null) === 94_400_000 && game.playerValue(a90, 25, MAXPOS) === 108_550_000
      && game.playerWage(a90, 25, null) === 9_450_000 && game.playerWage(a90, 25, MAXPOS) === 9_450_000,
    `the split holds at the elite end too: value £94.4M -> £108.55M, wage £9.45M -> £9.45M (got ${game.playerValue(a90, 25, MAXPOS)} / ${game.playerWage(a90, 25, MAXPOS)})`);
  assert(game.playerValue(a90, 25, P({ ego: 100 })) === 86_850_000 && game.playerWage(a90, 25, P({ ego: 100 })) === 11_800_000,
    `THE DIVA PARADOX the ledger describes, in pounds: worth LESS to buy (£86.85M vs £94.4M) and MORE to pay (£11.8M vs £9.45M) — got ${game.playerValue(a90, 25, P({ ego: 100 }))} / ${game.playerWage(a90, 25, P({ ego: 100 }))}`);

  // ══ 8. TRAITS → CONTRACT DEMANDS ═══════════════════════════════════════════════════════════
  // contracts.ts: "his DEMAND is the fair wage ... lifted by ego (a big ego wants up to +15%)".
  // _contracts_test pins the offer flow; what is pinned HERE is which dials reach the table.
  assert(contracts.evaluateRenewalOffer(a70, 25, null, 65, 1, 3).demand === WAGE_NEUTRAL,
    'a neutral man demands exactly his fair wage');
  assert(contracts.evaluateRenewalOffer(a70, 25, P({ professionalism: 100, consistency: 100, bigGame: 100 }), 65, 1, 3).demand === WAGE_NEUTRAL,
    'ISOLATION: professionalism/consistency/bigGame earn NOTHING at the negotiating table — the model pro asks the neutral wage');
  assert(contracts.evaluateRenewalOffer(a70, 25, P({ ego: 100 }), 65, 1, 3).demand === 2_673_750,
    `ego is the only dial that bargains: the +25% wage premium then +15% again on top (£2,673,750, got ${contracts.evaluateRenewalOffer(a70, 25, P({ ego: 100 }), 65, 1, 3).demand})`);
  assert(contracts.evaluateRenewalOffer(a70, 25, P({ ego: 0 }), 65, 1, 3).demand === WAGE_NEUTRAL,
    'a humble man never asks BELOW the fair wage (the ego factor floors at 1.0)');
  assert(contracts.evaluateRenewalOffer(a70, 25, P({ ego: 100 }), 65, 2_673_750, 3).decision === 'accept'
      && contracts.evaluateRenewalOffer(a70, 25, P({ ego: 100 }), 65, 2_673_749, 3).decision === 'counter',
    'the diva accepts at his ego-inflated demand and counters one pound short of it');

  // ══ 9. TRAITS → DEVELOPMENT ════════════════════════════════════════════════════════════════
  // Ledger pillar 2: "rate scales with ... professionalism/consistency traits". The 0.6..1.4 band
  // and its decline mirror are pinned by _training_test; what is pinned HERE is which dials feed it.
  const devPassing = (traits: Partial<Traits> | { professionalism?: number; consistency?: number } | null, age: number): number =>
    training.developAttrs(flat(60), age, 90, traits, 'balanced', 65, 1, 1, 'CM').passing;
  assert(devPassing(null, 19) === 61.5 && devPassing({}, 19) === 61.5 && devPassing(undefined as unknown as null, 19) === 61.5,
    'null / empty / undefined traits are all the exact identity — a personality-less save develops unchanged');
  assert(devPassing({ professionalism: 100, consistency: 100 }, 19) === 62.1 && devPassing({ professionalism: 0, consistency: 0 }, 19) === 60.9,
    'a model professional grows 1.4x and a slacker 0.6x per matchday');
  assert(devPassing({ professionalism: 100, consistency: 0 }, 19) === 61.5 && devPassing({ professionalism: 0, consistency: 100 }, 19) === 61.5,
    'the two dials are AVERAGED, not summed: maxing one while zeroing the other is exactly neutral');
  assert(devPassing(T({ professionalism: 100, consistency: 100, ego: 100, leadership: 0, temperament: 100, bigGame: 0, criticismResponse: 0, praiseResponse: 100 }), 19) === 62.1,
    'ISOLATION (growth): the other six dials are invisible to training — a full Traits object develops exactly like the two dials alone');
  assert(devPassing(T({ professionalism: 100, consistency: 100, ego: 100, leadership: 0, temperament: 100 }), 35) === 59.3
      && devPassing({ professionalism: 100, consistency: 100 }, 35) === 59.3
      && devPassing(null, 35) === 58.8,
    'ISOLATION (decline): same on the way down, and the pro really does fade slower than the neutral man (59.3 vs 58.8)');
  assert(training.diligenceFactor({ professionalism: 100, consistency: 0 }, true) === 1
      && training.diligenceFactor({ professionalism: 100, consistency: 0 }, false) === 1,
    'the averaging is visible on the factor itself: prof 100 / cons 0 is 1.0 in BOTH directions');

  // ══ 10. TRAITS → THE AI MANAGER'S CLUB IDENTITY (pure half) ════════════════════════════════
  // manager/plan.ts: "Reads the squad's AGGREGATE personality ... so different clubs get
  // different default plans without any rng."
  const xiOf = (t: Partial<Traits> | null, n = 11) =>
    Array.from({ length: n }, (_, i) => ({ name: `P${i}`, role: 'CM', traits: t === null ? null : T(t) }));
  const planFor = (t: Partial<Traits> | null, n = 11) =>
    mplan.fallbackPlan({ teamName: 'Test FC', squad: xiOf(t, n), formation: '4-3-3' });
  const neutralPlan = planFor({});
  assert(neutralPlan.summary === 'Test FC: Play balanced, controlling the game.' && neutralPlan.directives.length === 0,
    `an all-neutral dressing room lands dead centre on all three axes: no directives (got "${neutralPlan.summary}" / ${neutralPlan.directives.length})`);
  assert(planFor(null).summary === neutralPlan.summary && planFor(null).directives.length === 0,
    'an XI with NO dials yet reads as neutral (the average defaults to 50) — an un-personalised world plans identically');
  assert(mplan.fallbackPlan({ teamName: 'Test FC', squad: [], formation: '4-3-3' }).summary === neutralPlan.summary,
    'and so does an empty squad — the aggregate never divides by zero');
  const bold = planFor({ ego: 100, bigGame: 100 });
  assert(bold.summary === 'Test FC: Play on the front foot, attacking with intent.' && bold.directives.map(d => d.kind).join(',') === 'all_out_attack',
    `ego + bigGame drive BOLDNESS: a maxed pair attacks (got "${bold.summary}" / ${bold.directives.map(d => d.kind).join(',')})`);
  const timid = planFor({ ego: 0, bigGame: 0 });
  assert(timid.summary === 'Test FC: Play compact and disciplined, picking our moments.' && timid.directives.map(d => d.kind).join(',') === 'park_the_bus',
    'and a zeroed pair parks the bus — the axis runs both ways');
  const fiery = planFor({ temperament: 100, professionalism: 0 });
  assert(fiery.directives.map(d => d.kind).join(',') === 'high_press,play_it_long',
    `temperament + (100 - professionalism) drive AGGRESSION: a fiery, loose room presses high (got ${fiery.directives.map(d => d.kind).join(',')})`);
  // Professionalism is HALF-WEIGHTED into aggression, so it moves the axis on its own: with
  // temperament held at a neutral 50, a sloppy room presses and a professional one sits off.
  const sloppy = planFor({ professionalism: 0 }), tidy = planFor({ professionalism: 100 });
  assert(sloppy.directives.map(d => d.kind).join(',') === 'high_press,play_it_long'
      && tidy.directives.map(d => d.kind).join(',') === 'drop_off,keep_it_on_ground',
    `professionalism alone swings aggression across both bars at neutral temperament (got ${sloppy.directives.map(d => d.kind).join(',')} / ${tidy.directives.map(d => d.kind).join(',')})`);
  // Leadership only reaches the plan through PATIENCE, and half-weighted there too.
  const bossy = planFor({ leadership: 100 }), meek = planFor({ leadership: 0 });
  assert(bossy.directives.map(d => d.kind).join(',') === 'keep_it_on_ground'
      && meek.directives.map(d => d.kind).join(',') === 'play_it_long',
    `leadership alone swings PATIENCE at neutral professionalism, and touches no other axis (got ${bossy.directives.map(d => d.kind).join(',')} / ${meek.directives.map(d => d.kind).join(',')})`);
  const calmPro = planFor({ temperament: 0, professionalism: 100 });
  assert(calmPro.directives.map(d => d.kind).join(',') === 'drop_off,keep_it_on_ground',
    `an ice-cool, professional room sits off and builds (got ${calmPro.directives.map(d => d.kind).join(',')})`);
  assert(calmPro.directives.length === 2 && calmPro.directives.every(d => d.playerId === -1 && d.teamScope === 0 && d.intensity === 1
    && d.when?.fromMin === 0 && d.when?.toMin === 1000 && d.when?.scoreState === 'any'),
    'every emitted directive is TEAM-WIDE and whole-match in the persisted shape specForTeam resolves');
  // Only the fielded XI is read. Probed with an XI parked ONE POINT under the all_out_attack bar
  // (boldness 64 of 65) so a single extra man IS enough to tip the aggregate if he were counted:
  // 11 x 64 stays 64, but (11 x 64 + 100) / 12 = 67, which would clear the bar.
  const edgeXi = { ego: 64, bigGame: 64 };
  const onTheBar = planFor(edgeXi);
  assert(onTheBar.summary === 'Test FC: Play on the front foot, attacking with intent.' && onTheBar.directives.length === 0,
    'fixture check: boldness 64 is exactly one point under the all_out_attack bar, so the XI alone emits nothing');
  const twelfth = mplan.fallbackPlan({
    teamName: 'Test FC',
    squad: [...xiOf(edgeXi), { name: 'Sub', role: 'CM', traits: T({ ego: 100, bigGame: 100 }) }],
    formation: '4-3-3',
  });
  assert(twelfth.summary === onTheBar.summary && twelfth.directives.length === 0,
    'and a 12th man with maxed dials — enough to tip boldness to 67 if he counted — changes nothing: the bench is not read');
  // D4 — the prose bands (60/40) and the directive bands (65/35) disagree, and the 2-directive cap
  // can silently drop an axis the prose still promises.
  const midBold = planFor({ ego: 74, bigGame: 50 });
  assert(midBold.summary === 'Test FC: Play on the front foot, attacking with intent.' && midBold.directives.length === 0,
    'D4a: boldness 62 reads "on the front foot" in the PROSE but emits no all_out_attack (prose band 60, directive band 65)');
  const maxAll = planFor({ ego: 100, bigGame: 100, temperament: 100, professionalism: 100, leadership: 100 });
  assert(maxAll.summary.includes('Keep it on the ground') && maxAll.directives.map(d => d.kind).join(',') === 'all_out_attack,high_press',
    `D4b: with two directives already emitted the patience directive is dropped, though the brief still promises it (got ${maxAll.directives.map(d => d.kind).join(',')})`);

  // ══ 11. TRAITS → THE PRE-MATCH TEAM TALK (pure half) ═══════════════════════════════════════
  // teamtalk.ts: "each player reacts according to his personality dials, producing a one-off
  // morale delta ... A perfectly neutral (all-50) player barely moves."
  const TONES: TalkTone[] = ['believe', 'demand', 'calm', 'fire_up'];
  assert(TONES.every(t => teamtalk.talkDelta(T({}), t) === 0),
    'a perfectly neutral player is unmoved by ALL FOUR tones — talks reward a varied squad, not a bland one');
  assert(TONES.every(t => teamtalk.talkDelta({} as Traits, t) === 0),
    'a player with no dials at all reads as neutral too (every missing dial defaults to 50)');
  assert(teamtalk.talkDelta(T({ criticismResponse: 100 }), 'demand') === 0.4
      && teamtalk.talkDelta(T({ criticismResponse: 0 }), 'demand') === -0.4,
    'DEMAND is read through criticismResponse: the thick-skinned are fired up (+0.4), the sensitive wilt (-0.4)');
  assert(teamtalk.talkDelta(T({ criticismResponse: 100, temperament: 100 }), 'demand') === 0.5
      && teamtalk.talkDelta(T({ criticismResponse: 100, temperament: 0 }), 'demand') === 0.3,
    'and temperament AMPLIFIES the swing (0.6..1.0x): a fiery man takes a rocket harder either way');
  assert(teamtalk.talkDelta(T({ ego: 70 }), 'demand') === 0 && teamtalk.talkDelta(T({ ego: 71 }), 'demand') === -0.08,
    'a flat -0.08 "bristles at a dressing-down" penalty opens at ego STRICTLY above 70');
  assert(teamtalk.talkDelta(T({ praiseResponse: 100 }), 'believe') === 0.45
      && teamtalk.talkDelta(T({ praiseResponse: 0 }), 'believe') === 0,
    'BELIEVE lifts the praise-hungry (+0.45) and is a no-op for the praise-immune — it never punishes them');
  assert(teamtalk.talkDelta(T({ ego: 60 }), 'believe') === 0 && teamtalk.talkDelta(T({ ego: 61 }), 'believe') === -0.01,
    'the ego complacency drag on BELIEVE opens at 60, one point earlier than DEMAND\'s bristle');
  assert(teamtalk.talkDelta(T({ praiseResponse: 100, ego: 100 }), 'believe') === 0.15,
    'a praise-hungry DIVA still gains, but complacency eats two thirds of it (0.45 - 0.30)');
  assert(teamtalk.talkDelta(T({ bigGame: 0 }), 'calm') === 0.25 && teamtalk.talkDelta(T({ temperament: 100 }), 'calm') === 0.25,
    'CALM settles the two kinds of player who need it: the ones who freeze (low bigGame) and the hot-heads');
  assert(teamtalk.talkDelta(T({ bigGame: 100 }), 'calm') === 0 && teamtalk.talkDelta(T({ temperament: 0 }), 'calm') === 0,
    'and does nothing at all for the players who need neither — CALM can never be negative');
  assert(teamtalk.talkDelta(T({ bigGame: 100 }), 'fire_up') === 0.4 && teamtalk.talkDelta(T({ bigGame: 0 }), 'fire_up') === -0.4,
    'FIRE_UP is read through bigGame: the occasion players rise, the flat-track men shrink');
  assert(teamtalk.talkDelta(T({ bigGame: 100, leadership: 100 }), 'fire_up') === 0.5
      && teamtalk.talkDelta(T({ bigGame: 0, leadership: 0 }), 'fire_up') === -0.5,
    'leadership adds to it and the result CLAMPS at ±0.5 (0.55 and -0.55 both clip)');
  assert(teamtalk.talkDelta(T({ professionalism: 0, consistency: 0 }), 'fire_up') === 0
      && teamtalk.talkDelta(T({ professionalism: 100, consistency: 100 }), 'demand') === 0,
    'ISOLATION: professionalism and consistency are training dials — no tone reads them');

  // The pure math above must not have touched the database.
  assert(snapshotAll() === snapBeforePure && totalChanges() === writesBeforePure,
    'READ-ONLY: the projection / value / wage / demand / development / identity / talk math wrote nothing to the database');

  // ══ 12. TRAITS → THE CAPTAIN AND SQUAD MORALE ══════════════════════════════════════════════
  // morale.ts §2.11: "the resolved captain's leadership — the manager's chosen captain
  // (teams.captain_slot), else the highest-leadership player ... Returns 50 (neutral → no morale
  // effect) when the squad has no personality dials yet."
  assert(moraleMod.captainLeadership(capNoDials) === 50,
    'a squad with no dials yet resolves to a neutral 50 captain — existing saves are unaffected');
  assert(moraleMod.captainLeadership(999999) === 50, 'so does a team that does not exist (never NaN, never -1)');
  assert(moraleMod.captainLeadership(capAuto) === 90,
    'with no captain set, the HIGHEST leadership in the squad is auto-derived (90, not the 70 or the 30)');
  assert(moraleMod.captainLeadership(capPicked) === 30,
    'a DELIBERATE pick stands even when a better leader is available (30 beats the squad\'s 90) — the manager decides');
  assert(moraleMod.captainLeadership(capPickedBlank) === 50,
    'a chosen captain with no dials yet reads neutral 50 rather than falling back to a team-mate');
  assert(moraleMod.captainLeadership(capGone) === 88,
    'if the chosen captain has LEFT the club the auto-derive takes over again (88)');
  assert(moraleMod.captainLeadership(capCorrupt) === 20,
    'a corrupt personality blob is skipped, not thrown on — the next best real dial wins (20)');
  moraleMod.moraleTick(tickLeague);
  const moraleOf = (teamId: number): number =>
    (db.prepare('SELECT morale FROM players WHERE team_id = ? AND slot = 1').get(teamId) as { morale: number }).morale;
  assert(moraleOf(tickTeams.get(50)!) === 63,
    `baseline: a settled 65-morale squad with a NEUTRAL captain drifts to 63 (got ${moraleOf(tickTeams.get(50)!)})`);
  assert(moraleOf(tickTeams.get(100)!) === 65,
    `"a strong captain steadies the room": leadership 100 adds the capped +2 and holds the squad at 65 (got ${moraleOf(tickTeams.get(100)!)})`);
  assert(moraleOf(tickTeams.get(0)!) === 61,
    `"a poor one drags it": leadership 0 costs the capped -2 (got ${moraleOf(tickTeams.get(0)!)})`);
  assert(moraleOf(tickTeams.get(62)!) === 63 && moraleOf(tickTeams.get(63)!) === 64,
    'the bonus is quantised in whole points at (leadership - 50) / 25: 62 still buys nothing, 63 buys the first point');
  assert(moraleOf(tickTeams.get(200)!) === moraleOf(tickTeams.get(100)!),
    'the ±2 clamp is the guard on a MALFORMED dial: an out-of-range leadership 200 is worth no more than a legal 100');

  // ══ 13. TRAITS → THE TEAM TALK, PERSISTED ══════════════════════════════════════════════════
  // teamtalk.ts: "Stores the computed per-slot deltas so the reaction can't drift if
  // personalities change before the match."
  const believe = teamtalk.previewTalk(talkTeam, 'believe');
  assert(believe.length === 5 && believe.map(r => r.slot).join(',') === '0,1,2,3,4',
    'previewTalk covers the WHOLE squad in slot order (bench included)');
  assert(believe[0].delta === 0.45 && believe[0].reaction === 'fired up',
    `the praise-hungry man is "fired up" at +0.45 (got ${believe[0].delta}/${believe[0].reaction})`);
  assert(believe[3].delta === 0.15 && believe[3].reaction === 'lifted',
    'the praise-hungry diva is merely "lifted" at +0.15 — the label bands read the delta');
  assert(believe[1].delta === 0 && believe[1].reaction === 'unmoved' && believe[2].delta === 0 && believe[2].reaction === 'unmoved',
    'the neutral man and the dial-less man are both "unmoved" — a personality-less squad gets nothing from a talk');
  assert(teamtalk.previewTalk(999999, 'believe').length === 0, 'previewing a team that does not exist is empty, not a throw');
  const set = teamtalk.setTeamTalk(talkTeam, fixtureId, 'believe');
  assert(set.ok && set.tone === 'believe' && JSON.stringify(set.reactions) === JSON.stringify(believe),
    'setTeamTalk stores exactly what previewTalk showed the manager');
  const stored = teamtalk.getTeamTalkDeltas(talkTeam, fixtureId);
  assert(JSON.stringify([...stored]) === '[[0,0.45],[3,0.15],[4,-0.01]]',
    `only the players who actually MOVED ride into the spec (|delta| >= 0.01, so the unmoved slots 1 and 2 emit no moraleBoost field at all and stay byte-identical) — got ${JSON.stringify([...stored])}`);
  assert(teamtalk.pendingTalk(talkTeam, fixtureId)?.tone === 'believe' && teamtalk.pendingTalk(talkTeam, 999999) === null,
    'the tabled talk is readable back per fixture, and only for that fixture');
  teamtalk.setTeamTalk(talkTeam, fixtureId, 'fire_up');
  assert(count('SELECT COUNT(*) AS n FROM team_talks WHERE team_id = ?', talkTeam) === 1
      && teamtalk.getTeamTalkDeltas(talkTeam, fixtureId).size === 0,
    'a second talk REPLACES the first (one row per fixture) — and this all-neutral-bigGame squad stores nothing for fire_up');
  teamtalk.consumeTeamTalk(fixtureId);
  assert(teamtalk.getTeamTalkDeltas(talkTeam, fixtureId).size === 0 && teamtalk.pendingTalk(talkTeam, fixtureId) === null,
    'the talk is a ONE-OFF: consuming it after the match clears the row');

  // ══ 14. TRAITS → PRESS / 1-TO-1 INTERACTION ════════════════════════════════════════════════
  // press.ts: "Exported so the 1-to-1 player-interaction feature shares the exact
  // personality-gated math (praise lifts the praise-hungry + egos; criticism lifts the
  // responsive, dents the sensitive + hotheads)."
  const D = (o: Partial<{ criticismResponse: number; praiseResponse: number; ego: number; temperament: number }>) =>
    ({ criticismResponse: 50, praiseResponse: 50, ego: 50, temperament: 50, ...o });
  assert(press.deterministicDelta(1, D({})) === 12 && press.deterministicDelta(0.5, D({})) === 6,
    'a neutral player gains +12 from full praise and +6 from a half-strength word');
  assert(press.deterministicDelta(1, D({ praiseResponse: 100, ego: 100 })) === 15
      && press.deterministicDelta(1, D({ praiseResponse: 0, ego: 0 })) === 5,
    'praise scales with praiseResponse AND ego (a diva laps it up): +15 at the top, +5 at the bottom');
  assert(press.deterministicDelta(-1, D({ criticismResponse: 100, temperament: 0 })) === 14,
    'a rocket at a thick-skinned, ice-cool man LIFTS him by 14');
  assert(press.deterministicDelta(-1, D({ criticismResponse: 0, temperament: 100 })) === -13,
    'the same rocket at a sensitive hot-head costs 13');
  assert(press.deterministicDelta(-1, D({ criticismResponse: 100, temperament: 100 })) === 10
      && press.deterministicDelta(-1, D({ criticismResponse: 0, temperament: 0 })) === -9,
    'temperament is a pure penalty on criticism — it only ever subtracts, on top of criticismResponse');
  assert(press.deterministicDelta(-1, D({})) === 1,
    'PINNED QUIRK: a rocket at a PERFECTLY AVERAGE player is a small NET POSITIVE (+1), not a dent');
  assert(press.deterministicDelta(1, D({ criticismResponse: 0 })) === press.deterministicDelta(1, D({ criticismResponse: 100 }))
      && press.deterministicDelta(-1, D({ praiseResponse: 0 })) === press.deterministicDelta(-1, D({ praiseResponse: 100 })),
    'the two arms are dial-disjoint: criticismResponse cannot touch praise, praiseResponse cannot touch criticism');
  assert(press.deterministicDelta(5, D({ praiseResponse: 100, ego: 100 })) === 15
      && press.deterministicDelta(-5, D({ criticismResponse: 0, temperament: 100 })) === -15,
    'the delta clamps to ±15 however extreme the tone');

  const chat = (slot: number, tone: InteractTone) => interaction.interactWithPlayer(chatTeam, slot, tone);
  const praised = chat(0, 'praise');
  assert(praised.ok && praised.delta === 12 && praised.morale === 62 && praised.name === 'Perfectly Average',
    `a private word applies the SAME deterministic delta to morale (50 + 12 = 62, got ${praised.delta}/${praised.morale})`);
  assert(praised.reaction === 'Cheers, gaffer — means a lot. I’ll keep it going.',
    `and templates a reaction line from how it landed (got "${praised.reaction}")`);
  const repeat = chat(0, 'praise');
  assert(repeat.ok === false && repeat.delta === undefined && (repeat.error ?? '').includes('already had a word'),
    'the once-per-matchday cooldown blocks a second word — morale cannot be farmed');
  assert((db.prepare('SELECT morale FROM players WHERE team_id = ? AND slot = 0').get(chatTeam) as { morale: number }).morale === 62,
    'and the blocked call writes nothing');
  const noDialsChat = chat(1, 'praise');
  assert(noDialsChat.ok && noDialsChat.delta === 12,
    'a player with no dials yet reacts exactly like a neutral one (every dial defaults to 50)');
  const thick = chat(2, 'criticise');
  assert(thick.ok && thick.delta === 14 && thick.reaction === 'Fair enough — I’ll show you what I’m about.',
    `the thick-skinned man GAINS from a rocket, and his line says so (got ${thick.delta}: "${thick.reaction}")`);
  const sensitive = chat(3, 'criticise');
  assert(sensitive.ok && sensitive.delta === -13 && sensitive.morale === 0,
    `the hot-head loses 13 and his morale FLOORS at 0 rather than going negative (got ${sensitive.morale})`);
  assert(sensitive.reaction === 'That’s bang out of order — I don’t need this.',
    'and a fiery temperament picks the angrier of the two negative lines');
  const ceiling = chat(4, 'praise');
  assert(ceiling.ok && ceiling.delta === 15 && ceiling.morale === 100,
    `morale CEILINGS at 100 (95 + 15 clamps, got ${ceiling.morale})`);
  assert(chat(99, 'praise').ok === false, 'a word with a slot that holds nobody is a clean failure');

  // ══ 15. TRAITS → UNSETTLED-PLAYER CONCERNS ═════════════════════════════════════════════════
  // concerns.ts: "A player agitating to leave — deeply unhappy, a benched big ego, or running his
  // deal down while unsettled — becomes a concern."
  const found = concerns.getConcerns(concernTeam);
  assert(found.map(c => `${c.slot}:${c.kind}`).join(',') === '11:benched_star,14:benched_star',
    `exactly the two benched big egos below the morale bar are flagged, sorted most acute first (got ${found.map(c => `${c.slot}:${c.kind}`).join(',')})`);
  assert(found.length === 2 && found.every(c => c.reason === 'A big name frustrated on the bench.'),
    'and each carries the benched-star reason the UI shows');
  assert(concerns.getConcerns(999999).length === 0, 'a team with no players has no concerns');
  // The exhaustive list above shows slots 0 (starting), 12 (ego 69) and 13 (morale 60) are NOT
  // flagged. Push each of them one point over its own bar and re-read: each must now appear. That
  // is what proves the bar is where it is, rather than that those three are simply immune.
  const concernSlots = (): string => concerns.getConcerns(concernTeam).map(c => c.slot).join(',');
  db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = 12')
    .run(JSON.stringify(P({ ego: 70 })), concernTeam);
  assert(concernSlots() === '11,12,14', `ego 69 -> 70 flips slot 12 into a concern: the "big name" bar is exactly 70 (got ${concernSlots()})`);
  db.prepare('UPDATE players SET morale = 59 WHERE team_id = ? AND slot = 13').run(concernTeam);
  assert(concernSlots() === '11,12,13,14', `morale 60 -> 59 flips slot 13 in: the unhappiness bar is strictly below 60 (got ${concernSlots()})`);
  db.prepare('UPDATE teams SET lineup = ? WHERE id = ?')
    .run(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), concernTeam);   // drop slot 0, promote slot 11
  const benchedNow = concerns.getConcerns(concernTeam).map(c => c.slot).join(',');
  assert(benchedNow === '0,12,13,14',
    `it is the BENCH, not the ego, that triggers: dropping slot 0 from the XI flags him and promoting slot 11 clears him (got ${benchedNow})`);
  // D3 — concerns.ts calls the reassure lift "~3..13"; the formula's real range is 1..15.
  const plainLift = concerns.resolveConcern(reassureTeam, 11, 'reassure');
  assert(plainLift.ok && plainLift.moraleDelta === 9 && plainLift.morale === 59,
    `reassurance lifts by round(4 + praiseResponse*8 + ego*3 - temperament*3): a plain ego-80 man gains 9 (got ${plainLift.moraleDelta})`);
  const maxLift = concerns.resolveConcern(reassureTeam, 12, 'reassure');
  assert(maxLift.ok && maxLift.moraleDelta === 15,
    `D3: a maxed praise-hungry, ice-cool diva gains 15 — above the "~3..13" the comment claims (got ${maxLift.moraleDelta})`);
  const minLift = concerns.resolveConcern(reassureTeam, 13, 'reassure');
  assert(minLift.ok && minLift.moraleDelta === 3,
    `and a praise-immune hot-head gains only 3 — a fiery man trusts words least (got ${minLift.moraleDelta})`);
  assert(concerns.resolveConcern(reassureTeam, 11, 'reassure').ok === false,
    'reassurance carries its own once-per-matchday cooldown');
  assert(concerns.resolveConcern(reassureTeam, 0, 'reassure').ok === false,
    'and a settled player cannot be "reassured" at all — the classify() guard fronts every action');

  // ══ 16. CROSS-CUTTING: every deterministic path yields well-formed dials ════════════════════
  // A consumer that reads a dial off a malformed trait object is how a NaN reaches a wage. Sweep
  // every trait object this file can produce deterministically.
  const produced: Traits[] = [
    per.defaultPersonality('x', 'GK').traits,
    per.defaultPersonality('x', 'CM').traits,
    ...generated.map(g => g.traits),
    ...evolved.map(e => e.traits),
    ...capped.map(e => e.traits),
    derived, fromTagline, gkDerived,
    proj(allCues.join(' ')), proj(''), proj('a hothead, streaky, but clutch', 'On his day.'),
  ];
  assert(produced.length >= 15 && produced.every(dialsWellFormed),
    `every trait object any deterministic path produces has exactly the 8 dials as integers in 0..100 (${produced.length} objects)`);
  assert(produced.every(t => Number.isFinite(game.playerValue(a70, 25, { traits: t })) && game.playerValue(a70, 25, { traits: t }) >= 25_000),
    'and every one of them prices to a finite value at or above the 25k floor — no dial combination can produce a NaN fee');

  console.log(`_personality_test: ${assertions} assertions passed`);
} finally {
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
  rmSync(CWD_DIR, { recursive: true, force: true });
}

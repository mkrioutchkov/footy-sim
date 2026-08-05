// tools/_harmony_test.ts — engine-free regression for web/backend/harmony.ts (squad harmony /
// dressing room). Recreated from the GAME_LAYER_NOTES.md ledger entry:
//
//   "Verified by tools/_harmony_test.ts (12 — status bands, each flag, the happy-vs-benched
//    ego distinction, disruption drags harmony) + smoke (57)."
//
// Each assertion group quotes the ledger claim it covers. getSquadHarmony is deterministic
// given the rows (no RNG), so bands, boundaries, caps and the clamp are asserted EXACTLY.
//
// Run: cd <repo> && npx tsx tools/_harmony_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run — web/backend/data/ is never touched.

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { SquadHarmony } from '../web/backend/harmony.ts';

// db.ts resolves FOOTY_DB at IMPORT time, so point it at a scratch file BEFORE any backend
// module loads — which is why every backend import below is a dynamic import.
const TESTDB_DIR = '/tmp/claude-0/-home-user-footy-sim/710ecd1a-f780-5b5f-a4ef-27543513423b/scratchpad/testdb';
mkdirSync(TESTDB_DIR, { recursive: true });
const DB_PATH = path.join(TESTDB_DIR, `harmony_${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) { rmSync(DB_PATH + suffix, { force: true }); }
process.env.FOOTY_DB = DB_PATH;

const { db } = await import('../web/backend/db.ts');
const { getSquadHarmony, harmonyFactor } = await import('../web/backend/harmony.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(message); }
  assertions++;
}
function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 1e-9;
}

// ── Fixture builders ─────────────────────────────────────────────────────────
// Minimal rows getSquadHarmony reads: players(slot, name, personality, morale) + teams.lineup.
// Neutral trait defaults inside harmony.ts are ego 50 / leadership 50 / professionalism 50,
// so a NULL personality means "no flag, no bonus, no drag".
interface TestPlayer { slot: number; morale: number; ego?: number; lead?: number; prof?: number; personality?: string; }

const leagueId = Number(db.prepare("INSERT INTO leagues (name) VALUES ('Harmony Test League')").run().lastInsertRowid);
let teamCount = 0;

function makeTeam(players: TestPlayer[], lineup?: number[] | string): number {
  teamCount += 1;
  const lineupJson = lineup === undefined ? null : typeof lineup === 'string' ? lineup : JSON.stringify(lineup);
  const teamId = Number(db.prepare(
    "INSERT INTO teams (league_id, name, manager, tactics, created_at, lineup) VALUES (?, ?, 'AI', '{}', 0, ?)",
  ).run(leagueId, `Harmony Test ${teamCount}`, lineupJson).lastInsertRowid);
  const insert = db.prepare(
    "INSERT INTO players (team_id, slot, name, role, attrs, personality, morale) VALUES (?, ?, ?, 'CM', '{}', ?, ?)",
  );
  for (const p of players) {
    const personality = p.personality !== undefined
      ? p.personality
      : (p.ego !== undefined || p.lead !== undefined || p.prof !== undefined)
        ? JSON.stringify({ traits: { ego: p.ego ?? 50, leadership: p.lead ?? 50, professionalism: p.prof ?? 50 } })
        : null;
    insert.run(teamId, p.slot, `Player ${p.slot}`, personality, p.morale);
  }
  return teamId;
}

function uniform(count: number, morale: number): TestPlayer[] {
  return Array.from({ length: count }, (_, slot) => ({ slot, morale }));
}

function harmonyOf(teamId: number): SquadHarmony {
  const h = getSquadHarmony(teamId);
  if (h === null) { throw new Error(`team ${teamId} unexpectedly returned null harmony`); }
  return h;
}

function tagList(h: SquadHarmony): string {
  return h.players.map(p => `${p.slot}:${p.tag}`).join(',');
}

// Snapshot every user table (content, not file bytes) for the READ-ONLY proof.
function snapshotAll(): string {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[];
  const dump: Record<string, unknown> = {};
  for (const t of tables) { dump[t.name] = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all(); }
  return JSON.stringify(dump);
}

// ── Build every fixture team BEFORE the first harmony call ───────────────────
// All writes happen here; the snapshot taken after this block must survive every call below.
const bandTeams = new Map<number, number>();
for (const m of [75, 74, 55, 54, 35, 34]) { bandTeams.set(m, makeTeam(uniform(16, m))); }

const clampHighPs = uniform(16, 100); clampHighPs[0].lead = 100;
const clampHigh = makeTeam(clampHighPs);
const clampLowPs = uniform(16, 0); clampLowPs[0].ego = 100; clampLowPs[1].ego = 100;
const clampLow = makeTeam(clampLowPs);

const flagsPs = uniform(16, 60);
flagsPs[0].lead = 80;                       // leader
flagsPs[1].prof = 85;                       // model pro
flagsPs[2].ego = 80; flagsPs[2].morale = 40; // disruptive (starter, unhappy)
flagsPs[3].morale = 30;                     // unsettled
const flagsMix = makeTeam(flagsPs);

const lead70Ps = uniform(12, 60); lead70Ps[0].lead = 70;
const lead70 = makeTeam(lead70Ps);
const lead69Ps = uniform(12, 60); lead69Ps[0].lead = 69;
const lead69 = makeTeam(lead69Ps);
const prof78Ps = uniform(12, 60); prof78Ps[0].prof = 78;
const prof78 = makeTeam(prof78Ps);
const prof77Ps = uniform(12, 60); prof77Ps[0].prof = 77;
const prof77 = makeTeam(prof77Ps);
const unset35Ps = uniform(12, 60); unset35Ps[0].morale = 35;
const unset35 = makeTeam(unset35Ps);
const unset36Ps = uniform(12, 60); unset36Ps[0].morale = 36;
const unset36 = makeTeam(unset36Ps);
const sadLeaderPs = uniform(12, 60); sadLeaderPs[0].lead = 90; sadLeaderPs[0].morale = 30;
const sadLeader = makeTeam(sadLeaderPs);
const sadEgoPs = uniform(12, 60); sadEgoPs[0].ego = 80; sadEgoPs[0].morale = 30;
const sadEgo = makeTeam(sadEgoPs);

const egoStarterPs = uniform(14, 60); egoStarterPs[4].ego = 80;
const egoStarterHappy = makeTeam(egoStarterPs);
const egoBenchPs = uniform(14, 60); egoBenchPs[12].ego = 80;
const egoBenchedUnhappy = makeTeam(egoBenchPs);
const egoBenchOkPs = uniform(14, 60); egoBenchOkPs[12].ego = 80; egoBenchOkPs[12].morale = 70;
const egoBenchedHappy = makeTeam(egoBenchOkPs);
const bench64Ps = uniform(14, 60); bench64Ps[12].ego = 80; bench64Ps[12].morale = 64;
const bench64 = makeTeam(bench64Ps);
const bench65Ps = uniform(14, 60); bench65Ps[12].ego = 80; bench65Ps[12].morale = 65;
const bench65 = makeTeam(bench65Ps);
const pickedPs = uniform(14, 60); pickedPs[12].ego = 80; pickedPs[10].ego = 80;
const pickedXI = makeTeam(pickedPs, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);
const egoEdgePs = uniform(12, 60);
egoEdgePs[2].ego = 70; egoEdgePs[2].morale = 49;   // exactly at both thresholds -> flagged
egoEdgePs[3].ego = 69; egoEdgePs[3].morale = 49;   // one short of the ego bar -> clean
const egoEdge = makeTeam(egoEdgePs);
const starter50Ps = uniform(12, 60); starter50Ps[2].ego = 80; starter50Ps[2].morale = 50;
const starter50 = makeTeam(starter50Ps);

const leaderCapPs = uniform(12, 60);
for (const s of [0, 1, 2, 3]) { leaderCapPs[s].lead = 95; }
const leaderCap = makeTeam(leaderCapPs);
const dragBasePs = uniform(12, 60); dragBasePs[0].morale = 40;
const dragBase = makeTeam(dragBasePs);
const dragEgo70Ps = uniform(12, 60); dragEgo70Ps[0].morale = 40; dragEgo70Ps[0].ego = 70;
const dragEgo70 = makeTeam(dragEgo70Ps);
const dragEgo100Ps = uniform(12, 60); dragEgo100Ps[0].morale = 40; dragEgo100Ps[0].ego = 100;
const dragEgo100 = makeTeam(dragEgo100Ps);
const disruptCapPs = uniform(20, 40);
for (const p of disruptCapPs) { p.ego = 100; }
const disruptCap = makeTeam(disruptCapPs);

const spreadNone = makeTeam(uniform(20, 60));
const spreadWide = makeTeam([...uniform(10, 90), ...uniform(10, 30).map(p => ({ ...p, slot: p.slot + 10 }))]);
const spreadEdge = makeTeam([...uniform(10, 70), ...uniform(10, 40).map(p => ({ ...p, slot: p.slot + 10 }))]);
const spreadCap = makeTeam([...uniform(10, 100), ...uniform(10, 0).map(p => ({ ...p, slot: p.slot + 10 }))]);

const badPersonPs = uniform(12, 60); badPersonPs[0].personality = '{not json';
const badPersonality = makeTeam(badPersonPs);
const badLineupPs = uniform(14, 60); badLineupPs[12].ego = 80;
const badLineup = makeTeam(badLineupPs, 'not json');

const snapBefore = snapshotAll();

// ── harmonyFactor ────────────────────────────────────────────────────────────
// LEDGER: "harmony → training — `harmonyFactor` (EXACTLY 1.0 across the settled band so
// regressions are byte-identical; +6%/−8% outside)".
assert(Array.from({ length: 20 }, (_, i) => 55 + i).every(h => harmonyFactor(h) === 1),
  'harmonyFactor is EXACTLY 1.0 across the whole settled band (55..74)');
assert(harmonyFactor(75) === 1, 'united starts from the neutral identity at exactly 75');
assert(near(harmonyFactor(90), 1.0375), `united scales up: factor(90) = 1.0375, got ${harmonyFactor(90)}`);
assert(near(harmonyFactor(100), 1.06), `united bonus caps at +6%: factor(100) = 1.06, got ${harmonyFactor(100)}`);
assert(near(harmonyFactor(54), 0.998), `restless drags just below the band: factor(54) = 0.998, got ${harmonyFactor(54)}`);
assert(near(harmonyFactor(35), 0.96), `restless floor: factor(35) = 0.96, got ${harmonyFactor(35)}`);
assert(near(harmonyFactor(34), 0.92), `fractured is a flat -8%: factor(34) = 0.92, got ${harmonyFactor(34)}`);
assert(near(harmonyFactor(0), 0.92), 'fractured stays -8% all the way down');
assert(Array.from({ length: 100 }, (_, h) => h).every(h => harmonyFactor(h) <= harmonyFactor(h + 1)),
  'harmonyFactor is monotone non-decreasing over 0..100');

// ── Status bands ─────────────────────────────────────────────────────────────
// LEDGER: "Returns a 0–100 harmony + status (united/settled/restless/fractured)" — a squad of
// neutral personalities at uniform morale m has harmony == m (no bonus, no drag, no spread),
// so each band boundary is probed exactly.
const bandExpect: [number, SquadHarmony['status']][] = [
  [75, 'united'], [74, 'settled'], [55, 'settled'], [54, 'restless'], [35, 'restless'], [34, 'fractured'],
];
for (const [m, status] of bandExpect) {
  const h = harmonyOf(bandTeams.get(m)!);
  assert(h.harmony === m, `neutral squad at uniform morale ${m} has harmony ${m}, got ${h.harmony}`);
  assert(h.status === status, `harmony ${m} sits in the '${status}' band, got '${h.status}'`);
}
const neutral75 = harmonyOf(bandTeams.get(75)!);
assert(neutral75.players.length === 0, 'a fully neutral squad has no notable players');
assert(neutral75.avgMorale === 75, `avgMorale reports the rounded squad average, got ${neutral75.avgMorale}`);

// The 0-100 clamp.
const hi = harmonyOf(clampHigh);
assert(hi.harmony === 100, `morale 100 + a leader bonus clamps to 100, got ${hi.harmony}`);
assert(hi.status === 'united', 'clamped-high squad is united');
const lo = harmonyOf(clampLow);
assert(lo.harmony === 0, `morale 0 + disruption clamps to 0 (never negative), got ${lo.harmony}`);
assert(lo.status === 'fractured', 'clamped-low squad is fractured');

// ── Each flag ────────────────────────────────────────────────────────────────
// LEDGER: "the notable players (leader/pro/disruptive/unsettled)" — one squad carrying all
// four, checking tag + note + the severity sort (most significant first).
const mix = harmonyOf(flagsMix);
const bySlot = new Map(mix.players.map(p => [p.slot, p]));
assert(bySlot.get(0)?.tag === 'leader', `leadership 80 flags 'leader', got ${bySlot.get(0)?.tag}`);
assert(bySlot.get(0)?.note === 'A dressing-room leader', `leader note, got '${bySlot.get(0)?.note}'`);
assert(bySlot.get(1)?.tag === 'pro', `professionalism 85 flags 'pro', got ${bySlot.get(1)?.tag}`);
assert(bySlot.get(1)?.note === 'A model professional', `pro note, got '${bySlot.get(1)?.note}'`);
assert(bySlot.get(2)?.tag === 'disruptive', `ego 80 at morale 40 flags 'disruptive', got ${bySlot.get(2)?.tag}`);
assert(bySlot.get(2)?.note === 'A big ego, unsettled', `an unhappy STARTER ego gets the unsettled note, got '${bySlot.get(2)?.note}'`);
assert(bySlot.get(3)?.tag === 'unsettled', `morale 30 flags 'unsettled', got ${bySlot.get(3)?.tag}`);
assert(bySlot.get(3)?.note === 'Deeply unhappy', `unsettled note, got '${bySlot.get(3)?.note}'`);
assert(tagList(mix) === '2:disruptive,3:unsettled,0:leader,1:pro',
  `players sort most significant first (disruptive < unsettled < leader < pro, then slot), got ${tagList(mix)}`);
assert(mix.harmony === 50, `mixed squad: round(56.875 + 3 - 10) = 50, got ${mix.harmony}`);

// Flag thresholds, exactly at / just under the bar.
const l70 = harmonyOf(lead70);
assert(l70.players.length === 1 && l70.players[0].tag === 'leader', 'leadership 70 is exactly the leader bar');
// LEDGER: "leaders + model pros lift it" — the leader half holds numerically...
assert(l70.harmony === 61, `a lone leader lifts harmony above the 60 baseline (61), got ${l70.harmony}`);
const l69 = harmonyOf(lead69);
assert(l69.players.length === 0, 'leadership 69 is not a leader');
assert(l69.harmony === 60, 'no leader, no lift');
const p78 = harmonyOf(prof78);
assert(p78.players.length === 1 && p78.players[0].tag === 'pro', 'professionalism 78 is exactly the pro bar');
// ...but a model pro is TAG-ONLY in the shipped code: no numeric lift (leadBonus counts leaders
// alone). Asserting current behaviour; the ledger's "pros lift it" reads as panel prose.
assert(p78.harmony === 60, `a model pro adds no numeric lift: harmony stays 60, got ${p78.harmony}`);
assert(harmonyOf(prof77).players.length === 0, 'professionalism 77 is not a pro');
const u35 = harmonyOf(unset35);
assert(u35.players.length === 1 && u35.players[0].tag === 'unsettled', 'morale 35 is exactly the unsettled bar');
assert(harmonyOf(unset36).players.length === 0, 'morale 36 is not unsettled');
// Precedence: deep unhappiness outranks the leader flag; a big ego outranks unsettled.
assert(harmonyOf(sadLeader).players[0]?.tag === 'unsettled', 'a leader at morale 30 reads as unsettled, not leader');
assert(harmonyOf(sadEgo).players[0]?.tag === 'disruptive', 'a big ego at morale 30 reads as disruptive, not unsettled');

// ── The happy-vs-benched ego distinction ─────────────────────────────────────
// LEDGER: "the happy-vs-benched ego distinction" / "big egos who are unhappy or stuck on the
// bench drag it". Same ego 80 at morale 60: content as a starter, disruptive on the bench.
const starterEgo = harmonyOf(egoStarterHappy);
assert(starterEgo.players.length === 0, 'a big ego STARTING at morale 60 raises no flag');
assert(starterEgo.harmony === 60, `happy starter ego leaves harmony at 60, got ${starterEgo.harmony}`);
const benchEgo = harmonyOf(egoBenchedUnhappy);
assert(benchEgo.players.length === 1, 'the same ego BENCHED at morale 60 is flagged');
assert(benchEgo.players[0].tag === 'disruptive' && benchEgo.players[0].slot === 12, 'benched ego flags disruptive');
assert(benchEgo.players[0].note === 'A big ego unhappy on the bench', `bench note, got '${benchEgo.players[0].note}'`);
assert(benchEgo.harmony === 50, `benched-ego disruption drags 60 down to 50, got ${benchEgo.harmony}`);
assert(benchEgo.harmony < starterEgo.harmony, 'benched ego drags harmony below the happy-starter squad');
const benchOk = harmonyOf(egoBenchedHappy);
assert(benchOk.players.length === 0, 'a benched ego at morale 70 (>= 65) is content: no flag');
assert(benchOk.harmony === 61, `content bench squad: round(850/14) = 61, got ${benchOk.harmony}`);
assert(harmonyOf(bench64).players.length === 1, 'benched-ego morale 64 is exactly inside the unhappy bar');
assert(harmonyOf(bench65).players.length === 0, 'benched-ego morale 65 is exactly outside it');
// "bench = NOT in the starting XI, resolved from the team's lineup ... a starter at squad-slot 12
// isn't mistaken for a benchwarmer" — hand-picked XI [0..9, 12] leaves slot 10 out.
const picked = harmonyOf(pickedXI);
assert(picked.players.length === 1, 'hand-picked XI: only the excluded ego is flagged');
assert(picked.players[0].slot === 10, `the ego DROPPED from the picked XI (slot 10) is the disruptive one, got slot ${picked.players[0].slot}`);
assert(picked.players[0].note === 'A big ego unhappy on the bench', 'the dropped starter reads as benched');
const edge = harmonyOf(egoEdge);
assert(edge.players.length === 1 && edge.players[0].slot === 2, 'ego 70 @ morale 49 flags; ego 69 @ 49 does not');
assert(harmonyOf(starter50).players.length === 0, 'a starting ego at morale 50 is exactly outside the unhappy bar');

// ── Disruption drags harmony (and the caps) ──────────────────────────────────
// LEDGER: "disruption drags harmony".
const d0 = harmonyOf(dragBase), d70 = harmonyOf(dragEgo70), d100 = harmonyOf(dragEgo100);
assert(d0.harmony === 58, `no-ego baseline (one man at morale 40): 58, got ${d0.harmony}`);
assert(d70.harmony === 52, `ego 70 disruption costs 6: 52, got ${d70.harmony}`);
assert(d100.harmony === 40, `ego 100 disruption costs 18: 40, got ${d100.harmony}`);
assert(d100.harmony < d70.harmony && d70.harmony < d0.harmony, 'the bigger the ego, the bigger the drag');
const dCap = harmonyOf(disruptCap);
assert(dCap.harmony === 15, `disruption penalty caps at 25 (40 - 25 = 15) however many egos, got ${dCap.harmony}`);
assert(dCap.players.length === 6, `the notable list is capped at 6 players, got ${dCap.players.length}`);
assert(tagList(dCap) === '0:disruptive,1:disruptive,2:disruptive,3:disruptive,4:disruptive,5:disruptive',
  'equal severity ties break by slot');
const lCap = harmonyOf(leaderCap);
assert(lCap.harmony === 70, `the leadership bonus caps at +10 (60 + 10 = 70), got ${lCap.harmony}`);
assert(lCap.status === 'settled', 'the capped bonus cannot push a 60-morale squad united');

// ── Morale spread ────────────────────────────────────────────────────────────
// LEDGER: "as does a wide morale spread (a split dressing room)".
const s0 = harmonyOf(spreadNone), sW = harmonyOf(spreadWide);
assert(s0.harmony === 60, `flat squad at 60: harmony 60, got ${s0.harmony}`);
assert(sW.harmony === 45, `same average, spread 60: penalty 15 -> 45, got ${sW.harmony}`);
assert(sW.avgMorale === 60, `the split squad still averages 60 morale, got ${sW.avgMorale}`);
assert(sW.harmony < s0.harmony, 'a split dressing room drags harmony below the flat squad');
assert(harmonyOf(spreadEdge).harmony === 55, 'spread of exactly 30 is free (no penalty)');
assert(harmonyOf(spreadCap).harmony === 32, 'spread penalty caps at 18 (50 - 18 = 32)');

// ── Robustness ───────────────────────────────────────────────────────────────
assert(getSquadHarmony(999999) === null, 'a team with no players returns null');
const badP = harmonyOf(badPersonality);
assert(badP.harmony === 60 && badP.players.length === 0, 'malformed personality JSON reads as neutral traits');
const badL = harmonyOf(badLineup);
assert(badL.players.length === 1 && badL.players[0].slot === 12,
  'malformed lineup JSON falls back to the identity XI (slot 12 is benched)');

// ── READ-ONLY ────────────────────────────────────────────────────────────────
// LEDGER: "A READ-ONLY read of how settled the squad is ... it mutates nothing". Every
// getSquadHarmony / harmonyFactor call above ran between these two snapshots of EVERY table.
assert(snapshotAll() === snapBefore, 'harmony calls mutated db state — the module must stay read-only');

console.log(`_harmony_test: ${assertions} assertions passed`);

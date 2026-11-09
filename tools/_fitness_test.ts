// tools/_fitness_test.ts — engine-free regression for web/backend/fitness.ts (injuries &
// match fitness) plus the shared XI selection (game.ts fitFirstSelection / fieldedXIIndices)
// that keeps "who played" identical to "who's fielded". Recreated from the
// GAME_LAYER_NOTES.md ledger entry:
//
//   "Injuries & match fitness (fitness.ts). Condition 0–100: the XI that plays drains
//    (~10–17), the rest recover (+20); low fitness raises injury risk (3% fresh → 13%
//    exhausted, out 1–5 matchdays), so neglecting rotation bites. Injured players can't
//    be selected — specForTeam draws the XI fit-first (byte-identical when fully fit),
//    and a shared fitFirstSelection (game.ts) keeps 'who played' (fitnessTick) identical
//    to 'who's fielded'. resetFitness at rollover (pre-season). ... Verified by
//    tools/_fitness_test.ts (incl. the depleted-squad edge a review caught)."
//
// fitnessTick draws on Math.random (drain size, injury roll, injury length), so every tick
// here runs under a SCRIPTED rng queue: exact post-tick values, plus an exact count of the
// draws consumed — the count alone pins WHO was drained and WHO was injury-rolled (the
// shared-selection claim) tighter than value checks could. Nothing reads the wall clock.
//
// THE DEPLETED-SQUAD EDGE, pinned in both branches: with fewer than 11 fit men,
// fitFirstSelection returns the slot order UNCHANGED — the identity XI stands and the
// injured play on in their own slots (a legal 11, never a short side); on a custom lineup,
// an injured pick is auto-subbed for the first fit unused non-XI man, and when no such sub
// exists the injured pick simply plays hurt.
//
// Run: cd <repo> && npx tsx tools/_fitness_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite under os.tmpdir() per run — web/backend/data/ untouched.

import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InjuryEvent } from '../web/backend/fitness.ts';

// db.ts resolves FOOTY_DB at IMPORT time, so point it at a scratch file BEFORE any backend
// module loads — which is why every backend import below is a dynamic import.
const dbDir = path.join(os.tmpdir(), 'footy-testdb');
mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, `fitness-test-${process.pid}.sqlite`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
process.env.FOOTY_DB = dbPath;

const { db } = await import('../web/backend/db.ts');
const { fitnessTick, resetFitness, startInjuryRisk } = await import('../web/backend/fitness.ts');
const { fitFirstSelection, fieldedXIIndices } = await import('../web/backend/game.ts');

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) { throw new Error(`_fitness_test FAILED: ${message}`); }
  assertions += 1;
}
const near = (a: number, b: number, tol = 1e-12): boolean => Math.abs(a - b) <= tol;
const eq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const fmt = (a: number[]): string => JSON.stringify(a);

// ── Scripted rng ─────────────────────────────────────────────────────────────
// Math.random is swapped for a finite queue ONLY around each fitnessTick call, then
// restored. An exhausted queue returns a safe 0.999999 but counts as underflow, and every
// tick asserts calls === queue.length && underflow === 0 — so the exact rng consumption
// (11 drains + one roll per FIT starter + one length-draw per injury) is itself pinned.
const realRandom = Math.random;
function withRng<T>(queue: number[], fn: () => T): { result: T; calls: number; underflow: number } {
  const q = [...queue];
  let calls = 0, underflow = 0;
  Math.random = () => { calls += 1; if (q.length > 0) { return q.shift()!; } underflow += 1; return 0.999999; };
  try { return { result: fn(), calls, underflow }; } finally { Math.random = realRandom; }
}
function tick(leagueId: number, queue: number[], label: string): InjuryEvent[] {
  const r = withRng(queue, () => fitnessTick(leagueId));
  assert(r.calls === queue.length && r.underflow === 0,
    `${label}: tick consumed exactly ${queue.length} rng draws (got ${r.calls}, underflow ${r.underflow})`);
  return r.result;
}
// Drain draw for an exact drain d in 10..17: floor(((d-10)/8) * 8) === d-10 exactly.
const D = (d: number) => (d - 10) / 8;
const SAFE = 0.5;                      // an injury roll no scripted risk here ever reaches
const rep = (v: number, n: number): number[] => Array.from({ length: n }, () => v);

// ── Fixtures ─────────────────────────────────────────────────────────────────
interface PlayerSpec { fitness?: number; injured?: number; train?: string | null }
function makeLeague(name: string): number {
  return Number(db.prepare('INSERT INTO leagues (name) VALUES (?)').run(name).lastInsertRowid);
}
function makeTeam(leagueId: number, players: PlayerSpec[],
  opts: { lineup?: number[] | string | null; intensity?: string } = {}): number {
  const lineupJson = opts.lineup == null ? null
    : typeof opts.lineup === 'string' ? opts.lineup : JSON.stringify(opts.lineup);
  const teamId = Number(db.prepare(
    "INSERT INTO teams (league_id, name, tactics, created_at, formation, lineup, training_intensity) VALUES (?, ?, '{}', 0, '4-3-3', ?, ?)",
  ).run(leagueId, `Fitness L${leagueId}`, lineupJson, opts.intensity ?? 'normal').lastInsertRowid);
  const ins = db.prepare(
    "INSERT INTO players (team_id, slot, name, role, attrs, fitness, injured_matches, train_intensity) VALUES (?, ?, ?, 'CM', '{}', ?, ?, ?)");
  players.forEach((p, slot) => ins.run(teamId, slot, `T${teamId} P${slot}`, p.fitness ?? 100, p.injured ?? 0, p.train ?? null));
  return teamId;
}
function fitnessBySlot(teamId: number): number[] {
  return (db.prepare('SELECT fitness FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as unknown as { fitness: number }[]).map(r => r.fitness);
}
function injuredBySlot(teamId: number): number[] {
  return (db.prepare('SELECT injured_matches FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as unknown as { injured_matches: number }[]).map(r => r.injured_matches);
}

// ── startInjuryRisk — the single source of truth for the injury dice ─────────
// LEDGER: "low fitness raises injury risk (3% fresh → 13% exhausted)".
assert(startInjuryRisk(100) === 0.03, 'fully fresh starter risks exactly the 3% base');
assert(near(startInjuryRisk(0), 0.13), `exhausted starter risks 13%, got ${startInjuryRisk(0)}`);
assert(near(startInjuryRisk(50), 0.08), `risk is linear in lost condition: 8% at fitness 50, got ${startInjuryRisk(50)}`);
assert(Array.from({ length: 100 }, (_, f) => f).every(f => startInjuryRisk(f) >= startInjuryRisk(f + 1)),
  'risk is monotone non-increasing as fitness rises (0..100)');
// The fitness input is clamped to 0..100 before the formula.
assert(startInjuryRisk(150) === startInjuryRisk(100), 'fitness above 100 clamps to the fresh 3%');
assert(startInjuryRisk(-40) === startInjuryRisk(0), 'fitness below 0 clamps to the exhausted 13%');
// LEDGER (staff): "physios cut injury risk to ×0.55" — the multiplier scales the whole risk.
assert(near(startInjuryRisk(100, 0.55), 0.03 * 0.55), 'injuryMult 0.55 scales the fresh risk to 1.65%');
assert(near(startInjuryRisk(0, 0.55), 0.13 * 0.55), 'injuryMult 0.55 scales the exhausted risk to 7.15%');
// fitness.ts: "Clamped to [0,1]".
assert(startInjuryRisk(0, 100) === 1, 'a huge multiplier clamps the risk to exactly 1');
assert(startInjuryRisk(100, 0) === 0, 'a zero multiplier zeroes the risk');
assert(startInjuryRisk(50, -3) === 0, 'a negative multiplier clamps to 0, never below');

// ── The shared selection, directly (game.ts) ─────────────────────────────────
// LEDGER: "Injured players can't be selected — specForTeam draws the XI fit-first
// (byte-identical when fully fit), and a shared fitFirstSelection (game.ts) keeps 'who
// played' (fitnessTick) identical to 'who's fielded'".
const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
const injSet = (...xs: number[]) => new Set(xs);
const ffs = (n: number, injured: Set<number>) => fitFirstSelection(idx(n), i => injured.has(i));
const fxi = (n: number, injured: Set<number>, formation: string, lineup: number[] | null) =>
  fieldedXIIndices(idx(n), i => injured.has(i), formation, lineup);

assert(eq(ffs(16, injSet()), idx(16)), 'fully fit squad: the slot order is returned UNCHANGED (byte-identical)');
assert(eq(ffs(16, injSet(0, 12)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 0, 12]),
  'with >=11 fit cover, the injured sink to the back in slot order');
assert(eq(ffs(16, injSet(0, 1, 2, 3, 4)), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4]),
  'EXACTLY 11 fit still reorders — every fit man starts, all injured sit');
// THE DEPLETED-SQUAD EDGE (identity branch): fewer than 11 fit → order unchanged, the
// injured play on in their own slots rather than leaving a short side.
assert(eq(ffs(16, injSet(0, 1, 2, 3, 4, 5)), idx(16)),
  'DEPLETED (10 fit of 16): slot order unchanged — the injured keep their slots and play');
assert(eq(ffs(12, new Set(idx(12))), idx(12)), 'all-injured squad: order unchanged (still a full XI)');

assert(eq(fxi(16, injSet(), '4-3-3', null), idx(11)), 'default shape, fully fit: the identity first eleven');
assert(eq(fxi(16, injSet(3), '4-3-3', null), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]),
  'default shape: an injured slot-3 is skipped, slot 11 steps in (fit-first first eleven)');
assert(eq(fxi(16, injSet(3), '4-3-3', idx(11)), fxi(16, injSet(3), '4-3-3', null)),
  'an explicit identity lineup takes the same fit-first path as no lineup');
assert(eq(fxi(16, injSet(0, 1, 2, 3, 4, 5), '4-3-3', null), idx(11)),
  'DEPLETED: the fielded XI is still the full identity eleven, injured men included');
// Custom-lineup branch: injured pick → auto-sub with the FIRST fit, unused, non-XI man.
assert(eq(fxi(14, injSet(13), '4-3-3', [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), idx(11)),
  'custom XI: the injured pick (13) is auto-subbed for the first fit non-XI man (0)');
// ...and when no eligible sub exists, the injured pick simply plays (never a short XI).
assert(eq(fxi(12, injSet(0, 11), '4-3-3', [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  'custom XI, no fit sub left: the injured pick STAYS in the XI (plays hurt)');
// A non-default shape with the identity XI goes through the custom branch: the sub lands
// in the injured man's formation slot instead of re-packing fit-first.
assert(eq(fxi(16, injSet(0), '4-4-2', null), [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  '4-4-2 identity: injured slot 0 is replaced IN PLACE by the first fit non-XI man (11)');
// An unknown shape falls back to the fit-first path and IGNORES the lineup.
assert(eq(fxi(16, injSet(0), 'not-a-shape', [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
  'unknown formation: fit-first fallback, custom lineup ignored');
// Legal-XI invariant: whatever the injury count, the fielded XI is 11 DISTINCT men.
assert(Array.from({ length: 17 }, (_, k) => k).every(k => {
  const a = fxi(16, new Set(idx(k)), '4-3-3', null);
  const b = fxi(16, new Set(idx(k)), '4-4-2', null);
  return a.length === 11 && new Set(a).size === 11 && b.length === 11 && new Set(b).size === 11;
}), 'for every injury count 0..16, both selection branches field 11 distinct men');

// ── fitnessTick: drain + recovery + the clamps ───────────────────────────────
// LEDGER: "Condition 0–100: the XI that plays drains (~10–17), the rest recover (+20)".
const L1 = makeLeague('fitness drain');
const T1 = makeTeam(L1, [
  { fitness: 5 }, ...rep(0, 10).map(() => ({ fitness: 80 })), { fitness: 95 }, { fitness: 70 },
  { fitness: 80 }, { fitness: 80 }, { fitness: 80 },
]);
{
  // 11 drain draws (both extremes exercised), then 11 injury rolls, all safe.
  const events = tick(L1, [D(17), D(10), D(11), D(12), D(13), D(14), D(15), D(16), D(17), D(10), D(14), ...rep(SAFE, 11)], 'drain');
  assert(events.length === 0, `all rolls safe: no injuries, got ${events.length}`);
  const f = fitnessBySlot(T1);
  assert(eq(f, [0, 70, 69, 68, 67, 66, 65, 64, 63, 70, 66, 100, 90, 100, 100, 100]),
    `starters drain by the scripted 10..17, bench recovers +20, got ${fmt(f)}`);
  assert(f[0] === 0, 'drain clamps at 0: fitness 5 minus the max 17 drain floors at 0, never negative');
  assert(f[8] === 63, 'the maximum drain is exactly 17 (DRAIN_MIN 10 + DRAIN_VAR 8 - 1)');
  assert(f[1] === 70, 'the minimum drain is exactly 10 (DRAIN_MIN)');
  assert(f[12] === 90, 'a rested man regains exactly +20 (RECOVER)');
  assert(f[11] === 100, 'recovery clamps at 100: 95 + 20 caps, never 115');
  assert(eq(injuredBySlot(T1), rep(0, 16)), 'no injuries recorded when every roll is safe');
}

// ── fitnessTick: fresh injuries ──────────────────────────────────────────────
// LEDGER: "low fitness raises injury risk (3% fresh → 13% exhausted, out 1–5 matchdays)".
const L2 = makeLeague('fitness injuries');
const T2 = makeTeam(L2, [{ fitness: 20 }, ...rep(0, 11).map(() => ({ fitness: 100 }))]);
{
  // Rolls in slot order over the starters: P0 (pre-match fitness 20, risk 11%) rolls 0.10 →
  // injured, length draw 0.999 → the 5-matchday MAX; P1 (fresh, 3%) rolls 0.0 → injured,
  // length draw 0.0 → the 1-matchday MIN; P2..P10 safe.
  const events = tick(L2, [...rep(D(10), 11), 0.10, 0.999, 0.0, 0.0, ...rep(SAFE, 9)], 'injuries');
  assert(events.length === 2, `two starters went down, got ${events.length}`);
  assert(events[0].teamId === T2 && events[0].player === `T${T2} P0` && events[0].matches === 5,
    `the tired man's injury event carries team, name and the 5-match max, got ${JSON.stringify(events[0])}`);
  assert(events[1].player === `T${T2} P1` && events[1].matches === 1,
    `the fresh man's roll (0.0 < 3%) still injures, at the 1-match min, got ${JSON.stringify(events[1])}`);
  assert(eq(injuredBySlot(T2), [5, 1, ...rep(0, 10)]), `injured_matches persisted per player, got ${fmt(injuredBySlot(T2))}`);
  assert(eq(fitnessBySlot(T2), [10, ...rep(90, 10), 100]),
    'the men injured this tick still took their match drain (injury rolls come after the drain)');
}
// fitness.ts: the roll is against "startInjuryRisk on their PRE-MATCH fitness — the same
// number the UI warns with". Fresh men (risk 3%) drain 17 to fitness 83 (risk would be
// 4.7%); every roll is 0.04 — safe against 3%, but an implementation using post-drain
// fitness would injure all eleven.
const L3 = makeLeague('fitness pre-match risk');
const T3 = makeTeam(L3, rep(0, 12).map(() => ({ fitness: 100 })));
{
  const events = tick(L3, [...rep(D(17), 11), ...rep(0.04, 11)], 'pre-match risk');
  assert(events.length === 0, 'rolls are judged against PRE-match fitness: 0.04 >= 3%, so nobody is injured');
  assert(eq(injuredBySlot(T3), rep(0, 12)), 'no injuries written on the pre-match-risk team');
}

// ── fitnessTick: injury decrement + unavailability + the organic depleted tick ─
// LEDGER: "Injured players can't be selected" / fitness.ts: "standing injuries heal a
// matchday". Tick 2 on the injury team: with 2 of 12 men down only 10 are fit, so the
// DEPLETED fallback fields the identity XI — both injured men play on in their own slots.
{
  // 11 drains; injury rolls only for the 9 FIT starters (P2..P10) — the queue length pins
  // that injured starters are skipped by the fresh-injury dice.
  const events = tick(L2, [...rep(D(10), 11), ...rep(SAFE, 9)], 'depleted tick 2');
  assert(events.length === 0, 'no new injuries on the depleted tick');
  assert(eq(fitnessBySlot(T2), [0, ...rep(80, 10), 100]),
    `DEPLETED (10 fit of 12): the identity XI stands, the injured drain in their own slots, only slot 11 rests, got ${fmt(fitnessBySlot(T2))}`);
  assert(eq(injuredBySlot(T2), [4, 0, ...rep(0, 10)]), 'standing injuries heal a matchday: 5→4 and 1→0');
}
// Tick 3: P1 healed to 0 last tick and is selectable again; P0 (4 left) now has 11 fit
// cover, so he finally sits out — unavailability the moment cover exists.
{
  const events = tick(L2, [...rep(D(10), 11), ...rep(SAFE, 11)], 'recovered tick 3');
  assert(events.length === 0, 'no new injuries on tick 3');
  const f = fitnessBySlot(T2);
  assert(f[0] === 20 && injuredBySlot(T2)[0] === 3,
    `with 11 fit again the injured man SITS (recovers 0→20) and heals 4→3, got fitness ${f[0]} inj ${injuredBySlot(T2)[0]}`);
  assert(f[1] === 70, 'the man whose injury hit 0 is available and starts (80→70)');
  assert(f[11] === 90, 'slot 11 steps into the XI for the injured man (100→90)');
}

// ── The depleted-squad edge with a real bench ────────────────────────────────
// LEDGER: "(incl. the depleted-squad edge a review caught)". 16 men, slots 0..5 injured →
// only 10 fit: fitFirstSelection leaves the order unchanged, so the XI is the identity
// eleven WITH its injured men, while the five fit men on the bench rest. Exactly 11 drain.
const L4 = makeLeague('fitness depleted');
const T4 = makeTeam(L4, [
  ...rep(0, 6).map(() => ({ fitness: 70, injured: 2 })),
  ...rep(0, 10).map(() => ({ fitness: 70 })),
]);
{
  // 11 drains + rolls for the 5 FIT starters only (slots 6..10).
  const events = tick(L4, [...rep(D(10), 11), ...rep(SAFE, 5)], 'depleted 16-man');
  assert(events.length === 0, 'no fresh injuries on the depleted 16-man team');
  const f = fitnessBySlot(T4);
  assert(eq(f, [...rep(60, 11), ...rep(90, 5)]),
    `the fallback fields the legal identity XI: slots 0..10 drain (injured included), the fit bench rests, got ${fmt(f)}`);
  assert(f.filter((v, i) => v < 70 && i >= 0).length === 11, 'exactly 11 men lost condition — a full, legal XI played');
  assert(eq(injuredBySlot(T4), [...rep(1, 6), ...rep(0, 10)]), 'the fielded injured still heal their matchday (2→1)');
}

// ── Custom lineup: the fielded XI is what drains ─────────────────────────────
// fieldedXIIndices comment (§2.10): the old tick "drained the identity XI even when the
// match fielded a rotated one — inverting 'rest him'". Now the custom XI drains. NOTE:
// the ledger's known-limits line ("fitness bookkeeping uses the first-11-by-slot, so a
// custom-lineup user can see a small skew") is STALE — asserted here as the CODE behaves.
const L6 = makeLeague('fitness custom lineup');
const T6 = makeTeam(L6, [
  ...rep(0, 13).map(() => ({ fitness: 60 })), { fitness: 60, injured: 1 },
], { lineup: [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
{
  const events = tick(L6, [...rep(D(10), 11), ...rep(SAFE, 11)], 'custom sub');
  assert(events.length === 0, 'no injuries on the custom-lineup team');
  const f = fitnessBySlot(T6);
  assert(f[13] === 80 && injuredBySlot(T6)[13] === 0,
    `the injured custom pick (13) is auto-subbed OUT: he rests (+20) and heals, got fitness ${f[13]}`);
  assert(f[0] === 50, 'the FIRST fit, unused, non-XI man (slot 0) is subbed in and drains');
  assert(f[11] === 80 && f[12] === 80, 'later fit non-XI men (11, 12) are NOT the sub — they rest');
  assert(eq(f, [...rep(50, 11), 80, 80, 80]), `the custom XI, not the identity XI, is who drains, got ${fmt(f)}`);
}
// ...and the custom-lineup DEPLETED edge: the only non-XI man is himself injured, so the
// injured pick has no eligible sub and plays hurt — still a legal 11.
const L7 = makeLeague('fitness custom depleted');
const T7 = makeTeam(L7, [
  { fitness: 60, injured: 1 }, ...rep(0, 10).map(() => ({ fitness: 60 })), { fitness: 60, injured: 1 },
], { lineup: [11, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
{
  // 11 drains + rolls for the 10 fit starters (P1..P10); the injured starter P11 is skipped.
  const events = tick(L7, [...rep(D(10), 11), ...rep(SAFE, 10)], 'custom depleted');
  assert(events.length === 0, 'no fresh injuries on the custom-depleted team');
  const f = fitnessBySlot(T7);
  assert(f[11] === 50 && injuredBySlot(T7)[11] === 0,
    `no eligible sub: the injured pick PLAYS HURT (drains 60→50) and still heals, got fitness ${f[11]}`);
  assert(f[0] === 80, 'the injured non-XI man rests (+20) — he was never fielded');
  assert(eq(f, [80, ...rep(50, 11)]), `custom-depleted drain pattern, got ${fmt(f)}`);
}

// ── Physios in the tick ──────────────────────────────────────────────────────
// LEDGER (staff): "physios cut injury risk to ×0.55 + add up to +15 recovery (fitnessTick)".
// Three rating-90 physios reach both caps: injuryMult 0.55, recoverBonus +15.
const L8 = makeLeague('fitness physio');
const T8 = makeTeam(L8, [
  { fitness: 0 }, ...rep(0, 10).map(() => ({ fitness: 100 })),
  { fitness: 60 }, { fitness: 90 }, { fitness: 60 }, { fitness: 60 }, { fitness: 60 },
]);
for (let i = 0; i < 3; i++) {
  db.prepare("INSERT INTO staff (world_id, team_id, role, name, rating, cost) VALUES (?, ?, 'physio', ?, 90, 0)")
    .run(L8, T8, `Physio ${i}`);
}
{
  // P0 is exhausted (base risk 13%) and rolls 0.10: with the physios' ×0.55 the risk is
  // 7.15%, so he stays fit — without them 0.10 < 0.13 would have injured him.
  const events = tick(L8, [...rep(D(10), 11), 0.10, ...rep(SAFE, 10)], 'physio');
  assert(events.length === 0, 'physios cut the risk to x0.55: the 0.10 roll against 7.15% is safe');
  const f = fitnessBySlot(T8);
  assert(f[11] === 95 && f[13] === 95, `physios add +15 recovery: the rested regain 35, got ${f[11]}`);
  assert(f[12] === 100, 'physio-boosted recovery still clamps at 100 (90 + 35 caps)');
  assert(f[0] === 0, 'the exhausted starter drains 0-10 and floors at 0');
  assert(eq(injuredBySlot(T8), rep(0, 16)), 'nobody injured on the physio team');
}

// ── Training intensity scales the injury dice ────────────────────────────────
// fitness.ts: "training intensity scales the injury risk...: the player's own intensity
// wins, else the club dial". Club dial 'heavy' (x1.4 → 18.2% at fitness 0); P0's own
// 'rest' override (x0.3 → 3.9%) WINS over the club dial.
const L9 = makeLeague('fitness intensity');
const T9 = makeTeam(L9, [
  { fitness: 0, train: 'rest' }, ...rep(0, 11).map(() => ({ fitness: 0 })),
], { intensity: 'heavy' });
{
  // P0 rolls 0.05: safe against his rest-scaled 3.9%, would injure under the club's 18.2%.
  // P1 rolls 0.15: injured under heavy 18.2% (safe at the unscaled 13%) → length 0.5 → 3.
  const events = tick(L9, [...rep(D(10), 11), 0.05, 0.15, 0.5, ...rep(SAFE, 9)], 'intensity');
  assert(events.length === 1, `exactly one intensity-driven injury, got ${events.length}`);
  assert(events[0].player === `T${T9} P1` && events[0].matches === 3,
    `the club-dial man goes down for 1+floor(0.5*5)=3 matchdays, got ${JSON.stringify(events[0])}`);
  assert(injuredBySlot(T9)[0] === 0, "P0's own 'rest' intensity (x0.3) overrides the club's 'heavy' — his 0.05 roll is safe");
  assert(injuredBySlot(T9)[1] === 3, "P1 takes the club 'heavy' dial (x1.4): 0.15 < 18.2% injures him");
  assert(eq(fitnessBySlot(T9), [...rep(0, 11), 20]), 'exhausted starters floor at 0; the bench man recovers to 20');
}

// ── Stored-lineup validation (the fitnessTick guard) ─────────────────────────
// fitness.ts: "Validate the stored lineup like getTeamWithPlayers (a clean 11-perm of
// valid squad indices, else the identity XI)". Malformed JSON, a duplicate entry and a
// short array must all fall back to the identity XI.
const L10 = makeLeague('fitness lineup validation');
const T10a = makeTeam(L10, rep(0, 12).map(() => ({ fitness: 60 })), { lineup: 'not json' });
const T10b = makeTeam(L10, rep(0, 12).map(() => ({ fitness: 60 })), { lineup: [11, 11, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
const T10c = makeTeam(L10, rep(0, 12).map(() => ({ fitness: 60 })), { lineup: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
{
  // Three fully fit 12-man teams in one league: 3 x (11 drains + 11 rolls).
  const events = tick(L10, [...rep(D(10), 11), ...rep(SAFE, 11), ...rep(D(10), 11), ...rep(SAFE, 11), ...rep(D(10), 11), ...rep(SAFE, 11)], 'lineup validation');
  assert(events.length === 0, 'no injuries on the validation teams');
  assert(eq(fitnessBySlot(T10a), [...rep(50, 11), 80]), 'malformed lineup JSON → the identity XI drains');
  assert(eq(fitnessBySlot(T10b), [...rep(50, 11), 80]),
    'a duplicate-entry lineup is rejected → identity XI (slot 11 rests, and is never drained twice)');
  assert(eq(fitnessBySlot(T10c), [...rep(50, 11), 80]), 'a 10-long lineup is rejected → identity XI');
}

// ── League scoping + resetFitness ────────────────────────────────────────────
// LEDGER: "resetFitness at rollover (pre-season)" / fitness.ts: "everyone reports back
// fit and fully recovered" — and both tick and reset touch ONLY the given league.
const LM = makeLeague('fitness multi-team');
const TA = makeTeam(LM, rep(0, 12).map(() => ({ fitness: 80 })));
const TB = makeTeam(LM, rep(0, 12).map(() => ({ fitness: 80 })));
{
  const t4Before = fmt(fitnessBySlot(T4)) + fmt(injuredBySlot(T4));
  // One tick serves BOTH teams of the league: 2 x (11 drains + 11 rolls).
  const events = tick(LM, [...rep(D(10), 11), ...rep(SAFE, 11), ...rep(D(10), 11), ...rep(SAFE, 11)], 'multi-team');
  assert(events.length === 0, 'no injuries in the multi-team league');
  assert(eq(fitnessBySlot(TA), [...rep(70, 11), 100]) && eq(fitnessBySlot(TB), [...rep(70, 11), 100]),
    'one tick processes EVERY team in the league');
  assert(fmt(fitnessBySlot(T4)) + fmt(injuredBySlot(T4)) === t4Before,
    "ticking one league never touches another league's players");
}
resetFitness(LM);
assert(eq(fitnessBySlot(TA), rep(100, 12)) && eq(fitnessBySlot(TB), rep(100, 12)),
  'resetFitness: every player in every team of the league reports back at fitness 100');
assert(eq(injuredBySlot(TA), rep(0, 12)) && eq(injuredBySlot(TB), rep(0, 12)),
  'resetFitness clears every standing injury in the league');
assert(eq(fitnessBySlot(T2), [20, ...rep(70, 10), 90]) && injuredBySlot(T2)[0] === 3,
  "resetFitness leaves other leagues' fitness and injuries alone");
resetFitness(L2);
assert(eq(fitnessBySlot(T2), rep(100, 12)) && eq(injuredBySlot(T2), rep(0, 12)),
  'pre-season on the injury league: fit and fully recovered');
assert(eq(injuredBySlot(T4), [...rep(1, 6), ...rep(0, 10)]),
  'the depleted league, still un-reset, keeps its standing injuries');

console.log(`_fitness_test: ${assertions} assertions passed`);
db.close();   // Windows cannot delete a database file that is still open
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

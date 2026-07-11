import { db } from './db.ts';
import { randomPlayerName, randomTeamName } from './names.ts';
import { generateSquadPersonalities } from './personality.ts';
import { createCup } from './cup.ts';
import { deriveObjective, setSeasonObjective } from './objectives.ts';
import { registerWorld } from './worlds.ts';
import { backfillNationalities } from './nations.ts';
import { FORMATIONS, DEFAULT_FORMATION } from './formations.ts';
import type { Plan } from './plan.ts';

const parseJSON = (s: string | null): unknown | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Engine formation slots 0..10 -> role. Must match native createHome/AwayTeam.
export const ROLE_SLOTS = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'] as const;
// EngineRole = the 6 roles the native engine actually understands (roleFromStr in
// engine/types.cpp). A player's STORED role is always one of these. DM/AM are
// web-side POSITIONAL roles that only ever appear as a formation SLOT's role (a
// holding / attacking central-mid spot); they collapse to CM at the spec boundary
// via formations.engineRole(), so the engine never sees them. See that helper.
export type EngineRole = (typeof ROLE_SLOTS)[number];
export type Role = EngineRole | 'DM' | 'AM';

export interface Tactics {
  aggression: number; passingDirectness: number; overlapFrequency: number;
  midfieldFreedom: number; defensiveLineHeight: number;
}
export const DEFAULT_TACTICS: Tactics = {
  aggression: 50, passingDirectness: 50, overlapFrequency: 50,
  midfieldFreedom: 50, defensiveLineHeight: 50,
};

export const LEAGUE_SIZE = 8;

const clamp = (v: number, lo = 30, hi = 95) => Math.max(lo, Math.min(hi, Math.round(v)));
const jitter = (n: number) => n + (Math.random() * 2 - 1) * 6;

// Attribute bias per role, added to a team's base strength. Keeps a GK strong
// in positioning, a striker in shooting, a CB in tackling, etc.
const ROLE_BIAS: Record<EngineRole, Partial<Record<string, number>>> = {
  GK: { positioning: 30, handling: 35, passing: -2, shooting: -25, speed: -10, tackling: -10 },
  FB: { speed: 14, stamina: 14, tackling: 8, positioning: 4, shooting: -8 },
  CB: { tackling: 18, positioning: 16, speed: -6, shooting: -16, creativity: -8 },
  CM: { passing: 16, creativity: 12, stamina: 12, positioning: 6 },
  WM: { speed: 16, creativity: 14, shooting: 8, tackling: -16, stamina: 6 },
  CF: { shooting: 20, speed: 12, creativity: 12, tackling: -22, positioning: 6 },
};
const ATTR_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina', 'handling'] as const;
// Height is generated INDEPENDENT of skill (a poor player can be a giant), centred
// ~54 with role tendency: centre-backs + keepers tall, playmakers/wide men shorter.
// Feeds the engine's aerial-duel blend + 'target the tall man' targeting.
const HEIGHT_BIAS: Partial<Record<EngineRole, number>> = { GK: 16, CB: 24, CF: 12, FB: -2, CM: -8, WM: -6 };

export function genAttrs(role: EngineRole, base: number): Record<string, number> {
  const bias = ROLE_BIAS[role];
  const a: Record<string, number> = {};
  for (const k of ATTR_KEYS) a[k] = clamp(jitter(base + (bias[k] ?? 0)));
  a.height = clamp(jitter(54 + (HEIGHT_BIAS[role] ?? 0)));
  return a;
}

// ── Player value (pillar 1) ─────────────────────────────────────────────────
// `overall` = mean of the core skill attrs. Height is always excluded (a physical trait).
// Handling is a core skill FOR A KEEPER ONLY — pass role==='GK' to fold it in; every other role
// (and an omitted role) uses the 7-attr mean, so outfielders are byte-identical. Used for value +
// the AI's weakest-role logic + training headroom. TASTE: see GAME_LAYER_NOTES.md for the curve.
const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'] as const;
const GK_SKILL_KEYS = [...SKILL_KEYS, 'handling'] as const;
export function overall(attrs: Record<string, number>, role?: string): number {
  const keys = role === 'GK' ? GK_SKILL_KEYS : SKILL_KEYS;
  let s = 0, n = 0;
  for (const k of keys) if (typeof attrs[k] === 'number') { s += attrs[k]; n++; }
  return n ? Math.round(s / n) : 50;
}

// Age multiplier on transfer value: ramps up to a 24-26 peak, gentle decline to 30,
// steep fall after. A 19-y/o is discounted (raw) but a 33-y/o far more so.
function ageMult(age: number): number {
  const a = Math.max(16, Math.min(40, age));
  if (a <= 24) return 0.80 + (a - 18) * (0.20 / 6);          // 18 -> .80, 24 -> 1.00
  if (a <= 26) return 1.00;                                  // prime
  if (a <= 30) return 1.00 - (a - 26) * (0.15 / 4);          // 26 -> 1.00, 30 -> .85
  return Math.max(0.28, 0.85 - (a - 30) * 0.11);             // 30 -> .85, 33 -> .52, 35 -> .30
}

// Personality nudge: pros/consistent/big-game players command a premium; big egos a
// small discount. Neutral (or missing) personality => ×1.0.
function personalityMult(personality: unknown): number {
  const t = (personality as { traits?: Record<string, number> } | null)?.traits;
  if (!t) return 1;
  const pos = ((t.professionalism ?? 50) + (t.consistency ?? 50) + (t.bigGame ?? 50)) / 3;
  const ego = t.ego ?? 50;
  return 1 + ((pos - 50) / 50) * 0.15 - (Math.max(0, ego - 60) / 40) * 0.08;
}

// Transfer value, on a real Premier-League scale: steeply convex in overall so a ~95-rated
// star is worth ~£130M while a 50-rated squad filler is well under £1M (a 65-rated ~£11M, an
// 80-rated ~£46M). Shifting by 30 + the 4th power gives that spread. TASTE: see notes.
export function playerValue(attrs: Record<string, number>, age: number, personality: unknown, role?: string): number {
  const base = Math.pow(Math.max(0, overall(attrs, role) - 30) / 65, 4) * 130_000_000;
  const v = base * ageMult(age) * personalityMult(personality);
  return Math.max(25_000, Math.round(v / 50_000) * 50_000);
}

// Annual wage ≈ 10% of the (ego-neutral) value, then a big ego pushes the demand up — so a
// £67M (85-rated) star earns ~£6.7M/yr (~£130k/wk) and a diva costs more to PAY even when
// worth less to BUY. Separate from the one-off transfer fee. TASTE: the 10% ratio + ego premium.
export function playerWage(attrs: Record<string, number>, age: number, personality: unknown, role?: string): number {
  const base = playerValue(attrs, age, null, role) * 0.10;
  const ego = ((personality as { traits?: { ego?: number } } | null)?.traits?.ego) ?? 50;
  const egoMult = 1 + (Math.max(0, ego - 50) / 50) * 0.25;        // up to +25% for a maxed ego
  return Math.max(25_000, Math.round((base * egoMult) / 25_000) * 25_000);
}

// Rough Premier League (tier 1) vs Championship (tier 2) club finances: PL clubs run on a
// far bigger transfer kitty + wage budget than the Championship. Used at world creation and
// reset on promotion/relegation. TASTE — see GAME_LAYER_NOTES.md.
export const TIER_FINANCE: Record<number, { transferBudget: number; wageBudget: number }> = {
  1: { transferBudget: 80_000_000, wageBudget: 140_000_000 },
  2: { transferBudget: 18_000_000, wageBudget: 40_000_000 },
};
export const tierFinance = (tier: number) => TIER_FINANCE[tier] ?? TIER_FINANCE[2];

// The fit-first selection pool, shared by specForTeam (who plays) and fitnessTick (who gets
// drained/recovered) so the two can never diverge. Injured players sink to the back ONLY when
// there are >=11 fit to cover; with a fully fit squad (or one too injury-hit to field 11 fit)
// the input order is returned unchanged — so a healthy team stays byte-identical and a
// depleted team plays its injured in their own slots. Input must already be in slot order.
export function fitFirstSelection<T>(bySlot: T[], isInjured: (x: T) => boolean): T[] {
  const fitCount = bySlot.reduce((n, p) => n + (isInjured(p) ? 0 : 1), 0);
  return (fitCount >= 11 && fitCount < bySlot.length)
    ? [...bySlot.filter(p => !isInjured(p)), ...bySlot.filter(isInjured)]
    : bySlot;
}

// The squad SLOT-INDICES actually fielded, in formation order — the ONE source of truth shared by
// specForTeam (who plays) and fitnessTick (who is drained / injury-rolled), so the two can never
// diverge. (§2.10 rotation writes custom XIs; the old fitnessTick honoured only fitFirstSelection, so
// it drained the identity XI even when the match fielded a rotated one — inverting "rest him".) bySlot
// MUST be in slot order. Default 4-3-3 + identity XI (or an unknown shape) → the fit-first first-eleven
// (byte-identical to the old path); a custom XI → lineup[i], with an injured pick auto-subbed for the
// first fit, unused, non-XI man (mirrors specForTeam's explicit branch exactly).
export function fieldedXIIndices<T>(bySlot: T[], isInjured: (x: T) => boolean, formation: string, lineup: number[] | null): number[] {
  const layout = FORMATIONS[formation];
  const identity = !lineup || lineup.every((v, i) => v === i);
  if ((formation === DEFAULT_FORMATION && identity) || !layout) {
    return fitFirstSelection(bySlot.map((_, i) => i), i => isInjured(bySlot[i])).slice(0, 11);
  }
  const lu = lineup ?? bySlot.map((_, i) => i);
  const inXI = new Set(lu.slice(0, layout.length).filter(n => Number.isInteger(n) && n >= 0 && n < bySlot.length));
  const used = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < layout.length; i++) {
    const want = lu[i];
    let idx = (Number.isInteger(want) && want >= 0 && want < bySlot.length) ? want : i;
    // bySlot[idx] can be undefined only on a sub-11 squad (squad floor is 11, so unreachable in normal
    // play); the null guard mirrors the old `bySlot[idx]?.injuredMatches` so it degrades, never throws.
    if (bySlot[idx] != null && isInjured(bySlot[idx])) {
      const subIdx = bySlot.findIndex((q, qi) => !isInjured(q) && !used.has(qi) && !inXI.has(qi));
      if (subIdx >= 0) idx = subIdx;
    }
    used.add(idx);
    out.push(idx);
  }
  return out;
}

// New-player age: a realistic spread centred on the mid-20s (18..34), skewed to prime.
function genAge(): number {
  const r = (Math.random() + Math.random()) / 2;   // triangular, peaks at .5
  return Math.round(18 + r * 16);
}

// Potential = ceiling OVR (pillar 2). Younger players carry more upside; a 30+ player
// is essentially at their ceiling. Always >= current OVR. TASTE: the headroom curve.
export function genPotential(currentOverall: number, age: number): number {
  const youth = Math.max(0, 28 - age);                       // 0 at 28+, up to 10 at 18
  const headroom = Math.round(youth * (0.4 + Math.random() * 0.9));   // ~0..15
  return Math.min(95, Math.max(currentOverall, currentOverall + headroom));
}

export function randomTactics(): Tactics {
  const r = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
  return {
    aggression: r(38, 72), passingDirectness: r(35, 70), overlapFrequency: r(30, 70),
    midfieldFreedom: r(35, 68), defensiveLineHeight: r(35, 68),
  };
}

// Bench depth: one backup per line (a reserve keeper + one for each outfield role) so a fresh squad
// can rotate, cover an injury/suspension and actually make subs (§2.10 has someone to rotate TO). Kept
// weaker + younger than the XI (squad players / prospects, not co-stars), and seeded AFTER the starting
// eleven so slots 0-10 — and therefore the matched XI + every existing match result — are unchanged.
const BENCH_ROLES: EngineRole[] = ['GK', 'CB', 'FB', 'CM', 'WM', 'CF'];

function insertRoster(teamId: number, base: number): void {
  const ins = db.prepare(
    'INSERT INTO players (team_id, slot, name, role, attrs, age, potential, wage, contract_years) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  ROLE_SLOTS.forEach((role, slot) => {
    const attrs = genAttrs(role, base);
    const age = genAge();
    ins.run(teamId, slot, randomPlayerName(), role, JSON.stringify(attrs), age, genPotential(overall(attrs, role), age), playerWage(attrs, age, null, role), 2 + Math.floor(Math.random() * 3));
  });
  const benchBase = Math.max(40, base - 10);                 // a clear notch below the XI
  BENCH_ROLES.forEach((role, i) => {
    const attrs = genAttrs(role, benchBase);
    const age = 18 + Math.floor(Math.random() * 8);          // 18..25 — younger squad players / prospects
    ins.run(teamId, ROLE_SLOTS.length + i, randomPlayerName(), role, JSON.stringify(attrs), age, genPotential(overall(attrs, role), age), playerWage(attrs, age, null, role), 2 + Math.floor(Math.random() * 3));
  });
}

// Seed a league's free-agent pool. Quality is skewed low (a bargain bin with the
// occasional gem) so signings stay affordable and the AI's weakest-role buys are
// meaningful. Personalities are left NULL (generated lazily) to skip an LLM call.
export const FREE_AGENT_COUNT = 28;
const FA_ROLES: EngineRole[] = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];
export function seedFreeAgents(leagueId: number, count = FREE_AGENT_COUNT): void {
  const ins = db.prepare(
    'INSERT INTO free_agents (league_id, name, role, attrs, personality, age, potential, value, wage) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)',
  );
  for (let i = 0; i < count; i++) {
    const role = FA_ROLES[Math.floor(Math.random() * FA_ROLES.length)];
    const baseStrength = Math.round(38 + Math.pow(Math.random(), 2) * 42);   // 38..80, skewed low
    const attrs = genAttrs(role, baseStrength);
    const age = genAge();
    ins.run(leagueId, randomPlayerName(), role, JSON.stringify(attrs), age, genPotential(overall(attrs, role), age), playerValue(attrs, age, null, role), playerWage(attrs, age, null, role));
  }
  db.prepare('UPDATE leagues SET market_seeded = 1 WHERE id = ?').run(leagueId);
}

// Backfill potential for players + free agents that predate pillar 2 (potential NULL):
// set it from current OVR + age headroom. Idempotent — only touches NULL rows.
export function backfillPotentials(): void {
  const players = db.prepare('SELECT id, role, attrs, age FROM players WHERE potential IS NULL').all() as { id: number; role: string; attrs: string; age: number }[];
  const upP = db.prepare('UPDATE players SET potential = ? WHERE id = ?');
  for (const p of players) upP.run(genPotential(overall(JSON.parse(p.attrs), p.role), p.age), p.id);
  const fas = db.prepare('SELECT id, role, attrs, age FROM free_agents WHERE potential IS NULL').all() as { id: number; role: string; attrs: string; age: number }[];
  const upF = db.prepare('UPDATE free_agents SET potential = ? WHERE id = ?');
  for (const f of fas) upF.run(genPotential(overall(JSON.parse(f.attrs), f.role), f.age), f.id);
}

// One-time reconcile: existing GK potentials were derived from the 7-attr OVR (handling excluded), so
// now that a keeper's handling counts toward his OVR his stored ceiling can sit AT/below his new OVR —
// which would freeze his development (headroom 0). Re-derive each GK's potential as (role-aware OVR +
// a deterministic age headroom), and only ever RAISE it — so it's idempotent (a second run is a no-op
// once potential >= target) and never nerfs a keeper already given a higher ceiling. Deterministic (no
// Math.random) so it doesn't perturb any seeded stream. NULL-potential GKs are left to backfillPotentials.
export function reconcileGkPotentials(): void {
  const gks = db.prepare("SELECT id, attrs, age, potential FROM players WHERE role = 'GK' AND potential IS NOT NULL")
    .all() as { id: number; attrs: string; age: number; potential: number }[];
  const up = db.prepare('UPDATE players SET potential = ? WHERE id = ?');
  for (const g of gks) {
    const ovr = overall(JSON.parse(g.attrs), 'GK');
    const headroom = Math.max(0, Math.round((28 - g.age) * 0.65));   // deterministic: 0 at 28+, ~6 at 18
    const target = Math.min(95, ovr + headroom);
    if (target > g.potential) up.run(target, g.id);
  }
}

// Backfill wages for players + free agents that predate pillar 5.2 (wage NULL), from
// OVR/age/ego. Idempotent. contract_years already defaulted to 3 by the migration.
export function backfillContracts(): void {
  const players = db.prepare('SELECT id, attrs, age, personality FROM players WHERE wage IS NULL').all() as { id: number; attrs: string; age: number; personality: string | null }[];
  const upP = db.prepare('UPDATE players SET wage = ? WHERE id = ?');
  for (const p of players) upP.run(playerWage(JSON.parse(p.attrs), p.age, parseJSON(p.personality)), p.id);
  const fas = db.prepare('SELECT id, attrs, age FROM free_agents WHERE wage IS NULL').all() as { id: number; attrs: string; age: number }[];
  const upF = db.prepare('UPDATE free_agents SET wage = ? WHERE id = ?');
  for (const f of fas) upF.run(playerWage(JSON.parse(f.attrs), f.age, null), f.id);
}

// One-time backfill for leagues that predate the transfer market (or were created
// before seeding): seed any league still flagged unseeded. seedFreeAgents sets the
// flag, so a pool the user has since drained is never silently refilled. Idempotent —
// safe to call on every server start.
export function backfillFreeAgents(): void {
  const unseeded = db.prepare('SELECT id FROM leagues WHERE market_seeded = 0').all() as { id: number }[];
  for (const l of unseeded) seedFreeAgents(l.id);
}

export function createTeam(opts: {
  leagueId: number; userId: number | null; name: string;
  manager: string; tactics: Tactics; base: number;
  budget?: number; wageBudget?: number;            // default to Championship-tier finances
}): number {
  const fin = TIER_FINANCE[2];
  const info = db.prepare(
    `INSERT INTO teams (user_id, league_id, name, manager, tactics, budget, wage_budget, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.userId, opts.leagueId, opts.name, opts.manager, JSON.stringify(opts.tactics),
    opts.budget ?? fin.transferBudget, opts.wageBudget ?? fin.wageBudget, Date.now());
  const teamId = Number(info.lastInsertRowid);
  insertRoster(teamId, opts.base);
  return teamId;
}

// Standard circle-method double round-robin (home + reverse). N must be even.
export function generateFixtures(leagueId: number): void {
  const teams = (db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id').all(leagueId) as { id: number }[])
    .map(t => t.id);
  const n = teams.length;
  if (n < 2 || n % 2 !== 0) return;
  const ins = db.prepare(
    `INSERT INTO fixtures (league_id, round, home_team_id, away_team_id, seed)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const arr = teams.slice();
  const rounds = n - 1;
  let round = 1;
  for (let leg = 0; leg < 2; leg++) {
    const rot = teams.slice();
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n / 2; i++) {
        let home = rot[i], away = rot[n - 1 - i];
        if ((r % 2 === 1) !== (leg === 1)) [home, away] = [away, home];
        const seed = 1 + Math.floor(Math.random() * 99999);
        ins.run(leagueId, round, home, away, seed);
      }
      // rotate all but the first
      const fixed = rot[0];
      const rest = rot.slice(1);
      rest.unshift(rest.pop()!);
      rot.splice(0, rot.length, fixed, ...rest);
      round++;
    }
  }
  void arr;
}

// Create a fresh two-division WORLD: a top division (tier 1, all AI, stronger) and a
// second division (tier 2) where the user starts among weaker AI, so the first goal is
// to win promotion. Both divisions get fixtures + a free-agent pool. The two leagues
// share a world_id (= the tier-1 league id) so promotion/relegation + season rollover
// can move teams between them. Returns the USER's (tier-2) league id for compatibility.
export function newSeasonForUser(userId: number, username: string, teamName: string, tactics: Tactics): {
  leagueId: number; teamId: number; worldId: number;
} {
  const top = db.prepare("INSERT INTO leagues (name, season, status, tier) VALUES (?, 1, 'running', 1)")
    .run(`${username}'s World — Division 1`);
  const worldId = Number(top.lastInsertRowid);
  db.prepare('UPDATE leagues SET world_id = ? WHERE id = ?').run(worldId, worldId);
  const second = db.prepare("INSERT INTO leagues (name, season, status, tier, world_id) VALUES (?, 1, 'running', 2, ?)")
    .run(`${username}'s World — Division 2`, worldId);
  const secondId = Number(second.lastInsertRowid);

  const fin1 = TIER_FINANCE[1], fin2 = TIER_FINANCE[2];
  // user starts in the second division (Championship money)
  const teamId = createTeam({ leagueId: secondId, userId, name: teamName, manager: username, tactics, base: 70, budget: fin2.transferBudget, wageBudget: fin2.wageBudget });
  for (let i = 0; i < LEAGUE_SIZE - 1; i++) {
    createTeam({ leagueId: secondId, userId: null, name: randomTeamName(), manager: 'AI', tactics: randomTactics(), base: Math.round(55 + Math.random() * 15), budget: fin2.transferBudget, wageBudget: fin2.wageBudget }); // 55..70
  }
  // top division: a full slate of stronger AI sides on Premier-League money
  for (let i = 0; i < LEAGUE_SIZE; i++) {
    createTeam({ leagueId: worldId, userId: null, name: randomTeamName(), manager: 'AI', tactics: randomTactics(), base: Math.round(70 + Math.random() * 15), budget: fin1.transferBudget, wageBudget: fin1.wageBudget }); // 70..85
  }
  generateFixtures(worldId); generateFixtures(secondId);
  seedFreeAgents(worldId); seedFreeAgents(secondId);
  createCup(secondId);                                   // a knockout cup of all 16 clubs
  // the board's opening expectation: a strong fresh club in the second tier is expected to go up
  // (2 = PROMOTE; passed as a literal to keep game.ts free of a season.ts import cycle).
  setSeasonObjective(teamId, 1, deriveObjective({ tier: 2, size: LEAGUE_SIZE, promote: 2, isTopTier: false }));
  registerWorld(worldId, `${username}'s World`, 'solo');   // turn-state row (advanced on demand by the owner)
  return { leagueId: secondId, teamId, worldId };
}

// A SHARED (autonomous) world: two divisions of ALL-AI clubs, no human, open for humans to claim a team.
// Advanced only by the scheduler (worlds.mode = 'shared'). Structurally identical to newSeasonForUser
// minus the human team + objective. Nationalities are backfilled separately (see nations backfill).
export function createSharedWorld(name: string): { worldId: number; secondId: number } {
  const top = db.prepare("INSERT INTO leagues (name, season, status, tier) VALUES (?, 1, 'running', 1)").run(`${name} — Division 1`);
  const worldId = Number(top.lastInsertRowid);
  db.prepare('UPDATE leagues SET world_id = ? WHERE id = ?').run(worldId, worldId);
  const second = db.prepare("INSERT INTO leagues (name, season, status, tier, world_id) VALUES (?, 1, 'running', 2, ?)").run(`${name} — Division 2`, worldId);
  const secondId = Number(second.lastInsertRowid);
  const fin1 = TIER_FINANCE[1], fin2 = TIER_FINANCE[2];
  for (let i = 0; i < LEAGUE_SIZE; i++) createTeam({ leagueId: worldId, userId: null, name: randomTeamName(), manager: 'AI', tactics: randomTactics(), base: Math.round(70 + Math.random() * 15), budget: fin1.transferBudget, wageBudget: fin1.wageBudget });
  for (let i = 0; i < LEAGUE_SIZE; i++) createTeam({ leagueId: secondId, userId: null, name: randomTeamName(), manager: 'AI', tactics: randomTactics(), base: Math.round(55 + Math.random() * 15), budget: fin2.transferBudget, wageBudget: fin2.wageBudget });
  generateFixtures(worldId); generateFixtures(secondId);
  seedFreeAgents(worldId); seedFreeAgents(secondId);
  createCup(secondId);
  registerWorld(worldId, name, 'shared', { joinOpen: true });
  // Nationalities normally backfill at boot / season rollover — a world created at RUNTIME
  // would otherwise field ~270 nationality-less players for its whole first season (empty
  // internationals screen, no flags) until the next server restart.
  backfillNationalities();
  return { worldId, secondId };
}

export interface Standing {
  teamId: number; name: string; manager: string; isUser: boolean;
  played: number; won: number; drawn: number; lost: number;
  gf: number; ga: number; gd: number; points: number;
}

export function standings(leagueId: number): Standing[] {
  const teams = db.prepare(
    'SELECT id, name, manager, user_id FROM teams WHERE league_id = ?',
  ).all(leagueId) as { id: number; name: string; manager: string; user_id: number | null }[];
  const table = new Map<number, Standing>();
  for (const t of teams) {
    table.set(t.id, {
      teamId: t.id, name: t.name, manager: t.manager, isUser: t.user_id !== null,
      played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0,
    });
  }
  const fixtures = db.prepare(
    'SELECT home_team_id, away_team_id, home_score, away_score FROM fixtures WHERE league_id = ? AND played = 1',
  ).all(leagueId) as { home_team_id: number; away_team_id: number; home_score: number; away_score: number }[];
  for (const f of fixtures) {
    const h = table.get(f.home_team_id), a = table.get(f.away_team_id);
    if (!h || !a) continue;
    h.played++; a.played++;
    h.gf += f.home_score; h.ga += f.away_score;
    a.gf += f.away_score; a.ga += f.home_score;
    if (f.home_score > f.away_score) { h.won++; h.points += 3; a.lost++; }
    else if (f.home_score < f.away_score) { a.won++; a.points += 3; h.lost++; }
    else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  const out = [...table.values()];
  for (const s of out) s.gd = s.gf - s.ga;
  out.sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name));
  return out;
}

export interface PlayerRow { slot: number; name: string; role: string; attrs: Record<string, number>; personality: unknown | null; age: number; potential: number | null; listed: boolean; askPrice: number | null; wage: number; contractYears: number; fitness: number; injuredMatches: number; morale: number; trainFocus: string | null; trainIntensity: string | null; retrainRole: string | null; roleFamiliarity: number; seasonGoals: number; seasonAssists: number; seasonApps: number; seasonRatingSum: number; nationality: string; }

export interface SetPieceTakers { fk: number | null; corner: number | null; pen: number | null; longThrow: number | null; }
export function getTeamWithPlayers(teamId: number): {
  id: number; name: string; manager: string; leagueId: number; userId: number | null;
  budget: number; wageBudget: number; wageBill: number; trainingFocus: string; trainingIntensity: string; tactics: Tactics; formation: string; lineup: number[] | null; sacked: boolean; captainSlot: number | null;
  planText: string | null; plan: Plan | null; setPieceTakers: SetPieceTakers | null; players: PlayerRow[];
} | null {
  const t = db.prepare('SELECT id, name, manager, league_id, user_id, budget, wage_budget, training_focus, training_intensity, tactics, formation, lineup, plan_text, plan_directives, sacked, captain_slot, set_piece_takers FROM teams WHERE id = ?')
    .get(teamId) as { id: number; name: string; manager: string; league_id: number; user_id: number | null; budget: number; wage_budget: number; training_focus: string | null; training_intensity: string | null; tactics: string; formation: string | null; lineup: string | null; plan_text: string | null; plan_directives: string | null; sacked: number; captain_slot: number | null; set_piece_takers: string | null } | undefined;
  if (!t) return null;
  const players = (db.prepare('SELECT slot, name, role, attrs, personality, age, potential, listed, ask_price, wage, contract_years, fitness, injured_matches, morale, train_focus, train_intensity, retrain_role, role_familiarity, season_goals, season_assists, season_apps, season_rating_sum, nationality FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string; personality: string | null; age: number; potential: number | null; listed: number; ask_price: number | null; wage: number | null; contract_years: number; fitness: number; injured_matches: number; morale: number; train_focus: string | null; train_intensity: string | null; retrain_role: string | null; role_familiarity: number | null; season_goals: number | null; season_assists: number | null; season_apps: number | null; season_rating_sum: number | null; nationality: string | null }[])
    .map(p => ({ slot: p.slot, name: p.name, role: p.role, attrs: JSON.parse(p.attrs), personality: parseJSON(p.personality), age: p.age, potential: p.potential, listed: !!p.listed, askPrice: p.ask_price, wage: p.wage ?? 0, contractYears: p.contract_years, fitness: p.fitness ?? 100, injuredMatches: p.injured_matches ?? 0, morale: p.morale ?? 65, trainFocus: p.train_focus ?? null, trainIntensity: p.train_intensity ?? null, retrainRole: p.retrain_role ?? null, roleFamiliarity: p.role_familiarity ?? 100, seasonGoals: p.season_goals ?? 0, seasonAssists: p.season_assists ?? 0, seasonApps: p.season_apps ?? 0, seasonRatingSum: p.season_rating_sum ?? 0, nationality: p.nationality ?? '' }));
  let lineup: number[] | null = null;
  // Accept the stored lineup only if it's a clean 11-long permutation of valid squad
  // indices (0..squadSize-1, all distinct). A malformed/legacy/tampered value falls
  // back to the identity XI (null), so a bad row can never duplicate or drop a player
  // in the match spec. (Upper bound is squadSize, not 10, so a bench player can start
  // — for an 11-player squad this is byte-identical to the old 0..10 guard.)
  try {
    const l = t.lineup ? JSON.parse(t.lineup) : null;
    if (Array.isArray(l) && l.length === 11) {
      const nums = l.map(Number);
      if (nums.every(n => Number.isInteger(n) && n >= 0 && n < players.length) && new Set(nums).size === 11) lineup = nums;
    }
  } catch { /* ignore */ }
  // the compiled standing plan (team-relative ids); null = none yet
  const plan = parseJSON(t.plan_directives) as Plan | null;
  return {
    id: t.id, name: t.name, manager: t.manager, leagueId: t.league_id, userId: t.user_id,
    budget: t.budget, wageBudget: t.wage_budget, wageBill: players.reduce((s, p) => s + (p.wage ?? 0), 0), trainingFocus: t.training_focus ?? 'balanced', trainingIntensity: t.training_intensity ?? 'normal', tactics: JSON.parse(t.tactics),
    formation: t.formation ?? '4-3-3', lineup, sacked: !!t.sacked, captainSlot: t.captain_slot,
    planText: t.plan_text, plan: plan && Array.isArray(plan.directives) ? plan : null,
    setPieceTakers: parseJSON(t.set_piece_takers) as SetPieceTakers | null, players,
  };
}

export function teamForUser(userId: number): number | null {
  const row = db.prepare('SELECT id FROM teams WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) as { id: number } | undefined;
  return row ? row.id : null;
}

// True if any of the team's players still lacks a generated personality.
export function needsPersonalities(teamId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM players WHERE team_id = ? AND personality IS NULL').get(teamId) as { n: number };
  return row.n > 0;
}

// Generate + persist a personality per player (one batched LLM call; neutral
// defaults on failure so it never blocks). Idempotent-ish: regenerates the whole squad.
export async function assignPersonalities(teamId: number): Promise<void> {
  const rows = db.prepare('SELECT slot, name, role, attrs FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string }[];
  if (!rows.length) return;
  const ps = await generateSquadPersonalities(rows.map(r => ({ name: r.name, role: r.role, attrs: JSON.parse(r.attrs) })));
  const upd = db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?');
  rows.forEach((r, i) => upd.run(JSON.stringify(ps[i]), teamId, r.slot));
}

// Give an LLM-written backstory + matching dials to players that lack one — i.e. fresh youth
// regens (created with a blank-backstory neutral personality), WITHOUT touching established or
// hand-edited players. Best-effort + async, so it runs in the background after a season
// rollover (never inside the rollover tx). With no LLM the regens simply stay neutral until
// the manager writes their story (which then re-derives the dials).
export async function fillMissingPersonalities(teamId: number): Promise<void> {
  const rows = db.prepare('SELECT slot, name, role, attrs, personality FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string; personality: string | null }[];
  const needy = rows.filter(r => { const p = parseJSON(r.personality) as { backstory?: string } | null; return !p || !p.backstory; });
  if (!needy.length) return;
  const ps = await generateSquadPersonalities(needy.map(r => ({ name: r.name, role: r.role, attrs: JSON.parse(r.attrs) })));
  const upd = db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?');
  needy.forEach((r, i) => { if (ps[i]) upd.run(JSON.stringify(ps[i]), teamId, r.slot); });
}

import { db } from './db.ts';
import { randomPlayerName, randomTeamName } from './names.ts';
import { generateSquadPersonalities } from './personality.ts';

const parseJSON = (s: string | null): unknown | null => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Engine formation slots 0..10 -> role. Must match native createHome/AwayTeam.
export const ROLE_SLOTS = ['GK', 'FB', 'CB', 'CB', 'FB', 'CM', 'CM', 'CM', 'WM', 'CF', 'WM'] as const;
export type Role = (typeof ROLE_SLOTS)[number];

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
const ROLE_BIAS: Record<Role, Partial<Record<string, number>>> = {
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
const HEIGHT_BIAS: Partial<Record<Role, number>> = { GK: 16, CB: 24, CF: 12, FB: -2, CM: -8, WM: -6 };

export function genAttrs(role: Role, base: number): Record<string, number> {
  const bias = ROLE_BIAS[role];
  const a: Record<string, number> = {};
  for (const k of ATTR_KEYS) a[k] = clamp(jitter(base + (bias[k] ?? 0)));
  a.height = clamp(jitter(54 + (HEIGHT_BIAS[role] ?? 0)));
  return a;
}

// ── Player value (pillar 1) ─────────────────────────────────────────────────
// `overall` = mean of the 7 core skill attrs (height + handling excluded — height
// is a physical trait, handling only matters for a keeper). Used for value + the
// AI's weakest-role logic. TASTE: see GAME_LAYER_NOTES.md for the chosen curve.
const SKILL_KEYS = ['speed', 'passing', 'creativity', 'shooting', 'tackling', 'positioning', 'stamina'] as const;
export function overall(attrs: Record<string, number>): number {
  let s = 0, n = 0;
  for (const k of SKILL_KEYS) if (typeof attrs[k] === 'number') { s += attrs[k]; n++; }
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

// Transfer value in currency units. Convex in overall so a star is worth far more
// than a squad filler; rounded to the nearest 100k with a 50k floor.
export function playerValue(attrs: Record<string, number>, age: number, personality: unknown): number {
  const base = Math.pow(overall(attrs) / 100, 3) * 55_000_000;
  const v = base * ageMult(age) * personalityMult(personality);
  return Math.max(50_000, Math.round(v / 100_000) * 100_000);
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

function insertRoster(teamId: number, base: number): void {
  const ins = db.prepare(
    'INSERT INTO players (team_id, slot, name, role, attrs, age, potential) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  ROLE_SLOTS.forEach((role, slot) => {
    const attrs = genAttrs(role, base);
    const age = genAge();
    ins.run(teamId, slot, randomPlayerName(), role, JSON.stringify(attrs), age, genPotential(overall(attrs), age));
  });
}

// Seed a league's free-agent pool. Quality is skewed low (a bargain bin with the
// occasional gem) so signings stay affordable and the AI's weakest-role buys are
// meaningful. Personalities are left NULL (generated lazily) to skip an LLM call.
export const FREE_AGENT_COUNT = 28;
const FA_ROLES: Role[] = ['GK', 'FB', 'CB', 'CM', 'WM', 'CF'];
export function seedFreeAgents(leagueId: number, count = FREE_AGENT_COUNT): void {
  const ins = db.prepare(
    'INSERT INTO free_agents (league_id, name, role, attrs, personality, age, potential, value) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
  );
  for (let i = 0; i < count; i++) {
    const role = FA_ROLES[Math.floor(Math.random() * FA_ROLES.length)];
    const baseStrength = Math.round(38 + Math.pow(Math.random(), 2) * 42);   // 38..80, skewed low
    const attrs = genAttrs(role, baseStrength);
    const age = genAge();
    ins.run(leagueId, randomPlayerName(), role, JSON.stringify(attrs), age, genPotential(overall(attrs), age), playerValue(attrs, age, null));
  }
  db.prepare('UPDATE leagues SET market_seeded = 1 WHERE id = ?').run(leagueId);
}

// Backfill potential for players + free agents that predate pillar 2 (potential NULL):
// set it from current OVR + age headroom. Idempotent — only touches NULL rows.
export function backfillPotentials(): void {
  const players = db.prepare('SELECT id, attrs, age FROM players WHERE potential IS NULL').all() as { id: number; attrs: string; age: number }[];
  const upP = db.prepare('UPDATE players SET potential = ? WHERE id = ?');
  for (const p of players) upP.run(genPotential(overall(JSON.parse(p.attrs)), p.age), p.id);
  const fas = db.prepare('SELECT id, attrs, age FROM free_agents WHERE potential IS NULL').all() as { id: number; attrs: string; age: number }[];
  const upF = db.prepare('UPDATE free_agents SET potential = ? WHERE id = ?');
  for (const f of fas) upF.run(genPotential(overall(JSON.parse(f.attrs)), f.age), f.id);
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
}): number {
  const info = db.prepare(
    `INSERT INTO teams (user_id, league_id, name, manager, tactics, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.userId, opts.leagueId, opts.name, opts.manager, JSON.stringify(opts.tactics), Date.now());
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

// Create a fresh league, the user's team, AI opponents to fill it, and fixtures.
export function newSeasonForUser(userId: number, username: string, teamName: string, tactics: Tactics): {
  leagueId: number; teamId: number;
} {
  const lg = db.prepare("INSERT INTO leagues (name, season, status) VALUES (?, 1, 'running')")
    .run(`${username}'s League`);
  const leagueId = Number(lg.lastInsertRowid);

  const teamId = createTeam({
    leagueId, userId, name: teamName, manager: username, tactics, base: 70,
  });

  for (let i = 0; i < LEAGUE_SIZE - 1; i++) {
    createTeam({
      leagueId, userId: null, name: randomTeamName(),
      manager: 'AI', tactics: randomTactics(),
      base: Math.round(60 + Math.random() * 18), // AI strength 60..78
    });
  }
  generateFixtures(leagueId);
  seedFreeAgents(leagueId);
  return { leagueId, teamId };
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

export interface PlayerRow { slot: number; name: string; role: string; attrs: Record<string, number>; personality: unknown | null; age: number; potential: number | null; listed: boolean; askPrice: number | null; }

export function getTeamWithPlayers(teamId: number): {
  id: number; name: string; manager: string; leagueId: number; userId: number | null;
  budget: number; trainingFocus: string; tactics: Tactics; formation: string; lineup: number[] | null; players: PlayerRow[];
} | null {
  const t = db.prepare('SELECT id, name, manager, league_id, user_id, budget, training_focus, tactics, formation, lineup FROM teams WHERE id = ?')
    .get(teamId) as { id: number; name: string; manager: string; league_id: number; user_id: number | null; budget: number; training_focus: string | null; tactics: string; formation: string | null; lineup: string | null } | undefined;
  if (!t) return null;
  const players = (db.prepare('SELECT slot, name, role, attrs, personality, age, potential, listed, ask_price FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string; personality: string | null; age: number; potential: number | null; listed: number; ask_price: number | null }[])
    .map(p => ({ slot: p.slot, name: p.name, role: p.role, attrs: JSON.parse(p.attrs), personality: parseJSON(p.personality), age: p.age, potential: p.potential, listed: !!p.listed, askPrice: p.ask_price }));
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
  return {
    id: t.id, name: t.name, manager: t.manager, leagueId: t.league_id, userId: t.user_id,
    budget: t.budget, trainingFocus: t.training_focus ?? 'balanced', tactics: JSON.parse(t.tactics),
    formation: t.formation ?? '4-3-3', lineup, players,
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
// defaults on failure so it never blocks). Idempotent-ish: regenerates all 11.
export async function assignPersonalities(teamId: number): Promise<void> {
  const rows = db.prepare('SELECT slot, name, role, attrs FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string }[];
  if (!rows.length) return;
  const ps = await generateSquadPersonalities(rows.map(r => ({ name: r.name, role: r.role, attrs: JSON.parse(r.attrs) })));
  const upd = db.prepare('UPDATE players SET personality = ? WHERE team_id = ? AND slot = ?');
  rows.forEach((r, i) => upd.run(JSON.stringify(ps[i]), teamId, r.slot));
}

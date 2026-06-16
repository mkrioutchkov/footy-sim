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

export function randomTactics(): Tactics {
  const r = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
  return {
    aggression: r(38, 72), passingDirectness: r(35, 70), overlapFrequency: r(30, 70),
    midfieldFreedom: r(35, 68), defensiveLineHeight: r(35, 68),
  };
}

function insertRoster(teamId: number, base: number): void {
  const ins = db.prepare(
    'INSERT INTO players (team_id, slot, name, role, attrs) VALUES (?, ?, ?, ?, ?)',
  );
  ROLE_SLOTS.forEach((role, slot) => {
    ins.run(teamId, slot, randomPlayerName(), role, JSON.stringify(genAttrs(role, base)));
  });
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

export interface PlayerRow { slot: number; name: string; role: string; attrs: Record<string, number>; personality: unknown | null; }

export function getTeamWithPlayers(teamId: number): {
  id: number; name: string; manager: string; leagueId: number; userId: number | null;
  tactics: Tactics; formation: string; lineup: number[] | null; players: PlayerRow[];
} | null {
  const t = db.prepare('SELECT id, name, manager, league_id, user_id, tactics, formation, lineup FROM teams WHERE id = ?')
    .get(teamId) as { id: number; name: string; manager: string; league_id: number; user_id: number | null; tactics: string; formation: string | null; lineup: string | null } | undefined;
  if (!t) return null;
  const players = (db.prepare('SELECT slot, name, role, attrs, personality FROM players WHERE team_id = ? ORDER BY slot').all(teamId) as
    { slot: number; name: string; role: string; attrs: string; personality: string | null }[])
    .map(p => ({ slot: p.slot, name: p.name, role: p.role, attrs: JSON.parse(p.attrs), personality: parseJSON(p.personality) }));
  let lineup: number[] | null = null;
  // Accept the stored lineup only if it's a clean permutation of 0..10 (11 distinct
  // in-range slots). A malformed/legacy/tampered value falls back to the identity XI
  // (null), so a bad row can never duplicate or drop a player in the match spec.
  try {
    const l = t.lineup ? JSON.parse(t.lineup) : null;
    if (Array.isArray(l) && l.length === 11) {
      const nums = l.map(Number);
      if (nums.every(n => Number.isInteger(n) && n >= 0 && n <= 10) && new Set(nums).size === 11) lineup = nums;
    }
  } catch { /* ignore */ }
  return {
    id: t.id, name: t.name, manager: t.manager, leagueId: t.league_id, userId: t.user_id,
    tactics: JSON.parse(t.tactics), formation: t.formation ?? '4-3-3', lineup, players,
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

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'web', 'backend', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.FOOTY_DB ?? path.join(DATA_DIR, 'footy.sqlite');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id      TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leagues (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open'   -- open | running | done
);

CREATE TABLE IF NOT EXISTS teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL = AI manager
  league_id  INTEGER NOT NULL REFERENCES leagues(id),
  name       TEXT NOT NULL,
  manager    TEXT NOT NULL DEFAULT 'AI',
  tactics    TEXT NOT NULL,   -- json: {aggression,passingDirectness,overlapFrequency,midfieldFreedom,defensiveLineHeight}
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slot    INTEGER NOT NULL,   -- 0..10, engine formation slot
  name    TEXT NOT NULL,
  role    TEXT NOT NULL,      -- GK|FB|CB|CM|WM|CF
  attrs   TEXT NOT NULL       -- json: {speed,passing,creativity,shooting,tackling,positioning,stamina}
);

CREATE TABLE IF NOT EXISTS fixtures (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id    INTEGER NOT NULL REFERENCES leagues(id),
  round        INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  seed         INTEGER NOT NULL,
  played       INTEGER NOT NULL DEFAULT 0,
  home_score   INTEGER,
  away_score   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_players_team   ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_league   ON teams(league_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_league ON fixtures(league_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
`);

// Lightweight migrations (no framework): add a column only if it's missing, so an
// existing DB upgrades in place. Each new column has a default that reproduces the
// pre-migration behaviour (teams default to the 4-3-3 shape + identity XI).
function ensureColumn(table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('teams', 'formation', "formation TEXT NOT NULL DEFAULT '4-3-3'");
ensureColumn('teams', 'lineup', 'lineup TEXT');   // json int[11]: formationSlot -> player slot; NULL = identity XI
ensureColumn('players', 'personality', 'personality TEXT');   // json: LLM-generated traits/nationality/backstory/tagline; NULL = not generated yet

// ── Transfer market (pillar 1) ──────────────────────────────────────────────
// Every team gets a transfer kitty; defaults so existing teams are unaffected.
ensureColumn('teams', 'budget', 'budget INTEGER NOT NULL DEFAULT 50000000');   // 50M starting funds
// Marks whether a league's free-agent pool has been seeded. Defaults 0 so leagues
// that predate the market (or any new league before seeding) get a one-time backfill
// (backfillFreeAgents at startup) without ever re-seeding a pool the user has drained.
ensureColumn('leagues', 'market_seeded', 'market_seeded INTEGER NOT NULL DEFAULT 0');
// Age feeds the value formula (and pillar-2 development). Existing players default
// to a neutral 24 — they keep playing identically (the engine never sees age).
ensureColumn('players', 'age', 'age INTEGER NOT NULL DEFAULT 24');
// Transfer-listing: a player can be offered for sale at an asking price.
ensureColumn('players', 'listed', 'listed INTEGER NOT NULL DEFAULT 0');
ensureColumn('players', 'ask_price', 'ask_price INTEGER');

// Free-agent pool — unattached players a team can sign. Kept in its own table (NOT
// as players rows with a null team) so every existing player query and the fixed-22
// match invariant stay untouched. Buying = INSERT into players + DELETE the agent.
db.exec(`
CREATE TABLE IF NOT EXISTS free_agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id   INTEGER NOT NULL REFERENCES leagues(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,        -- GK|FB|CB|CM|WM|CF
  attrs       TEXT NOT NULL,        -- json (same shape as players.attrs)
  personality TEXT,                 -- json | NULL (generated lazily)
  age         INTEGER NOT NULL DEFAULT 24,
  potential   INTEGER,              -- ceiling OVR (pillar 2); NULL on legacy rows
  value       INTEGER NOT NULL DEFAULT 0   -- snapshot at generation
);
CREATE INDEX IF NOT EXISTS idx_free_agents_league ON free_agents(league_id);
`);

// ── Training / development (pillar 2) ───────────────────────────────────────
// A player's ceiling OVR — attrs drift toward it each matchday. NULL on pre-pillar-2
// rows; backfillPotentials() sets it from current OVR + an age-based headroom.
ensureColumn('players', 'potential', 'potential INTEGER');
ensureColumn('free_agents', 'potential', 'potential INTEGER');   // for pillar-1 pools that predate this
// Which attribute a club trains hardest ('balanced' or an attr key); nudges the drift.
ensureColumn('teams', 'training_focus', "training_focus TEXT NOT NULL DEFAULT 'balanced'");

// ── Seasons / divisions (pillar 3) ──────────────────────────────────────────
// A league is one division; divisions of a world are linked by world_id and ranked by
// tier (1 = top). Legacy single leagues keep tier 1 + world_id NULL and roll over as a
// lone division (no promotion/relegation), so the original single-league flow is intact.
ensureColumn('leagues', 'tier', 'tier INTEGER NOT NULL DEFAULT 1');
ensureColumn('leagues', 'world_id', 'world_id INTEGER');

// ── Wages & contracts (pillar 5.2) ──────────────────────────────────────────
// Annual wage (a recurring commitment, separate from the one-off transfer fee) + a wage
// budget per club. NULL wages are backfilled (backfillContracts) from OVR/age/ego.
ensureColumn('players', 'wage', 'wage INTEGER');
ensureColumn('free_agents', 'wage', 'wage INTEGER');
ensureColumn('teams', 'wage_budget', 'wage_budget INTEGER NOT NULL DEFAULT 40000000');
// Seasons left on a player's deal; at rollover it ticks down and expiring players leave
// (pillar 5.2b). Existing rows default to a comfortable 3.
ensureColumn('players', 'contract_years', 'contract_years INTEGER NOT NULL DEFAULT 3');

// ── Injuries & match fitness (core stream) ──────────────────────────────────
// Condition (0..100): playing drains it, resting restores it; low fitness raises injury
// risk. injured_matches = matchdays still sidelined (0 = available). Defaults are the
// healthy state, so existing squads are unaffected + still emit a byte-identical spec.
ensureColumn('players', 'fitness', 'fitness INTEGER NOT NULL DEFAULT 100');
ensureColumn('players', 'injured_matches', 'injured_matches INTEGER NOT NULL DEFAULT 0');

// ── Morale (LLM stream) ─────────────────────────────────────────────────────
// Squad morale 0..100: it drifts with results, is moved by press conferences (via each
// player's criticism/praise dials), and modulates development. Default 65 is neutral — its
// dev factor is exactly 1.0, so existing saves develop identically.
ensureColumn('players', 'morale', 'morale INTEGER NOT NULL DEFAULT 65');

// ── Cup competition (core stream) ───────────────────────────────────────────
// A single-elimination knockout of all the world's clubs, run alongside the league each
// season. round 1 = the first round, rising to the final; slot orders the bracket. Later-
// round ties have NULL teams until the feeding ties resolve. A drawn tie is settled by a
// deterministic seeded shootout. New table, so existing saves are unaffected.
db.exec(`
CREATE TABLE IF NOT EXISTS cup_ties (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id       INTEGER NOT NULL,
  season         INTEGER NOT NULL,
  round          INTEGER NOT NULL,
  slot           INTEGER NOT NULL,
  home_team_id   INTEGER,
  away_team_id   INTEGER,
  seed           INTEGER NOT NULL,
  played         INTEGER NOT NULL DEFAULT 0,
  home_score     INTEGER,
  away_score     INTEGER,
  winner_team_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cup_world_season ON cup_ties(world_id, season);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cup_tie ON cup_ties(world_id, season, round, slot);
`);

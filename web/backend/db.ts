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

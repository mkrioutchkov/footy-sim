import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
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

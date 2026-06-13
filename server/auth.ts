import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';

export interface User { id: number; username: string; }

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

const SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function createSession(userId: number): string {
  const id = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)')
    .run(id, userId, Date.now() + SESSION_MS);
  return id;
}

export function getUserBySession(sid: string | undefined): User | null {
  if (!sid) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, s.expires FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  ).get(sid) as { id: number; username: string; expires: number } | undefined;
  if (!row) return null;
  if (row.expires < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function destroySession(sid: string | undefined): void {
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

export function registerUser(username: string, password: string): User {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('username taken');
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?)',
  ).run(username, hash, salt, Date.now());
  return { id: Number(info.lastInsertRowid), username };
}

export function loginUser(username: string, password: string): User | null {
  const row = db.prepare(
    'SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?',
  ).get(username) as { id: number; username: string; pass_hash: string; pass_salt: string } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.pass_hash, row.pass_salt)) return null;
  return { id: row.id, username: row.username };
}

// tools/_db_test.ts — safety regression for web/backend/db.ts's prepared-statement cache.
//
// db.ts hands the exported `db` a transparent LRU cache keyed by SQL text, so all ~500
// `db.prepare(...)` call sites reuse a compiled statement instead of recompiling per call
// (measured 3x on a 30-matchday workload). Sharing a StatementSync is safe for .get()/.all()/
// .run() — but NOT for .iterate(): two loops over the same SQL would share one cursor, and on
// node v22 the inner loop silently advances the outer one instead of throwing. That is a
// silent WRONG-DATA hazard, not a crash, so it gets its own pinned test rather than trusting
// review. db.ts closes it by giving every cached statement an .iterate() that compiles a
// fresh uncached statement.
//
// The rest of the file pins the cache's other load-bearing properties: identity, the DDL
// drop, transactions staying on the fast path, bounded eviction under pathological dynamic
// SQL, and the PRAGMA/index state the perf work depends on.
//
// Run: cd <repo> && npx tsx tools/_db_test.ts   (exits non-zero on any failure).
// Isolation: a fresh temp sqlite per run + chdir into a temp cwd BEFORE importing db.ts,
// because db.ts reads FOOTY_DB and mkdirs its data dir at import time.
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `footy_db_test_${process.pid}`);
mkdirSync(TMP, { recursive: true });
process.chdir(TMP);
const DB_PATH = path.join(TMP, 'db_test.sqlite');
process.env.FOOTY_DB = DB_PATH;

// Dynamic import AFTER the env write — db.ts opens the file at module scope.
const mod = await import('../web/backend/db.ts') as unknown as {
  db: any;
  stmtCacheStats: () => { size: number; max: number; hits: number; misses: number; evictions: number };
};
const { db, stmtCacheStats } = mod;

let assertions = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) { assertions++; } else { failures.push(msg); }
}

db.exec('CREATE TABLE IF NOT EXISTS cache_probe (a INTEGER PRIMARY KEY)');
for (let i = 1; i <= 5; i++) { db.prepare('INSERT INTO cache_probe VALUES (?)').run(i); }

// ── 1. Identity: same SQL text is the same compiled statement ──────────────────
assert(db.prepare('SELECT a FROM cache_probe') === db.prepare('SELECT a FROM cache_probe'),
  'the same SQL returns the same cached statement');
assert(db.prepare('SELECT a FROM cache_probe') !== db.prepare('SELECT a FROM cache_probe WHERE a > 0'),
  'different SQL returns different statements');

// ── 2. A shared statement is reusable across get/all/run ───────────────────────
const sel = db.prepare('SELECT a FROM cache_probe WHERE a = ?');
assert(sel.get(1)?.a === 1 && sel.get(3)?.a === 3 && sel.all(5).length === 1 && sel.get(2)?.a === 2,
  'a shared statement reuses correctly across get/all with different bindings');

// ── 3. THE hazard: nested iterate() must not corrupt the outer cursor ──────────
const outer: number[] = [];
const inner: number[] = [];
let guard = 0;
for (const r of db.prepare('SELECT a FROM cache_probe ORDER BY a').iterate() as Iterable<{ a: number }>) {
  outer.push(r.a);
  if (++guard > 20) { break; }   // a shared cursor could otherwise loop forever
  if (r.a === 2 && inner.length === 0) {
    for (const q of db.prepare('SELECT a FROM cache_probe ORDER BY a').iterate() as Iterable<{ a: number }>) {
      inner.push(q.a);
    }
  }
}
assert(JSON.stringify(outer) === '[1,2,3,4,5]',
  `a nested iterate leaves the outer cursor intact (got ${JSON.stringify(outer)})`);
assert(JSON.stringify(inner) === '[1,2,3,4,5]',
  `the nested inner loop is itself complete (got ${JSON.stringify(inner)})`);

// ── 4. An options-bearing prepare is never shared ──────────────────────────────
// PrepareOptions changes what a statement RETURNS, so such statements bypass the cache.
// (The option landed in node v25.5.0; on v22 it is accepted and ignored, so the only
// property observable here is that it never enters the shared cache.)
const opt1 = db.prepare('SELECT a FROM cache_probe', { returnArrays: true });
const opt2 = db.prepare('SELECT a FROM cache_probe', { returnArrays: true });
assert(opt1 !== opt2 && opt1 !== db.prepare('SELECT a FROM cache_probe'),
  'prepare(sql, options) bypasses the cache');
assert(opt1.all().length === 5, 'an options-bearing statement still executes correctly');

// ── 5. DDL through exec() drops the cache ──────────────────────────────────────
const preDdl = db.prepare('SELECT * FROM cache_probe WHERE a = 1');
const sizeBefore = stmtCacheStats().size;
db.exec("ALTER TABLE cache_probe ADD COLUMN note TEXT NOT NULL DEFAULT 'zz'");
assert(sizeBefore > 0 && stmtCacheStats().size === 0,
  `a DDL exec clears the cache (${sizeBefore} -> ${stmtCacheStats().size})`);
assert(db.prepare('SELECT * FROM cache_probe WHERE a = 1').get()?.note === 'zz',
  'a post-DDL prepare sees the added column');
assert(preDdl.get()?.note === 'zz',
  'even a pre-DDL statement re-prepares itself (sqlite3_prepare_v2), so the drop is belt-and-braces');

// ── 6. Transactions stay on the fast path ──────────────────────────────────────
db.prepare('SELECT a FROM cache_probe').all();
const sizeTx = stmtCacheStats().size;
db.exec('BEGIN');
db.prepare('INSERT INTO cache_probe(a) VALUES (?)').run(99);
db.exec('ROLLBACK');
assert(stmtCacheStats().size >= sizeTx, 'BEGIN/ROLLBACK do not clear the cache');
assert(db.prepare('SELECT COUNT(*) n FROM cache_probe').get().n === 5,
  'a rollback still rolls back when the statements are cached');

// ── 7. Eviction is bounded and correct under pathological dynamic SQL ──────────
const max = stmtCacheStats().max;
let dynamicOk = true;
for (let i = 0; i < max + 200; i++) {
  if (db.prepare(`SELECT ${i} AS x`).get().x !== i) { dynamicOk = false; break; }
}
assert(dynamicOk, 'every one of max+200 distinct dynamic statements returned its own value');
const stats = stmtCacheStats();
assert(stats.size <= stats.max, `the cache stays bounded (${stats.size} <= ${stats.max})`);
assert(stats.evictions > 0, `eviction actually fired under dynamic SQL (${stats.evictions})`);
assert(db.prepare('SELECT COUNT(*) n FROM cache_probe').get().n === 5,
  'a statement that was evicted and re-prepared still returns correct rows');

// ── 8. The PRAGMA / index state the perf work rests on ─────────────────────────
assert(db.prepare('PRAGMA synchronous').get().synchronous === 1, 'synchronous is NORMAL (1)');
assert(String(db.prepare('PRAGMA journal_mode').get().journal_mode) === 'wal', 'journal_mode is still WAL');
assert(db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1, 'foreign_keys is still ON');
assert(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_staff_team'").get().n === 1,
  'idx_staff_team exists');

// ── 9. close() clears the cache and really closes ──────────────────────────────
db.close();
assert(stmtCacheStats().size === 0, 'close() clears the cache');
assert(db.isOpen === false, 'close() actually closed the handle');
assert(db instanceof (await import('node:sqlite')).DatabaseSync,
  'the exported db is still a real DatabaseSync (instance-patched, not wrapped)');

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

if (failures.length > 0) {
  console.error('FAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`_db_test: ${assertions} assertions passed`);

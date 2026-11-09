// Per-match weather test (§weather integration). Asserts the seeded weather pick is deterministic and
// sensibly distributed, that buildTieSpec carries it into the spec (omitting 'clear' for byte-identical
// specs), and — the load-bearing determinism guard — that the golden fixture-1.json has NO weather key
// so the locked default match stays clear/byte-identical.
//
//   npx tsx tools/_weather_test.ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-wx-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
function check(c: boolean, m: string): void { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } }

const { db } = await import('../web/backend/db.ts');
const { registerUser } = await import('../web/backend/auth.ts');
const game = await import('../web/backend/game.ts');
const match = await import('../web/backend/match.ts');

// ── deterministic + sensibly distributed ─────────────────────────────────────
const W = (s: number) => match.weatherForSeed(s);
check(W(12345) === W(12345) && W(777) === W(777), 'weatherForSeed is deterministic per seed');
const counts: Record<string, number> = { clear: 0, rain: 0, wind: 0 };
for (let s = 1; s <= 2000; s++) counts[W(s)]++;
check(counts.clear + counts.rain + counts.wind === 2000, 'every seed maps to exactly one weather');
check(counts.clear > counts.rain && counts.clear > counts.wind, `clear is the most common condition (${JSON.stringify(counts)})`);
check(counts.rain > 230 && counts.rain < 490, `rain is ~18% (${counts.rain}/2000)`);
check(counts.wind > 140 && counts.wind < 360, `wind is ~12% (${counts.wind}/2000)`);

// ── buildTieSpec carries weather, omitting 'clear' ───────────────────────────
let clearSeed = 0, rainSeed = 0, windSeed = 0;
for (let s = 1; s < 8000 && !(clearSeed && rainSeed && windSeed); s++) {
  const w = W(s);
  if (w === 'clear' && !clearSeed) clearSeed = s;
  if (w === 'rain' && !rainSeed) rainSeed = s;
  if (w === 'wind' && !windSeed) windSeed = s;
}
const u = registerUser('met', 'secret');
const { teamId, leagueId } = game.newSeasonForUser(u.id, u.username, 'Weather FC', game.DEFAULT_TACTICS);
const opp = (db.prepare('SELECT id FROM teams WHERE league_id = ? AND id != ? LIMIT 1').get(leagueId, teamId) as { id: number }).id;
const specClear = match.buildTieSpec(teamId, opp, clearSeed);
check(!('weather' in specClear), 'a clear-seed spec omits the weather key (byte-identical with weather-free specs)');
check(match.buildTieSpec(teamId, opp, rainSeed).weather === 'rain', 'a rain-seed spec carries weather:"rain"');
check(match.buildTieSpec(teamId, opp, windSeed).weather === 'wind', 'a wind-seed spec carries weather:"wind"');

// ── the golden guard: the locked default-match spec must stay weather-free ────
const goldenSpec = path.join(process.cwd(), 'web', 'backend', 'data', 'specs', 'fixture-1.json');
if (existsSync(goldenSpec)) {
  const g = JSON.parse(readFileSync(goldenSpec, 'utf8'));
  check(!('weather' in g), 'the golden fixture-1.json has NO weather key (locked match stays clear/byte-identical)');
} else {
  console.warn('  (note: fixture-1.json not present — golden weather-free check skipped)');
}

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

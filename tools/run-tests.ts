// Runs every tools/_*_test.ts suite in its own process, one after another, and prints one line per
// suite plus a total. Each suite already works on a throwaway FOOTY_DB; the LLM key is cleared here
// as well, so a test run never calls a configured provider.
//
//   npm run test:all                    # every suite
//   npm run test:all -- morale press    # only suites whose file name contains one of the words
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TOOLS_DIR);
const SUITE_TIMEOUT_MS = 300_000;

const words = process.argv.slice(2);
const suites = readdirSync(TOOLS_DIR)
  .filter(f => /^_.+_test\.ts$/.test(f))
  .filter(f => words.length === 0 || words.some(w => f.includes(w)))
  .sort();

const failed: string[] = [];
const started = Date.now();
for (const file of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join('tools', file)], {
    cwd: ROOT, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS,
    env: { ...process.env, TACTICS_LLM_API_KEY: '' },
  });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const verdict = [...lines].reverse().find(l => /PASS|FAIL/.test(l)) ?? lines[lines.length - 1] ?? '(no output)';
  const ok = r.status === 0;
  if (!ok) failed.push(file);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${ok ? '✓' : '✗'} ${file.padEnd(30)} ${secs.padStart(5)}s  ${verdict.slice(0, 90)}`);
  if (!ok) {
    for (const l of lines.filter(l => l.startsWith('✗')).slice(0, 5)) console.log(`      ${l}`);
    if (r.error) console.log(`      ${r.error.message}`);
  }
}

const total = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed in ${total}s`);
if (failed.length > 0) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exitCode = 1;
}

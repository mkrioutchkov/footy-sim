// Engine --frame-sample ≡ the web layer's thinning. Runs the REAL engine (skips, loudly, when no
// binary has been built) over one short match twice:
//   A  full frame stream, thinned 1-in-N by captureLineStream — how every recording was made
//      before the flag existed, and still how one is made from a binary too old to know it;
//   B  --frame-sample N, the engine thinning BEFORE it serialises, captureLineStream told the
//      same N and required to leave the stream alone.
// The two recordings must be the same bytes once B's "frameSample" stamp is removed. That is the
// whole contract: the rule lives in two places (engine/main.cpp FrameSampler and capture.ts), and
// this is what stops them drifting. The seed is chosen because its 4 minutes contain every kind
// of frame the rule pins — a goal, half-time/full-time, and a woodwork event — and the test
// asserts that they are there, so a balance change that moves them fails here instead of quietly
// leaving the equality proving less than it claims (pick another seed: the scan is in the header
// of the commit that added this file).
//
//   npx tsx tools/_frame_sample_test.ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'footy-fs-'));
process.env.FOOTY_DB = path.join(tmp, 'test.sqlite');   // recordings land in tmp/recordings, not the real save
process.env.TACTICS_LLM_API_KEY = '';

let pass = 0, fail = 0;
const check = (c: boolean, m: string): void => { if (c) pass++; else { fail++; console.error(`  ✗ ${m}`); } };

const m = await import('../web/backend/match.ts');
const { ENGINE } = await import('../web/backend/match/runtime.ts');
const { db } = await import('../web/backend/db.ts');
const finish = (): never => {
  try { db.close(); } catch { /* already closed */ }   // release the FOOTY_DB lock before rm (Windows EPERM)
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* OS reaps the temp dir */ }
  process.exit(fail === 0 ? 0 : 1);
};

if (!existsSync(ENGINE)) {
  console.log(`\n✓ PASS — SKIPPED, nothing was checked: no engine binary at ${ENGINE} (npm run native:build)`);
  finish();
}

const SEED = 19, MINUTES = 4, N = m.REPLAY_SAMPLE;
const engine = (extra: string[]) => spawn(ENGINE, [String(SEED), String(MINUTES), '--no-debug', ...extra], { stdio: ['ignore', 'pipe', 'ignore'] });

const tA = Date.now();
const a = await m.captureLineStream('fixture', 1, engine([]).stdout, 1, N);
const msA = Date.now() - tA;
const tB = Date.now();
const b = await m.captureLineStream('fixture', 2, engine(['--frame-sample', String(N)]).stdout, 1, N);
const msB = Date.now() - tB;

const A = m.loadRecording(m.recordingFor('fixture', 1)!);
const B = m.loadRecording(m.recordingFor('fixture', 2)!);
const stamp = `"frameSample":${N},`;

check(!a.sourceThinned, 'a full stream is reported as thinned HERE, not by its source');
check(b.sourceThinned, 'a --frame-sample stream is recognised as already thinned');
check(A.every(l => !l.includes('"frameSample"')), 'without the flag no frame carries the stamp (the default output is untouched)');
check(B.every(l => l.includes(stamp)), `with the flag every frame carries ${stamp.slice(0, -1)}`);

const unstamped = B.map(l => l.replace(stamp, ''));
check(A.length === unstamped.length, `both paths keep the same number of frames (${A.length} vs ${unstamped.length})`);
const firstDiff = A.findIndex((l, i) => l !== unstamped[i]);
check(firstDiff === -1, `the kept frames are byte-identical bar the stamp${firstDiff >= 0 ? ` — first difference at kept frame ${firstDiff}` : ''}`);
check(a.homeScore === b.homeScore && a.awayScore === b.awayScore, `same result either way (${a.homeScore}-${a.awayScore} vs ${b.homeScore}-${b.awayScore})`);

// The match has to exercise every pin, or the equality above is weaker than it reads.
type Frame = { homeScore: number; awayScore: number; matchState: string; events?: { type: string; age: number }[] };
const fr = A.map(l => JSON.parse(l) as Frame);
check(fr.some((f, i) => i > 0 && (f.homeScore !== fr[i - 1].homeScore || f.awayScore !== fr[i - 1].awayScore)), 'the match contains a score change');
check(new Set(fr.map(f => f.matchState)).size >= 2 && fr[fr.length - 1].matchState === 'finished', `the match changes state and ends finished (${[...new Set(fr.map(f => f.matchState))].join(' → ')})`);
check(fr.some(f => (f.events ?? []).some(e => (e.type === 'woodwork' || e.type === 'penalty') && e.age < 150)), 'the match contains a fresh woodwork/penalty frame (the transient-event pin)');

// The point of the flag. The true ratio is ~N (measured 6-8×); 2× leaves a loaded box room.
check(msB * 2 < msA, `thinning in the engine is the faster path (${(msA / 1000).toFixed(1)}s full, ${(msB / 1000).toFixed(1)}s sampled, ${(msA / msB).toFixed(1)}×)`);

// A bad N fails loudly instead of silently streaming every frame.
for (const bad of [['--frame-sample'], ['--frame-sample', '1'], ['--frame-sample', 'abc'], ['--frame-sample', '0'], ['--frame-sample', String(N), '--summary']]) {
  const r = spawnSync(ENGINE, [String(SEED), '1', '--no-debug', ...bad], { encoding: 'utf8', timeout: 30_000 });
  check(r.status === 1 && r.stdout === '' && /frame-sample/.test(r.stderr), `engine rejects "${bad.join(' ')}" (exit ${r.status})`);
}

console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${pass} passed, ${fail} failed`);
finish();
